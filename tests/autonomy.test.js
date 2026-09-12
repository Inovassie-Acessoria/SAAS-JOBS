/**
 * §32, §55, §68, §70 — OPERAÇÃO AUTÔNOMA
 *
 * O §70 é o teste que define o produto:
 *
 *     "Simulate: no active browser session.
 *      Verify: scheduled jobs run; Seasonal feed imports; AI analysis runs;
 *              email queue sends; database persists results."
 *
 * Nada aqui abre navegador, e nenhuma etapa recebe entrada do usuário. Tudo o
 * que roda, roda porque o agendador acordou — que é exatamente a condição da
 * §63: o laptop do usuário pode estar desligado.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'h2a-autonomy-'));
process.env.DB_PATH = path.join(TMP, 'autonomy.db');

const { db } = require('../config/database');
const scheduler = require('../services/scheduler');
const orchestrator = require('../services/agentOrchestrator');
const driverProfile = require('../services/driverProfileService');
const awayReport = require('../services/awayReport');
const readiness = require('../services/readinessService');
const channelAgent = require('../core/agents/communicationChannel');
const truckGate = require('../core/agents/truckDriverGate');

test.after(() => {
  scheduler.stop();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let seq = 0;
function inserirVaga(over = {}) {
  seq++;
  const j = Object.assign({
    job_order_id: `H-300-${String(seq).padStart(5, '0')}`,
    visa_type: 'H-2A',
    job_title: 'Heavy and Tractor-Trailer Truck Driver',
    soc_code: '53-3032.00',
    employer_name: 'Prairie Grain Co',
    employer_state: 'KS',
    employer_phone: '(620) 555-0142',
    employer_email: 'hiring@prairiegrain.example',
    application_email: 'hiring@prairiegrain.example',
    application_method: 'EMAIL',
    wage_rate: 21.5,
    start_date: '2027-02-01',
    end_date: '2027-11-15',
    duties_description: 'Operate tractor-trailer to haul grain. Pre-trip inspection, DOT regulations, log book.',
    special_requirements: 'Valid CDL Class A required. Clean driving record. Minimum 2 years driving experience.'
  }, over);

  db.prepare(`INSERT INTO seasonal_jobs
    (job_order_id, visa_type, job_title, soc_code, employer_name, employer_state, employer_phone,
     employer_email, application_email, application_method, wage_rate, start_date, end_date,
     duties_description, special_requirements)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(j.job_order_id, j.visa_type, j.job_title, j.soc_code, j.employer_name, j.employer_state,
         j.employer_phone, j.employer_email, j.application_email, j.application_method,
         j.wage_rate, j.start_date, j.end_date, j.duties_description, j.special_requirements);

  const row = db.prepare('SELECT id FROM seasonal_jobs WHERE job_order_id = ?').get(j.job_order_id);

  db.prepare(`INSERT INTO seasonal_matches (job_id, fit_score, ats_score, opportunity_score, category)
              VALUES (?,?,?,?,?)`)
    .run(row.id, over.fit_score || 92, over.ats_score || 87, over.opportunity_score || 90, 'TOP_PRIORITY');

  return row.id;
}

function perfilCompleto() {
  driverProfile.update({
    truck_driving_experience: 6,
    tractor_trailer_experience: 4,
    cdl_status: 'HELD',
    cdl_class: 'A',
    cdl_endorsements: 'N',
    driving_record: 'CLEAN',
    english_level: 'INTERMEDIATE',
    manual_transmission_experience: 'YES'
  }, 1);
}

// ---------------------------------------------------------------------------
// §27 — perfil de motorista e a regra do UNKNOWN
// ---------------------------------------------------------------------------

test('§27, §18 — o perfil de motorista nasce inteiramente UNKNOWN', () => {
  const p = driverProfile.get(1);

  assert.strictEqual(p.cdl_status, 'UNKNOWN');
  assert.strictEqual(p.driving_record, 'UNKNOWN');
  assert.strictEqual(p.truck_driving_experience, 'UNKNOWN');
  assert.ok(p.criticalUnknowns.length > 0);
  assert.strictEqual(p.complete, false,
    'um perfil vazio não pode se apresentar como completo');
});

test('§18 — retirar uma afirmação devolve o campo a UNKNOWN', () => {
  driverProfile.update({ cdl_status: 'HELD', cdl_class: 'A' }, 1);
  assert.strictEqual(driverProfile.get(1).cdl_status, 'HELD');

  driverProfile.update({ cdl_status: 'UNKNOWN' }, 1);
  assert.strictEqual(driverProfile.get(1).cdl_status, 'UNKNOWN',
    'o usuário pode retirar uma afirmação, e isso precisa propagar');
});

test('§27 — valor fora do conjunto declarado é recusado, não silenciosamente aceito', () => {
  assert.throws(() => driverProfile.update({ cdl_class: 'Z' }, 1), /Valor inválido/);
  assert.throws(() => driverProfile.update({ truck_driving_experience: -3 }, 1), /Valor inválido/);
});

/** Foco das candidaturas: 1 = só caminhão (regra original), 0 = todas (padrão desde 2026-09-11). */
function foco(truckOnly) {
  db.prepare('UPDATE seasonal_config SET require_truck_driver_match = ?').run(truckOnly ? 1 : 0);
}

