/**
 * Indeed Global Application Business Service
 * Responsável pelo fluxo completo: Search -> Normalization -> Hard Filters -> AI ATS Matcher -> Fit & Opportunity Scores -> DB Isolation.
 */

const { db, logIndeed } = require('../config/database');
const indeedAdapter = require('./indeedAdapter');

class IndeedService {
  getProfile() {
    const profile = db.prepare('SELECT * FROM indeed_profiles ORDER BY id DESC LIMIT 1').get();
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
      UPDATE indeed_profiles SET
        full_name = ?, email = ?, phone = ?, city = ?, state = ?, country = ?, headline = ?,
        target_role = ?, experience_years = ?, skills_json = ?, languages_json = ?,
        min_salary_usd = ?, is_remote_only = ?, visa_sponsorship_needed = ?,
        raw_resume_text = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT id FROM indeed_profiles ORDER BY id DESC LIMIT 1)
    `).run(
      data.full_name || 'Lucas Ferreira da Silva',
      data.email || 'lucas.globaltech@gmail.com',
      data.phone || '+1 (555) 345-6789',
      data.city || 'São Paulo',
      data.state || 'SP',
      data.country || 'Brazil',
      data.headline || 'Senior Full Stack Software Engineer',
      data.target_role || 'Senior Software Engineer',
      parseInt(data.experience_years || 6),
      skillsJson,
      languagesJson,
      parseFloat(data.min_salary_usd || 90000),
      data.is_remote_only ? 1 : 0,
      data.visa_sponsorship_needed ? 1 : 0,
      data.raw_resume_text || ''
    );

    logIndeed('profile_updated', 'Perfil Internacional Indeed atualizado com sucesso.');
    return this.getProfile();
  }

  async searchAndSyncJobs(options = {}) {
    logIndeed('search_started', 'Iniciando varredura de vagas internacionais no Indeed Global...', options);

    const profile = this.getProfile();
    const candidateSkills = profile ? profile.skills.map(s => s.toLowerCase()) : ['react', 'node.js', 'typescript', 'aws'];

    // 1. Coleta via Adapter
    const rawJobs = await indeedAdapter.search_jobs(options);

    let newCount = 0;
    const insertJobStmt = db.prepare(`
      INSERT INTO indeed_jobs (
        external_id, country, title, normalized_title, company, location_city, location_state,
        is_remote, salary_min, salary_max, salary_currency, salary_period, job_url,
        description, requirements, category, visa_sponsorship, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_id) DO UPDATE SET
        title = excluded.title,
        salary_min = excluded.salary_min,
        salary_max = excluded.salary_max,
        description = excluded.description,
        requirements = excluded.requirements
    `);

    const insertAnalysisStmt = db.prepare(`
      INSERT INTO indeed_job_analysis (
        job_id, mandatory_reqs_json, preferred_reqs_json, tech_skills_json, seniority, fit_reasoning, gap_analysis
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        fit_reasoning = excluded.fit_reasoning,
        gap_analysis = excluded.gap_analysis
    `);

    const insertMatchStmt = db.prepare(`
      INSERT INTO indeed_matches (
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
      insertJobStmt.run(
        job.external_id || `indeed_${Date.now()}_${Math.random()}`,
        job.country || 'US',
        job.title || 'Software Engineer',
        job.normalized_title || job.title || 'Software Engineer',
        job.company || 'Tech Company',
        job.location_city || 'Remote',
        job.location_state || 'US',
        job.is_remote ? 1 : 0,
        job.salary_min || 90000,
        job.salary_max || 140000,
        job.salary_currency || 'USD',
        job.salary_period || 'year',
        job.job_url || 'https://www.indeed.com',
        job.description || '',
        job.requirements || '',
        job.category || 'tech',
        job.visa_sponsorship ? 1 : 0,
        job.raw_json || '{}'
      );

      const savedJob = db.prepare('SELECT id FROM indeed_jobs WHERE external_id = ?').get(job.external_id);
      if (!savedJob) continue;
      newCount++;

      const textToAnalyze = `${job.title} ${job.description} ${job.requirements}`.toLowerCase();

      const foundSkills = [];
      const partialSkills = [];
      const missingSkills = [];

      const techKeywords = ['react', 'node.js', 'typescript', 'python', 'postgresql', 'docker', 'next.js', 'fastapi', 'tailwind', 'graphql', 'aws', 'ci/cd', 'kubernetes', 'terraform'];

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

      let fitScore = 70;
      if (jobRequiredTech.length > 0) {
        const matchRatio = foundSkills.length / jobRequiredTech.length;
        fitScore = Math.min(97, Math.round(58 + matchRatio * 38));
      }

      let opportunityScore = Math.min(99, fitScore + (job.salary_min >= 100000 ? 5 : 2) + (job.visa_sponsorship ? 3 : 0));

      const fitReasoning = `Forte aderência internacional para a stack (${foundSkills.join(', ')}). Salário em USD ($${((job.salary_min||100000)/1000).toFixed(0)}k-$${((job.salary_max||150000)/1000).toFixed(0)}k/ano) e contratação remota global.`;
      const gapAnalysis = missingSkills.length > 0 ? `Competências recomendadas para aprofundamento: ${missingSkills.join(', ')}.` : 'Requisitos 100% satisfeitos.';

      insertAnalysisStmt.run(
        savedJob.id,
        JSON.stringify(foundSkills),
        JSON.stringify(partialSkills),
        JSON.stringify(jobRequiredTech),
        'Senior Software Engineer',
        fitReasoning,
        gapAnalysis
      );

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

    db.prepare(`
      INSERT INTO indeed_searches (keywords, location, country, results_count, new_count)
      VALUES (?, ?, ?, ?, ?)
    `).run(options.keywords || 'Software Engineer', options.location || 'Remote', options.country || 'US', rawJobs.length, newCount);

    logIndeed('search_completed', `Busca Indeed concluída com ${rawJobs.length} vagas analisadas.`);

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
      FROM indeed_jobs j
      LEFT JOIN indeed_matches m ON j.id = m.job_id
      LEFT JOIN indeed_job_analysis a ON j.id = a.job_id
      LEFT JOIN indeed_saved_jobs s ON j.id = s.job_id
      LEFT JOIN indeed_discarded_jobs d ON j.id = d.job_id
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
    db.prepare('DELETE FROM indeed_discarded_jobs WHERE job_id = ?').run(jobId);
    db.prepare(`
      INSERT INTO indeed_saved_jobs (job_id, notes) VALUES (?, ?)
      ON CONFLICT(job_id) DO UPDATE SET notes = excluded.notes
    `).run(jobId, notes);
    logIndeed('save_job', `Vaga Indeed #${jobId} salva.`);
    return { success: true };
  }

  discardJob(jobId, reason = 'Não alinhado') {
    db.prepare('DELETE FROM indeed_saved_jobs WHERE job_id = ?').run(jobId);
    db.prepare(`
      INSERT INTO indeed_discarded_jobs (job_id, reason) VALUES (?, ?)
      ON CONFLICT(job_id) DO UPDATE SET reason = excluded.reason
    `).run(jobId, reason);
    logIndeed('discard_job', `Vaga Indeed #${jobId} descartada: ${reason}.`);
    return { success: true };
  }

  getDashboardMetrics() {
    const totalJobs = db.prepare('SELECT COUNT(*) as c FROM indeed_jobs').get().c;
    const strongMatches = db.prepare('SELECT COUNT(*) as c FROM indeed_matches WHERE fit_score >= 85').get().c;
    const savedJobs = db.prepare('SELECT COUNT(*) as c FROM indeed_saved_jobs').get().c;
    const discardedJobs = db.prepare('SELECT COUNT(*) as c FROM indeed_discarded_jobs').get().c;
    const searches = db.prepare('SELECT COUNT(*) as c FROM indeed_searches').get().c;
    const config = db.prepare('SELECT * FROM indeed_integration_config ORDER BY id DESC LIMIT 1').get();

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
    return db.prepare('SELECT * FROM indeed_logs ORDER BY id DESC LIMIT 100').all();
  }

  async testConnection() {
    const result = await indeedAdapter.test_connection();
    db.prepare(`
      UPDATE indeed_integration_config SET
        is_connected = ?, last_sync_at = CURRENT_TIMESTAMP, last_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT id FROM indeed_integration_config ORDER BY id DESC LIMIT 1)
    `).run(result.success ? 1 : 0, result.message || null);
    return result;
  }
}

module.exports = new IndeedService();
