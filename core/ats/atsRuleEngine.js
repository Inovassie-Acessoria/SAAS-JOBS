/**
 * ATSRuleEngine (spec §8, §11, §12, §13, §18, §52, §55).
 *
 * Resolve o pacote de regras (país + plataforma), roda o Format Analyzer,
 * aplica as regras e produz:
 *   - ATS Compatibility Score com componentes e pesos explícitos (§52);
 *   - lista de issues com severidade, motivo, evidência e correção (§12);
 *   - sugestões de reescrita ancoradas em fatos do perfil (§13).
 *
 * NUNCA reescreve o currículo do usuário (spec §69) e nunca sugere adicionar
 * uma experiência que não esteja no perfil mestre (spec §13, §54).
 */

const { BASES, EXTENSIONS, SEVERITY } = require('./rules');
const formatAnalyzer = require('./formatAnalyzer');
const ontology = require('../match/skillOntology');
const { classifyJobRequirements } = require('../match/requirementClassifier');

const SEVERITY_PENALTY = { CRITICAL: 26, HIGH: 14, MEDIUM: 7, LOW: 3 };

/**
 * Resolve o rule set efetivo para país+plataforma, mesclando base e extensão.
 * @returns {object} rule set resolvido, com `version` = id da extensão (§55)
 */
function resolveRuleSet(country, platform) {
  const c = String(country || '').toUpperCase() === 'BR' ? 'BR' : 'US';
  const p = platform ? String(platform).toLowerCase() : null;

  const extId = p ? `${c.toLowerCase()}-${p}-v1` : null;
  const ext = extId && EXTENSIONS[extId] ? EXTENSIONS[extId] : null;
  const base = ext ? BASES[ext.extends] : BASES[`${c.toLowerCase()}-general-v1`];

  if (!base) throw new Error(`Pacote de regras ATS não encontrado para país "${country}".`);

  const weights = Object.assign({}, base.weights, (ext && ext.weightOverrides) || {});
  // Renormaliza para somar 1 após os overrides.
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(weights)) weights[k] = weights[k] / sum;

  return {
    version: ext ? ext.id : base.id,
    baseId: base.id,
    country: c,
    platform: p,
    label: ext ? ext.label : base.label,
    language: base.language,
    weights,
    sections: base.sections,
    format: base.format,
    conventions: base.conventions.concat((ext && ext.conventions) || [])
  };
}

// ---------------------------------------------------------------------------
// Componentes do ATS Score (§18)
// ---------------------------------------------------------------------------

function scoreParsingQuality(signals, ruleSet) {
  let s = 100;
  if (signals.extractionConfidence === 'LOW') s -= 45;
  else if (signals.extractionConfidence === 'MEDIUM') s -= 15;
  if (signals.columns > ruleSet.format.maxColumns) s -= 25;
  if (signals.hasTextBoxes) s -= 20;
  if (signals.hasTables && !ruleSet.format.allowTables) s -= 15;
  if (signals.headerFooterContact) s -= 12;
  if (signals.hasSkillCharts) s -= 8;
  return clamp(s);
}

function scoreSectionStructure(signals, ruleSet) {
  const required = ruleSet.sections.required.length || 1;
  const missing = signals.missingRequiredSections.length;
  let s = Math.round(((required - missing) / required) * 100);
  if (signals.bulletStructure.ratio < 0.1 && signals.wordCount > 250) s -= 12;
  return clamp(s);
}

function scoreCountryConvention(signals, ruleSet) {
  let s = 100;
  if (!ruleSet.format.allowPhoto && signals.photoLikely) s -= 30;
  if (ruleSet.country === 'US' && signals.personalDetails.length) s -= 10 * signals.personalDetails.length;
  if (signals.pageCount > ruleSet.format.maxPages) s -= 15;
  if (ruleSet.country === 'US' && signals.languageMix.mixed) s -= 20;
  if (ruleSet.country === 'US' && signals.achievementSignals.quantified === 0 && signals.bulletStructure.count > 3) s -= 12;
  return clamp(s);
}

function scoreCompleteness(signals) {
  const fields = ['email', 'phone', 'location'];
  const filled = fields.filter(f => signals.contactInfo[f]).length;
  let s = Math.round((filled / fields.length) * 100);
  if (signals.dateConsistency.entriesWithDates === 0) s -= 20;
  if (signals.wordCount < 150) s -= 25;
  return clamp(s);
}

