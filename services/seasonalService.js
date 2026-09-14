/**
 * Seasonal Jobs — somente Estados Unidos (spec §4.3, §28, §33, §45).
 *
 * Além do que Gupy e Indeed fazem, este produto classifica a JANELA DE
 * CONTRATAÇÃO e prioriza estrategicamente as vagas com período de trabalho em
 * 2027, conforme a regra de negócio da §33. A ordenação é sempre explicável.
 */

const { db, logSeasonal } = require('../config/database');
const pipeline = require('./pipeline');
const candidate = require('./candidateService');
const atsService = require('./atsService');
const scoreEngine = require('../core/match/scoreEngine');
const timelineEngine = require('../core/timeline/hiringTimelineEngine');
const { DolAdapter, DEFAULT_BASE_URL: DOL_DEFAULT_BASE_URL } = require('./adapters/dolAdapter');
const { HEALTH } = require('./adapters/mcpClient');

const COUNTRY = 'US';
const PLATFORM = 'seasonal';

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

function getConfig() {
  let row = db.prepare('SELECT * FROM seasonal_config ORDER BY id LIMIT 1').get();
  if (!row) {
    db.prepare('INSERT INTO seasonal_config DEFAULT VALUES').run();
    row = db.prepare('SELECT * FROM seasonal_config ORDER BY id LIMIT 1').get();
  }
  return row;
}

const AUTOMATION_MODES = ['MANUAL', 'ASSISTED', 'AUTOMATIC'];
const REVIEW_MODES = ['ALWAYS_REVIEW', 'REVIEW_FLAGGED', 'FULLY_AUTOMATIC'];

/**
 * Teto de envios do dia, lido de quem é dono dele.
 *
 * Este módulo repetia o número 50 em três lugares da mesma linha. Número de
 * segurança copiado é número que fica para trás quando o original muda — e o
 * limite do produto tem um dono só: `seasonalEmailService.ABSOLUTE_DAILY_CAP`.
 *
 * O require é tardio de propósito: os dois módulos se referenciam, e resolver
 * no topo criaria dependência circular.
 */
function emailCap() {
  return require('./seasonalEmailService').ABSOLUTE_DAILY_CAP;
}

