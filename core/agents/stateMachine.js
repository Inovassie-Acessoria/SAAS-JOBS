/**
 * Máquina de estados das candidaturas (spec de agentes §51, §72).
 *
 * A §50 diz que o PostgreSQL — aqui, o SQLite — é a fonte da verdade e que
 * nenhum estado crítico vive na memória conversacional do LLM. A §72 exige que
 * toda candidatura seja auditável da descoberta ao estado final.
 *
 * Para isso o estado precisa ser um valor conhecido, e a transição precisa ser
 * verificável. Transição não declarada é erro, não improviso.
 */

const VERSION = 'state-machine-v1';

/** Estados do Seasonal (§51). */
const SEASONAL_STATE = {
  DISCOVERED: 'DISCOVERED',
  NORMALIZED: 'NORMALIZED',
  FILTERED: 'FILTERED',
  ANALYZED: 'ANALYZED',
  ATS_ANALYZED: 'ATS_ANALYZED',
  MATCHED: 'MATCHED',
  APPROVED: 'APPROVED',
  DOCUMENTS_READY: 'DOCUMENTS_READY',
  CONTACT_VALIDATED: 'CONTACT_VALIDATED',
  QUEUED: 'QUEUED',
  SENDING: 'SENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  DEFERRED: 'DEFERRED',
  MANUAL_ACTION_REQUIRED: 'MANUAL_ACTION_REQUIRED'
};

/** Estados de Gupy e Indeed (§51). */
const BOARD_STATE = {
  DISCOVERED: 'DISCOVERED',
  FILTERED: 'FILTERED',
  ANALYZED: 'ANALYZED',
  ATS_ANALYZED: 'ATS_ANALYZED',
  MATCHED: 'MATCHED',
  APPROVED: 'APPROVED',
  PACKAGE_READY: 'PACKAGE_READY',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  DISCARDED: 'DISCARDED'
};

const SEASONAL_TRANSITIONS = {
  // ANALYZED é alcançável direto de DISCOVERED porque a importação normaliza e
  // pontua no mesmo passo: quando a cadeia de agentes chega, a normalização já
  // aconteceu. Exigir a passagem explícita por NORMALIZED seria burocracia sem
  // informação — o estado precisa refletir o que o sistema realmente faz.
  DISCOVERED: ['NORMALIZED', 'FILTERED', 'ANALYZED', 'MANUAL_ACTION_REQUIRED'],
  NORMALIZED: ['FILTERED', 'ANALYZED', 'MANUAL_ACTION_REQUIRED'],
  FILTERED: ['ANALYZED', 'MANUAL_ACTION_REQUIRED'],
  ANALYZED: ['ATS_ANALYZED', 'MATCHED', 'MANUAL_ACTION_REQUIRED'],
  ATS_ANALYZED: ['MATCHED', 'MANUAL_ACTION_REQUIRED'],
  MATCHED: ['APPROVED', 'MANUAL_ACTION_REQUIRED', 'FILTERED'],
  APPROVED: ['DOCUMENTS_READY', 'MANUAL_ACTION_REQUIRED'],
  DOCUMENTS_READY: ['CONTACT_VALIDATED', 'MANUAL_ACTION_REQUIRED', 'FAILED'],
  CONTACT_VALIDATED: ['QUEUED', 'MANUAL_ACTION_REQUIRED'],
  QUEUED: ['SENDING', 'DEFERRED', 'MANUAL_ACTION_REQUIRED'],
  SENDING: ['SENT', 'FAILED', 'DEFERRED'],
  DEFERRED: ['QUEUED', 'SENDING', 'FAILED'],
  FAILED: ['QUEUED', 'MANUAL_ACTION_REQUIRED'],
  MANUAL_ACTION_REQUIRED: ['QUEUED', 'FILTERED', 'MATCHED', 'APPROVED'],
  SENT: []   // terminal — um envio registrado nunca é desfeito (§39)
};

