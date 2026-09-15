/**
 * Automação de e-mail do Seasonal Jobs (spec §31, §32, §35, §36, §37, §38, §61, §62, §63).
 *
 * Garantias inegociáveis:
 *   - no máximo 50 e-mails de candidatura ENVIADOS COM SUCESSO por dia-calendário,
 *     no fuso configurado, com reserva atômica à prova de concorrência (§32, §61);
 *   - nunca uma segunda candidatura para o mesmo (candidato, vaga, destinatário) (§62);
 *   - com o envio pausado, nenhum e-mail sai — descoberta e preparo continuam (§63);
 *   - nenhum envio sem currículo anexado e sem passar por TODA a validação;
 *   - carta de recomendação nunca é gerada por IA, só anexada se o usuário enviou (§36).
 */

const fs = require('fs');
const path = require('path');
const { db, logSeasonal } = require('../config/database');
const candidate = require('./candidateService');
const senders = require('./gmailSenderService');
const templates = require('./seasonalTemplateService');
// Notificações do sino do front H2B — nunca podem derrubar um envio.
function notifyUi(kind, title, body, link) {
  try { require('./seasonalUiService').notify(kind, title, body, link); } catch (e) { /* silencioso */ }
}
const truthGuard = require('../core/agents/truthGuard');
const policyGate = require('../core/agents/policyGate');
const truckGate = require('../core/agents/truckDriverGate');
const cdlIntel = require('../core/agents/cdlIntelligence');
const driverProfileService = require('./driverProfileService');

/**
 * Teto de e-mails de candidatura enviados com sucesso por dia-calendário.
 *
 * Era 50. Passou a 300 por decisão explícita do operador em 2026-09-11, junto
 * com a entrada do rodízio de contas (F1.3) — não é deriva.
 *
 * O que mudou e o que NÃO mudou:
 *
 *   mudou      o número. 300/dia distribuídos entre as contas ativas; com três
 *              contas são 100 cada, contra os 500/dia que o Gmail corta.
 *
 *   não mudou  a garantia. A reserva continua atômica — checagem e incremento
 *              na mesma instrução SQL — e o envio de número 301 não sai, pelo
 *              mesmo motivo que o 51 não saía. É essa propriedade que protege,
 *              não o valor em si.
 *
 * Nenhuma configuração pode elevar o teto acima deste valor.
 */
const ABSOLUTE_DAILY_CAP = 300;

/**
 * Teto do dia = 300 por conta Gmail ativa (decisão do operador, 2026-09-14).
 * Sem conta cadastrada vale o teto de uma conta — a antiga conta única.
 * O limite de 500/24h do Google continua sendo o freio de cada conta.
 */
function absoluteDailyCap() {
  let active = 0;
  try { active = require('./gmailSenderService').activeSenders().length; } catch (e) { active = 0; }
  return ABSOLUTE_DAILY_CAP * Math.max(1, active);
}

const QUEUE_STATUS = {
  QUEUED: 'QUEUED', SENDING: 'SENDING', SENT: 'SENT',
  FAILED: 'FAILED', DEFERRED: 'DEFERRED', SKIPPED: 'SKIPPED',
  MANUAL_ACTION_REQUIRED: 'MANUAL_ACTION_REQUIRED', AWAITING_REVIEW: 'AWAITING_REVIEW'
};

/** Backoff por tentativa (spec §40 do build prompt). */
const RETRY_BACKOFF_MINUTES = [5, 30, 120];

// ---------------------------------------------------------------------------
// Fuso e chave do dia
// ---------------------------------------------------------------------------

function getSetting(key, fallback) {
  const r = db.prepare('SELECT value FROM core_system_settings WHERE key = ?').get(key);
  return r && r.value !== null && r.value !== '' ? r.value : fallback;
}

function getTimezone() {
  return getSetting('application_timezone', 'America/Sao_Paulo');
}

/**
 * Data-calendário NO FUSO CONFIGURADO (spec §32 — "calendar day according to the
 * configured application timezone"). A versão anterior usava UTC.
 */
function todayKey(tz = getTimezone()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

function nextResetAt(tz = getTimezone()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date());
    const h = Number(parts.find(p => p.type === 'hour').value);
    const m = Number(parts.find(p => p.type === 'minute').value);
    const minutesLeft = (24 * 60) - (h * 60 + m);
    return { hoursLeft: Math.floor(minutesLeft / 60), minutesLeft: minutesLeft % 60, timezone: tz };
  } catch (e) {
    return { hoursLeft: null, minutesLeft: null, timezone: tz };
  }
}

function configuredLimit() {
  const cap = absoluteDailyCap();
  const cfg = db.prepare('SELECT daily_email_limit FROM seasonal_config ORDER BY id LIMIT 1').get();
  const fromConfig = cfg ? parseInt(cfg.daily_email_limit, 10) : 0;
  const fromSettings = parseInt(getSetting('max_seasonal_emails_per_day', '0'), 10);
  // 0 (ou vazio) em qualquer um dos dois = automático: acompanha o teto
  // (300 × contas ativas). Um valor positivo só pode REDUZIR.
  const chosen = [fromConfig, fromSettings].filter(n => Number.isFinite(n) && n > 0);
  if (!chosen.length) return cap;
  // Nenhuma configuração eleva o limite acima do teto.
  return Math.max(0, Math.min(cap, ...chosen));
}

function ensureQuotaRow(dateStr = todayKey()) {
  const tz = getTimezone();
  const limit = configuredLimit();
  db.prepare(`INSERT INTO seasonal_daily_quota (date_str, count_sent, max_limit, timezone)
              VALUES (?,0,?,?) ON CONFLICT(date_str) DO UPDATE SET max_limit = ?, timezone = ?`)
    .run(dateStr, limit, tz, limit, tz);
  return db.prepare('SELECT * FROM seasonal_daily_quota WHERE date_str = ?').get(dateStr);
}

function getQuotaStatus() {
  const dateStr = todayKey();
  const row = ensureQuotaRow(dateStr);
  return {
    date: dateStr,
    timezone: getTimezone(),
    countSent: row.count_sent,
    maxLimit: row.max_limit,
    remaining: Math.max(0, row.max_limit - row.count_sent),
    reset: nextResetAt(),
    absoluteCap: absoluteDailyCap(),
    perAccountCap: ABSOLUTE_DAILY_CAP,
    automatic: configuredLimit() === absoluteDailyCap()
  };
}

/**
 * Reserva UMA unidade da cota, de forma atômica.
 *
 * A checagem e o incremento acontecem na MESMA instrução SQL. Sob concorrência,
 * apenas uma execução consegue `changes === 1` quando resta uma vaga — é isso
 * que impede o e-mail 51 (spec §32, §78).
 */