function updateConfig(data) {
  const cur = getConfig();
  // Campos de texto/lista: string vazia enviada = LIMPAR (o assistente manda
  // '' para "todos os estados"). Campos numéricos: '' = manter o atual, porque
  // um <input type=number> vazio não é uma escolha.
  const TEXT_FIELDS = new Set(['preferred_states', 'preferred_occupations', 'excluded_occupations',
                               'english_level', 'dol_feed_url', 'available_from', 'available_to']);
  const v = (k, d) => {
    if (data[k] === undefined) return cur[k] !== undefined ? cur[k] : d;
    if (data[k] === '' && !TEXT_FIELDS.has(k)) return cur[k] !== undefined ? cur[k] : d;
    return data[k];
  };
  const b = (k) => (data[k] !== undefined ? (data[k] ? 1 : 0) : cur[k]);

  const mode = AUTOMATION_MODES.includes(String(data.automation_mode)) ? data.automation_mode : cur.automation_mode;
  const review = REVIEW_MODES.includes(String(data.email_review_mode)) ? data.email_review_mode : cur.email_review_mode;

  db.prepare(`UPDATE seasonal_config SET
      h2a_preference = ?, h2b_preference = ?, preferred_states = ?, preferred_occupations = ?,
      excluded_occupations = ?, min_hourly_wage = ?, available_from = ?, available_to = ?,
      desired_weekly_hours = ?, housing_required = ?, transportation_required = ?, english_level = ?,
      physical_labor_ready = ?, pref_hospitality = ?, pref_agriculture = ?, pref_construction = ?,
      pref_maintenance = ?, pref_driving = ?,
      automation_mode = ?, email_review_mode = ?,
      auto_queue_fit_threshold = ?, auto_queue_ats_threshold = ?, auto_queue_opportunity_threshold = ?,
      target_hiring_year = ?, daily_email_limit = ?, dol_feed_url = ?,
      onboarding_step = ?, onboarding_done = ?, require_truck_driver_match = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).run(
    b('h2a_preference'), b('h2b_preference'),
    String(v('preferred_states', '')), String(v('preferred_occupations', '')),
    String(v('excluded_occupations', '')),
    Number(v('min_hourly_wage', 0)) || 0,
    v('available_from', null), v('available_to', null),
    parseInt(v('desired_weekly_hours', 0), 10) || null,
    b('housing_required'), b('transportation_required'),
    String(v('english_level', '')), b('physical_labor_ready'),
    b('pref_hospitality'), b('pref_agriculture'), b('pref_construction'),
    b('pref_maintenance'), b('pref_driving'),
    mode, review,
    parseInt(v('auto_queue_fit_threshold', 85), 10),
    parseInt(v('auto_queue_ats_threshold', 75), 10),
    parseInt(v('auto_queue_opportunity_threshold', 85), 10),
    parseInt(v('target_hiring_year', 2027), 10),
    Math.min(emailCap(), parseInt(v('daily_email_limit', emailCap()), 10) || emailCap()),
    String(v('dol_feed_url', '')),
    parseInt(v('onboarding_step', 0), 10), v('onboarding_done', 0) ? 1 : 0,
    // Foco: 1 = só motorista de caminhão, 0 = todas as vagas (padrão).
    data.require_truck_driver_match === undefined
      ? (Number(cur.require_truck_driver_match) === 1 ? 1 : 0)
      : ([1, '1', true].includes(data.require_truck_driver_match) ? 1 : 0),
    cur.id
  );

  logSeasonal('config_updated', 'Configuração do Seasonal Jobs atualizada.', {
    automation_mode: mode, email_review_mode: review
  });
  return getConfig();
}

/** Repositório de candidato DESTE produto — Seasonal é US-only (§1B, §4.3). */
function store(userId) {
  return candidate.environment(PLATFORM, COUNTRY, userId);
}

/**
 * Perfil do candidato Seasonal, combinado com as preferências sazonais.
 * Não há Perfil Mestre: estes dados pertencem exclusivamente ao Seasonal (§1A).
 */
function candidateProfile(userId) {
  const cfg = getConfig();
  const own = store(userId).getProfile();
  return Object.assign({}, own, {
    minHourlyWage: cfg.min_hourly_wage,
    preferredStates: splitList(cfg.preferred_states),
    preferredOccupations: splitList(cfg.preferred_occupations),
    excludedOccupations: splitList(cfg.excluded_occupations),
    housingRequired: Boolean(cfg.housing_required),
    availabilityFrom: cfg.available_from || own.availabilityFrom,
    availabilityTo: cfg.available_to || own.availabilityTo
  });
}

// ---------------------------------------------------------------------------
// Integração DOL
// ---------------------------------------------------------------------------

function buildAdapter() {
  const cfg = getConfig();

  // Três origens, e o nome da variável importa: o `.env.example` sempre
  // documentou SEASONAL_FEED_BASE_URL — que é o que o próprio DolAdapter lê —
  // mas aqui só SEASONAL_DATA_URL era consultada. Resultado: com tudo
  // configurado corretamente, o produto caía em modo fixture e se declarava
  // pronto. A varredura reforçava o engano, porque checava a variável e não o
  // adaptador que seria construído.
  const url = cfg.dol_feed_url
    || process.env.SEASONAL_DATA_URL
    || process.env.SEASONAL_FEED_BASE_URL
    || '';

  // O feed do DOL é público e tem endereço padrão conhecido. Quando o operador
  // liga SEASONAL_FEED_ENABLED, usar o padrão é o comportamento correto —
  // exigir a URL de novo seria burocracia sem ganho.
  const enabled = String(process.env.SEASONAL_FEED_ENABLED || '').toLowerCase() === 'true';
  const effective = url || (enabled ? DOL_DEFAULT_BASE_URL : '');

  // `baseUrl` e `feedUrl` NÃO são a mesma coisa: o adaptador monta o caminho
  // real (/datahub-search/sjCaseData/zip/<feed>/<data>) a partir do baseUrl,
  // enquanto feedUrl é um endereço completo que substitui essa montagem.
  // Preencher os dois com o mesmo valor faz o adaptador baixar a página
  // inicial do site em vez do arquivo de dados.
  const isFullFeedUrl = /\/(datahub-search|zip)\//.test(effective);

  return new DolAdapter({
    baseUrl: isFullFeedUrl ? undefined : effective,
    feedUrl: isFullFeedUrl ? effective : '',
    fixtureMode: !effective
  });
}

async function testConnection() {
  const adapter = buildAdapter();
  const result = await adapter.testConnection();
  db.prepare(`UPDATE seasonal_config SET health_status = ?,
      last_success_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_success_at END,
      last_failure_at = CASE WHEN ? = 0 THEN CURRENT_TIMESTAMP ELSE last_failure_at END,
      last_error = ?, updated_at = CURRENT_TIMESTAMP`)
    .run(result.health, result.success ? 1 : 0, result.success ? 1 : 0,
         result.success ? null : result.userMessage);
  logSeasonal('connection_test', result.userMessage, { health: result.health, steps: result.steps },
              result.success ? 'info' : 'warn');
  return result;
}

// ---------------------------------------------------------------------------
// Importação
// ---------------------------------------------------------------------------

async function importJobs(options = {}, userId) {
  const started = Date.now();
  const cfg = getConfig();
  const adapter = buildAdapter();
  const profile = candidateProfile(userId);

  if (profile.isEmpty) {
    const e = new Error('Preencha o perfil do Seasonal Jobs antes de importar vagas. Ele é independente dos perfis do Gupy e do Indeed.');
    e.userFacing = true;
    throw e;
  }

  let payload;
  try {
    payload = await adapter.fetchJobs(options);
  } catch (err) {
    db.prepare(`UPDATE seasonal_config SET health_status = ?, last_failure_at = CURRENT_TIMESTAMP,
                last_error = ?, updated_at = CURRENT_TIMESTAMP`).run(err.health || 'ERROR', err.userMessage || err.message);
    db.prepare(`INSERT INTO seasonal_searches (params_json, duration_ms, errors_json) VALUES (?,?,?)`)
      .run(JSON.stringify(options), Date.now() - started, JSON.stringify([err.userMessage || err.message]));
    logSeasonal('import_failed', err.userMessage || err.message, null, 'error');
    const e = new Error(err.userMessage || 'Não foi possível importar as vagas agora.');
    e.userFacing = true;
    throw e;
  }

  const atsInfo = resolveAts(cfg, userId);
  const targetYear = cfg.target_hiring_year || 2027;
  const queueWeights = safeParse(cfg.queue_weights_json, null) || timelineEngine.DEFAULT_QUEUE_WEIGHTS;

  const visaPrefs = [];
  if (cfg.h2a_preference) visaPrefs.push('H-2A');
  if (cfg.h2b_preference) visaPrefs.push('H-2B');

  const metrics = pipeline.run(payload.jobs, {
    tables: { jobs: 'seasonal_jobs', analysis: 'seasonal_job_analysis', matches: 'seasonal_matches' },
    profile,
    thresholds: { topPriority: 90, strongMatch: 80, possibleMatch: 70 },
    filterConfig: {
      excludedOccupations: profile.excludedOccupations,
      minHourlyWage: cfg.min_hourly_wage,
      preferredStates: profile.preferredStates,
      visaPreferences: visaPrefs.length === 2 ? null : visaPrefs
    },
    atsScore: atsInfo.score, atsVersion: atsInfo.version,
    atsComponents: atsInfo.components, atsStatus: atsInfo.status, atsAnalysis: atsInfo.analysis,
    queueWeights,
    force: Boolean(options.force),
    // Sem LLM a análise é barata: pontua TODAS as ordens, em vez de deixar
    // metade sem score (e portanto fora do automático) por falta de
    // sobreposição com as habilidades digitadas. Com LLM ligado, o pré-filtro
    // volta a valer para conter custo.
    prefilter: require('./aiService').status().llmAvailable,

    timelineFor: (job) => timelineEngine.classifyTimeline(job, targetYear),

    findExisting: (job) => db.prepare('SELECT id FROM seasonal_jobs WHERE job_order_id = ?').get(job.job_order_id),

    upsertJob: (job, hash) => {
      upsertJob(job, hash);
      const row = db.prepare('SELECT id FROM seasonal_jobs WHERE job_order_id = ?').get(job.job_order_id);
      return row ? row.id : null;
    },

    loadJob: (id) => db.prepare('SELECT * FROM seasonal_jobs WHERE id = ?').get(id),

    // Grava a classificação de timeline junto da vaga, para ordenação em SQL.
    afterScore: (jobId, job, { timeline }) => {
      if (!timeline) return;
      db.prepare(`UPDATE seasonal_jobs SET timeline_class = ?, timeline_priority = ?, timeline_weight = ?,
                  timeline_label = ?, timeline_explanation = ?, timeline_period = ? WHERE id = ?`)
        .run(timeline.timelineClass, timeline.priority, timeline.weight,
             timeline.label, timeline.explanation, timeline.periodLabel || null, jobId);
    }
  });

  db.prepare(`INSERT INTO seasonal_searches
    (params_json, duration_ms, results_found, new_results, duplicates, filtered_out, analyzed, recommended, errors_json)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    JSON.stringify(options), Date.now() - started, metrics.received, metrics.newJobs,
    metrics.duplicates, metrics.filteredOut + metrics.prefiltered, metrics.analyzed,
    metrics.recommended, JSON.stringify(metrics.errors)
  );

  db.prepare(`UPDATE seasonal_config SET health_status = ?, last_success_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP`).run(payload.fixtureMode ? HEALTH.DEGRADED : HEALTH.HEALTHY);

  logSeasonal('import_completed',
    `${metrics.received} ordem(ns) recebida(s), ${metrics.newJobs} nova(s), ${metrics.analyzed} analisada(s), ${metrics.recommended} recomendada(s).`,
    metrics);

  try {
    require('./seasonalUiService').notify('import', 'Vagas importadas do DOL',
      `${metrics.received} recebida(s) · ${metrics.newJobs} nova(s) · ${metrics.recommended} recomendada(s)`, 'jobs');
  } catch (e) { /* silencioso */ }

  // Enfileiramento automático conforme o modo (spec §29, §30)
  const queued = maybeAutoQueue(userId);

  return Object.assign({}, metrics, {
    fixtureMode: payload.fixtureMode,
    rejected: payload.rejected.length,
    durationMs: Date.now() - started,
    autoQueued: queued
  });
}

