/**
 * Classificação de requisitos (spec §15) e tratamento de habilidade crítica (§16).
 *
 * Requisitos NÃO são todos iguais. Faltar um "diferencial" e faltar uma
 * habilitação obrigatória têm consequências diferentes, e o sistema não deve
 * aplicar penalidade uniforme (spec §16).
 */

const ontology = require('./skillOntology');

const KIND = {
  MANDATORY:  'MANDATORY',
  PREFERRED:  'PREFERRED',
  CONTEXTUAL: 'CONTEXTUAL',
  AMBIGUOUS:  'AMBIGUOUS'
};

const STATUS = {
  MET:            'MET',             // atendido
  SEMANTIC_MET:   'SEMANTIC_MET',    // atendido por equivalência
  NEAR:           'NEAR',            // quase atendido (§15 — 4.7 anos para 5+)
  UNRESOLVED:     'UNRESOLVED',      // não há informação para decidir
  NOT_MET:        'NOT_MET'
};

const MANDATORY_MARKERS = [
  /\brequired\b/i, /\bmust have\b/i, /\bmust be\b/i, /\bmandatory\b/i, /\bessential\b/i,
  /\bobrigat[óo]ri[oa]\b/i, /\bindispens[áa]vel\b/i, /\b[ée] necess[áa]rio\b/i,
  /\brequisitos? obrigat[óo]rios?\b/i, /\bexig[ei]/i, /\bvalid\b.*\blicen[cs]e\b/i
];

const PREFERRED_MARKERS = [
  /\bpreferred\b/i, /\bnice to have\b/i, /\ba plus\b/i, /\bdesirable\b/i, /\bbonus\b/i,
  /\bdesej[áa]vel\b/i, /\bdiferencial\b/i, /\bser[áa] um plus\b/i, /\bvantagem\b/i
];

const CONTEXTUAL_MARKERS = [
  /\b(\d+)\s*\+?\s*(?:years?|anos?)\b/i,
  /\bm[íi]nimo de\s*(\d+)/i,
  /\bat least\s*(\d+)/i,
  /\bminimum\s*(?:of\s*)?(\d+)/i
];

/**
 * Requisitos que, quando ausentes, são bloqueantes de fato — não uma questão
 * de pontuação (spec §16). São verificados contra o perfil de forma explícita.
 */
const HARD_GATE_PATTERNS = [
  { id: 'drivers_license', re: /\b(driver'?s? licen[cs]e|CDL|carteira de habilita[çc][ãa]o|CNH)\b/i,
    label: 'Habilitação de motorista' },
  { id: 'work_authorization', re: /\b(work authorization|authorized to work|legally authorized|green card|us citizen)\b/i,
    label: 'Autorização de trabalho' },
  { id: 'certification', re: /\b(certification required|certified|certifica[çc][ãa]o obrigat[óo]ria)\b/i,
    label: 'Certificação' },
  { id: 'language', re: /\b(fluent|fluência|fluente|native speaker|proficiency required)\b/i,
    label: 'Idioma' }
];

// ---------------------------------------------------------------------------

/** Quebra o texto de requisitos em linhas/frases candidatas. */
function splitRequirements(text) {
  if (!text) return [];
  return String(text)
    .split(/\n|(?<=[.;])\s+(?=[A-ZÀ-Ý])|•|·|▪|‣/)
    .map(s => s.replace(/^[\s\-–—*•·]+/, '').trim())
    .filter(s => s.length >= 8 && s.length <= 400);
}

/** Classifica uma única frase de requisito. */
function classifyOne(sentence) {
  const isMandatory = MANDATORY_MARKERS.some(re => re.test(sentence));
  const isPreferred = PREFERRED_MARKERS.some(re => re.test(sentence));

  let years = null;
  for (const re of CONTEXTUAL_MARKERS) {
    const m = sentence.match(re);
    if (m) { years = parseInt(m[1], 10); break; }
  }

  const gate = HARD_GATE_PATTERNS.find(g => g.re.test(sentence)) || null;

  let kind;
  if (isPreferred && !isMandatory) kind = KIND.PREFERRED;
  else if (isMandatory || gate) kind = KIND.MANDATORY;
  else if (years !== null) kind = KIND.CONTEXTUAL;
  else kind = KIND.AMBIGUOUS;

  // Um requisito com anos E marcador obrigatório é contextual-obrigatório:
  // permite "near match" mas pesa como obrigatório.
  const contextual = years !== null;

  return {
    text: sentence,
    kind,
    contextual,
    requiredYears: years,
    hardGate: gate ? gate.id : null,
    hardGateLabel: gate ? gate.label : null,
    concepts: ontology.extractKnownTerms(sentence)
  };
}

/**
 * Classifica todos os requisitos de uma vaga.
 * @param {{description?:string, requirements?:string}} job
 */
function classifyJobRequirements(job) {
  const blocks = [job && job.requirements, job && job.description].filter(Boolean).join('\n');
  const sentences = splitRequirements(blocks);

  const seen = new Set();
  const out = [];

  for (const s of sentences) {
    const key = s.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);

    const c = classifyOne(s);
    // Só guardamos frases que carregam algum conceito reconhecível ou um gate.
    if (c.concepts.length > 0 || c.hardGate || c.requiredYears !== null) out.push(c);
  }

  return out;
}

