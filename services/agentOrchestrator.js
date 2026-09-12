/**
 * Job Orchestrator — o gerente da cadeia de agentes (spec de agentes §2, §32, §50, §72).
 *
 * A §2 é uma proibição antes de ser um desenho: NÃO construir um único agente
 * de IA irrestrito que busca, pensa, escreve, envia e altera dados sem controle.
 * O que existe no lugar é uma cadeia de agentes especializados, cada um com
 * entrada e saída declaradas, e serviços determinísticos entre eles.
 *
 *   DISCOVERY → PARSER → HARD FILTER → TRUCK GATE → TIMELINE → CDL →
 *   ATS → MATCH → OPPORTUNITY → DECISION → TRUTH GUARD → POLICY GATE → canal
 *
 * Duas regras estruturais governam este arquivo:
 *
 *   §50  O banco é a fonte da verdade. Nenhum estado crítico vive em memória
 *        de conversa. Cada passo lê e grava do PostgreSQL/SQLite.
 *   §72  Toda candidatura precisa ser auditável da descoberta ao estado final.
 *        Por isso cada passo grava uma linha em `core_agent_runs`.
 *
 * O orquestrador não decide nada sozinho: ele chama quem decide e registra.
 */

const { db, logSeasonal, logCore } = require('../config/database');
const crypto = require('crypto');

const truckGate = require('../core/agents/truckDriverGate');
const cdlIntel = require('../core/agents/cdlIntelligence');
const channelAgent = require('../core/agents/communicationChannel');
const decisionEngine = require('../core/agents/decisionEngine');
const stateMachine = require('../core/agents/stateMachine');
const permissions = require('../core/agents/permissions');
const policyGate = require('../core/agents/policyGate');

const { AGENT, CAPABILITY } = permissions;

const VERSION = 'orchestrator-v1';

// ---------------------------------------------------------------------------
// Auditoria (§72)
// ---------------------------------------------------------------------------

function newCorrelationId() {
  return `run_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function recordAgentRun({ correlationId, product, agent, jobId = null, entityRef = null,
                          stateFrom = null, stateTo = null, outcome, summary, detail = null, durationMs = 0 }) {
  try {
    db.prepare(`INSERT INTO core_agent_runs
      (correlation_id, product, agent, job_id, entity_ref, state_from, state_to, outcome, summary, detail_json, duration_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(correlationId, product, agent, jobId, entityRef, stateFrom, stateTo, outcome,
           summary, detail ? JSON.stringify(detail) : null, durationMs);
  } catch (e) {
    console.error('[agent-audit]', e.message);
  }
}

/**
 * Executa um passo com permissão verificada, cronometrado e auditado.
 * A verificação de capacidade (§52) acontece ANTES do passo rodar.
 */
