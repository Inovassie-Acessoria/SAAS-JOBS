/**
 * Decision Engine — a decisão final APPLY / REVIEW / IGNORE (spec de agentes §16).
 *
 * A §16 é explícita: esta decisão NÃO é opinião livre de um LLM. É regra
 * configurável, determinística e auditável. O LLM pode explicar a vaga; quem
 * decide se ela vira candidatura é este arquivo.
 *
 * Regra base:
 *
 *     SE  fit >= 85  E  ats >= 80  E  critical_mandatory_gaps == 0
 *     ENTÃO APPLY
 *
 * O Seasonal acrescenta duas condições próprias (§16):
 *
 *     truck_driver_match == true
 *     application_email_available == true
 *
 * Toda decisão devolve as regras que foram avaliadas, com o valor observado e o
 * limiar aplicado. Nenhum "não sei por quê" sai daqui.
 */

const VERSION = 'decision-v1';

const DECISION = {
  APPLY: 'APPLY',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  DO_NOT_APPLY: 'DO_NOT_APPLY'
};

const DECISION_LABEL = {
  APPLY: 'Candidatar',
  REVIEW_REQUIRED: 'Revisar antes de decidir',
  DO_NOT_APPLY: 'Não candidatar'
};

/** Limiares padrão — sobrescritos pela configuração do produto (§16). */
const DEFAULT_THRESHOLDS = {
  fit: 85,
  ats: 80,
  opportunity: 85,
  maxCriticalGaps: 0,
  /** Abaixo destes valores a vaga é descartada em vez de ir para revisão. */
  fitFloor: 55,
  atsFloor: 50,
  /** Margem em que um score "quase lá" vira revisão em vez de recusa. */
  borderline: 8
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Avalia uma regra e registra o resultado de forma legível.
 * `severity` define o que a falha causa: BLOCK descarta, REVIEW manda revisar.
 */
function rule(id, label, passed, { observed = null, threshold = null, severity = 'REVIEW', detail = null } = {}) {
  return { id, label, passed: Boolean(passed), observed, threshold, severity, detail };
}

/**
 * Decide sobre uma vaga já analisada.
 *
 * @param {object} input
 * @param {number|null} input.fitScore
 * @param {number|null} input.atsScore
 * @param {number|null} input.opportunityScore
 * @param {number} [input.criticalGaps]        requisitos obrigatórios não atendidos
 * @param {number} [input.unresolvedCritical]  requisitos críticos em UNKNOWN (§18)
 * @param {object} [input.thresholds]
 * @param {object} [input.seasonal]            condições extras do Seasonal (§16)
 * @param {boolean} [input.seasonal.requireTruckMatch] false = foco amplo (a ocupação não bloqueia)
 * @param {boolean} [input.seasonal.truckDriverMatch]
 * @param {boolean} [input.seasonal.applicationEmailAvailable]
 * @param {string}  [input.seasonal.truckClassification]
 * @param {boolean} [input.truthGuardPassed]   resultado do Truth Guard (§17)
 * @param {string}  [input.policyDecision]     saída do Policy Gate (§53)
 */
function decide(input = {}) {
  const t = Object.assign({}, DEFAULT_THRESHOLDS, input.thresholds || {});
  const rules = [];

  const fit = num(input.fitScore);
  const ats = num(input.atsScore);
  const opportunity = num(input.opportunityScore);
  const criticalGaps = Number(input.criticalGaps || 0);
  const unresolved = Number(input.unresolvedCritical || 0);

  // ---- Condições do Seasonal, quando aplicáveis (§16) ---------------------
  if (input.seasonal) {
    const s = input.seasonal;

    // Foco amplo (requireTruckMatch === false): a ocupação não decide nada —
    // a regra passa e registra só a classificação, para auditoria.
    const broad = s.requireTruckMatch === false;
    rules.push(rule(
      'truck_driver_match',
      broad ? 'Foco amplo: qualquer ocupação H-2A/H-2B' : 'A vaga é de motorista de caminhão',
      broad || s.truckDriverMatch === true,
      {
        observed: s.truckClassification || String(s.truckDriverMatch),
        severity: s.truckClassification === 'REVIEW_REQUIRED' ? 'REVIEW' : 'BLOCK',
        detail: broad
          ? 'O operador escolheu candidatar-se a todas as vagas; o portão de caminhão só informa.'
          : 'Seasonal Jobs existe para vagas de motorista de caminhão (§24).'
      }
    ));

    rules.push(rule(
      'application_email_available',
      'A vaga informa e-mail de candidatura',
      s.applicationEmailAvailable === true,
      {
        observed: s.applicationEmailAvailable ? 'sim' : 'não',
        severity: 'REVIEW',
        detail: 'Sem e-mail explícito a candidatura automática não pode ocorrer — vira ação manual (§40, §41).'
      }
    ));
  }

  // ---- Truth Guard (§17) — bloqueio absoluto -----------------------------
  if (input.truthGuardPassed !== undefined) {
    rules.push(rule(
      'truth_guard',
      'O texto gerado passou no Truth Guard',
      input.truthGuardPassed === true,
      { observed: input.truthGuardPassed ? 'PASSED' : 'FAILED', severity: 'BLOCK',
        detail: 'Nenhum texto sem lastro no perfil sai do sistema (§17).' }
    ));
  }

  // ---- Policy Gate (§53) — bloqueio absoluto -----------------------------
  if (input.policyDecision !== undefined) {
    rules.push(rule(
      'policy_gate',
      'A ação externa é permitida pela política',
      input.policyDecision === 'ALLOWED',
      { observed: input.policyDecision, severity: 'BLOCK',
        detail: 'Toda ação externa passa pelo Policy Gate (§53).' }
    ));
  }

  // ---- Requisitos obrigatórios -------------------------------------------
  rules.push(rule(
    'critical_gaps',
    'Nenhum requisito obrigatório em aberto',
    criticalGaps <= t.maxCriticalGaps,
    { observed: criticalGaps, threshold: t.maxCriticalGaps, severity: 'BLOCK' }
  ));

  rules.push(rule(
    'unresolved_critical',
    'Nenhum requisito crítico desconhecido',
    unresolved === 0,
    { observed: unresolved, threshold: 0, severity: 'REVIEW',
      detail: 'O que o perfil não sabe permanece UNKNOWN e exige decisão humana (§18, §54).' }
  ));

  // ---- Scores -------------------------------------------------------------
  if (fit === null) {
    rules.push(rule('fit_score', 'Fit Score calculado', false,
      { observed: null, threshold: t.fit, severity: 'REVIEW', detail: 'A vaga ainda não foi pontuada.' }));
  } else {
    rules.push(rule('fit_score', `Fit Score >= ${t.fit}`, fit >= t.fit,
      { observed: fit, threshold: t.fit, severity: fit < t.fitFloor ? 'BLOCK' : 'REVIEW' }));
  }

  // ATS ausente não reprova: pode não haver currículo analisado ainda.
  if (ats !== null) {
    rules.push(rule('ats_score', `ATS Compatibility >= ${t.ats}`, ats >= t.ats,
      { observed: ats, threshold: t.ats, severity: ats < t.atsFloor ? 'BLOCK' : 'REVIEW' }));
  } else {
    rules.push(rule('ats_score', 'ATS Compatibility disponível', false,
      { observed: null, threshold: t.ats, severity: 'REVIEW',
        detail: 'Sem currículo analisado nesta plataforma não há ATS (§11).' }));
  }

  if (opportunity !== null && t.opportunity) {
    rules.push(rule('opportunity_score', `Opportunity Score >= ${t.opportunity}`,
      opportunity >= t.opportunity,
      { observed: opportunity, threshold: t.opportunity, severity: 'REVIEW' }));
  }

  // ---- Consolidação -------------------------------------------------------
  const failed = rules.filter(r => !r.passed);
  const blocking = failed.filter(r => r.severity === 'BLOCK');
  const reviewable = failed.filter(r => r.severity === 'REVIEW');

  let decision;
  if (blocking.length) decision = DECISION.DO_NOT_APPLY;
  else if (reviewable.length) decision = DECISION.REVIEW_REQUIRED;
  else decision = DECISION.APPLY;

  // Um score na fronteira do limiar merece ser dito, mesmo quando aprova (§31).
  const borderline = [];
  for (const [id, value, threshold] of [['fit_score', fit, t.fit], ['ats_score', ats, t.ats],
                                        ['opportunity_score', opportunity, t.opportunity]]) {
    if (value === null || !threshold) continue;
    if (Math.abs(value - threshold) <= t.borderline) {
      borderline.push({ id, observed: value, threshold });
    }
  }

  const reasons = failed.map(r =>
    `${r.label}: observado ${r.observed === null ? 'indisponível' : r.observed}` +
    (r.threshold !== null ? ` (limiar ${r.threshold})` : '') +
    (r.detail ? ` — ${r.detail}` : '')
  );

  return {
    decision,
    label: DECISION_LABEL[decision],
    rules,
    failedRules: failed,
    blockingRules: blocking,
    reviewRules: reviewable,
    borderline,
    reasons,
    thresholds: t,
    version: VERSION
  };
}

/**
 * Carrega os limiares a partir da configuração persistida do produto.
 * Mantém os padrões quando a configuração não define o campo (§16).
 */
function thresholdsFromConfig(config = {}) {
  const pick = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return Object.assign({}, DEFAULT_THRESHOLDS, {
    fit: pick(config.auto_queue_fit_threshold, DEFAULT_THRESHOLDS.fit),
    ats: pick(config.auto_queue_ats_threshold, DEFAULT_THRESHOLDS.ats),
    opportunity: pick(config.auto_queue_opportunity_threshold, DEFAULT_THRESHOLDS.opportunity)
  });
}

module.exports = {
  VERSION, DECISION, DECISION_LABEL, DEFAULT_THRESHOLDS,
  decide, thresholdsFromConfig
};