test('§27, §54 — no foco "só caminhão", a prontidão do perfil nomeia o que trava a autonomia', () => {
  foco(true);
  driverProfile.update({ cdl_status: 'UNKNOWN', truck_driving_experience: 'UNKNOWN' }, 1);
  const r = driverProfile.readiness(1);

  assert.strictEqual(r.truckFocus, true);
  assert.strictEqual(r.complete, false);
  assert.ok(r.blockers.some(b => b.field === 'cdl_status'));
  assert.ok(r.blockers.every(b => b.message && b.message.length > 20),
    'cada bloqueador precisa explicar a consequência, não só nomear o campo');

  perfilCompleto();
  assert.strictEqual(driverProfile.readiness(1).complete, true);
  foco(false);
});

test('foco amplo (padrão) — campos de motorista em UNKNOWN não travam o sistema inteiro', () => {
  foco(false);
  driverProfile.update({ cdl_status: 'UNKNOWN', truck_driving_experience: 'UNKNOWN' }, 1);
  const r = driverProfile.readiness(1);

  assert.strictEqual(r.truckFocus, false);
  assert.strictEqual(r.complete, true, 'sem foco em caminhão, CDL desconhecida não é bloqueio geral');
  const cdl = r.blockers.find(b => b.field === 'cdl_status');
  assert.ok(cdl, 'o aviso continua existindo — só muda de peso');
  assert.strictEqual(cdl.severity, 'LOW');
  assert.strictEqual(cdl.scope, 'TRUCK_JOBS_ONLY');
  assert.match(cdl.message, /vagas de caminhão/i);

  perfilCompleto();
});

// ---------------------------------------------------------------------------
// §2, §32 — a cadeia de agentes
// ---------------------------------------------------------------------------

test('§32 — a cadeia classifica, decide e registra o estado da vaga', () => {
  perfilCompleto();
  const jobId = inserirVaga();

  const r = orchestrator.runSeasonalChain(jobId, { userId: 1 });

  assert.strictEqual(r.truck.classification, truckGate.CLASSIFICATION.CONFIRMED);
  assert.strictEqual(r.decision, 'APPLY');
  assert.strictEqual(r.state, 'MATCHED');

  const row = db.prepare('SELECT * FROM seasonal_jobs WHERE id = ?').get(jobId);
  assert.strictEqual(row.truck_classification, 'TRUCK_DRIVER_CONFIRMED');
  assert.strictEqual(row.cdl_requirement, 'CDL_REQUIRED_BEFORE_HIRE');
  assert.strictEqual(row.decision, 'APPLY');
  assert.ok(row.channels_json, 'os canais precisam ficar gravados para filtro em SQL');
});

test('§25, §32 — no foco "só caminhão", vaga agrícola com direção incidental é filtrada pela cadeia', () => {
  foco(true);
  const jobId = inserirVaga({
    job_title: 'Farm Worker',
    soc_code: '45-2092.00',
    duties_description: 'Harvest lettuce by hand. Workers may occasionally drive truck to the shed.',
    special_requirements: 'Must be able to lift 50 lbs.'
  });

  const r = orchestrator.runSeasonalChain(jobId, { userId: 1 });

  assert.strictEqual(r.truck.classification, truckGate.CLASSIFICATION.NOT);
  assert.strictEqual(r.requireTruck, true);
  assert.strictEqual(r.state, 'FILTERED');
  assert.strictEqual(r.stoppedAt, 'TRUCK_GATE',
    'a cadeia para no portão — não gasta análise em vaga fora do alvo');
  foco(false);
});