const BOARD_TRANSITIONS = {
  DISCOVERED: ['FILTERED', 'ANALYZED', 'DISCARDED'],
  FILTERED: ['ANALYZED', 'DISCARDED'],
  ANALYZED: ['ATS_ANALYZED', 'MATCHED', 'DISCARDED'],
  ATS_ANALYZED: ['MATCHED', 'DISCARDED'],
  MATCHED: ['APPROVED', 'DISCARDED'],
  APPROVED: ['PACKAGE_READY', 'DISCARDED'],
  PACKAGE_READY: ['READY_FOR_REVIEW', 'DISCARDED'],
  READY_FOR_REVIEW: ['DISCARDED'],
  DISCARDED: ['DISCOVERED']   // o usuário pode restaurar uma vaga descartada
};

const TERMINAL = {
  seasonal: ['SENT'],
  board: []
};

const LABEL = {
  DISCOVERED: 'Descoberta',
  NORMALIZED: 'Normalizada',
  FILTERED: 'Filtrada',
  ANALYZED: 'Analisada',
  ATS_ANALYZED: 'ATS calculado',
  MATCHED: 'Pontuada',
  APPROVED: 'Aprovada',
  DOCUMENTS_READY: 'Documentos prontos',
  CONTACT_VALIDATED: 'Contato validado',
  PACKAGE_READY: 'Pacote pronto',
  READY_FOR_REVIEW: 'Pronta para revisão',
  QUEUED: 'Na fila',
  SENDING: 'Enviando',
  SENT: 'Enviada',
  FAILED: 'Falhou',
  DEFERRED: 'Adiada',
  DISCARDED: 'Descartada',
  MANUAL_ACTION_REQUIRED: 'Ação manual necessária'
};

function machineFor(kind) {
  return kind === 'seasonal'
    ? { states: SEASONAL_STATE, transitions: SEASONAL_TRANSITIONS, terminal: TERMINAL.seasonal }
    : { states: BOARD_STATE, transitions: BOARD_TRANSITIONS, terminal: TERMINAL.board };
}

/** A transição é declarada? (§51) */
function canTransition(kind, from, to) {
  const m = machineFor(kind);
  if (!m.states[to]) return { allowed: false, reason: `Estado "${to}" não existe na máquina do ${kind}.` };
  if (from === null || from === undefined) {
    const isEntry = to === 'DISCOVERED';
    return isEntry
      ? { allowed: true, reason: null }
      : { allowed: false, reason: `Sem estado anterior, a única entrada válida é DISCOVERED (recebido "${to}").` };
  }
  if (!m.states[from]) return { allowed: false, reason: `Estado de origem "${from}" não existe na máquina do ${kind}.` };
  if (from === to) return { allowed: true, reason: 'Estado inalterado.' };
  if (m.terminal.includes(from)) {
    return { allowed: false, reason: `${from} é terminal: não há transição a partir dele (§39).` };
  }
  const allowed = (m.transitions[from] || []).includes(to);
  return allowed
    ? { allowed: true, reason: null }
    : { allowed: false, reason: `Transição ${from} → ${to} não é declarada. Válidas: ${(m.transitions[from] || []).join(', ') || 'nenhuma'}.` };
}

/** Lança quando a transição não é válida — o chamador não precisa checar. */
function assertTransition(kind, from, to) {
  const r = canTransition(kind, from, to);
  if (!r.allowed) {
    const err = new Error(`Transição de estado inválida: ${r.reason}`);
    err.userFacing = false;
    err.stateMachine = { kind, from, to };
    throw err;
  }
  return r;
}

function nextStates(kind, from) {
  const m = machineFor(kind);
  if (from === null || from === undefined) return ['DISCOVERED'];
  return m.transitions[from] || [];
}

function isTerminal(kind, state) {
  return machineFor(kind).terminal.includes(state);
}

function label(state) {
  return LABEL[state] || state;
}

module.exports = {
  VERSION,
  SEASONAL_STATE, BOARD_STATE,
  SEASONAL_TRANSITIONS, BOARD_TRANSITIONS,
  LABEL, label,
  machineFor, canTransition, assertTransition, nextStates, isTerminal
};
