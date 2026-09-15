/**
 * AI Job Intelligence Platform — API.
 *
 * Rotas espelham a separação de produtos e países do spec (§26, §27, §28):
 *   /api/gupy/:country/*      country ∈ {br, us}
 *   /api/indeed/:country/*    country ∈ {br, us}
 *   /api/seasonal/*           somente US
 *   /api/core/*               perfil mestre, currículos, ATS, saúde
 *
 * Nenhuma rota de um produto lê dados de outro.
 */

// Precisa vir ANTES de qualquer require que leia process.env — o banco lê
// DB_PATH e o secretBox lê APP_ENCRYPTION_KEY já no carregamento do módulo.
//
// O caminho é explícito, ao lado deste arquivo. O padrão do dotenv é o
// diretório de trabalho do processo — e uma hospedagem gerenciada pode iniciar
// o app de outro lugar, caso em que o `.env` da pasta do projeto era ignorado
// em silêncio. Variáveis já presentes no ambiente (painel da hospedagem,
// Docker) continuam mandando: o dotenv nunca sobrescreve o que já existe.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const { db, logCore, migration, uploadsRoot } = require('./config/database');
const candidate = require('./services/candidateService');
const atsService = require('./services/atsService');
const { gupyService, indeedService, normCountry } = require('./services/boardService');
const seasonal = require('./services/seasonalService');
const emailService = require('./services/seasonalEmailService');
const gmail = require('./services/gmailService');
const auth = require('./services/authService');
const providers = require('./services/providerConnectionService');
const googleCreds = require('./services/googleCredentialsService');
const gmailSenders = require('./services/gmailSenderService');
const seasonalTemplates = require('./services/seasonalTemplateService');
const seasonalUi = require('./services/seasonalUiService');
const driverProfile = require('./services/driverProfileService');
const orchestrator = require('./services/agentOrchestrator');
const scheduler = require('./services/scheduler');
const awayReport = require('./services/awayReport');
const ai = require('./services/aiService');
const readiness = require('./services/readinessService');
const backup = require('./services/backupService');
const disclosureImport = require('./services/disclosureImportService');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');

// Atrás de um proxy reverso (Caddy no VPS, ou a hospedagem gerenciada) o
// Express só enxerga "http" e o IP do proxy. Com trust proxy ligado, req.protocol
// e req.ip vêm dos cabeçalhos X-Forwarded-* — é o que faz o redirect_uri do
// Google sair com https e o limite de requisições contar por visitante real.
// TRUST_PROXY=false desliga; qualquer outro valor (ou produção) liga.
const trustProxy = process.env.TRUST_PROXY !== undefined
  ? (process.env.TRUST_PROXY !== 'false' && process.env.TRUST_PROXY !== '0')
  : process.env.APP_ENV === 'production';
if (trustProxy) app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Upload — destino resolvido por campo, sem depender de escopo externo
// ---------------------------------------------------------------------------

function uploadFolderFor(req) {
  if (req.path.includes('/portfolio')) return 'portfolio';
  if (req.path.includes('/documents') || req.path.includes('/resumes')) return 'documents';
  return 'resumes';
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(uploadsRoot, uploadFolderFor(req));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    // `uploadFolderFor(req)` é recalculado aqui — o bug anterior lia uma
    // variável que só existia no escopo de `destination`.
    const kind = uploadFolderFor(req) === 'portfolio' ? 'photo' : 'doc';
    const ext = path.extname(file.originalname || '').toLowerCase();
    const base = path.basename(file.originalname || 'arquivo', ext)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60).toLowerCase() || 'arquivo';
    cb(null, `${kind}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${base}${ext}`);
  }
});

const ALLOWED_DOC_EXT = new Set(['.pdf', '.docx', '.doc', '.txt']);
const ALLOWED_IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowed = uploadFolderFor(req) === 'portfolio' ? ALLOWED_IMG_EXT : ALLOWED_DOC_EXT;
    if (!allowed.has(ext)) {
      return cb(new UserError(`Formato não aceito: ${ext || 'sem extensão'}. Envie ${[...allowed].join(', ')}.`, 400));
    }
    cb(null, true);
  }
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

class UserError extends Error {
  constructor(message, status = 400) { super(message); this.userFacing = true; this.status = status; }
}

app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Cabeçalhos de segurança básicos (spec §53 do build prompt).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Rate limiting simples em memória, por IP.
const rateBuckets = new Map();
app.use('/api/', (req, res, next) => {
  const key = req.ip || 'local';
  const now = Date.now();
  const windowMs = 60000;
  const limit = Number(process.env.RATE_LIMIT_PER_MINUTE || 240);

  let b = rateBuckets.get(key);
  if (!b || now - b.start > windowMs) { b = { start: now, count: 0 }; rateBuckets.set(key, b); }
  b.count++;
  if (b.count > limit) {
    return res.status(429).json({
      error: 'Muitas requisições em pouco tempo. Aguarde um minuto e tente de novo.',
      retryAfterSeconds: Math.ceil((windowMs - (now - b.start)) / 1000)
    });
  }
  next();
});

/** Envolve handlers async e encaminha erros ao tratador central. */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Autenticação (spec de autenticação §1, §4, §23)
//
// Resolve o usuário a partir da sessão. Sem Google configurado, a instalação
// opera em modo operador local — declarado abertamente, nunca disfarçado de
// login do Google.
// ---------------------------------------------------------------------------

app.use((req, res, next) => {
  req.cookies = auth.parseCookies(req.headers.cookie);

  const session = auth.getSession(req.cookies[auth.SESSION_COOKIE]);
  if (session) {
    req.session = session;
    req.user = auth.getUser(session.user_id);
  } else if (auth.localOperatorMode()) {
    // Sem login configurado: um único operador, sem sessão.
    req.user = auth.localOperator();
    req.localOperator = true;
  }

  next();
});

/** Exige usuário autenticado. A isolação é do backend, não da rota (spec §23). */
function requireUser(req, res, next) {
  if (!req.user) {
    return next(new UserError('Entre com o Google para continuar.', 401));
  }
  if (req.user.status !== 'ACTIVE') {
    return next(new UserError('Esta conta está suspensa.', 403));
  }
  next();
}

/** Valida o país da rota antes de chegar ao serviço. */
function countryParam(req, res, next) {
  const c = String(req.params.country || '').toLowerCase();
  if (c !== 'br' && c !== 'us') {
    return next(new UserError('País inválido nesta rota. Use "br" ou "us".', 404));
  }
  req.country = c.toUpperCase();
  next();
}

