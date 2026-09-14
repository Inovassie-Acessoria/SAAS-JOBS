/**
 * Varredura de prontidão operacional.
 *
 * Responde a uma pergunta só, e responde com precisão:
 *
 *     O que exatamente falta para este sistema rodar sozinho, 24/7,
 *     com o computador do usuário desligado?
 *
 * Cada verificação devolve: o que é, como está, o que quebra se ficar assim, e
 * o que fazer para resolver — com o nome da variável de ambiente, da rota ou da
 * tela. Nada de "configure as integrações".
 *
 * A varredura é dividida por CAPACIDADE, não por arquivo, porque o sistema
 * degrada em camadas: dá para descobrir vagas sem enviar e-mail, e dá para
 * enviar e-mail sem LLM. Um item BLOCKER impede a autonomia; um DEGRADED faz o
 * sistema funcionar com menos.
 */

const fs = require('fs');
const path = require('path');
const { db } = require('../config/database');

const VERSION = 'readiness-v1';

const STATUS = { OK: 'OK', MISSING: 'MISSING', DEGRADED: 'DEGRADED', UNKNOWN: 'UNKNOWN' };
const SEVERITY = { BLOCKER: 'BLOCKER', DEGRADED: 'DEGRADED', INFO: 'INFO' };

/** Capacidades do sistema, da mais básica à mais autônoma. */
const CAPABILITY = {
  RUNTIME: 'Executar',
  DISCOVERY: 'Descobrir vagas',
  ANALYSIS: 'Analisar e pontuar',
  PREPARATION: 'Preparar candidaturas',
  SENDING: 'Enviar candidaturas',
  AUTONOMY: 'Trabalhar sem o usuário',
  INTELLIGENCE: 'Camada de LLM (opcional)'
};

function setting(key, fallback = '') {
  try {
    const r = db.prepare('SELECT value FROM core_system_settings WHERE key = ?').get(key);
    return r && r.value !== null && r.value !== '' ? r.value : fallback;
  } catch (e) { return fallback; }
}

function one(sql, ...p) {
  try { return db.prepare(sql).get(...p); } catch (e) { return null; }
}

function item(o) {
  return Object.assign({
    id: null, capability: null, title: null,
    status: STATUS.UNKNOWN, severity: SEVERITY.INFO,
    observed: null, impact: null, fix: null, env: null, route: null
  }, o);
}

// ---------------------------------------------------------------------------
// Verificações
// ---------------------------------------------------------------------------