function upsertJob(j, hash) {
  db.prepare(`INSERT INTO seasonal_jobs
    (job_order_id, visa_type, job_title, normalized_title, soc_code, employer_name, employer_city,
     employer_state, employer_phone, employer_email, attorney_name, attorney_email, wage_rate,
     wage_unit, start_date, end_date, openings, weekly_hours, housing_provided, transportation_provided,
     duties_description, special_requirements, application_method, application_email, application_url,
     content_hash, raw_json,
     first_seen_feed, last_seen_feed, feed_appearances, feed_key, dol_url, dol_published)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
            ?,?,1,?,?,?)
    ON CONFLICT(job_order_id) DO UPDATE SET
      wage_rate = excluded.wage_rate, openings = excluded.openings,
      start_date = excluded.start_date, end_date = excluded.end_date,
      duties_description = excluded.duties_description,
      special_requirements = excluded.special_requirements,
      application_method = excluded.application_method,
      application_email = excluded.application_email,
      housing_provided = excluded.housing_provided,
      content_hash = excluded.content_hash, raw_json = excluded.raw_json,
      -- A primeira aparição NUNCA é sobrescrita: é ela que diz de que safra a
      -- vaga é. A última avança a cada publicação em que a ordem reaparece, e
      -- é a diferença entre "ainda publicada" e "saiu da janela".
      first_seen_feed = COALESCE(seasonal_jobs.first_seen_feed, excluded.first_seen_feed),
      last_seen_feed = MAX(COALESCE(seasonal_jobs.last_seen_feed, ''), COALESCE(excluded.last_seen_feed, '')),
      feed_appearances = COALESCE(seasonal_jobs.feed_appearances, 0) + 1,
      feed_key = COALESCE(seasonal_jobs.feed_key, excluded.feed_key),
      -- O link é fixo; a publicação só avança (aceite não volta atrás).
      dol_url = COALESCE(excluded.dol_url, seasonal_jobs.dol_url),
      dol_published = MAX(COALESCE(seasonal_jobs.dol_published, 0), COALESCE(excluded.dol_published, 0))`)
    .run(j.job_order_id, j.visa_type, j.job_title, j.normalized_title, j.soc_code, j.employer_name,
         j.employer_city, j.employer_state, j.employer_phone, j.employer_email, j.attorney_name,
         j.attorney_email, j.wage_rate, j.wage_unit, j.start_date, j.end_date, j.openings,
         j.weekly_hours, j.housing_provided, j.transportation_provided, j.duties_description,
         j.special_requirements, j.application_method, j.application_email, j.application_url,
         hash, j.raw_json,
         j.feed_date || null, j.feed_date || null, j.feed_key || null,
         j.dol_url || null, j.dol_published ? 1 : 0);
}

