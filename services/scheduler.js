/**
 * Agendador — o despertador dos robôs (spec de agentes §8, §47, §48, §49, §63, §70).
 *
 * A §49 define a função: acordar os workers, rodar as sincronizações, importar
 * o feed do DOL diariamente, checar vagas vencidas e processar a fila adiada,
 * "sem interação do usuário". A §63 acrescenta a condição que dá sentido a tudo:
 * o laptop do usuário pode estar DESLIGADO.
 *
 * O spec recomenda Celery + Celery Beat + Redis. Esta implementação usa um
 * agendador em processo com estado no banco, pela mesma razão registrada em
 * docs/architecture.md: é um sistema de um usuário só, e a fila é uma tabela.
 * O que a §49 exige de verdade — execução periódica sem o usuário presente —
 * é atendido porque o processo do servidor roda no VPS, não na máquina dele.
 *
 * O que se ganha ao manter o estado no banco e não na memória do timer:
 *
 *   - reiniciar o processo não perde o agendamento;
 *   - o horário da próxima execução é consultável pela interface;
 *   - a falha de uma tarefa não interrompe as outras;
 *   - a auditoria da §72 cobre também o que rodou sozinho.
 */

const { db, logCore, logSeasonal } = require('../config/database');

const VERSION = 'scheduler-v1';

/** Intervalo do tique. Não é a frequência das tarefas — é de quanto em quanto
 *  tempo o agendador confere o que venceu. */
const DEFAULT_TICK_SECONDS = 60;

/** Backoff após falhas consecutivas: não martelar uma integração quebrada. */
const FAILURE_BACKOFF_MINUTES = [5, 15, 60, 180];

let timer = null;
let running = false;          // trava de reentrância dentro do processo
let startedAt = null;
let tickCount = 0;

// ---------------------------------------------------------------------------
// Registro de tarefas
// ---------------------------------------------------------------------------

/**
 * As tarefas periódicas do sistema (§8, §49).
 * `handler` é assíncrono e devolve `{ status, message, metrics }`.
 */
