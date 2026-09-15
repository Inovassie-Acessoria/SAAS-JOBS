/**
 * Base de divulgação do DOL — importação com curadoria.
 *
 * O arquivo é o H-2B Disclosure Data (planilha pública do DOL) convertido em
 * JSON: um registro por PEDIDO certificado, com empregador, cargo, salário,
 * horas, requisitos, contato e como se candidatar. São vagas de temporada
 * passada — o pedido já encerrou —, de empregadores que contratam pelo
 * programa todo ano. Entram no acervo com origin = 'disclosure', com selo
 * próprio, e a candidatura sai como interesse na próxima temporada.
 *
 * Curadoria, na ordem:
 *   1. só pedidos certificados com dados completos; os "pendentes de loteria"
 *      só têm nome do empregador e estado — não dá para se candidatar;
 *   2. mesmo empregador + mesmo cargo + mesma cidade/estado = UM card
 *      (datas diferentes se juntam; cidade diferente é outro card). Fica o
 *      pedido mais recente e mais completo; as vagas dos pedidos da mesma
 *      data somam; os demais números de caso ficam listados no card;
 *   3. e-mail de candidatura: o de "como se candidatar", senão o do contato
 *      do empregador — NUNCA o do advogado/agente;
 *   4. o índice público do seasonaljobs.dol.gov enriquece o que a base não
 *      tem (descrição das tarefas, e-mail publicado, estado do caso);
 *   5. o card some da lista enquanto o mesmo empregador tiver o mesmo cargo
 *      no mesmo estado entre as vagas ATUAIS do DOL — regra recalculada ao
 *      fim de toda importação (seasonalService.refreshDuplicateFlags).
 */

const fs = require('fs');
const path = require('path');
const { db, logSeasonal } = require('../config/database');
const keys = require('../core/jobs/dedupKeys');
const { stateCode } = require('./adapters/dolIndexClient');

const ORIGIN = 'disclosure';
const WAGE_UNITS = { hour: 'Hour', week: 'Week', 'bi-weekly': 'Bi-Weekly', biweekly: 'Bi-Weekly', month: 'Month', year: 'Year', 'piece rate': 'Piece Rate' };

// ---------------------------------------------------------------- utilidades

function clean(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' || /^(n\/?a|none|null|-)$/i.test(t) ? null : t;
}
function emailOf(v) {
  const t = clean(v);
  if (!t) return null;
  const m = t.match(/[^\s<>,;"']+@[^\s<>,;"']+\.[a-z]{2,}/i);
  return m ? m[0].toLowerCase() : null;
}
function urlOf(v) {
  const t = clean(v);
  if (!t || !/^(https?:\/\/|www\.)/i.test(t)) return null;
  return /^www\./i.test(t) ? 'http://' + t : t;
}
function isoDate(v) {
  const t = clean(v);
  if (!t) return null;
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function yn(v) { return /^y(es)?$/i.test(String(v || '').trim()) ? 1 : 0; }
function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }

// ---------------------------------------------------------------- leitura

function parseFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    const err = new Error('O arquivo não é um JSON válido.'); err.userFacing = true; err.status = 400; throw err;
  }
  const rows = Array.isArray(data) ? data : (data && (data.jobs || data.rows || data.data));
  if (!Array.isArray(rows)) {
    const err = new Error('O JSON precisa ser uma lista de vagas (ou um objeto com "jobs").'); err.userFacing = true; err.status = 400; throw err;
  }
  return rows;
}

/** Por que uma linha não vira vaga — ou null se serve. */
function rejectReason(r) {
  if (!r || typeof r !== 'object') return 'invalid';
  if (!clean(r.case_number)) return 'no_case';
  if (r.status_category && r.status_category !== 'certified') return 'not_certified';
  if (r.has_full_job_details === false) return 'no_details';
  if (!clean(r.job && r.job.job_title)) return 'no_title';
  if (!clean(r.employer && r.employer.name)) return 'no_employer';
  return null;
}

