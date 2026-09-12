/**
 * §28, §29 — INTELIGÊNCIA DE CDL E REQUISITOS DE MOTORISTA
 *
 * A §28 diz que estas três coisas NÃO são equivalentes:
 *
 *   CDL REQUIRED BEFORE HIRE
 *   CDL CAN BE OBTAINED AFTER HIRE
 *   CDL PREFERRED
 *
 * e que confundi-las "pode afetar materialmente a elegibilidade". É verdade nas
 * duas direções: tratar "pode obter depois" como exigência descarta vaga boa;
 * tratar exigência como preferência gera candidatura que o empregador descarta.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const cdl = require('../core/agents/cdlIntelligence');
const { CDL_REQUIREMENT } = cdl;

const req = (text) => cdl.analyzeCdl({ special_requirements: text });

// ---------------------------------------------------------------------------
// As três distinções da §28
// ---------------------------------------------------------------------------

test('§28 — "must have a valid CDL" é exigência ANTES da contratação', () => {
  const r = req('Applicants must have a valid CDL Class A at time of hire.');
  assert.strictEqual(r.requirement, CDL_REQUIREMENT.REQUIRED_BEFORE_HIRE);
  assert.strictEqual(r.blocking, true);
  assert.strictEqual(r.cdlClass, 'A');
  assert.ok(r.evidence, 'a classificação precisa vir com o trecho que a sustenta');
});

test('§28 — "may obtain CDL after hire" NÃO é exigência prévia', () => {
  const r = req('Worker may obtain CDL after hire; employer will pay for training.');
  assert.strictEqual(r.requirement, CDL_REQUIREMENT.OBTAINABLE_AFTER_HIRE);
  assert.strictEqual(r.blocking, false, 'isto não pode eliminar o candidato');
});

test('§28 — "must obtain a CDL within 30 days" é obtenção posterior, não exigência prévia', () => {
  const r = req('Employee must obtain a CDL within 30 days of employment.');
  assert.strictEqual(r.requirement, CDL_REQUIREMENT.OBTAINABLE_AFTER_HIRE,
    'a frase casa com "must" e com "obtain depois" — a leitura correta é a segunda');
  assert.strictEqual(r.blocking, false);
});

test('§28 — "CDL preferred" pesa mas não bloqueia', () => {
  const r = req('CDL preferred but not required. Clean driving record expected.');
  assert.strictEqual(r.requirement, CDL_REQUIREMENT.PREFERRED);
  assert.strictEqual(r.blocking, false);
});

test('§28 — "no CDL required" é dispensa explícita', () => {
  const r = req('No CDL required. Farm vehicles only.');
  assert.strictEqual(r.requirement, CDL_REQUIREMENT.NOT_REQUIRED);
});

test('§28 — vaga que não menciona CDL não vira exigência inventada', () => {
  const r = req('Must be able to lift 50 lbs and work outdoors in all weather.');
  assert.strictEqual(r.requirement, CDL_REQUIREMENT.NOT_MENTIONED);
  assert.strictEqual(r.mentioned, false);
});

test('§18, §28 — cita CDL sem dizer em que termos vira UNKNOWN, não exigência', () => {
  const r = req('CDL. Housing provided. Transportation reimbursed.');
  assert.strictEqual(r.requirement, CDL_REQUIREMENT.UNKNOWN,
    'sem construção que qualifique, o sistema não escolhe uma interpretação');
});

test('§28 — endossos são extraídos com a evidência', () => {
  const r = req('Valid CDL Class A required with tanker and hazmat endorsements.');
  const codes = r.endorsements.map(e => e.code).sort();
  assert.deepStrictEqual(codes, ['H', 'N']);
  assert.ok(r.endorsements.every(e => e.evidence));
});

// ---------------------------------------------------------------------------
// §29 — os demais requisitos
// ---------------------------------------------------------------------------

test('§29 — os requisitos de motorista listados são extraídos', () => {
  const r = cdl.extractDriverRequirements({
    special_requirements:
      'Must have a clean driving record. Pre-employment drug testing required. ' +
      'DOT physical examination required. Manual transmission experience required. ' +
      'Minimum 2 years driving experience. Must be able to lift 75 lbs. ' +
      'Must speak English. Background check required.'
  });

  const ids = r.requirements.map(x => x.id);
  for (const esperado of ['clean_driving_record', 'drug_testing', 'physical_requirements',
                          'manual_transmission', 'minimum_experience', 'lifting',
                          'english_requirement', 'background_check']) {
    assert.ok(ids.includes(esperado), `faltou extrair: ${esperado}`);
  }
});

test('§29 — a quantidade exigida é extraída, não só a presença do requisito', () => {
  const r = cdl.extractDriverRequirements({
    special_requirements: 'Minimum 3 years of truck driving experience. Must lift 100 lbs.'
  });

  const exp = r.requirements.find(x => x.id === 'minimum_experience');
  assert.deepStrictEqual(exp.amount, { amount: 3, unit: 'years' });

  const lift = r.requirements.find(x => x.id === 'lifting');
  assert.deepStrictEqual(lift.amount, { amount: 100, unit: 'lbs' });
});

test('§29 — requisito ausente do texto nunca é inventado', () => {
  const r = cdl.extractDriverRequirements({ special_requirements: 'Housing provided.' });
  assert.strictEqual(r.requirements.length, 0);
});

// ---------------------------------------------------------------------------
// Elegibilidade — o cruzamento com o perfil (§18)
// ---------------------------------------------------------------------------

const JOB_CDL_OBRIGATORIA = {
  job_title: 'Heavy Truck Driver',
  special_requirements: 'Valid CDL Class A required. Clean driving record. Minimum 2 years driving experience.'
};

test('§18 — perfil UNKNOWN não vira "não atende": vira UNRESOLVED', () => {
  const r = cdl.evaluateEligibility(JOB_CDL_OBRIGATORIA, {
    cdl_status: 'UNKNOWN', cdl_class: 'UNKNOWN', driving_record: 'UNKNOWN',
    truck_driving_experience: 'UNKNOWN'
  });

  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.needsHumanReview, true);
  assert.strictEqual(r.gaps.length, 0, 'nada é declarado como lacuna sem base');
  assert.ok(r.unresolved.length >= 3, 'cada desconhecido crítico precisa aparecer');
});

test('§28 — perfil sem CDL contra vaga que exige CDL é lacuna REAL', () => {
  const r = cdl.evaluateEligibility(JOB_CDL_OBRIGATORIA, {
    cdl_status: 'NOT_HELD', driving_record: 'CLEAN', truck_driving_experience: 5
  });

  assert.strictEqual(r.eligible, false);
  assert.ok(r.gaps.some(g => g.id === 'cdl'), 'aqui existe informação suficiente para dizer que não atende');
  assert.ok(r.blockingGaps.length > 0);
});

test('§28 — perfil completo e compatível é elegível', () => {
  const r = cdl.evaluateEligibility(JOB_CDL_OBRIGATORIA, {
    cdl_status: 'HELD', cdl_class: 'A', cdl_endorsements: 'N',
    driving_record: 'CLEAN', truck_driving_experience: 5
  });

  assert.strictEqual(r.eligible, true, JSON.stringify({ gaps: r.gaps, unresolved: r.unresolved }));
  assert.strictEqual(r.blockingGaps.length, 0);
});

test('§28 — classe de CDL diferente da exigida é lacuna', () => {
  const r = cdl.evaluateEligibility(JOB_CDL_OBRIGATORIA, {
    cdl_status: 'HELD', cdl_class: 'B', driving_record: 'CLEAN', truck_driving_experience: 5
  });

  assert.ok(r.gaps.some(g => g.id === 'cdl_class'));
});

test('§28 — experiência insuficiente é lacuna com o número dos dois lados', () => {
  const r = cdl.evaluateEligibility(JOB_CDL_OBRIGATORIA, {
    cdl_status: 'HELD', cdl_class: 'A', driving_record: 'CLEAN', truck_driving_experience: 1
  });

  const gap = r.gaps.find(g => g.id === 'minimum_experience');
  assert.ok(gap, 'a lacuna de experiência precisa aparecer');
  assert.ok(gap.detail.includes('2') && gap.detail.includes('1'));
});

test('§28 — CDL obtida depois não bloqueia quem não tem CDL', () => {
  const r = cdl.evaluateEligibility(
    { job_title: 'Truck Driver', special_requirements: 'CDL can be obtained after hire. Employer provides training.' },
    { cdl_status: 'NOT_HELD', can_obtain_cdl: '1', driving_record: 'CLEAN', truck_driving_experience: 3 }
  );

  assert.strictEqual(r.blockingGaps.length, 0, 'não ter CDL não elimina numa vaga que treina');
});
