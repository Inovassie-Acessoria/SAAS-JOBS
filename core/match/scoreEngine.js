/**
 * Motor de scores (spec §17 Fit, §19 Opportunity, §22 categorias, §52 transparência).
 *
 * TRÊS scores separados, nunca fundidos (spec §6):
 *   Fit Score          — quão bem o perfil verdadeiro do candidato atende à vaga
 *   ATS Compatibility  — calculado em core/ats (não aqui)
 *   Opportunity Score  — heurística de PRIORIZAÇÃO, jamais probabilidade de contratação (§19)
 *
 * Toda saída carrega version, components, weights, evidence, warnings e confidence
 * para que mudanças futuras de algoritmo não alterem silenciosamente análises antigas.
 */

const ontology = require('./skillOntology');
const { evaluateJob, STATUS, KIND } = require('./requirementClassifier');

const FIT_VERSION = 'fit-v1';
const OPPORTUNITY_VERSION = 'opportunity-v1';

/** Pesos padrão do Fit Score (§17). Configuráveis por país/tipo de vaga. */
const DEFAULT_FIT_WEIGHTS = {
  core_skills:                  0.24,
  mandatory_requirement_coverage: 0.20,
  experience:                   0.14,
  role_similarity:              0.12,
  seniority:                    0.08,
  tools:                        0.06,
  industry:                     0.05,
  languages:                    0.05,
  education:                    0.03,
  location_work_model:          0.03
};

/** Pesos padrão do Opportunity Score (§19). */
const DEFAULT_OPPORTUNITY_WEIGHTS = {
  fit:                  0.34,
  ats:                  0.16,
  mandatory_coverage:   0.16,
  salary_compatibility: 0.10,
  freshness:            0.08,
  location:             0.06,
  preferences:          0.06,
  timing:               0.04
};

/** Categorias de recomendação (§22). Limiares configuráveis. */
const DEFAULT_THRESHOLDS = { topPriority: 90, strongMatch: 80, possibleMatch: 70 };

function categorize(score, thresholds = DEFAULT_THRESHOLDS) {
  if (score >= thresholds.topPriority) return 'TOP_PRIORITY';
  if (score >= thresholds.strongMatch) return 'STRONG_MATCH';
  if (score >= thresholds.possibleMatch) return 'POSSIBLE_MATCH';
  return 'LOW_MATCH';
}

const CATEGORY_LABEL = {
  TOP_PRIORITY:   'Prioridade máxima',
  STRONG_MATCH:   'Match forte',
  POSSIBLE_MATCH: 'Match possível',
  LOW_MATCH:      'Match baixo'
};

function clamp(n) { return Math.max(0, Math.min(100, Math.round(n))); }

// ---------------------------------------------------------------------------
// Componentes do Fit Score
// ---------------------------------------------------------------------------

function scoreCoreSkills(job, candidate) {
  const jobConcepts = ontology.extractKnownTerms(
    [job.title, job.description, job.requirements, job.duties_description, job.special_requirements]
      .filter(Boolean).join(' ')
  );
  if (!jobConcepts.length) return { value: null, evidence: [] };

  const matched = [];
  const partial = [];
  const missing = [];
  let weightSum = 0;

  for (const c of jobConcepts) {
    const m = ontology.matchRequirement(c.label, candidate.skills || []);
    weightSum += m.weight;
    if (m.type === 'EXACT' || (m.type === 'SEMANTIC' && m.confidence === 'HIGH')) {
      matched.push({ concept: c.label, matchedWith: m.matchedWith, type: m.type, confidence: m.confidence, explanation: m.explanation });
    } else if (m.type === 'SEMANTIC') {
      partial.push({ concept: c.label, matchedWith: m.matchedWith, type: m.type, confidence: m.confidence, explanation: m.explanation });
    } else {
      missing.push({ concept: c.label });
    }
  }

  return {
    value: clamp((weightSum / jobConcepts.length) * 100),
    evidence: { matched, partial, missing, total: jobConcepts.length }
  };
}

function scoreExperience(job, candidate, requirementReport) {
  const contextual = requirementReport.byKind[KIND.CONTEXTUAL]
    .concat(requirementReport.byKind[KIND.MANDATORY].filter(e => /\d+\s*\+?\s*(years?|anos?)/i.test(e.requirement)));

  if (!contextual.length) {
    const y = Number(candidate.yearsOfExperience);
    if (!Number.isFinite(y)) return { value: null, evidence: 'Tempo de experiência não informado.' };
    return { value: clamp(Math.min(100, 50 + y * 6)), evidence: `${y} anos de experiência declarados.` };
  }

  const score = contextual.reduce((acc, e) => {
    if (e.status === STATUS.MET) return acc + 1;
    if (e.status === STATUS.NEAR) return acc + 0.7;
    if (e.status === STATUS.UNRESOLVED) return acc + 0.4;
    return acc;
  }, 0) / contextual.length;

  return {
    value: clamp(score * 100),
    evidence: contextual.map(e => ({ requirement: e.requirement, status: e.status, explanation: e.explanation }))
  };
}