/**
 * As safras presentes no acervo (F4.3).
 *
 * "Safra" não é uma tabela: é uma consulta sobre a data da primeira publicação
 * em que cada ordem apareceu. Agrupar por mês dá exatamente o que o H2BApply
 * chama de planilha — Jan 2026, Jul 2025 — sem duplicar dado.
 */
function seasons() {
  const rows = db.prepare(`
    SELECT substr(first_seen_feed, 1, 7) AS season,
           COUNT(*)                      AS total,
           SUM(CASE WHEN visa_type = 'H-2A' THEN 1 ELSE 0 END) AS h2a,
           SUM(CASE WHEN visa_type = 'H-2B' THEN 1 ELSE 0 END) AS h2b,
           MIN(first_seen_feed)          AS from_feed,
           MAX(last_seen_feed)           AS to_feed
      FROM seasonal_jobs
     WHERE first_seen_feed IS NOT NULL
     GROUP BY season
     ORDER BY season DESC
  `).all();

  const latest = db.prepare('SELECT MAX(last_seen_feed) v FROM seasonal_jobs').get().v || null;

  return {
    latestFeed: latest,
    seasons: rows.map(r => Object.assign({}, r, { label: seasonLabel(r.season) })),
    // Ordens sem marcação vieram antes da F4.3 existir. Declarado, não escondido.
    unmarked: db.prepare('SELECT COUNT(*) v FROM seasonal_jobs WHERE first_seen_feed IS NULL').get().v
  };
}

const MONTHS_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun',
                   'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function seasonLabel(season) {
  if (!season || season.length < 7) return 'sem data';
  const [y, m] = season.split('-');
  const idx = parseInt(m, 10) - 1;
  return `${MONTHS_PT[idx] || m}/${y}`;
}