test('foco amplo (padrão) — vaga agrícola segue a cadeia inteira e pode ser enviada', () => {
  foco(false);
  perfilCompleto();
  const seasonal = require('../services/seasonalService');
  seasonal.updateConfig({});
  const store = require('../services/candidateService').environment('seasonal', 'US', 1);
  store.updateProfile({ full_name: 'Teste Amplo', email: 't@example.com', years_of_experience: 4 });

  const jobId = inserirVaga({
    job_title: 'Farm Worker',
    soc_code: '45-2092.00',
    duties_description: 'Harvest lettuce by hand. 3 months experience required. Workers may occasionally drive truck to the shed.',
    special_requirements: 'Must be able to lift 50 lbs.'
  });

  const r = orchestrator.runSeasonalChain(jobId, { userId: 1 });

  assert.strictEqual(r.truck.classification, truckGate.CLASSIFICATION.NOT, 'o portão continua classificando');
  assert.strictEqual(r.requireTruck, false);
  assert.notStrictEqual(r.stoppedAt, 'TRUCK_GATE', 'a cadeia NÃO para no portão');
  assert.notStrictEqual(r.state, 'FILTERED');

  // A regra de ocupação passa e diz por quê; nada a ver com caminhão trava.
  const rule = r.decisionDetail.rules.find(x => x.id === 'truck_driver_match');
  assert.ok(rule && rule.passed, 'no foco amplo a regra de ocupação passa');
  assert.ok(!r.eligibility.unresolved.some(u => u.id === 'minimum_experience'),
    '"3 months experience" numa vaga agrícola não é experiência de direção');
  const geral = r.eligibility.satisfied.find(s => s.id === 'minimum_general_experience');
  assert.ok(geral, 'experiência mínima na função é comparada com os anos do perfil geral');
});

test('foco amplo — a carta de uma vaga não-caminhão não fala de CDL nem de caminhão', () => {
  perfilCompleto();
  const emailService = require('../services/seasonalEmailService');
  const profile = { fullName: 'Teste Amplo', email: 't@example.com', yearsOfExperience: 4, skills: ['harvest'], summary: 'Seasonal farm worker.' };
  const dp = driverProfile.get(1);
  const farm = emailService.buildCoverLetter({
    job: { job_title: 'Farm Worker', employer_name: 'Green Acres', job_order_id: 'H-300-X', duties_description: 'harvest', truck_classification: 'NOT_TRUCK_DRIVER' },
    profile, resume: null, driverProfile: dp
  });
  assert.ok(!/CDL|truck driving/i.test(farm), 'vaga agrícola: nada de CDL ou caminhão na carta');
  assert.match(farm, /4 years of professional experience/);

  const truck = emailService.buildCoverLetter({
    job: { job_title: 'Heavy Truck Driver', employer_name: 'Haul Co', job_order_id: 'H-300-Y', duties_description: 'haul grain', truck_classification: 'TRUCK_DRIVER_CONFIRMED' },
    profile, resume: null, driverProfile: dp
  });
  assert.match(truck, /CDL/, 'vaga de caminhão: a CDL declarada entra na carta');
});

test('§18, §54 — perfil UNKNOWN leva a vaga para ação humana, não para envio', () => {
  driverProfile.update({ cdl_status: 'UNKNOWN', driving_record: 'UNKNOWN' }, 1);
  const jobId = inserirVaga();

  const r = orchestrator.runSeasonalChain(jobId, { userId: 1 });

  assert.strictEqual(r.decision, 'REVIEW_REQUIRED');
  assert.strictEqual(r.state, 'MANUAL_ACTION_REQUIRED');
  assert.ok(r.eligibility.unresolved.length > 0);

  perfilCompleto();
});

