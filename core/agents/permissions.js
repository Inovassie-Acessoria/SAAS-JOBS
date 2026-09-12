/**
 * Permissões por agente (spec de agentes §52, §37, §71.14, §71.15).
 *
 * "Do not let every agent access every capability." A separação que mais importa
 * está na §52 e na §37, e é a mesma ideia dita duas vezes:
 *
 *     O Email Agent NÃO pode enviar e-mail.
 *     Só o Gmail Worker envia — e o LLM nunca toca nas credenciais.
 *
 * O Email Agent escreve um rascunho estruturado, grava no banco, e ali a
 * responsabilidade dele termina. Um validador determinístico aprova, a fila
 * recebe, e o Gmail Worker — que é a única peça com SEND_GMAIL — envia.
 *
 * Este módulo é a declaração dessa fronteira e o verificador dela.
 */

const VERSION = 'agent-permissions-v1';

const CAPABILITY = {
  READ_EXTERNAL_JOBS: 'READ_EXTERNAL_JOBS',
  WRITE_JOB_DB: 'WRITE_JOB_DB',
  READ_JOB: 'READ_JOB',
  READ_PLATFORM_RESUME: 'READ_PLATFORM_RESUME',
  READ_SEASONAL_PROFILE: 'READ_SEASONAL_PROFILE',
  WRITE_ATS_ANALYSIS: 'WRITE_ATS_ANALYSIS',
  WRITE_MATCH: 'WRITE_MATCH',
  WRITE_EMAIL_DRAFT: 'WRITE_EMAIL_DRAFT',
  READ_APPROVED_EMAIL: 'READ_APPROVED_EMAIL',
  SEND_GMAIL: 'SEND_GMAIL',
  WRITE_PROVIDER_RESULT: 'WRITE_PROVIDER_RESULT',
  WRITE_PACKAGE: 'WRITE_PACKAGE',
  WRITE_QUEUE: 'WRITE_QUEUE',
  WRITE_MANUAL_ACTION: 'WRITE_MANUAL_ACTION',
  CALL_LLM: 'CALL_LLM',
  READ_CONFIG: 'READ_CONFIG'
};

const AGENT = {
  DISCOVERY: 'DiscoveryAgent',
  PARSER: 'JobParserAgent',
  HARD_FILTER: 'HardFilterEngine',
  ATS: 'ATSAgent',
  MATCH: 'MatchAgent',
  OPPORTUNITY: 'OpportunityAgent',
  TRUCK_GATE: 'TruckDriverGate',
  TIMELINE: 'TimelineAgent',
  DECISION: 'DecisionEngine',
  TRUTH_GUARD: 'TruthGuard',
  COVER_LETTER: 'CoverLetterAgent',
  EMAIL: 'EmailAgent',
  DOCUMENT: 'DocumentAgent',
  CHANNEL: 'CommunicationChannelAgent',
  VALIDATION: 'EmailValidationAgent',
  PACKAGE: 'ApplicationPackageAgent',
  GMAIL_WORKER: 'GmailWorker',
  ORCHESTRATOR: 'JobOrchestrator'
};

/**
 * A matriz. O que não está listado é negado — não há capacidade implícita.
 */