function reserveQuotaSlot(dateStr = todayKey()) {
  ensureQuotaRow(dateStr);
  const r = db.prepare(`UPDATE seasonal_daily_quota
                        SET count_sent = count_sent + 1, updated_at = CURRENT_TIMESTAMP
                        WHERE date_str = ? AND count_sent < max_limit`).run(dateStr);
  return r.changes === 1;
}

/**
 * Devolve a reserva quando o e-mail NÃO saiu. A cota conta envios bem-sucedidos,
 * então uma tentativa frustrada não pode consumir a vaga do dia.
 */
function releaseQuotaSlot(dateStr = todayKey()) {
  db.prepare(`UPDATE seasonal_daily_quota
              SET count_sent = MAX(0, count_sent - 1), updated_at = CURRENT_TIMESTAMP
              WHERE date_str = ?`).run(dateStr);
}

// ---------------------------------------------------------------------------
// Pacote de candidatura
// ---------------------------------------------------------------------------

function getConfig() {
  return db.prepare('SELECT * FROM seasonal_config ORDER BY id LIMIT 1').get();
}

function recordEvent(queueId, jobId, event, detail, metadata = null) {
  db.prepare(`INSERT INTO seasonal_email_events (queue_id, job_id, event, detail, metadata_json)
              VALUES (?,?,?,?,?)`)
    .run(queueId, jobId, event, detail, metadata ? JSON.stringify(metadata) : null);
}

/**
 * Gera a carta de apresentação (spec §37).
 * Usa APENAS fatos do Perfil Mestre. Nada é afirmado sem lastro: cada bloco só
 * é incluído se o dado correspondente existir.
 */
/**
 * A vaga é de direção? Decide se a carta fala de caminhão/CDL. Numa vaga de
 * hotelaria ou colheita, anos de caminhão são verdade — mas não são o assunto.
 * Foco amplo (2026-09-11): a carta fala do que a vaga pede.
 */
function isDrivingJob(job = {}) {
  if (['TRUCK_DRIVER_CONFIRMED', 'TRUCK_DRIVER_PROBABLE', 'REVIEW_REQUIRED'].includes(String(job.truck_classification || ''))) return true;
  const text = [job.job_title, job.special_requirements].filter(Boolean).join(' ');
  return /\b(driver|driving|truck|cdl|chauffeur|hauler|hauling)\b/i.test(text);
}

/** Vaga da base de divulgação do DOL: empregador de temporada passada. */
function isRecurringEmployer(job) {
  return Boolean(job && job.origin === 'disclosure');
}

function buildCoverLetter({ job, profile, resume, driverProfile = {} }) {
  const lines = [];
  const name = profile.fullName || 'Candidate';
  const known = (v) => v !== undefined && v !== null && v !== '' && String(v).toUpperCase() !== 'UNKNOWN';
  const driving = isDrivingJob(job);

  lines.push(`Dear Hiring Team at ${job.employer_name},`);
  lines.push('');
  if (isRecurringEmployer(job)) {
    // Base de divulgação: a vaga encerrou na temporada passada. O e-mail é
    // interesse na PRÓXIMA temporada, e diz isso — nunca finge que a ordem
    // antiga ainda está aberta.
    const season = String(job.start_date || '').slice(0, 4);
    const where = [job.employer_city, job.employer_state].filter(Boolean).join(', ');
    lines.push(`I understand that ${job.employer_name} hired ${job.job_title} workers through the ${job.visa_type || 'H-2B'} program${season ? ` for the ${season} season` : ''}${where ? ` in ${where}` : ''} (DOL case #${job.job_order_id}).`);
    lines.push('I would like to apply for a position on your team for the upcoming season.');
  } else {
    lines.push(`I am applying for the ${job.job_title} position under DOL job order #${job.job_order_id}.`);
  }

  // Experiência — só se houver anos declarados no perfil.
  // A experiência específica de caminhão (§27) tem precedência sobre a genérica:
  // é ela que interessa ao empregador, e é a que o Truth Guard sabe verificar.
  if (driving && known(driverProfile.truck_driving_experience) && Number(driverProfile.truck_driving_experience) > 0) {
    lines.push('');
    lines.push(`I have ${driverProfile.truck_driving_experience} years of truck driving experience.`);
    if (known(driverProfile.tractor_trailer_experience) && Number(driverProfile.tractor_trailer_experience) > 0) {
      lines.push(`Of those, ${driverProfile.tractor_trailer_experience} years were with tractor-trailers.`);
    }
  } else if (Number.isFinite(Number(profile.yearsOfExperience)) && Number(profile.yearsOfExperience) > 0) {
    lines.push('');
    lines.push(`I have ${profile.yearsOfExperience} years of professional experience.`);
  }

  // CDL — jamais afirmada sem registro explícito de posse no perfil (§17, §18).
  // Um perfil que diz UNKNOWN não produz nenhuma frase sobre CDL.
  if (driving && String(driverProfile.cdl_status || '').toUpperCase() === 'HELD') {
    const cls = known(driverProfile.cdl_class) ? ` Class ${String(driverProfile.cdl_class).toUpperCase()}` : '';
    const endorsements = known(driverProfile.cdl_endorsements)
      ? ` with ${driverProfile.cdl_endorsements} endorsement(s)` : '';
    lines.push(`I hold a valid CDL${cls}${endorsements}.`);
  }

  if (driving && String(driverProfile.driving_record || '').toUpperCase() === 'CLEAN') {
    lines.push('I maintain a clean driving record.');
  }
  if (driving && String(driverProfile.manual_transmission_experience || '').toUpperCase() === 'YES') {
    lines.push('I am experienced with manual transmission vehicles.');
  }

  // Título e resumo do perfil geral — o que o candidato escreveu sobre si,
  // relevante para qualquer ocupação. O Truth Guard confere as afirmações.
  if (!driving && profile.headline) {
    lines.push('');
    lines.push(`Background: ${String(profile.headline).trim()}.`.replace(/\.\.$/, '.'));
  }
  if (profile.summary && String(profile.summary).trim()) {
    lines.push('');
    lines.push(String(profile.summary).trim());
  }
  // Capacidade física declarada — vagas de campo, fábrica e hotelaria pedem.
  if (known(driverProfile.lifting_capacity)) {
    lines.push(`I can lift and carry ${String(driverProfile.lifting_capacity).trim()}.`);
  }

  // Habilidades — apenas as que a vaga realmente cita E que o perfil possui.
  const ontology = require('../core/match/skillOntology');
  const jobConcepts = ontology.extractKnownTerms(
    [job.job_title, job.duties_description, job.special_requirements].filter(Boolean).join(' ')
  );
  const relevant = jobConcepts
    .map(c => ({ c, m: ontology.matchRequirement(c.label, profile.skills || []) }))
    .filter(x => x.m.type === 'EXACT' || (x.m.type === 'SEMANTIC' && x.m.confidence === 'HIGH'))
    .map(x => x.m.matchedWith);

  if (relevant.length) {
    lines.push('');
    lines.push(`Relevant to this role, my background includes: ${[...new Set(relevant)].slice(0, 6).join(', ')}.`);
  }

  // Disponibilidade — só se declarada.
  if (profile.availabilityFrom || profile.availabilityTo) {
    lines.push('');
    const from = profile.availabilityFrom ? `from ${profile.availabilityFrom}` : '';
    const to = profile.availabilityTo ? ` through ${profile.availabilityTo}` : '';
    lines.push(`I am available${from ? ' ' + from : ''}${to}.`);
  }
  if (job.start_date && job.end_date) {
    lines.push(`I understand the contract period runs from ${job.start_date} to ${job.end_date}.`);
  }

  // Habilitação — só se realmente registrada no perfil e se a vaga envolve dirigir.
  if (driving && profile.driversLicense) {
    lines.push('');
    lines.push(`Driver license: ${profile.driversLicense}.`);
  }

  lines.push('');
  lines.push(`My resume${resume ? ` (${resume.original_name})` : ''} is attached for your review. I am available for an interview at your convenience.`);
  lines.push('');
  lines.push('Sincerely,');
  lines.push(name);
  if (profile.email) lines.push(profile.email);
  if (profile.phone) lines.push(profile.phone);

  return lines.join('\n');
}