/** ATS do currículo Seasonal. Nunca usa currículo de outra plataforma (§1E). */
function resolveAts(cfg, userId) {
  return atsService.resolveEnvironmentAts(PLATFORM, COUNTRY, { userId });
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

function listJobs({ view = 'all', visaType = null, applicationMethod = null, only2027 = false,
                    state = null, minFit = null, limit = 200, offset = 0,
                    season = null, stillPublished = false,
                    // --- filtros mestres do front H2B (F2.1) ---
                    q = null, states = null, city = null, titles = null,
                    minWage = null, minOpenings = null, startMonths = null,
                    emailOnly = false, excludeApplied = false, housing = null, sort = null } = {}) {
  const where = [];
  const params = [];

  // Busca livre: título, empregador, cidade, número da ordem (F2.3).
  if (q && String(q).trim()) {
    const like = `%${String(q).trim()}%`;
    where.push('(j.job_title LIKE ? OR j.employer_name LIKE ? OR j.employer_city LIKE ? OR j.job_order_id LIKE ? OR j.normalized_title LIKE ?)');
    params.push(like, like, like, like, like);
  }
  const stateList = splitList(states).map(x => String(x).toUpperCase()).filter(x => /^[A-Z]{2}$/.test(x));
  if (stateList.length) {
    where.push(`j.employer_state IN (${stateList.map(() => '?').join(',')})`);
    params.push(...stateList);
  }
  if (city && String(city).trim()) { where.push('j.employer_city LIKE ?'); params.push(`%${String(city).trim()}%`); }
  const titleList = splitList(titles);
  if (titleList.length) {
    where.push(`(${titleList.map(() => 'j.job_title LIKE ?').join(' OR ')})`);
    params.push(...titleList.map(t => `%${t}%`));
  }
  if (minWage !== null && minWage !== '' && !isNaN(Number(minWage))) { where.push('j.wage_rate >= ?'); params.push(Number(minWage)); }
  if (minOpenings !== null && minOpenings !== '' && !isNaN(Number(minOpenings))) { where.push('j.openings >= ?'); params.push(Number(minOpenings)); }
  const months = splitList(startMonths).map(m => String(m).padStart(2, '0')).filter(m => /^(0[1-9]|1[0-2])$/.test(m));
  if (months.length) {
    where.push(`substr(j.start_date, 6, 2) IN (${months.map(() => '?').join(',')})`);
    params.push(...months);
  }
  if (emailOnly) where.push("j.application_method = 'EMAIL' AND j.application_email IS NOT NULL AND j.application_email <> ''");
  if (excludeApplied) where.push('ap.id IS NULL');
  if (housing === true || housing === 'true' || housing === '1') where.push('j.housing_provided = 1');

  // --- Safra e janela de publicação (F4.3) ---
  if (season) {
    where.push('substr(j.first_seen_feed, 1, 7) = ?');
    params.push(String(season));
  }
  if (stillPublished) {
    // "Ainda publicada" = apareceu na publicação mais recente que já importamos.
    where.push('j.last_seen_feed = (SELECT MAX(last_seen_feed) FROM seasonal_jobs)');
  }

  if (view === 'recommended') where.push('d.id IS NULL', 'm.opportunity_score >= 70');
  else if (view === 'saved') where.push('s.id IS NOT NULL');
  else if (view === 'discarded') where.push('d.id IS NOT NULL');
  else if (view === 'applied') where.push('ap.id IS NOT NULL');
  else if (view === 'manual_action') where.push("d.id IS NULL", "j.application_method IN ('PHONE','WEBSITE','OTHER','UNKNOWN')");
  else where.push('d.id IS NULL');

  // Parametrizado — sem interpolação de entrada do usuário no SQL.
  if (visaType && visaType !== 'all') { where.push('j.visa_type = ?'); params.push(String(visaType)); }
  if (applicationMethod && applicationMethod !== 'all') { where.push('j.application_method = ?'); params.push(String(applicationMethod)); }
  if (state) { where.push('j.employer_state = ?'); params.push(String(state).toUpperCase()); }
  if (only2027) { where.push("j.timeline_class = 'TARGET_2027'"); }
  if (minFit !== null && minFit !== '' && !isNaN(Number(minFit))) { where.push('m.fit_score >= ?'); params.push(Number(minFit)); }

  const SORTS = {
    wage: 'j.wage_rate DESC NULLS LAST',
    start: 'j.start_date ASC NULLS LAST',
    openings: 'j.openings DESC NULLS LAST',
    recent: 'j.first_seen_feed DESC NULLS LAST, j.id DESC'
  };
  const order = SORTS[sort] ? SORTS[sort]
              : view === 'saved' ? 's.saved_at DESC'
              : view === 'discarded' ? 'd.discarded_at DESC'
              : view === 'applied' ? 'ap.sent_at DESC'
              : 'm.queue_priority DESC NULLS LAST, j.timeline_weight DESC NULLS LAST, m.opportunity_score DESC NULLS LAST';

  const rows = db.prepare(`
    SELECT j.*, m.fit_score, m.ats_score, m.opportunity_score, m.category, m.queue_priority,
           m.fit_components_json, m.fit_evidence_json, m.warnings_json, m.queue_breakdown_json,
           a.concerns_json,
           p.id AS package_id, p.validation_status, p.requires_review,
           q.status AS queue_status,
           CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END AS is_saved,
           CASE WHEN d.id IS NOT NULL THEN 1 ELSE 0 END AS is_discarded,
           CASE WHEN ap.id IS NOT NULL THEN 1 ELSE 0 END AS is_applied
    FROM seasonal_jobs j
    LEFT JOIN seasonal_matches m ON j.id = m.job_id
    LEFT JOIN seasonal_job_analysis a ON j.id = a.job_id
    LEFT JOIN seasonal_saved_jobs s ON j.id = s.job_id
    LEFT JOIN seasonal_discarded_jobs d ON j.id = d.job_id
    LEFT JOIN seasonal_application_packages p ON j.id = p.job_id
    LEFT JOIN seasonal_email_queue q ON p.id = q.package_id
    LEFT JOIN seasonal_applications ap ON j.id = ap.seasonal_job_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `).all(...params, Number(limit), Number(offset));

  return rows.map(shapeJob);
}

/**
 * Lugares e títulos disponíveis para os filtros mestres (F2.1, F2.4).
 * Conta só o que ainda não foi descartado — filtro que oferece o que o
 * usuário jogou fora não ajuda ninguém.
 */
function facets() {
  const states = db.prepare(`
    SELECT j.employer_state AS state, COUNT(*) AS total,
           SUM(CASE WHEN j.visa_type = 'H-2A' THEN 1 ELSE 0 END) AS h2a,
           SUM(CASE WHEN j.visa_type = 'H-2B' THEN 1 ELSE 0 END) AS h2b
    FROM seasonal_jobs j
    LEFT JOIN seasonal_discarded_jobs d ON j.id = d.job_id
    WHERE d.id IS NULL AND j.employer_state IS NOT NULL AND j.employer_state <> ''
    GROUP BY j.employer_state ORDER BY total DESC`).all();
  const cities = db.prepare(`
    SELECT j.employer_state AS state, j.employer_city AS city, COUNT(*) AS total
    FROM seasonal_jobs j
    LEFT JOIN seasonal_discarded_jobs d ON j.id = d.job_id
    WHERE d.id IS NULL AND j.employer_city IS NOT NULL AND j.employer_city <> ''
    GROUP BY j.employer_state, j.employer_city ORDER BY total DESC LIMIT 400`).all();
  const titles = db.prepare(`
    SELECT COALESCE(NULLIF(j.normalized_title, ''), j.job_title) AS title, COUNT(*) AS total,
           SUM(CASE WHEN j.visa_type = 'H-2A' THEN 1 ELSE 0 END) AS h2a,
           SUM(CASE WHEN j.visa_type = 'H-2B' THEN 1 ELSE 0 END) AS h2b
    FROM seasonal_jobs j
    LEFT JOIN seasonal_discarded_jobs d ON j.id = d.job_id
    WHERE d.id IS NULL
    GROUP BY title ORDER BY total DESC LIMIT 300`).all();
  const months = db.prepare(`
    SELECT substr(j.start_date, 6, 2) AS month, COUNT(*) AS total
    FROM seasonal_jobs j
    LEFT JOIN seasonal_discarded_jobs d ON j.id = d.job_id
    WHERE d.id IS NULL AND length(j.start_date) >= 7
    GROUP BY month ORDER BY month`).all();
  const totals = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN j.visa_type = 'H-2A' THEN 1 ELSE 0 END) AS h2a,
           SUM(CASE WHEN j.visa_type = 'H-2B' THEN 1 ELSE 0 END) AS h2b,
           SUM(CASE WHEN j.application_method = 'EMAIL' AND j.application_email <> '' THEN 1 ELSE 0 END) AS withEmail,
           MAX(j.last_seen_feed) AS lastFeed
    FROM seasonal_jobs j
    LEFT JOIN seasonal_discarded_jobs d ON j.id = d.job_id
    WHERE d.id IS NULL`).get();
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM seasonal_jobs j LEFT JOIN seasonal_discarded_jobs d ON j.id=d.job_id LEFT JOIN seasonal_matches m ON j.id=m.job_id WHERE d.id IS NULL AND m.opportunity_score >= 70) AS recommended,
      (SELECT COUNT(*) FROM seasonal_saved_jobs) AS saved,
      (SELECT COUNT(DISTINCT seasonal_job_id) FROM seasonal_applications) AS applied`).get();
  return { states, cities, titles, months, totals: Object.assign(totals, counts) };
}