// ---------------------------------------------------------------------------
// CORE — perfil mestre, currículos, ATS
// ---------------------------------------------------------------------------

/**
 * Health endpoints (spec §69).
 *
 * `live`  — o processo está de pé.
 * `ready` — as dependências LOCAIS críticas respondem. Provedor externo caído
 *           deixa a integração degradada, mas não derruba a prontidão da
 *           aplicação: o produto continua servindo o que já está no banco.
 */
app.get('/health/live', (req, res) => {
  res.json({ status: 'alive', uptimeSeconds: Math.round(process.uptime()) });
});

app.get('/health/ready', (req, res) => {
  const checks = {};
  let ready = true;

  try {
    db.prepare('SELECT 1 AS ok').get();
    checks.database = 'ok';
  } catch (e) {
    checks.database = 'unreachable';
    ready = false;
  }

  try {
    const v = db.prepare("SELECT value FROM core_schema_meta WHERE key = 'schema_version'").get();
    const applied = v ? parseInt(v.value, 10) : 0;
    checks.migrations = applied === migration.to ? 'ok' : `incompatível (banco v${applied}, código v${migration.to})`;
    if (applied !== migration.to) ready = false;
  } catch (e) {
    checks.migrations = 'indeterminado';
    ready = false;
  }

  checks.storage = fs.existsSync(uploadsRoot) ? 'ok' : 'diretório de uploads ausente';
  if (checks.storage !== 'ok') ready = false;

  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
});

app.get('/api/core/health', (req, res) => {
  const checks = {
    database: 'HEALTHY',
    gupy_br: gupyService.getIntegration('BR').health_status,
    gupy_us: gupyService.getIntegration('US').health_status,
    indeed_br: indeedService.getIntegration('BR').health_status,
    indeed_us: indeedService.getIntegration('US').health_status,
    seasonal_dol: seasonal.getConfig().health_status,
    gmail: gmail.status().connected ? 'HEALTHY' : gmail.status().authStatus
  };
  // A pior condição entre as integrações define o status geral. Nada de
  // reportar HEALTHY com integrações caídas (spec §41).
  const RANK = { HEALTHY: 0, DEGRADED: 1, NOT_CONFIGURED: 1, DISCONNECTED: 2, REQUIRES_ATTENTION: 3, ERROR: 4 };
  const worst = Object.values(checks)
    .reduce((acc, v) => ((RANK[v] ?? 2) > (RANK[acc] ?? 0) ? v : acc), 'HEALTHY');

  res.json({ status: worst, checks, schemaVersion: migration.to, uptimeSeconds: Math.round(process.uptime()) });
});

// ---------------------------------------------------------------------------
// AUTENTICAÇÃO DA APLICAÇÃO (spec de autenticação §3, §4, §18, §30, §34)
//
// Entrar com o Google identifica o usuário AQUI. Não conecta Gupy nem Indeed,
// e não concede permissão de envio no Gmail — essa é incremental e separada.
// ---------------------------------------------------------------------------

app.get('/api/auth/status', wrap((req, res) => {
  res.json(auth.authStatus(req.user));
}));

app.get('/api/auth/google/start', wrap((req, res) => {
  // Domínio configurado ≠ domínio acessado → erro claro AQUI, não um 400 no Google.
  googleCreds.assertDomainConsistent(req);
  const { url, state, nonce } = auth.beginLogin({ returnTo: String(req.query.returnTo || '/'), req });

  // `state` e `nonce` viajam em cookie HttpOnly de curta duração (proteção CSRF).
  res.setHeader('Set-Cookie', auth.buildCookie(
    auth.STATE_COOKIE, JSON.stringify({ state, nonce }), { maxAgeSeconds: 600 }
  ));
  res.json({ url });
}));

app.get('/api/auth/google/callback', wrap(async (req, res) => {
  if (req.query.error) {
    return res.redirect('/#/entrar?erro=cancelado');
  }

  let expected = {};
  try { expected = JSON.parse(req.cookies[auth.STATE_COOKIE] || '{}'); } catch (e) {}

  try {
    const { session } = await auth.completeLogin({
      code: String(req.query.code || ''),
      state: String(req.query.state || ''),
      expectedState: expected.state,
      nonce: expected.nonce,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
      req
    });

    res.setHeader('Set-Cookie', [
      auth.buildCookie(auth.SESSION_COOKIE, session.id),
      auth.buildCookie(auth.STATE_COOKIE, '', { clear: true })
    ]);
    res.redirect('/#/');
  } catch (err) {
    logCore('auth', 'login_failed', err.message, null, null, 'warn');
    res.redirect('/#/entrar?erro=falha');
  }
}));

/** Sair encerra a sessão daqui — não desconecta o Google nem o Gmail (§34). */
app.post('/api/auth/logout', wrap((req, res) => {
  if (req.session) auth.revokeSession(req.session.id);
  res.setHeader('Set-Cookie', auth.buildCookie(auth.SESSION_COOKIE, '', { clear: true }));
  res.json({
    signedOut: true,
    note: 'Você saiu do Job Intelligence. Sua conta do Google continua conectada no navegador, e a autorização do Gmail não foi revogada.'
  });
}));

app.get('/api/auth/sessions', requireUser, wrap((req, res) => {
  res.json({ sessions: auth.listSessions(req.user.id) });
}));

app.post('/api/auth/sessions/revoke-others', requireUser, wrap((req, res) => {
  res.json(auth.revokeAllSessions(req.user.id, req.session ? req.session.id : null));
}));

/** Contexto de produto/país da sessão (spec §4, §22). */
app.put('/api/auth/context', requireUser, wrap((req, res) => {
  if (!req.session) return res.json({ ok: true, note: 'Modo operador local: não há sessão para contextualizar.' });
  auth.setSessionContext(req.session.id, {
    product: req.body.product ? String(req.body.product).toUpperCase() : null,
    country: req.body.country ? String(req.body.country).toUpperCase() : null
  });
  res.json({ ok: true });
}));

// --- Conexões de provedor — diferentes do login (spec §16, §17, §30, §31) ---