function scoreRoleSimilarity(job, candidate) {
  const jobTitle = job.title || job.job_title || '';
  const targets = [candidate.targetRole, candidate.headline, candidate.currentTitle].filter(Boolean);
  if (!jobTitle || !targets.length) return { value: null, evidence: null };

  const jobCanon = new Set(ontology.extractKnownTerms(jobTitle).map(c => c.canonical));
  let best = { value: 0, against: null };

  for (const t of targets) {
    const tCanon = new Set(ontology.extractKnownTerms(t).map(c => c.canonical));
    const inter = [...jobCanon].filter(c => tCanon.has(c)).length;
    const union = new Set([...jobCanon, ...tCanon]).size || 1;

    // Sobreposição textual como reforço quando a ontologia não cobre o título
    const jw = ontology.normalize(jobTitle).split(' ').filter(w => w.length > 3);
    const tw = new Set(ontology.normalize(t).split(' ').filter(w => w.length > 3));
    const wordOverlap = jw.length ? jw.filter(w => tw.has(w)).length / jw.length : 0;

    const v = clamp(Math.max((inter / union) * 100, wordOverlap * 100));
    if (v > best.value) best = { value: v, against: t };
  }

  return { value: best.value, evidence: best.against ? `Comparado com "${best.against}".` : null };
}

function scoreSeniority(job, candidate) {
  const text = ontology.normalize([job.title, job.job_title, job.description].filter(Boolean).join(' '));
  const levels = [
    { id: 'junior', re: /\b(junior|jr|entry level|trainee|estagi)/, years: 1 },
    { id: 'pleno',  re: /\b(pleno|mid level|mid-level|intermediate)/, years: 3 },
    { id: 'senior', re: /\b(senior|sr|especialista|specialist)/, years: 5 },
    { id: 'lead',   re: /\b(lead|principal|staff|head|gerente|manager|coordenador)/, years: 8 }
  ];

  const found = levels.filter(l => l.re.test(text));
  if (!found.length) return { value: null, evidence: 'Senioridade não declarada na vaga.' };

  const required = found[found.length - 1];
  const have = Number(candidate.yearsOfExperience);
  if (!Number.isFinite(have)) return { value: null, evidence: 'Tempo de experiência do candidato não informado.' };

  if (have >= required.years) return { value: 100, evidence: `Vaga ${required.id}; perfil com ${have} anos.` };
  const ratio = have / required.years;
  return {
    value: clamp(ratio * 100),
    evidence: `Vaga ${required.id} (referência ${required.years} anos); perfil com ${have} anos.`
  };
}

function scoreTools(job, candidate) {
  const tools = (candidate.tools && candidate.tools.length) ? candidate.tools : (candidate.skills || []);
  if (!tools.length) return { value: null, evidence: null };
  const jobText = [job.description, job.requirements, job.duties_description].filter(Boolean).join(' ').toLowerCase();
  if (!jobText) return { value: null, evidence: null };

  const cited = tools.filter(t => jobText.includes(String(t).toLowerCase()));
  if (!cited.length) return { value: null, evidence: 'Nenhuma ferramenta do perfil é citada na vaga.' };
  return { value: clamp((cited.length / tools.length) * 100 + 40), evidence: cited };
}

function scoreIndustry(job, candidate) {
  if (!candidate.industries || !candidate.industries.length) return { value: null, evidence: null };
  const text = ontology.normalize([job.company, job.employer_name, job.description].filter(Boolean).join(' '));
  const hit = candidate.industries.find(i => text.includes(ontology.normalize(i)));
  return hit
    ? { value: 100, evidence: `Setor "${hit}" presente no histórico.` }
    : { value: 55, evidence: 'Setor da vaga não consta no histórico — não é impeditivo.' };
}

function scoreLanguages(job, candidate, requirementReport) {
  const langReqs = requirementReport.evaluations.filter(e => /\b(english|ingl[êe]s|spanish|espanhol|fluent|fluente|idioma|language)\b/i.test(e.requirement));
  if (!langReqs.length) return { value: null, evidence: null };
  const met = langReqs.filter(e => e.status === STATUS.MET || e.status === STATUS.SEMANTIC_MET).length;
  return { value: clamp((met / langReqs.length) * 100), evidence: langReqs.map(e => e.explanation) };
}

