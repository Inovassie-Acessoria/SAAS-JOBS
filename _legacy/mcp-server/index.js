#!/usr/bin/env node
/**
 * Servidor MCP Oficial - Hub Central de Empregos & Candidaturas
 * Suporte multi-plataforma: Gupy Brasil (Tech/Mkt), Indeed Global (BR & US) e Seasonal Jobs DOL (H-2A/H-2B).
 */

const { db, logEvent, getTodayQuota } = require('../config/database');
const { fetchSeasonalJobsDol } = require('../services/dolService');
const { fetchGupyJobs, generateGupyApplication } = require('../services/gupyService');
const { fetchIndeedJobs, generateIndeedApplication } = require('../services/indeedService');
const { sendSingleApplication, processApprovedQueueBatch, isQueueProcessing } = require('../services/emailService');
const { generateUsResumePdf, generateTechResumePdf } = require('../services/pdfGeneratorService');
const path = require('path');
const fs = require('fs');

const tools = [
  // --- MÓDULO GUPY BRASIL (TECH & MARKETING) ---
  {
    name: 'gupy_search_jobs',
    description: 'Busca vagas ativas de Tecnologia e Marketing na Gupy Brasil.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['tech', 'marketing', ''], description: 'Categoria da vaga' },
        workplaceType: { type: 'string', enum: ['remote', 'hybrid', 'on-site', ''], description: 'Modalidade' },
        keyword: { type: 'string', description: 'Termo de busca (ex: React, Python, Tráfego Pago)' },
        limit: { type: 'number', description: 'Quantidade máxima (padrão: 30)' }
      }
    }
  },
  {
    name: 'gupy_score_job',
    description: 'Calcula e grava a pontuação de compatibilidade (Match Score 0-100%) para uma vaga da Gupy.',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'number', description: 'ID da vaga Gupy' },
        score: { type: 'number', description: 'Score de 0 a 100' },
        reasoning: { type: 'string', description: 'Justificativa do match' }
      },
      required: ['jobId', 'score', 'reasoning']
    }
  },
  {
    name: 'gupy_queue_application',
    description: 'Gera a carta de apresentação e respostas para o formulário da Gupy e insere na fila.',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'number', description: 'ID da vaga Gupy' }
      },
      required: ['jobId']
    }
  },

  // --- MÓDULO INDEED GLOBAL (BR & US TECH/MARKETING) ---
  {
    name: 'indeed_search_jobs',
    description: 'Busca vagas no Indeed Brasil (R$) ou Indeed Estados Unidos ($USD em dólar).',
    parameters: {
      type: 'object',
      properties: {
        country: { type: 'string', enum: ['BR', 'US', ''], description: 'País de busca (BR para Brasil ou US para Estados Unidos)' },
        category: { type: 'string', enum: ['tech', 'marketing', ''], description: 'Categoria' },
        isRemoteOnly: { type: 'boolean', description: 'Apenas vagas 100% remotas' },
        minSalary: { type: 'number', description: 'Salário mínimo' },
        limit: { type: 'number', description: 'Limite de registros' }
      }
    }
  },
  {
    name: 'indeed_score_job',
    description: 'Grava o Match Score de uma vaga do Indeed.',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'number', description: 'ID da vaga Indeed' },
        score: { type: 'number', description: 'Score de 0 a 100' },
        reasoning: { type: 'string', description: 'Justificativa analítica' }
      },
      required: ['jobId', 'score', 'reasoning']
    }
  },
  {
    name: 'indeed_queue_application',
    description: 'Gera a Cover Letter bilingue (PT ou EN) para a vaga do Indeed e enfileira.',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'number', description: 'ID da vaga Indeed' }
      },
      required: ['jobId']
    }
  },

  // --- MÓDULO H-2A & H-2B (DOL VISTOS & MOTORISTA DE CAMINHÃO) ---
  {
    name: 'h2a_list_jobs',
    description: 'Lista ordens de serviço ativas H-2A e H-2B do SeasonalJobs DOL (Caminhoneiros, Tratores, Obras).',
    parameters: {
      type: 'object',
      properties: {
        visaType: { type: 'string', enum: ['H-2A', 'H-2B', ''] },
        state: { type: 'string' },
        category: { type: 'string', enum: ['truck', 'tractor', 'harvest', 'cattle', 'landscape', 'construction', ''] },
        minWage: { type: 'number' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'h2a_score_and_match_job',
    description: 'Calcula e grava o Score de Match para uma vaga H-2A/H-2B.',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'number' },
        score: { type: 'number' },
        reasoning: { type: 'string' },
        keyHighlights: { type: 'string' }
      },
      required: ['jobId', 'score', 'reasoning']
    }
  },

  // --- FILA UNIFICADA & PERFIS ---
  {
    name: 'multi_get_queue',
    description: 'Retorna a fila de candidaturas de todas as plataformas ou filtrada por GUPY, INDEED ou H2A.',
    parameters: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['ALL', 'GUPY', 'INDEED', 'H2A', ''] },
        status: { type: 'string', enum: ['pending_review', 'approved', 'sent', 'failed', ''] }
      }
    }
  },
  {
    name: 'get_candidate_profile_tech',
    description: 'Retorna o perfil completo de Tecnologia e Marketing do candidato.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_candidate_profile_operational',
    description: 'Retorna o perfil de Motorista de Caminhão / H-2A do candidato.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'generate_tech_resume_pdf',
    description: 'Compila o Currículo de Tecnologia & Marketing em PDF (versão em Português ou Inglês americano).',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['pt', 'en'], description: 'Idioma do currículo (pt para Brasil ou en para EUA/Global)' }
      }
    }
  }
];