function step({ correlationId, product, agent, jobId, capabilities = [], stateFrom = null, stateTo = null }, fn) {
  for (const c of capabilities) permissions.requireCapability(agent, c);

  const started = Date.now();
  try {
    const result = fn();
    recordAgentRun({
      correlationId, product, agent, jobId, stateFrom, stateTo,
      outcome: result && result.outcome ? result.outcome : 'PASS',
      summary: result && result.summary ? result.summary : `${agent} concluído.`,
      detail: result && result.detail !== undefined ? result.detail : null,
      durationMs: Date.now() - started
    });
    return result;
  } catch (err) {
    recordAgentRun({
      correlationId, product, agent, jobId, stateFrom, stateTo,
      outcome: 'FAIL', summary: err.message,
      detail: { stack: String(err.stack || '').split('\n').slice(0, 4) },
      durationMs: Date.now() - started
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Estado da candidatura (§51)
// ---------------------------------------------------------------------------

function currentState(jobId) {
  const r = db.prepare('SELECT application_state FROM seasonal_jobs WHERE id = ?').get(Number(jobId));
  return r ? (r.application_state || 'DISCOVERED') : null;
}

/**
 * Move a vaga de estado, validando a transição (§51).
 * Uma transição não declarada é erro de programação e falha alto — não é
 * silenciosamente aceita, porque a auditoria da §72 depende do estado ser real.
 */
function transition(jobId, to, { correlationId = null, note = null } = {}) {
  const from = currentState(jobId);
  if (from === to) return { from, to, changed: false };

  stateMachine.assertTransition('seasonal', from, to);
  db.prepare('UPDATE seasonal_jobs SET application_state = ? WHERE id = ?').run(to, Number(jobId));

  recordAgentRun({
    correlationId, product: 'seasonal', agent: AGENT.ORCHESTRATOR, jobId,
    stateFrom: from, stateTo: to, outcome: 'PASS',
    summary: note || `Estado: ${stateMachine.label(from)} → ${stateMachine.label(to)}.`
  });

  return { from, to, changed: true };
}

// ---------------------------------------------------------------------------
// Cadeia do Seasonal (§32)
// ---------------------------------------------------------------------------

/**
 * Roda a cadeia de agentes sobre UMA ordem de serviço já importada e pontuada.
 *
 * Não envia nada. O resultado é a decisão e o estado — o envio acontece depois,
 * na fila, e só através do Gmail Worker (§37).
 *
 * @param {number} jobId
 * @param {object} options
 * @param {number} [options.userId]
 * @param {string} [options.correlationId]
 * @param {object} [options.config]        configuração do Seasonal
 * @param {object} [options.driverProfile] perfil de motorista (§27)
 */
/** Anos de experiência profissional do perfil geral (foco amplo, §29). */
function generalExperienceYears(userId) {
  try {
    const p = require('./seasonalService').candidateProfile(userId);
    return p && p.yearsOfExperience !== null && p.yearsOfExperience !== undefined && p.yearsOfExperience !== ''
      ? Number(p.yearsOfExperience) : undefined;
  } catch (e) { return undefined; }
}

function runSeasonalChain(jobId, options = {}) {
  const correlationId = options.correlationId || newCorrelationId();
  const product = 'seasonal';
  const ctx = { correlationId, product, jobId };

  const job = db.prepare('SELECT * FROM seasonal_jobs WHERE id = ?').get(Number(jobId));
  if (!job) {
    const e = new Error('Ordem de serviço não encontrada.');
    e.userFacing = true; e.status = 404;
    throw e;
  }

  const config = options.config || db.prepare('SELECT * FROM seasonal_config ORDER BY id LIMIT 1').get() || {};
  const driverProfile = options.driverProfile
    || require('./driverProfileService').get(options.userId || 1);

  const out = { jobId: Number(jobId), correlationId, version: VERSION };

  // ---- 1. TRUCK DRIVER GATE (§24, §25, §26) ------------------------------
  const truck = step(
    Object.assign({ agent: AGENT.TRUCK_GATE, capabilities: [CAPABILITY.READ_JOB, CAPABILITY.WRITE_JOB_DB] }, ctx),
    () => {
      const c = truckGate.classify(job);
      db.prepare(`UPDATE seasonal_jobs SET truck_classification = ?, truck_confidence = ?,
                  truck_soc_matched = ?, truck_reasons_json = ?, truck_gate_version = ? WHERE id = ?`)
        .run(c.classification, c.confidence, c.socMatched ? 1 : 0,
             JSON.stringify(c.reasons), c.version, job.id);
      return {
        outcome: c.pass ? 'PASS' : (c.classification === truckGate.CLASSIFICATION.REVIEW ? 'SKIP' : 'BLOCK'),
        summary: `${c.label}${c.socCode ? ` — SOC ${c.socCode}` : ''}. ${c.reasons[0] || ''}`.trim(),
        detail: c,
        value: c
      };
    }
  ).value;

  out.truck = truck;

  // Foco das candidaturas. No foco AMPLO (padrão desde 2026-09-11) o portão
  // de caminhão só classifica — vaga de outra ocupação segue a cadeia normal.
  // No foco "só motorista" ela sai aqui, registrada com o motivo (§25, §72).
  const requireTruck = Number(config.require_truck_driver_match) === 1;
  out.requireTruck = requireTruck;

  if (requireTruck && truck.classification === truckGate.CLASSIFICATION.NOT) {
    transition(job.id, 'FILTERED', { correlationId, note: `Filtrada pelo Truck Driver Gate: ${truck.reasons[0]}` });
    out.state = 'FILTERED';
    out.decision = decisionEngine.DECISION.DO_NOT_APPLY;
    out.stoppedAt = 'TRUCK_GATE';
    return out;
  }

  // ---- 2. CDL e requisitos de motorista (§28, §29) -----------------------
  const eligibility = step(
    Object.assign({ agent: AGENT.PARSER, capabilities: [CAPABILITY.READ_JOB, CAPABILITY.WRITE_JOB_DB] }, ctx),
    () => {
      const e = cdlIntel.evaluateEligibility(job, driverProfile, { generalExperienceYears: generalExperienceYears(options.userId || 1) });
      db.prepare(`UPDATE seasonal_jobs SET cdl_requirement = ?, cdl_class_required = ?,
                  cdl_evidence = ?, driver_requirements_json = ? WHERE id = ?`)
        .run(e.cdl.requirement, e.cdl.cdlClass, e.cdl.evidence,
             JSON.stringify({ requirements: e.requirements, gaps: e.gaps, unresolved: e.unresolved }), job.id);
      return {
        outcome: e.blockingGaps.length ? 'BLOCK' : (e.unresolved.length ? 'SKIP' : 'PASS'),
        summary: `${e.cdl.label}. ${e.blockingGaps.length} lacuna(s) bloqueante(s), ${e.unresolved.length} em UNKNOWN.`,
        detail: e,
        value: e
      };
    }
  ).value;

  out.eligibility = eligibility;

  // ---- 3. Canais de contato (§40, §44) -----------------------------------
  const channels = step(
    Object.assign({ agent: AGENT.CHANNEL, capabilities: [CAPABILITY.READ_JOB, CAPABILITY.WRITE_MANUAL_ACTION] }, ctx),
    () => {
      const c = channelAgent.classify(job, {
        whatsappCloudApiConfigured: false,
        whatsappConsent: false
      });
      db.prepare('UPDATE seasonal_jobs SET channels_json = ? WHERE id = ?')
        .run(JSON.stringify(c), job.id);
      return {
        outcome: c.automatable ? 'PASS' : 'SKIP',
        summary: `Canal principal: ${c.primary}. Automatizável por e-mail: ${c.automatable ? 'sim' : 'não'}.`,
        detail: c,
        value: c
      };
    }
  ).value;

  out.channels = channels;

  // ---- 4. DECISION ENGINE (§16) ------------------------------------------
  const match = db.prepare('SELECT * FROM seasonal_matches WHERE job_id = ?').get(job.id) || {};

  const decision = step(
    Object.assign({ agent: AGENT.DECISION, capabilities: [CAPABILITY.READ_JOB, CAPABILITY.READ_CONFIG] }, ctx),
    () => {
      const d = decisionEngine.decide({
        fitScore: match.fit_score,
        atsScore: match.ats_score,
        opportunityScore: match.opportunity_score,
        criticalGaps: eligibility.blockingGaps.length,
        unresolvedCritical: eligibility.unresolved.length,
        thresholds: decisionEngine.thresholdsFromConfig(config),
        seasonal: {
          requireTruckMatch: requireTruck,
          truckDriverMatch: truck.pass,
          truckClassification: truck.classification,
          applicationEmailAvailable: channels.email.available && channels.email.explicitlyListed
        }
      });
      db.prepare('UPDATE seasonal_jobs SET decision = ?, decision_reasons_json = ? WHERE id = ?')
        .run(d.decision, JSON.stringify(d.reasons), job.id);
      return {
        outcome: d.decision === decisionEngine.DECISION.APPLY ? 'PASS'
               : d.decision === decisionEngine.DECISION.REVIEW_REQUIRED ? 'SKIP' : 'BLOCK',
        summary: `${d.label}. ${d.reasons.length} regra(s) não atendida(s).`,
        detail: d,
        value: d
      };
    }
  ).value;

  out.decision = decision.decision;
  out.decisionDetail = decision;

  // ---- 5. Ação manual quando não há e-mail (§41, §42) --------------------
  if (!channels.email.available && channels.phone.available) {
    const profile = require('./seasonalService').candidateProfile(options.userId || 1);
    const action = channelAgent.buildManualAction({ job, profile, driverProfile, channels });
    if (action) {
      db.prepare(`INSERT INTO seasonal_manual_actions
        (job_id, kind, channel_value, message, deep_link, instruction)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(job_id, kind) DO UPDATE SET
          channel_value = excluded.channel_value, message = excluded.message,
          deep_link = excluded.deep_link, instruction = excluded.instruction`)
        .run(job.id, action.kind, action.phone, action.message, action.deepLink, action.instruction);
      out.manualAction = action;
    }
  }

  // ---- 6. Estado final da cadeia (§51) -----------------------------------
  let target;
  if (decision.decision === decisionEngine.DECISION.DO_NOT_APPLY) {
    target = 'FILTERED';
  } else if (decision.decision === decisionEngine.DECISION.REVIEW_REQUIRED) {
    target = 'MANUAL_ACTION_REQUIRED';
  } else {
    target = 'MATCHED';
  }

  // A cadeia sempre passa por MATCHED antes de qualquer estado adiante.
  const from = currentState(job.id);
  if (from === 'DISCOVERED' || from === 'NORMALIZED') {
    transition(job.id, 'ANALYZED', { correlationId });
    transition(job.id, 'MATCHED', { correlationId });
  } else if (from === 'FILTERED') {
    // Reprocessamento (ex.: foco ampliado): a máquina de estados só aceita
    // FILTERED → ANALYZED → MATCHED, nunca o salto direto.
    transition(job.id, 'ANALYZED', { correlationId });
    transition(job.id, 'MATCHED', { correlationId });
  } else if (from === 'ANALYZED') {
    transition(job.id, 'MATCHED', { correlationId });
  }

  if (target !== 'MATCHED') transition(job.id, target, { correlationId, note: decision.reasons[0] || null });

  out.state = currentState(job.id);
  return out;
}

/**
 * Roda a cadeia sobre um lote. Usado pelo agendador (§49) e pelo "Atualizar agora".
 * Uma vaga que falha não derruba o lote — o erro fica registrado nela.
 */
function runSeasonalBatch({ limit = 200, userId = 1, jobIds = null, correlationId = null, state = null } = {}) {
  const cid = correlationId || newCorrelationId();
  const config = db.prepare('SELECT * FROM seasonal_config ORDER BY id LIMIT 1').get() || {};
  const driverProfile = require('./driverProfileService').get(userId);

  // `state` restringe o lote a um estado (ex.: reprocessar só as FILTERED
  // depois de o operador ampliar o foco das candidaturas).
  const ids = jobIds || db.prepare(`
    SELECT j.id FROM seasonal_jobs j
    LEFT JOIN seasonal_discarded_jobs d ON j.id = d.job_id
    LEFT JOIN seasonal_applications a ON j.id = a.seasonal_job_id
    WHERE d.id IS NULL AND a.id IS NULL ${state ? 'AND j.application_state = ?' : ''}
    ORDER BY j.collected_at DESC
    LIMIT ?
  `).all(...(state ? [String(state)] : []), Number(limit)).map(r => r.id);

  const summary = {
    correlationId: cid, processed: 0, errors: [],
    truck: { CONFIRMED: 0, PROBABLE: 0, REVIEW: 0, NOT: 0 },
    decisions: { APPLY: 0, REVIEW_REQUIRED: 0, DO_NOT_APPLY: 0 },
    manualActions: 0
  };

  for (const id of ids) {
    try {
      const r = runSeasonalChain(id, { userId, correlationId: cid, config, driverProfile });
      summary.processed++;

      const cls = r.truck.classification;
      if (cls === truckGate.CLASSIFICATION.CONFIRMED) summary.truck.CONFIRMED++;
      else if (cls === truckGate.CLASSIFICATION.PROBABLE) summary.truck.PROBABLE++;
      else if (cls === truckGate.CLASSIFICATION.REVIEW) summary.truck.REVIEW++;
      else summary.truck.NOT++;

      if (r.decision && summary.decisions[r.decision] !== undefined) summary.decisions[r.decision]++;
      if (r.manualAction) summary.manualActions++;
    } catch (err) {
      summary.errors.push({ jobId: id, error: err.message });
    }
  }

  logSeasonal('agent_chain_batch',
    `Cadeia de agentes: ${summary.processed} ordem(ns) processada(s). ` +
    `${summary.truck.CONFIRMED} motorista confirmado, ${summary.truck.PROBABLE} provável, ` +
    `${summary.truck.REVIEW} em revisão, ${summary.truck.NOT} fora do alvo.`,
    summary, summary.errors.length ? 'warn' : 'info', { correlationId: cid });

  return summary;
}

// ---------------------------------------------------------------------------
// Leitura da trilha de auditoria (§72)
// ---------------------------------------------------------------------------

/** Histórico completo de uma candidatura, da descoberta ao estado atual. */
function auditTrail(jobId, limit = 200) {
  const rows = db.prepare(`SELECT * FROM core_agent_runs WHERE job_id = ? ORDER BY id ASC LIMIT ?`)
    .all(Number(jobId), Number(limit));
  return rows.map(r => Object.assign({}, r, {
    detail: safeParse(r.detail_json, null),
    stateFromLabel: r.state_from ? stateMachine.label(r.state_from) : null,
    stateToLabel: r.state_to ? stateMachine.label(r.state_to) : null
  }));
}

function recentRuns({ product = null, limit = 100 } = {}) {
  const where = product ? 'WHERE product = ?' : '';
  const params = product ? [product] : [];
  return db.prepare(`SELECT * FROM core_agent_runs ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, Number(limit));
}

/** Ações manuais pendentes (§41, §57). */
function pendingManualActions(limit = 100) {
  return db.prepare(`
    SELECT a.*, j.job_order_id, j.job_title, j.employer_name, j.employer_state,
           j.timeline_class, j.truck_classification
    FROM seasonal_manual_actions a
    JOIN seasonal_jobs j ON a.job_id = j.id
    WHERE a.status = 'PENDING'
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(Number(limit));
}

function resolveManualAction(id, status = 'DONE') {
  const allowed = ['DONE', 'DISMISSED', 'PENDING'];
  const s = allowed.includes(String(status).toUpperCase()) ? String(status).toUpperCase() : 'DONE';
  db.prepare(`UPDATE seasonal_manual_actions SET status = ?,
              resolved_at = CASE WHEN ? = 'PENDING' THEN NULL ELSE CURRENT_TIMESTAMP END
              WHERE id = ?`).run(s, s, Number(id));
  logSeasonal('manual_action_resolved', `Ação manual #${id} marcada como ${s}.`);
  return { success: true, status: s };
}

/**
 * Verificação de integridade da arquitetura de agentes.
 * Roda no boot e na rota de saúde: se a matriz de permissões for violada por
 * uma edição futura, isso aparece em vez de passar despercebido (§52).
 */
function selfCheck() {
  const separation = permissions.auditSeparation();
  const policyChecks = [
    {
      id: 'indeed_auto_submit_denied',
      expected: 'DENIED',
      actual: policyGate.evaluate({ provider: 'INDEED', action: 'AUTO_SUBMIT' }).outcome
    },
    {
      id: 'gupy_auto_submit_denied_without_official',
      expected: 'DENIED',
      actual: policyGate.evaluate({ provider: 'GUPY', action: 'AUTO_SUBMIT' }).outcome
    },
    {
      id: 'whatsapp_manual_by_default',
      expected: 'DENIED',
      actual: policyGate.evaluate({ provider: 'SEASONAL', action: 'SEND_WHATSAPP',
        application: { employerSupportsWhatsapp: true } }).outcome
    }
  ].map(c => Object.assign(c, { ok: c.expected === c.actual }));

  const failures = policyChecks.filter(c => !c.ok);
  const ok = separation.ok && failures.length === 0;

  if (!ok) {
    logCore('agents', 'self_check_failed',
      'A verificação de integridade dos agentes falhou.',
      { separation: separation.violations, policy: failures }, null, 'error');
  }

  return { ok, separation, policyChecks, version: VERSION };
}

function safeParse(s, f) { try { return JSON.parse(s || ''); } catch (e) { return f; } }

module.exports = {
  VERSION,
  newCorrelationId, recordAgentRun, step,
  currentState, transition,
  runSeasonalChain, runSeasonalBatch,
  auditTrail, recentRuns,
  pendingManualActions, resolveManualAction,
  selfCheck
};
