/**
 * Perfil e currículos POR PLATAFORMA E PAÍS (spec de infraestrutura §1A–§1K).
 *
 * Invariante inegociável (§1K):
 *
 *   > Toda plataforma é dona do próprio perfil, currículos, preferências,
 *   > contexto de ATS e histórico. Nenhuma plataforma consome automaticamente
 *   > dados de candidato de outra.
 *
 * Não existe Perfil Mestre. Não existe Biblioteca compartilhada. Não existe
 * fallback para o currículo de outro ambiente: se o ambiente atual não tem
 * currículo, a resposta é "nenhum currículo configurado para este ambiente" (§1E).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, logCore, uploadsRoot } = require('../config/database');
const { extractText } = require('../core/documents/textExtract');

const PLATFORMS = ['gupy', 'indeed', 'seasonal'];

const LIST_FIELDS = {
  skills: 'skills_json',
  tools: 'tools_json',
  languages: 'languages_json',
  certifications: 'certifications_json',
  industries: 'industries_json',
  education: 'education_json'
};

const ALLOWED_MIME = {
  '.pdf':  'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc':  'application/msword',
  '.txt':  'text/plain'
};

class EnvironmentError extends Error {
  constructor(message, status = 400) { super(message); this.userFacing = true; this.status = status; }
}

/** Normaliza e valida o par plataforma+país. Seasonal é sempre US (§4.3). */
function resolveEnv(platform, country) {
  const p = String(platform || '').toLowerCase();
  if (!PLATFORMS.includes(p)) {
    throw new EnvironmentError(`Plataforma inválida: "${platform}". Use gupy, indeed ou seasonal.`, 404);
  }
  if (p === 'seasonal') return { platform: p, country: 'US' };

  const c = String(country || '').toUpperCase();
  if (c !== 'BR' && c !== 'US') {
    throw new EnvironmentError(`País inválido para ${p}: "${country}". Use BR ou US.`, 404);
  }
  return { platform: p, country: c };
}

/** Chave de armazenamento com dono explícito (spec §1H). */
function storageKey({ platform, country }, documentId, ext, userId = 1) {
  return `users/${userId}/${platform}/${country.toLowerCase()}/resumes/${documentId}${ext}`;
}

function safeParse(s, fallback) { try { return JSON.parse(s || ''); } catch (e) { return fallback; } }

// ---------------------------------------------------------------------------

/**
 * Devolve o repositório de candidato do ambiente pedido. Todas as consultas
 * carregam o filtro de país — não há caminho que leia outro ambiente.
 */
