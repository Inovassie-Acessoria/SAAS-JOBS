/**
 * Pipeline de ingestão e análise (spec §73).
 *
 *   Import → Normalize → Deduplicate → Hard Filters → Pré-filtro semântico
 *          → Análise → Scores (Fit / ATS / Opportunity)
 *
 * O código é compartilhado entre os três produtos — o spec §1 permite
 * infraestrutura técnica comum. Os DADOS permanecem isolados: cada produto
 * passa seu próprio descritor de tabelas e nada cruza entre eles.
 *
 * Deduplicação acontece SEMPRE dentro do escopo do produto (spec §25 do build
 * prompt): o pipeline nunca consulta a tabela de outro produto.
 */

const crypto = require('crypto');
const { db } = require('../config/database');
const scoreEngine = require('../core/match/scoreEngine');
const { classifyJobRequirements } = require('../core/match/requirementClassifier');
const ontology = require('../core/match/skillOntology');

const ANALYSIS_VERSION = 'analysis-v1';

/** Hash do conteúdo relevante — evita reanalisar vaga que não mudou (§73). */
function contentHash(job) {
  const material = [
    job.title || job.job_title, job.company || job.employer_name,
    job.description || job.duties_description, job.requirements || job.special_requirements,
    job.wage_rate, job.salary_min, job.salary_max, job.start_date, job.end_date
  ].join('|');
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Hard Filters — determinísticos, antes de qualquer análise cara (§73)
// ---------------------------------------------------------------------------

/**
 * @returns {{passed:boolean, reason:string|null, rule:string|null}}
 */
function applyHardFilters(job, config = {}) {
  const text = ontology.normalize(
    [job.title, job.job_title, job.description, job.duties_description, job.special_requirements]
      .filter(Boolean).join(' ')
  );

  // Ocupações explicitamente excluídas pelo candidato
  for (const excluded of (config.excludedOccupations || [])) {
    const e = ontology.normalize(excluded);
    if (e && text.includes(e)) {
      return { passed: false, rule: 'excluded_occupation', reason: `Ocupação excluída pelo candidato: "${excluded}".` };
    }
  }

  // Termos obrigatórios ausentes
  for (const term of (config.requiredTerms || [])) {
    const t = ontology.normalize(term);
    if (t && !text.includes(t)) {
      return { passed: false, rule: 'missing_required_term', reason: `Termo obrigatório ausente: "${term}".` };
    }
  }

  // Termos banidos
  for (const term of (config.excludedTerms || [])) {
    const t = ontology.normalize(term);
    if (t && text.includes(t)) {
      return { passed: false, rule: 'excluded_term', reason: `Termo excluído presente: "${term}".` };
    }
  }

  // Salário abaixo do mínimo — só filtra quando o salário É informado (§47)
  if (config.minHourlyWage && Number(job.wage_rate) > 0 && Number(job.wage_rate) < Number(config.minHourlyWage)) {
    return { passed: false, rule: 'below_min_wage', reason: `Salário $${job.wage_rate}/h abaixo do mínimo $${config.minHourlyWage}/h.` };
  }
  if (config.minSalaryYear && Number(job.salary_max) > 0 && Number(job.salary_max) < Number(config.minSalaryYear)) {
    return { passed: false, rule: 'below_min_salary', reason: `Faixa salarial máxima abaixo do mínimo pretendido.` };
  }
  if (config.minSalaryMonth && Number(job.salary_month) > 0 && Number(job.salary_month) < Number(config.minSalaryMonth)) {
    return { passed: false, rule: 'below_min_salary', reason: `Salário mensal abaixo do mínimo pretendido.` };
  }

  // Estados desejados (sazonal / presencial)
  if (config.preferredStates && config.preferredStates.length) {
    const st = job.employer_state || job.location_state;
    if (st && !config.preferredStates.map(s => s.trim().toUpperCase()).includes(String(st).toUpperCase())) {
      return { passed: false, rule: 'state_not_desired', reason: `Estado ${st} fora da lista de estados desejados.` };
    }
  }

  // Modelo de trabalho incompatível
  if (config.remoteOnly) {
    const isRemote = job.is_remote === 1 || job.workplace_type === 'remote' || /\bremot|home office\b/i.test(text);
    if (!isRemote) {
      return { passed: false, rule: 'not_remote', reason: 'Vaga não é remota e a preferência é exclusivamente remoto.' };
    }
  }

  // Vaga expirada
  if (job.end_date) {
    const end = new Date(job.end_date);
    if (!isNaN(end.getTime()) && end.getTime() < Date.now()) {
      return { passed: false, rule: 'expired', reason: `Período de trabalho encerrado em ${job.end_date}.` };
    }
  }

  // Tipo de visto não desejado
  if (job.visa_type && config.visaPreferences) {
    const v = String(job.visa_type).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const wanted = config.visaPreferences.map(x => String(x).toUpperCase().replace(/[^A-Z0-9]/g, ''));
    if (wanted.length && !wanted.includes(v)) {
      return { passed: false, rule: 'visa_not_desired', reason: `Visto ${job.visa_type} fora da preferência.` };
    }
  }

  return { passed: true, reason: null, rule: null };
}

/**
 * Pré-filtro semântico barato (§73): descarta o que claramente não conversa
 * com o perfil, antes de rodar a análise completa. Nunca descarta quando a vaga
 * não traz conceitos reconhecíveis — nesse caso segue para a análise.
 */
function semanticPrefilter(job, candidateProfile, minOverlap = 1) {
  const jobConcepts = ontology.extractKnownTerms(
    [job.title, job.job_title, job.description, job.duties_description, job.special_requirements]
      .filter(Boolean).join(' ')
  );
  if (!jobConcepts.length) return { passed: true, reason: 'Vaga sem conceitos reconhecíveis — segue para análise completa.' };

  const profileConcepts = new Set(
    ontology.extractKnownTerms((candidateProfile.skills || []).join(' ')).map(c => c.canonical)
  );
  if (!profileConcepts.size) return { passed: true, reason: 'Perfil sem habilidades cadastradas — nada a pré-filtrar.' };

  const overlap = jobConcepts.filter(c => profileConcepts.has(c.canonical));
  if (overlap.length >= minOverlap) {
    return { passed: true, overlap: overlap.map(c => c.label) };
  }
  return {
    passed: false,
    reason: `Nenhuma sobreposição conceitual entre a vaga e o perfil (${jobConcepts.slice(0, 4).map(c => c.label).join(', ')}).`
  };
}

// ---------------------------------------------------------------------------
// Persistência de scores
// ---------------------------------------------------------------------------

function saveAnalysis(tables, jobId, requirementReport, concerns, hash) {
  db.prepare(`INSERT INTO ${tables.analysis}
      (job_id, requirements_json, concerns_json, analysis_version, content_hash)
      VALUES (?,?,?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET
        requirements_json = excluded.requirements_json,
        concerns_json = excluded.concerns_json,
        analysis_version = excluded.analysis_version,
        content_hash = excluded.content_hash,
        analyzed_at = CURRENT_TIMESTAMP`)
    .run(jobId,
         JSON.stringify((requirementReport.evaluations || []).slice(0, 60)),
         JSON.stringify(concerns), ANALYSIS_VERSION, hash);
}

function saveMatch(tables, jobId, { fit, ats, opportunity, queue }) {
  const hasQueue = Boolean(queue);
  const cols = `job_id, fit_score, fit_version, fit_components_json, fit_weights_json, fit_evidence_json, fit_confidence,
                ats_score, ats_version, ats_components_json, ats_status,
                opportunity_score, opportunity_version, opportunity_components_json,
                category, warnings_json${hasQueue ? ', queue_priority, queue_breakdown_json' : ''}`;
  const placeholders = hasQueue ? '?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?' : '?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?';

  const params = [
    jobId,
    fit.score, fit.version, JSON.stringify(fit.components), JSON.stringify(fit.weights),
    JSON.stringify(fit.evidence || {}), fit.confidence,
    ats ? ats.score : null, ats ? ats.version : null,
    ats ? JSON.stringify(ats.components) : null, ats ? ats.status : null,
    opportunity.score, opportunity.version, JSON.stringify(opportunity.components),
    opportunity.category,
    JSON.stringify((fit.warnings || []).concat(opportunity.warnings || []))
  ];
  if (hasQueue) params.push(queue.score, JSON.stringify(queue));

  db.prepare(`INSERT INTO ${tables.matches} (${cols}) VALUES (${placeholders})
    ON CONFLICT(job_id) DO UPDATE SET
      fit_score = excluded.fit_score, fit_version = excluded.fit_version,
      fit_components_json = excluded.fit_components_json, fit_weights_json = excluded.fit_weights_json,
      fit_evidence_json = excluded.fit_evidence_json, fit_confidence = excluded.fit_confidence,
      ats_score = excluded.ats_score, ats_version = excluded.ats_version,
      ats_components_json = excluded.ats_components_json, ats_status = excluded.ats_status,
      opportunity_score = excluded.opportunity_score, opportunity_version = excluded.opportunity_version,
      opportunity_components_json = excluded.opportunity_components_json,
      category = excluded.category, warnings_json = excluded.warnings_json${hasQueue ? `,
      queue_priority = excluded.queue_priority, queue_breakdown_json = excluded.queue_breakdown_json` : ''},
      updated_at = CURRENT_TIMESTAMP`).run(...params);
}

/**
 * Executa o pipeline completo para um lote de vagas já normalizadas.
 *
 * @param {object} ctx
 * @param {object} ctx.tables         nomes das tabelas DO PRODUTO (isolamento)
 * @param {function} ctx.upsertJob    grava a vaga e devolve o id
 * @param {object} ctx.profile        perfil mestre resolvido
 * @param {object} ctx.filterConfig   configuração dos hard filters
 * @param {number|null} ctx.atsScore  ATS do currículo selecionado (§18)
 * @param {string} ctx.atsVersion
 * @param {function} [ctx.timelineFor] devolve a classificação de timeline (Seasonal)
 * @param {object} [ctx.thresholds]
 */
function run(rawJobs, ctx) {
  const metrics = {
    received: rawJobs.length,
    stored: 0, newJobs: 0, duplicates: 0,
    filteredOut: 0, prefiltered: 0, analyzed: 0, cached: 0, recommended: 0,
    filterReasons: {}, warnings: [], errors: []
  };

  // --- FASE 1: persistir, deduplicar e aplicar filtros determinísticos ---
  const survivors = [];

  for (const raw of rawJobs) {
    try {
      const hash = contentHash(raw);

      // DEDUPE — sempre dentro do produto, nunca consultando outra tabela.
      const existing = ctx.findExisting(raw);
      if (existing) metrics.duplicates++;

      const jobId = ctx.upsertJob(raw, hash);
      if (!jobId) continue;
      metrics.stored++;
      if (!existing) metrics.newJobs++;

      const job = ctx.loadJob(jobId);

      const hf = applyHardFilters(job, ctx.filterConfig || {});
      if (!hf.passed) {
        metrics.filteredOut++;
        metrics.filterReasons[hf.rule] = (metrics.filterReasons[hf.rule] || 0) + 1;
        ctx.markFiltered && ctx.markFiltered(jobId, hf.reason);
        continue;
      }

      // CACHE por hash + versão da análise (§73)
      const prior = db.prepare(`SELECT content_hash, analysis_version FROM ${ctx.tables.analysis} WHERE job_id = ?`).get(jobId);
      if (prior && prior.content_hash === hash && prior.analysis_version === ANALYSIS_VERSION && !ctx.force) {
        metrics.cached++;
        continue;
      }

      survivors.push({ jobId, job, hash });
    } catch (e) {
      metrics.errors.push({ job: raw.external_id || raw.job_order_id || '?', error: e.message });
    }
  }

  // --- FASE 2: pré-filtro semântico, com proteção contra esvaziamento ---
  //
  // O pré-filtro existe para evitar análise cara em vaga claramente irrelevante
  // (§73). Mas se ele descartaria TUDO, o resultado seria uma tela vazia sem
  // explicação. Nesse caso ele é desligado neste lote e o usuário é avisado de
  // que o perfil parece pertencer a outro domínio.
  const prefilterResults = survivors.map(s => ({ s, pre: semanticPrefilter(s.job, ctx.profile) }));
  const passing = prefilterResults.filter(r => r.pre.passed);
  const bypassPrefilter = survivors.length > 0 && passing.length === 0;

  if (bypassPrefilter) {
    metrics.warnings.push(
      'Nenhuma vaga deste lote tem sobreposição com as habilidades do seu Perfil Mestre. ' +
      'Todas foram analisadas mesmo assim, mas as pontuações devem ficar baixas — ' +
      'verifique se o perfil corresponde ao tipo de vaga que você busca aqui.'
    );
  }

  const toAnalyze = bypassPrefilter ? prefilterResults : passing;
  for (const r of prefilterResults) {
    if (!bypassPrefilter && !r.pre.passed) {
      metrics.prefiltered++;
      metrics.filterReasons.semantic = (metrics.filterReasons.semantic || 0) + 1;
    }
  }

  for (const { s } of toAnalyze) {
    const { jobId, job, hash } = s;
    try {
      // --- SCORES ---
      const fit = scoreEngine.computeFitScore(job, ctx.profile, { thresholds: ctx.thresholds });
      const timeline = ctx.timelineFor ? ctx.timelineFor(job) : null;

      const opportunity = scoreEngine.computeOpportunityScore({
        job, candidate: ctx.profile, fit,
        atsScore: ctx.atsScore, timeline, thresholds: ctx.thresholds
      });

      const concerns = scoreEngine.buildConcerns({
        fit, opportunity, atsAnalysis: ctx.atsAnalysis || null, job, candidate: ctx.profile
      });

      let queue = null;
      if (timeline) {
        const { queuePriorityScore } = require('../core/timeline/hiringTimelineEngine');
        queue = queuePriorityScore({
          timeline,
          opportunityScore: opportunity.score,
          fitScore: fit.score,
          atsScore: ctx.atsScore || 0,
          completeness: job.application_email ? 100 : 0,
          freshness: opportunity.components.freshness || 0
        }, ctx.queueWeights);
      }

      saveAnalysis(ctx.tables, jobId, fit.requirementReport, concerns, hash);
      saveMatch(ctx.tables, jobId, {
        fit,
        ats: ctx.atsScore != null ? { score: ctx.atsScore, version: ctx.atsVersion, components: ctx.atsComponents || {}, status: ctx.atsStatus } : null,
        opportunity,
        queue
      });

      if (ctx.afterScore) ctx.afterScore(jobId, job, { fit, opportunity, timeline, queue, concerns });

      metrics.analyzed++;
      if (opportunity.category === 'TOP_PRIORITY' || opportunity.category === 'STRONG_MATCH') metrics.recommended++;
    } catch (e) {
      metrics.errors.push({ job: job.external_id || job.job_order_id || String(jobId), error: e.message });
    }
  }

  return metrics;
}

module.exports = {
  ANALYSIS_VERSION,
  contentHash,
  applyHardFilters,
  semanticPrefilter,
  saveAnalysis,
  saveMatch,
  run
};