function checkRuntime() {
  const out = [];

  const major = Number(String(process.versions.node).split('.')[0]);
  out.push(item({
    id: 'node_version', capability: CAPABILITY.RUNTIME, title: 'Node.js 22 ou superior',
    status: major >= 22 ? STATUS.OK : STATUS.MISSING,
    severity: SEVERITY.BLOCKER,
    observed: `Node ${process.versions.node}`,
    impact: 'O banco usa `node:sqlite`, nativo a partir do Node 22. Versões anteriores não sobem o processo.',
    fix: major >= 22 ? null : 'Instale o Node.js 22 LTS ou superior no servidor.'
  }));

  const schemaRow = one("SELECT value FROM core_schema_meta WHERE key = 'schema_version'");
  const schemaVersion = schemaRow ? Number(schemaRow.value) : 0;
  const expected = require('../config/database').SCHEMA_VERSION;
  out.push(item({
    id: 'schema_version', capability: CAPABILITY.RUNTIME, title: 'Schema do banco na versão atual',
    status: schemaVersion === expected ? STATUS.OK : STATUS.MISSING,
    severity: SEVERITY.BLOCKER,
    observed: `v${schemaVersion} (esperado v${expected})`,
    impact: 'Tabelas ausentes fazem rotas falharem em tempo de execução.',
    fix: schemaVersion === expected ? null : 'Rode `npm run migrate` — a migração é automática no boot e não descarta dados.'
  }));

  // Valida cifrando e decifrando de verdade, em vez de conferir o formato.
  // A checagem anterior exigia hex de 64 caracteres e reprovava justamente a
  // chave base64 que `secretBox.generateKey()` produz — acusava como ausente
  // uma configuração correta.
  const key = process.env.APP_ENCRYPTION_KEY || '';
  const keyValid = (() => {
    if (!key.trim()) return false;
    try {
      const box = require('../core/security/secretBox');
      return box.decrypt(box.encrypt('readiness-probe')) === 'readiness-probe';
    } catch (e) { return false; }
  })();
  out.push(item({
    id: 'encryption_key', capability: CAPABILITY.RUNTIME, title: 'Chave de criptografia dos segredos',
    status: keyValid ? STATUS.OK : STATUS.MISSING,
    severity: SEVERITY.BLOCKER,
    observed: key ? (keyValid ? 'definida e funcional' : 'definida, mas o teste de cifragem falhou') : 'ausente',
    env: 'APP_ENCRYPTION_KEY',
    impact: 'Sem ela os tokens do Gmail não podem ser gravados nem lidos — o envio automático não funciona.',
    fix: keyValid ? null :
      'Gere com `node -e "console.log(require(\'./core/security/secretBox\').generateKey())"` e defina APP_ENCRYPTION_KEY no servidor. Trocá-la depois invalida os tokens já gravados.'
  }));

  const agentCheck = require('./agentOrchestrator').selfCheck();
  out.push(item({
    id: 'agent_integrity', capability: CAPABILITY.RUNTIME, title: 'Integridade da arquitetura de agentes',
    status: agentCheck.ok ? STATUS.OK : STATUS.MISSING,
    severity: SEVERITY.BLOCKER,
    observed: agentCheck.ok
      ? 'matriz de permissões e Policy Gate íntegros'
      : `${agentCheck.separation.violations.length} violação(ões) de permissão`,
    route: 'GET /api/core/agents/self-check',
    impact: 'Uma violação aqui significa que um agente ganhou capacidade que a spec proíbe — por exemplo, o Email Agent poder enviar.',
    fix: agentCheck.ok ? null : agentCheck.separation.violations.join(' ')
  }));

  return out;
}

function checkDiscovery() {
  const out = [];
  const cfg = one('SELECT * FROM seasonal_config ORDER BY id LIMIT 1') || {};

  // Pergunta ao SERVIÇO qual adaptador ele construiria, em vez de conferir a
  // variável de ambiente. A checagem anterior via a variável definida e
  // reportava OK enquanto o produto rodava em modo fixture — o pior tipo de
  // relatório, o que confirma o que você espera ouvir.
  let feed = '';
  try {
    const adapter = require('./seasonalService').buildAdapter();
    feed = adapter.fixtureMode ? '' : (adapter.explicitUrl || adapter.baseUrl || '');
  } catch (e) {
    feed = cfg.dol_feed_url || process.env.SEASONAL_FEED_BASE_URL || '';
  }
  out.push(item({
    id: 'dol_feed', capability: CAPABILITY.DISCOVERY, title: 'Feed oficial do DOL (Seasonal)',
    status: feed ? STATUS.OK : STATUS.MISSING,
    severity: SEVERITY.BLOCKER,
    observed: feed ? feed : 'não configurado — o produto opera com dados de exemplo',
    env: 'SEASONAL_FEED_BASE_URL',
    route: 'PUT /api/seasonal/config { dol_feed_url }',
    impact: 'Sem o feed, nenhuma ordem de serviço real é importada. Tudo que aparece é fixture rotulada como tal.',
    fix: feed ? null : 'Defina SEASONAL_FEED_BASE_URL=https://api.seasonaljobs.dol.gov ou informe a URL em Configurações do Seasonal.'
  }));

  const gupyUrl = process.env.GUPY_MCP_URL || '';
  out.push(item({
    id: 'gupy_mcp', capability: CAPABILITY.DISCOVERY, title: 'MCP de candidatos da Gupy',
    status: gupyUrl ? STATUS.OK : STATUS.DEGRADED,
    severity: SEVERITY.DEGRADED,
    observed: gupyUrl || 'não configurado',
    env: 'GUPY_MCP_URL',
    impact: 'Sem ele o produto Gupy não descobre vagas reais. O Seasonal não é afetado.',
    fix: gupyUrl ? null : 'Defina GUPY_MCP_URL=https://candidates.mcp.api.gupy.io/mcp (a documentação oficial não exige token).'
  }));

  const indeedEnabled = String(process.env.INDEED_CUSTOM_MCP_ENABLED || '').toLowerCase() === 'true';
  out.push(item({
    id: 'indeed_mcp', capability: CAPABILITY.DISCOVERY, title: 'Acesso oficial do Indeed',
    status: indeedEnabled ? STATUS.OK : STATUS.DEGRADED,
    severity: SEVERITY.INFO,
    observed: indeedEnabled ? 'habilitado' : 'desligado — não há acesso oficial publicado para cliente próprio',
    env: 'INDEED_CUSTOM_MCP_ENABLED',
    impact: 'O produto Indeed fica em modo fixture. Isso é limitação do provedor, não do sistema — e a §21 proíbe contornar com bot de navegador.',
    fix: indeedEnabled ? null : 'Ative apenas quando o Indeed liberar acesso oficial para backend próprio.'
  }));

  return out;
}