function environment(platform, country, userId) {
  const env = resolveEnv(platform, country);

  // Autorização é por usuário + produto + país (spec de autenticação §23).
  // Sem usuário resolvido não há consulta: a isolação é do backend, não da rota.
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) {
    throw new EnvironmentError('Usuário não identificado para este ambiente.', 401);
  }
  const T = {
    profiles: `${env.platform}_profiles`,
    resumes: `${env.platform}_resumes`,
    analysis: `${env.platform}_resume_analysis`
  };
  const label = `${env.platform}/${env.country}`;

  /**
   * Tipo de visto é conceito exclusivo do Seasonal Jobs (H-2A × H-2B).
   * Gupy e Indeed não têm visto, e suas tabelas não têm a coluna — esta fábrica
   * serve aos três, então a diferença precisa ser explícita aqui.
   */
  const HAS_VISA_TYPE = env.platform === 'seasonal';
  const scope = { userId: uid, platform: env.platform, country: env.country };

  // ------------------------------------------------------------------ perfil

  function getProfileRow() {
    let row = db.prepare(`SELECT * FROM ${T.profiles} WHERE user_id = ? AND country = ?`).get(uid, env.country);
    if (!row) {
      db.prepare(`INSERT INTO ${T.profiles} (user_id, country) VALUES (?,?)`).run(uid, env.country);
      row = db.prepare(`SELECT * FROM ${T.profiles} WHERE user_id = ? AND country = ?`).get(uid, env.country);
    }
    return row;
  }

  /** Perfil no formato que os motores de score consomem. */
  function getProfile() {
    const row = getProfileRow();
    const lists = {};
    for (const [key, col] of Object.entries(LIST_FIELDS)) lists[key] = safeParse(row[col], []);

    const filled = Boolean(row.full_name || row.email || lists.skills.length);

    return {
      platform: env.platform,
      country: env.country,
      environment: label,
      id: row.id,
      fullName: row.full_name,
      email: row.email,
      phone: row.phone,
      city: row.city,
      state: row.state,
      headline: row.headline,
      summary: row.summary,
      yearsOfExperience: row.years_of_experience,
      availabilityFrom: row.availability_from,
      availabilityTo: row.availability_to,
      workplacePreference: row.workplace_preference,
      workAuthorization: row.work_authorization,
      driversLicense: row.drivers_license,

      skills: lists.skills,
      tools: lists.tools,
      languages: lists.languages,
      certifications: lists.certifications,
      industries: lists.industries,
      education: lists.education,

      // Consultados pelos "hard gates" do classificador de requisitos.
      attributes: {
        drivers_license: row.drivers_license || undefined,
        work_authorization: row.work_authorization || undefined
      },

      isEmpty: !filled
    };
  }

  function updateProfile(data) {
    const row = getProfileRow();
    const v = (k, d = null) => (data[k] !== undefined ? data[k] : (row[k] !== undefined ? row[k] : d));
    const list = (key) => {
      if (data[key] === undefined) return row[LIST_FIELDS[key]] || '[]';
      const arr = Array.isArray(data[key])
        ? data[key]
        : String(data[key]).split(',').map(s => s.trim()).filter(Boolean);
      return JSON.stringify(arr);
    };

    db.prepare(`UPDATE ${T.profiles} SET
        full_name = ?, email = ?, phone = ?, city = ?, state = ?,
        headline = ?, summary = ?, years_of_experience = ?,
        availability_from = ?, availability_to = ?, workplace_preference = ?,
        work_authorization = ?, drivers_license = ?,
        skills_json = ?, tools_json = ?, languages_json = ?,
        certifications_json = ?, industries_json = ?, education_json = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND country = ?`).run(
      String(v('full_name', '')), String(v('email', '')), String(v('phone', '')),
      String(v('city', '')), String(v('state', '')),
      String(v('headline', '')), String(v('summary', '')),
      data.years_of_experience === '' || data.years_of_experience == null
        ? row.years_of_experience : Number(data.years_of_experience),
      v('availability_from'), v('availability_to'),
      String(v('workplace_preference', 'remote')),
      v('work_authorization'), v('drivers_license'),
      list('skills'), list('tools'), list('languages'),
      list('certifications'), list('industries'), list('education'),
      uid, env.country
    );

    logCore('candidate', 'profile_updated', `Perfil de ${label} atualizado.`, { environment: label });
    return getProfile();
  }

  // -------------------------------------------------------------- currículos

  function listResumes({ careerTrack = null, docType = null, includeArchived = false } = {}) {
    const where = ['user_id = ?', 'country = ?'];
    const params = [uid, env.country];
    if (!includeArchived) where.push('archived = 0');
    if (careerTrack) { where.push('career_track = ?'); params.push(careerTrack); }
    if (docType) { where.push('doc_type = ?'); params.push(docType); }

    // `visa_type` existe APENAS em seasonal_resumes: tipo de visto é conceito do
    // Seasonal Jobs, não da Gupy nem do Indeed. Esta fábrica é compartilhada
    // pelos três produtos, então a coluna entra no SELECT só onde existe —
    // pedi-la em todos quebra a listagem dos outros dois com "no such column".
    //
    // Sem ela no SELECT, `recommendResume` leria undefined, trataria todo
    // documento como ANY, e a separação H-2A / H-2B não filtraria nada.
    const visaCol = HAS_VISA_TYPE ? 'visa_type,' : `'ANY' AS visa_type,`;

    return db.prepare(`SELECT id, country, name, career_track, doc_type, ${visaCol} filename, original_name,
                              storage_key, mime_type, file_size, sha256, extraction_confidence,
                              ats_health, is_default, is_active, archived, created_at, updated_at,
                              LENGTH(COALESCE(extracted_text,'')) AS text_length
                       FROM ${T.resumes}
                       WHERE ${where.join(' AND ')}
                       ORDER BY is_default DESC, updated_at DESC`).all(...params);
  }

  /** Busca sempre com o filtro de país: um id de outro ambiente devolve null. */
  function getResume(id) {
    return db.prepare(`SELECT * FROM ${T.resumes} WHERE id = ? AND user_id = ? AND country = ?`)
      .get(Number(id), uid, env.country) || null;
  }

  function validateUpload(file) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_MIME[ext]) {
      throw new EnvironmentError(`Formato não aceito: ${ext || 'sem extensão'}. Envie PDF, DOCX ou TXT.`);
    }
    if (!fs.existsSync(file.path)) throw new EnvironmentError('Arquivo enviado não foi encontrado no servidor.');

    const head = Buffer.alloc(8);
    const fd = fs.openSync(file.path, 'r');
    fs.readSync(fd, head, 0, 8, 0);
    fs.closeSync(fd);

    if (ext === '.pdf' && head.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new EnvironmentError('O arquivo tem extensão .pdf mas o conteúdo não é um PDF válido.');
    }
    if (ext === '.docx' && head.readUInt32LE(0) !== 0x04034b50) {
      throw new EnvironmentError('O arquivo tem extensão .docx mas o conteúdo não é um DOCX válido.');
    }
    return ext;
  }

  function addResume(file, meta = {}) {
    const ext = validateUpload(file);
    const extraction = extractText(file.path, file.originalname);
    const sha = sha256(file.path);

    const info = db.prepare(`INSERT INTO ${T.resumes}
      (user_id, country, name, career_track, doc_type, filename, original_name, file_path,
       mime_type, file_size, sha256, extracted_text, extraction_confidence, is_default, is_active)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
      uid, env.country,
      meta.name || path.basename(file.originalname, ext),
      meta.career_track || 'geral',
      meta.doc_type || 'resume',
      file.filename, file.originalname, file.path,
      ALLOWED_MIME[ext], file.size || 0, sha,
      extraction.text || null, extraction.confidence,
      meta.is_default ? 1 : 0
    );

    const id = Number(info.lastInsertRowid);
    db.prepare(`UPDATE ${T.resumes} SET storage_key = ? WHERE id = ? AND user_id = ?`).run(storageKey(env, id, ext, uid), id, uid);
    if (meta.is_default) setDefaultResume(id);
    applyVisaType(id, meta.visa_type);

    logCore('candidate', 'resume_added',
      `Documento "${meta.name || file.originalname}" adicionado em ${label}.`,
      { environment: label, id, confidence: extraction.confidence });

    return { resume: getResume(id), extraction };
  }

  function setDefaultResume(id) {
    const r = getResume(id);
    if (!r) throw new EnvironmentError('Documento não encontrado neste ambiente.', 404);
    db.prepare(`UPDATE ${T.resumes} SET is_default = 0
                WHERE user_id = ? AND country = ? AND career_track = ? AND doc_type = ?`)
      .run(uid, env.country, r.career_track, r.doc_type);
    db.prepare(`UPDATE ${T.resumes} SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`).run(id, uid);
    return getResume(id);
  }

  /**
   * Tipo de visto do documento — etapa separada, e só no Seasonal (F1.2).
   *
   * Fica fora do INSERT e do UPDATE compartilhados de propósito: a coluna não
   * existe na Gupy nem no Indeed, e incluí-la na instrução comum quebraria os
   * dois com "no such column" — foi exatamente o que aconteceu na primeira
   * tentativa. Nos outros produtos esta função não faz nada, por desenho.
   */
  const VISA_TYPES = new Set(['H-2A', 'H-2B', 'ANY']);

  function applyVisaType(id, visaType) {
    if (!HAS_VISA_TYPE || visaType === undefined || visaType === null || visaType === '') return;
    const v = String(visaType).toUpperCase().replace(/^H2/, 'H-2');
    if (!VISA_TYPES.has(v)) {
      throw new EnvironmentError(`Tipo de visto inválido: "${visaType}". Use H-2A, H-2B ou ANY.`, 400);
    }
    db.prepare(`UPDATE ${T.resumes} SET visa_type = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND user_id = ? AND country = ?`).run(v, Number(id), uid, env.country);
  }

  function updateResume(id, data) {
    const r = getResume(id);
    if (!r) throw new EnvironmentError('Documento não encontrado neste ambiente.', 404);
    db.prepare(`UPDATE ${T.resumes} SET name = ?, career_track = ?, is_active = ?, archived = ?,
                updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND country = ?`).run(
      data.name !== undefined ? data.name : r.name,
      data.career_track !== undefined ? data.career_track : r.career_track,
      data.is_active !== undefined ? (data.is_active ? 1 : 0) : r.is_active,
      data.archived !== undefined ? (data.archived ? 1 : 0) : r.archived,
      id, uid, env.country
    );
    if (data.is_default) setDefaultResume(id);
    applyVisaType(id, data.visa_type);
    return getResume(id);
  }

  function archiveResume(id) {
    const r = getResume(id);
    if (!r) throw new EnvironmentError('Documento não encontrado neste ambiente.', 404);
    db.prepare(`UPDATE ${T.resumes} SET archived = 1, is_active = 0, is_default = 0,
                updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND country = ?`).run(id, uid, env.country);
    logCore('candidate', 'resume_archived', `Documento #${id} arquivado em ${label}.`, { environment: label });
    return { success: true };
  }

  /**
   * Recomenda o currículo mais adequado DENTRO deste ambiente (§1I).
   * Sem currículo aqui, o retorno é explícito — jamais o de outro ambiente.
   */
  function recommendResume({ careerTrack = null, job = null, visaType = null } = {}) {
    let pool = listResumes({ docType: 'resume' }).filter(r => r.is_active);

    if (!pool.length) {
      return {
        resume: null,
        reason: `Nenhum currículo configurado para ${label}. Adicione um neste ambiente — o sistema não usa o currículo de outra plataforma.`,
        environment: label
      };
    }

    // --- Tipo de visto decide ANTES de trilha e de semântica (F1.2) ---
    //
    // H-2A é agricultura e H-2B não é. Mandar o currículo de um no outro é
    // errar a conversa inteira, e nenhuma sobreposição de palavra-chave
    // compensa isso. Documento marcado ANY serve aos dois.
    if (visaType) {
      const wanted = String(visaType).toUpperCase();
      const matching = pool.filter(r => {
        const v = String(r.visa_type || 'ANY').toUpperCase();
        return v === wanted || v === 'ANY';
      });

      if (!matching.length) {
        // Existe currículo, mas nenhum serve a este visto. Dizer isso é melhor
        // que entregar o do outro tipo e deixar a candidatura sair errada.
        return {
          resume: null,
          environment: label,
          visaType: wanted,
          reason: `Nenhum currículo deste ambiente serve a vagas ${wanted}. ` +
                  `Cadastre um marcado como ${wanted} ou ANY — o currículo do outro tipo de visto não é usado como substituto.`
        };
      }

      // Específico do visto ganha de genérico quando os dois existem.
      const specific = matching.filter(r => String(r.visa_type || '').toUpperCase() === wanted);
      pool = specific.length ? specific : matching;
    }

    if (careerTrack) {
      const exact = pool.find(r => r.career_track === careerTrack);
      if (exact) {
        return { resume: exact, environment: label,
                 reason: `Trilha "${careerTrack}" corresponde à categoria detectada para a vaga.` };
      }
    }

    if (job) {
      const ontology = require('../core/match/skillOntology');
      const jobConcepts = new Set(
        ontology.extractKnownTerms([job.title, job.job_title, job.description, job.duties_description]
          .filter(Boolean).join(' ')).map(x => x.canonical)
      );

      let best = null;
      for (const r of pool) {
        const full = getResume(r.id);
        const resumeConcepts = new Set(
          ontology.extractKnownTerms((full && full.extracted_text) || r.name).map(x => x.canonical)
        );
        const overlap = [...jobConcepts].filter(x => resumeConcepts.has(x));
        if (!best || overlap.length > best.overlap.length) best = { resume: r, overlap };
      }

      if (best && best.overlap.length) {
        const labels = best.overlap.map(c => (ontology.groupFor(c) || {}).label).filter(Boolean);
        return { resume: best.resume, environment: label,
                 reason: `Maior sobreposição de experiência com a vaga (${labels.slice(0, 4).join(', ')}).` };
      }
    }

    const def = pool.find(r => r.is_default) || pool[0];
    return { resume: def, environment: label,
             reason: `Currículo padrão de ${label} — nenhuma trilha específica correspondeu à vaga.` };
  }

  /**
   * Sugere habilidades encontradas no texto de um currículo DESTE ambiente.
   * São sugestões a confirmar, nunca fatos assumidos.
   */
  function suggestSkillsFromResume(resumeId) {
    const r = getResume(resumeId);
    if (!r) throw new EnvironmentError('Documento não encontrado neste ambiente.', 404);
    if (!r.extracted_text) {
      return { suggestions: [], environment: label,
               warning: 'Não há texto extraído deste documento para analisar.' };
    }

    const ontology = require('../core/match/skillOntology');
    const existing = new Set(getProfile().skills.map(s => ontology.normalize(s)));

    const suggestions = ontology.extractKnownTerms(r.extracted_text)
      .filter(f => !existing.has(ontology.normalize(f.label)))
      .map(f => ({
        value: f.label, matchedTerm: f.matchedTerm, confidence: 0.7,
        source: `resume:${resumeId}`,
        note: `Termo "${f.matchedTerm}" encontrado em "${r.name}". Confirme antes de tratar como experiência.`
      }));

    return { suggestions, resumeName: r.name, environment: label,
             extractionConfidence: r.extraction_confidence };
  }

  return {
    platform: env.platform, country: env.country, label,
    tables: T,
    getProfile, updateProfile,
    listResumes, getResume, addResume, updateResume, archiveResume,
    setDefaultResume, recommendResume, suggestSkillsFromResume, validateUpload
  };
}

