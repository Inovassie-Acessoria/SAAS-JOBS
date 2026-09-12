/**
 * §65 — TESTING: TRUTH
 *
 * As fixtures que o spec de agentes nomeia:
 *
 *   LLM afirma 5 anos de experiência, perfil tem 2   → BLOCK
 *   LLM afirma CDL, perfil diz UNKNOWN               → BLOCK
 *   LLM afirma endosso, sem evidência                → BLOCK
 *
 * A segunda merece atenção porque é contraintuitiva: o perfil não diz que o
 * candidato NÃO tem CDL — diz que não sabe. E a §18 é explícita: o desconhecido
 * permanece desconhecido. Afirmar o que não se sabe é inventar, e inventar é
 * exatamente o que a §17 proíbe.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const truthGuard = require('../core/agents/truthGuard');
const { STATUS, CLAIM_KIND, VERDICT } = truthGuard;

const PERFIL_2_ANOS = {
  fullName: 'Ana Souza',
  yearsOfExperience: 2,
  skills: ['loading', 'unloading'],
  languages: ['Portuguese'],
  certifications: [],
  education: []
};

const MOTORISTA_TUDO_UNKNOWN = {
  truck_driving_experience: 'UNKNOWN',
  cdl_status: 'UNKNOWN',
  cdl_class: 'UNKNOWN',
  cdl_endorsements: 'UNKNOWN',
  driving_record: 'UNKNOWN'
};

const MOTORISTA_COM_CDL = {
  truck_driving_experience: 6,
  cdl_status: 'HELD',
  cdl_class: 'A',
  cdl_endorsements: 'N',
  driving_record: 'CLEAN'
};

// ---------------------------------------------------------------------------
// As três fixtures da §65
// ---------------------------------------------------------------------------

test('§65 — texto afirma 5 anos, perfil tem 2: BLOQUEIA', () => {
  const r = truthGuard.validate({
    text: 'I have 5 years of experience driving trucks for agricultural employers.',
    profile: PERFIL_2_ANOS,
    driverProfile: { truck_driving_experience: 2 }
  });

  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.status, STATUS.FAILED);

  const v = r.violations.find(x => x.kind === CLAIM_KIND.EXPERIENCE_YEARS);
  assert.ok(v, 'a violação precisa ser identificada como alegação de experiência');
  assert.ok(v.reason.includes('5') && v.reason.includes('2'),
    'o motivo precisa mostrar o afirmado e o real, não só dizer que falhou');
});

test('§65, §18 — texto afirma CDL, perfil diz UNKNOWN: BLOQUEIA', () => {
  const r = truthGuard.validate({
    text: 'I have a valid CDL Class A and I am ready to start immediately.',
    profile: PERFIL_2_ANOS,
    driverProfile: MOTORISTA_TUDO_UNKNOWN
  });

  assert.strictEqual(r.passed, false);

  const cdl = [...r.violations, ...r.unknowns].find(x => x.kind === CLAIM_KIND.CDL);
  assert.ok(cdl, 'a alegação de CDL precisa ser capturada');
  assert.strictEqual(cdl.verdict, VERDICT.UNKNOWN_SOURCE,
    'perfil UNKNOWN não é "não tem" — é "não se sabe", e afirmar é inventar');
  assert.ok(cdl.reason.includes('§18'), 'o motivo precisa apontar a regra que sustenta o bloqueio');
});

test('§65 — texto afirma endosso sem evidência: BLOQUEIA', () => {
  const r = truthGuard.validate({
    text: 'I hold a valid CDL Class A with hazmat and doubles/triples endorsements.',
    profile: PERFIL_2_ANOS,
    driverProfile: MOTORISTA_COM_CDL       // tem CDL A, mas só o endosso N
  });

  assert.strictEqual(r.passed, false);
  const e = r.violations.find(x => x.kind === CLAIM_KIND.ENDORSEMENT);
  assert.ok(e, 'o endosso não declarado precisa ser barrado');
  assert.ok(e.reason.includes('N'), 'o motivo mostra quais endossos o perfil realmente declara');
});

// ---------------------------------------------------------------------------
// O outro lado: o guarda não pode bloquear o que é verdade
// ---------------------------------------------------------------------------

test('§17 — afirmação sustentada pelo perfil PASSA', () => {
  const r = truthGuard.validate({
    text: 'I have 6 years of truck driving experience. I hold a valid CDL Class A. I maintain a clean driving record.',
    profile: Object.assign({}, PERFIL_2_ANOS, { yearsOfExperience: 6 }),
    driverProfile: MOTORISTA_COM_CDL
  });

  assert.strictEqual(r.passed, true, r.summary);
  assert.strictEqual(r.status, STATUS.PASSED);
  assert.ok(r.claims.length > 0, 'o guarda precisa ter de fato encontrado alegações para validar');
  assert.ok(r.claims.every(c => c.verdict === VERDICT.SUPPORTED));
});

test('§17 — afirmar MENOS do que o perfil sustenta continua verdadeiro', () => {
  const r = truthGuard.validate({
    text: 'I have 3 years of truck driving experience.',
    profile: PERFIL_2_ANOS,
    driverProfile: { truck_driving_experience: 6 }
  });

  assert.strictEqual(r.passed, true, 'dizer 3 quando se tem 6 não é mentira');
});

test('§17 — frases sobre a VAGA não viram alegação sobre o candidato', () => {
  const r = truthGuard.validate({
    text: 'I am writing to apply for the Heavy Truck Driver position. ' +
          'I understand the contract period runs from 2027-01-15 to 2027-10-30. ' +
          'Please find my resume attached. Thank you.',
    profile: PERFIL_2_ANOS,
    driverProfile: MOTORISTA_TUDO_UNKNOWN
  });

  assert.strictEqual(r.passed, true,
    'uma carta que não afirma nada sobre o candidato não pode ser bloqueada');
});

// ---------------------------------------------------------------------------
// Cobertura das categorias que a §17 lista
// ---------------------------------------------------------------------------

test('§17 — métrica inventada é bloqueada', () => {
  const r = truthGuard.validate({
    text: 'In my last role I delivered 450 loads with a 99% on-time rate.',
    profile: PERFIL_2_ANOS,
    driverProfile: MOTORISTA_COM_CDL,
    resumeText: ''
  });

  assert.strictEqual(r.passed, false);
  assert.ok(r.violations.some(v => v.kind === CLAIM_KIND.METRIC));
});

test('§17 — métrica que consta no currículo anexado é aceita', () => {
  const r = truthGuard.validate({
    text: 'In my last role I delivered 450 loads.',
    profile: PERFIL_2_ANOS,
    driverProfile: MOTORISTA_COM_CDL,
    resumeText: 'Truck driver 2019-2025. Delivered 450 loads of grain across three states.'
  });

  assert.strictEqual(r.passed, true, r.summary);
});

test('§17 — empregador que não está no currículo é bloqueado', () => {
  const r = truthGuard.validate({
    text: 'I worked for Midwest Grain Logistics for four seasons.',
    profile: PERFIL_2_ANOS,
    driverProfile: MOTORISTA_COM_CDL,
    resumeText: 'Driver at Vale Verde Transportes.'
  });

  assert.strictEqual(r.passed, false);
  assert.ok(r.violations.some(v => v.kind === CLAIM_KIND.EMPLOYER));
});

test('§17 — certificação ausente do perfil é bloqueada', () => {
  const r = truthGuard.validate({
    text: 'I am OSHA certified and hold a DOT medical card.',
    profile: Object.assign({}, PERFIL_2_ANOS, { certifications: ['Defensive Driving'] }),
    driverProfile: MOTORISTA_COM_CDL
  });

  assert.strictEqual(r.passed, false);
  assert.ok(r.violations.some(v => v.kind === CLAIM_KIND.CERTIFICATION));
});

test('§17 — idioma não declarado é bloqueado', () => {
  const r = truthGuard.validate({
    text: 'I am fluent in English and can communicate with dispatch without difficulty.',
    profile: Object.assign({}, PERFIL_2_ANOS, { languages: ['Portuguese'] }),
    driverProfile: MOTORISTA_COM_CDL
  });

  assert.strictEqual(r.passed, false);
  assert.ok(r.violations.some(v => v.kind === CLAIM_KIND.LANGUAGE));
});

test('§17 — autorização de trabalho não declarada é bloqueada', () => {
  const r = truthGuard.validate({
    text: 'I am authorized to work in the United States.',
    profile: Object.assign({}, PERFIL_2_ANOS, { workAuthorization: null }),
    driverProfile: MOTORISTA_COM_CDL
  });

  assert.strictEqual(r.passed, false);
  const wa = [...r.violations, ...r.unknowns].find(v => v.kind === CLAIM_KIND.WORK_AUTHORIZATION);
  assert.ok(wa);
  assert.strictEqual(wa.verdict, VERDICT.UNKNOWN_SOURCE);
});

// ---------------------------------------------------------------------------
// Validação de pacote inteiro
// ---------------------------------------------------------------------------

test('§17 — basta UM texto do pacote falhar para o pacote inteiro ser bloqueado', () => {
  const r = truthGuard.validatePackage({
    texts: {
      cover_letter: 'I have 6 years of truck driving experience.',   // verdadeiro
      email_body: 'I hold a hazmat endorsement.',                    // falso
      email_subject: 'Application for Heavy Truck Driver'
    },
    profile: PERFIL_2_ANOS,
    driverProfile: MOTORISTA_COM_CDL
  });

  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.results.cover_letter.passed, true);
  assert.strictEqual(r.results.email_body.passed, false);
  assert.ok(r.blockingReasons.length > 0, 'o pacote precisa dizer o que o bloqueou');
});

test('§17 — pacote inteiramente verdadeiro passa', () => {
  const r = truthGuard.validatePackage({
    texts: {
      cover_letter: 'I have 6 years of truck driving experience and I hold a valid CDL Class A.',
      email_body: 'I maintain a clean driving record and I am available for the season.',
      email_subject: 'Application for Heavy Truck Driver'
    },
    profile: Object.assign({}, PERFIL_2_ANOS, { yearsOfExperience: 6 }),
    driverProfile: MOTORISTA_COM_CDL
  });

  assert.strictEqual(r.passed, true, JSON.stringify(r.blockingReasons));
});

test('§18 — a base de fatos distingue ausente de UNKNOWN de declarado', () => {
  const facts = truthGuard.buildFactBase(PERFIL_2_ANOS, MOTORISTA_TUDO_UNKNOWN);
  assert.strictEqual(facts.cdlStatus, null, 'UNKNOWN vira null, não string "UNKNOWN"');
  assert.strictEqual(facts.truckDrivingExperience, null);
  assert.strictEqual(facts.yearsOfExperience, 2, 'o que é declarado permanece');
});