test('§72 — cada passo da cadeia deixa rastro auditável', () => {
  perfilCompleto();
  const jobId = inserirVaga();
  orchestrator.runSeasonalChain(jobId, { userId: 1 });

  const trail = orchestrator.auditTrail(jobId);
  assert.ok(trail.length >= 4, `esperava vários passos, veio ${trail.length}`);

  const agentes = trail.map(t => t.agent);
  for (const esperado of ['TruckDriverGate', 'DecisionEngine']) {
    assert.ok(agentes.includes(esperado), `faltou o registro de ${esperado}`);
  }
  assert.ok(trail.every(t => t.summary && t.outcome),
    'todo registro precisa dizer o que aconteceu e como terminou');
  assert.ok(trail.some(t => t.state_to), 'as transições de estado precisam aparecer na trilha');
});

test('§41, §42 — vaga só com telefone gera ação manual de WhatsApp, nunca envio', () => {
  const jobId = inserirVaga({
    employer_email: null,
    application_email: null,
    application_method: 'PHONE'
  });

  const r = orchestrator.runSeasonalChain(jobId, { userId: 1 });

  assert.ok(r.manualAction, 'a ação manual precisa ser preparada');
  assert.strictEqual(r.manualAction.kind, 'WHATSAPP_MESSAGE');
  assert.strictEqual(r.manualAction.automation, channelAgent.AUTOMATION.MANUAL_DRAFT);
  assert.ok(r.manualAction.deepLink.startsWith('https://wa.me/'));
  assert.ok(r.manualAction.instruction.includes('não envia'),
    'a instrução precisa deixar explícito que quem envia é o usuário');

  assert.strictEqual(r.decision, 'REVIEW_REQUIRED', 'sem e-mail não há candidatura automática');

  const pendentes = orchestrator.pendingManualActions();
  assert.ok(pendentes.some(a => a.job_id === jobId));
});

test('§42 — a mensagem de WhatsApp não afirma o que o perfil não sabe', () => {
  driverProfile.update({ cdl_status: 'UNKNOWN', truck_driving_experience: 'UNKNOWN' }, 1);

  const job = { job_title: 'Heavy Truck Driver', job_order_id: 'H-300-99999', employer_phone: '6205550142' };
  const msg = channelAgent.buildWhatsappMessage({
    job, profile: { fullName: 'Ana Souza' }, driverProfile: driverProfile.get(1)
  });

  assert.ok(msg.includes('Ana Souza'));
  assert.ok(!/CDL/i.test(msg), 'sem CDL declarada, a mensagem não pode citar CDL');
  assert.ok(!/\d+\s*year/i.test(msg), 'sem experiência declarada, a mensagem não pode citar anos');

  perfilCompleto();
  const msg2 = channelAgent.buildWhatsappMessage({
    job, profile: { fullName: 'Ana Souza' }, driverProfile: driverProfile.get(1)
  });
  assert.ok(/CDL/i.test(msg2), 'com CDL declarada, a mensagem pode e deve citá-la');
});

test('§40, §44 — os canais são classificados com o nível de automação correto', () => {
  const comEmail = channelAgent.classify({
    application_email: 'jobs@farm.example', employer_phone: '6205550142',
    application_url: 'https://farm.example/apply'
  });

  assert.strictEqual(comEmail.email.automation, channelAgent.AUTOMATION.AUTO);
  assert.strictEqual(comEmail.phone.automation, channelAgent.AUTOMATION.MANUAL);
  assert.strictEqual(comEmail.whatsapp.automation, channelAgent.AUTOMATION.MANUAL_DRAFT);
  assert.strictEqual(comEmail.whatsapp.eligibility, channelAgent.ELIGIBILITY.UNKNOWN_CONSENT,
    'telefone presente não estabelece consentimento de WhatsApp (§41)');
  assert.strictEqual(comEmail.automatable, true);

  const soAdvogado = channelAgent.classify({ attorney_email: 'law@firm.example' });
  assert.strictEqual(soAdvogado.email.kind, 'ATTORNEY');
  assert.strictEqual(soAdvogado.email.explicitlyListed, false,
    'e-mail de representante legal não é e-mail de candidatura explicitamente listado');
  assert.strictEqual(soAdvogado.automatable, false);
});

// ---------------------------------------------------------------------------
// §49, §63, §70 — o agendador
// ---------------------------------------------------------------------------

