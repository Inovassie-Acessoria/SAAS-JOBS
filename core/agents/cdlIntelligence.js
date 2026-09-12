/**
 * Inteligência de CDL e requisitos de motorista (spec de agentes §28, §29).
 *
 * A §28 é explícita: estas três coisas NÃO são equivalentes e não podem ser
 * tratadas como a mesma exigência —
 *
 *   CDL REQUIRED BEFORE HIRE      elimina quem não tem
 *   CDL CAN BE OBTAINED AFTER HIRE não elimina ninguém
 *   CDL PREFERRED                  pesa, mas não bloqueia
 *
 * Confundi-las muda materialmente a elegibilidade do candidato. Por isso a
 * classificação é determinística e devolve a EVIDÊNCIA textual que a sustenta.
 *
 * Quando o texto não permite decidir, a resposta é UNKNOWN — nunca um palpite
 * (§18). UNKNOWN em requisito crítico produz revisão humana, não descarte.
 */

const VERSION = 'cdl-intel-v1';

const CDL_REQUIREMENT = {
  REQUIRED_BEFORE_HIRE: 'CDL_REQUIRED_BEFORE_HIRE',
  OBTAINABLE_AFTER_HIRE: 'CDL_OBTAINABLE_AFTER_HIRE',
  PREFERRED: 'CDL_PREFERRED',
  NOT_REQUIRED: 'CDL_NOT_REQUIRED',
  NOT_MENTIONED: 'CDL_NOT_MENTIONED',
  UNKNOWN: 'UNKNOWN'
};

const CDL_REQUIREMENT_LABEL = {
  CDL_REQUIRED_BEFORE_HIRE: 'CDL exigida ANTES da contratação',
  CDL_OBTAINABLE_AFTER_HIRE: 'CDL pode ser obtida DEPOIS da contratação',
  CDL_PREFERRED: 'CDL preferencial, não obrigatória',
  CDL_NOT_REQUIRED: 'CDL não é exigida',
  CDL_NOT_MENTIONED: 'A vaga não menciona CDL',
  UNKNOWN: 'Não foi possível determinar'
};

/** Ordem de severidade — a mais restritiva ganha quando o texto é contraditório. */
const SEVERITY_ORDER = [
  CDL_REQUIREMENT.REQUIRED_BEFORE_HIRE,
  CDL_REQUIREMENT.OBTAINABLE_AFTER_HIRE,
  CDL_REQUIREMENT.PREFERRED,
  CDL_REQUIREMENT.NOT_REQUIRED,
  CDL_REQUIREMENT.NOT_MENTIONED
];