app.get('/api/account', requireUser, wrap((req, res) => {
  res.json({
    auth: auth.authStatus(req.user),
    sessions: auth.listSessions(req.user.id),
    connections: providers.listConnections(req.user.id),
    health: providers.healthMatrix(req.user.id, {
      gupyMcp: gupyService.getIntegration('BR').health_status,
      // O Indeed reporta o estado real do adapter: sem acesso oficial para
      // cliente próprio, e não um 'desconectado' que sugeriria problema nosso.
      indeedMcp: process.env.INDEED_CUSTOM_MCP_ENABLED === 'true'
        ? indeedService.getIntegration('US').health_status
        : 'CUSTOM_CLIENT_ACCESS_UNAVAILABLE',
      seasonalDol: seasonal.getConfig().health_status,
      gmail: gmail.status().connected ? 'CONNECTED' : gmail.status().authStatus
    })
  });
}));

app.get('/api/account/connections', requireUser, wrap((req, res) => {
  res.json({ connections: providers.listConnections(req.user.id) });
}));

app.post('/api/account/connections/:provider/disconnect', requireUser, wrap((req, res) => {
  const p = String(req.params.provider).toUpperCase();
  if (p === 'GMAIL') {
    gmail.disconnect();
    return res.json(providers.disconnect(req.user.id, 'GMAIL'));
  }
  res.json(providers.disconnect(req.user.id, p));
}));

// ---------------------------------------------------------------------------
// CANDIDATO — sempre no escopo de um ambiente (spec §1A, §1B, §1E)
//
//   /api/env/:platform/:country/*   platform ∈ {gupy, indeed, seasonal}
//
// Não existe rota de perfil ou currículo global. Todo acesso declara a qual
// plataforma e país pertence, e o serviço recusa ids de outro ambiente.
// ---------------------------------------------------------------------------

const envRouter = express.Router({ mergeParams: true });

envRouter.use(requireUser);

/**
 * Resolve o ambiente já amarrado ao usuário autenticado.
 * A autorização é sempre usuário + produto + país (spec §23).
 */
function withEnv(req) {
  try {
    return candidate.environment(req.params.platform, req.params.country, req.user.id);
  } catch (e) {
    throw new UserError(e.message, e.status || 404);
  }
}

envRouter.get('/profile', wrap((req, res) =>
  res.json({ profile: withEnv(req).getProfile() })));

envRouter.put('/profile', wrap((req, res) =>
  res.json({ profile: withEnv(req).updateProfile(req.body || {}) })));

envRouter.get('/resumes', wrap((req, res) => {
  const store = withEnv(req);
  res.json({
    environment: store.label,
    resumes: store.listResumes({
      careerTrack: req.query.careerTrack || null,
      docType: req.query.docType || null,
      includeArchived: req.query.includeArchived === 'true'
    })
  });
}));

envRouter.post('/resumes', upload.single('file'), wrap((req, res) => {
  const store = withEnv(req);
  if (!req.file) throw new UserError('Nenhum arquivo foi enviado.');
  const out = store.addResume(req.file, {
    name: req.body.name,
    career_track: req.body.career_track,
    doc_type: req.body.doc_type,
    visa_type: req.body.visa_type,
    is_default: req.body.is_default === '1' || req.body.is_default === 'true'
  });
  res.json({
    environment: store.label,
    resume: out.resume,
    extraction: {
      confidence: out.extraction.confidence,
      characters: (out.extraction.text || '').length,
      pages: out.extraction.pages,
      warnings: out.extraction.warnings
    }
  });
}));

envRouter.put('/resumes/:id', wrap((req, res) =>
  res.json({ resume: withEnv(req).updateResume(Number(req.params.id), req.body || {}) })));

envRouter.delete('/resumes/:id', wrap((req, res) =>
  res.json(withEnv(req).archiveResume(Number(req.params.id)))));

envRouter.get('/resumes/:id/suggestions', wrap((req, res) =>
  res.json(withEnv(req).suggestSkillsFromResume(Number(req.params.id)))));

/**
 * Download — o documento só é servido pelo ambiente dono dele (spec §1H).
 * Um id do Gupy pedido pela rota do Indeed devolve 404, não o arquivo.
 */
envRouter.get('/resumes/:id/file', wrap((req, res) => {
  const store = withEnv(req);
  const r = store.getResume(Number(req.params.id));
  if (!r) throw new UserError(`Documento não encontrado em ${store.label}.`, 404);

  const resolved = path.resolve(r.file_path);
  if (!resolved.startsWith(path.resolve(uploadsRoot))) {
    throw new UserError('Caminho de arquivo inválido.', 400);
  }
  if (!fs.existsSync(resolved)) throw new UserError('O arquivo não está mais disponível no servidor.', 404);

  res.setHeader('Content-Type', r.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(r.original_name || r.filename)}"`);
  fs.createReadStream(resolved).pipe(res);
}));

// --- ATS do ambiente ---

envRouter.get('/ats/center', wrap((req, res) =>
  res.json(atsService.atsCenter(req.params.platform, req.params.country, req.user.id))));

envRouter.post('/ats/analyze/:resumeId', wrap((req, res) =>
  res.json(atsService.analyzeResume(
    req.params.platform, req.params.country, Number(req.params.resumeId),
    { force: Boolean(req.body && req.body.force), userId: req.user.id }
  ))));

envRouter.post('/ats/compare', wrap((req, res) => {
  const store = withEnv(req);
  const { resumeId, jobId } = req.body || {};
  if (!resumeId || !jobId) throw new UserError('Informe resumeId e jobId.');

  // A vaga também precisa ser do ambiente atual (§1E, §1F).
  let job = null;
  if (store.platform === 'gupy') job = gupyService.getJob(store.country, jobId);
  else if (store.platform === 'indeed') job = indeedService.getJob(store.country, jobId);
  else job = seasonal.getJob(jobId);

  if (!job) throw new UserError(`Vaga não encontrada em ${store.label}.`, 404);

  const normalized = store.platform === 'seasonal'
    ? { title: job.job_title, company: job.employer_name,
        description: job.duties_description, requirements: job.special_requirements }
    : job;

  res.json(atsService.compareResumeToJob(store.platform, store.country, Number(resumeId), normalized, { userId: req.user.id }));
}));

// Seasonal é US-only, mas a rota mantém o país explícito para que o endereço
// sempre declare o ambiente: /api/env/seasonal/us/...
app.use('/api/env/:platform/:country', envRouter);

// --- Documentos herdados da v2, aguardando atribuição explícita (spec §1J) ---