function scorePlatformReadability(signals, ruleSet) {
  let s = 100;
  if (ruleSet.platform === 'gupy') {
    if (signals.columns > 1) s -= 35;
    if (signals.hasImages) s -= 20;
    if (signals.contactInfo.filled < 3) s -= 20;
  }
  if (ruleSet.platform === 'indeed' && signals.titleAlignment && signals.titleAlignment.aligned === false) s -= 20;
  if (ruleSet.platform === 'seasonal') {
    if (!signals.availability.mentioned) s -= 20;
    if (signals.readability.avgSentenceWords > 28) s -= 10;
  }
  return clamp(s);
}

/**
 * Cobertura de conceitos da vaga presentes no texto do currículo (§18).
 * Usa a ontologia — não é contagem crua de palavras-chave.
 */
function scoreKeywordCoverage(resumeText, job) {
  if (!job) return { score: null, detail: null };
  const jobConcepts = ontology.extractKnownTerms(
    [job.title, job.description, job.requirements].filter(Boolean).join(' ')
  );
  if (!jobConcepts.length) return { score: null, detail: null };

  const resumeConcepts = new Set(ontology.extractKnownTerms(resumeText).map(c => c.canonical));

  const covered = [];
  const missing = [];
  for (const c of jobConcepts) {
    if (resumeConcepts.has(c.canonical)) covered.push(c);
    else missing.push(c);
  }

  return {
    score: Math.round((covered.length / jobConcepts.length) * 100),
    detail: { covered, missing, total: jobConcepts.length }
  };
}

function scoreExperienceAlignment(resumeText, job, signals) {
  if (!job) return null;
  const reqs = classifyJobRequirements(job);
  if (!reqs.length) return null;

  const resumeConcepts = new Set(ontology.extractKnownTerms(resumeText).map(c => c.canonical));
  let hit = 0;
  for (const r of reqs) {
    if (r.concepts.some(c => resumeConcepts.has(c.canonical))) hit++;
  }
  let s = Math.round((hit / reqs.length) * 100);
  if (signals.dateConsistency.entriesWithDates === 0) s -= 15;
  return clamp(s);
}

function scoreSkillsAlignment(resumeText, candidateSkills, job) {
  if (!job || !candidateSkills || !candidateSkills.length) return null;
  const resumeLower = (resumeText || '').toLowerCase();
  const declared = candidateSkills.length;
  const evidenced = candidateSkills.filter(s => resumeLower.includes(String(s).toLowerCase())).length;
  return clamp(Math.round((evidenced / declared) * 100));
}

function clamp(n) { return Math.max(0, Math.min(100, Math.round(n))); }

// ---------------------------------------------------------------------------
// Motor principal
// ---------------------------------------------------------------------------

/**
 * @param {object} params
 * @param {object} params.extraction     resultado de textExtract.extractText
 * @param {string} params.country        'BR' | 'US'
 * @param {string} [params.platform]     'gupy' | 'indeed' | 'seasonal'
 * @param {object} [params.job]          vaga para comparação (modo Compare, §67)
 * @param {string[]} [params.candidateSkills]
 */
