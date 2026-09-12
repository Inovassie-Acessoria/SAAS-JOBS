/**
 * ATS Center e ATS Compare, escopados por plataforma e país (spec §1E, §1F).
 *
 * A análise SEMPRE usa o perfil e o currículo do ambiente ativo. Não existe
 * fallback: se o ambiente não tem currículo, a resposta é explícita, e o
 * currículo de outra plataforma jamais é usado no lugar.
 */

const { db, logCore } = require('../config/database');
const atsEngine = require('../core/ats/atsRuleEngine');
const candidate = require('./candidateService');
const { extractText } = require('../core/documents/textExtract');

/** Reconstrói o objeto de extração a partir do que está gravado no currículo. */
function extractionFromResume(resume) {
  if (resume.extracted_text) {
    return {
      text: resume.extracted_text,
      pages: Math.max(1, Math.ceil(resume.extracted_text.length / 3000)),
      confidence: resume.extraction_confidence || 'MEDIUM',
      format: (resume.mime_type || '').includes('pdf') ? 'pdf' : 'docx',
      hasImages: false,
      warnings: []
    };
  }
  return extractText(resume.file_path, resume.original_name);
}

/**
 * Analisa um currículo do ambiente, sem vaga de referência (ATS Center).
 * O pacote de regras vem do país E da plataforma do próprio ambiente.
 */
function analyzeResume(platform, country, resumeId, { force = false, userId } = {}) {
  const store = candidate.environment(platform, country, userId);
  const resume = store.getResume(resumeId);
  if (!resume) {
    throw new candidate.EnvironmentError(
      `Documento não encontrado em ${store.label}. Currículos de outros ambientes não são acessíveis aqui.`, 404);
  }

  const ruleSet = atsEngine.resolveRuleSet(store.country, store.platform);

  if (!force) {
    const cached = db.prepare(`SELECT * FROM ${store.tables.analysis}
                               WHERE resume_id = ? AND rule_set_version = ?`)
      .get(resumeId, ruleSet.version);
    if (cached) return hydrate(cached, resume, store);
  }

  const profile = store.getProfile();
  const analysis = atsEngine.analyze({
    extraction: extractionFromResume(resume),
    country: store.country,
    platform: store.platform,
    candidateSkills: profile.skills
  });

  return persist(store, resumeId, resume, analysis);
}

/** Compara um currículo do ambiente contra uma vaga do mesmo ambiente (§1E). */
function compareResumeToJob(platform, country, resumeId, job, { userId } = {}) {
  const store = candidate.environment(platform, country, userId);
  const resume = store.getResume(resumeId);
  if (!resume) {
    throw new candidate.EnvironmentError(
      `Documento não encontrado em ${store.label}.`, 404);
  }

  const profile = store.getProfile();
  const analysis = atsEngine.analyze({
    extraction: extractionFromResume(resume),
    country: store.country,
    platform: store.platform,
    job,
    candidateSkills: profile.skills
  });

  // O contexto de IA é montado SOMENTE com dados deste ambiente (§1F).
  const suggestions = atsEngine.buildSuggestions(analysis, { job, masterProfile: profile });

  return {
    environment: store.label,
    resume: { id: resume.id, name: resume.name, careerTrack: resume.career_track, country: resume.country },
    job: { title: job.title || job.job_title, company: job.company || job.employer_name },
    analysis,
    suggestions,
    missingMandatory: analysis.keywordDetail ? analysis.keywordDetail.missing.length : null
  };
}