/** Linha da base → vaga no formato do acervo (o mesmo do feed e do índice). */
function normalizeRecord(r, sourceRef = null) {
  const job = r.job || {}, dates = r.dates || {}, emp = r.employer || {}, contact = r.employer_contact || {};
  const site = r.worksite || {}, wage = r.wage || {}, sched = r.schedule || {}, how = r.how_to_apply || {}, extra = r.extra_conditions || {};
  const caseNumber = String(r.case_number).trim().toUpperCase();
  const visa = /^H-300/.test(caseNumber) ? 'H-2A' : 'H-2B';

  const applyEmail = emailOf(how.email);
  const contactEmail = emailOf(contact.email);
  const applyUrl = urlOf(how.website);
  const phone = clean(how.phone) || clean(emp.phone) || clean(contact.phone);
  // Regra 3: primeiro "como se candidatar", depois o contato do empregador. Advogado nunca.
  const email = applyEmail || contactEmail;
  const method = email ? 'EMAIL' : applyUrl ? 'WEBSITE' : phone ? 'PHONE' : 'UNKNOWN';

  const req = [];
  const months = parseInt(job.work_experience_months || 0, 10);
  if (months > 0) req.push(`${months} months of experience required.`);
  const training = parseInt(job.training_months || 0, 10);
  if (training > 0) req.push(`${training} months of training required.`);
  const edu = clean(job.education_level);
  if (edu && !/^none$/i.test(edu)) req.push(`Minimum education: ${edu}.`);
  const special = clean(job.special_requirements);
  if (special) req.push(special);

  const conditions = [];
  if (clean(job.soc_title)) conditions.push(`Occupation: ${clean(job.soc_title)} (SOC ${clean(job.soc_code) || '—'}).`);
  if (clean(sched.hourly_schedule_begin) && clean(sched.hourly_schedule_end)) conditions.push(`Schedule: ${sched.hourly_schedule_begin} to ${sched.hourly_schedule_end}${num(sched.anticipated_hours_per_week) ? `, ${sched.anticipated_hours_per_week} hours per week` : ''}.`);
  if (/^y$/i.test(String(wage.overtime_available || ''))) conditions.push(`Overtime available${num(wage.overtime_rate_from) ? ` at $${wage.overtime_rate_from}/hour` : ''}.`);
  if (clean(wage.additional_wage_conditions)) conditions.push(clean(wage.additional_wage_conditions));
  if (clean(extra.deductions_from_pay)) conditions.push(`Deductions from pay: ${clean(extra.deductions_from_pay)}`);
  if (yn(extra.employer_provided_tools_equipment)) conditions.push('Tools and equipment provided by the employer.');
  if (yn(extra.on_the_job_training_available)) conditions.push('On-the-job training available.');

  const unitRaw = String(wage.per || 'Hour').trim().toLowerCase();
  const start = isoDate(dates.employment_begin_date) || isoDate(dates.requested_begin_date);
  const end = isoDate(dates.employment_end_date) || isoDate(dates.requested_end_date);
  const state = stateCode(clean(site.state) || clean(emp.state));
  const title = clean(job.job_title);

  return {
    job_order_id: caseNumber,
    visa_type: visa,
    job_title: title,
    normalized_title: title,
    soc_code: (clean(job.soc_code) || '').replace(/\.00$/, '') || null,
    employer_name: clean(emp.name),
    employer_city: clean(site.city) || clean(emp.city),
    employer_state: state,
    employer_phone: phone,
    employer_email: contactEmail,
    // Advogado/agente fica só no raw_json: nunca vira destinatário.
    attorney_name: null,
    attorney_email: null,
    wage_rate: num(wage.rate_from),
    wage_unit: WAGE_UNITS[unitRaw] || (clean(wage.per) || 'Hour'),
    start_date: start,
    end_date: end,
    openings: parseInt(job.workers_certified || job.workers_requested || '1', 10) || 1,
    weekly_hours: parseInt(sched.anticipated_hours_per_week || '0', 10) || null,
    housing_provided: visa === 'H-2A' ? 1 : yn(extra.board_lodging_other_facilities),
    transportation_provided: visa === 'H-2A' ? 1 : yn(extra.daily_transportation),
    // A base não traz a descrição das tarefas; o índice do DOL completa. Até
    // lá, o card mostra as condições do pedido — nunca fica em branco.
    duties_description: conditions.length ? conditions.join('\n') : null,
    special_requirements: req.length ? req.join('\n') : null,
    application_method: method,
    application_email: email,
    application_url: applyUrl,
    provider_feed: ORIGIN,
    origin: ORIGIN,
    origin_ref: sourceRef || clean(r.source_file),
    feed_key: null,
    feed_date: null,
    dol_url: `https://seasonaljobs.dol.gov/jobs/${caseNumber}`,
    dol_published: 0,
    dol_active: 0,
    dol_status: clean(r.case_status) || 'Determination Issued - Certification',
    dol_accepted_at: isoDate(dates.decision_date),
    dol_active_until: null,
    raw_json: JSON.stringify({ disclosure: r }).slice(0, 20000),
    _received: clean(dates.received_date) || '',
    _complete: (email ? 4 : 0) + (num(wage.rate_from) ? 2 : 0) + (special ? 1 : 0) + (start ? 1 : 0)
  };
}

// ---------------------------------------------------------------- curadoria