function analyze({ extraction, country, platform, job = null, candidateSkills = [] }) {
  const ruleSet = resolveRuleSet(country, platform);
  const signals = formatAnalyzer.analyzeFormat(extraction, ruleSet, job);
  const text = extraction.text || '';

  // --- Issues (§12) ---
  const issues = [];
  for (const rule of ruleSet.conventions) {
    let fired = false;
    try { fired = Boolean(rule.when(signals)); } catch (e) { fired = false; }
    if (!fired) continue;

    let evidence = null;
    if (rule.evidenceFrom) {
      try { evidence = rule.evidenceFrom(signals); } catch (e) { evidence = null; }
    }
    if (!evidence && rule.id.includes('column') && signals.columnEvidence) evidence = signals.columnEvidence;
    if (!evidence && rule.id.includes('missing-sections')) evidence = signals.missingRequiredSections;

    issues.push({
      id: rule.id,
      severity: rule.severity,
      title: rule.title,
      why: rule.why,
      correction: rule.correction,
      evidence: Array.isArray(evidence) ? evidence : (evidence ? [evidence] : []),
      countryRule: ruleSet.country,
      platformRule: ruleSet.platform || 'geral',
      ruleSetVersion: ruleSet.version
    });
  }

  // Ordena por severidade
  const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);

  // --- Componentes (§52) ---
  const keyword = scoreKeywordCoverage(text, job);
  const components = {
    resume_parsing_quality: scoreParsingQuality(signals, ruleSet),
    section_structure:      scoreSectionStructure(signals, ruleSet),
    country_convention:     scoreCountryConvention(signals, ruleSet),
    content_completeness:   scoreCompleteness(signals),
    platform_readability:   scorePlatformReadability(signals, ruleSet),
    keyword_coverage:       keyword.score,
    experience_alignment:   scoreExperienceAlignment(text, job, signals),
    skills_alignment:       scoreSkillsAlignment(text, candidateSkills, job)
  };

  // Componentes nulos (sem vaga de referência) são excluídos e os pesos
  // renormalizados, em vez de contarem como zero.
  const active = Object.keys(components).filter(k => components[k] !== null);
  const activeWeightSum = active.reduce((acc, k) => acc + (ruleSet.weights[k] || 0), 0) || 1;

  let score = 0;
  const appliedWeights = {};
  for (const k of active) {
    const w = (ruleSet.weights[k] || 0) / activeWeightSum;
    appliedWeights[k] = Number(w.toFixed(4));
    score += components[k] * w;
  }

  // Penalidade adicional por issues, com teto para não zerar o score.
  const penalty = Math.min(40, issues.reduce((acc, i) => acc + SEVERITY_PENALTY[i.severity], 0));
  const finalScore = clamp(score - penalty);

  const status = formatAnalyzer.formatStatus(issues, signals);

  return {
    score: finalScore,
    version: ruleSet.version,
    ruleSetLabel: ruleSet.label,
    country: ruleSet.country,
    platform: ruleSet.platform,
    status,
    components,
    weights: appliedWeights,
    penalty,
    issues,
    keywordDetail: keyword.detail,
    signals,
    confidence: extraction.confidence,
    warnings: (extraction.warnings || []).concat(
      extraction.confidence === 'LOW'
        ? ['A análise abaixo tem confiança reduzida porque o texto do arquivo não pôde ser lido integralmente.']
        : []
    ),
    // Aviso obrigatório (spec §7) — nunca prometer aprovação.
    disclaimer: 'Não existe um algoritmo de ATS único usado por todos os empregadores. Esta é uma heurística transparente de compatibilidade de leitura e aderência, não uma previsão de aprovação ou de contratação.'
  };
}

/**
 * Sugestões de reescrita (spec §13).
 * Só propõe reforçar o que JÁ existe no perfil/currículo. Se o conceito exigido
 * pela vaga não tem lastro no perfil mestre, a saída é um alerta de lacuna real,
 * jamais um texto sugerido afirmando a experiência.
 */
function buildSuggestions(analysis, { job, masterProfile }) {
  const suggestions = [];
  if (!job || !analysis.keywordDetail) return suggestions;

  const profileSkills = (masterProfile && masterProfile.skills) || [];
  const resumeText = (analysis.signals && analysis.signals.__text) || '';

  for (const missing of analysis.keywordDetail.missing) {
    const match = ontology.matchRequirement(missing.label, profileSkills);

    if (match.type === 'NONE') {
      suggestions.push({
        type: 'GAP',
        concept: missing.label,
        canAssert: false,
        reason: `A vaga menciona ${missing.label}, e não há nada no seu perfil mestre que sustente essa competência.`,
        recommendation: 'Não inclua isso no currículo. Se você de fato tem essa experiência, registre-a primeiro no Perfil Mestre com a evidência correspondente.'
      });
      continue;
    }

    suggestions.push({
      type: 'REWRITE',
      concept: missing.label,
      canAssert: true,
      confidence: match.confidence,
      basedOn: match.matchedWith,
      reason: `A vaga cita ${missing.label} e seu perfil registra "${match.matchedWith}", que ${match.type === 'EXACT' ? 'corresponde diretamente' : 'é equivalente'}. O termo, porém, não aparece no currículo selecionado.`,
      recommendation: `Torne explícito no currículo o vínculo entre sua experiência com "${match.matchedWith}" e a terminologia ${missing.label} usada pela vaga — desde que seja verdade para sua atuação.`
    });
  }

  // Sugestões estruturais derivadas das issues
  for (const issue of analysis.issues.slice(0, 6)) {
    suggestions.push({
      type: 'STRUCTURE',
      severity: issue.severity,
      concept: issue.title,
      canAssert: true,
      reason: issue.why,
      recommendation: issue.correction
    });
  }

  return suggestions;
}

module.exports = { analyze, resolveRuleSet, buildSuggestions, SEVERITY };