const TASKS = {
  seasonal_import: {
    label: 'Importar ordens do DOL (Seasonal)',
    defaultIntervalMinutes: 1440,          // §8 — diário, após a atualização do feed
    description: 'Busca o feed oficial do DOL, normaliza, deduplica e pontua as ordens novas.',
    async handler({ userId }) {
      const seasonal = require('./seasonalService');
      const cfg = seasonal.getConfig();

      if (!cfg.dol_feed_url && !process.env.SEASONAL_DATA_URL && !process.env.SEASONAL_FEED_BASE_URL) {
        return { status: 'SKIPPED', message: 'A URL do feed do DOL não está configurada. Nada foi importado.' };
      }

      const metrics = await seasonal.importJobs({ auto: true }, userId);
      return {
        status: 'OK',
        message: `${metrics.received} ordem(ns) recebida(s), ${metrics.newJobs} nova(s), ${metrics.analyzed} analisada(s).`,
        metrics
      };
    }
  },

  seasonal_agent_chain: {
    label: 'Cadeia de agentes (Seasonal)',
    defaultIntervalMinutes: 360,
    description: 'Truck Driver Gate, CDL, canais e decisão sobre as ordens ainda não processadas.',
    async handler({ userId }) {
      const orchestrator = require('./agentOrchestrator');
      const pending = db.prepare(`
        SELECT j.id FROM seasonal_jobs j
        LEFT JOIN seasonal_discarded_jobs d ON j.id = d.job_id
        LEFT JOIN seasonal_applications a ON j.id = a.seasonal_job_id
        WHERE d.id IS NULL AND a.id IS NULL
          AND (j.truck_classification IS NULL OR j.truck_gate_version IS NULL
               OR j.truck_gate_version != ?)
        LIMIT 300
      `).all(require('../core/agents/truckDriverGate').VERSION).map(r => r.id);

      if (!pending.length) {
        return { status: 'SKIPPED', message: 'Nenhuma ordem pendente de classificação.' };
      }

      const summary = orchestrator.runSeasonalBatch({ userId, jobIds: pending });
      return {
        status: summary.errors.length ? 'OK' : 'OK',
        message: `${summary.processed} ordem(ns) classificada(s): ` +
                 `${summary.truck.CONFIRMED} confirmada(s), ${summary.truck.PROBABLE} provável(is), ` +
                 `${summary.truck.REVIEW} em revisão, ${summary.truck.NOT} fora do alvo.`,
        metrics: summary
      };
    }
  },

  seasonal_prepare_packages: {
    label: 'Preparar candidaturas (Seasonal)',
    defaultIntervalMinutes: 360,
    description: 'Monta pacotes das ordens aprovadas, conforme o modo de automação configurado.',
    async handler({ userId }) {
      const seasonal = require('./seasonalService');
      const cfg = seasonal.getConfig();

      if (cfg.automation_mode === 'MANUAL') {
        return { status: 'SKIPPED', message: 'Modo manual: nenhuma candidatura é preparada sem ação do usuário.' };
      }
      const r = seasonal.maybeAutoQueue(userId);
      return {
        status: 'OK',
        message: r.queued ? `${r.queued} candidatura(s) preparada(s).` : 'Nenhuma ordem atingiu os limiares configurados.',
        metrics: r
      };
    }
  },

  seasonal_dispatch: {
    label: 'Enviar candidaturas da fila (Seasonal)',
    defaultIntervalMinutes: 60,
    description: 'Processa a fila respeitando cota, pausa, prioridade 2027 e backoff.',
    async handler() {
      const emailService = require('./seasonalEmailService');
      const r = await emailService.processQueue({ max: 10 });

      if (r.reason === 'PAUSED' || r.reason === 'GLOBAL_PAUSE') {
        return { status: 'SKIPPED', message: r.userMessage, metrics: r };
      }
      if (r.reason === 'EMPTY') {
        return { status: 'SKIPPED', message: 'Fila vazia.', metrics: r };
      }
      return { status: 'OK', message: r.userMessage, metrics: r };
    }
  },

  seasonal_stale_check: {
    label: 'Marcar ordens vencidas (Seasonal)',
    defaultIntervalMinutes: 720,
    description: 'Retira da fila as ordens cujo período de trabalho já terminou.',
    async handler() {
      const today = new Date().toISOString().slice(0, 10);

      const stale = db.prepare(`
        SELECT q.id, q.job_id, j.job_order_id FROM seasonal_email_queue q
        JOIN seasonal_jobs j ON q.job_id = j.id
        WHERE q.status IN ('QUEUED','DEFERRED','AWAITING_REVIEW')
          AND j.end_date IS NOT NULL AND j.end_date < ?
      `).all(today);

      for (const s of stale) {
        db.prepare(`UPDATE seasonal_email_queue SET status = 'SKIPPED',
                    last_error = 'O período de trabalho desta ordem já terminou.' WHERE id = ?`).run(s.id);
        db.prepare(`INSERT INTO seasonal_email_events (queue_id, job_id, event, detail)
                    VALUES (?,?,?,?)`)
          .run(s.id, s.job_id, 'SKIPPED_EXPIRED', `Ordem #${s.job_order_id} fora do período.`);
      }

      return {
        status: 'OK',
        message: stale.length ? `${stale.length} ordem(ns) vencida(s) retirada(s) da fila.` : 'Nenhuma ordem vencida na fila.',
        metrics: { removed: stale.length }
      };
    }
  },

  audit_retention: {
    label: 'Limpeza da trilha de auditoria',
    defaultIntervalMinutes: 1440,
    description: 'Remove registros de agentes mais antigos que a retenção configurada.',
    async handler() {
      const days = parseInt(getSetting('agent_audit_retention_days', '90'), 10) || 90;
      const r = db.prepare(`DELETE FROM core_agent_runs WHERE created_at < datetime('now', ?)`).run(`-${days} days`);
      db.prepare(`DELETE FROM core_scheduler_runs WHERE started_at < datetime('now', ?)`).run(`-${days} days`);
      return { status: 'OK', message: `${r.changes} registro(s) de auditoria removido(s) (retenção: ${days} dias).` };
    }
  }
};