// ---------------------------------------------------------------------------

/**
 * Avalia um requisito classificado contra o perfil do candidato.
 *
 * @param {object} req            saída de classifyOne
 * @param {object} candidate      { skills:[], yearsOfExperience:number, attributes:{} }
 * @returns {object} avaliação com status, evidência e confiança
 */
function evaluateRequirement(req, candidate) {
  const skills = candidate.skills || [];

  // --- Gate obrigatório: precisa de confirmação explícita no perfil ---
  if (req.hardGate) {
    const attr = (candidate.attributes || {})[req.hardGate];
    if (attr === true || (typeof attr === 'string' && attr.trim())) {
      return {
        requirement: req.text, kind: req.kind, status: STATUS.MET, confidence: 'HIGH',
        evidence: typeof attr === 'string' ? attr : `${req.hardGateLabel} confirmado no perfil.`,
        explanation: `${req.hardGateLabel} está declarado no perfil do candidato.`
      };
    }
    if (attr === false) {
      return {
        requirement: req.text, kind: req.kind, status: STATUS.NOT_MET, confidence: 'HIGH',
        evidence: null,
        explanation: `${req.hardGateLabel} é exigido e o perfil declara não possuir.`
      };
    }
    // Sem informação: NÃO presumir (spec §54). Fica pendente e é sinalizado.
    return {
      requirement: req.text, kind: req.kind, status: STATUS.UNRESOLVED, confidence: 'HIGH',
      evidence: null,
      explanation: `${req.hardGateLabel} é exigido e o perfil não informa. Requisito crítico em aberto — o sistema não pode presumir.`
    };
  }

  // --- Requisito de tempo de experiência (§15) ---
  if (req.requiredYears !== null) {
    const have = Number(candidate.yearsOfExperience);
    if (!Number.isFinite(have)) {
      return {
        requirement: req.text, kind: req.kind, status: STATUS.UNRESOLVED, confidence: 'MEDIUM',
        evidence: null,
        explanation: `A vaga pede ${req.requiredYears} ano(s) e o perfil não informa tempo de experiência.`
      };
    }
    if (have >= req.requiredYears) {
      return {
        requirement: req.text, kind: req.kind, status: STATUS.MET, confidence: 'HIGH',
        evidence: `${have} anos de experiência no perfil.`,
        explanation: `A vaga pede ${req.requiredYears}; o perfil tem ${have}.`
      };
    }
    // Faixa de "quase atendido": até 15% abaixo, ou 1 ano de diferença.
    const gap = req.requiredYears - have;
    if (gap <= Math.max(1, req.requiredYears * 0.15)) {
      return {
        requirement: req.text, kind: req.kind, status: STATUS.NEAR, confidence: 'HIGH',
        evidence: `${have} anos de experiência no perfil.`,
        explanation: `A vaga pede ${req.requiredYears} e o perfil tem ${have} — diferença de ${gap.toFixed(1)} ano. Revisão contextual recomendada.`
      };
    }
    return {
      requirement: req.text, kind: req.kind, status: STATUS.NOT_MET, confidence: 'HIGH',
      evidence: `${have} anos de experiência no perfil.`,
      explanation: `A vaga pede ${req.requiredYears} e o perfil tem ${have}.`
    };
  }

  // --- Requisito por conceito/habilidade ---
  if (req.concepts.length) {
    const results = req.concepts.map(c => ({
      concept: c,
      match: ontology.matchRequirement(c.label, skills)
    }));

    const best = results.reduce((a, b) => (b.match.weight > a.match.weight ? b : a));

    if (best.match.type === 'EXACT') {
      return {
        requirement: req.text, kind: req.kind, status: STATUS.MET, confidence: 'HIGH',
        matchedWith: best.match.matchedWith, concept: best.concept.label,
        evidence: best.match.matchedWith,
        explanation: best.match.explanation
      };
    }
    if (best.match.type === 'SEMANTIC') {
      // Confiança baixa não conta como cobertura plena (spec §53).
      const status = best.match.confidence === 'LOW' ? STATUS.NEAR : STATUS.SEMANTIC_MET;
      return {
        requirement: req.text, kind: req.kind, status, confidence: best.match.confidence,
        matchedWith: best.match.matchedWith, concept: best.concept.label,
        evidence: best.match.matchedWith,
        explanation: best.match.explanation
      };
    }

    return {
      requirement: req.text, kind: req.kind, status: STATUS.NOT_MET, confidence: 'MEDIUM',
      concept: best.concept.label, evidence: null,
      explanation: `Nenhuma habilidade do perfil corresponde a ${best.concept.label}.`
    };
  }

  return {
    requirement: req.text, kind: req.kind, status: STATUS.UNRESOLVED, confidence: 'LOW',
    evidence: null,
    explanation: 'Requisito sem conceito reconhecível — precisa de leitura humana.'
  };
}