function checkProfileAndDocuments(userId = 1) {
  const out = [];

  const profile = one('SELECT * FROM seasonal_profiles WHERE user_id = ? AND country = ?', userId, 'US');
  const profileFilled = Boolean(profile && (profile.full_name || profile.email));
  out.push(item({
    id: 'seasonal_profile', capability: CAPABILITY.PREPARATION, title: 'Perfil do Seasonal preenchido',
    status: profileFilled ? STATUS.OK : STATUS.MISSING,
    severity: SEVERITY.BLOCKER,
    observed: profileFilled ? `${profile.full_name || '(sem nome)'} — ${profile.email || '(sem e-mail)'}` : 'vazio',
    route: 'PUT /api/env/seasonal/us/profile',
    impact: 'Sem nome e e-mail, nenhuma carta é montada e a validação bloqueia o envio. O perfil do Gupy ou do Indeed NÃO é reaproveitado aqui.',
    fix: profileFilled ? null : 'Preencha o perfil do ambiente Seasonal/US — ele é independente dos outros produtos.'
  }));

  const driver = require('./driverProfileService').readiness(userId);
  const highBlockers = driver.blockers.filter(b => b.severity === 'HIGH');
  out.push(item({
    id: 'driver_profile', capability: CAPABILITY.PREPARATION, title: 'Perfil de motorista (CDL, experiência, histórico)',
    status: highBlockers.length === 0 ? STATUS.OK : STATUS.MISSING,
    severity: SEVERITY.BLOCKER,
    observed: `${driver.unknownFields.length} campo(s) em UNKNOWN` +
              (highBlockers.length ? `: ${highBlockers.map(b => b.field).join(', ')}` : ''),
    route: 'PUT /api/seasonal/driver-profile',
    impact: 'Campo em UNKNOWN nunca vira suposição. Vagas que exigem CDL ou histórico limpo param em revisão humana em vez de serem enviadas, ' +
            'e o Truth Guard bloqueia qualquer texto que afirme o que o perfil não sabe.',
    fix: highBlockers.length === 0 ? null : highBlockers.map(b => b.message).join(' ')
  }));

  const resumes = (() => {
    try {
      return db.prepare(`SELECT * FROM seasonal_resumes
                         WHERE user_id = ? AND doc_type = 'resume' AND is_active = 1 AND archived = 0`).all(userId);
    } catch (e) { return []; }
  })();

  const onDisk = resumes.filter(r => r.file_path && fs.existsSync(r.file_path));
  out.push(item({
    id: 'seasonal_resume', capability: CAPABILITY.PREPARATION, title: 'Currículo do Seasonal em disco',
    status: onDisk.length ? STATUS.OK : STATUS.MISSING,
    severity: SEVERITY.BLOCKER,
    observed: `${resumes.length} cadastrado(s), ${onDisk.length} presente(s) em disco`,
    route: 'POST /api/env/seasonal/us/resumes',
    impact: 'Nenhuma candidatura sai sem currículo anexado — a validação bloqueia antes de reservar cota.',
    fix: onDisk.length ? null :
      'Envie um currículo no ambiente Seasonal/US. Currículos do Gupy ou do Indeed nunca são reutilizados aqui (isolamento por plataforma).'
  }));

  return out;
}