function groupKey(j) {
  return [keys.employerKey(j.employer_name), keys.titleKey(j.job_title), j.employer_state || '', keys.cityKey(j.employer_city)].join('|');
}

/**
 * Regra 2: dobra pedidos que são a mesma vaga. Devolve os representantes
 * (com `merged_cases`) e quantas linhas foram dobradas.
 */
function curate(jobs) {
  const groups = new Map();
  for (const j of jobs) {
    const k = groupKey(j);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(j);
  }
  const representatives = [];
  let mergedRows = 0, mergedGroups = 0;
  for (const list of groups.values()) {
    if (list.length === 1) { representatives.push(list[0]); continue; }
    // Mais recente primeiro (início, depois recebimento), depois o mais completo.
    list.sort((a, b) => String(b.start_date || '').localeCompare(String(a.start_date || ''))
      || String(b._received).localeCompare(String(a._received)) || b._complete - a._complete);
    const rep = list[0];
    const sameSeason = list.filter(x => x !== rep && x.start_date === rep.start_date);
    rep.openings = (rep.openings || 0) + sameSeason.reduce((n, x) => n + (x.openings || 0), 0);
    // Um pedido irmão pode ter o e-mail/salário que o representante não tem.
    for (const x of list.slice(1)) {
      if (!rep.application_email && x.application_email) { rep.application_email = x.application_email; rep.application_method = 'EMAIL'; }
      if (!rep.wage_rate && x.wage_rate) { rep.wage_rate = x.wage_rate; rep.wage_unit = x.wage_unit; }
      if (!rep.special_requirements && x.special_requirements) rep.special_requirements = x.special_requirements;
      if (!rep.employer_phone && x.employer_phone) rep.employer_phone = x.employer_phone;
    }
    rep.merged_cases = list.slice(1).map(x => ({ case: x.job_order_id, start: x.start_date, end: x.end_date, openings: x.openings }));
    mergedRows += list.length - 1;
    mergedGroups++;
    representatives.push(rep);
  }
  return { representatives, mergedRows, mergedGroups };
}

/** Regra 4: o índice do DOL completa descrição, e-mail publicado e estado. */
function enrichFromIndex(job, idx) {
  if (!idx) return false;
  if (idx.duties_description) job.duties_description = idx.duties_description;
  if (!job.application_email && idx.application_email) { job.application_email = idx.application_email; job.application_method = 'EMAIL'; }
  if (!job.application_url && idx.application_url) { job.application_url = idx.application_url; if (job.application_method === 'UNKNOWN' || job.application_method === 'PHONE') job.application_method = 'WEBSITE'; }
  if (!job.employer_email && idx.employer_email) job.employer_email = idx.employer_email;
  if (!job.wage_rate && idx.wage_rate) { job.wage_rate = idx.wage_rate; job.wage_unit = idx.wage_unit; }
  if (!job.weekly_hours && idx.weekly_hours) job.weekly_hours = idx.weekly_hours;
  if (idx.special_requirements && (!job.special_requirements || idx.special_requirements.length > job.special_requirements.length)) job.special_requirements = idx.special_requirements;
  if (idx.dol_status) job.dol_status = idx.dol_status;
  if (idx.dol_active !== null && idx.dol_active !== undefined) job.dol_active = idx.dol_active;
  if (idx.dol_accepted_at) job.dol_accepted_at = idx.dol_accepted_at;
  job.dol_published = 1;
  job.dol_url = idx.dol_url || job.dol_url;
  return true;
}


// ---------------------------------------------------------------- execução

const progress = { running: false, phase: null, done: 0, total: 0, startedAt: null, file: null, error: null };
function status() {
  const last = db.prepare("SELECT value FROM core_system_settings WHERE key = 'disclosure_last_import'").get();
  let lastReport = null;
  try { lastReport = last ? JSON.parse(last.value) : null; } catch (e) { lastReport = null; }
  const inBase = db.prepare("SELECT COUNT(*) c FROM seasonal_jobs WHERE origin = 'disclosure'").get().c;
  return Object.assign({}, progress, { lastReport, inBase });
}
function setProgress(patch) { Object.assign(progress, patch); }

/**
 * Importa um arquivo (ou uma lista já lida). `enrich` consulta o índice do
 * DOL — desligue só em teste ou sem internet: a importação segue sem ele.
 */
