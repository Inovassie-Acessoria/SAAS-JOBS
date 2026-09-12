/**
 * Seasonal Jobs Application Business Service (H-2A & H-2B EUA)
 * Foco especializado em Motorista de Caminhão Pesado (CDL) e Operadores Agrícolas.
 * Gerenciamento do Perfil de Motorista, Documentos Autênticos, Portfólio Online com 3 Fotos e Varredura DOL.
 */

const { db, logSeasonal } = require('../config/database');
const seasonalJobsAdapter = require('./seasonalJobsAdapter');

class SeasonalJobsService {
  getProfile() {
    const profile = db.prepare('SELECT * FROM seasonal_profiles ORDER BY id DESC LIMIT 1').get();
    return profile;
  }

  updateProfile(data) {
    db.prepare(`
      UPDATE seasonal_profiles SET
        full_name = ?, email = ?, phone = ?, whatsapp = ?, city = ?, state = ?, country = ?,
        headline = ?, experience_years = ?, bio = ?, cdl_license_type = ?, driving_years = ?,
        equipment_skills = ?, english_level = ?, passport_valid = ?, h2a_preference = ?,
        h2b_preference = ?, preferred_states = ?, min_hourly_wage = ?, available_from = ?,
        available_to = ?, physical_labor_ready = ?, raw_resume_text = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT id FROM seasonal_profiles ORDER BY id DESC LIMIT 1)
    `).run(
      data.full_name || 'Carlos Henrique Santana',
      data.email || 'carlos.h2a.driver@gmail.com',
      data.phone || '+1 (786) 500-1234',
      data.whatsapp || '+55 (16) 99876-5432',
      data.city || 'Ribeirão Preto',
      data.state || 'SP',
      data.country || 'Brazil',
      data.headline || 'Professional Heavy Truck Driver & Agricultural Machinery Specialist',
      parseInt(data.experience_years || 7),
      data.bio || '',
      data.cdl_license_type || 'Class A Equivalent',
      parseInt(data.driving_years || 7),
      data.equipment_skills || '',
      data.english_level || 'Intermediate',
      data.passport_valid ? 1 : 0,
      data.h2a_preference ? 1 : 0,
      data.h2b_preference ? 1 : 0,
      data.preferred_states || 'TX, IA, NE, KS',
      parseFloat(data.min_hourly_wage || 17.50),
      data.available_from || '2026-09-01',
      data.available_to || '2027-06-30',
      data.physical_labor_ready ? 1 : 0,
      data.raw_resume_text || ''
    );

    logSeasonal('profile_updated', 'Perfil de Motorista/Agro H-2A atualizado com sucesso.');
    return this.getProfile();
  }

  // --- GESTÃO DO PORTFÓLIO ONLINE PÚBLICO (/portfolio) ---
  getPortfolio() {
    let portfolio = db.prepare('SELECT * FROM seasonal_portfolio ORDER BY id DESC LIMIT 1').get();
    return portfolio;
  }

  updatePortfolio(data) {
    db.prepare(`
      UPDATE seasonal_portfolio SET
        full_name = ?, headline = ?, tagline = ?, bio_english = ?, years_driving = ?,
        years_farming = ?, cdl_info = ?, equipment_list = ?, photo_profile_url = ?,
        photo_truck_url = ?, photo_farm_url = ?, why_hire_me = ?, phone = ?,
        whatsapp = ?, email = ?, public_slug = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = (SELECT id FROM seasonal_portfolio ORDER BY id DESC LIMIT 1)
    `).run(
      data.full_name || 'Carlos Henrique Santana',
      data.headline || 'Certified Heavy Truck Driver & Agricultural Equipment Specialist',
      data.tagline || 'H-2A & H-2B Visa Ready | Clean Driving Record | 7+ Years Experience',
      data.bio_english || '',
      parseInt(data.years_driving || 7),
      parseInt(data.years_farming || 5),
      data.cdl_info || 'Valid Class A Equivalent License',
      data.equipment_list || 'Heavy Semitrailers, John Deere 8R/7R, Combines',
      data.photo_profile_url || '/uploads/portfolio/photo_profile.jpg',
      data.photo_truck_url || '/uploads/portfolio/photo_truck.jpg',
      data.photo_farm_url || '/uploads/portfolio/photo_farm.jpg',
      data.why_hire_me || 'Safety-first, 60+ weekly hours stamina, clean record.',
      data.phone || '+1 (786) 500-1234',
      data.whatsapp || '+55 (16) 99876-5432',
      data.email || 'carlos.h2a.driver@gmail.com',
      data.public_slug || 'carlos-driver'
    );

    logSeasonal('portfolio_updated', 'Portfólio online de motorista atualizado com sucesso.');
    return this.getPortfolio();
  }

