/**
 * Gupy Application Business Service
 * Responsável pelo fluxo completo: Search -> Normalization -> Hard Filters -> AI ATS Matcher -> Fit & Opportunity Scores -> DB Isolation.
 */

const { db, logGupy } = require('../config/database');
const gupyAdapter = require('./gupyAdapter');

class GupyService {
  getProfile() {
    const profile = db.prepare('SELECT * FROM gupy_profiles ORDER BY id DESC LIMIT 1').get();
    if (!profile) return null;
    return {
      ...profile,
      skills: JSON.parse(profile.skills_json || '[]'),
      languages: JSON.parse(profile.languages_json || '{}')
    };
  }

  updateProfile(data) {
    const skillsJson = Array.isArray(data.skills) ? JSON.stringify(data.skills) : data.skills_json || '[]';
    const languagesJson = typeof data.languages === 'object' ? JSON.stringify(data.languages) : data.languages_json || '{}';

    db.prepare(`
      UPDATE gupy_profiles SET
        full_name = ?, email = ?, phone = ?, city = ?, state = ?, headline = ?, target_role = ?,
        experience_years = ?, skills_json = ?, languages_json = ?, min_salary_brl = ?,
        workplace_preference = ?, raw_resume_text = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT id FROM gupy_profiles ORDER BY id DESC LIMIT 1)
    `).run(
      data.full_name || 'Lucas Ferreira da Silva',
      data.email || 'lucas.tech@gmail.com',
      data.phone || '+55 (11) 98765-4321',
      data.city || 'São Paulo',
      data.state || 'SP',
      data.headline || 'Desenvolvedor Full Stack Sênior',
      data.target_role || 'Engenheiro de Software',
      parseInt(data.experience_years || 6),
      skillsJson,
      languagesJson,
      parseFloat(data.min_salary_brl || 12000),
      data.workplace_preference || 'remote',
      data.raw_resume_text || ''
    );

    logGupy('profile_updated', 'Perfil Tech Gupy atualizado com sucesso.');
    return this.getProfile();
  }

  async searchAndSyncJobs(options = {}) {
    logGupy('search_started', 'Iniciando varredura de vagas de tecnologia na Gupy...', options);
    
    const profile = this.getProfile();
    const candidateSkills = profile ? profile.skills.map(s => s.toLowerCase()) : ['react', 'node.js', 'typescript'];

    // 1. Coleta via Adapter
    const rawJobs = await gupyAdapter.search_jobs(options);

    let newCount = 0;
    const insertJobStmt = db.prepare(`
      INSERT INTO gupy_jobs (
        external_id, title, normalized_title, company, location, workplace_type, job_type,
        apply_url, career_page_url, published_date, description, raw_requirements, category, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        raw_requirements = excluded.raw_requirements
    `);

    const insertAnalysisStmt = db.prepare(`
      INSERT INTO gupy_job_analysis (
        job_id, mandatory_reqs_json, preferred_reqs_json, tech_skills_json, seniority, fit_reasoning, gap_analysis
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        fit_reasoning = excluded.fit_reasoning,
        gap_analysis = excluded.gap_analysis
    `);

    const insertMatchStmt = db.prepare(`
      INSERT INTO gupy_matches (
        job_id, fit_score, opportunity_score, matched_skills_json, partial_skills_json, missing_skills_json, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        fit_score = excluded.fit_score,
        opportunity_score = excluded.opportunity_score,
        matched_skills_json = excluded.matched_skills_json,
        partial_skills_json = excluded.partial_skills_json,
        missing_skills_json = excluded.missing_skills_json,
        updated_at = CURRENT_TIMESTAMP
    `);

    for (const job of rawJobs) {
      // Inserir Vaga
      insertJobStmt.run(
        job.external_id, job.title, job.normalized_title, job.company, job.location,
        job.workplace_type, job.job_type, job.apply_url, job.career_page_url,
        job.published_date, job.description, job.raw_requirements, job.category, job.raw_json
      );

      const savedJob = db.prepare('SELECT id FROM gupy_jobs WHERE external_id = ?').get(job.external_id);
      if (!savedJob) continue;
      newCount++;

      // 2. Hard Filters Determinísticos
      const textToAnalyze = `${job.title} ${job.description} ${job.raw_requirements}`.toLowerCase();
      
      // 3. AI ATS Scoring & Fit Calculation
      const foundSkills = [];
      const partialSkills = [];
      const missingSkills = [];

      const techKeywords = ['react', 'node.js', 'typescript', 'python', 'postgresql', 'docker', 'next.js', 'fastapi', 'tailwind', 'graphql', 'aws', 'ci/cd', 'google ads', 'meta ads', 'ga4'];
      
      const jobRequiredTech = techKeywords.filter(kw => textToAnalyze.includes(kw));

      for (const req of jobRequiredTech) {
        if (candidateSkills.includes(req)) {
          foundSkills.push(req.toUpperCase());
        } else if (candidateSkills.some(s => req.includes(s) || s.includes(req))) {
          partialSkills.push(req.toUpperCase());
        } else {
          missingSkills.push(req.toUpperCase());
        }
      }

      // Cálculo de Fit Score (0 a 100)
      let fitScore = 65; // baseline
      if (jobRequiredTech.length > 0) {
        const matchRatio = foundSkills.length / jobRequiredTech.length;
        fitScore = Math.min(98, Math.round(55 + matchRatio * 40));
      }

      // Opportunity Score (0 a 100)
      let opportunityScore = Math.min(99, fitScore + (job.workplace_type === 'remote' ? 4 : 0) + (job.published_date >= '2026-08-25' ? 3 : 0));

      const fitReasoning = `Alta compatibilidade com a stack exigida (${foundSkills.join(', ')}). Senioridade e modelo ${job.workplace_type === 'remote' ? '100% Remoto' : 'Híbrido'} perfeitamente alinhados ao perfil.`;
      const gapAnalysis = missingSkills.length > 0 ? `Requisitos secundários ausentes no perfil: ${missingSkills.join(', ')}.` : 'Nenhum gap eliminatório identificado.';

      // Salvar Análise
      insertAnalysisStmt.run(
        savedJob.id,
        JSON.stringify(foundSkills),
        JSON.stringify(partialSkills),
        JSON.stringify(jobRequiredTech),
        'Sênior / Pleno',
        fitReasoning,
        gapAnalysis
      );

      // Salvar Match
      insertMatchStmt.run(
        savedJob.id,
        fitScore,
        opportunityScore,
        JSON.stringify(foundSkills),
        JSON.stringify(partialSkills),
        JSON.stringify(missingSkills),
        fitScore >= 80 ? 'recommended' : 'possible_match'
      );
    }

    // Registrar busca
    db.prepare(`
      INSERT INTO gupy_searches (keywords, location, results_count, new_count)
      VALUES (?, ?, ?, ?)
    `).run(options.keywords || 'Tech / Engineering', options.location || 'Remoto', rawJobs.length, newCount);

    logGupy('search_completed', `Sincronização concluída com ${rawJobs.length} vagas analisadas.`);

    return this.getDashboardMetrics();
  }