const GRANTS = {
  [AGENT.DISCOVERY]: [
    CAPABILITY.READ_EXTERNAL_JOBS,
    CAPABILITY.WRITE_JOB_DB,
    CAPABILITY.READ_CONFIG
  ],
  [AGENT.PARSER]: [
    CAPABILITY.READ_JOB,
    CAPABILITY.WRITE_JOB_DB,
    CAPABILITY.CALL_LLM
  ],
  [AGENT.HARD_FILTER]: [
    CAPABILITY.READ_JOB,
    CAPABILITY.READ_CONFIG
  ],
  [AGENT.ATS]: [
    CAPABILITY.READ_JOB,
    CAPABILITY.READ_PLATFORM_RESUME,
    CAPABILITY.WRITE_ATS_ANALYSIS
  ],
  [AGENT.MATCH]: [
    CAPABILITY.READ_JOB,
    CAPABILITY.READ_PLATFORM_RESUME,
    CAPABILITY.WRITE_MATCH,
    CAPABILITY.CALL_LLM
  ],
  [AGENT.OPPORTUNITY]: [
    CAPABILITY.READ_JOB,
    CAPABILITY.WRITE_MATCH,
    CAPABILITY.READ_CONFIG
  ],
  [AGENT.TRUCK_GATE]: [
    CAPABILITY.READ_JOB,
    CAPABILITY.WRITE_JOB_DB
  ],
  [AGENT.TIMELINE]: [
    CAPABILITY.READ_JOB,
    CAPABILITY.WRITE_JOB_DB,
    CAPABILITY.READ_CONFIG
  ],
  [AGENT.DECISION]: [
    CAPABILITY.READ_JOB,
    CAPABILITY.READ_CONFIG
  ],
  [AGENT.TRUTH_GUARD]: [
    CAPABILITY.READ_JOB,
    CAPABILITY.READ_SEASONAL_PROFILE,
    CAPABILITY.READ_PLATFORM_RESUME
  ],
  [AGENT.COVER_LETTER]: [
    CAPABILITY.READ_JOB,
    CAPABILITY.READ_SEASONAL_PROFILE,
    CAPABILITY.READ_PLATFORM_RESUME,
    CAPABILITY.CALL_LLM
  ],
  // §52: o Email Agent escreve o rascunho. Ele NÃO tem SEND_GMAIL.
  [AGENT.EMAIL]: [
    CAPABILITY.READ_JOB,
    CAPABILITY.READ_SEASONAL_PROFILE,
    CAPABILITY.WRITE_EMAIL_DRAFT,
    CAPABILITY.CALL_LLM
  ],
  [AGENT.DOCUMENT]: [
    CAPABILITY.READ_JOB,
    CAPABILITY.READ_PLATFORM_RESUME
  ],
  [AGENT.CHANNEL]: [
    CAPABILITY.READ_JOB,
    CAPABILITY.WRITE_MANUAL_ACTION
  ],
  [AGENT.VALIDATION]: [
    CAPABILITY.READ_JOB,
    CAPABILITY.READ_APPROVED_EMAIL,
    CAPABILITY.READ_PLATFORM_RESUME,
    CAPABILITY.READ_CONFIG,
    CAPABILITY.WRITE_QUEUE
  ],
  [AGENT.PACKAGE]: [
    CAPABILITY.READ_JOB,
    CAPABILITY.READ_PLATFORM_RESUME,
    CAPABILITY.READ_SEASONAL_PROFILE,
    CAPABILITY.WRITE_PACKAGE,
    CAPABILITY.WRITE_QUEUE
  ],
  // §37, §71.15: o único componente autorizado a enviar.
  [AGENT.GMAIL_WORKER]: [
    CAPABILITY.READ_APPROVED_EMAIL,
    CAPABILITY.SEND_GMAIL,
    CAPABILITY.WRITE_PROVIDER_RESULT,
    CAPABILITY.WRITE_QUEUE
  ],
  [AGENT.ORCHESTRATOR]: [
    CAPABILITY.READ_JOB,
    CAPABILITY.READ_CONFIG,
    CAPABILITY.WRITE_JOB_DB
  ]
};

/** Capacidades que nenhum agente que fala com LLM pode ter (§37, §71.14). */
const FORBIDDEN_WITH_LLM = [CAPABILITY.SEND_GMAIL];

function grantsFor(agent) {
  return GRANTS[agent] || [];
}

function can(agent, capability) {
  return grantsFor(agent).includes(capability);
}

/**
 * Verifica uma capacidade. Lança quando o agente não a possui — é assim que a
 * fronteira vira erro em tempo de execução, e não comentário em documento.
 */
function requireCapability(agent, capability) {
  if (!GRANTS[agent]) {
    const err = new Error(`Agente desconhecido: "${agent}". Nenhuma capacidade é concedida por padrão (§52).`);
    err.permission = { agent, capability };
    throw err;
  }
  if (!can(agent, capability)) {
    const err = new Error(
      `${agent} não tem a capacidade ${capability} (§52). ` +
      `Concedidas: ${grantsFor(agent).join(', ') || 'nenhuma'}.`
    );
    err.permission = { agent, capability, granted: grantsFor(agent) };
    err.status = 403;
    throw err;
  }
  return true;
}

/**
 * Auditoria da matriz: confirma que a separação exigida pela spec se mantém.
 * É chamada pelos testes e pela rota de saúde — a violação precisa aparecer.
 */
function auditSeparation() {
  const violations = [];

  // §52 — o Email Agent não pode enviar.
  if (can(AGENT.EMAIL, CAPABILITY.SEND_GMAIL)) {
    violations.push('O Email Agent recebeu SEND_GMAIL. A §52 proíbe: ele escreve o rascunho, não envia.');
  }

  // §37/§71.15 — só um componente envia.
  const senders = Object.keys(GRANTS).filter(a => can(a, CAPABILITY.SEND_GMAIL));
  if (senders.length !== 1 || senders[0] !== AGENT.GMAIL_WORKER) {
    violations.push(
      `Exatamente um agente pode ter SEND_GMAIL (o ${AGENT.GMAIL_WORKER}). Encontrados: ${senders.join(', ') || 'nenhum'}.`
    );
  }

  // §71.14 — quem fala com o LLM não segura credencial de envio.
  for (const agent of Object.keys(GRANTS)) {
    if (!can(agent, CAPABILITY.CALL_LLM)) continue;
    for (const forbidden of FORBIDDEN_WITH_LLM) {
      if (can(agent, forbidden)) {
        violations.push(`${agent} chama o LLM e tem ${forbidden}. A §71.14 separa as duas coisas.`);
      }
    }
  }

  return { ok: violations.length === 0, violations, version: VERSION };
}

module.exports = {
  VERSION, CAPABILITY, AGENT, GRANTS, FORBIDDEN_WITH_LLM,
  grantsFor, can, requireCapability, auditSeparation
};