  // --- GESTÃO DE DOCUMENTOS AUTÊNTICOS ---
  getDocuments() {
    return db.prepare('SELECT * FROM seasonal_documents WHERE is_active = 1 ORDER BY id DESC').all();
  }

  addDocument(doc) {
    db.prepare(`
      INSERT INTO seasonal_documents (doc_type, title, filename, original_name, file_path, file_size, is_default, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      doc.doc_type || 'resume',
      doc.title,
      doc.filename,
      doc.original_name,
      doc.file_path,
      doc.file_size || 0,
      doc.is_default ? 1 : 0,
      doc.category || 'truck_driver'
    );
    logSeasonal('document_uploaded', `Documento '${doc.title}' (${doc.doc_type}) cadastrado no sistema.`);
    return this.getDocuments();
  }

  deleteDocument(docId) {
    db.prepare('UPDATE seasonal_documents SET is_active = 0 WHERE id = ?').run(docId);
    logSeasonal('document_deleted', `Documento #${docId} desativado.`);
    return { success: true };
  }

  // --- VARREDURA & MATCHING DOL ---
  async fetchAndSyncJobs(options = {}) {
    logSeasonal('sync_started', 'Disparando varredura DOL SeasonalJobs ao vivo...', options);

    const profile = this.getProfile();
    const isDriver = profile && profile.driving_years > 0;

    const rawJobs = await seasonalJobsAdapter.fetch_jobs(options);

    let newCount = 0;
    const insertJobStmt = db.prepare(`
      INSERT INTO seasonal_jobs (
        job_order_id, visa_type, job_title, normalized_title, soc_code, employer_name,
        employer_city, employer_state, employer_phone, employer_email, attorney_name,
        attorney_email, wage_rate, wage_unit, start_date, end_date, openings,
        housing_provided, duties_description, special_requirements, is_truck_driver_role,
        application_method, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_order_id) DO UPDATE SET
        wage_rate = excluded.wage_rate,
        openings = excluded.openings,
        duties_description = excluded.duties_description,
        special_requirements = excluded.special_requirements,
        application_method = excluded.application_method
    `);

    const insertAnalysisStmt = db.prepare(`
      INSERT INTO seasonal_job_analysis (
        job_id, key_tasks_json, physical_requirements_json, license_required, housing_notes, why_recommended, potential_gaps
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        why_recommended = excluded.why_recommended,
        potential_gaps = excluded.potential_gaps
    `);

    const insertMatchStmt = db.prepare(`
      INSERT INTO seasonal_matches (
        job_id, fit_score, opportunity_score, matched_qualifications_json, missing_qualifications_json, status
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        fit_score = excluded.fit_score,
        opportunity_score = excluded.opportunity_score,
        matched_qualifications_json = excluded.matched_qualifications_json,
        missing_qualifications_json = excluded.missing_qualifications_json,
        updated_at = CURRENT_TIMESTAMP
    `);

    for (const job of rawJobs) {
      insertJobStmt.run(
        job.job_order_id, job.visa_type, job.job_title, job.normalized_title, job.soc_code,
        job.employer_name, job.employer_city, job.employer_state, job.employer_phone,
        job.employer_email, job.attorney_name, job.attorney_email, job.wage_rate, job.wage_unit,
        job.start_date, job.end_date, job.openings, job.housing_provided, job.duties_description,
        job.special_requirements, job.is_truck_driver_role, job.application_method, job.raw_json
      );

      const savedJob = db.prepare('SELECT id FROM seasonal_jobs WHERE job_order_id = ?').get(job.job_order_id);
      if (!savedJob) continue;
      newCount++;

      // Cálculo de Fit & Opportunity para H-2A/H-2B
      const matchedQuals = [];
      const missingQuals = [];

      if (job.is_truck_driver_role && isDriver) {
        matchedQuals.push('Experiência comprovada em Caminhão Pesado / Carreta Bitrem');
        matchedQuals.push('CNH / CDL Class A Equivalent ativa');
      }

      if (profile && profile.passport_valid) {
        matchedQuals.push('Passaporte Válido para Visto H-2A/H-2B');
      }

      if (job.housing_provided) {
        matchedQuals.push('Alojamento Gratuito Garantido por Lei');
      }

      let fitScore = 75;
      if (job.is_truck_driver_role && isDriver) {
        fitScore = 95;
      } else if (job.visa_type === 'H-2A') {
        fitScore = 88;
      }

      let opportunityScore = Math.min(99, fitScore + (job.wage_rate >= 18 ? 4 : 0) + (job.application_method === 'EMAIL' ? 5 : 0));

      const whyRec = job.is_truck_driver_role 
        ? `Excelente oportunidade para Motorista de Caminhão Pesado na safra de ${job.employer_state}. Salário de $${job.wage_rate}/hora com moradia inclusa.`
        : `Vaga de Operador Agrícola em fazenda de ${job.employer_state}. Alojamento garantido e conformidade legal total.`;

      const gaps = job.wage_rate < (profile ? profile.min_hourly_wage : 15) ? 'Salário ligeiramente inferior à pretensão ideal.' : 'Nenhum gap eliminatório identificado.';

      insertAnalysisStmt.run(
        savedJob.id,
        JSON.stringify(['Operação de Veículo/Maquinário', 'Inspeção de Segurança', 'Manutenção Preventiva']),
        JSON.stringify(['Capacidade física 50+ lbs', 'Trabalho em condições climáticas externas']),
        1,
        job.housing_provided ? 'Alojamento fornecido pelo empregador sem custos' : 'Moradia não inclusa',
        whyRec,
        gaps
      );

      insertMatchStmt.run(
        savedJob.id,
        fitScore,
        opportunityScore,
        JSON.stringify(matchedQuals),
        JSON.stringify(missingQuals),
        fitScore >= 80 ? 'recommended' : 'possible_match'
      );
    }

    logSeasonal('sync_completed', `Varredura DOL concluída com ${rawJobs.length} vagas sincronizadas e pontuadas.`);
    return this.getDashboardMetrics();
  }

  getJobs(filterType = 'all', options = {}) {
    let query = `
      SELECT 
        j.*,
        m.fit_score,
        m.opportunity_score,
        m.matched_qualifications_json,
        m.missing_qualifications_json,
        a.why_recommended,
        a.potential_gaps,
        CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END as is_saved,
        CASE WHEN d.id IS NOT NULL THEN 1 ELSE 0 END as is_discarded,
        CASE WHEN app.id IS NOT NULL THEN 1 ELSE 0 END as is_applied
      FROM seasonal_jobs j
      LEFT JOIN seasonal_matches m ON j.id = m.job_id
      LEFT JOIN seasonal_job_analysis a ON j.id = a.job_id
      LEFT JOIN seasonal_saved_jobs s ON j.id = s.job_id
      LEFT JOIN seasonal_discarded_jobs d ON j.id = d.job_id
      LEFT JOIN seasonal_applications app ON j.id = app.seasonal_job_id
    `;

    const whereClauses = [];

    if (filterType === 'recommended') {
      whereClauses.push('(d.id IS NULL) AND m.fit_score >= 80');
    } else if (filterType === 'saved') {
      whereClauses.push('s.id IS NOT NULL');
    } else if (filterType === 'discarded') {
      whereClauses.push('d.id IS NOT NULL');
    } else if (filterType === 'truck_drivers') {
      whereClauses.push('(d.id IS NULL) AND j.is_truck_driver_role = 1');
    } else {
      whereClauses.push('(d.id IS NULL)');
    }

    if (options.truckDriverOnly) {
      whereClauses.push('j.is_truck_driver_role = 1');
    }

    if (options.visaType && options.visaType !== 'all') {
      whereClauses.push(`j.visa_type = '${options.visaType}'`);
    }

    if (whereClauses.length > 0) {
      query += ' WHERE ' + whereClauses.join(' AND ');
    }

    query += ' ORDER BY j.is_truck_driver_role DESC, m.opportunity_score DESC';

    const rows = db.prepare(query).all();
    return rows.map(r => ({
      ...r,
      matched_qualifications: JSON.parse(r.matched_qualifications_json || '[]'),
      missing_qualifications: JSON.parse(r.missing_qualifications_json || '[]')
    }));
  }

  saveJob(jobId, notes = '') {
    db.prepare('DELETE FROM seasonal_discarded_jobs WHERE job_id = ?').run(jobId);
    db.prepare(`
      INSERT INTO seasonal_saved_jobs (job_id, notes) VALUES (?, ?)
      ON CONFLICT(job_id) DO UPDATE SET notes = excluded.notes
    `).run(jobId, notes);
    logSeasonal('save_job', `Vaga DOL #${jobId} salva nos favoritos.`);
    return { success: true };
  }

  discardJob(jobId, reason = 'Não alinhado') {
    db.prepare('DELETE FROM seasonal_saved_jobs WHERE job_id = ?').run(jobId);
    db.prepare(`
      INSERT INTO seasonal_discarded_jobs (job_id, reason) VALUES (?, ?)
      ON CONFLICT(job_id) DO UPDATE SET reason = excluded.reason
    `).run(jobId, reason);
    logSeasonal('discard_job', `Vaga DOL #${jobId} descartada: ${reason}.`);
    return { success: true };
  }

  getDashboardMetrics() {
    const totalJobs = db.prepare('SELECT COUNT(*) as c FROM seasonal_jobs').get().c;
    const truckJobs = db.prepare('SELECT COUNT(*) as c FROM seasonal_jobs WHERE is_truck_driver_role = 1').get().c;
    const strongMatches = db.prepare('SELECT COUNT(*) as c FROM seasonal_matches WHERE fit_score >= 85').get().c;
    const emailQualified = db.prepare("SELECT COUNT(*) as c FROM seasonal_jobs WHERE application_method = 'EMAIL'").get().c;
    const savedJobs = db.prepare('SELECT COUNT(*) as c FROM seasonal_saved_jobs').get().c;
    const config = db.prepare('SELECT * FROM seasonal_integration_config ORDER BY id DESC LIMIT 1').get();
    
    // Quota de e-mails de hoje
    const today = new Date().toISOString().split('T')[0];
    let quota = db.prepare('SELECT * FROM seasonal_daily_quota WHERE date_str = ?').get(today);
    if (!quota) {
      db.prepare('INSERT OR IGNORE INTO seasonal_daily_quota (date_str, count_sent, max_limit) VALUES (?, 0, 50)').run(today);
      quota = { count_sent: 0, max_limit: 50 };
    }

    const queuedCount = db.prepare("SELECT COUNT(*) as c FROM seasonal_email_queue WHERE status = 'QUEUED'").get().c;
    const sentCount = db.prepare("SELECT COUNT(*) as c FROM seasonal_applications").get().c;

    return {
      totalJobs,
      truckJobs,
      strongMatches,
      emailQualified,
      savedJobs,
      emailsSentToday: quota.count_sent,
      dailyEmailLimit: quota.max_limit,
      emailsRemainingToday: Math.max(0, quota.max_limit - quota.count_sent),
      queuedApplications: queuedCount,
      totalSentLifetime: sentCount,
      pauseEmailSending: Boolean(config ? config.pause_email_sending : 0),
      lastSync: config ? config.last_sync_at : null
    };
  }

  getLogs() {
    return db.prepare('SELECT * FROM seasonal_logs ORDER BY id DESC LIMIT 100').all();
  }
}

module.exports = new SeasonalJobsService();