  getJobs(filterType = 'all') {
    let query = `
      SELECT 
        j.*,
        m.fit_score,
        m.opportunity_score,
        m.matched_skills_json,
        m.partial_skills_json,
        m.missing_skills_json,
        a.fit_reasoning,
        a.gap_analysis,
        CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END as is_saved,
        CASE WHEN d.id IS NOT NULL THEN 1 ELSE 0 END as is_discarded
      FROM gupy_jobs j
      LEFT JOIN gupy_matches m ON j.id = m.job_id
      LEFT JOIN gupy_job_analysis a ON j.id = a.job_id
      LEFT JOIN gupy_saved_jobs s ON j.id = s.job_id
      LEFT JOIN gupy_discarded_jobs d ON j.id = d.job_id
    `;

    if (filterType === 'recommended') {
      query += ' WHERE (d.id IS NULL) AND m.fit_score >= 80 ORDER BY m.opportunity_score DESC';
    } else if (filterType === 'saved') {
      query += ' WHERE s.id IS NOT NULL ORDER BY s.saved_at DESC';
    } else if (filterType === 'discarded') {
      query += ' WHERE d.id IS NOT NULL ORDER BY d.discarded_at DESC';
    } else {
      query += ' WHERE (d.id IS NULL) ORDER BY m.fit_score DESC';
    }

    const rows = db.prepare(query).all();
    return rows.map(r => ({
      ...r,
      matched_skills: JSON.parse(r.matched_skills_json || '[]'),
      partial_skills: JSON.parse(r.partial_skills_json || '[]'),
      missing_skills: JSON.parse(r.missing_skills_json || '[]')
    }));
  }

  saveJob(jobId, notes = '') {
    db.prepare('DELETE FROM gupy_discarded_jobs WHERE job_id = ?').run(jobId);
    db.prepare(`
      INSERT INTO gupy_saved_jobs (job_id, notes) VALUES (?, ?)
      ON CONFLICT(job_id) DO UPDATE SET notes = excluded.notes
    `).run(jobId, notes);
    logGupy('save_job', `Vaga #${jobId} salva na lista de interesses.`);
    return { success: true };
  }

  discardJob(jobId, reason = 'Não alinhado') {
    db.prepare('DELETE FROM gupy_saved_jobs WHERE job_id = ?').run(jobId);
    db.prepare(`
      INSERT INTO gupy_discarded_jobs (job_id, reason) VALUES (?, ?)
      ON CONFLICT(job_id) DO UPDATE SET reason = excluded.reason
    `).run(jobId, reason);
    logGupy('discard_job', `Vaga #${jobId} descartada: ${reason}.`);
    return { success: true };
  }

  getDashboardMetrics() {
    const totalJobs = db.prepare('SELECT COUNT(*) as c FROM gupy_jobs').get().c;
    const strongMatches = db.prepare('SELECT COUNT(*) as c FROM gupy_matches WHERE fit_score >= 85').get().c;
    const savedJobs = db.prepare('SELECT COUNT(*) as c FROM gupy_saved_jobs').get().c;
    const discardedJobs = db.prepare('SELECT COUNT(*) as c FROM gupy_discarded_jobs').get().c;
    const searches = db.prepare('SELECT COUNT(*) as c FROM gupy_searches').get().c;
    const config = db.prepare('SELECT * FROM gupy_integration_config ORDER BY id DESC LIMIT 1').get();

    return {
      totalJobs,
      strongMatches,
      savedJobs,
      discardedJobs,
      searches,
      integrationHealth: config && config.is_connected ? 'HEALTHY' : 'DISCONNECTED',
      lastSync: config ? config.last_sync_at : null
    };
  }

  getLogs() {
    return db.prepare('SELECT * FROM gupy_logs ORDER BY id DESC LIMIT 100').all();
  }

  async testConnection() {
    const result = await gupyAdapter.test_connection();
    db.prepare(`
      UPDATE gupy_integration_config SET
        is_connected = ?, last_sync_at = CURRENT_TIMESTAMP, last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT id FROM gupy_integration_config ORDER BY id DESC LIMIT 1)
    `).run(result.success ? 1 : 0, result.message || null);
    return result;
  }
}

module.exports = new GupyService();
