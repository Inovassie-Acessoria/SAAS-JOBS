/**
 * "Enquanto você esteve fora" (spec de agentes §55, §56, §57).
 *
 * Este é o resumo que o usuário encontra ao voltar. Ele responde a três
 * perguntas, nesta ordem de importância:
 *
 *   1. O que os robôs fizeram sozinhos?
 *   2. O que está esperando por mim?
 *   3. O que deu errado e por quê?
 *
 * A janela padrão é "desde o último acesso", com piso de 24h — um relatório que
 * some porque o usuário abriu o painel dois minutos atrás não serve para nada.
 *
 * Números aqui nunca são estimativa. Cada contagem sai de uma consulta sobre o
 * que realmente aconteceu, e cada bloco cita o produto de onde veio, porque o
 * isolamento entre Gupy, Indeed e Seasonal também vale para o relatório.
 */

const { db } = require('../config/database');

const VERSION = 'away-report-v1';

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 30;

function since(hours) {
  const h = Math.max(1, Math.min(MAX_WINDOW_HOURS, Number(hours) || DEFAULT_WINDOW_HOURS));
  return { hours: h, iso: new Date(Date.now() - h * 3600000).toISOString() };
}

function count(sql, ...params) {
  try { return db.prepare(sql).get(...params).v || 0; } catch (e) { return 0; }
}

// ---------------------------------------------------------------------------
// Gupy e Indeed (§55, §56) — fila de aprovação
// ---------------------------------------------------------------------------

function boardSummary(prefix, windowIso) {
  const jobs = `${prefix}_jobs`;
  const matches = `${prefix}_matches`;

  const found = count(`SELECT COUNT(*) v FROM ${jobs} WHERE collected_at >= ?`, windowIso);
  const strong = count(
    `SELECT COUNT(*) v FROM ${matches} m JOIN ${jobs} j ON m.job_id = j.id
     WHERE m.updated_at >= ? AND m.opportunity_score >= 80`, windowIso);

  // "Pronta para revisão" = pontuada acima do limiar, não descartada e não vista.
  const ready = count(`
    SELECT COUNT(*) v FROM ${jobs} j
    JOIN ${matches} m ON j.id = m.job_id
    LEFT JOIN ${prefix}_discarded_jobs d ON j.id = d.job_id
    WHERE d.id IS NULL AND m.opportunity_score >= 80`);

  const byCountry = {};
  try {
    for (const r of db.prepare(`SELECT country, COUNT(*) v FROM ${jobs} WHERE collected_at >= ? GROUP BY country`).all(windowIso)) {
      byCountry[r.country] = r.v;
    }
  } catch (e) { /* produto sem coluna de país não chega aqui */ }

  return { found, strongMatches: strong, readyForReview: ready, byCountry };
}