async function run({ file = null, rows = null, enrich = true, userId = 1, sourceRef = null, onProgress = null } = {}) {
  if (progress.running) { const e = new Error('Já existe uma importação da base em andamento.'); e.userFacing = true; e.status = 409; throw e; }
  const started = Date.now();
  setProgress({ running: true, phase: 'lendo', done: 0, total: 0, startedAt: new Date().toISOString(), file: file ? path.basename(file) : null, error: null });
  const tick = (patch) => { setProgress(patch); if (onProgress) onProgress(Object.assign({}, progress)); };
  try {
    const seasonal = require('./seasonalService');
    const cfg = seasonal.getConfig();
    const profile = seasonal.candidateProfile(userId);
    if (profile.isEmpty) {
      const e = new Error('Preencha o perfil antes de importar a base: é ele que pontua as vagas.'); e.userFacing = true; throw e;
    }

    const list = rows || parseFile(file);
    const ref = sourceRef || (file ? path.basename(file) : null);
    const skipped = {};
    const usable = [];
    for (const r of list) {
      const why = rejectReason(r);
      if (why) { skipped[why] = (skipped[why] || 0) + 1; continue; }
      usable.push(normalizeRecord(r, ref));
    }
    tick({ phase: 'curadoria', total: usable.length });
    const { representatives, mergedRows, mergedGroups } = curate(usable);

    let enriched = { attempted: false, found: 0, withDuties: 0, error: null };
    if (enrich && representatives.length) {
      tick({ phase: 'índice do DOL', done: 0, total: representatives.length });
      try {
        const idx = await require('./adapters/dolIndexClient').fetchCases(representatives.map(j => j.job_order_id), {
          onBatch: (b) => tick({ done: b.done })
        });
        enriched.attempted = true;
        for (const j of representatives) {
          const rec = idx[j.job_order_id];
          if (enrichFromIndex(j, rec)) { enriched.found++; if (rec.duties_description) enriched.withDuties++; }
        }
      } catch (e) {
        enriched.error = e.message;
        logSeasonal('disclosure_index_unavailable', `Índice do DOL indisponível durante a importação da base (${e.message}); vagas importadas sem a descrição.`, null, 'warn');
      }
    }

    tick({ phase: 'gravando e pontuando', done: 0, total: representatives.length });
    for (const j of representatives) { delete j._received; delete j._complete; }
    // Um lote só: 10 mil escritas em transações separadas levariam minutos.
    db.exec('BEGIN');
    let metrics;
    try {
      metrics = seasonal.runPipeline(representatives, { cfg, profile, userId, force: false });
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    // Regra 5: quem já tem a mesma vaga entre as atuais fica oculta.
    seasonal.refreshDuplicateFlags();
    const ids = representatives.map(j => j.job_order_id);
    let hiddenByCurrent = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      hiddenByCurrent += db.prepare(`SELECT COUNT(*) c FROM seasonal_jobs WHERE dup_hidden = 1 AND job_order_id IN (${chunk.map(() => '?').join(',')})`).get(...chunk).c;
    }

    const withEmail = representatives.filter(j => j.application_method === 'EMAIL' && j.application_email).length;
    const report = {
      finishedAt: new Date().toISOString(), file: ref, durationMs: Date.now() - started,
      received: list.length, usable: usable.length, skipped,
      mergedGroups, mergedRows, cards: representatives.length,
      enriched, hiddenByCurrent,
      withEmail, websiteOnly: representatives.filter(j => j.application_method === 'WEBSITE').length,
      noContact: representatives.filter(j => j.application_method === 'UNKNOWN').length,
      stored: metrics.stored, newJobs: metrics.newJobs, analyzed: metrics.analyzed, recommended: metrics.recommended,
      filteredOut: metrics.filteredOut, errors: metrics.errors.slice(0, 20)
    };
    db.prepare(`INSERT INTO core_system_settings (key, value, description) VALUES ('disclosure_last_import', ?, 'Último relatório de importação da base de divulgação do DOL.')
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(JSON.stringify(report));
    logSeasonal('disclosure_import',
      `Base de divulgação: ${report.received} linha(s) lida(s), ${report.cards} card(s) (${report.mergedRows} pedido(s) dobrados), ${report.newJobs} nova(s), ${report.withEmail} com e-mail, ${report.hiddenByCurrent} oculta(s) por já existirem entre as atuais.`,
      report);
    try {
      require('./seasonalUiService').notify('import', 'Base do DOL importada',
        `${report.cards} empregador(es) de temporada passada · ${report.withEmail} com e-mail · ${report.mergedRows} duplicata(s) dobrada(s)`, 'jobs');
    } catch (e) { /* silencioso */ }
    tick({ phase: 'concluída', done: representatives.length });
    return report;
  } catch (e) {
    setProgress({ error: e.message });
    throw e;
  } finally {
    setProgress({ running: false });
  }
}

module.exports = { ORIGIN, parseFile, rejectReason, normalizeRecord, curate, enrichFromIndex, groupKey, run, status };