app.get('/api/core/unassigned-documents', requireUser, wrap((req, res) => res.json({
  documents: candidate.listUnassignedDocuments({ includeAssigned: req.query.includeAssigned === 'true' }),
  note: 'Estes documentos vieram da biblioteca compartilhada da versão anterior. Escolha a qual plataforma e país cada um pertence — o sistema não atribui sozinho.'
})));

app.post('/api/core/unassigned-documents/:id/assign', requireUser, wrap((req, res) => {
  const { platform, country } = req.body || {};
  if (!platform) throw new UserError('Informe a plataforma de destino.');
  res.json(candidate.assignDocument(Number(req.params.id), platform, country, req.user.id));
}));

// --- Credenciais do cliente OAuth do Google -------------------------------
// O client_secret entra, mas nunca sai: nenhuma resposta abaixo o devolve.

app.get('/api/core/google-credentials', wrap((req, res) =>
  res.json(googleCreds.status(req))));

app.put('/api/core/google-credentials', requireUser, wrap((req, res) => {
  const { clientId, clientSecret } = req.body || {};
  res.json(googleCreds.save({ clientId, clientSecret }));
}));

app.delete('/api/core/google-credentials', requireUser, wrap((req, res) =>
  res.json(googleCreds.clear())));

// --- Contas de envio do Gmail, em rodízio (F1.3) --------------------------
//
// Nenhuma rota aqui devolve token. A listagem traz e-mail, estado e cota —
// o suficiente para operar, nada além.

app.get('/api/core/gmail/senders', requireUser, wrap((req, res) =>
  res.json(gmailSenders.status({ globalCap: emailService.configuredLimit(), userId: req.user.id }))));

/**
 * URL para ACRESCENTAR uma conta, não para trocar a existente.
 *
 * `prompt=consent select_account` é o que obriga o Google a mostrar o seletor
 * de contas — sem isso ele reautoriza silenciosamente a conta já logada no
 * navegador, e a segunda conta nunca entra.
 */
app.get('/api/core/gmail/senders/add-url', requireUser, wrap((req, res) =>
  res.json({ url: gmail.getAuthUrl({ addSender: true, req: googleCreds.assertDomainConsistent(req) && req }) })));

app.put('/api/core/gmail/senders/:id', requireUser, wrap((req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  let sender;
  if (body.active !== undefined) sender = gmailSenders.setActive(id, Boolean(body.active), req.user.id);
  if (body.dailyLimit !== undefined) sender = gmailSenders.setDailyLimit(id, body.dailyLimit, req.user.id);
  if (!sender) throw new UserError('Informe "active" ou "dailyLimit".');
  res.json({ sender });
}));

app.delete('/api/core/gmail/senders/:id', requireUser, wrap((req, res) =>
  res.json(gmailSenders.remove(Number(req.params.id), req.user.id))));

app.get('/api/core/ats/rule-sets', wrap((req, res) => res.json({ ruleSets: atsService.listRuleSets() })));

app.get('/api/core/audit-logs', wrap((req, res) => res.json({
  logs: db.prepare('SELECT * FROM core_audit_logs ORDER BY id DESC LIMIT ?').all(Number(req.query.limit || 100))
})));

// ---------------------------------------------------------------------------
// GUPY e INDEED — mesmas rotas, produtos e dados separados
// ---------------------------------------------------------------------------

function mountBoard(prefix, service) {
  const r = express.Router({ mergeParams: true });

  r.get('/dashboard', wrap((req, res) => res.json(service.dashboard(req.country, req.user.id))));
  r.get('/config', wrap((req, res) => res.json({ config: service.getCountryConfig(req.country) })));
  r.put('/config', wrap((req, res) => res.json({ config: service.updateCountryConfig(req.country, req.body || {}) })));

  r.get('/jobs', wrap((req, res) => res.json({
    jobs: service.listJobs(req.country, {
      view: req.query.view || 'all',
      minFit: req.query.minFit,
      limit: Math.min(500, Number(req.query.limit || 100)),
      offset: Number(req.query.offset || 0)
    })
  })));

  r.get('/jobs/:id', wrap((req, res) => {
    const job = service.getJob(req.country, Number(req.params.id));
    if (!job) throw new UserError('Vaga não encontrada neste país.', 404);
    res.json({ job });
  }));

  r.post('/jobs/:id/save', wrap((req, res) =>
    res.json(service.saveJob(req.country, Number(req.params.id), String(req.body.notes || '')))));

  r.post('/jobs/:id/discard', wrap((req, res) =>
    res.json(service.discardJob(req.country, Number(req.params.id), String(req.body.reason || '')))));

  r.post('/search', wrap(async (req, res) =>
    res.json({ metrics: await service.search(req.country, req.body || {}, req.user.id) })));

  r.get('/searches', wrap((req, res) => res.json({ searches: service.searchHistory(req.country) })));
  r.get('/logs', wrap((req, res) => res.json({ logs: service.logs(req.country, Number(req.query.limit || 100)) })));

  r.get('/integration', wrap((req, res) => res.json({ integration: service.getIntegration(req.country) })));
  r.put('/integration', wrap((req, res) =>
    res.json({ integration: service.configureIntegration(req.country, req.body || {}) })));
  r.post('/integration/test', wrap(async (req, res) => res.json(await service.testConnection(req.country))));
  r.post('/integration/disconnect', wrap((req, res) => res.json({ integration: service.disconnect(req.country) })));

  app.use(`/api/${prefix}/:country`, requireUser, countryParam, r);
}

mountBoard('gupy', gupyService);
mountBoard('indeed', indeedService);

// ---------------------------------------------------------------------------
// SEASONAL JOBS — somente US
// ---------------------------------------------------------------------------