test('§49 — as tarefas periódicas do spec existem e nascem desligadas', () => {
  scheduler.ensureTasks();
  const s = scheduler.status();

  for (const esperada of ['seasonal_import', 'seasonal_dispatch', 'seasonal_stale_check']) {
    assert.ok(s.tasks.some(t => t.id === esperada), `faltou a tarefa ${esperada}`);
  }
  assert.strictEqual(s.enabled, false, 'a automação não se liga sozinha');
  assert.ok(s.tasks.every(t => t.description), 'cada tarefa precisa dizer o que faz');
});

test('§49, §63 — ligar a automação habilita as tarefas do Seasonal de uma vez', () => {
  const s = scheduler.setEnabled(true);

  assert.strictEqual(s.enabled, true);
  const ativas = s.tasks.filter(t => t.enabled).map(t => t.id);
  assert.ok(ativas.includes('seasonal_import'));
  assert.ok(ativas.includes('seasonal_dispatch'));
});

test('§70 — o tique roda as tarefas vencidas SEM nenhuma interação do usuário', async () => {
  scheduler.setEnabled(true);
  const r = await scheduler.tick({ userId: 1 });

  assert.strictEqual(r.skipped, false, 'com a automação ligada, o tique precisa rodar');
  assert.ok(r.ran > 0, 'nenhuma tarefa rodou no primeiro tique');

  // §70: "database persists results" — o resultado ficou gravado.
  const runs = scheduler.history({ limit: 20 });
  assert.ok(runs.length > 0);
  assert.ok(runs.every(x => x.status && x.finished_at),
    'toda execução precisa ter status e horário de término gravados');
});

test('§70 — sem feed configurado, a importação é PULADA e diz por quê', async () => {
  const r = await scheduler.runTask('seasonal_import', { userId: 1, force: true });

  assert.strictEqual(r.status, 'SKIPPED');
  assert.ok(r.message.includes('DOL'), 'a mensagem precisa dizer o que falta configurar');
});

test('§32, §70 — a cadeia de agentes roda sozinha pela tarefa periódica', async () => {
  perfilCompleto();
  inserirVaga();
  inserirVaga({ job_title: 'Farm Worker', soc_code: '45-2092.00',
    duties_description: 'Pick strawberries. May occasionally drive truck.' });

  const r = await scheduler.runTask('seasonal_agent_chain', { userId: 1, force: true });

  assert.strictEqual(r.status, 'OK');
  assert.ok(r.metrics.processed >= 2);

  const semClassificar = db.prepare(
    'SELECT COUNT(*) v FROM seasonal_jobs WHERE truck_classification IS NULL').get().v;
  assert.strictEqual(semClassificar, 0, 'a tarefa precisa cobrir tudo que estava pendente');
});

test('§38, §63 — com o envio pausado, o despacho é pulado e nada sai', async () => {
  db.prepare('UPDATE seasonal_config SET pause_email_sending = 1').run();
  const r = await scheduler.runTask('seasonal_dispatch', { userId: 1, force: true });

  assert.strictEqual(r.status, 'SKIPPED');
  assert.ok(r.message.toLowerCase().includes('pausad'));

  db.prepare('UPDATE seasonal_config SET pause_email_sending = 0').run();
});

test('§53 — a pausa GERAL impede até a execução forçada de tarefa externa', async () => {
  db.prepare("UPDATE core_system_settings SET value = '1' WHERE key = 'global_pause_all_automations'").run();

  const t = await scheduler.tick({ userId: 1 });
  assert.strictEqual(t.skipped, true);
  assert.strictEqual(t.reason, 'GLOBAL_PAUSE');

  db.prepare("UPDATE core_system_settings SET value = '0' WHERE key = 'global_pause_all_automations'").run();
});

test('§49 — falhas consecutivas afastam a próxima tentativa em vez de martelar', () => {
  const row = { interval_minutes: 60, last_run_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
                consecutive_failures: 0 };

  const semFalha = Date.parse(scheduler.computeNextRun(row));
  const comFalhas = Date.parse(scheduler.computeNextRun(Object.assign({}, row, { consecutive_failures: 3 })));

  assert.ok(comFalhas > semFalha, 'o backoff precisa afastar a próxima execução');
});

test('§49 — desligar a automação faz o tique não rodar nada', async () => {
  scheduler.setEnabled(false);
  const r = await scheduler.tick({ userId: 1 });

  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.reason, 'DISABLED');

  scheduler.setEnabled(true);
});

// ---------------------------------------------------------------------------
// §55 — "enquanto você esteve fora"
// ---------------------------------------------------------------------------