/** Sugestões para a caixa de busca (F2.3): empresas, títulos, cidades, ordens. */
function suggest(q, limit = 12) {
  const term = String(q || '').trim();
  if (term.length < 2) return [];
  const like = `%${term}%`;
  const out = [];
  const push = (kind, rows) => rows.forEach(r => out.push(Object.assign({ kind }, r)));
  push('employer', db.prepare(`SELECT employer_name AS label, COUNT(*) AS total FROM seasonal_jobs
      WHERE employer_name LIKE ? GROUP BY employer_name ORDER BY total DESC LIMIT ?`).all(like, limit));
  push('title', db.prepare(`SELECT job_title AS label, COUNT(*) AS total FROM seasonal_jobs
      WHERE job_title LIKE ? GROUP BY job_title ORDER BY total DESC LIMIT ?`).all(like, limit));
  push('city', db.prepare(`SELECT employer_city || ', ' || employer_state AS label, COUNT(*) AS total FROM seasonal_jobs
      WHERE employer_city LIKE ? GROUP BY employer_city, employer_state ORDER BY total DESC LIMIT ?`).all(like, limit));
  push('order', db.prepare(`SELECT job_order_id AS label, job_title AS meta, id FROM seasonal_jobs
      WHERE job_order_id LIKE ? LIMIT ?`).all(like, 5));
  return out.slice(0, limit * 3);
}

function getJob(id) {
  const row = db.prepare(`
    SELECT j.*, m.*, a.concerns_json, a.requirements_json,
           -- m.* traz m.id e sobrescreve j.id; o id da vaga volta por último.
           j.id AS id, j.content_hash AS content_hash, j.collected_at AS collected_at,
           p.id AS package_id, p.validation_status, p.validation_json, p.requires_review,
           p.review_reasons_json, p.email_subject, p.email_body, p.cover_letter,
           p.selected_resume_id, p.selected_resume_reason, p.recipient_email AS package_recipient,
           q.status AS queue_status, q.attempts, q.last_error, q.next_attempt_at,
           CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END AS is_saved,
           CASE WHEN d.id IS NOT NULL THEN 1 ELSE 0 END AS is_discarded,
           CASE WHEN ap.id IS NOT NULL THEN 1 ELSE 0 END AS is_applied
    FROM seasonal_jobs j
    LEFT JOIN seasonal_matches m ON j.id = m.job_id
    LEFT JOIN seasonal_job_analysis a ON j.id = a.job_id
    LEFT JOIN seasonal_saved_jobs s ON j.id = s.job_id
    LEFT JOIN seasonal_discarded_jobs d ON j.id = d.job_id
    LEFT JOIN seasonal_application_packages p ON j.id = p.job_id
    LEFT JOIN seasonal_email_queue q ON p.id = q.package_id
    LEFT JOIN seasonal_applications ap ON j.id = ap.seasonal_job_id
    WHERE j.id = ?
  `).get(Number(id));

  if (!row) return null;
  const shaped = shapeJob(row);
  shaped.requirements = safeParse(row.requirements_json, []);
  shaped.emailHistory = db.prepare(`SELECT * FROM seasonal_email_events WHERE job_id = ? ORDER BY id DESC LIMIT 30`).all(Number(id));
  return shaped;
}

function shapeJob(r) {
  return Object.assign({}, r, {
    fitComponents: safeParse(r.fit_components_json, {}),
    fitEvidence: safeParse(r.fit_evidence_json, {}),
    concerns: safeParse(r.concerns_json, []),
    warnings: safeParse(r.warnings_json, []),
    queueBreakdown: safeParse(r.queue_breakdown_json, null),
    reviewReasons: safeParse(r.review_reasons_json, []),
    categoryLabel: r.category ? scoreEngine.CATEGORY_LABEL[r.category] : null,
    timeline: r.timeline_class ? {
      timelineClass: r.timeline_class, priority: r.timeline_priority,
      weight: r.timeline_weight, label: r.timeline_label,
      explanation: r.timeline_explanation, periodLabel: r.timeline_period
    } : null,
    isEmailEligible: r.application_method === 'EMAIL' && Boolean(r.application_email)
  });
}

function saveJob(id, notes = '') {
  db.prepare('DELETE FROM seasonal_discarded_jobs WHERE job_id = ?').run(id);
  db.prepare(`INSERT INTO seasonal_saved_jobs (job_id, notes) VALUES (?,?)
              ON CONFLICT(job_id) DO UPDATE SET notes = excluded.notes`).run(id, notes);
  logSeasonal('job_saved', `Ordem #${id} salva.`, null, 'info', { entityId: String(id) });
  return { success: true };
}