app.get('/api/seasonal/dashboard', requireUser, wrap((req, res) => res.json(seasonal.dashboard(req.user.id))));
app.get('/api/seasonal/config', requireUser, wrap((req, res) => res.json({ config: seasonal.getConfig() })));
app.put('/api/seasonal/config', wrap((req, res) => {
  const before = Number(seasonal.getConfig().require_truck_driver_match) === 1;
  const config = seasonal.updateConfig(req.body || {});
  const after = Number(config.require_truck_driver_match) === 1;

  // Mudou o foco das candidaturas: as vagas já classificadas precisam passar
  // de novo pela cadeia. Ampliou → as FILTERED pelo portão de caminhão voltam
  // a concorrer. Restringiu → as MATCHED que não são caminhão saem.
  let reprocessed = null;
  if (before !== after) {
    const userId = req.user ? req.user.id : 1;
    const r1 = orchestrator.runSeasonalBatch({ userId, state: after ? 'MATCHED' : 'FILTERED', limit: 2000 });
    const r2 = orchestrator.runSeasonalBatch({ userId, state: 'MANUAL_ACTION_REQUIRED', limit: 2000 });
    reprocessed = { processed: r1.processed + r2.processed, decisions: r1.decisions, errors: r1.errors.concat(r2.errors) };
    try {
      seasonalUi.notify('system', after ? 'Foco: só motorista de caminhão' : 'Foco: todas as vagas H-2A/H-2B',
        `${reprocessed.processed} vaga(s) reclassificada(s).`, 'jobs');
    } catch (e) { /* silencioso */ }
  }
  res.json({ config, reprocessed });
}));

app.get('/api/seasonal/jobs', requireUser, wrap((req, res) => res.json({
  jobs: seasonal.listJobs({
    view: req.query.view || 'all',
    visaType: req.query.visaType || null,
    applicationMethod: req.query.applicationMethod || null,
    state: req.query.state || null,
    only2027: req.query.only2027 === 'true' || req.query.only2027 === '1',
    minFit: req.query.minFit,
    // filtros mestres do front H2B (F2.1 / F2.3)
    q: req.query.q || null,
    states: req.query.states || null,
    city: req.query.city || null,
    titles: req.query.titles || null,
    minWage: req.query.minWage,
    minOpenings: req.query.minOpenings,
    startMonths: req.query.startMonths || null,
    emailOnly: req.query.emailOnly === 'true' || req.query.emailOnly === '1',
    excludeApplied: req.query.excludeApplied === 'true' || req.query.excludeApplied === '1',
    housing: req.query.housing || null,
    dolActive: req.query.dolActive !== undefined ? req.query.dolActive : null,
    years: req.query.years || null,
    origin: req.query.origin || null,
    sort: req.query.sort || null,
    season: req.query.season || null,
    stillPublished: req.query.stillPublished === 'true' || req.query.stillPublished === '1',
    limit: Math.min(1000, Number(req.query.limit || 100)),
    offset: Number(req.query.offset || 0)
  })
})));

// Facetas (lugares, títulos, meses) e sugestões da busca — front H2B.
app.get('/api/seasonal/facets', requireUser, wrap((req, res) => res.json(seasonal.facets())));
app.get('/api/seasonal/suggest', requireUser, wrap((req, res) =>
  res.json({ suggestions: seasonal.suggest(req.query.q || '', Math.min(20, Number(req.query.limit || 8))) })));

// Modelos de assunto/corpo em rotação (F1.1).
app.get('/api/seasonal/templates', requireUser, wrap((req, res) => res.json(seasonalTemplates.grouped())));
app.put('/api/seasonal/templates', requireUser, wrap((req, res) => res.json(seasonalTemplates.save(req.body || {}))));
app.post('/api/seasonal/templates/preview', requireUser, wrap((req, res) => {
  const job = req.body.jobId ? seasonal.getJob(Number(req.body.jobId)) : (req.body.job || {});
  const profile = seasonal.candidateProfile(req.user.id);
  res.json({ text: seasonalTemplates.preview({ kind: req.body.kind, content: req.body.content || '', job: job || {}, profile }) });
}));

// Preferências, notificações e números do front H2B.
app.get('/api/seasonal/ui/prefs', requireUser, wrap((req, res) => res.json({ prefs: seasonalUi.getPrefs() })));
app.put('/api/seasonal/ui/prefs', requireUser, wrap((req, res) => res.json({ prefs: seasonalUi.setPrefs(req.body || {}) })));
app.get('/api/seasonal/notifications', requireUser, wrap((req, res) => res.json(seasonalUi.listNotifications(Number(req.query.limit || 60)))));
app.post('/api/seasonal/notifications/read', requireUser, wrap((req, res) => res.json(seasonalUi.markRead(req.body.id || null))));
app.delete('/api/seasonal/notifications', requireUser, wrap((req, res) => res.json(seasonalUi.clearNotifications())));
app.get('/api/seasonal/stats', requireUser, wrap((req, res) => res.json(seasonalUi.stats())));

app.get('/api/seasonal/jobs/:id', wrap((req, res) => {
  const job = seasonal.getJob(Number(req.params.id));
  if (!job) throw new UserError('Ordem de serviço não encontrada.', 404);
  res.json({ job, package: emailService.getPackage(Number(req.params.id)) });
}));

app.post('/api/seasonal/jobs/:id/save', wrap((req, res) =>
  res.json(seasonal.saveJob(Number(req.params.id), String(req.body.notes || '')))));

app.post('/api/seasonal/jobs/:id/discard', wrap((req, res) =>
  res.json(seasonal.discardJob(Number(req.params.id), String(req.body.reason || '')))));

app.post('/api/seasonal/import', wrap(async (req, res) => {
  const metrics = await seasonal.importJobs(req.body || {}, req.user.id);
  // O estado no DOL entra logo depois, para a tela já mostrar ativas/inativas.
  let dolStatus = null;
  if (req.body && req.body.skipStatus) dolStatus = { skipped: true };
  else { try { dolStatus = await seasonal.syncDolStatus(); } catch (e) { dolStatus = { error: e.message }; } }
  res.json({ metrics: Object.assign({}, metrics, { dolStatus }) });
}));
// Base de divulgação do DOL (JSON de vagas certificadas de temporadas passadas):
// sobe o arquivo e importa em segundo plano; o front acompanha pelo status.
const disclosureUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(uploadsRoot, 'imports');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) { cb(null, `disclosure_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.json`); }
  }),
  limits: { fileSize: 300 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext !== '.json') return cb(new UserError(`Formato não aceito: ${ext || 'sem extensão'}. Envie o arquivo .json da base.`, 400));
    cb(null, true);
  }
});
app.post('/api/seasonal/import/disclosure', requireUser, disclosureUpload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new UserError('Envie o arquivo JSON da base do DOL.', 400);
  if (disclosureImport.status().running) { fs.unlink(req.file.path, () => {}); throw new UserError('Já existe uma importação da base em andamento.', 409); }
  const enrich = !(req.body && (req.body.enrich === '0' || req.body.enrich === 'false'));
  const file = req.file.path;
  const original = req.file.originalname;
  disclosureImport.run({ file, enrich, userId: req.user.id, sourceRef: original })
    .catch(e => { try { logCore('seasonal', 'disclosure_import_failed', `Importação da base falhou: ${e.message}`, { file: original }, null, 'error'); } catch (x) { /* */ } })
    .finally(() => fs.unlink(file, () => {}));
  res.json({ started: true, file: original, enrich });
}));
app.get('/api/seasonal/import/disclosure/status', requireUser, wrap((req, res) => res.json(disclosureImport.status())));