function checkSending() {
  const out = [];
  const cfg = one('SELECT * FROM seasonal_config ORDER BY id LIMIT 1') || {};

  const hasOAuthApp = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  out.push(item({
    id: 'gmail_oauth_app', capability: CAPABILITY.SENDING, title: 'Credenciais OAuth do Google',
    status: hasOAuthApp ? STATUS.OK : STATUS.MISSING,
    severity: SEVERITY.BLOCKER,
    observed: hasOAuthApp ? 'GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET definidos' : 'ausentes',
    env: 'GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI',
    impact: 'Sem elas não existe fluxo de autorização — e o sistema não usa senha de aplicativo em nenhuma hipótese.',
    fix: hasOAuthApp ? null :
      'Crie credenciais tipo "Aplicativo da Web" no Google Cloud Console, com o escopo gmail.send, e cadastre o GOOGLE_REDIRECT_URI apontando para /api/seasonal/gmail/callback do domínio do servidor.'
  }));

  const connected = Boolean(cfg.gmail_connected);
  out.push(item({
    id: 'gmail_connected', capability: CAPABILITY.SENDING, title: 'Conta do Gmail autorizada',
    status: connected ? STATUS.OK : STATUS.MISSING,
    severity: SEVERITY.BLOCKER,
    observed: connected ? `conectada como ${cfg.gmail_user || '(conta autorizada)'}` : 'não conectada',
    route: 'GET /api/seasonal/gmail/auth-url',
    impact: 'O Gmail Worker é o único componente autorizado a enviar. Sem token, a fila enche e nada sai.',
    fix: connected ? null : 'Abra Integrações → Gmail e conclua a autorização OAuth. Isso é independente da conta usada para entrar no sistema.'
  }));

  const paused = Boolean(cfg.pause_email_sending);
  out.push(item({
    id: 'email_not_paused', capability: CAPABILITY.SENDING, title: 'Envio de e-mails não pausado',
    status: paused ? STATUS.DEGRADED : STATUS.OK,
    severity: SEVERITY.DEGRADED,
    observed: paused ? 'PAUSADO' : 'ativo',
    route: 'POST /api/seasonal/pause { paused: false }',
    impact: 'Com a pausa ativa a descoberta, a análise e o preparo continuam, mas nenhum e-mail sai.',
    fix: paused ? 'Desative a pausa quando quiser retomar os envios.' : null
  }));

  const emailService = require('./seasonalEmailService');
  const quota = emailService.getQuotaStatus();
  out.push(item({
    id: 'quota', capability: CAPABILITY.SENDING, title: 'Cota diária de envios',
    status: quota.maxLimit > 0 ? STATUS.OK : STATUS.DEGRADED,
    severity: SEVERITY.INFO,
    observed: `${quota.countSent}/${quota.maxLimit} hoje (teto ${emailService.absoluteDailyCap()} = ${emailService.ABSOLUTE_DAILY_CAP} × contas ativas), fuso ${quota.timezone}`,
    impact: 'A reserva é atômica: sob concorrência, o e-mail 51 não sai. Nenhuma configuração eleva o teto acima de 50.',
    fix: quota.maxLimit > 0 ? null : 'O limite diário está em zero — ajuste em Configurações do Seasonal.'
  }));

  const tz = setting('application_timezone', '');
  out.push(item({
    id: 'timezone', capability: CAPABILITY.SENDING, title: 'Fuso horário da virada da cota',
    status: tz ? STATUS.OK : STATUS.DEGRADED,
    severity: SEVERITY.INFO,
    observed: tz || 'não definido (usando UTC)',
    env: 'APPLICATION_TIMEZONE',
    impact: 'A cota vira no dia-calendário deste fuso. Um fuso errado desloca a janela de envio.',
    fix: tz ? null : 'Defina application_timezone nas configurações do sistema.'
  }));

  return out;
}