function normalize(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Divide em sentenças para que a evidência devolvida seja legível. */
function sentences(text) {
  return String(text || '')
    .split(/(?<=[.;!?])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 3);
}

const CDL_MENTION = /\b(cdl|commercial driver'?s? licen[sc]e|commercial drivers licen[sc]e|class a licen[sc]e|class b licen[sc]e)\b/i;

/** "pode obter depois" — precede a checagem de obrigatoriedade (§28). */
const AFTER_HIRE_PATTERNS = [
  /\b(can|may|will)\s+(be\s+)?(obtain|acquire|get|earn)\w*\s+(the\s+)?(a\s+)?cdl/i,
  /\bcdl\s+(can|may|will)\s+be\s+(obtained|acquired|provided|issued)/i,
  /\b(obtain|acquire|get)\w*\s+(a\s+|the\s+)?cdl\s+(with)?in\s+\d+/i,
  /\b(after|upon|following|post)[- ](hire|hiring|employment|arrival|start)\b[^.;]{0,60}\bcdl\b/i,
  /\bcdl\b[^.;]{0,60}\b(after|upon|following)\s+(hire|hiring|employment|arrival)/i,
  /\b(employer|company)\s+(will\s+)?(provide|pay for|sponsor|assist with|help obtain)\b[^.;]{0,40}\bcdl\b/i,
  /\bcdl\s+training\s+(provided|available|offered)/i,
  /\bwilling(ness)?\s+to\s+obtain\b[^.;]{0,30}\bcdl\b/i,
  /\bmust\s+(be\s+able\s+to\s+)?obtain\b[^.;]{0,30}\bcdl\b/i
];

/** Preferencial — não bloqueia. */
const PREFERRED_PATTERNS = [
  /\bcdl\b[^.;]{0,30}\b(preferred|a plus|desirable|desired|advantage|nice to have)/i,
  /\b(preferred|desirable|a plus)\b[^.;]{0,30}\bcdl\b/i,
  /\bprefer\w*\b[^.;]{0,40}\bcdl\b/i
];

/**
 * Exigida antes da contratação.
 *
 * O lookbehind `(?<!not\s)` existe por um caso concreto: "CDL preferred but not
 * required" contém a palavra "required" a poucos caracteres de "CDL", e sem ele
 * a frase seria lida como exigência — o oposto exato do que ela diz.
 */
const REQUIRED_PATTERNS = [
  /\b(must|shall)\s+(have|hold|possess|maintain)\b[^.;]{0,40}\bcdl\b/i,
  /\bcdl\b[^.;]{0,30}?(?<!\bnot\s)(?:is\s+)?(required|mandatory|obligatory)\b/i,
  /(?<!\bnot\s)\b(required|requires|requirement)\b[^.;]{0,30}\bcdl\b/i,
  /\bvalid\s+cdl\b/i,
  /\bcurrent\s+cdl\b/i,
  /\bactive\s+cdl\b/i,
  /\bmust\s+(be\s+)?cdl[- ]licensed\b/i,
  /\bcdl\s+holder[s]?\s+only\b/i,
  /\bapplicants?\s+must\s+(have|hold|possess)\b[^.;]{0,40}\bcommercial\s+driver/i
];

/** Explicitamente dispensada. */
const NOT_REQUIRED_PATTERNS = [
  /\bno\s+cdl\s+(required|needed|necessary)\b/i,
  /\bcdl\s+(is\s+)?not\s+(required|needed|necessary)\b/i,
  /\bwithout\s+(a\s+)?cdl\b/i
];

// ---------------------------------------------------------------------------
// Classe e endossos
// ---------------------------------------------------------------------------

const CLASS_PATTERNS = [
  { cls: 'A', re: /\bclass\s*[-–]?\s*a\b/i },
  { cls: 'B', re: /\bclass\s*[-–]?\s*b\b/i },
  { cls: 'C', re: /\bclass\s*[-–]?\s*c\b/i }
];

const ENDORSEMENT_PATTERNS = [
  { code: 'H', label: 'Hazmat', re: /\b(hazmat|hazardous materials?)\s*(endorsement)?\b/i },
  { code: 'N', label: 'Tank Vehicle', re: /\b(tanker|tank vehicle)\s*(endorsement)?\b/i },
  { code: 'T', label: 'Doubles/Triples', re: /\b(doubles?\s*\/?\s*triples?)\s*(endorsement)?\b/i },
  { code: 'P', label: 'Passenger', re: /\bpassenger\s+endorsement\b/i },
  { code: 'S', label: 'School Bus', re: /\bschool\s+bus\s+endorsement\b/i },
  { code: 'X', label: 'Tank + Hazmat', re: /\bx\s+endorsement\b/i }
];

// ---------------------------------------------------------------------------
// Outros requisitos de motorista (§29)
// ---------------------------------------------------------------------------

const OTHER_REQUIREMENTS = [
  {
    id: 'clean_driving_record',
    label: 'Histórico de direção limpo',
    blocking: true,
    re: /\b(clean|good|satisfactory|acceptable)\s+(driving|motor vehicle|mvr)\s+(record|history)\b|\bno\s+(major\s+)?(moving\s+)?violations?\b|\bno\s+dui\b/i
  },
  {
    id: 'drug_testing',
    label: 'Teste antidrogas',
    blocking: false,
    re: /\b(drug|substance)\s+(test|testing|screen|screening)\b|\bdrug[- ]free\b|\brandom\s+testing\b/i
  },
  {
    id: 'physical_requirements',
    label: 'Exigência física / exame médico',
    blocking: false,
    re: /\b(dot\s+)?(physical|medical)\s+(exam|examination|certificate|card)\b|\bmedical\s+card\b|\bphysically\s+able\b/i
  },
  {
    id: 'manual_transmission',
    label: 'Câmbio manual',
    blocking: true,
    re: /\b(manual\s+transmission|stick\s+shift|non[- ]automatic|standard\s+transmission|manual\s+shift)\b/i
  },
  {
    // Experiência DE DIREÇÃO: só quando o texto liga o prazo a dirigir/caminhão/CDL.
    id: 'minimum_experience',
    label: 'Experiência mínima de direção',
    blocking: true,
    re: /\b(\d+)\s*(\+|plus)?\s*(years?|months?|yrs?)\b[^.;]{0,40}\b(driving|driver|truck|cdl)\b|\b(driving|truck|cdl)\s+experience\b[^.;]{0,25}\b(\d+)\s*(years?|months?)\b/i
  },
  {
    // Experiência NA FUNÇÃO, sem menção a direção: "3 months experience
    // required" numa vaga de colheita, hotelaria, construção etc. Compara com
    // a experiência geral do candidato, não com anos de caminhão (foco amplo).
    id: 'minimum_general_experience',
    label: 'Experiência mínima na função',
    blocking: true,
    re: /\b(\d+)\s*(\+|plus)?\s*(years?|months?|yrs?)\b[^.;]{0,40}\bexperience\b|\bexperience\b[^.;]{0,25}\b(\d+)\s*(\+|plus)?\s*(years?|months?|yrs?)\b/i
  },
  {
    id: 'lifting',
    label: 'Levantamento de peso',
    blocking: false,
    re: /\b(lift|lifting|carry|carrying)\b[^.;]{0,30}\b(\d{2,3})\s*(lbs?|pounds?|kg)\b/i
  },
  {
    id: 'english_requirement',
    label: 'Exigência de inglês',
    blocking: false,
    re: /\b(english)\b[^.;]{0,40}\b(required|proficien\w+|speak|read|write|understand|communicat\w+)\b|\bmust\s+speak\s+english\b/i
  },
  {
    id: 'state_license',
    label: 'Habilitação de estado específico',
    blocking: false,
    re: /\b(state|[a-z]{2})\s+(issued\s+)?(driver'?s?\s+)?licen[sc]e\s+(required|only)\b|\bin[- ]state\s+licen[sc]e\b/i
  },
  {
    id: 'age_requirement',
    label: 'Idade mínima',
    blocking: true,
    re: /\b(at least|minimum(\s+age)?(\s+of)?|must be)\s+(\d{2})\s*(years?\s+(of\s+)?age|years?\s+old)\b|\b21\+\s*(years?)?\b/i
  },
  {
    id: 'background_check',
    label: 'Checagem de antecedentes',
    blocking: false,
    re: /\bbackground\s+(check|screening|investigation)\b|\bcriminal\s+(record|history)\s+check\b/i
  },
  {
    id: 'twic_card',
    label: 'Cartão TWIC',
    blocking: true,
    re: /\btwic\b|\btransportation\s+worker\s+identification\b/i
  }
];

/** Extrai o número de anos/meses de experiência exigidos, quando declarado. */
function extractExperienceAmount(text) {
  const m = String(text).match(/\b(\d{1,2})\s*(\+|plus)?\s*(years?|yrs?)\b[^.;]{0,40}\b(driving|driver|truck|cdl|experience)\b/i)
    || String(text).match(/\b(driving|truck|cdl)\b[^.;]{0,30}\b(\d{1,2})\s*(\+|plus)?\s*(years?|yrs?)\b/i);
  if (m) {
    const n = Number(m[1]) || Number(m[2]);
    if (Number.isFinite(n) && n > 0 && n < 60) return { amount: n, unit: 'years' };
  }
  const mm = String(text).match(/\b(\d{1,2})\s*(months?|mos?)\b[^.;]{0,40}\b(driving|driver|truck|experience)\b/i);
  if (mm) return { amount: Number(mm[1]), unit: 'months' };
  return null;
}

/** Prazo de experiência genérica ("2 years experience", "3 months of experience"). */
function extractGeneralExperienceAmount(text) {
  const s = String(text);
  const y = s.match(/\b(\d{1,2})\s*(\+|plus)?\s*(years?|yrs?)\b[^.;]{0,40}\bexperience\b/i)
    || s.match(/\bexperience\b[^.;]{0,25}\b(\d{1,2})\s*(\+|plus)?\s*(years?|yrs?)\b/i);
  if (y) {
    const n = Number(y[1]);
    if (Number.isFinite(n) && n > 0 && n < 60) return { amount: n, unit: 'years' };
  }
  const m = s.match(/\b(\d{1,2})\s*(months?|mos?)\b[^.;]{0,40}\bexperience\b/i)
    || s.match(/\bexperience\b[^.;]{0,25}\b(\d{1,2})\s*(months?|mos?)\b/i);
  if (m) return { amount: Number(m[1]), unit: 'months' };
  return null;
}

/** Extrai o peso exigido em levantamento, quando declarado. */
function extractLiftingAmount(text) {
  const m = String(text).match(/\b(lift|lifting|carry|carrying)\b[^.;]{0,30}\b(\d{2,3})\s*(lbs?|pounds?)\b/i);
  if (m) return { amount: Number(m[2]), unit: 'lbs' };
  const kg = String(text).match(/\b(lift|lifting|carry|carrying)\b[^.;]{0,30}\b(\d{2,3})\s*kg\b/i);
  if (kg) return { amount: Number(kg[2]), unit: 'kg' };
  return null;
}

function findEvidence(text, regex) {
  for (const s of sentences(text)) {
    if (regex.test(s)) return s.length > 220 ? s.slice(0, 217) + '...' : s;
  }
  const m = String(text).match(regex);
  return m ? m[0] : null;
}

/**
 * Analisa a exigência de CDL de uma vaga (§28).
 *
 * @returns {{requirement:string, label:string, mentioned:boolean, blocking:boolean,
 *            cdlClass:string|null, endorsements:object[], evidence:string|null,
 *            candidates:object[], version:string}}
 */
function analyzeCdl(job = {}) {
  const raw = [job.job_title || job.title, job.duties_description || job.description,
               job.special_requirements || job.requirements].filter(Boolean).join('. ');

  const mentioned = CDL_MENTION.test(raw);

  const candidates = [];
  const test = (patterns, requirement) => {
    for (const re of patterns) {
      if (re.test(raw)) {
        candidates.push({ requirement, evidence: findEvidence(raw, re), pattern: String(re) });
        return true;
      }
    }
    return false;
  };

  // A ordem importa: "must obtain a CDL within 30 days" casa com REQUIRED e com
  // AFTER_HIRE. A §28 diz que são coisas diferentes — e a leitura correta dessa
  // frase é "pode obter depois". Por isso AFTER_HIRE é avaliado primeiro.
  test(NOT_REQUIRED_PATTERNS, CDL_REQUIREMENT.NOT_REQUIRED);
  test(AFTER_HIRE_PATTERNS, CDL_REQUIREMENT.OBTAINABLE_AFTER_HIRE);
  test(PREFERRED_PATTERNS, CDL_REQUIREMENT.PREFERRED);
  test(REQUIRED_PATTERNS, CDL_REQUIREMENT.REQUIRED_BEFORE_HIRE);

  let requirement;
  if (!mentioned && !candidates.length) {
    requirement = CDL_REQUIREMENT.NOT_MENTIONED;
  } else if (!candidates.length) {
    // O texto cita CDL, mas nenhuma construção diz em que termos.
    requirement = CDL_REQUIREMENT.UNKNOWN;
  } else if (candidates.some(c => c.requirement === CDL_REQUIREMENT.NOT_REQUIRED)) {
    requirement = CDL_REQUIREMENT.NOT_REQUIRED;
  } else if (candidates.some(c => c.requirement === CDL_REQUIREMENT.OBTAINABLE_AFTER_HIRE)) {
    requirement = CDL_REQUIREMENT.OBTAINABLE_AFTER_HIRE;
  } else if (candidates.some(c => c.requirement === CDL_REQUIREMENT.PREFERRED)
             && !candidates.some(c => c.requirement === CDL_REQUIREMENT.REQUIRED_BEFORE_HIRE)) {
    requirement = CDL_REQUIREMENT.PREFERRED;
  } else {
    requirement = CDL_REQUIREMENT.REQUIRED_BEFORE_HIRE;
  }

  const chosen = candidates.find(c => c.requirement === requirement);

  let cdlClass = null;
  if (mentioned) {
    for (const c of CLASS_PATTERNS) {
      if (c.re.test(raw)) { cdlClass = c.cls; break; }
    }
  }

  const endorsements = ENDORSEMENT_PATTERNS
    .filter(e => e.re.test(raw))
    .map(e => ({ code: e.code, label: e.label, evidence: findEvidence(raw, e.re) }));

  return {
    requirement,
    label: CDL_REQUIREMENT_LABEL[requirement],
    mentioned,
    blocking: requirement === CDL_REQUIREMENT.REQUIRED_BEFORE_HIRE,
    cdlClass,
    endorsements,
    evidence: chosen ? chosen.evidence : null,
    candidates,
    version: VERSION
  };
}

/**
 * Extrai os demais requisitos de motorista presentes no texto (§29).
 * Só devolve o que ESTÁ escrito — ausência nunca vira "não exigido".
 */
function extractDriverRequirements(job = {}) {
  const raw = [job.job_title || job.title, job.duties_description || job.description,
               job.special_requirements || job.requirements].filter(Boolean).join('. ');

  const found = [];
  for (const req of OTHER_REQUIREMENTS) {
    if (!req.re.test(raw)) continue;
    const entry = {
      id: req.id,
      label: req.label,
      blocking: req.blocking,
      evidence: findEvidence(raw, req.re)
    };
    if (req.id === 'minimum_experience') entry.amount = extractExperienceAmount(raw);
    if (req.id === 'minimum_general_experience') {
      // Se o prazo já foi lido como experiência de direção, não conta duas vezes.
      if (found.some(f => f.id === 'minimum_experience')) continue;
      entry.amount = extractGeneralExperienceAmount(raw);
    }
    if (req.id === 'lifting') entry.amount = extractLiftingAmount(raw);
    found.push(entry);
  }
  return { requirements: found, version: VERSION };
}

/**
 * Confronta os requisitos da vaga com o perfil de motorista do candidato.
 *
 * A regra da §18 manda o desconhecido permanecer desconhecido: se o perfil diz
 * UNKNOWN sobre CDL, o resultado é UNRESOLVED — nunca "não atende" nem "atende".
 *
 * @param {object} job
 * @param {object} driverProfile  perfil Seasonal de motorista (§27)
 */
/**
 * @param {object} [options]
 * @param {number} [options.generalExperienceYears] anos de experiência profissional
 *        do candidato (perfil geral). Usado nos requisitos de experiência que
 *        NÃO são de direção. Quando ausente, cai nos anos de caminhão, se conhecidos.
 */
function evaluateEligibility(job, driverProfile = {}, options = {}) {
  const cdl = analyzeCdl(job);
  const other = extractDriverRequirements(job);

  // Experiência geral: perfil geral primeiro; anos de caminhão como reserva.
  const generalYears = Number.isFinite(Number(options.generalExperienceYears)) && options.generalExperienceYears !== null && options.generalExperienceYears !== ''
    ? Number(options.generalExperienceYears)
    : (driverProfile.truck_driving_experience !== undefined && driverProfile.truck_driving_experience !== null
       && String(driverProfile.truck_driving_experience).toUpperCase() !== 'UNKNOWN'
       ? Number(driverProfile.truck_driving_experience) : undefined);
  const profileView = Object.assign({}, driverProfile, { general_experience_years: generalYears });
  const gaps = [];
  const unresolved = [];
  const satisfied = [];

  const known = (v) => v !== undefined && v !== null && v !== '' && String(v).toUpperCase() !== 'UNKNOWN';

  // --- CDL ---
  if (cdl.requirement === CDL_REQUIREMENT.REQUIRED_BEFORE_HIRE) {
    if (!known(driverProfile.cdl_status)) {
      unresolved.push({
        id: 'cdl', label: 'CDL exigida antes da contratação',
        detail: 'A vaga exige CDL válida e o perfil não informa o status da CDL.',
        evidence: cdl.evidence
      });
    } else if (String(driverProfile.cdl_status).toUpperCase() === 'HELD') {
      const classOk = !cdl.cdlClass || !known(driverProfile.cdl_class)
        ? null
        : String(driverProfile.cdl_class).toUpperCase() === cdl.cdlClass;
      if (classOk === false) {
        gaps.push({
          id: 'cdl_class', label: `Classe de CDL exigida: ${cdl.cdlClass}`,
          detail: `O perfil declara classe ${driverProfile.cdl_class}.`, evidence: cdl.evidence
        });
      } else if (classOk === null && cdl.cdlClass) {
        unresolved.push({
          id: 'cdl_class', label: `Classe de CDL exigida: ${cdl.cdlClass}`,
          detail: 'O perfil não informa a classe da CDL.', evidence: cdl.evidence
        });
      } else {
        satisfied.push({ id: 'cdl', label: 'CDL atendida' });
      }
    } else {
      gaps.push({
        id: 'cdl', label: 'CDL exigida antes da contratação',
        detail: `O perfil declara CDL: ${driverProfile.cdl_status}.`, evidence: cdl.evidence
      });
    }
  } else if (cdl.requirement === CDL_REQUIREMENT.OBTAINABLE_AFTER_HIRE) {
    if (known(driverProfile.can_obtain_cdl) && String(driverProfile.can_obtain_cdl) === '0') {
      gaps.push({
        id: 'cdl_obtainable', label: 'CDL obtida após a contratação',
        detail: 'O perfil declara que não pode obter CDL.', evidence: cdl.evidence
      });
    } else {
      satisfied.push({ id: 'cdl', label: 'CDL pode ser obtida após a contratação — não bloqueia.' });
    }
  } else if (cdl.requirement === CDL_REQUIREMENT.UNKNOWN) {
    unresolved.push({
      id: 'cdl', label: 'A vaga cita CDL sem dizer em que termos',
      detail: 'Não é possível determinar se é exigência prévia, preferência ou treinamento oferecido.',
      evidence: null
    });
  }

  // --- Endossos ---
  const profileEndorsements = String(driverProfile.cdl_endorsements || '')
    .toUpperCase().split(/[,;\s]+/).filter(Boolean);
  for (const e of cdl.endorsements) {
    if (!known(driverProfile.cdl_endorsements)) {
      unresolved.push({ id: `endorsement_${e.code}`, label: `Endosso ${e.code} (${e.label})`,
        detail: 'O perfil não informa os endossos.', evidence: e.evidence });
    } else if (!profileEndorsements.includes(e.code)) {
      gaps.push({ id: `endorsement_${e.code}`, label: `Endosso ${e.code} (${e.label})`,
        detail: `O perfil declara: ${driverProfile.cdl_endorsements}.`, evidence: e.evidence });
    } else {
      satisfied.push({ id: `endorsement_${e.code}`, label: `Endosso ${e.code} atendido` });
    }
  }

  // --- Demais requisitos ---
  const PROFILE_FIELD = {
    clean_driving_record: 'driving_record',
    manual_transmission: 'manual_transmission_experience',
    minimum_experience: 'truck_driving_experience',
    minimum_general_experience: 'general_experience_years',
    english_requirement: 'english_level',
    lifting: 'lifting_capacity'
  };

  for (const req of other.requirements) {
    const field = PROFILE_FIELD[req.id];
    if (!field) continue;
    const value = profileView[field];

    if (!known(value)) {
      unresolved.push({ id: req.id, label: req.label,
        detail: `O perfil não informa "${field}".`, evidence: req.evidence });
      continue;
    }

    if ((req.id === 'minimum_experience' || req.id === 'minimum_general_experience') && req.amount) {
      const years = Number(value);
      const requiredYears = req.amount.unit === 'months' ? req.amount.amount / 12 : req.amount.amount;
      if (Number.isFinite(years) && years + 0.001 >= requiredYears) {
        satisfied.push({ id: req.id, label: `${years} ano(s) de experiência atendem ${requiredYears}.` });
      } else {
        gaps.push({ id: req.id, label: req.label,
          detail: `A vaga pede ${requiredYears} ano(s); o perfil declara ${years}.`, evidence: req.evidence });
      }
      continue;
    }

    if (req.id === 'clean_driving_record') {
      const clean = /clean|limpo|no violations|sem infra/i.test(String(value));
      if (clean) satisfied.push({ id: req.id, label: 'Histórico de direção limpo declarado.' });
      else gaps.push({ id: req.id, label: req.label,
        detail: `O perfil declara histórico: ${value}.`, evidence: req.evidence });
      continue;
    }

    if (req.id === 'lifting' && req.amount) {
      const cap = Number(String(value).replace(/[^0-9.]/g, ''));
      if (Number.isFinite(cap) && cap >= req.amount.amount) {
        satisfied.push({ id: req.id, label: `Capacidade de ${cap} atende ${req.amount.amount} ${req.amount.unit}.` });
      } else if (Number.isFinite(cap)) {
        gaps.push({ id: req.id, label: req.label,
          detail: `A vaga pede ${req.amount.amount} ${req.amount.unit}; o perfil declara ${cap}.`, evidence: req.evidence });
      }
      continue;
    }

    satisfied.push({ id: req.id, label: `${req.label}: ${value}` });
  }

  const blockingGaps = gaps.filter(g => {
    const def = OTHER_REQUIREMENTS.find(r => r.id === g.id);
    return g.id.startsWith('cdl') || g.id.startsWith('endorsement_') || (def && def.blocking);
  });

  return {
    cdl,
    requirements: other.requirements,
    gaps,
    blockingGaps,
    unresolved,
    satisfied,
    eligible: blockingGaps.length === 0 && unresolved.length === 0,
    needsHumanReview: unresolved.length > 0,
    version: VERSION
  };
}

module.exports = {
  VERSION,
  CDL_REQUIREMENT,
  CDL_REQUIREMENT_LABEL,
  SEVERITY_ORDER,
  OTHER_REQUIREMENTS,
  analyzeCdl,
  extractDriverRequirements,
  extractExperienceAmount,
  extractLiftingAmount,
  evaluateEligibility
};