function scoreEducation(job, candidate, requirementReport) {
  const eduReqs = requirementReport.evaluations.filter(e => /\b(degree|bachelor|graduation|gradua[çc][ãa]o|ensino superior|diploma|escolaridade)\b/i.test(e.requirement));
  if (!eduReqs.length) return { value: null, evidence: null };
  if (!candidate.education || !candidate.education.length) {
    return { value: null, evidence: 'Vaga menciona formação e o perfil não informa — o sistema não presume.' };
  }
  return { value: 100, evidence: candidate.education.map(e => e.title || e).slice(0, 3) };
}

function scoreLocationWorkModel(job, candidate) {
  const prefRemote = candidate.workplacePreference === 'remote';
  const isRemote = job.is_remote === 1 || /\bremoto|remote|home office\b/i.test(
    [job.location, job.workplace_type, job.description].filter(Boolean).join(' ')
  );

  if (prefRemote && isRemote) return { value: 100, evidence: 'Vaga remota e preferência do candidato é remota.' };
  if (prefRemote && !isRemote) return { value: 45, evidence: 'Preferência é remoto e a vaga não indica trabalho remoto.' };

  const state = job.employer_state || job.location_state;
  if (state && candidate.preferredStates && candidate.preferredStates.length) {
    const ok = candidate.preferredStates.map(s => s.trim().toUpperCase()).includes(String(state).toUpperCase());
    return ok
      ? { value: 100, evidence: `${state} está entre os estados desejados.` }
      : { value: 40, evidence: `${state} não está entre os estados desejados.` };
  }
  return { value: null, evidence: null };
}

// ---------------------------------------------------------------------------
// Fit Score
// ---------------------------------------------------------------------------

/**
 * @param {object} job        vaga normalizada
 * @param {object} candidate  perfil mestre resolvido
 * @param {object} [opts]     { weights, thresholds }
 */
function computeFitScore(job, candidate, opts = {}) {
  const weights = Object.assign({}, DEFAULT_FIT_WEIGHTS, opts.weights || {});
  const requirementReport = evaluateJob(job, candidate);

  const raw = {
    core_skills:                    scoreCoreSkills(job, candidate),
    mandatory_requirement_coverage: {
      value: requirementReport.mandatoryCoverage.total
        ? clamp(requirementReport.mandatoryCoverage.ratio * 100)
        : null,
      evidence: requirementReport.mandatoryCoverage
    },
    experience:          scoreExperience(job, candidate, requirementReport),
    role_similarity:     scoreRoleSimilarity(job, candidate),
    seniority:           scoreSeniority(job, candidate),
    tools:               scoreTools(job, candidate),
    industry:            scoreIndustry(job, candidate),
    languages:           scoreLanguages(job, candidate, requirementReport),
    education:           scoreEducation(job, candidate, requirementReport),
    location_work_model: scoreLocationWorkModel(job, candidate)
  };

  const components = {};
  const evidence = {};
  for (const k of Object.keys(raw)) {
    components[k] = raw[k].value;
    if (raw[k].evidence) evidence[k] = raw[k].evidence;
  }

  // Renormaliza pesos sobre os componentes efetivamente avaliáveis.
  const active = Object.keys(components).filter(k => components[k] !== null);
  const sum = active.reduce((a, k) => a + (weights[k] || 0), 0) || 1;

  let score = 0;
  const applied = {};
  for (const k of active) {
    const w = (weights[k] || 0) / sum;
    applied[k] = Number(w.toFixed(4));
    score += components[k] * w;
  }

  const warnings = [];
  if (requirementReport.hasBlockingGap) {
    warnings.push('Há requisito obrigatório explicitamente não atendido.');
  }
  for (const u of requirementReport.criticalUnresolved) {
    if (u.status === STATUS.UNRESOLVED) warnings.push(u.explanation);
  }
  if (active.length < 4) {
    warnings.push('Poucos componentes puderam ser avaliados — a vaga traz pouca informação estruturada.');
  }

  const confidence = active.length >= 7 ? 'HIGH' : (active.length >= 4 ? 'MEDIUM' : 'LOW');

  return {
    score: clamp(score),
    version: FIT_VERSION,
    components,
    weights: applied,
    evidence,
    warnings,
    confidence,
    requirementReport,
    category: categorize(clamp(score), opts.thresholds)
  };
}

// ---------------------------------------------------------------------------
// Opportunity Score (§19)
// ---------------------------------------------------------------------------