function discardJob(id, reason = '') {
  db.prepare('DELETE FROM seasonal_saved_jobs WHERE job_id = ?').run(id);
  db.prepare(`INSERT INTO seasonal_discarded_jobs (job_id, reason) VALUES (?,?)
              ON CONFLICT(job_id) DO UPDATE SET reason = excluded.reason`).run(id, reason);
  logSeasonal('job_discarded', `Ordem #${id} descartada.`, { reason }, 'info', { entityId: String(id) });
  return { success: true };
}

/**
 * Fila ordenada com explicação (spec §34).
 * Recalcula a prioridade em memória para refletir pesos alterados na configuração.
 */
function rankedCandidates(limit = 100) {
  const cfg = getConfig();
  const weights = safeParse(cfg.queue_weights_json, null) || timelineEngine.DEFAULT_QUEUE_WEIGHTS;

  const rows = db.prepare(`
    SELECT j.id, j.job_order_id, j.job_title, j.employer_name, j.employer_state, j.wage_rate,
           j.visa_type, j.employer_city, j.openings, j.housing_provided, j.normalized_title,
           j.application_method, j.application_email, j.timeline_class, j.timeline_priority,
           j.timeline_weight, j.timeline_label, j.timeline_explanation, j.timeline_period,
           m.fit_score, m.ats_score, m.opportunity_score
    FROM seasonal_jobs j
    JOIN seasonal_matches m ON j.id = m.job_id
    LEFT JOIN seasonal_discarded_jobs d ON j.id = d.job_id
    LEFT JOIN seasonal_applications ap ON j.id = ap.seasonal_job_id
    WHERE d.id IS NULL AND ap.id IS NULL
      AND j.application_method = 'EMAIL' AND j.application_email IS NOT NULL
    LIMIT ?
  `).all(Number(limit));

  const items = rows.map(r => ({
    id: r.id, jobOrderId: r.job_order_id, title: r.job_title,
    employer: r.employer_name, state: r.employer_state, wage: r.wage_rate,
    visaType: r.visa_type, city: r.employer_city, openings: r.openings,
    housing: Boolean(r.housing_provided), normalizedTitle: r.normalized_title,
    fitScore: r.fit_score, atsScore: r.ats_score, opportunityScore: r.opportunity_score,
    completeness: r.application_email ? 100 : 0,
    freshness: 60,
    timeline: r.timeline_class ? {
      timelineClass: r.timeline_class, priority: r.timeline_priority, weight: r.timeline_weight,
      label: r.timeline_label, explanation: r.timeline_explanation, periodLabel: r.timeline_period
    } : null
  }));

  return timelineEngine.rankQueue(items, weights);
}

/**
 * Enfileiramento automático conforme o modo de autonomia (spec §29, §30).
 * MANUAL nunca enfileira sozinho. ASSISTED e AUTOMATIC respeitam os limiares.
 */