app.post('/api/seasonal/dol/sync-status', requireUser, wrap(async (req, res) =>
  res.json(await seasonal.syncDolStatus({ maxAgeHours: Number(req.body && req.body.maxAgeHours) || 0 }))));

app.get('/api/seasonal/searches', requireUser, wrap((req, res) => res.json({ searches: seasonal.searchHistory() })));
app.get('/api/seasonal/logs', requireUser, wrap((req, res) =>
  res.json({ logs: seasonal.logs(Number(req.query.limit || 100)) })));

app.get('/api/seasonal/queue/ranked', wrap((req, res) =>
  res.json({ ranked: seasonal.rankedCandidates(Number(req.query.limit || 50)) })));

app.post('/api/seasonal/jobs/:id/package', wrap((req, res) =>
  res.json(emailService.prepareApplicationPackage(Number(req.params.id), Object.assign({}, req.body || {}, { userId: req.user.id })))));

app.post('/api/seasonal/packages/:id/approve', wrap((req, res) =>
  res.json(emailService.approvePackage(Number(req.params.id)))));

app.get('/api/seasonal/queue', requireUser, wrap((req, res) => res.json({
  queue: emailService.getQueue({ status: req.query.status || null, limit: Number(req.query.limit || 200) }),
  quota: emailService.getQuotaStatus()
})));

app.post('/api/seasonal/queue/dispatch', wrap(async (req, res) =>
  res.json(await emailService.processQueue({
    max: Math.min(50, Number(req.body.max || 10)),
    // Envio manual: despacha exatamente o pacote que o usuário revisou.
    packageId: req.body.packageId ? Number(req.body.packageId) : null
  }))));

app.get('/api/seasonal/quota', requireUser, wrap((req, res) => res.json(emailService.getQuotaStatus())));

app.post('/api/seasonal/pause', wrap((req, res) =>
  res.json(emailService.setPause(req.body.paused === true || req.body.paused === 1))));

app.get('/api/seasonal/sent', requireUser, wrap((req, res) =>
  res.json({ applications: emailService.getSentApplications(Number(req.query.limit || 200)) })));

app.post('/api/seasonal/integration/test', wrap(async (req, res) => res.json(await seasonal.testConnection())));

// --- Gmail OAuth ---

app.get('/api/seasonal/gmail/status', wrap((req, res) => res.json(gmail.status())));

app.get('/api/seasonal/gmail/auth-url', wrap((req, res) => {
  googleCreds.assertDomainConsistent(req);
  res.json({ url: gmail.getAuthUrl({ req }) });
}));

/**
 * O Google volta para cá com `error=` quando NÃO concede a permissão. O caso
 * mais comum não é o usuário cancelar: é a conta não estar na lista de
 * usuários de teste do app (tela de permissão OAuth em modo "Teste"), ou um
 * administrador do Workspace bloquear o escopo. Dizer "você cancelou" nesses
 * casos manda o usuário procurar o problema no lugar errado.
 */
function describeConsentError(code) {
  const c = String(code || '').trim();
  const known = {
    access_denied:
      'O Google não concedeu a permissão de envio. Isso acontece quando você cancela, ou — mais comum — quando a ' +
      'conta escolhida não está na lista de "usuários de teste" da tela de permissão OAuth no Google Cloud ' +
      '(app em modo Teste), ou quando o administrador do Google Workspace bloqueia o escopo gmail.send. ' +
      'Adicione a conta como usuário de teste e tente de novo.',
    admin_policy_enforced:
      'O administrador do Google Workspace desta conta bloqueou o acesso de apps externos ao Gmail. ' +
      'Use uma conta pessoal (@gmail.com) ou peça liberação ao administrador.',
    org_internal:
      'Este app está restrito a contas da organização no Google Cloud (tipo de usuário "Interno"). ' +
      'Mude para "Externo" na tela de permissão OAuth para aceitar contas @gmail.com.',
    interaction_required:
      'O Google precisava de uma confirmação sua e não conseguiu mostrá-la. Tente de novo.'
  };
  return known[c] || `O Google recusou a autorização (${c || 'motivo não informado'}). Nenhuma conta foi conectada.`;
}

app.get('/api/seasonal/gmail/callback', wrap(async (req, res) => {
  if (req.query.error) {
    const code = String(req.query.error);
    logCore('gmail', 'oauth_consent_denied',
      `O Google voltou com erro na tela de permissão: ${code}.`, { googleError: code }, null, 'warn');
    return res.status(400).send(htmlMessage('Gmail não conectado', describeConsentError(code), { ok: false }));
  }
  if (!req.query.code) {
    return res.status(400).send(htmlMessage('Gmail não conectado',
      'O Google voltou sem o código de autorização. Feche esta janela e clique em Conectar de novo.', { ok: false }));
  }

  // Falhar aqui virava um JSON genérico dentro da janela do Google, sem o
  // motivo. A página de erro precisa dizer o que aconteceu E avisar a janela
  // mãe de que NÃO deu certo — senão a tela principal comemora uma conexão
  // que não existe.
  let out;
  try {
    out = await gmail.handleCallback(String(req.query.code), { userId: req.user ? req.user.id : 1, req });
  } catch (err) {
    const status = err.status || (err.userFacing ? 400 : 500);
    const message = err.userFacing
      ? err.message
      : 'Algo deu errado ao concluir a autorização. Veja os Logs para o detalhe técnico.';
    if (!err.userFacing) {
      logCore('gmail', 'oauth_callback_failed', err.message, { path: req.path }, null, 'error');
      console.error('[gmail callback]', err);
    }
    return res.status(status).send(htmlMessage('Gmail não conectado', message, { ok: false }));
  }

  // Registra a conexão de PROVEDOR — separada do login da aplicação (§21).
  if (req.user) {
    try {
      providers.markConnected(req.user.id, 'GMAIL', {
        accountEmail: out.email, scopes: gmail.SCOPES
      });
    } catch (e) { /* o envio funciona mesmo se o registro falhar */ }
  }

  res.send(htmlMessage('Gmail conectado',
    `As candidaturas serão enviadas de ${out.email || 'a conta autorizada'}. Isso é independente da conta com que você entra no Job Intelligence. Você já pode fechar esta aba.`));
}));

