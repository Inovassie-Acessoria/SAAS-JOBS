/**
 * Truth Guard — auditor factual (spec de agentes §17, §18, §65).
 *
 * Esta é a trava mais importante do sistema. Nenhum texto gerado sai para um
 * empregador sem passar por aqui. A regra da §17 é absoluta: a IA NUNCA inventa
 *
 *   anos de experiência · licenças · CDL · histórico de empregadores ·
 *   escolaridade · certificações · idiomas · conquistas · habilidades ·
 *   autorização de trabalho · métricas
 *
 * O guarda não avalia estilo nem qualidade. Ele responde a uma única pergunta,
 * afirmação por afirmação:
 *
 *      esta alegação está sustentada pelo perfil/currículo DESTA plataforma?
 *
 * Se a resposta for NÃO, o pacote inteiro é bloqueado com
 * TRUTH_VALIDATION_FAILED — não há "aprovar mesmo assim" automático (§17).
 *
 * O que o perfil não sabe permanece UNKNOWN (§18). Uma alegação apoiada em
 * campo UNKNOWN é violação, não dúvida: afirmar o desconhecido é inventar.
 */

const VERSION = 'truth-guard-v1';

const STATUS = {
  PASSED: 'TRUTH_VALIDATION_PASSED',
  FAILED: 'TRUTH_VALIDATION_FAILED'
};

const CLAIM_KIND = {
  EXPERIENCE_YEARS: 'EXPERIENCE_YEARS',
  CDL: 'CDL',
  LICENSE: 'LICENSE',
  ENDORSEMENT: 'ENDORSEMENT',
  CERTIFICATION: 'CERTIFICATION',
  EDUCATION: 'EDUCATION',
  LANGUAGE: 'LANGUAGE',
  EMPLOYER: 'EMPLOYER',
  SKILL: 'SKILL',
  WORK_AUTHORIZATION: 'WORK_AUTHORIZATION',
  METRIC: 'METRIC',
  AVAILABILITY: 'AVAILABILITY'
};

const VERDICT = {
  SUPPORTED: 'SUPPORTED',       // o perfil sustenta a afirmação
  UNSUPPORTED: 'UNSUPPORTED',   // o perfil contradiz ou não contém a afirmação
  UNKNOWN_SOURCE: 'UNKNOWN_SOURCE' // o perfil declara UNKNOWN — afirmar é inventar (§18)
};