function checkAutonomy() {
  const out = [];
  const scheduler = require('./scheduler');
  const s = scheduler.status();
  const cfg = one('SELECT * FROM seasonal_config ORDER BY id LIMIT 1') || {};

  out.push(item({
    id: 'scheduler_enabled', capability: CAPABILITY.AUTONOMY, title: 'Agendador habilitado',
    status: s.enabled ? STATUS.OK : STATUS.MISSING,
    severity: SEVERITY.BLOCKER,
    observed: s.enabled ? `ligado, ${s.tasks.filter(t => t.enabled).length} tarefa(s) ativa(s)` : 'desligado',
    route: 'POST /api/core/scheduler/enable { enabled: true }',
    impact: 'Esta é a diferença entre um sistema que você opera e um que trabalha por você. Desligado, nada roda sozinho.',
    fix: s.enabled ? null : 'Ligue a automação — as tarefas do Seasonal são habilitadas junto, com os intervalos configurados.'
  }));

  out.push(item({
    id: 'scheduler_process', capability: CAPABILITY.AUTONOMY, title: 'Agendador rodando neste processo',
    status: s.running ? STATUS.OK : STATUS.DEGRADED,
    severity: SEVERITY.DEGRADED,
    observed: s.running ? `ativo desde ${s.startedAt}, tique de ${s.tickSeconds}s` : 'timer não iniciado',
    impact: 'O agendador sobe junto com o servidor. Se não estiver rodando, o processo foi iniciado sem passar pelo server.js.',
    fix: s.running ? null : 'Inicie a aplicação com `npm start` (ou o serviço do Docker), não importando módulos avulsos.'
  }));

  const globalPause = setting('global_pause_all_automations', '0') === '1';
  out.push(item({
    id: 'global_pause', capability: CAPABILITY.AUTONOMY, title: 'Pausa geral desativada',
    status: globalPause ? STATUS.DEGRADED : STATUS.OK,
    severity: SEVERITY.DEGRADED,
    observed: globalPause ? 'PAUSA GERAL ATIVA' : 'sem pausa',
    impact: 'Com a pausa geral, o Policy Gate nega toda ação externa, independentemente das demais configurações.',
    fix: globalPause ? 'Desative global_pause_all_automations nas configurações do sistema.' : null
  }));

  const mode = cfg.email_review_mode || 'ALWAYS_REVIEW';
  const automation = cfg.automation_mode || 'MANUAL';
  const fullyAuto = mode === 'FULLY_AUTOMATIC' && automation === 'AUTOMATIC';
  out.push(item({
    id: 'automation_mode', capability: CAPABILITY.AUTONOMY, title: 'Modo de automação do Seasonal',
    status: fullyAuto ? STATUS.OK : STATUS.DEGRADED,
    severity: SEVERITY.DEGRADED,
    observed: `automação: ${automation}, revisão: ${mode}`,
    route: 'PUT /api/seasonal/config { automation_mode, email_review_mode }',
    impact: fullyAuto
      ? 'Candidaturas qualificadas são enviadas sem aprovação, como a §32 permite para o Seasonal.'
      : 'As candidaturas são preparadas mas ficam aguardando sua aprovação. Isso é o padrão seguro, não um defeito.',
    fix: fullyAuto ? null :
      'Para envio sem aprovação, defina automation_mode=AUTOMATIC e email_review_mode=FULLY_AUTOMATIC. Recomendado só depois de validar alguns envios em modo REVIEW_FLAGGED.'
  }));

  const unclassified = one("SELECT COUNT(*) v FROM seasonal_jobs WHERE truck_classification IS NULL");
  const n = unclassified ? unclassified.v : 0;
  out.push(item({
    id: 'truck_gate_coverage', capability: CAPABILITY.AUTONOMY, title: 'Cobertura do Truck Driver Gate',
    status: n === 0 ? STATUS.OK : STATUS.DEGRADED,
    severity: SEVERITY.DEGRADED,
    observed: n === 0 ? 'todas as ordens classificadas' : `${n} ordem(ns) sem classificação`,
    route: 'POST /api/seasonal/agents/run',
    impact: 'Ordem sem classificação não entra no fluxo automático — o filtro de motorista é condição da §16.',
    fix: n === 0 ? null : 'Rode a cadeia de agentes uma vez; depois disso a tarefa periódica mantém a cobertura.'
  }));

  // Hospedagem: o sistema não tem como detectar sozinho se está no VPS.
  const onServer = process.platform === 'linux' || Boolean(process.env.APP_ENV === 'production');
  out.push(item({
    id: 'always_on_host', capability: CAPABILITY.AUTONOMY, title: 'Hospedagem ligada 24/7',
    status: onServer ? STATUS.OK : STATUS.UNKNOWN,
    severity: SEVERITY.BLOCKER,
    observed: `${process.platform}, APP_ENV=${process.env.APP_ENV || 'não definido'}`,
    impact: 'O princípio central do produto é que o computador do usuário pode estar desligado. Rodando em máquina pessoal, a autonomia dura só enquanto ela estiver ligada.',
    fix: onServer ? null :
      'Suba a aplicação no VPS (docker-compose.yml já está no repositório) e defina APP_ENV=production. O processo precisa ser reiniciado automaticamente pelo Docker ou por systemd.'
  }));

  return out;
}