app.post('/api/seasonal/gmail/test', wrap(async (req, res) => res.json(await gmail.testConnection())));
app.post('/api/seasonal/gmail/disconnect', wrap((req, res) => res.json(gmail.disconnect())));

// ---------------------------------------------------------------------------
// AGENTES E ROBÔS AUTÔNOMOS (spec de agentes)
// ---------------------------------------------------------------------------

// --- Perfil de motorista do Seasonal (§27) ---

app.get('/api/seasonal/driver-profile', requireUser, wrap((req, res) =>
  res.json(driverProfile.readiness(req.user.id))));

app.put('/api/seasonal/driver-profile', requireUser, wrap((req, res) =>
  res.json({ profile: driverProfile.update(req.body || {}, req.user.id) })));

// --- Cadeia de agentes (§2, §32) ---

app.post('/api/seasonal/agents/run', requireUser, wrap((req, res) =>
  res.json(orchestrator.runSeasonalBatch({
    userId: req.user.id,
    limit: Math.min(500, Number(req.body && req.body.limit) || 200)
  }))));

app.post('/api/seasonal/jobs/:id/agents/run', requireUser, wrap((req, res) =>
  res.json(orchestrator.runSeasonalChain(Number(req.params.id), { userId: req.user.id }))));

// --- Trilha de auditoria (§72) ---

app.get('/api/seasonal/jobs/:id/audit', requireUser, wrap((req, res) =>
  res.json({ trail: orchestrator.auditTrail(Number(req.params.id)) })));

app.get('/api/core/agent-runs', requireUser, wrap((req, res) => res.json({
  runs: orchestrator.recentRuns({
    product: req.query.product || null,
    limit: Math.min(500, Number(req.query.limit) || 100)
  })
})));

app.get('/api/core/agents/self-check', wrap((req, res) => {
  const r = orchestrator.selfCheck();
  res.status(r.ok ? 200 : 500).json(r);
}));

// --- Ações manuais: telefone e WhatsApp (§41, §42, §57) ---

app.get('/api/seasonal/manual-actions', requireUser, wrap((req, res) =>
  res.json({ actions: orchestrator.pendingManualActions(Number(req.query.limit || 100)) })));

app.post('/api/seasonal/manual-actions/:id/resolve', requireUser, wrap((req, res) =>
  res.json(orchestrator.resolveManualAction(Number(req.params.id), req.body && req.body.status))));

// --- Agendador (§49, §63) ---

app.get('/api/core/scheduler', requireUser, wrap((req, res) => res.json(scheduler.status())));

app.post('/api/core/scheduler/enable', requireUser, wrap((req, res) =>
  res.json(scheduler.setEnabled(req.body.enabled === true || req.body.enabled === 1))));

app.put('/api/core/scheduler/tasks/:id', requireUser, wrap((req, res) =>
  res.json({ task: scheduler.setTaskConfig(req.params.id, {
    enabled: req.body.enabled === undefined ? undefined : Boolean(req.body.enabled),
    intervalMinutes: req.body.intervalMinutes
  }) })));

app.post('/api/core/scheduler/tasks/:id/run', requireUser, wrap(async (req, res) =>
  res.json(await scheduler.runTask(req.params.id, { userId: req.user.id, force: true }))));

app.get('/api/core/scheduler/history', requireUser, wrap((req, res) => res.json({
  runs: scheduler.history({ taskId: req.query.taskId || null, limit: Number(req.query.limit || 50) })
})));

// --- Relatório "enquanto você esteve fora" (§55) ---

app.get('/api/core/away-report', requireUser, wrap((req, res) =>
  res.json(awayReport.build({ hours: Number(req.query.hours) || 24, userId: req.user.id }))));

// --- Dados e backup: onde o histórico mora e como não perdê-lo ---

app.get('/api/core/storage', requireUser, wrap((req, res) => res.json(backup.status())));

app.post('/api/core/backup', requireUser, wrap((req, res) => {
  const r = backup.run({ reason: 'manual' });
  res.json({ backup: r, status: backup.status() });
}));

// Download de um backup pelo nome que o próprio serviço gerou — nada de caminho livre.
app.get('/api/core/backups/:file', requireUser, wrap((req, res) => {
  const file = backup.resolveFile(req.params.file);
  if (!file) return res.status(404).json({ error: 'Backup não encontrado.' });
  res.download(file, req.params.file);
}));