test('§55 — o relatório conta o que os robôs fizeram e o que espera pelo usuário', () => {
  const r = awayReport.build({ hours: 24, userId: 1 });

  assert.ok(r.headline && r.headline.length > 10);
  assert.ok(r.seasonal.truckJobs >= 1, 'vagas de motorista precisam ser contadas');
  assert.ok(r.seasonal.notTruck >= 1, 'vagas fora do alvo também são contadas, não somem');
  assert.ok(Array.isArray(r.actions));
  assert.ok(r.scheduler.tasks.length > 0);
  // O relatório reflete o teto vigente, seja ele qual for — fixar o número aqui
  // faria este teste quebrar a cada revisão legítima do limite.
  assert.strictEqual(r.quota.limit, require('../services/seasonalEmailService').ABSOLUTE_DAILY_CAP);
});

test('§30, §55 — a contagem de 2027 vive DENTRO do universo de motorista', () => {
  // Uma vaga 2027 que NÃO é de motorista não pode inflar o número.
  const id = inserirVaga({
    job_title: 'Farm Worker', soc_code: '45-2092.00',
    duties_description: 'Harvest crops.', start_date: '2027-03-01', end_date: '2027-10-01'
  });
  db.prepare("UPDATE seasonal_jobs SET timeline_class = 'TARGET_2027' WHERE id = ?").run(id);
  orchestrator.runSeasonalChain(id, { userId: 1 });

  const r = awayReport.build({ hours: 24, userId: 1 });
  const contadas = db.prepare(`
    SELECT COUNT(*) v FROM seasonal_jobs
    WHERE timeline_class = 'TARGET_2027'
      AND truck_classification IN ('TRUCK_DRIVER_CONFIRMED','TRUCK_DRIVER_PROBABLE')`).get().v;

  assert.strictEqual(r.seasonal.target2027, contadas,
    'a §30 restringe a prioridade 2027 ao universo de motorista');
});

test('§55 — as ações pendentes trazem produto, contagem e explicação', () => {
  const r = awayReport.build({ hours: 24, userId: 1 });

  for (const a of r.actions) {
    assert.ok(a.product && a.kind && a.label, 'ação sem identificação');
    assert.ok(a.detail && a.detail.length > 20, `ação "${a.label}" sem explicação`);
    assert.ok(Number.isInteger(a.count));
  }
});

// ---------------------------------------------------------------------------
// Integridade e prontidão
// ---------------------------------------------------------------------------

test('§52, §53 — a verificação de integridade dos agentes passa', () => {
  const r = orchestrator.selfCheck();
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(r.policyChecks.every(c => c.ok));
});

test('a varredura de prontidão nomeia cada bloqueador com a ação correspondente', () => {
  const r = readiness.check({ userId: 1 });

  assert.ok(typeof r.ready === 'boolean');
  assert.ok(r.items.length >= 10, 'a varredura precisa cobrir o sistema, não uma amostra');

  for (const b of r.blockers) {
    assert.ok(b.title, 'bloqueador sem título');
    assert.ok(b.impact, `bloqueador "${b.title}" não diz o que quebra`);
    assert.ok(b.fix, `bloqueador "${b.title}" não diz o que fazer`);
  }

  // Sem currículo, sem Gmail e sem feed, o ambiente de teste NÃO pode se
  // apresentar como pronto — seria a mentira mais cara que este sistema poderia contar.
  assert.strictEqual(r.ready, false);
  assert.ok(r.blockers.some(b => b.id === 'gmail_connected'));

  const texto = readiness.toText(r);
  assert.ok(texto.includes('BLOQUEADORES'));
});

test('a varredura agrupa por capacidade, porque o sistema degrada em camadas', () => {
  const r = readiness.check({ userId: 1 });

  assert.ok(r.capabilities[readiness.CAPABILITY.RUNTIME]);
  assert.ok(r.capabilities[readiness.CAPABILITY.SENDING]);
  assert.strictEqual(r.capabilities[readiness.CAPABILITY.SENDING].available, false,
    'sem Gmail conectado, enviar não é uma capacidade disponível');
  assert.strictEqual(r.capabilities[readiness.CAPABILITY.INTELLIGENCE].available, true,
    'a camada de LLM é opcional: sua ausência não indisponibiliza nada');
});