/**
 * Checklist de validação (spec §33 do build prompt). Toda checagem obrigatória
 * que falhar IMPEDE o envio — nada é marcado PASSED por padrão.
 */
function validatePackage({ job, profile, resume, attachments, recipient, body, subject,
                          driverProfile = null, coverLetter = null, config = null }) {
  const checks = [];
  const add = (id, label, ok, detail = null, blocking = true) =>
    checks.push({ id, label, ok: Boolean(ok), detail, blocking });

  add('job_exists', 'A vaga existe', Boolean(job));
  add('job_active', 'A vaga ainda está no período', !job.end_date || new Date(job.end_date) >= new Date(),
      job.end_date ? `Período até ${job.end_date}` : 'Sem data de término informada', false);
  add('application_email', 'Existe e-mail de candidatura', Boolean(recipient), recipient || 'nenhum');
  add('email_format', 'O e-mail tem formato válido',
      Boolean(recipient) && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(recipient), recipient || null);

  const already = job && db.prepare(
    'SELECT id FROM seasonal_applications WHERE candidate_id = 1 AND seasonal_job_id = ? AND recipient_email = ?'
  ).get(job.id, recipient || '');
  add('not_duplicate', 'Ainda não foi enviada candidatura para esta vaga', !already,
      already ? 'Já existe envio registrado.' : null);

  add('profile_complete', 'O Perfil Mestre tem o mínimo necessário',
      Boolean(profile && profile.fullName && profile.email),
      !profile || !profile.fullName ? 'Nome ausente' : (!profile.email ? 'E-mail ausente' : null));

  add('resume_exists', 'Há um currículo selecionado', Boolean(resume),
      resume ? resume.name : 'Nenhum currículo ativo para os EUA na Biblioteca.');

  const resumeOnDisk = Boolean(resume && resume.file_path && fs.existsSync(resume.file_path));
  add('resume_file', 'O arquivo do currículo existe em disco', resumeOnDisk,
      resume && !resumeOnDisk ? `Arquivo não encontrado: ${resume.file_path}` : null);

  add('attachments', 'Os anexos existem', Array.isArray(attachments) && attachments.length > 0,
      `${(attachments || []).length} anexo(s)`);

  const missingAttachment = (attachments || []).find(a => !fs.existsSync(a.path));
  add('attachments_readable', 'Todos os anexos são legíveis', !missingAttachment,
      missingAttachment ? `Ausente: ${missingAttachment.filename}` : null);

  add('email_body', 'O corpo do e-mail foi gerado', Boolean(body && body.trim().length > 80));
  add('email_subject', 'O assunto foi gerado', Boolean(subject && subject.trim()));

  // --- Portão de motorista de caminhão (spec de agentes §24, §25, §36) -----
  // Seasonal Jobs existe para vagas de motorista. Uma vaga que não é disso não
  // entra no fluxo automático, por melhor que sejam os scores.
  const requireTruck = Boolean(config) && Number(config.require_truck_driver_match) === 1;
  const truck = job.truck_classification
    ? { classification: job.truck_classification, confidence: job.truck_confidence,
        pass: ['TRUCK_DRIVER_CONFIRMED', 'TRUCK_DRIVER_PROBABLE'].includes(job.truck_classification) }
    : truckGate.classify(job);

  add('truck_driver_match', requireTruck ? 'A vaga é de motorista de caminhão' : 'Foco amplo: qualquer ocupação H-2A/H-2B',
      requireTruck ? truck.pass : true,
      `Classificação: ${truck.classification}${truck.confidence ? ` (confiança ${truck.confidence})` : ''}`,
      requireTruck);

  // --- Requisitos de CDL e de motorista (§28, §29) ------------------------
  const dp = driverProfile || driverProfileService.get(1);
  const eligibility = cdlIntel.evaluateEligibility(job, dp, {
    generalExperienceYears: profile && profile.yearsOfExperience !== null && profile.yearsOfExperience !== undefined && profile.yearsOfExperience !== ''
      ? Number(profile.yearsOfExperience) : undefined
  });

  add('cdl_requirements', 'Os requisitos de CDL são compatíveis',
      eligibility.blockingGaps.length === 0,
      eligibility.blockingGaps.length
        ? eligibility.blockingGaps.map(g => g.label).join('; ')
        : eligibility.cdl.label);

  add('no_unresolved_critical', 'Nenhum requisito crítico em UNKNOWN',
      eligibility.unresolved.length === 0,
      eligibility.unresolved.length
        ? eligibility.unresolved.map(u => u.label).join('; ') + ' — o que o perfil não sabe permanece UNKNOWN (§18).'
        : null,
      false);

  // --- TRUTH GUARD (§17) — a trava final antes de qualquer envio ----------
  // Nenhum texto sem lastro no perfil desta plataforma sai do sistema.
  const truth = truthGuard.validatePackage({
    texts: { cover_letter: coverLetter, email_body: body, email_subject: subject },
    profile,
    driverProfile: dp,
    resumeText: resume && resume.extracted_text ? resume.extracted_text : ''
  });

  add('truth_validation', 'O Truth Guard aprovou todo o texto gerado',
      truth.passed,
      truth.passed ? `${Object.keys(truth.results).length} texto(s) auditado(s).`
                   : truth.blockingReasons.slice(0, 4).join(' | '));

  const quota = getQuotaStatus();
  add('quota_available', 'Há cota disponível hoje', quota.remaining > 0,
      `${quota.countSent}/${quota.maxLimit} enviados hoje`, false);

  const blockingFailures = checks.filter(c => c.blocking && !c.ok);
  return {
    status: blockingFailures.length === 0 ? 'PASSED' : 'FAILED',
    checks,
    truth,
    eligibility,
    truckClassification: truck.classification,
    blockingFailures: blockingFailures.map(c => c.label + (c.detail ? ` — ${c.detail}` : ''))
  };
}