function checkIntelligence() {
  const ai = require('./aiService');
  const s = ai.status();

  return [item({
    id: 'ai_provider', capability: CAPABILITY.INTELLIGENCE, title: 'Provedor de LLM',
    status: s.llmAvailable ? STATUS.OK : STATUS.DEGRADED,
    severity: SEVERITY.INFO,
    observed: s.llmAvailable ? `${s.provider} / ${s.model}` : 'modo determinístico',
    env: s.apiKeyRef || 'ANTHROPIC_API_KEY | OPENAI_API_KEY | GEMINI_API_KEY',
    route: 'PUT /api/core/ai { provider, apiKeyRef, model }',
    impact: 'Sem LLM o sistema funciona inteiro: análise por ontologia curada, cartas por template com lastro no perfil. ' +
            'Com LLM, a leitura de requisitos ambíguos e a redação ficam melhores. Nenhuma regra de negócio depende do modelo.',
    fix: s.requirement
  })];
}

// ---------------------------------------------------------------------------

/**
 * Roda a varredura completa.
 * @param {object} [options]
 * @param {number} [options.userId]
 */
/**
 * De onde o processo está lendo a configuração — para resolver, de uma vez,
 * a dúvida "o servidor está vendo o meu .env?".
 *
 * Só diz SE cada variável existe, nunca o valor. É o suficiente para separar
 * "arquivo não foi lido" de "arquivo lido, mas a variável está em branco".
 */