function normalize(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function sentences(text) {
  return String(text || '')
    .split(/(?<=[.;!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function isKnown(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim();
  if (!s) return false;
  return s.toUpperCase() !== 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Extração de alegações
// ---------------------------------------------------------------------------

/** "I have 5 years of experience", "5+ anos de experiência", "five years driving" */
const EXPERIENCE_RE = /\b(\d{1,2})\s*(\+|plus)?\s*(years?|yrs?|anos?)\b[^.;]{0,50}?\b(experience|experi[eê]ncia|driving|driver|hauling|working|worked|operating)\b/gi;
const EXPERIENCE_RE_ALT = /\b(experience|experi[eê]ncia)\b[^.;]{0,30}?\b(\d{1,2})\s*(\+|plus)?\s*(years?|yrs?|anos?)\b/gi;

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20
};
const EXPERIENCE_WORD_RE = new RegExp(
  `\\b(${Object.keys(WORD_NUMBERS).join('|')})\\s+(years?|yrs?)\\b[^.;]{0,50}?\\b(experience|driving|driver|hauling|working)\\b`, 'gi'
);

const CDL_CLAIM_RE = /\b(i\s+(have|hold|possess|carry)|my|holder of|licensed with|possuo|tenho)\b[^.;]{0,40}\b(cdl|commercial driver'?s? licen[sc]e)\b/gi;
const CDL_CLASS_CLAIM_RE = /\bcdl\s*(class\s*)?[-–]?\s*(a|b|c)\b/gi;
const ENDORSEMENT_CLAIM_RE = /\b(hazmat|tanker|tank vehicle|doubles?\s*\/?\s*triples?|passenger endorsement|school bus endorsement)\b/gi;
const LICENSE_CLAIM_RE = /\b(i\s+(have|hold|possess)|my)\b[^.;]{0,30}\b(driver'?s?\s+licen[sc]e|licen[sc]a de motorista|cnh)\b/gi;
const WORK_AUTH_RE = /\b(authorized to work|work authorization|legally (able|authorized) to work|green card|permanent resident|us citizen|visa (holder|status)|autoriza[cç][aã]o de trabalho)\b/gi;
const EDUCATION_RE = /\b(degree|diploma|graduated|bachelor'?s?|master'?s?|high school|ged|college|university|forma[cç][aã]o|gradua[cç][aã]o|ensino m[eé]dio)\b/gi;
const CERTIFICATION_RE = /\b(certified|certification|certificate|twic|osha|forklift certified|dot medical card|certificad[oa])\b/gi;
const LANGUAGE_RE = /\b(fluent|native|proficient|conversational|bilingual)\s+(in\s+)?(english|spanish|portuguese|ingl[eê]s|espanhol|portugu[eê]s)\b|\b(english|spanish|portuguese)\s+(fluency|proficiency|native speaker)\b/gi;
const METRIC_RE = /\b(\d{1,3}(?:[.,]\d{3})*|\d+)\s*(%|percent|miles|km|loads?|deliveries|trips?|tons?|clientes?|customers?)\b/gi;
// Grupos não-capturantes no verbo para que o NOME do empregador seja sempre o
// grupo 1 — depender da contagem de alternativas é como o bug anterior nasceu.
const EMPLOYER_RE = /\b(?:worked (?:at|for)|employed (?:at|by)|my (?:previous |former |last )?employer (?:was|is)|trabalhei (?:na|no|para))\s+([A-Z][\w&.\- ]{2,40})/g;

/** Frases que não afirmam fato sobre o candidato — não devem virar alegação. */
const NON_CLAIM_MARKERS = [
  'the position requires', 'this role requires', 'the job requires',
  'you require', 'your posting', 'as listed', 'per the job order',
  'i understand the contract period', 'i am writing to apply', 'i found your',
  'i am interested', 'please find', 'thank you', 'i am available for an interview',
  'a vaga exige', 'conforme a ordem'
];

function isNonClaim(sentence) {
  const s = normalize(sentence);
  return NON_CLAIM_MARKERS.some(m => s.includes(m));
}

/**
 * Extrai as alegações verificáveis de um texto gerado.
 * Trabalha por sentença para que cada alegação carregue sua evidência textual.
 */
function extractClaims(text) {
  const claims = [];
  const push = (kind, value, sentence, extra = {}) => {
    claims.push(Object.assign({ kind, value, sentence: sentence.trim() }, extra));
  };

  for (const sentence of sentences(text)) {
    if (isNonClaim(sentence)) continue;

    let m;

    EXPERIENCE_RE.lastIndex = 0;
    while ((m = EXPERIENCE_RE.exec(sentence)) !== null) {
      push(CLAIM_KIND.EXPERIENCE_YEARS, Number(m[1]), sentence, { unit: 'years' });
    }
    EXPERIENCE_RE_ALT.lastIndex = 0;
    while ((m = EXPERIENCE_RE_ALT.exec(sentence)) !== null) {
      push(CLAIM_KIND.EXPERIENCE_YEARS, Number(m[2]), sentence, { unit: 'years' });
    }
    EXPERIENCE_WORD_RE.lastIndex = 0;
    while ((m = EXPERIENCE_WORD_RE.exec(sentence)) !== null) {
      push(CLAIM_KIND.EXPERIENCE_YEARS, WORD_NUMBERS[m[1].toLowerCase()], sentence, { unit: 'years' });
    }

    CDL_CLAIM_RE.lastIndex = 0;
    if (CDL_CLAIM_RE.test(sentence)) {
      CDL_CLASS_CLAIM_RE.lastIndex = 0;
      const cm = CDL_CLASS_CLAIM_RE.exec(sentence);
      push(CLAIM_KIND.CDL, cm ? cm[2].toUpperCase() : true, sentence, { cdlClass: cm ? cm[2].toUpperCase() : null });
    }

    ENDORSEMENT_CLAIM_RE.lastIndex = 0;
    while ((m = ENDORSEMENT_CLAIM_RE.exec(sentence)) !== null) {
      push(CLAIM_KIND.ENDORSEMENT, m[0], sentence);
    }

    LICENSE_CLAIM_RE.lastIndex = 0;
    if (LICENSE_CLAIM_RE.test(sentence)) push(CLAIM_KIND.LICENSE, true, sentence);

    WORK_AUTH_RE.lastIndex = 0;
    while ((m = WORK_AUTH_RE.exec(sentence)) !== null) {
      push(CLAIM_KIND.WORK_AUTHORIZATION, m[0], sentence);
    }

    EDUCATION_RE.lastIndex = 0;
    while ((m = EDUCATION_RE.exec(sentence)) !== null) {
      push(CLAIM_KIND.EDUCATION, m[0], sentence);
    }

    CERTIFICATION_RE.lastIndex = 0;
    while ((m = CERTIFICATION_RE.exec(sentence)) !== null) {
      push(CLAIM_KIND.CERTIFICATION, m[0], sentence);
    }

    LANGUAGE_RE.lastIndex = 0;
    while ((m = LANGUAGE_RE.exec(sentence)) !== null) {
      push(CLAIM_KIND.LANGUAGE, m[0], sentence);
    }

    METRIC_RE.lastIndex = 0;
    while ((m = METRIC_RE.exec(sentence)) !== null) {
      push(CLAIM_KIND.METRIC, m[0], sentence);
    }

    EMPLOYER_RE.lastIndex = 0;
    while ((m = EMPLOYER_RE.exec(sentence)) !== null) {
      push(CLAIM_KIND.EMPLOYER, m[1].trim(), sentence);
    }
  }

  return claims;
}

// ---------------------------------------------------------------------------
// Verificação contra o perfil
// ---------------------------------------------------------------------------

/**
 * Constrói o conjunto de fatos verificáveis a partir do perfil DA PLATAFORMA.
 * Nunca recebe perfil de outra plataforma — o isolamento é do chamador (§11).
 */
function buildFactBase(profile = {}, driverProfile = {}, resumeText = '') {
  const list = (v) => Array.isArray(v) ? v.filter(Boolean).map(String) : [];

  return {
    yearsOfExperience: Number.isFinite(Number(profile.yearsOfExperience)) && profile.yearsOfExperience !== null
      ? Number(profile.yearsOfExperience) : null,
    truckDrivingExperience: isKnown(driverProfile.truck_driving_experience)
      ? Number(driverProfile.truck_driving_experience) : null,
    cdlStatus: isKnown(driverProfile.cdl_status) ? String(driverProfile.cdl_status).toUpperCase() : null,
    cdlClass: isKnown(driverProfile.cdl_class) ? String(driverProfile.cdl_class).toUpperCase() : null,
    cdlEndorsements: isKnown(driverProfile.cdl_endorsements)
      ? String(driverProfile.cdl_endorsements).toUpperCase().split(/[,;\s]+/).filter(Boolean) : null,
    driversLicense: isKnown(profile.driversLicense) ? String(profile.driversLicense) : null,
    workAuthorization: isKnown(profile.workAuthorization) ? String(profile.workAuthorization) : null,
    skills: list(profile.skills),
    tools: list(profile.tools),
    languages: list(profile.languages),
    certifications: list(profile.certifications),
    education: list(profile.education),
    industries: list(profile.industries),
    availabilityFrom: profile.availabilityFrom || null,
    availabilityTo: profile.availabilityTo || null,
    resumeText: normalize(resumeText)
  };
}

function inResume(facts, term) {
  const t = normalize(term);
  return Boolean(t) && t.length > 2 && facts.resumeText.includes(t);
}

function listContains(list, term) {
  const t = normalize(term);
  return (list || []).some(x => {
    const n = normalize(x);
    return n === t || n.includes(t) || t.includes(n);
  });
}

/** Verifica uma alegação. Devolve veredito + a evidência que o sustenta. */
function verifyClaim(claim, facts) {
  const supported = (evidence) => ({ verdict: VERDICT.SUPPORTED, evidence });
  const unsupported = (reason) => ({ verdict: VERDICT.UNSUPPORTED, reason });
  const unknownSource = (field) => ({
    verdict: VERDICT.UNKNOWN_SOURCE,
    reason: `O perfil não declara "${field}". Afirmar isso seria inventar (§18).`
  });

  switch (claim.kind) {
    case CLAIM_KIND.EXPERIENCE_YEARS: {
      const claimed = Number(claim.value);
      const candidates = [facts.truckDrivingExperience, facts.yearsOfExperience]
        .filter(v => v !== null && Number.isFinite(v));
      if (!candidates.length) return unknownSource('anos de experiência');
      const best = Math.max(...candidates);
      if (claimed <= best + 0.001) return supported(`O perfil declara ${best} ano(s).`);
      return unsupported(`O texto afirma ${claimed} ano(s); o perfil declara ${best}.`);
    }

    case CLAIM_KIND.CDL: {
      if (facts.cdlStatus === null) return unknownSource('CDL_status');
      if (facts.cdlStatus !== 'HELD') {
        return unsupported(`O texto afirma possuir CDL; o perfil declara "${facts.cdlStatus}".`);
      }
      if (claim.cdlClass) {
        if (facts.cdlClass === null) return unknownSource('CDL_class');
        if (facts.cdlClass !== claim.cdlClass) {
          return unsupported(`O texto afirma CDL classe ${claim.cdlClass}; o perfil declara ${facts.cdlClass}.`);
        }
      }
      return supported(`O perfil declara CDL ${facts.cdlClass || ''} (${facts.cdlStatus}).`.trim());
    }

    case CLAIM_KIND.ENDORSEMENT: {
      if (facts.cdlEndorsements === null) return unknownSource('CDL_endorsements');
      const map = { hazmat: 'H', tanker: 'N', 'tank vehicle': 'N', 'doubles': 'T', 'triples': 'T',
                    'passenger endorsement': 'P', 'school bus endorsement': 'S' };
      const key = Object.keys(map).find(k => normalize(claim.value).includes(k));
      const code = key ? map[key] : null;
      if (code && facts.cdlEndorsements.includes(code)) {
        return supported(`O perfil declara os endossos: ${facts.cdlEndorsements.join(', ')}.`);
      }
      return unsupported(`O texto cita o endosso "${claim.value}"; o perfil declara: ${facts.cdlEndorsements.join(', ') || 'nenhum'}.`);
    }

    case CLAIM_KIND.LICENSE: {
      if (facts.driversLicense === null) return unknownSource('drivers_license');
      return supported(`O perfil declara habilitação: ${facts.driversLicense}.`);
    }

    case CLAIM_KIND.WORK_AUTHORIZATION: {
      if (facts.workAuthorization === null) return unknownSource('work_authorization');
      return supported(`O perfil declara autorização de trabalho: ${facts.workAuthorization}.`);
    }

    case CLAIM_KIND.EDUCATION: {
      if (listContains(facts.education, claim.value) || inResume(facts, claim.value)) {
        return supported('Consta na escolaridade do perfil ou no currículo anexado.');
      }
      if (!facts.education.length) return unknownSource('education');
      return unsupported(`O texto cita "${claim.value}", ausente da escolaridade declarada.`);
    }

    case CLAIM_KIND.CERTIFICATION: {
      if (listContains(facts.certifications, claim.value) || inResume(facts, claim.value)) {
        return supported('Consta nas certificações do perfil ou no currículo anexado.');
      }
      if (!facts.certifications.length) return unknownSource('certifications');
      return unsupported(`O texto cita a certificação "${claim.value}", ausente do perfil.`);
    }

    case CLAIM_KIND.LANGUAGE: {
      if (listContains(facts.languages, claim.value) || inResume(facts, claim.value)) {
        return supported('Consta nos idiomas do perfil.');
      }
      if (!facts.languages.length) return unknownSource('languages');
      return unsupported(`O texto afirma "${claim.value}", ausente dos idiomas declarados.`);
    }

    case CLAIM_KIND.EMPLOYER: {
      if (inResume(facts, claim.value)) return supported('O empregador aparece no currículo anexado.');
      return unsupported(`O texto cita o empregador "${claim.value}", que não aparece no currículo desta plataforma.`);
    }

    case CLAIM_KIND.SKILL: {
      if (listContains(facts.skills, claim.value) || listContains(facts.tools, claim.value)
          || inResume(facts, claim.value)) {
        return supported('Consta nas habilidades do perfil.');
      }
      return unsupported(`O texto cita "${claim.value}", ausente das habilidades declaradas.`);
    }

    case CLAIM_KIND.METRIC: {
      if (inResume(facts, claim.value)) return supported('O número aparece no currículo anexado.');
      return unsupported(`O texto apresenta a métrica "${claim.value}" sem lastro no perfil ou no currículo (§17).`);
    }

    default:
      return unsupported('Tipo de alegação não reconhecido — bloqueado por precaução.');
  }
}

/**
 * Valida um texto gerado contra o perfil da plataforma (§17).
 *
 * @param {object} input
 * @param {string} input.text            texto gerado (carta, e-mail, mensagem)
 * @param {object} input.profile         perfil DA PLATAFORMA
 * @param {object} [input.driverProfile] perfil de motorista do Seasonal (§27)
 * @param {string} [input.resumeText]    texto extraído do currículo selecionado
 * @param {string} [input.source]        rótulo do que está sendo validado
 * @returns {{status:string, passed:boolean, claims:object[], violations:object[],
 *            unknowns:object[], version:string}}
 */
function validate({ text, profile = {}, driverProfile = {}, resumeText = '', source = 'generated_text' }) {
  const facts = buildFactBase(profile, driverProfile, resumeText);
  const raw = extractClaims(text || '');

  // Deduplica alegações idênticas na mesma sentença.
  const seen = new Set();
  const claims = [];
  for (const c of raw) {
    const key = `${c.kind}|${normalize(String(c.value))}|${normalize(c.sentence).slice(0, 60)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push(c);
  }

  const evaluated = claims.map(c => Object.assign({}, c, verifyClaim(c, facts)));
  const violations = evaluated.filter(c => c.verdict === VERDICT.UNSUPPORTED);
  const unknowns = evaluated.filter(c => c.verdict === VERDICT.UNKNOWN_SOURCE);

  // Alegação apoiada em UNKNOWN também bloqueia: a §18 manda não adivinhar.
  const blocked = violations.length > 0 || unknowns.length > 0;

  return {
    status: blocked ? STATUS.FAILED : STATUS.PASSED,
    passed: !blocked,
    source,
    claims: evaluated,
    violations,
    unknowns,
    summary: blocked
      ? `${violations.length} alegação(ões) sem lastro e ${unknowns.length} apoiada(s) em dado desconhecido.`
      : `${evaluated.length} alegação(ões) verificada(s), todas sustentadas pelo perfil.`,
    version: VERSION
  };
}

/**
 * Valida um pacote inteiro de uma vez: carta, corpo do e-mail e assunto.
 * Basta um texto falhar para o pacote ser bloqueado (§17).
 */
function validatePackage({ texts = {}, profile, driverProfile, resumeText }) {
  const results = {};
  let passed = true;

  for (const [name, text] of Object.entries(texts)) {
    if (!text) continue;
    const r = validate({ text, profile, driverProfile, resumeText, source: name });
    results[name] = r;
    if (!r.passed) passed = false;
  }

  const allViolations = Object.values(results).flatMap(r => r.violations);
  const allUnknowns = Object.values(results).flatMap(r => r.unknowns);

  return {
    status: passed ? STATUS.PASSED : STATUS.FAILED,
    passed,
    results,
    violations: allViolations,
    unknowns: allUnknowns,
    blockingReasons: [
      ...allViolations.map(v => `${v.kind}: ${v.reason}`),
      ...allUnknowns.map(u => `${u.kind}: ${u.reason}`)
    ],
    version: VERSION
  };
}

module.exports = {
  VERSION, STATUS, CLAIM_KIND, VERDICT,
  extractClaims, buildFactBase, verifyClaim,
  validate, validatePackage, isKnown
};