/**
 * Decide se o pacote precisa de revisão humana (spec §31).
 */
function reviewDecision({ job, match, validation, resumeRecommendation, config }) {
  const mode = config.email_review_mode;
  if (mode === 'ALWAYS_REVIEW') {
    return { requiresReview: true, reasons: ['Modo de revisão: revisar sempre.'] };
  }
  if (mode === 'FULLY_AUTOMATIC') {
    return { requiresReview: false, reasons: [] };
  }

  // REVIEW_FLAGGED
  const reasons = [];
  if (validation.status !== 'PASSED') reasons.push('A validação encontrou pendências.');
  if (validation.checks.some(c => !c.ok && !c.blocking)) reasons.push('Há avisos não bloqueantes na validação.');

  // Classificação de motorista incerta: a §26 manda revisar, não adivinhar.
  if (validation.truckClassification === 'TRUCK_DRIVER_PROBABLE') {
    reasons.push('A vaga é PROVAVELMENTE de motorista de caminhão, sem SOC 53-3032.00 para confirmar.');
  }
  if (validation.truckClassification === 'REVIEW_REQUIRED') {
    reasons.push('A classificação de motorista ficou ambígua e precisa de decisão humana (§26).');
  }

  // Requisito crítico em UNKNOWN nunca vira suposição (§18, §54).
  if (validation.eligibility && validation.eligibility.unresolved.length) {
    reasons.push(
      `${validation.eligibility.unresolved.length} requisito(s) crítico(s) em UNKNOWN: ` +
      validation.eligibility.unresolved.map(u => u.label).slice(0, 3).join('; ') + '.'
    );
  }

  const concerns = match && match.concerns_json ? safeParse(match.concerns_json, []) : [];
  if (concerns.some(c => c.severity === 'CRITICAL' || c.severity === 'HIGH')) {
    reasons.push('Há requisito crítico em aberto para esta vaga.');
  }
  if (resumeRecommendation && /padrão do país/i.test(resumeRecommendation.reason || '')) {
    reasons.push('A escolha do currículo foi por padrão, sem correspondência clara de trilha.');
  }
  if (!job.employer_email && job.attorney_email) {
    reasons.push('O destinatário é o representante legal, não o empregador direto.');
  }
  if (job.timeline_class === 'UNKNOWN_DATE' || !job.timeline_class) {
    reasons.push('O período de trabalho não pôde ser determinado.');
  }

  const fit = match ? match.fit_score : null;
  if (fit !== null && Math.abs(fit - config.auto_queue_fit_threshold) <= 3) {
    reasons.push(`O Fit Score (${fit}) está na fronteira do limiar configurado (${config.auto_queue_fit_threshold}).`);
  }

  return { requiresReview: reasons.length > 0, reasons };
}

/**
 * Monta o pacote de candidatura completo (spec §35).
 * NÃO envia e NÃO enfileira se a validação bloquear.
 */