function scoreFreshness(job) {
  const raw = job.published_date || job.collected_at || job.posted_at;
  if (!raw) return { value: null, evidence: null };
  const d = new Date(raw);
  if (isNaN(d.getTime())) return { value: null, evidence: null };
  const days = (Date.now() - d.getTime()) / 86400000;
  if (days < 0) return { value: 100, evidence: 'Publicação futura declarada.' };
  if (days <= 2) return { value: 100, evidence: 'Publicada nas últimas 48 horas.' };
  if (days <= 7) return { value: 85, evidence: 'Publicada na última semana.' };
  if (days <= 21) return { value: 65, evidence: 'Publicada há até 3 semanas.' };
  if (days <= 60) return { value: 40, evidence: 'Publicada há mais de 3 semanas.' };
  return { value: 20, evidence: 'Publicação com mais de 2 meses.' };
}

function scoreSalaryCompatibility(job, candidate) {
  // Salário por hora (sazonal / US)
  const hourly = Number(job.wage_rate);
  if (Number.isFinite(hourly) && hourly > 0 && Number.isFinite(Number(candidate.minHourlyWage))) {
    const min = Number(candidate.minHourlyWage);
    if (hourly >= min) return { value: clamp(80 + ((hourly - min) / Math.max(min, 1)) * 100), evidence: `$${hourly}/h vs. mínimo $${min}/h.` };
    return { value: clamp((hourly / min) * 70), evidence: `$${hourly}/h abaixo do mínimo $${min}/h.` };
  }

  // Faixa anual (Indeed US)
  const yearly = Number(job.salary_min);
  if (Number.isFinite(yearly) && yearly > 0 && Number.isFinite(Number(candidate.minSalaryYear))) {
    const min = Number(candidate.minSalaryYear);
    if (yearly >= min) return { value: clamp(80 + ((yearly - min) / Math.max(min, 1)) * 60), evidence: `${yearly} vs. mínimo ${min}.` };
    return { value: clamp((yearly / min) * 70), evidence: `${yearly} abaixo do mínimo ${min}.` };
  }

  // Mensal (Gupy BR)
  const monthly = Number(job.salary_month);
  if (Number.isFinite(monthly) && monthly > 0 && Number.isFinite(Number(candidate.minSalaryMonth))) {
    const min = Number(candidate.minSalaryMonth);
    return monthly >= min
      ? { value: clamp(80 + ((monthly - min) / Math.max(min, 1)) * 60), evidence: `R$ ${monthly} vs. mínimo R$ ${min}.` }
      : { value: clamp((monthly / min) * 70), evidence: `R$ ${monthly} abaixo do mínimo R$ ${min}.` };
  }

  // Spec §21/§47: nunca inventar salário ausente.
  return { value: null, evidence: 'Salário não informado pela vaga.' };
}

function scorePreferences(job, candidate) {
  const prefs = [];
  if (candidate.excludedOccupations && candidate.excludedOccupations.length) {
    const text = ontology.normalize([job.title, job.job_title, job.description].filter(Boolean).join(' '));
    const hit = candidate.excludedOccupations.find(o => text.includes(ontology.normalize(o)));
    if (hit) return { value: 0, evidence: `Ocupação "${hit}" está na lista de exclusões do candidato.` };
    prefs.push('Nenhuma ocupação excluída presente.');
  }
  if (candidate.preferredOccupations && candidate.preferredOccupations.length) {
    const text = ontology.normalize([job.title, job.job_title, job.description].filter(Boolean).join(' '));
    const hit = candidate.preferredOccupations.find(o => text.includes(ontology.normalize(o)));
    if (hit) return { value: 100, evidence: `Ocupação preferida "${hit}" identificada.` };
  }
  if (job.housing_provided === 1 && candidate.housingRequired) {
    prefs.push('Alojamento fornecido, conforme preferência.');
    return { value: 100, evidence: prefs };
  }
  if (job.housing_provided === 0 && candidate.housingRequired) {
    return { value: 30, evidence: 'Candidato precisa de alojamento e a vaga não fornece.' };
  }
  return prefs.length ? { value: 70, evidence: prefs } : { value: null, evidence: null };
}

/**
 * @param {object} params
 * @param {object} params.job
 * @param {object} params.candidate
 * @param {object} params.fit         saída de computeFitScore
 * @param {number} [params.atsScore]
 * @param {object} [params.timeline]  saída de classifyTimeline (Seasonal)
 */