// ---------------------------------------------------------------------------
// Documentos herdados da v2, aguardando atribuição explícita (spec §1J)
// ---------------------------------------------------------------------------

function listUnassignedDocuments({ includeAssigned = false } = {}) {
  const where = includeAssigned ? '' : 'WHERE assigned_to IS NULL';
  return db.prepare(`SELECT id, legacy_id, name, original_country, career_track, doc_type,
                            original_name, mime_type, file_size, extraction_confidence,
                            assigned_to, assigned_at, created_at
                     FROM core_unassigned_documents ${where}
                     ORDER BY id`).all();
}

/**
 * Atribui um documento herdado a UM ambiente, criando uma cópia independente.
 * O original continua no staging, marcado — nada é apagado (§1J.5) e nenhuma
 * sincronização acontece depois: a partir daqui os dois são independentes (§1D).
 */
function assignDocument(documentId, platform, country, userId) {
  const env = resolveEnv(platform, country);
  const doc = db.prepare('SELECT * FROM core_unassigned_documents WHERE id = ?').get(Number(documentId));
  if (!doc) throw new EnvironmentError('Documento herdado não encontrado.', 404);
  if (!fs.existsSync(doc.file_path)) {
    throw new EnvironmentError('O arquivo original não está mais disponível no servidor.', 404);
  }

  const store = environment(env.platform, env.country, userId);
  const ext = path.extname(doc.original_name || '').toLowerCase();

  const info = db.prepare(`INSERT INTO ${store.tables.resumes}
    (user_id, country, name, career_track, doc_type, filename, original_name, file_path,
     mime_type, file_size, sha256, extracted_text, extraction_confidence, is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
    Number(userId), env.country, doc.name, doc.career_track || 'geral', doc.doc_type || 'resume',
    doc.filename, doc.original_name, doc.file_path,
    doc.mime_type, doc.file_size, sha256(doc.file_path),
    doc.extracted_text, doc.extraction_confidence
  );

  const newId = Number(info.lastInsertRowid);
  db.prepare(`UPDATE ${store.tables.resumes} SET storage_key = ? WHERE id = ?`)
    .run(storageKey(env, newId, ext, Number(userId)), newId);

  const target = `${env.platform}/${env.country}`;
  const previous = doc.assigned_to ? doc.assigned_to.split(',').filter(Boolean) : [];
  if (!previous.includes(target)) previous.push(target);

  db.prepare(`UPDATE core_unassigned_documents SET assigned_to = ?, assigned_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(previous.join(','), doc.id);

  logCore('candidate', 'legacy_document_assigned',
    `Documento herdado "${doc.name}" copiado para ${target}.`,
    { documentId: doc.id, target, newResumeId: newId });

  return { resume: store.getResume(newId), environment: target, copiedFrom: doc.id };
}

function sha256(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch (e) { return null; }
}

module.exports = {
  PLATFORMS, ALLOWED_MIME, EnvironmentError,
  resolveEnv, environment, storageKey, sha256,
  listUnassignedDocuments, assignDocument,
  uploadsRoot
};