function prepareApplicationPackage(jobId, options = {}) {
  const job = db.prepare('SELECT * FROM seasonal_jobs WHERE id = ?').get(Number(jobId));
  if (!job) { const e = new Error('Ordem de serviço não encontrada.'); e.userFacing = true; e.status = 404; throw e; }

  const config = getConfig();
  const seasonalService = require('./seasonalService');
  const profile = seasonalService.candidateProfile(options.userId || 1);
  const match = db.prepare('SELECT * FROM seasonal_matches WHERE job_id = ?').get(job.id);

  const recipient = options.recipientOverride
    || job.application_email
    || job.employer_email
    || job.attorney_email
    || null;

  if (!recipient) {
    const e = new Error('Esta vaga não informa e-mail de candidatura. Ela exige ação manual — use o telefone ou o site indicado.');
    e.userFacing = true;
    throw e;
  }

  // Seleção de currículo entre os EXISTENTES do ambiente Seasonal (§38, §1I).
  // A busca NUNCA atravessa para o Gupy ou o Indeed.
  const store = candidate.environment('seasonal', 'US', options.userId || 1);
  const careerTrack = job.career_track || detectCareerTrack(job);
  // O tipo de visto da vaga escolhe o documento (F1.2). H-2A é agricultura,
  // H-2B não é — e o currículo de um não substitui o do outro.
  const visaType = String(job.visa_type || '').toUpperCase() || null;

  const rec = options.resumeId
    ? { resume: store.getResume(options.resumeId), reason: 'Currículo escolhido manualmente.' }
    : store.recommendResume({ careerTrack, job, visaType });

  const resume = rec.resume;

  // Anexos: currículo + cartas de recomendação AUTÊNTICAS enviadas pelo usuário (§36).
  const attachments = [];
  if (resume && resume.file_path && fs.existsSync(resume.file_path)) {
    attachments.push({ filename: resume.original_name || resume.filename, path: resume.file_path, resumeId: resume.id });
  }

  // A carta NÃO atravessa tipo de visto. Uma carta escrita para fazenda saindo
  // numa vaga de hotelaria é pior que nenhuma carta — e o H2BApply documenta
  // esse caso como erro real que aconteceu em produção. Carta marcada ANY serve
  // aos dois; carta do outro tipo fica de fora, em silêncio deliberado.
  const letters = store.listResumes()
    .filter(d => d.is_active && (d.doc_type === 'recommendation_letter' || d.doc_type === 'cover_letter'))
    .filter(d => {
      if (!visaType) return true;
      const v = String(d.visa_type || 'ANY').toUpperCase();
      return v === visaType || v === 'ANY';
    });

  for (const l of letters) {
    const full = store.getResume(l.id);
    if (full && full.file_path && fs.existsSync(full.file_path)) {
      attachments.push({ filename: full.original_name || full.filename, path: full.file_path, documentId: full.id });
    }
  }

  const driverProfile = driverProfileService.get(options.userId || 1);

  // Assunto e corpo: modelos do usuário em rotação (F1.1) quando existem;
  // caso contrário, o texto gerado pelo sistema. O texto escolhido — de
  // qualquer origem — passa pelo Truth Guard logo abaixo.
  const coverLetter = buildCoverLetter({ job, profile, resume, driverProfile });
  const composed = templates.compose({ job, profile, consume: options.consumeTemplates !== false });
  const subject = composed.subject
    || (isRecurringEmployer(job)
      ? `Application for the upcoming ${job.visa_type || 'H-2B'} season — ${job.job_title} — ${profile.fullName || ''}`.trim()
      : `Application — ${job.job_title} — Job Order #${job.job_order_id} — ${profile.fullName || ''}`.trim());
  const body = composed.body || coverLetter;

  const validation = validatePackage({
    job, profile, resume, attachments, recipient, body, subject,
    driverProfile, coverLetter, config
  });
  const review = reviewDecision({ job, match, validation, resumeRecommendation: rec, config });

  db.prepare(`INSERT INTO seasonal_application_packages
    (job_id, selected_resume_id, selected_resume_reason, selected_doc_ids_json, recipient_email,
     recipient_kind, email_subject, email_body, cover_letter, attachments_json,
     validation_status, validation_json, requires_review, review_reasons_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(job_id) DO UPDATE SET
      selected_resume_id = excluded.selected_resume_id,
      selected_resume_reason = excluded.selected_resume_reason,
      selected_doc_ids_json = excluded.selected_doc_ids_json,
      recipient_email = excluded.recipient_email, recipient_kind = excluded.recipient_kind,
      email_subject = excluded.email_subject, email_body = excluded.email_body,
      cover_letter = excluded.cover_letter, attachments_json = excluded.attachments_json,
      validation_status = excluded.validation_status, validation_json = excluded.validation_json,
      requires_review = excluded.requires_review, review_reasons_json = excluded.review_reasons_json,
      approved_at = NULL`)
    .run(job.id, resume ? resume.id : null, rec.reason,
         JSON.stringify(letters.map(l => l.id)), recipient,
         job.employer_email === recipient ? 'EMPLOYER' : 'ATTORNEY',
         subject, body, coverLetter, JSON.stringify(attachments),
         validation.status, JSON.stringify(validation),
         review.requiresReview ? 1 : 0, JSON.stringify(review.reasons));

  const pkg = db.prepare('SELECT * FROM seasonal_application_packages WHERE job_id = ?').get(job.id);

  // Só entra na fila se passou na validação.
  if (validation.status !== 'PASSED') {
    // Só o que ainda não saiu: a linha SENT é registro do que foi enviado e fica.
    db.prepare('DELETE FROM seasonal_email_queue WHERE package_id = ? AND status <> ?').run(pkg.id, QUEUE_STATUS.SENT);
    recordEvent(null, job.id, 'PACKAGE_INVALID', validation.blockingFailures.join(' | '));
    logSeasonal('package_invalid',
      `Pacote da ordem #${job.job_order_id} não passou na validação: ${validation.blockingFailures.join('; ')}`,
      null, 'warn', { entityId: String(job.id) });
    return { package: pkg, validation, review, queued: false, attachments };
  }

  const queueStatus = review.requiresReview ? QUEUE_STATUS.AWAITING_REVIEW : QUEUE_STATUS.QUEUED;

  db.prepare(`INSERT INTO seasonal_email_queue
    (package_id, job_id, recipient_email, email_subject, email_body, attachments_json, status, queue_priority)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(package_id) DO UPDATE SET
      recipient_email = excluded.recipient_email, email_subject = excluded.email_subject,
      email_body = excluded.email_body, attachments_json = excluded.attachments_json,
      status = excluded.status, queue_priority = excluded.queue_priority,
      error_class = NULL, last_error = NULL, next_attempt_at = NULL`)
    .run(pkg.id, job.id, recipient, subject, body, JSON.stringify(attachments),
         queueStatus, match ? (match.queue_priority || 0) : 0);

  recordEvent(null, job.id, 'PACKAGE_READY',
    review.requiresReview ? 'Aguardando revisão.' : 'Pronto para envio.',
    { requiresReview: review.requiresReview, reasons: review.reasons });

  logSeasonal(review.requiresReview ? 'package_awaiting_review' : 'package_queued',
    `Pacote da ordem #${job.job_order_id} para ${recipient} — ${review.requiresReview ? 'aguardando revisão' : 'na fila'}.`,
    { auto: Boolean(options.auto) }, 'info', { entityId: String(job.id) });

  return { package: pkg, validation, review, queued: true, status: queueStatus, attachments, resume, resumeReason: rec.reason };
}

function detectCareerTrack(job) {
  const t = [job.job_title, job.duties_description].filter(Boolean).join(' ').toLowerCase();
  if (/truck|driver|cdl|haul/.test(t)) return 'driving';
  if (/tractor|combine|machinery|equipment operator/.test(t)) return 'ag_machinery';
  if (/housekeep|hotel|server|kitchen|hospitality|resort/.test(t)) return 'hospitality';
  if (/landscap|grounds|mower|nursery/.test(t)) return 'landscaping';
  if (/construction|framing|concrete|carpen/.test(t)) return 'construction';
  if (/farm|harvest|crop|orchard|livestock|cattle/.test(t)) return 'agriculture';
  return 'geral';
}