app.get('/api/core/export/history', requireUser, wrap((req, res) => {
  const data = backup.exportHistory();
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="h2dream-historico-${stamp}.json"`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(data, null, 2));
}));

// --- Provedor de IA (§5, §59) ---

app.get('/api/core/ai', requireUser, wrap((req, res) => res.json(ai.status())));

app.put('/api/core/ai', requireUser, wrap((req, res) => res.json(ai.updateConfig(req.body || {}))));

app.post('/api/core/ai/test', requireUser, wrap(async (req, res) => res.json(await ai.testConnection())));

// --- Prontidão operacional: o que falta para rodar sozinho ---

app.get('/api/core/readiness', wrap((req, res) => {
  const r = readiness.check();
  res.status(r.ready ? 200 : 200).json(r);
}));

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function htmlMessage(title, body, { ok = true } = {}) {
  // Se a página foi aberta pelo front (janela filha), avisa a janela mãe do
  // resultado. Sucesso fecha sozinho; falha fica aberta, porque o texto é a
  // única pista do que corrigir — e a janela mãe recebe a mesma mensagem.
  const payload = JSON.stringify({ type: ok ? 'gmail-oauth-done' : 'gmail-oauth-failed', message: String(body) })
    .replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
    <div style="font:16px system-ui;padding:48px;max-width:520px;margin:0 auto">
      <h1 style="font-size:20px;color:${ok ? '#166534' : '#991b1b'}">${escapeHtml(title)}</h1>
      <p style="color:#444;line-height:1.5">${escapeHtml(body)}</p>
      ${ok ? '' : '<p style="color:#666;font-size:14px">Você pode fechar esta janela.</p>'}</div>
    <script>try{if(window.opener){window.opener.postMessage(${payload},'*');${ok ? 'setTimeout(function(){window.close()},2500)' : ''}}}catch(e){}</script>`;
}

// ---------------------------------------------------------------------------
// Front-end
// ---------------------------------------------------------------------------

// Front H2B (cópia do sistema de referência) vive em /h2b/ ao lado do front
// atual, até a troca definitiva. Sem cache do index para que atualizações
// cheguem sem "limpar o cache" no celular.
// Páginas públicas — Política de Privacidade e Termos de Serviço. Sem login:
// o Google exige que sejam acessíveis a qualquer pessoa para aprovar o app
// OAuth. Operador, e-mail de contato e URL vêm do ambiente; o HTML é estático.
const LEGAL_PAGES = {
  '/privacidade': 'privacidade.html', '/privacy': 'privacidade.html', '/politica-de-privacidade': 'privacidade.html',
  '/termos': 'termos.html', '/terms': 'termos.html', '/termos-de-servico': 'termos.html'
};
function legalVars() {
  const escapeHtml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return {
    OPERATOR: escapeHtml(process.env.PUBLIC_OPERATOR_NAME || 'Inovassie Acessoria'),
    EMAIL: escapeHtml(process.env.PUBLIC_CONTACT_EMAIL || 'ghguilhermehintz@gmail.com'),
    BASE_URL: escapeHtml(process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`)
  };
}
app.get(Object.keys(LEGAL_PAGES), (req, res) => {
  const file = LEGAL_PAGES[req.path.replace(/\/+$/, '')] || LEGAL_PAGES[req.path];
  const vars = legalVars();
  const html = fs.readFileSync(path.join(__dirname, 'public', 'legal', file), 'utf8')
    .replace(/\{\{(OPERATOR|EMAIL|BASE_URL)\}\}/g, (m, k) => vars[k]);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.type('html').send(html);
});

app.get(['/h2b', '/h2b/'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'h2b', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Tratamento central de erros (spec §42) — mensagem humana, técnico só no log
// ---------------------------------------------------------------------------

app.use((err, req, res, next) => {
  const correlationId = crypto.randomBytes(6).toString('hex');

  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? 'O arquivo passa de 15 MB. Envie uma versão menor.'
      : 'Não foi possível processar o arquivo enviado.';
    return res.status(400).json({ error: msg, correlationId });
  }

  const status = err.status || (err.userFacing ? 400 : 500);
  const userMessage = err.userFacing
    ? err.message
    : 'Algo deu errado ao processar sua solicitação. Seus dados salvos não foram afetados. Tente novamente — se persistir, consulte os Logs.';

  logCore('api', 'request_error', err.message, {
    path: req.path, method: req.method, status
  }, null, status >= 500 ? 'error' : 'warn', correlationId);

  if (status >= 500) console.error(`[${correlationId}]`, err);

  res.status(status).json({
    error: userMessage,
    correlationId,
    ...(err.health ? { health: err.health } : {})
  });
});

// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  logCore('system', 'server_started', `API iniciada na porta ${PORT}.`, { schemaVersion: migration.to });

  // A integridade da arquitetura de agentes é verificada no boot: se a matriz
  // de permissões ou o Policy Gate forem violados por uma edição futura, isso
  // aparece aqui em vez de passar despercebido (spec de agentes §52, §53).
  const check = orchestrator.selfCheck();

  // O agendador é o que faz os robôs trabalharem com o computador do usuário
  // desligado (§63). Ele sobe sempre; se estiver desabilitado, fica em espera.
  const sched = scheduler.start({ userId: 1 });

  console.log(`\n  AI Job Intelligence Platform`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  schema v${migration.to}${migration.dropped && migration.dropped.length ? ` (migração aplicada: ${migration.dropped.length} tabela(s) legada(s) removida(s))` : ''}`);
  console.log(`  agentes: ${check.ok ? 'integridade verificada' : 'FALHA DE INTEGRIDADE — veja /api/core/agents/self-check'}`);
  console.log(`  robôs:   ${sched.enabled ? `ligados (tique de ${sched.tickSeconds}s)` : 'em espera — habilite a automação para rodarem sozinhos'}`);
  console.log(`  IA:      ${ai.status().llmAvailable ? `${ai.status().provider} / ${ai.status().model}` : 'modo determinístico (nenhum LLM configurado)'}`);

  // Domínio público e URIs do Google — impressos no boot porque é aqui que um
  // .env herdado de outro domínio aparece antes de virar redirect_uri_mismatch.
  const creds = googleCreds.status();
  const hosts = [...new Set([creds.baseUrl, creds.gmailRedirectUri, creds.signinRedirectUri]
    .map(u => { try { return new URL(u).host; } catch (e) { return ''; } }).filter(Boolean))];
  console.log(`  domínio: ${creds.baseUrl} (${creds.baseUrlSource === 'env' ? 'APP_BASE_URL' : 'sem APP_BASE_URL — derivado de cada acesso'})`);
  console.log(`  Google:  ${creds.gmailRedirectUri}`);
  // Onde os dados moram — é o que decide se um redeploy leva o histórico junto.
  const st = backup.status();
  console.log(`  dados:   ${st.db.path} (${(st.db.size / 1024 / 1024).toFixed(1)} MB) · backups em ${st.dir}${st.last ? ` · último há ${st.lastAgeHours} h` : ' · nenhum ainda'}`);
  for (const w of st.warnings.filter(x => x.code !== 'NO_BACKUP' && x.code !== 'STALE')) {
    console.log(`  ATENÇÃO: ${w.title}. ${w.detail}`);
  }
  if (hosts.length > 1) {
    console.log(`  ATENÇÃO: as URIs do Google apontam para hosts diferentes (${hosts.join(', ')}). ` +
                'Alinhe APP_BASE_URL, GOOGLE_REDIRECT_URI e GOOGLE_SIGNIN_REDIRECT_URI — ou rode "node scripts/changeDomain.js <dominio>".');
    logCore('auth', 'domain_config_inconsistent',
      `URIs do Google em hosts diferentes: ${hosts.join(', ')}.`, { hosts }, null, 'warn');
  }
  console.log('');
});

/** Encerramento limpo: para o agendador antes de fechar o processo. */
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    scheduler.stop();
    logCore('system', 'server_stopping', `Encerrando por ${sig}. Agendador parado.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

module.exports = { app, server };