/**
 * Avalia a vaga inteira e resume a cobertura por classe de requisito.
 * A penalidade NÃO é uniforme: obrigatórios pesam, preferidos pesam pouco (§16).
 */
function evaluateJob(job, candidate) {
  const classified = classifyJobRequirements(job);
  const evaluations = classified.map(r => evaluateRequirement(r, candidate));

  const byKind = { MANDATORY: [], PREFERRED: [], CONTEXTUAL: [], AMBIGUOUS: [] };
  for (const e of evaluations) byKind[e.kind].push(e);

  const coverageOf = list => {
    if (!list.length) return { ratio: 1, met: 0, total: 0 };
    const score = list.reduce((acc, e) => {
      if (e.status === STATUS.MET) return acc + 1;
      if (e.status === STATUS.SEMANTIC_MET) return acc + (e.confidence === 'HIGH' ? 0.95 : 0.65);
      if (e.status === STATUS.NEAR) return acc + 0.5;
      return acc;
    }, 0);
    return {
      ratio: score / list.length,
      met: list.filter(e => e.status === STATUS.MET || e.status === STATUS.SEMANTIC_MET).length,
      total: list.length
    };
  };

  const mandatory = coverageOf(byKind.MANDATORY.concat(byKind.CONTEXTUAL));
  const preferred = coverageOf(byKind.PREFERRED);

  // Requisitos críticos em aberto (§24 — "Potential Concerns")
  const criticalUnresolved = evaluations.filter(
    e => (e.kind === KIND.MANDATORY) && (e.status === STATUS.UNRESOLVED || e.status === STATUS.NOT_MET)
  );

  return {
    evaluations,
    byKind,
    mandatoryCoverage: mandatory,
    preferredCoverage: preferred,
    criticalUnresolved,
    hasBlockingGap: criticalUnresolved.some(e => e.status === STATUS.NOT_MET)
  };
}

module.exports = {
  KIND,
  STATUS,
  splitRequirements,
  classifyOne,
  classifyJobRequirements,
  evaluateRequirement,
  evaluateJob
};