function boardTopJobs(prefix, limit = 5) {
  try {
    return db.prepare(`
      SELECT j.id, j.title, j.company, j.country, j.location,
             m.fit_score, m.ats_score, m.opportunity_score, m.category
      FROM ${prefix}_jobs j
      JOIN ${prefix}_matches m ON j.id = m.job_id
      LEFT JOIN ${prefix}_discarded_jobs d ON j.id = d.job_id
      WHERE d.id IS NULL
      ORDER BY m.opportunity_score DESC NULLS LAST
      LIMIT ?
    `).all(Number(limit));
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Seasonal (§55, §57)
// ---------------------------------------------------------------------------

function seasonalSummary(windowIso) {
  const imported = count('SELECT COUNT(*) v FROM seasonal_jobs WHERE collected_at >= ?', windowIso);

  const truckJobs = count(
    "SELECT COUNT(*) v FROM seasonal_jobs WHERE truck_classification IN ('TRUCK_DRIVER_CONFIRMED','TRUCK_DRIVER_PROBABLE')");
  const truckConfirmed = count(
    "SELECT COUNT(*) v FROM seasonal_jobs WHERE truck_classification = 'TRUCK_DRIVER_CONFIRMED'");
  const truckReview = count(
    "SELECT COUNT(*) v FROM seasonal_jobs WHERE truck_classification = 'REVIEW_REQUIRED'");
  const notTruck = count(
    "SELECT COUNT(*) v FROM seasonal_jobs WHERE truck_classification = 'NOT_TRUCK_DRIVER'");
  const unclassified = count(
    'SELECT COUNT(*) v FROM seasonal_jobs WHERE truck_classification IS NULL');

  // 2027 só conta DENTRO do universo de motorista (§30: "Only within the
  // truck-driver target universe").
  const target2027 = count(`
    SELECT COUNT(*) v FROM seasonal_jobs
    WHERE timeline_class = 'TARGET_2027'
      AND truck_classification IN ('TRUCK_DRIVER_CONFIRMED','TRUCK_DRIVER_PROBABLE')`);

  const qualified = count(`
    SELECT COUNT(*) v FROM seasonal_jobs j
    JOIN seasonal_matches m ON j.id = m.job_id
    WHERE j.decision = 'APPLY'`);

  const queued = count("SELECT COUNT(*) v FROM seasonal_email_queue WHERE status IN ('QUEUED','DEFERRED')");
  const awaitingReview = count("SELECT COUNT(*) v FROM seasonal_email_queue WHERE status = 'AWAITING_REVIEW'");
  const sentInWindow = count('SELECT COUNT(*) v FROM seasonal_applications WHERE sent_at >= ?', windowIso);
  const failed = count("SELECT COUNT(*) v FROM seasonal_email_queue WHERE status = 'FAILED'");
  const blockedByPolicy = count("SELECT COUNT(*) v FROM seasonal_email_queue WHERE error_class = 'POLICY'");
  const manualActions = count("SELECT COUNT(*) v FROM seasonal_manual_actions WHERE status = 'PENDING'");

  return {
    imported,
    truckJobs, truckConfirmed, truckReview, notTruck, unclassified,
    target2027, qualified,
    queued, awaitingReview,
    emailsSent: sentInWindow, failed, blockedByPolicy,
    manualActionsRequired: manualActions
  };
}

// ---------------------------------------------------------------------------
// Atividade dos robôs
// ---------------------------------------------------------------------------

function schedulerActivity(windowIso) {
  const runs = db.prepare(`
    SELECT job_id, status, COUNT(*) v FROM core_scheduler_runs
    WHERE started_at >= ? GROUP BY job_id, status
  `).all(windowIso);

  const byTask = {};
  for (const r of runs) {
    byTask[r.job_id] = byTask[r.job_id] || { OK: 0, FAILED: 0, SKIPPED: 0, RUNNING: 0 };
    byTask[r.job_id][r.status] = (byTask[r.job_id][r.status] || 0) + r.v;
  }

  const lastRuns = db.prepare(`
    SELECT job_id, status, message, started_at, duration_ms
    FROM core_scheduler_runs WHERE started_at >= ?
    ORDER BY id DESC LIMIT 20
  `).all(windowIso);

  const failures = db.prepare(`
    SELECT job_id, message, started_at FROM core_scheduler_runs
    WHERE started_at >= ? AND status = 'FAILED' ORDER BY id DESC LIMIT 10
  `).all(windowIso);

  return { byTask, lastRuns, failures, totalRuns: lastRuns.length };
}

function agentActivity(windowIso) {
  const byOutcome = {};
  try {
    for (const r of db.prepare(`
      SELECT outcome, COUNT(*) v FROM core_agent_runs WHERE created_at >= ? GROUP BY outcome
    `).all(windowIso)) {
      byOutcome[r.outcome] = r.v;
    }
  } catch (e) { /* tabela nova, sem dados */ }

  const blocked = db.prepare(`
    SELECT agent, job_id, summary, created_at FROM core_agent_runs
    WHERE created_at >= ? AND outcome IN ('BLOCK','FAIL')
    ORDER BY id DESC LIMIT 15
  `).all(windowIso);

  return { byOutcome, blocked };
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------

/**
 * Monta o relatório completo (§55).
 *
 * @param {object} options
 * @param {number} [options.hours]   janela em horas (padrão 24)
 * @param {number} [options.userId]
 */
function build({ hours = DEFAULT_WINDOW_HOURS, userId = 1 } = {}) {
  const w = since(hours);

  const gupy = boardSummary('gupy', w.iso);
  const indeed = boardSummary('indeed', w.iso);
  const seasonal = seasonalSummary(w.iso);
  const scheduler = require('./scheduler').status();
  const quota = require('./seasonalEmailService').getQuotaStatus();

  const activity = schedulerActivity(w.iso);
  const agents = agentActivity(w.iso);

  // --- O que exige ação do usuário -----------------------------------------
  const actions = [];

  if (gupy.readyForReview > 0) {
    actions.push({ product: 'gupy', kind: 'REVIEW', count: gupy.readyForReview,
      label: `${gupy.readyForReview} candidatura(s) da Gupy prontas para revisão`,
      detail: 'A Gupy não aceita submissão automática. O sistema preparou tudo; a candidatura final é sua (§20).' });
  }
  if (indeed.readyForReview > 0) {
    actions.push({ product: 'indeed', kind: 'REVIEW', count: indeed.readyForReview,
      label: `${indeed.readyForReview} candidatura(s) do Indeed prontas para revisão`,
      detail: 'O Indeed exige mecanismos oficiais. Nenhum bot submete por você (§21, §71.4).' });
  }
  if (seasonal.awaitingReview > 0) {
    actions.push({ product: 'seasonal', kind: 'APPROVE', count: seasonal.awaitingReview,
      label: `${seasonal.awaitingReview} candidatura(s) do Seasonal aguardando aprovação`,
      detail: 'Elas não são enviadas até você aprovar.' });
  }
  if (seasonal.manualActionsRequired > 0) {
    actions.push({ product: 'seasonal', kind: 'MANUAL', count: seasonal.manualActionsRequired,
      label: `${seasonal.manualActionsRequired} contato(s) por telefone/WhatsApp preparado(s)`,
      detail: 'A mensagem está pronta em inglês. Telefone listado não é consentimento de WhatsApp — o envio é seu (§41).' });
  }
  if (seasonal.truckReview > 0) {
    actions.push({ product: 'seasonal', kind: 'CLASSIFY', count: seasonal.truckReview,
      label: `${seasonal.truckReview} vaga(s) com classificação de motorista ambígua`,
      detail: 'Sem SOC 53-3032.00 e sem título inequívoco, a decisão é humana (§26, §54).' });
  }
  if (seasonal.failed > 0) {
    actions.push({ product: 'seasonal', kind: 'FAILURE', count: seasonal.failed,
      label: `${seasonal.failed} envio(s) com falha`,
      detail: 'Consulte o motivo de cada um na fila de e-mails.' });
  }
  if (activity.failures.length) {
    actions.push({ product: 'core', kind: 'SCHEDULER', count: activity.failures.length,
      label: `${activity.failures.length} execução(ões) automática(s) falharam`,
      detail: activity.failures[0].message || 'Veja o histórico do agendador.' });
  }

  // --- Estado da autonomia --------------------------------------------------
  const autonomyNotes = [];
  if (!scheduler.enabled) {
    autonomyNotes.push('O agendador está DESLIGADO. Nada roda sozinho — descoberta e envio dependem de ação sua.');
  }
  if (scheduler.globallyPaused) {
    autonomyNotes.push('A pausa geral das automações está ATIVA. Nenhuma ação externa sai do sistema.');
  }
  if (seasonal.unclassified > 0) {
    autonomyNotes.push(`${seasonal.unclassified} ordem(ns) ainda não passaram pelo Truck Driver Gate.`);
  }
  if (seasonal.blockedByPolicy > 0) {
    autonomyNotes.push(`${seasonal.blockedByPolicy} envio(s) foram barrados pelo Policy Gate — a política venceu a fila, como deve.`);
  }

  return {
    window: { hours: w.hours, since: w.iso, generatedAt: new Date().toISOString() },
    gupy: Object.assign({}, gupy, { top: boardTopJobs('gupy') }),
    indeed: Object.assign({}, indeed, { top: boardTopJobs('indeed') }),
    seasonal,
    quota: {
      sentToday: quota.countSent, limit: quota.maxLimit,
      remaining: quota.remaining, timezone: quota.timezone, reset: quota.reset
    },
    scheduler: {
      enabled: scheduler.enabled,
      running: scheduler.running,
      globallyPaused: scheduler.globallyPaused,
      tasks: scheduler.tasks.map(t => ({
        id: t.id, label: t.label, enabled: t.enabled,
        lastRunAt: t.last_run_at, lastStatus: t.last_status,
        lastMessage: t.last_message, nextRunAt: t.next_run_at,
        consecutiveFailures: t.consecutive_failures
      }))
    },
    activity,
    agents,
    actions,
    autonomyNotes,
    /** Uma frase para o topo da tela — a §55 abre com um resumo, não com uma tabela. */
    headline: buildHeadline({ gupy, indeed, seasonal, scheduler }),
    version: VERSION
  };
}

function buildHeadline({ gupy, indeed, seasonal, scheduler }) {
  if (!scheduler.enabled) {
    return 'Os robôs estão desligados. Ligue a automação para que a descoberta e o preparo aconteçam sem você.';
  }

  const parts = [];
  const found = gupy.found + indeed.found + seasonal.imported;
  if (found) parts.push(`${found} vaga(s) descoberta(s)`);
  if (seasonal.truckJobs) parts.push(`${seasonal.truckJobs} de motorista`);
  if (seasonal.target2027) parts.push(`${seasonal.target2027} com contratação em 2027`);
  if (seasonal.emailsSent) parts.push(`${seasonal.emailsSent} candidatura(s) enviada(s)`);

  const pending = gupy.readyForReview + indeed.readyForReview + seasonal.awaitingReview;
  if (pending) parts.push(`${pending} esperando por você`);

  return parts.length
    ? 'Enquanto você esteve fora: ' + parts.join(', ') + '.'
    : 'Enquanto você esteve fora, nada de novo apareceu nas fontes configuradas.';
}

module.exports = { VERSION, DEFAULT_WINDOW_HOURS, build, since };
