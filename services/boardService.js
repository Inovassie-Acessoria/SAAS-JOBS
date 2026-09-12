/**
 * Serviço de produto para Gupy e Indeed (spec §26, §27).
 *
 * Gupy e Indeed compartilham a MESMA LÓGICA e NENHUM DADO. A fábrica abaixo
 * recebe o descritor de tabelas de cada produto; nenhuma consulta cruza a
 * fronteira. Cada país (BR | US) tem sua própria configuração, seus próprios
 * limiares e seu próprio histórico dentro do produto.
 */

const { db, logGupy, logIndeed } = require('../config/database');
const pipeline = require('./pipeline');
const candidate = require('./candidateService');
const atsService = require('./atsService');
const scoreEngine = require('../core/match/scoreEngine');
const { GupyAdapter, IndeedAdapter, HEALTH } = require('./adapters/mcpClient');
const fixtures = require('./adapters/fixtures');

function normCountry(c) {
  const u = String(c || '').toUpperCase();
  return u === 'US' ? 'US' : 'BR';
}

function createBoardService(spec) {
  const T = spec.tables;
  const log = spec.log;

  // ---------------------------------------------------------------- config

  function getCountryConfig(country) {
    const c = normCountry(country);
    let row = db.prepare(`SELECT * FROM ${T.countryConfig} WHERE country = ?`).get(c);
    if (!row) {
      db.prepare(`INSERT INTO ${T.countryConfig} (country) VALUES (?)`).run(c);
      row = db.prepare(`SELECT * FROM ${T.countryConfig} WHERE country = ?`).get(c);
    }
    return row;
  }

  function updateCountryConfig(country, data) {
    const c = normCountry(country);
    const cur = getCountryConfig(c);
    const v = (k, d) => (data[k] !== undefined && data[k] !== '' ? data[k] : cur[k] !== undefined ? cur[k] : d);

    db.prepare(`UPDATE ${T.countryConfig} SET
        target_role = ?, career_track = ?, default_resume_id = ?,
        min_salary_month = ?, min_salary_year = ?, workplace_preference = ?,
        fit_threshold = ?, ats_threshold = ?,
        top_priority_threshold = ?, strong_match_threshold = ?, possible_match_threshold = ?,
        onboarding_step = ?, onboarding_done = ?, updated_at = CURRENT_TIMESTAMP
      WHERE country = ?`).run(
      String(v('target_role', '')), String(v('career_track', 'geral')),
      data.default_resume_id !== undefined ? (data.default_resume_id || null) : cur.default_resume_id,
      numOrNull(v('min_salary_month', null)), numOrNull(v('min_salary_year', null)),
      String(v('workplace_preference', 'remote')),
      int(v('fit_threshold', 70)), int(v('ats_threshold', 70)),
      int(v('top_priority_threshold', 90)), int(v('strong_match_threshold', 80)), int(v('possible_match_threshold', 70)),
      int(v('onboarding_step', 0)), v('onboarding_done', 0) ? 1 : 0,
      c
    );
    log('config_updated', `Configuração de ${spec.label} ${c} atualizada.`, null, 'info', { country: c });
    return getCountryConfig(c);
  }

  function thresholdsFor(country) {
    const cfg = getCountryConfig(country);
    return {
      topPriority: cfg.top_priority_threshold,
      strongMatch: cfg.strong_match_threshold,
      possibleMatch: cfg.possible_match_threshold
    };
  }

  // ------------------------------------------------------------ integração

  function getIntegration(country) {
    const c = normCountry(country);
    let row = db.prepare(`SELECT * FROM ${T.integration} WHERE country = ?`).get(c);
    if (!row) {
      db.prepare(`INSERT INTO ${T.integration} (country) VALUES (?)`).run(c);
      row = db.prepare(`SELECT * FROM ${T.integration} WHERE country = ?`).get(c);
    }
    return row;
  }

  /**
   * Escolhe COMO este ambiente descobre vagas (§45, §46).
   *
   * Precedência deliberada, da fonte mais confiável para a menos:
   *
   *   1. MCP oficial   — dado estruturado, é o que a §45 manda preferir
   *   2. navegador     — lê a listagem pública quando não há endpoint algum
   *   3. fixture       — nada configurado; dados de exemplo, sempre rotulados
   *
   * O navegador entra em segundo lugar, não em primeiro: ele é mais frágil
   * (o site muda o HTML e a leitura quebra) e mais lento. Mas entre um dado
   * real frágil e nenhum dado, o real ganha — sem ele, Gupy e Indeed
   * simplesmente não descobrem vaga nenhuma.
   */
  function discoveryMode(country) {
    const c = normCountry(country);
    const cfg = getIntegration(c);
    const envUrl = process.env[`${spec.key.toUpperCase()}_MCP_URL`] || '';
    if (cfg.mcp_url || envUrl) return 'mcp';

    const flag = String(process.env[`${spec.key.toUpperCase()}_BROWSER_DISCOVERY`] || '').toLowerCase();
    const setting = (() => {
      try {
        const r = db.prepare('SELECT value FROM core_system_settings WHERE key = ?')
          .get(`${spec.key}_browser_discovery`);
        return r && r.value === '1';
      } catch (e) { return false; }
    })();

    return (flag === 'true' || setting) ? 'browser' : 'fixture';
  }

  function buildAdapter(country) {
    const c = normCountry(country);
    const cfg = getIntegration(c);
    const envUrl = process.env[`${spec.key.toUpperCase()}_MCP_URL`] || '';
    const envToken = process.env[`${spec.key.toUpperCase()}_MCP_TOKEN`] || '';
    const url = cfg.mcp_url || envUrl;

    if (discoveryMode(c) === 'browser') {
      const { BrowserAdapter } = require('./adapters/browserAdapter');
      return new BrowserAdapter({
        provider: spec.key,
        country: c,
        maxPages: parseInt(process.env.BROWSER_MAX_PAGES || '3', 10),
        onProgress: (p) => log('browser_discovery', p.message, p, 'info', { country: c })
      });
    }

    return new spec.Adapter({
      url,
      token: envToken,
      // Sem URL configurada, opera em modo fixture — sempre rotulado.
      fixtureMode: !url,
      fixtures: {
        search_jobs: (args) => ({ jobs: spec.fixtureJobs({ country: c, keywords: args.keywords }) })
      }
    });
  }

  async function testConnection(country) {
    const c = normCountry(country);
    const adapter = buildAdapter(c);
    const result = await adapter.testConnection();

    db.prepare(`UPDATE ${T.integration} SET
        is_connected = ?, health_status = ?, auth_status = ?, tools_json = ?,
        last_success_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_success_at END,
        last_failure_at = CASE WHEN ? = 0 THEN CURRENT_TIMESTAMP ELSE last_failure_at END,
        last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE country = ?`).run(
      result.success ? 1 : 0, result.health,
      result.health === HEALTH.REQUIRES_ATTENTION ? 'EXPIRED' : (result.success ? 'OK' : 'UNKNOWN'),
      JSON.stringify(result.tools || []),
      result.success ? 1 : 0, result.success ? 1 : 0,
      result.success ? null : result.userMessage,
      c
    );

    log('connection_test', result.userMessage, { health: result.health, steps: result.steps },
        result.success ? 'info' : 'warn', { country: c });

    return result;
  }

  function disconnect(country) {
    const c = normCountry(country);
    db.prepare(`UPDATE ${T.integration} SET mcp_url = '', is_connected = 0,
                health_status = 'DISCONNECTED', auth_status = 'UNKNOWN', tools_json = NULL,
                updated_at = CURRENT_TIMESTAMP WHERE country = ?`).run(c);
    log('disconnected', `Integração ${spec.label} ${c} desconectada.`, null, 'info', { country: c });
    return getIntegration(c);
  }

  function configureIntegration(country, { mcp_url }) {
    const c = normCountry(country);
    db.prepare(`UPDATE ${T.integration} SET mcp_url = ?, updated_at = CURRENT_TIMESTAMP WHERE country = ?`)
      .run(String(mcp_url || '').trim(), c);
    return getIntegration(c);
  }

  // ------------------------------------------------------------------ busca

  async function search(country, options = {}, userId) {
    const c = normCountry(country);
    const started = Date.now();
    const adapter = buildAdapter(c);
    const cfg = getCountryConfig(c);
    const store = candidate.environment(spec.key, c, userId);
    const profile = store.getProfile();

    if (profile.isEmpty) {
      const e = new Error(`Preencha o perfil de ${store.label} antes de buscar vagas. Cada plataforma e país tem o próprio perfil — nada é reaproveitado de outro ambiente.`);
      e.userFacing = true;
      throw e;
    }

    let payload;
    try {
      payload = await adapter.searchJobs({
        keywords: options.keywords || cfg.target_role || '',
        country: c,
        location: options.location || '',
        remote: options.remote
      });
    } catch (err) {
      db.prepare(`UPDATE ${T.integration} SET health_status = ?, last_failure_at = CURRENT_TIMESTAMP,
                  last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE country = ?`)
        .run(err.health || 'ERROR', err.userMessage || err.message, c);
      db.prepare(`INSERT INTO ${T.searches} (country, params_json, duration_ms, errors_json)
                  VALUES (?,?,?,?)`).run(c, JSON.stringify(options), Date.now() - started,
                  JSON.stringify([err.userMessage || err.message]));
      log('search_failed', err.userMessage || err.message, null, 'error', { country: c });
      const e = new Error(err.userMessage || 'Não foi possível buscar vagas agora.');
      e.userFacing = true;
      e.health = err.health;
      throw e;
    }

    const rawJobs = (payload && (payload.jobs || payload.results || payload)) || [];
    const list = Array.isArray(rawJobs) ? rawJobs : [];

    // ATS do currículo selecionado para este país (spec §18)
    const atsInfo = resolveAts(c, cfg, userId);

    const metrics = pipeline.run(list.map(j => spec.normalize(j, c)), {
      tables: T,
      profile: buildCandidateForCountry(profile, cfg, c),
      filterConfig: buildFilters(cfg, options, c),
      thresholds: thresholdsFor(c),
      atsScore: atsInfo.score,
      atsVersion: atsInfo.version,
      atsComponents: atsInfo.components,
      atsStatus: atsInfo.status,
      atsAnalysis: atsInfo.analysis,
      force: Boolean(options.force),

      findExisting: (job) => db.prepare(`SELECT id FROM ${T.jobs} WHERE country = ? AND external_id = ?`)
        .get(c, job.external_id),

      upsertJob: (job, hash) => {
        spec.upsert(job, c, hash);
        const row = db.prepare(`SELECT id FROM ${T.jobs} WHERE country = ? AND external_id = ?`).get(c, job.external_id);
        return row ? row.id : null;
      },

      loadJob: (id) => db.prepare(`SELECT * FROM ${T.jobs} WHERE id = ?`).get(id)
    });

    db.prepare(`INSERT INTO ${T.searches}
      (country, params_json, duration_ms, results_found, new_results, duplicates, filtered_out, analyzed, recommended, errors_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      c, JSON.stringify(options), Date.now() - started,
      metrics.received, metrics.newJobs, metrics.duplicates,
      metrics.filteredOut + metrics.prefiltered, metrics.analyzed, metrics.recommended,
      JSON.stringify(metrics.errors)
    );

    db.prepare(`UPDATE ${T.integration} SET last_search_at = CURRENT_TIMESTAMP,
                health_status = ?, updated_at = CURRENT_TIMESTAMP WHERE country = ?`)
      .run(adapter.fixtureMode ? HEALTH.DEGRADED : HEALTH.HEALTHY, c);

    log('search_completed',
      `${metrics.received} vaga(s) recebida(s), ${metrics.newJobs} nova(s), ${metrics.analyzed} analisada(s), ${metrics.recommended} recomendada(s).`,
      metrics, 'info', { country: c });

    return Object.assign({}, metrics, {
      fixtureMode: adapter.fixtureMode,
      durationMs: Date.now() - started
    });
  }

  /**
   * ATS do currículo ativo DESTE ambiente. Sem currículo aqui, o score é nulo —
   * nunca o de outra plataforma ou de outro país (spec §1E).
   */
  function resolveAts(country, cfg, userId) {
    return atsService.resolveEnvironmentAts(spec.key, normCountry(country), {
      careerTrack: cfg.career_track, userId
    });
  }

  function buildCandidateForCountry(profile, cfg, country) {
    return Object.assign({}, profile, {
      targetRole: cfg.target_role || profile.headline,
      workplacePreference: cfg.workplace_preference || profile.workplacePreference,
      minSalaryMonth: cfg.min_salary_month,
      minSalaryYear: cfg.min_salary_year
    });
  }

  function buildFilters(cfg, options, country) {
    return {
      remoteOnly: (options.remote === true) || cfg.workplace_preference === 'remote_only',
      minSalaryMonth: country === 'BR' ? cfg.min_salary_month : null,
      minSalaryYear: country === 'US' ? cfg.min_salary_year : null,
      requiredTerms: splitList(options.requiredTerms),
      excludedTerms: splitList(options.excludedTerms)
    };
  }

  // ------------------------------------------------------------------ vagas

  function listJobs(country, { view = 'all', minFit = null, limit = 200, offset = 0 } = {}) {
    const c = normCountry(country);
    const cfg = getCountryConfig(c);

    const where = ['j.country = ?'];
    const params = [c];

    if (view === 'recommended') {
      where.push('d.id IS NULL', 'm.opportunity_score >= ?');
      params.push(cfg.possible_match_threshold);
    } else if (view === 'saved') {
      where.push('s.id IS NOT NULL');
    } else if (view === 'discarded') {
      where.push('d.id IS NOT NULL');
    } else {
      where.push('d.id IS NULL');
    }

    if (minFit !== null && minFit !== '' && !isNaN(Number(minFit))) {
      where.push('m.fit_score >= ?');
      params.push(Number(minFit));
    }

    const order = view === 'saved' ? 's.saved_at DESC'
                : view === 'discarded' ? 'd.discarded_at DESC'
                : 'm.opportunity_score DESC NULLS LAST, m.fit_score DESC';

    const rows = db.prepare(`
      SELECT j.*, m.fit_score, m.ats_score, m.opportunity_score, m.category,
             m.fit_components_json, m.fit_evidence_json, m.fit_confidence, m.warnings_json,
             a.concerns_json,
             CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END AS is_saved,
             CASE WHEN d.id IS NOT NULL THEN 1 ELSE 0 END AS is_discarded
      FROM ${T.jobs} j
      LEFT JOIN ${T.matches} m ON j.id = m.job_id
      LEFT JOIN ${T.analysis} a ON j.id = a.job_id
      LEFT JOIN ${T.saved} s ON j.id = s.job_id
      LEFT JOIN ${T.discarded} d ON j.id = d.job_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ? OFFSET ?
    `).all(...params, Number(limit), Number(offset));

    return rows.map(shapeJob);
  }

  function getJob(country, id) {
    const c = normCountry(country);
    const row = db.prepare(`
      SELECT j.*, m.*, a.concerns_json, a.requirements_json,
             CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END AS is_saved,
             CASE WHEN d.id IS NOT NULL THEN 1 ELSE 0 END AS is_discarded
      FROM ${T.jobs} j
      LEFT JOIN ${T.matches} m ON j.id = m.job_id
      LEFT JOIN ${T.analysis} a ON j.id = a.job_id
      LEFT JOIN ${T.saved} s ON j.id = s.job_id
      LEFT JOIN ${T.discarded} d ON j.id = d.job_id
      WHERE j.id = ? AND j.country = ?
    `).get(Number(id), c);

    if (!row) return null;
    const shaped = shapeJob(row);
    shaped.requirements = safeParse(row.requirements_json, []);
    shaped.fitWeights = safeParse(row.fit_weights_json, {});
    shaped.atsComponents = safeParse(row.ats_components_json, {});
    shaped.opportunityComponents = safeParse(row.opportunity_components_json, {});
    return shaped;
  }

  function shapeJob(r) {
    return Object.assign({}, r, {
      fitComponents: safeParse(r.fit_components_json, {}),
      fitEvidence: safeParse(r.fit_evidence_json, {}),
      concerns: safeParse(r.concerns_json, []),
      warnings: safeParse(r.warnings_json, []),
      categoryLabel: r.category ? scoreEngine.CATEGORY_LABEL[r.category] : null
    });
  }

  function saveJob(country, id, notes = '') {
    assertOwned(country, id);
    db.prepare(`DELETE FROM ${T.discarded} WHERE job_id = ?`).run(id);
    db.prepare(`INSERT INTO ${T.saved} (job_id, notes) VALUES (?,?)
                ON CONFLICT(job_id) DO UPDATE SET notes = excluded.notes`).run(id, notes);
    log('job_saved', `Vaga #${id} salva.`, null, 'info', { country: normCountry(country), entityId: String(id) });
    return { success: true };
  }

  function discardJob(country, id, reason = '') {
    assertOwned(country, id);
    db.prepare(`DELETE FROM ${T.saved} WHERE job_id = ?`).run(id);
    db.prepare(`INSERT INTO ${T.discarded} (job_id, reason) VALUES (?,?)
                ON CONFLICT(job_id) DO UPDATE SET reason = excluded.reason`).run(id, reason);
    log('job_discarded', `Vaga #${id} descartada.`, { reason }, 'info', { country: normCountry(country), entityId: String(id) });
    return { success: true };
  }

  /** Impede operar uma vaga de outro país dentro do escopo atual (spec §76). */
  function assertOwned(country, id) {
    const row = db.prepare(`SELECT id FROM ${T.jobs} WHERE id = ? AND country = ?`).get(Number(id), normCountry(country));
    if (!row) {
      const e = new Error('Vaga não encontrada neste país.');
      e.userFacing = true; e.status = 404;
      throw e;
    }
  }

  // -------------------------------------------------------------- dashboard

  function dashboard(country, userId) {
    const c = normCountry(country);
    const cfg = getCountryConfig(c);
    const one = (sql, ...p) => db.prepare(sql).get(c, ...p).v;

    const total = one(`SELECT COUNT(*) v FROM ${T.jobs} WHERE country = ?`);
    const newJobs = one(`SELECT COUNT(*) v FROM ${T.jobs} WHERE country = ? AND collected_at >= datetime('now','-7 day')`);
    const strong = one(`SELECT COUNT(*) v FROM ${T.jobs} j JOIN ${T.matches} m ON j.id = m.job_id
                        WHERE j.country = ? AND m.opportunity_score >= ?`, cfg.strong_match_threshold);
    const top = one(`SELECT COUNT(*) v FROM ${T.jobs} j JOIN ${T.matches} m ON j.id = m.job_id
                     WHERE j.country = ? AND m.opportunity_score >= ?`, cfg.top_priority_threshold);
    const saved = one(`SELECT COUNT(*) v FROM ${T.jobs} j JOIN ${T.saved} s ON j.id = s.job_id WHERE j.country = ?`);
    const avgFit = db.prepare(`SELECT ROUND(AVG(m.fit_score)) v FROM ${T.jobs} j JOIN ${T.matches} m ON j.id = m.job_id WHERE j.country = ?`).get(c).v;

    const integration = getIntegration(c);
    const atsInfo = resolveAts(c, cfg, userId);

    // Zona de atenção (spec §43 ROW 2)
    const attention = [];
    if (integration.health_status === 'REQUIRES_ATTENTION') {
      attention.push({ severity: 'HIGH', title: 'A conexão precisa de atenção', detail: integration.last_error, action: 'reconnect' });
    } else if (integration.health_status === 'NOT_CONFIGURED') {
      attention.push({ severity: 'MEDIUM', title: 'Integração não configurada', detail: `Configure o servidor MCP para buscar vagas reais de ${spec.label}.`, action: 'configure' });
    } else if (integration.health_status === 'DEGRADED') {
      attention.push({ severity: 'LOW', title: 'Operando com dados de exemplo', detail: 'As vagas exibidas são fixtures locais, não resultados reais.', action: 'configure' });
    }
    const store = candidate.environment(spec.key, c, userId);
    if (store.getProfile().isEmpty) {
      attention.push({
        severity: 'HIGH',
        title: `Perfil de ${spec.label} ${c} vazio`,
        detail: 'Cada plataforma e país tem o próprio perfil. Sem ele não é possível calcular aderência aqui.',
        action: 'profile'
      });
    }
    if (atsInfo.score === null) {
      attention.push({
        severity: 'MEDIUM',
        title: 'Nenhum currículo neste ambiente',
        detail: atsInfo.reason || `Adicione um currículo em ${spec.label} ${c}. Currículos de outros ambientes não são usados aqui.`,
        action: 'ats'
      });
    } else if (atsInfo.status === 'RISKY') {
      attention.push({ severity: 'HIGH', title: 'Currículo com risco de leitura automática', detail: 'O ATS Center listou problemas críticos de formato.', action: 'ats' });
    }

    return {
      country: c,
      kpis: { total, newJobs, strongMatches: strong, topPriority: top, saved, avgFit: avgFit || null },
      ats: { score: atsInfo.score, status: atsInfo.status, version: atsInfo.version, resume: atsInfo.resume },
      integration: {
        health: integration.health_status,
        lastSuccess: integration.last_success_at,
        lastFailure: integration.last_failure_at,
        lastSearch: integration.last_search_at,
        lastError: integration.last_error,
        configured: Boolean(integration.mcp_url)
      },
      attention,
      recent: listJobs(c, { view: 'recommended', limit: 5 }),
      searches: db.prepare(`SELECT * FROM ${T.searches} WHERE country = ? ORDER BY id DESC LIMIT 5`).all(c),
      onboarding: { step: cfg.onboarding_step, done: Boolean(cfg.onboarding_done) }
    };
  }

  function logs(country, limit = 100) {
    return db.prepare(`SELECT * FROM ${T.logs} WHERE country = ? OR country IS NULL ORDER BY id DESC LIMIT ?`)
      .all(normCountry(country), Number(limit));
  }

  function searchHistory(country, limit = 30) {
    return db.prepare(`SELECT * FROM ${T.searches} WHERE country = ? ORDER BY id DESC LIMIT ?`)
      .all(normCountry(country), Number(limit));
  }

  return {
    key: spec.key, label: spec.label,
    getCountryConfig, updateCountryConfig,
    getIntegration, configureIntegration, testConnection, disconnect,
    search, listJobs, getJob, saveJob, discardJob,
    dashboard, logs, searchHistory, resolveAts,
    discoveryMode, buildAdapter
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParse(s, fallback) { try { return JSON.parse(s || ''); } catch (e) { return fallback; } }
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function int(v, d = 0) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function splitList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Instâncias — tabelas totalmente separadas por produto (spec §50)
// ---------------------------------------------------------------------------

const gupyService = createBoardService({
  key: 'gupy', label: 'Gupy', log: logGupy, Adapter: GupyAdapter,
  fixtureJobs: fixtures.gupyJobs,
  tables: {
    jobs: 'gupy_jobs', analysis: 'gupy_job_analysis', matches: 'gupy_matches',
    saved: 'gupy_saved_jobs', discarded: 'gupy_discarded_jobs', searches: 'gupy_searches',
    integration: 'gupy_integration_config', logs: 'gupy_logs', countryConfig: 'gupy_country_config'
  },
  normalize: (j, country) => ({
    external_id: String(j.external_id || j.id || ''),
    title: j.title || 'Sem título',
    normalized_title: j.normalized_title || j.title,
    company: j.company || 'Empresa não informada',
    location: j.location || '',
    workplace_type: j.workplace_type || 'onsite',
    job_type: j.job_type || null,
    salary_month: j.salary_month || null,
    salary_min: j.salary_min || null, salary_max: j.salary_max || null,
    salary_currency: j.salary_currency || (country === 'BR' ? 'BRL' : 'USD'),
    salary_period: j.salary_period || (country === 'BR' ? 'month' : 'year'),
    apply_url: j.apply_url || j.url || '',
    career_page_url: j.career_page_url || null,
    published_date: j.published_date || null,
    description: j.description || '',
    requirements: j.requirements || j.raw_requirements || '',
    category: j.category || null,
    raw_json: JSON.stringify(j).slice(0, 20000)
  }),
  upsert: (j, country, hash) => {
    db.prepare(`INSERT INTO gupy_jobs
      (country, external_id, title, normalized_title, company, location, workplace_type, job_type,
       salary_month, salary_min, salary_max, salary_currency, salary_period, apply_url, career_page_url,
       published_date, description, requirements, category, content_hash, raw_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(country, external_id) DO UPDATE SET
        title = excluded.title, company = excluded.company, location = excluded.location,
        salary_month = excluded.salary_month, salary_min = excluded.salary_min, salary_max = excluded.salary_max,
        description = excluded.description, requirements = excluded.requirements,
        published_date = excluded.published_date, content_hash = excluded.content_hash,
        raw_json = excluded.raw_json`)
      .run(country, j.external_id, j.title, j.normalized_title, j.company, j.location, j.workplace_type,
           j.job_type, j.salary_month, j.salary_min, j.salary_max, j.salary_currency, j.salary_period,
           j.apply_url, j.career_page_url, j.published_date, j.description, j.requirements,
           j.category, hash, j.raw_json);
  }
});

const indeedService = createBoardService({
  key: 'indeed', label: 'Indeed', log: logIndeed, Adapter: IndeedAdapter,
  fixtureJobs: fixtures.indeedJobs,
  tables: {
    jobs: 'indeed_jobs', analysis: 'indeed_job_analysis', matches: 'indeed_matches',
    saved: 'indeed_saved_jobs', discarded: 'indeed_discarded_jobs', searches: 'indeed_searches',
    integration: 'indeed_integration_config', logs: 'indeed_logs', countryConfig: 'indeed_country_config'
  },
  normalize: (j, country) => ({
    external_id: String(j.external_id || j.id || ''),
    title: j.title || 'Sem título',
    normalized_title: j.normalized_title || j.title,
    company: j.company || 'Empresa não informada',
    location_city: j.location_city || null,
    location_state: j.location_state || null,
    is_remote: j.is_remote ? 1 : 0,
    salary_month: j.salary_month || null,
    salary_min: j.salary_min || null, salary_max: j.salary_max || null,
    salary_currency: j.salary_currency || (country === 'BR' ? 'BRL' : 'USD'),
    salary_period: j.salary_period || (country === 'BR' ? 'month' : 'year'),
    job_url: j.job_url || j.url || '',
    published_date: j.published_date || null,
    description: j.description || '',
    requirements: j.requirements || '',
    category: j.category || null,
    visa_sponsorship: j.visa_sponsorship ? 1 : 0,
    raw_json: JSON.stringify(j).slice(0, 20000)
  }),
  upsert: (j, country, hash) => {
    db.prepare(`INSERT INTO indeed_jobs
      (country, external_id, title, normalized_title, company, location_city, location_state, is_remote,
       salary_month, salary_min, salary_max, salary_currency, salary_period, job_url,
       published_date, description, requirements, category, visa_sponsorship, content_hash, raw_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(country, external_id) DO UPDATE SET
        title = excluded.title, company = excluded.company,
        salary_min = excluded.salary_min, salary_max = excluded.salary_max,
        description = excluded.description, requirements = excluded.requirements,
        published_date = excluded.published_date, content_hash = excluded.content_hash,
        raw_json = excluded.raw_json`)
      .run(country, j.external_id, j.title, j.normalized_title, j.company, j.location_city,
           j.location_state, j.is_remote, j.salary_month, j.salary_min, j.salary_max,
           j.salary_currency, j.salary_period, j.job_url, j.published_date, j.description,
           j.requirements, j.category, j.visa_sponsorship, hash, j.raw_json);
  }
});

module.exports = { createBoardService, gupyService, indeedService, normCountry };