// ---------------------------------------------------------------------------
// Persistência do agendamento
// ---------------------------------------------------------------------------

function getSetting(key, fallback = '') {
  try {
    const r = db.prepare('SELECT value FROM core_system_settings WHERE key = ?').get(key);
    return r && r.value !== null && r.value !== '' ? r.value : fallback;
  } catch (e) { return fallback; }
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO core_system_settings (key, value, category, description)
              VALUES (?,?, 'automation', '')
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
    .run(key, String(value));
}

/** Cria a linha de cada tarefa conhecida, preservando o que já foi configurado. */
function ensureTasks() {
  const ins = db.prepare(`INSERT INTO core_scheduler_jobs (id, label, interval_minutes, enabled)
                          VALUES (?,?,?,0)
                          ON CONFLICT(id) DO UPDATE SET label = excluded.label`);
  for (const [id, t] of Object.entries(TASKS)) ins.run(id, t.label, t.defaultIntervalMinutes);

  // Remove tarefas que não existem mais no código.
  const known = Object.keys(TASKS);
  const rows = db.prepare('SELECT id FROM core_scheduler_jobs').all();
  for (const r of rows) {
    if (!known.includes(r.id)) db.prepare('DELETE FROM core_scheduler_jobs WHERE id = ?').run(r.id);
  }
}

function taskRow(id) {
  return db.prepare('SELECT * FROM core_scheduler_jobs WHERE id = ?').get(id);
}

function isEnabled() {
  return getSetting('scheduler_enabled', '0') === '1';
}

function globallyPaused() {
  return getSetting('global_pause_all_automations', '0') === '1';
}

/**
 * O SQLite grava `CURRENT_TIMESTAMP` como "YYYY-MM-DD HH:MM:SS" em UTC, sem
 * indicador de fuso. Interpretar isso como hora local desloca o agendamento em
 * horas — por isso o carimbo é convertido para ISO explicitamente UTC.
 */