function describeEnvironment() {
  const fs = require('fs');
  const path = require('path');
  const envFile = path.join(__dirname, '..', '.env');
  const present = (k) => Boolean(process.env[k] && String(process.env[k]).trim());

  return {
    nodeVersion: process.version,
    appDir: path.join(__dirname, '..'),
    workingDir: process.cwd(),
    envFile,
    envFileFound: fs.existsSync(envFile),
    variables: {
      APP_ENV: process.env.APP_ENV || '(vazio)',
      APP_BASE_URL: present('APP_BASE_URL'),
      APP_ENCRYPTION_KEY: present('APP_ENCRYPTION_KEY'),
      GOOGLE_CLIENT_ID: present('GOOGLE_CLIENT_ID'),
      GOOGLE_CLIENT_SECRET: present('GOOGLE_CLIENT_SECRET'),
      GOOGLE_REDIRECT_URI: present('GOOGLE_REDIRECT_URI'),
      DB_PATH: present('DB_PATH')
    }
  };
}

function check({ userId = 1 } = {}) {
  const items = [
    ...checkRuntime(),
    ...checkDiscovery(),
    ...checkProfileAndDocuments(userId),
    ...checkSending(),
    ...checkAutonomy(),
    ...checkIntelligence()
  ];

  const blockers = items.filter(i => i.severity === SEVERITY.BLOCKER && i.status !== STATUS.OK);
  const degraded = items.filter(i => i.severity === SEVERITY.DEGRADED && i.status !== STATUS.OK);

  // Capacidades: uma capacidade está disponível quando nenhum bloqueador dela falha.
  const byCapability = {};
  for (const cap of Object.values(CAPABILITY)) {
    const own = items.filter(i => i.capability === cap);
    const ownBlockers = own.filter(i => i.severity === SEVERITY.BLOCKER && i.status !== STATUS.OK);
    byCapability[cap] = {
      available: ownBlockers.length === 0,
      checks: own.length,
      blockers: ownBlockers.map(i => i.id)
    };
  }

  const ready = blockers.length === 0;

  return {
    ready,
    environment: describeEnvironment(),
    summary: ready
      ? 'O sistema tem tudo o que precisa para operar sozinho.'
      : `Faltam ${blockers.length} item(ns) obrigatório(s) para a operação autônoma` +
        (degraded.length ? `, e ${degraded.length} item(ns) deixam o sistema em modo reduzido.` : '.'),
    blockers,
    degraded,
    items,
    capabilities: byCapability,
    checkedAt: new Date().toISOString(),
    version: VERSION
  };
}

/** Renderização em texto — usada pelo script de varredura no terminal. */
function toText(report) {
  const lines = [];
  const icon = { OK: '  OK  ', MISSING: ' FALTA', DEGRADED: 'PARCIAL', UNKNOWN: '   ?  ' };

  lines.push('='.repeat(78));
  lines.push('VARREDURA DE PRONTIDÃO — o que falta para o sistema rodar sozinho');
  lines.push('='.repeat(78));
  lines.push('');
  lines.push(report.summary);
  lines.push('');

  for (const cap of Object.values(CAPABILITY)) {
    const own = report.items.filter(i => i.capability === cap);
    if (!own.length) continue;
    const state = report.capabilities[cap];
    lines.push(`${cap.toUpperCase()}  —  ${state.available ? 'disponível' : 'INDISPONÍVEL'}`);
    lines.push('-'.repeat(78));
    for (const i of own) {
      lines.push(`[${icon[i.status] || i.status}] ${i.title}`);
      lines.push(`         estado: ${i.observed}`);
      if (i.status !== 'OK' && i.impact) lines.push(`         impacto: ${i.impact}`);
      if (i.fix) lines.push(`         AÇÃO: ${i.fix}`);
      if (i.env && i.status !== 'OK') lines.push(`         env: ${i.env}`);
      if (i.route && i.status !== 'OK') lines.push(`         rota: ${i.route}`);
      lines.push('');
    }
  }

  if (report.blockers.length) {
    lines.push('='.repeat(78));
    lines.push('BLOQUEADORES — sem estes, não há operação autônoma');
    lines.push('='.repeat(78));
    report.blockers.forEach((b, i) => lines.push(`${i + 1}. ${b.title} — ${b.fix || b.impact}`));
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = { VERSION, STATUS, SEVERITY, CAPABILITY, check, toText };