async function executeTool(name, args) {
  switch (name) {
    case 'gupy_search_jobs': {
      const { category, workplaceType, keyword, limit = 30 } = args || {};
      let query = 'SELECT * FROM gupy_jobs WHERE 1=1';
      const params = [];
      if (category) { query += ' AND category = ?'; params.push(category); }
      if (workplaceType) { query += ' AND workplace_type = ?'; params.push(workplaceType); }
      if (keyword) {
        query += ' AND (job_title LIKE ? OR description LIKE ? OR requirements LIKE ?)';
        const term = `%${keyword}%`;
        params.push(term, term, term);
      }
      query += ' ORDER BY match_score DESC LIMIT ?';
      params.push(limit);
      const jobs = db.prepare(query).all(...params);
      return { success: true, count: jobs.length, jobs };
    }

    case 'gupy_score_job': {
      const { jobId, score, reasoning } = args;
      db.prepare('UPDATE gupy_jobs SET match_score = ?, match_reasoning = ? WHERE id = ?').run(score, reasoning, jobId);
      logEvent('info', 'MCP Agent', `Score Gupy (${score}%) gravado para vaga #${jobId}`);
      return { success: true, jobId, score, message: 'Score Gupy gravado com sucesso!' };
    }

    case 'gupy_queue_application': {
      const { jobId } = args;
      const res = await generateGupyApplication(jobId);
      return res;
    }

    case 'indeed_search_jobs': {
      const { country, category, isRemoteOnly, minSalary = 0, limit = 30 } = args || {};
      let query = 'SELECT * FROM indeed_jobs WHERE 1=1';
      const params = [];
      if (country) { query += ' AND country = ?'; params.push(country.toUpperCase()); }
      if (category) { query += ' AND category = ?'; params.push(category); }
      if (isRemoteOnly) { query += ' AND is_remote = 1'; }
      if (minSalary > 0) { query += ' AND salary_min >= ?'; params.push(minSalary); }
      query += ' ORDER BY match_score DESC LIMIT ?';
      params.push(limit);
      const jobs = db.prepare(query).all(...params);
      return { success: true, count: jobs.length, jobs };
    }

    case 'indeed_score_job': {
      const { jobId, score, reasoning } = args;
      db.prepare('UPDATE indeed_jobs SET match_score = ?, match_reasoning = ? WHERE id = ?').run(score, reasoning, jobId);
      logEvent('info', 'MCP Agent', `Score Indeed (${score}%) gravado para vaga #${jobId}`);
      return { success: true, jobId, score, message: 'Score Indeed gravado com sucesso!' };
    }

    case 'indeed_queue_application': {
      const { jobId } = args;
      const res = await generateIndeedApplication(jobId);
      return res;
    }

    case 'h2a_list_jobs': {
      const { visaType, state, category, minWage = 0, limit = 50 } = args || {};
      let query = 'SELECT * FROM jobs WHERE 1=1';
      const params = [];
      if (visaType) { query += ' AND visa_type = ?'; params.push(visaType.toUpperCase()); }
      if (state) { query += ' AND employer_state = ?'; params.push(state.toUpperCase()); }
      if (minWage > 0) { query += ' AND wage_rate >= ?'; params.push(minWage); }
      query += ' ORDER BY match_score DESC, wage_rate DESC LIMIT ?';
      params.push(limit);
      const jobs = db.prepare(query).all(...params);
      return { success: true, count: jobs.length, jobs };
    }

    case 'h2a_score_and_match_job': {
      const { jobId, score, reasoning, keyHighlights } = args;
      db.prepare('UPDATE jobs SET match_score = ?, match_reasoning = ? WHERE id = ?')
        .run(score, `${reasoning} ${keyHighlights ? ' | Destaques: ' + keyHighlights : ''}`, jobId);
      logEvent('info', 'MCP Agent', `Score H2A (${score}%) gravado para vaga #${jobId}`);
      return { success: true, jobId, score, message: 'Score H2A gravado com sucesso!' };
    }

    case 'multi_get_queue': {
      const { platform, status } = args || {};
      let query = 'SELECT * FROM applications_queue WHERE 1=1';
      const params = [];
      if (platform && platform !== 'ALL') { query += ' AND platform = ?'; params.push(platform.toUpperCase()); }
      if (status) { query += ' AND status = ?'; params.push(status); }
      query += ' ORDER BY id DESC';
      const queue = db.prepare(query).all(...params);
      return { success: true, count: queue.length, queue, isProcessing: isQueueProcessing() };
    }

    case 'get_candidate_profile_tech': {
      const profile = db.prepare('SELECT * FROM candidate_profile_tech ORDER BY id DESC LIMIT 1').get();
      return { success: true, profile };
    }

    case 'get_candidate_profile_operational': {
      const profile = db.prepare('SELECT * FROM candidate_profile ORDER BY id DESC LIMIT 1').get();
      return { success: true, profile };
    }

    case 'generate_tech_resume_pdf': {
      const { language = 'pt' } = args || {};
      const candidate = db.prepare('SELECT * FROM candidate_profile_tech ORDER BY id DESC LIMIT 1').get();
      const filename = `Curriculo_Tech_${language.toUpperCase()}_${Date.now()}.pdf`;
      const outputPath = path.join(__dirname, '..', 'uploads', 'resumes', filename);

      await generateTechResumePdf(candidate, outputPath, language);
      const stats = fs.statSync(outputPath);

      return {
        success: true,
        filename,
        pdfUrl: `/uploads/resumes/${filename}`,
        size: stats.size,
        language: language.toUpperCase(),
        message: `Currículo Tech (${language.toUpperCase()}) gerado com sucesso!`
      };
    }

    default:
      throw new Error(`Ferramenta desconhecida: ${name}`);
  }
}

module.exports = {
  tools,
  executeTool
};

if (require.main === module) {
  console.log('🚀 Servidor MCP Multi-Plataforma pronto. Ferramentas registradas:', tools.map(t => t.name).join(', '));
}