function persist(store, resumeId, resume, analysis) {
  db.prepare(`INSERT INTO ${store.tables.analysis}
      (resume_id, rule_set_version, platform, score, status,
       components_json, weights_json, signals_json, issues_json)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(resume_id, rule_set_version) DO UPDATE SET
        score = excluded.score, status = excluded.status,
        components_json = excluded.components_json, weights_json = excluded.weights_json,
        signals_json = excluded.signals_json, issues_json = excluded.issues_json,
        analyzed_at = CURRENT_TIMESTAMP`)
    .run(resumeId, analysis.version, store.platform, analysis.score, analysis.status,
         JSON.stringify(analysis.components), JSON.stringify(analysis.weights),
         JSON.stringify(summarizeSignals(analysis.signals)),
         JSON.stringify(analysis.issues));

  db.prepare(`UPDATE ${store.tables.resumes} SET ats_health = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(analysis.score, resumeId);

  logCore('ats', 'resume_analyzed',
    `"${resume.name}" (${store.label}) analisado com ${analysis.version}: ${analysis.score}/100, ${analysis.issues.length} problema(s).`,
    { environment: store.label, resumeId, version: analysis.version, score: analysis.score });

  return {
    environment: store.label,
    resume: { id: resume.id, name: resume.name, careerTrack: resume.career_track, country: resume.country },
    analysis
  };
}

function hydrate(cached, resume, store) {
  return {
    environment: store.label,
    resume: { id: resume.id, name: resume.name, careerTrack: resume.career_track, country: resume.country },
    analysis: {
      score: cached.score,
      version: cached.rule_set_version,
      status: cached.status,
      components: safeParse(cached.components_json, {}),
      weights: safeParse(cached.weights_json, {}),
      signals: safeParse(cached.signals_json, {}),
      issues: safeParse(cached.issues_json, []),
      cached: true,
      analyzedAt: cached.analyzed_at,
      disclaimer: 'Não existe um algoritmo de ATS único usado por todos os empregadores. Esta é uma heurística transparente de compatibilidade, não uma previsão de aprovação.'
    }
  };
}

function summarizeSignals(s) {
  if (!s) return {};
  return {
    columns: s.columns, hasTables: s.hasTables, hasTextBoxes: s.hasTextBoxes,
    hasImages: s.hasImages, hasSkillCharts: s.hasSkillCharts, photoLikely: s.photoLikely,
    pageCount: s.pageCount, wordCount: s.wordCount, fileType: s.fileType,
    extractionConfidence: s.extractionConfidence,
    missingRequiredSections: s.missingRequiredSections,
    sectionsFound: (s.sectionTitlesFound || []).map(x => x.section),
    contactInfo: {
      email: Boolean(s.contactInfo && s.contactInfo.email),
      phone: Boolean(s.contactInfo && s.contactInfo.phone),
      filled: s.contactInfo && s.contactInfo.filled
    },
    bullets: s.bulletStructure && s.bulletStructure.count,
    quantifiedAchievements: s.achievementSignals && s.achievementSignals.quantified,
    personalDetails: s.personalDetails,
    languageMixed: s.languageMix && s.languageMix.mixed
  };
}

/** Painel do ATS Center de um ambiente (spec §66 do spec de produto). */
function atsCenter(platform, country, userId) {
  const store = candidate.environment(platform, country, userId);
  const ruleSet = atsEngine.resolveRuleSet(store.country, store.platform);
  const resumes = store.listResumes({ docType: 'resume' });

  const items = resumes.map(r => {
    const a = db.prepare(`SELECT * FROM ${store.tables.analysis}
                          WHERE resume_id = ? AND rule_set_version = ?`).get(r.id, ruleSet.version);
    const issues = a ? safeParse(a.issues_json, []) : [];
    return {
      id: r.id, name: r.name, careerTrack: r.career_track, isDefault: r.is_default,
      score: a ? a.score : null, status: a ? a.status : null,
      criticalIssues: a ? issues.filter(i => i.severity === 'CRITICAL' || i.severity === 'HIGH').length : null,
      analyzedAt: a ? a.analyzed_at : null,
      extractionConfidence: r.extraction_confidence
    };
  });

  const analyzed = items.filter(i => i.score !== null);

  return {
    environment: store.label,
    platform: store.platform,
    country: store.country,
    ruleSet: { version: ruleSet.version, label: ruleSet.label, baseId: ruleSet.baseId },
    resumes: items,
    selected: items.find(i => i.isDefault) || items[0] || null,
    averageHealth: analyzed.length
      ? Math.round(analyzed.reduce((a, i) => a + i.score, 0) / analyzed.length) : null,
    totalCriticalIssues: analyzed.reduce((a, i) => a + (i.criticalIssues || 0), 0),
    pendingAnalysis: items.filter(i => i.score === null).length,
    emptyMessage: items.length ? null
      : `Nenhum currículo configurado para ${store.label}. Adicione um neste ambiente — o sistema não reutiliza currículos de outras plataformas.`,
    disclaimer: 'ATS Compatibility é uma heurística transparente. Não existe algoritmo de ATS único entre empregadores, e este número não prevê aprovação.'
  };
}

/**
 * Resolve o ATS do currículo ativo de um ambiente, para alimentar o pipeline.
 * Devolve score nulo — nunca o de outro ambiente — quando não há currículo.
 */
function resolveEnvironmentAts(platform, country, { careerTrack = null, userId } = {}) {
  const empty = { score: null, version: null, components: {}, status: null, analysis: null, resume: null, reason: null };
  try {
    const store = candidate.environment(platform, country, userId);
    const rec = store.recommendResume({ careerTrack });
    if (!rec.resume) return Object.assign({}, empty, { reason: rec.reason });

    const out = analyzeResume(platform, country, rec.resume.id, { userId });
    return {
      score: out.analysis.score, version: out.analysis.version,
      components: out.analysis.components, status: out.analysis.status,
      analysis: out.analysis, resume: out.resume, reason: rec.reason
    };
  } catch (e) {
    return Object.assign({}, empty, { reason: e.message });
  }
}

function listRuleSets() {
  return db.prepare('SELECT * FROM core_ats_rule_sets ORDER BY country, platform').all();
}

function safeParse(s, f) { try { return JSON.parse(s || ''); } catch (e) { return f; } }

module.exports = {
  analyzeResume, compareResumeToJob, atsCenter,
  resolveEnvironmentAts, listRuleSets, extractionFromResume
};
