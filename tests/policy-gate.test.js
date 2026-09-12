/**
 * §52, §53, §71 — POLICY GATE, PERMISSÕES E MÁQUINA DE ESTADOS
 *
 * As regras verificadas aqui não são preferências de implementação. São as
 * proibições da §71, e cada uma protege contra um comportamento específico:
 *
 *   §71.4   Indeed nunca via bot de terceiros
 *   §71.14  o LLM não segura credencial do Gmail
 *   §71.15  só o Gmail Worker envia
 *   §71.18  WhatsApp é manual por padrão
 *   §71.19  telefone listado não é consentimento
 *   §71.25  toda ação externa passa pelo portão
 *
 * Um teste que falhe aqui significa que o sistema passou a poder fazer algo que
 * prometeu não fazer. É o tipo de regressão que não aparece na interface.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const gate = require('../core/agents/policyGate');
const permissions = require('../core/agents/permissions');
const stateMachine = require('../core/agents/stateMachine');
const decision = require('../core/agents/decisionEngine');

const { PROVIDER, ACTION, OUTCOME } = gate;

// ---------------------------------------------------------------------------
// §53 — o exemplo literal do spec
// ---------------------------------------------------------------------------

test('§53, §71.4 — Indeed + AUTO_SUBMIT = DENIED', () => {
  const r = gate.evaluate({ provider: PROVIDER.INDEED, action: ACTION.AUTO_SUBMIT });
  assert.strictEqual(r.outcome, OUTCOME.DENIED);
  assert.ok(r.message.includes('oficiais') || r.message.includes('automática'),
    'a negativa precisa explicar por quê, não só negar');
});

test('§53 — Seasonal + SEND_APPLICATION_EMAIL com tudo em ordem = ALLOWED', () => {
  const r = gate.evaluate({
    provider: PROVIDER.SEASONAL,
    action: ACTION.SEND_APPLICATION_EMAIL,
    application: {
      applicationEmailListed: true,
      truckDriverMatch: true,
      truthValidationPassed: true,
      resumeFromCorrectEnvironment: true,
      alreadyApplied: false,
      quotaAvailable: true
    },
    rules: { emailSendingPaused: false, globalPause: false }
  });

  assert.strictEqual(r.outcome, OUTCOME.ALLOWED);
  assert.ok(r.checks.every(c => c.passed));
});

// ---------------------------------------------------------------------------
// Cada condição da §36 barra sozinha
// ---------------------------------------------------------------------------

const BASE_OK = {
  applicationEmailListed: true, truckDriverMatch: true, truthValidationPassed: true,
  resumeFromCorrectEnvironment: true, alreadyApplied: false, quotaAvailable: true
};

for (const [campo, valor, rotulo] of [
  ['applicationEmailListed', false, 'sem e-mail explicitamente listado'],
  ['truckDriverMatch', false, 'vaga que não é de motorista'],
  ['truthValidationPassed', false, 'Truth Guard reprovado'],
  ['resumeFromCorrectEnvironment', false, 'currículo de outro ambiente'],
  ['alreadyApplied', true, 'candidatura duplicada'],
  ['quotaAvailable', false, 'cota diária esgotada']
]) {
  test(`§36, §53 — ${rotulo} basta para negar o envio`, () => {
    const r = gate.evaluate({
      provider: PROVIDER.SEASONAL,
      action: ACTION.SEND_APPLICATION_EMAIL,
      application: Object.assign({}, BASE_OK, { [campo]: valor })
    });
    assert.strictEqual(r.outcome, OUTCOME.DENIED, `${campo} deveria bloquear`);
  });
}

test('§38, §63 — a pausa de envio bloqueia mesmo com todo o resto em ordem', () => {
  const r = gate.evaluate({
    provider: PROVIDER.SEASONAL, action: ACTION.SEND_APPLICATION_EMAIL,
    application: BASE_OK, rules: { emailSendingPaused: true }
  });
  assert.strictEqual(r.outcome, OUTCOME.DENIED);
});

test('§53 — a pausa GERAL bloqueia qualquer ação externa, de qualquer provedor', () => {
  for (const action of [ACTION.SEND_APPLICATION_EMAIL, ACTION.AUTO_SUBMIT, ACTION.SEND_WHATSAPP]) {
    const r = gate.evaluate({
      provider: PROVIDER.SEASONAL, action, application: BASE_OK, rules: { globalPause: true }
    });
    assert.strictEqual(r.outcome, OUTCOME.DENIED, `${action} passou com a pausa geral ativa`);
    assert.strictEqual(r.code, 'GLOBAL_PAUSE');
  }
});

// ---------------------------------------------------------------------------
// §41, §43 — WhatsApp
// ---------------------------------------------------------------------------

test('§41, §71.19 — telefone disponível NÃO autoriza WhatsApp automático', () => {
  const r = gate.evaluate({
    provider: PROVIDER.SEASONAL, action: ACTION.SEND_WHATSAPP,
    application: { employerSupportsWhatsapp: true }
  });

  assert.strictEqual(r.outcome, OUTCOME.DENIED);
  assert.strictEqual(r.code, 'WHATSAPP_MANUAL_ONLY');
  assert.ok(r.message.includes('manual'));
});

test('§43 — WhatsApp automático exige canal oficial E consentimento E suporte do empregador', () => {
  const completo = {
    provider: PROVIDER.SEASONAL, action: ACTION.SEND_WHATSAPP,
    application: { employerSupportsWhatsapp: true },
    rules: { whatsappCloudApiConfigured: true, whatsappConsent: true }
  };
  assert.strictEqual(gate.evaluate(completo).outcome, OUTCOME.ALLOWED);

  // Retirar qualquer uma das três condições nega.
  assert.strictEqual(gate.evaluate(Object.assign({}, completo, {
    rules: { whatsappCloudApiConfigured: false, whatsappConsent: true }
  })).outcome, OUTCOME.DENIED);

  assert.strictEqual(gate.evaluate(Object.assign({}, completo, {
    rules: { whatsappCloudApiConfigured: true, whatsappConsent: false }
  })).outcome, OUTCOME.DENIED);

  assert.strictEqual(gate.evaluate(Object.assign({}, completo, {
    application: { employerSupportsWhatsapp: false }
  })).outcome, OUTCOME.DENIED);
});

// ---------------------------------------------------------------------------
// §20 — Gupy
// ---------------------------------------------------------------------------

test('§20 — Gupy só submete automaticamente com capacidade oficial declarada', () => {
  assert.strictEqual(
    gate.evaluate({ provider: PROVIDER.GUPY, action: ACTION.AUTO_SUBMIT }).outcome, OUTCOME.DENIED);

  assert.strictEqual(
    gate.evaluate({ provider: PROVIDER.GUPY, action: ACTION.AUTO_SUBMIT,
      rules: { officialSubmissionCapability: true } }).outcome, OUTCOME.ALLOWED);
});

test('§71.4 — nenhuma configuração libera AUTO_SUBMIT no Indeed', () => {
  const r = gate.evaluate({
    provider: PROVIDER.INDEED, action: ACTION.AUTO_SUBMIT,
    rules: { officialSubmissionCapability: true, globalPause: false }
  });
  assert.strictEqual(r.outcome, OUTCOME.DENIED,
    'diferente da Gupy, aqui a proibição não tem chave de escape');
});

test('§46, §71.4 — submissão por navegador é negada nos três produtos', () => {
  for (const p of [PROVIDER.GUPY, PROVIDER.INDEED, PROVIDER.SEASONAL]) {
    assert.strictEqual(gate.evaluate({ provider: p, action: ACTION.BROWSER_SUBMIT }).outcome,
      OUTCOME.DENIED, `${p} permitiu submissão por navegador`);
  }
});

// ---------------------------------------------------------------------------
// Fail-closed
// ---------------------------------------------------------------------------

test('§53 — provedor ou ação desconhecidos são negados por precaução', () => {
  assert.strictEqual(gate.evaluate({ provider: 'LINKEDIN', action: ACTION.AUTO_SUBMIT }).outcome, OUTCOME.DENIED);
  assert.strictEqual(gate.evaluate({ provider: PROVIDER.SEASONAL, action: 'HACK_THE_ATS' }).outcome, OUTCOME.DENIED);
  assert.strictEqual(gate.evaluate({}).outcome, OUTCOME.DENIED);
});

test('§53 — requireAllowed lança erro apresentável quando nega', () => {
  assert.throws(
    () => gate.requireAllowed({ provider: PROVIDER.INDEED, action: ACTION.AUTO_SUBMIT }),
    (err) => err.userFacing === true && err.status === 403 && Boolean(err.policy)
  );
  assert.doesNotThrow(() => gate.requireAllowed({ provider: PROVIDER.GUPY, action: ACTION.PREPARE_APPLICATION }));
});

// ---------------------------------------------------------------------------
// §52 — permissões dos agentes
// ---------------------------------------------------------------------------

test('§52, §71.15 — SOMENTE o Gmail Worker pode enviar e-mail', () => {
  const senders = Object.keys(permissions.GRANTS)
    .filter(a => permissions.can(a, permissions.CAPABILITY.SEND_GMAIL));

  assert.deepStrictEqual(senders, [permissions.AGENT.GMAIL_WORKER]);
});

test('§52 — o Email Agent escreve o rascunho e NÃO envia', () => {
  const email = permissions.AGENT.EMAIL;
  assert.strictEqual(permissions.can(email, permissions.CAPABILITY.WRITE_EMAIL_DRAFT), true);
  assert.strictEqual(permissions.can(email, permissions.CAPABILITY.SEND_GMAIL), false);

  assert.throws(
    () => permissions.requireCapability(email, permissions.CAPABILITY.SEND_GMAIL),
    (err) => err.status === 403 && err.message.includes('SEND_GMAIL')
  );
});

test('§71.14 — nenhum agente que chama o LLM segura credencial de envio', () => {
  for (const agent of Object.keys(permissions.GRANTS)) {
    if (!permissions.can(agent, permissions.CAPABILITY.CALL_LLM)) continue;
    assert.strictEqual(permissions.can(agent, permissions.CAPABILITY.SEND_GMAIL), false,
      `${agent} chama o LLM e pode enviar e-mail`);
  }
});

test('§52 — a auditoria da matriz confirma a separação', () => {
  const a = permissions.auditSeparation();
  assert.strictEqual(a.ok, true, a.violations.join(' | '));
});

test('§52 — agente desconhecido não recebe capacidade por omissão', () => {
  assert.throws(() => permissions.requireCapability('AgenteQueNaoExiste', permissions.CAPABILITY.READ_JOB));
});

// ---------------------------------------------------------------------------
// §51 — máquina de estados
// ---------------------------------------------------------------------------

test('§51 — o caminho feliz do Seasonal é percorrível de ponta a ponta', () => {
  const caminho = ['DISCOVERED', 'NORMALIZED', 'ANALYZED', 'ATS_ANALYZED', 'MATCHED',
                   'APPROVED', 'DOCUMENTS_READY', 'CONTACT_VALIDATED', 'QUEUED', 'SENDING', 'SENT'];

  for (let i = 1; i < caminho.length; i++) {
    const r = stateMachine.canTransition('seasonal', caminho[i - 1], caminho[i]);
    assert.strictEqual(r.allowed, true, `${caminho[i - 1]} → ${caminho[i]}: ${r.reason}`);
  }
});

test('§39, §51 — SENT é terminal: um envio registrado não é desfeito', () => {
  assert.strictEqual(stateMachine.isTerminal('seasonal', 'SENT'), true);
  for (const destino of ['QUEUED', 'FAILED', 'DEFERRED', 'MATCHED']) {
    assert.strictEqual(stateMachine.canTransition('seasonal', 'SENT', destino).allowed, false);
  }
});

test('§51 — transição não declarada é recusada com a lista do que é válido', () => {
  const r = stateMachine.canTransition('seasonal', 'DISCOVERED', 'SENT');
  assert.strictEqual(r.allowed, false);
  assert.ok(r.reason.includes('Válidas'), 'a recusa precisa dizer o que era possível');

  assert.throws(() => stateMachine.assertTransition('seasonal', 'DISCOVERED', 'SENT'));
});

test('§51 — Gupy e Indeed terminam em revisão, nunca em SENT', () => {
  assert.strictEqual(stateMachine.canTransition('board', 'PACKAGE_READY', 'READY_FOR_REVIEW').allowed, true);
  assert.strictEqual(stateMachine.canTransition('board', 'READY_FOR_REVIEW', 'SENT').allowed, false,
    'não existe SENT na máquina dos quadros de vaga — quem submete é o usuário');
});

// ---------------------------------------------------------------------------
// §16 — Decision Engine
// ---------------------------------------------------------------------------

test('§16 — a regra literal do spec: fit>=85, ats>=80, zero lacunas críticas = APPLY', () => {
  const d = decision.decide({
    fitScore: 92, atsScore: 87, opportunityScore: 90,
    criticalGaps: 0, unresolvedCritical: 0,
    seasonal: { truckDriverMatch: true, applicationEmailAvailable: true, truckClassification: 'TRUCK_DRIVER_CONFIRMED' }
  });

  assert.strictEqual(d.decision, decision.DECISION.APPLY);
  assert.strictEqual(d.failedRules.length, 0);
});

test('§16 — sem correspondência de motorista, o Seasonal não candidata', () => {
  const d = decision.decide({
    fitScore: 99, atsScore: 99, opportunityScore: 99, criticalGaps: 0, unresolvedCritical: 0,
    seasonal: { truckDriverMatch: false, applicationEmailAvailable: true, truckClassification: 'NOT_TRUCK_DRIVER' }
  });

  assert.strictEqual(d.decision, decision.DECISION.DO_NOT_APPLY,
    'nota alta não compra passagem para fora do universo de motorista');
});

test('§16 — sem e-mail de candidatura, vai para revisão, não para o lixo', () => {
  const d = decision.decide({
    fitScore: 92, atsScore: 87, opportunityScore: 90, criticalGaps: 0, unresolvedCritical: 0,
    seasonal: { truckDriverMatch: true, applicationEmailAvailable: false, truckClassification: 'TRUCK_DRIVER_CONFIRMED' }
  });

  assert.strictEqual(d.decision, decision.DECISION.REVIEW_REQUIRED);
});

test('§17 — Truth Guard reprovado bloqueia, qualquer que seja a pontuação', () => {
  const d = decision.decide({
    fitScore: 99, atsScore: 99, opportunityScore: 99, criticalGaps: 0, unresolvedCritical: 0,
    truthGuardPassed: false,
    seasonal: { truckDriverMatch: true, applicationEmailAvailable: true }
  });

  assert.strictEqual(d.decision, decision.DECISION.DO_NOT_APPLY);
});

test('§18, §54 — requisito crítico em UNKNOWN produz revisão, não recusa', () => {
  const d = decision.decide({
    fitScore: 92, atsScore: 87, opportunityScore: 90,
    criticalGaps: 0, unresolvedCritical: 2,
    seasonal: { truckDriverMatch: true, applicationEmailAvailable: true }
  });

  assert.strictEqual(d.decision, decision.DECISION.REVIEW_REQUIRED);
});

test('§16 — toda decisão devolve regra, valor observado e limiar', () => {
  const d = decision.decide({ fitScore: 70, atsScore: 60, opportunityScore: 65, criticalGaps: 0 });

  assert.ok(d.rules.length > 0);
  for (const r of d.rules) {
    assert.ok(typeof r.id === 'string' && typeof r.label === 'string');
    assert.ok('observed' in r && 'threshold' in r);
  }
  assert.ok(d.reasons.every(x => typeof x === 'string' && x.length > 0));
});

test('§16 — os limiares vêm da configuração, não do código', () => {
  const t = decision.thresholdsFromConfig({
    auto_queue_fit_threshold: 70, auto_queue_ats_threshold: 60, auto_queue_opportunity_threshold: 65
  });

  assert.strictEqual(t.fit, 70);
  assert.strictEqual(t.ats, 60);

  const d = decision.decide({
    fitScore: 72, atsScore: 62, opportunityScore: 66, criticalGaps: 0, unresolvedCritical: 0,
    thresholds: t,
    seasonal: { truckDriverMatch: true, applicationEmailAvailable: true }
  });
  assert.strictEqual(d.decision, decision.DECISION.APPLY,
    'a mesma pontuação que reprovaria no padrão aprova com o limiar configurado');
});