/** Aprova um pacote que estava aguardando revisão (spec §31). */
function approvePackage(packageId) {
  const pkg = db.prepare('SELECT * FROM seasonal_application_packages WHERE id = ?').get(Number(packageId));
  if (!pkg) { const e = new Error('Pacote não encontrado.'); e.userFacing = true; e.status = 404; throw e; }
  if (pkg.validation_status !== 'PASSED') {
    const e = new Error('Este pacote não passou na validação e não pode ser aprovado.');
    e.userFacing = true;
    throw e;
  }

  db.prepare(`UPDATE seasonal_application_packages SET requires_review = 0, approved_at = CURRENT_TIMESTAMP WHERE id = ?`).run(pkg.id);
  db.prepare(`UPDATE seasonal_email_queue SET status = ? WHERE package_id = ? AND status = ?`)
    .run(QUEUE_STATUS.QUEUED, pkg.id, QUEUE_STATUS.AWAITING_REVIEW);

  recordEvent(null, pkg.job_id, 'APPROVED', 'Aprovado manualmente para envio.');
  logSeasonal('package_approved', `Pacote #${pkg.id} aprovado para envio.`, null, 'info', { entityId: String(pkg.job_id) });
  return { success: true };
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

function classifyError(err) {
  const msg = String(err && err.message || '').toLowerCase();
  const code = String(err && err.responseCode || err && err.code || '');

  if (/invalid recipient|no such user|mailbox unavailable|550|553/.test(msg + code)) {
    return { class: 'PERMANENT', reason: 'Destinatário inválido ou inexistente.' };
  }
  if (/auth|credential|invalid_grant|unauthorized|401|403/.test(msg + code)) {
    return { class: 'PERMANENT', reason: 'Autorização do Gmail revogada ou inválida. Reconecte a conta.' };
  }
  if (/attachment|enoent|not found/.test(msg)) {
    return { class: 'PERMANENT', reason: 'Anexo ausente no servidor.' };
  }
  if (/timeout|etimedout|econnreset|enotfound|429|500|502|503|504|temporar/.test(msg + code)) {
    return { class: 'TRANSIENT', reason: 'Falha temporária de rede ou do provedor.' };
  }
  return { class: 'TRANSIENT', reason: err && err.message ? err.message : 'Erro desconhecido.' };
}

async function sendViaTransport({ to, subject, text, attachments, senderId = null }) {
  const cfg = getConfig();

  // Gmail via OAuth 2.0 é o caminho suportado (spec §34 do build prompt).
  // Sem conta conectada, NÃO usamos senha de aplicativo: o envio fica indisponível.
  //
  // Com rodízio de contas (F1.3), a conta vem escolhida de fora e o estado
  // legado `gmail_connected` deixa de ser a autoridade — o registro de contas é.
  if (!senderId && !cfg.gmail_connected) {
    const err = new Error('A conta do Gmail não está conectada. Conecte-a em Integrações para habilitar o envio.');
    err.permanent = true;
    throw err;
  }

  const gmail = require('./gmailService');
  return gmail.sendMail({ to, subject, text, attachments, senderId });
}

/**
 * Processa a fila respeitando cota, pausa, prioridade e backoff.
 * A ordem segue a prioridade da linha do tempo (2027 primeiro) — §33, §34.
 */
async function processQueue({ max = 10, packageId = null } = {}) {
  const cfg = getConfig();

  // 1. Kill switch (spec §63) — antes de qualquer outra coisa.
  if (cfg.pause_email_sending) {
    logSeasonal('dispatch_paused', 'Envio bloqueado: a pausa global está ativa.');
    return { processed: 0, sent: 0, reason: 'PAUSED', userMessage: 'O envio de e-mails está pausado. Nenhuma mensagem sai do sistema enquanto a pausa estiver ativa.' };
  }
  if (getSetting('global_pause_all_automations', '0') === '1') {
    return { processed: 0, sent: 0, reason: 'GLOBAL_PAUSE', userMessage: 'Todas as automações estão pausadas nas configurações do sistema.' };
  }

  const dateStr = todayKey();
  const quotaBefore = getQuotaStatus();
  if (quotaBefore.remaining <= 0) {
    logSeasonal('daily_limit_reached', `Cota diária atingida (${quotaBefore.countSent}/${quotaBefore.maxLimit}).`);
    return {
      processed: 0, sent: 0, reason: 'QUOTA_REACHED', quota: quotaBefore,
      userMessage: `Cota diária atingida: ${quotaBefore.countSent} de ${quotaBefore.maxLimit}. As candidaturas restantes continuam na fila e serão enviadas depois da virada do dia.`
    };
  }

  const nowIso = new Date().toISOString();
  const items = db.prepare(`
    SELECT q.*, j.job_order_id, j.employer_name, j.timeline_weight,
           j.truck_classification, j.application_email, j.employer_email,
           j.job_title, j.visa_type, j.employer_state
    FROM seasonal_email_queue q
    JOIN seasonal_jobs j ON q.job_id = j.id
    WHERE (q.status = ? OR (q.status = ? AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= ?)))
      ${packageId ? 'AND q.package_id = ?' : ''}
    ORDER BY q.queue_priority DESC, j.timeline_weight DESC, q.id ASC
    LIMIT ?
  `).all(...[QUEUE_STATUS.QUEUED, QUEUE_STATUS.DEFERRED, nowIso].concat(packageId ? [Number(packageId)] : []), Number(max));

  if (!items.length) {
    return { processed: 0, sent: 0, reason: 'EMPTY', quota: quotaBefore, userMessage: 'Não há candidaturas prontas para envio no momento.' };
  }

  const result = { processed: 0, sent: 0, skipped: 0, failed: 0, deferred: 0, details: [] };

  for (const item of items) {
    result.processed++;

    // 2. Anti-duplicata ANTES de reservar cota (spec §62).
    const already = db.prepare(
      'SELECT id FROM seasonal_applications WHERE candidate_id = 1 AND seasonal_job_id = ? AND recipient_email = ?'
    ).get(item.job_id, item.recipient_email);

    if (already) {
      db.prepare('UPDATE seasonal_email_queue SET status = ?, last_error = ? WHERE id = ?')
        .run(QUEUE_STATUS.SKIPPED, 'Candidatura já enviada para este destinatário.', item.id);
      recordEvent(item.id, item.job_id, 'SKIPPED_DUPLICATE', 'Já existe envio registrado.');
      result.skipped++;
      result.details.push({ jobOrderId: item.job_order_id, outcome: 'SKIPPED', reason: 'duplicata' });
      continue;
    }

    // 2b. Um e-mail por destinatário a cada N dias. Agentes e recrutadores
    // aparecem em dezenas de ordens; mandar dezenas de e-mails para a mesma
    // caixa é o caminho mais curto para a marcação de spam.
    const cooldownDays = Number(cfg.recipient_cooldown_days);
    if (cooldownDays > 0) {
      const recent = db.prepare(`SELECT sent_at, job_order_id FROM seasonal_applications
        WHERE lower(recipient_email) = lower(?) AND sent_at >= datetime('now', ?)
        ORDER BY sent_at DESC LIMIT 1`).get(item.recipient_email, `-${cooldownDays} days`);
      if (recent) {
        db.prepare('UPDATE seasonal_email_queue SET status = ?, last_error = ? WHERE id = ?')
          .run(QUEUE_STATUS.SKIPPED, `Destinatário já recebeu candidatura em ${String(recent.sent_at).slice(0, 10)} (ordem #${recent.job_order_id}); intervalo de ${cooldownDays} dias.`, item.id);
        recordEvent(item.id, item.job_id, 'SKIPPED_RECIPIENT_COOLDOWN', `Mesmo destinatário já contatado em ${String(recent.sent_at).slice(0, 10)}.`);
        result.skipped++;
        result.details.push({ jobOrderId: item.job_order_id, outcome: 'SKIPPED', reason: 'recipient_cooldown', recipient: item.recipient_email });
        continue;
      }
    }

    // 3. Revalidação dos anexos (spec §38 do build prompt: revalidar antes de enviar).
    const attachments = safeParse(item.attachments_json, []);
    const missing = attachments.find(a => !a.path || !fs.existsSync(a.path));
    if (!attachments.length || missing) {
      db.prepare('UPDATE seasonal_email_queue SET status = ?, error_class = ?, last_error = ? WHERE id = ?')
        .run(QUEUE_STATUS.FAILED, 'PERMANENT',
             missing ? `Anexo ausente: ${missing.filename}` : 'Nenhum anexo — envio exige currículo.', item.id);
      recordEvent(item.id, item.job_id, 'FAILED_ATTACHMENT', missing ? missing.filename : 'sem anexo');
      result.failed++;
      result.details.push({ jobOrderId: item.job_order_id, outcome: 'FAILED', reason: 'anexo ausente' });
      continue;
    }

    // 4. POLICY GATE (§53) — o último portão antes da ação externa.
    //
    // O pacote já passou por validação e Truth Guard no preparo, mas o estado
    // pode ter mudado desde então: a pausa pode ter sido ligada, a cota pode ter
    // acabado, a vaga pode ter sido reclassificada. O portão reavalia AGORA.
    const pkgRow = db.prepare('SELECT * FROM seasonal_application_packages WHERE id = ?').get(item.package_id);
    // Foco amplo: a ocupação não trava o envio. Foco "só motorista": só passa
    // o que o portão confirmou.
    const truckOk = Number(cfg.require_truck_driver_match) !== 1
      || !item.truck_classification
      || ['TRUCK_DRIVER_CONFIRMED', 'TRUCK_DRIVER_PROBABLE'].includes(item.truck_classification);

    const policy = policyGate.evaluate({
      provider: policyGate.PROVIDER.SEASONAL,
      action: policyGate.ACTION.SEND_APPLICATION_EMAIL,
      application: {
        applicationEmailListed: Boolean(item.application_email || item.employer_email || item.recipient_email),
        truckDriverMatch: truckOk,
        truthValidationPassed: !pkgRow || pkgRow.validation_status === 'PASSED',
        resumeFromCorrectEnvironment: Boolean(pkgRow && pkgRow.selected_resume_id),
        alreadyApplied: false,
        quotaAvailable: getQuotaStatus().remaining > 0
      },
      rules: {
        globalPause: getSetting('global_pause_all_automations', '0') === '1',
        emailSendingPaused: Boolean(cfg.pause_email_sending)
      }
    });

    if (!policy.allowed) {
      const failedChecks = policy.checks.filter(c => !c.passed).map(c => c.label).join('; ');
      db.prepare('UPDATE seasonal_email_queue SET status = ?, error_class = ?, last_error = ? WHERE id = ?')
        .run(QUEUE_STATUS.MANUAL_ACTION_REQUIRED, 'POLICY', policy.message, item.id);
      recordEvent(item.id, item.job_id, 'POLICY_DENIED', policy.message, { code: policy.code, failedChecks });
      logSeasonal('policy_denied',
        `Envio bloqueado pelo Policy Gate na ordem #${item.job_order_id}: ${policy.message}`,
        { code: policy.code }, 'warn', { entityId: String(item.job_id) });
      result.skipped++;
      result.details.push({ jobOrderId: item.job_order_id, outcome: 'BLOCKED', reason: policy.code });
      continue;
    }

    // 5. Reserva atômica da cota DO DIA.
    if (!reserveQuotaSlot(dateStr)) {
      db.prepare('UPDATE seasonal_email_queue SET status = ? WHERE id = ?').run(QUEUE_STATUS.QUEUED, item.id);
      recordEvent(item.id, item.job_id, 'DEFERRED_QUOTA', 'Cota diária esgotada durante o processamento.');
      logSeasonal('daily_limit_reached', 'Cota diária esgotada durante o processamento da fila.');
      notifyUi('quota', 'Cota do dia atingida', 'As candidaturas restantes continuam na fila e saem depois da virada do dia.', 'logs');
      result.details.push({ jobOrderId: item.job_order_id, outcome: 'DEFERRED', reason: 'cota' });
      break;
    }

    // 5b. Escolhe a conta de envio e reserva a cota DELA (F1.3).
    //
    // São duas cotas independentes, e um envio só sai quando as duas passam: o
    // teto do dia protege o produto, o teto da conta protege aquela conta de
    // chamar atenção do Google.
    const pick = senders.nextAvailable({ globalCap: quotaBefore.maxLimit });
    const haveSenders = senders.list().length > 0;

    if (haveSenders && !pick) {
      // Há contas cadastradas, mas nenhuma ativa com vaga. Devolve a cota do dia
      // — ela conta envio bem-sucedido, e nada foi enviado.
      releaseQuotaSlot(dateStr);
      db.prepare('UPDATE seasonal_email_queue SET status = ? WHERE id = ?').run(QUEUE_STATUS.QUEUED, item.id);
      recordEvent(item.id, item.job_id, 'DEFERRED_SENDER', 'Nenhuma conta de envio com cota disponível.');
      logSeasonal('sender_exhausted',
        'Todas as contas de envio atingiram o limite do dia ou estão desativadas. A fila segue amanhã.',
        null, 'warn');
      result.details.push({ jobOrderId: item.job_order_id, outcome: 'DEFERRED', reason: 'contas sem cota' });
      break;
    }

    const senderId = pick ? pick.sender.id : null;

    db.prepare('UPDATE seasonal_email_queue SET status = ? WHERE id = ?').run(QUEUE_STATUS.SENDING, item.id);

    try {
      await sendViaTransport({
        to: item.recipient_email,
        subject: item.email_subject,
        text: item.email_body,
        attachments: attachments.map(a => ({ filename: a.filename, path: a.path })),
        senderId
      });

      if (senderId) senders.recordSuccess(senderId);

      // 6. Registro permanente — é ele que sustenta o anti-duplicata (§62).
      // O histórico guarda a sua própria cópia do que importa da vaga (título,
      // visto, estado): ele precisa continuar legível mesmo que a vaga mude ou suma.
      db.prepare(`INSERT INTO seasonal_applications
        (candidate_id, seasonal_job_id, job_order_id, recipient_email, employer_name, subject, content_sent, attachments_json,
         job_title, visa_type, employer_state)
        VALUES (1,?,?,?,?,?,?,?,?,?,?)`)
        .run(item.job_id, item.job_order_id, item.recipient_email, item.employer_name,
             item.email_subject, item.email_body, item.attachments_json,
             item.job_title || null, item.visa_type || null, item.employer_state || null);

      db.prepare('UPDATE seasonal_email_queue SET status = ?, sent_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?')
        .run(QUEUE_STATUS.SENT, item.id);

      recordEvent(item.id, item.job_id, 'SENT', `Enviado para ${item.recipient_email}.`);
      logSeasonal('email_sent', `Candidatura enviada para ${item.recipient_email} (ordem #${item.job_order_id}).`,
                  null, 'info', { entityId: String(item.job_id) });

      result.sent++;
      result.details.push({ jobOrderId: item.job_order_id, outcome: 'SENT' });
      notifyUi('sent', `Candidatura enviada — ${item.employer_name}`, `${item.email_subject} → ${item.recipient_email}`, `job:${item.job_id}`);
    } catch (err) {
      // O e-mail NÃO saiu: devolve AS DUAS cotas — as duas contam sucesso.
      releaseQuotaSlot(dateStr);
      if (senderId) senders.releaseSlot(senderId, dateStr);

      const cls = err.permanent ? { class: 'PERMANENT', reason: err.message } : classifyError(err);

      // Conta com autorização revogada sai do rodízio e as outras continuam.
      // Insistir numa conta bloqueada só gasta a fila e faz o robô parecer
      // quebrado quando ele ainda tem caminho para enviar.
      if (senderId) {
        const v = senders.recordFailure(senderId, { errorClass: cls.class, reason: cls.reason });
        if (v && v.deactivated) {
          result.details.push({ senderDeactivated: true, reason: cls.reason });
          notifyUi('sender', 'Conta Gmail desativada automaticamente', cls.reason, 'settings');
        }
      }
      const attempts = (item.attempts || 0) + 1;

      if (cls.class === 'TRANSIENT' && attempts <= RETRY_BACKOFF_MINUTES.length) {
        const waitMin = RETRY_BACKOFF_MINUTES[attempts - 1];
        const next = new Date(Date.now() + waitMin * 60000).toISOString();
        db.prepare(`UPDATE seasonal_email_queue SET status = ?, attempts = ?, error_class = ?,
                    last_error = ?, next_attempt_at = ? WHERE id = ?`)
          .run(QUEUE_STATUS.DEFERRED, attempts, cls.class, cls.reason, next, item.id);
        recordEvent(item.id, item.job_id, 'DEFERRED_RETRY', `${cls.reason} Nova tentativa em ${waitMin} min.`);
        result.deferred++;
        result.details.push({ jobOrderId: item.job_order_id, outcome: 'DEFERRED', reason: cls.reason, retryInMinutes: waitMin });
      } else {
        db.prepare(`UPDATE seasonal_email_queue SET status = ?, attempts = ?, error_class = ?, last_error = ? WHERE id = ?`)
          .run(QUEUE_STATUS.FAILED, attempts, cls.class, cls.reason, item.id);
        recordEvent(item.id, item.job_id, 'FAILED', cls.reason);
        notifyUi('failed', `Falha no envio — ${item.employer_name}`, cls.reason, `job:${item.job_id}`);
        logSeasonal('email_failed', `Falha ao enviar para ${item.recipient_email}: ${cls.reason}`,
                    null, 'error', { entityId: String(item.job_id) });
        result.failed++;
        result.details.push({ jobOrderId: item.job_order_id, outcome: 'FAILED', reason: cls.reason });
      }
    }
  }

  result.quota = getQuotaStatus();
  result.userMessage = buildDispatchMessage(result);
  return result;
}

function buildDispatchMessage(r) {
  const parts = [];
  if (r.sent) parts.push(`${r.sent} candidatura(s) enviada(s)`);
  if (r.deferred) parts.push(`${r.deferred} reagendada(s) para nova tentativa`);
  if (r.skipped) parts.push(`${r.skipped} ignorada(s) por duplicidade`);
  if (r.failed) parts.push(`${r.failed} com falha`);
  if (!parts.length) return 'Nenhuma candidatura foi processada.';
  return parts.join(', ') + `. Restam ${r.quota.remaining} de ${r.quota.maxLimit} envios hoje.`;
}

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------

function setPause(paused) {
  db.prepare('UPDATE seasonal_config SET pause_email_sending = ?, updated_at = CURRENT_TIMESTAMP').run(paused ? 1 : 0);
  logSeasonal('pause_toggled', paused
    ? 'Envio de e-mails PAUSADO. Descoberta, análise e preparo continuam.'
    : 'Envio de e-mails REATIVADO.');
  return { paused: Boolean(paused) };
}

function getQueue({ status = null, limit = 200 } = {}) {
  const where = status && status !== 'all' ? 'WHERE q.status = ?' : '';
  const params = status && status !== 'all' ? [String(status)] : [];
  return db.prepare(`
    SELECT q.*, j.job_order_id, j.job_title, j.employer_name, j.employer_state, j.wage_rate,
           j.visa_type, j.timeline_class, j.timeline_label, j.timeline_period,
           p.requires_review, p.validation_status, p.review_reasons_json
    FROM seasonal_email_queue q
    JOIN seasonal_jobs j ON q.job_id = j.id
    LEFT JOIN seasonal_application_packages p ON q.package_id = p.id
    ${where}
    ORDER BY q.queue_priority DESC, j.timeline_weight DESC, q.id DESC
    LIMIT ?
  `).all(...params, Number(limit)).map(r => Object.assign(r, {
    reviewReasons: safeParse(r.review_reasons_json, [])
  }));
}

function getSentApplications(limit = 200) {
  return db.prepare('SELECT * FROM seasonal_applications ORDER BY sent_at DESC LIMIT ?').all(Number(limit));
}

function getPackage(jobId) {
  const pkg = db.prepare('SELECT * FROM seasonal_application_packages WHERE job_id = ?').get(Number(jobId));
  if (!pkg) return null;
  return Object.assign({}, pkg, {
    validation: safeParse(pkg.validation_json, null),
    reviewReasons: safeParse(pkg.review_reasons_json, []),
    attachments: safeParse(pkg.attachments_json, [])
  });
}

function safeParse(s, f) { try { return JSON.parse(s || ''); } catch (e) { return f; } }

module.exports = {
  isDrivingJob,
  ABSOLUTE_DAILY_CAP, absoluteDailyCap, QUEUE_STATUS, RETRY_BACKOFF_MINUTES,
  todayKey, getTimezone, nextResetAt, configuredLimit,
  getQuotaStatus, reserveQuotaSlot, releaseQuotaSlot, ensureQuotaRow,
  buildCoverLetter, isRecurringEmployer, validatePackage, reviewDecision,
  prepareApplicationPackage, approvePackage,
  processQueue, setPause, getQueue, getSentApplications, getPackage,
  classifyError, detectCareerTrack
};