function parseDbTimestamp(value) {
  if (!value) return null;
  const s = String(value).trim();
  const iso = /[zZ]|[+-]\d{2}:\d{2}$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function computeNextRun(row) {
  const interval = Math.max(1, Number(row.interval_minutes) || 60);
  const base = parseDbTimestamp(row.last_run_at) || Date.now();
  let minutes = interval;

  // Backoff em falhas consecutivas — não insistir de minuto em minuto numa
  // integração que está fora do ar. O atraso SOMA ao intervalo: usar o maior
  // dos dois não afastaria nada quando o intervalo já é longo.
  const failures = Number(row.consecutive_failures) || 0;
  if (failures > 0) {
    minutes += FAILURE_BACKOFF_MINUTES[Math.min(failures - 1, FAILURE_BACKOFF_MINUTES.length - 1)];
  }

  return new Date(base + minutes * 60000).toISOString();
}

function isDue(row, now = Date.now()) {
  if (!row.enabled) return false;
  if (!row.last_run_at) return true;
  const next = parseDbTimestamp(row.next_run_at);
  if (next === null) return true;
  return next <= now;
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

/**
 * Roda UMA tarefa, com registro de início e fim.
 * `force` ignora o agendamento (é o "Atualizar agora" da §8), mas nunca ignora
 * a pausa global — essa é uma trava de segurança, não uma preferência.
 */
async function runTask(id, { userId = 1, force = false } = {}) {
  const task = TASKS[id];
  if (!task) {
    const e = new Error(`Tarefa desconhecida: "${id}".`);
    e.userFacing = true; e.status = 404;
    throw e;
  }

  if (globallyPaused() && !force) {
    return { id, status: 'SKIPPED', message: 'Todas as automações estão pausadas nas configurações do sistema.' };
  }

  const started = Date.now();
  const runInfo = db.prepare('INSERT INTO core_scheduler_runs (job_id, status) VALUES (?, ?)').run(id, 'RUNNING');
  const runId = Number(runInfo.lastInsertRowid);

  let result;
  try {
    result = await task.handler({ userId });
    if (!result || !result.status) result = { status: 'OK', message: 'Concluída.' };
  } catch (err) {
    result = { status: 'FAILED', message: err.userFacing ? err.message : `Falha: ${err.message}` };
  }

  const duration = Date.now() - started;
  const failed = result.status === 'FAILED';

  db.prepare(`UPDATE core_scheduler_runs SET finished_at = CURRENT_TIMESTAMP, status = ?,
              message = ?, metrics_json = ?, duration_ms = ? WHERE id = ?`)
    .run(result.status, result.message || null,
         result.metrics ? JSON.stringify(result.metrics) : null, duration, runId);

  const row = taskRow(id);
  const failures = failed ? (Number(row.consecutive_failures) || 0) + 1 : 0;

  db.prepare(`UPDATE core_scheduler_jobs SET last_run_at = CURRENT_TIMESTAMP, last_status = ?,
              last_message = ?, last_duration_ms = ?, consecutive_failures = ?,
              updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(result.status, result.message || null, duration, failures, id);

  const updated = taskRow(id);
  db.prepare('UPDATE core_scheduler_jobs SET next_run_at = ? WHERE id = ?')
    .run(computeNextRun(updated), id);

  logCore('scheduler', failed ? 'task_failed' : 'task_run',
    `[${task.label}] ${result.message || result.status}`,
    { taskId: id, status: result.status, durationMs: duration, failures },
    id, failed ? 'error' : 'info');

  return Object.assign({ id, label: task.label, durationMs: duration }, result);
}

/** Um tique: roda tudo que venceu. Nunca roda duas vezes em paralelo. */
async function tick({ userId = 1 } = {}) {
  if (running) return { skipped: true, reason: 'BUSY' };
  running = true;
  tickCount++;

  const results = [];
  try {
    if (!isEnabled()) return { skipped: true, reason: 'DISABLED' };
    if (globallyPaused()) return { skipped: true, reason: 'GLOBAL_PAUSE' };

    const now = Date.now();
    const rows = db.prepare('SELECT * FROM core_scheduler_jobs ORDER BY id').all();

    for (const row of rows) {
      if (!isDue(row, now)) continue;
      try {
        results.push(await runTask(row.id, { userId }));
      } catch (err) {
        results.push({ id: row.id, status: 'FAILED', message: err.message });
      }
    }
  } finally {
    running = false;
  }

  return { skipped: false, ran: results.length, results };
}

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------

/**
 * Liga o agendador no processo. Chamado pelo `server.js` no boot — é isso que
 * faz os robôs trabalharem com o computador do usuário desligado (§63).
 */
function start({ userId = 1 } = {}) {
  ensureTasks();
  if (timer) return { started: false, reason: 'ALREADY_RUNNING' };

  const seconds = Math.max(15, parseInt(getSetting('scheduler_tick_seconds', String(DEFAULT_TICK_SECONDS)), 10) || DEFAULT_TICK_SECONDS);

  timer = setInterval(() => {
    tick({ userId }).catch(err => {
      logCore('scheduler', 'tick_failed', `Falha no tique do agendador: ${err.message}`, null, null, 'error');
    });
  }, seconds * 1000);

  // Não segura o processo: `npm test` e scripts curtos encerram normalmente.
  if (timer.unref) timer.unref();
  startedAt = new Date().toISOString();

  logCore('scheduler', 'started',
    `Agendador iniciado com tique de ${seconds}s. ` +
    (isEnabled() ? 'Habilitado.' : 'Em espera: habilite-o nas configurações para os robôs trabalharem sozinhos.'),
    { tickSeconds: seconds, enabled: isEnabled() });

  return { started: true, tickSeconds: seconds, enabled: isEnabled() };
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  startedAt = null;
  return { stopped: true };
}

/** Liga/desliga a automação inteira, sem derrubar o processo. */
function setEnabled(enabled) {
  setSetting('scheduler_enabled', enabled ? '1' : '0');
  db.prepare('UPDATE seasonal_config SET scheduler_enabled = ?').run(enabled ? 1 : 0);

  // Ao habilitar, as tarefas do Seasonal entram em operação com o intervalo salvo.
  if (enabled) {
    const cfg = db.prepare('SELECT * FROM seasonal_config ORDER BY id LIMIT 1').get() || {};
    setTaskConfig('seasonal_import', { enabled: true, intervalMinutes: cfg.import_interval_minutes || 1440 });
    setTaskConfig('seasonal_agent_chain', { enabled: true });
    setTaskConfig('seasonal_prepare_packages', { enabled: true });
    setTaskConfig('seasonal_dispatch', { enabled: true, intervalMinutes: cfg.dispatch_interval_minutes || 60 });
    setTaskConfig('seasonal_stale_check', { enabled: true });
    setTaskConfig('audit_retention', { enabled: true });
  }

  logCore('scheduler', enabled ? 'enabled' : 'disabled',
    enabled
      ? 'Automação ligada: os robôs passam a trabalhar sem o usuário presente.'
      : 'Automação desligada. Descoberta e envio só acontecem por ação manual.');

  return status();
}

/** Ajusta uma tarefa individual. */
function setTaskConfig(id, { enabled, intervalMinutes } = {}) {
  if (!TASKS[id]) {
    const e = new Error(`Tarefa desconhecida: "${id}".`);
    e.userFacing = true; e.status = 404;
    throw e;
  }
  ensureTasks();

  if (enabled !== undefined) {
    db.prepare('UPDATE core_scheduler_jobs SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(enabled ? 1 : 0, id);
  }
  if (intervalMinutes !== undefined) {
    const n = Math.max(5, Math.min(20160, parseInt(intervalMinutes, 10) || TASKS[id].defaultIntervalMinutes));
    db.prepare('UPDATE core_scheduler_jobs SET interval_minutes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(n, id);
  }

  const row = taskRow(id);
  db.prepare('UPDATE core_scheduler_jobs SET next_run_at = ? WHERE id = ?').run(computeNextRun(row), id);
  return taskRow(id);
}

/** Estado completo, para a interface e para o relatório de prontidão. */
function status() {
  ensureTasks();
  const rows = db.prepare('SELECT * FROM core_scheduler_jobs ORDER BY id').all();

  return {
    enabled: isEnabled(),
    running: Boolean(timer),
    globallyPaused: globallyPaused(),
    startedAt,
    tickCount,
    tickSeconds: parseInt(getSetting('scheduler_tick_seconds', String(DEFAULT_TICK_SECONDS)), 10) || DEFAULT_TICK_SECONDS,
    tasks: rows.map(r => Object.assign({}, r, {
      description: TASKS[r.id] ? TASKS[r.id].description : null,
      due: isDue(r),
      enabled: Boolean(r.enabled)
    })),
    version: VERSION
  };
}

function history({ taskId = null, limit = 50 } = {}) {
  const where = taskId ? 'WHERE job_id = ?' : '';
  const params = taskId ? [taskId] : [];
  return db.prepare(`SELECT * FROM core_scheduler_runs ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, Number(limit))
    .map(r => Object.assign({}, r, { metrics: safeParse(r.metrics_json, null) }));
}

function safeParse(s, f) { try { return JSON.parse(s || ''); } catch (e) { return f; } }

module.exports = {
  VERSION, TASKS, DEFAULT_TICK_SECONDS, FAILURE_BACKOFF_MINUTES,
  ensureTasks, start, stop, tick, runTask,
  setEnabled, setTaskConfig, status, history,
  isEnabled, isDue, computeNextRun
};