function computeOpportunityScore({ job, candidate, fit, atsScore = null, timeline = null, weights: w = {}, thresholds }) {
  const weights = Object.assign({}, DEFAULT_OPPORTUNITY_WEIGHTS, w);

  const freshness = scoreFreshness(job);
  const salary = scoreSalaryCompatibility(job, candidate);
  const preferences = scorePreferences(job, candidate);
  const location = fit.components.location_work_model;

  const components = {
    fit:                  fit.score,
    ats:                  atsScore,
    mandatory_coverage:   fit.components.mandatory_requirement_coverage,
    salary_compatibility: salary.value,
    freshness:            freshness.value,
    location:             location,
    preferences:          preferences.value,
    timing:               timeline ? timeline.weight : null
  };

  const active = Object.keys(components).filter(k => components[k] !== null);
  const sum = active.reduce((a, k) => a + (weights[k] || 0), 0) || 1;

  let score = 0;
  const applied = {};
  for (const k of active) {
    const wk = (weights[k] || 0) / sum;
    applied[k] = Number(wk.toFixed(4));
    score += components[k] * wk;
  }

  // Requisito obrigatório não atendido rebaixa a prioridade de forma explícita.
  const warnings = [];
  if (fit.requirementReport && fit.requirementReport.hasBlockingGap) {
    score = Math.min(score, 55);
    warnings.push('Prioridade limitada: há requisito obrigatório não atendido.');
  }
  const unresolved = (fit.requirementReport && fit.requirementReport.criticalUnresolved) || [];
  if (unresolved.length) {
    score = Math.min(score, 82);
    warnings.push(`${unresolved.length} requisito(s) crítico(s) em aberto reduzem a prioridade até que sejam resolvidos.`);
  }

  const evidence = {
    freshness: freshness.evidence,
    salary_compatibility: salary.evidence,
    preferences: preferences.evidence,
    timing: timeline ? timeline.explanation : null
  };

  return {
    score: clamp(score),
    version: OPPORTUNITY_VERSION,
    components,
    weights: applied,
    evidence,
    warnings,
    confidence: active.length >= 5 ? 'HIGH' : (active.length >= 3 ? 'MEDIUM' : 'LOW'),
    category: categorize(clamp(score), thresholds),
    // Spec §19 / §81.7 — nunca chamar de probabilidade de contratação.
    disclaimer: 'Opportunity Score é uma heurística de priorização de esforço. Não representa probabilidade de contratação.'
  };
}

/**
 * Preocupações relevantes (spec §24). Só retorna o que for materialmente relevante.
 */
function buildConcerns({ fit, opportunity, atsAnalysis, job, candidate }) {
  const concerns = [];

  for (const u of (fit.requirementReport ? fit.requirementReport.criticalUnresolved : [])) {
    concerns.push({
      severity: u.status === STATUS.NOT_MET ? 'CRITICAL' : 'HIGH',
      title: u.status === STATUS.NOT_MET ? 'Requisito obrigatório não atendido' : 'Requisito obrigatório em aberto',
      detail: u.explanation,
      evidence: u.requirement
    });
  }

  if (opportunity.components.salary_compatibility !== null && opportunity.components.salary_compatibility < 55) {
    concerns.push({
      severity: 'MEDIUM', title: 'Salário abaixo da pretensão',
      detail: opportunity.evidence.salary_compatibility, evidence: null
    });
  }

  if (fit.components.location_work_model !== null && fit.components.location_work_model < 50) {
    concerns.push({
      severity: 'MEDIUM', title: 'Incompatibilidade de local ou modelo de trabalho',
      detail: (fit.evidence.location_work_model || 'Local ou modelo de trabalho diverge da preferência.'), evidence: null
    });
  }

  if (opportunity.components.freshness !== null && opportunity.components.freshness <= 20) {
    concerns.push({
      severity: 'LOW', title: 'Publicação antiga',
      detail: opportunity.evidence.freshness, evidence: null
    });
  }

  if (atsAnalysis) {
    const blocking = atsAnalysis.issues.filter(i => i.severity === 'CRITICAL' || i.severity === 'HIGH');
    if (blocking.length) {
      concerns.push({
        severity: blocking[0].severity, title: 'Problema de formato do currículo',
        detail: `${blocking.length} problema(s) de alto impacto na leitura automática. Ver ATS Center.`,
        evidence: blocking.slice(0, 3).map(i => i.title)
      });
    }
  }

  return concerns;
}

module.exports = {
  FIT_VERSION,
  OPPORTUNITY_VERSION,
  DEFAULT_FIT_WEIGHTS,
  DEFAULT_OPPORTUNITY_WEIGHTS,
  DEFAULT_THRESHOLDS,
  CATEGORY_LABEL,
  categorize,
  computeFitScore,
  computeOpportunityScore,
  buildConcerns
};