function maybeAutoQueue(userId) {
  const cfg = getConfig();
  if (cfg.automation_mode === 'MANUAL') return { queued: 0, mode: 'MANUAL', reason: 'Modo manual: nada é preparado sem sua ação.' };

  // Escolhas do assistente de envio automático (front H2B) são filtros
  // DUROS, não só peso de score: visto, estados, cargos e salário mínimo.
  // O que o usuário não marcou, o robô não toca.
  const wantVisa = [];
  if (cfg.h2a_preference) wantVisa.push('H-2A');
  if (cfg.h2b_preference) wantVisa.push('H-2B');
  const wantStates = splitList(cfg.preferred_states).map(x => x.toUpperCase());
  const wantTitles = splitList(cfg.preferred_occupations).map(x => x.toLowerCase());
  const minWage = Number(cfg.min_hourly_wage) || 0;

  const ranked = rankedCandidates(1000).filter(i =>
    (wantVisa.length === 0 || wantVisa.includes(i.visaType)) &&
    (wantStates.length === 0 || wantStates.includes(String(i.state || '').toUpperCase())) &&
    (wantTitles.length === 0 || wantTitles.some(t => String(i.title || '').toLowerCase().includes(t) || String(i.normalizedTitle || '').toLowerCase().includes(t))) &&
    (minWage <= 0 || Number(i.wage || 0) >= minWage) &&
    (i.fitScore || 0) >= cfg.auto_queue_fit_threshold &&
    (i.opportunityScore || 0) >= cfg.auto_queue_opportunity_threshold &&
    (i.atsScore === null || i.atsScore >= cfg.auto_queue_ats_threshold)
  );

  const emailService = require('./seasonalEmailService');
  let queued = 0;
  const errors = [];

  for (const item of ranked) {
    const already = db.prepare('SELECT id FROM seasonal_application_packages WHERE job_id = ?').get(item.id);
    if (already) continue;
    try {
      emailService.prepareApplicationPackage(item.id, { auto: true, userId });
      queued++;
    } catch (e) {
      errors.push({ job: item.jobOrderId, error: e.message });
    }
  }

  if (queued) {
    logSeasonal('auto_queue', `${queued} candidatura(s) preparada(s) automaticamente no modo ${cfg.automation_mode}.`,
                { mode: cfg.automation_mode, thresholds: {
                  fit: cfg.auto_queue_fit_threshold,
                  ats: cfg.auto_queue_ats_threshold,
                  opportunity: cfg.auto_queue_opportunity_threshold } });
  }

  return { queued, mode: cfg.automation_mode, errors };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function dashboard(userId) {
  const cfg = getConfig();
  const emailService = require('./seasonalEmailService');
  const quota = emailService.getQuotaStatus();
  const one = (sql, ...p) => db.prepare(sql).get(...p).v;

  const total = one('SELECT COUNT(*) v FROM seasonal_jobs');
  const target2027 = one("SELECT COUNT(*) v FROM seasonal_jobs WHERE timeline_class = 'TARGET_2027'");
  const recommended = one('SELECT COUNT(*) v FROM seasonal_matches WHERE opportunity_score >= 80');
  const queued = one("SELECT COUNT(*) v FROM seasonal_email_queue WHERE status IN ('QUEUED','DEFERRED')");
  const failures = one("SELECT COUNT(*) v FROM seasonal_email_queue WHERE status = 'FAILED'");
  const manualAction = one("SELECT COUNT(*) v FROM seasonal_jobs WHERE application_method IN ('PHONE','WEBSITE','OTHER','UNKNOWN')");
  const unknownDate = one("SELECT COUNT(*) v FROM seasonal_jobs WHERE timeline_class = 'UNKNOWN_DATE' OR timeline_class IS NULL");
  const h2a = one("SELECT COUNT(*) v FROM seasonal_jobs WHERE visa_type = 'H-2A'");
  const h2b = one("SELECT COUNT(*) v FROM seasonal_jobs WHERE visa_type = 'H-2B'");
  const pendingReview = one("SELECT COUNT(*) v FROM seasonal_application_packages WHERE requires_review = 1 AND approved_at IS NULL");

  const atsInfo = resolveAts(cfg, userId);

  const attention = [];
  if (cfg.pause_email_sending) {
    attention.push({ severity: 'HIGH', title: 'Envio de e-mails pausado', detail: 'Nenhum e-mail sai do sistema enquanto a pausa estiver ativa. A descoberta e a análise continuam.', action: 'pause' });
  }
  if (!cfg.gmail_connected) {
    // Distingue as duas causas: sem credencial do servidor não existe botão a
    // clicar, e mandar "conecte a conta" nesse caso só produz um beco sem saída.
    const creds = require('./googleCredentialsService').status();
    attention.push(creds.configured
      ? { severity: 'HIGH', title: 'Gmail não conectado',
          detail: 'Entre com sua conta do Google para habilitar o envio das candidaturas.', action: 'gmail' }
      : { severity: 'HIGH', title: 'Login do Google indisponível',
          detail: 'Este servidor ainda não tem um cliente OAuth do Google. Configure-o em Ajustes — leva cerca de dois minutos e é feito uma única vez.',
          action: 'gmail' });
  }
  if (cfg.health_status === 'NOT_CONFIGURED' || cfg.health_status === 'DEGRADED') {
    attention.push({ severity: 'MEDIUM', title: 'Fonte do DOL não configurada', detail: 'As ordens exibidas são dados de exemplo. Configure a URL do feed para importar ordens reais.', action: 'configure' });
  }
  if (pendingReview > 0) {
    attention.push({ severity: 'MEDIUM', title: `${pendingReview} candidatura(s) aguardando revisão`, detail: 'Elas não serão enviadas até você aprovar.', action: 'review' });
  }
  if (failures > 0) {
    attention.push({ severity: 'MEDIUM', title: `${failures} envio(s) com falha`, detail: 'Consulte os motivos na fila de e-mails.', action: 'queue' });
  }
  if (store(userId).listResumes({ docType: 'resume' }).length === 0) {
    attention.push({
      severity: 'HIGH',
      title: 'Nenhum currículo no Seasonal Jobs',
      detail: 'Sem currículo neste ambiente nenhuma candidatura pode ser enviada. Currículos do Gupy ou do Indeed não são reutilizados aqui.',
      action: 'documents'
    });
  }

  return {
    kpis: {
      target2027, recommended, queued,
      sentToday: quota.countSent, dailyLimit: quota.maxLimit, remaining: quota.remaining,
      failures
    },
    secondary: { total, h2a, h2b, manualAction, unknownDate, pendingReview },
    ats: { score: atsInfo.score, status: atsInfo.status, version: atsInfo.version, resume: atsInfo.resume },
    automation: {
      mode: cfg.automation_mode,
      reviewMode: cfg.email_review_mode,
      paused: Boolean(cfg.pause_email_sending),
      targetYear: cfg.target_hiring_year,
      thresholds: {
        fit: cfg.auto_queue_fit_threshold,
        ats: cfg.auto_queue_ats_threshold,
        opportunity: cfg.auto_queue_opportunity_threshold
      }
    },
    integration: {
      health: cfg.health_status, configured: Boolean(cfg.dol_feed_url),
      lastSuccess: cfg.last_success_at, lastFailure: cfg.last_failure_at, lastError: cfg.last_error,
      gmailConnected: Boolean(cfg.gmail_connected), gmailUser: cfg.gmail_user
    },
    attention,
    quota,
    top2027: listJobs({ view: 'recommended', only2027: true, limit: 5 }),
    onboarding: { step: cfg.onboarding_step, done: Boolean(cfg.onboarding_done) }
  };
}

function logs(limit = 100) {
  return db.prepare('SELECT * FROM seasonal_logs ORDER BY id DESC LIMIT ?').all(Number(limit));
}

function searchHistory(limit = 30) {
  return db.prepare('SELECT * FROM seasonal_searches ORDER BY id DESC LIMIT ?').all(Number(limit));
}

// ---------------------------------------------------------------------------

function safeParse(s, f) { try { return JSON.parse(s || ''); } catch (e) { return f; } }
function splitList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

module.exports = {
  COUNTRY, PLATFORM, AUTOMATION_MODES, REVIEW_MODES,
  getConfig, updateConfig, candidateProfile, buildAdapter,
  testConnection, importJobs,
  listJobs, getJob, saveJob, discardJob, facets, suggest,
  rankedCandidates, maybeAutoQueue,
  dashboard, logs, searchHistory, resolveAts, store,
  seasons, seasonLabel
};
