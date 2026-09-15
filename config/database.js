/**
 * Schema e migrações — AI Job Intelligence Platform.
 *
 * Isolamento lógico por prefixo (spec §50), equivalente aos schemas PostgreSQL
 * core.* / gupy.* / indeed.* / seasonal.* :
 *
 *   core_*      infraestrutura compartilhada + Perfil Mestre + Biblioteca de Currículos
 *   gupy_*      produto Gupy, com escopo explícito de país (BR | US)
 *   indeed_*    produto Indeed, com escopo explícito de país (BR | US)
 *   seasonal_*  produto Seasonal Jobs — somente US (spec §4.3)
 *
 * Gupy e Indeed NUNCA compartilham tabela de vagas (spec §50, §44).
 * O escopo de país é uma coluna DENTRO de cada produto, o que o spec §50
 * endossa explicitamente ("country-specific entities should contain explicit
 * country scope") — não é a coluna `source` proibida pela §44.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const os = require('os');

const appRoot = path.resolve(__dirname, '..');

/**
 * Onde os dados moram. Por padrão dentro da pasta do app (data/ e
 * private_uploads/), o que serve para a máquina do usuário. Em servidor,
 * DATA_DIR e UPLOADS_DIR devem apontar para FORA da pasta do app: um deploy
 * que recria a pasta (clone novo, "rebuild") apagaria o banco junto.
 */
const dbDir = path.resolve(process.env.DATA_DIR || path.join(appRoot, 'data'));
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

// Uploads ficam FORA de qualquer diretório servido estaticamente (spec §54).
const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(appRoot, 'private_uploads'));
const uploadsDirs = ['resumes', 'documents', 'portfolio'].map(d => path.join(uploadsRoot, d));
for (const dir of uploadsDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const defaultDbPath = path.join(dbDir, 'h2a_system.db');

/**
 * Testes NUNCA abrem o banco real. Um teste que esquece o DB_PATH ganha um
 * banco temporário, e um DB_PATH que aponte para o banco real sob NODE_ENV=test
 * é recusado — `npm test` na máquina de produção já apagou modelos e
 * notificações uma vez; não acontece de novo.
 */
function resolveDbPath() {
  const wanted = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : null;
  if (process.env.NODE_ENV === 'test') {
    if (!wanted) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h2a-test-'));
      const p = path.join(tmp, 'test.db');
      process.env.DB_PATH = p;
      return p;
    }
    if (wanted === path.resolve(defaultDbPath)) {
      throw new Error(`Recusado: NODE_ENV=test com DB_PATH apontando para o banco real (${wanted}).`);
    }
    return wanted;
  }
  return wanted || defaultDbPath;
}

const dbPath = resolveDbPath();
const db = new DatabaseSync(dbPath);

// Os backups ficam ao lado do banco que está aberto — um teste com DB_PATH
// temporário faz backup no temporário, nunca na pasta de backups real.
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(path.dirname(dbPath), 'backups'));

/** Tudo que descreve onde os dados estão — para o painel "Dados e backup" e o banner. */
function storagePaths() {
  const inside = (p) => path.resolve(p).toLowerCase().startsWith(appRoot.toLowerCase() + path.sep);
  return {
    appRoot, dbPath, dataDir: dbDir, uploadsRoot, backupDir,
    dbInsideApp: inside(dbPath), uploadsInsideApp: inside(uploadsRoot), backupsInsideApp: inside(backupDir),
    fromEnv: { DATA_DIR: Boolean(process.env.DATA_DIR), UPLOADS_DIR: Boolean(process.env.UPLOADS_DIR), BACKUP_DIR: Boolean(process.env.BACKUP_DIR) }
  };
}

try { db.exec('PRAGMA journal_mode = WAL;'); } catch (e) {}
try { db.exec('PRAGMA foreign_keys = ON;'); } catch (e) {}

const SCHEMA_VERSION = 5;

// ---------------------------------------------------------------------------
// MIGRAÇÕES
// ---------------------------------------------------------------------------

function tableExists(name) {
  const r = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  return Boolean(r);
}

function columnsOf(table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); }
  catch (e) { return []; }
}

function addColumnIfMissing(table, column, definition) {
  if (!tableExists(table)) return;
  if (columnsOf(table).includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

function getSchemaVersion() {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS core_schema_meta (
      key TEXT PRIMARY KEY, value TEXT, applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    );`);
    const r = db.prepare("SELECT value FROM core_schema_meta WHERE key = 'schema_version'").get();
    return r ? parseInt(r.value, 10) : 0;
  } catch (e) { return 0; }
}

function setSchemaVersion(v) {
  db.prepare(`INSERT INTO core_schema_meta (key, value, applied_at) VALUES ('schema_version', ?, CURRENT_TIMESTAMP)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, applied_at = CURRENT_TIMESTAMP`).run(String(v));
}

/**
 * Tabelas do schema v1 cuja FORMA mudou na v2. `CREATE TABLE IF NOT EXISTS` não
 * altera tabela existente, então elas são renomeadas para `<nome>__v1` antes da
 * criação do schema novo, e os dados que ainda fazem sentido são copiados de volta
 * em backfillFromV1(). Nada é apagado nesta etapa.
 */
const V2_RESHAPED = {
  gupy_jobs:                     'country',
  gupy_matches:                  'fit_version',
  gupy_job_analysis:             'requirements_json',
  gupy_searches:                 'params_json',
  gupy_integration_config:       'country',
  gupy_logs:                     'country',
  indeed_jobs:                   'country',
  indeed_matches:                'fit_version',
  indeed_job_analysis:           'requirements_json',
  indeed_searches:               'params_json',
  indeed_integration_config:     'country',
  indeed_logs:                   'country',
  seasonal_jobs:                 'timeline_class',
  seasonal_matches:              'fit_version',
  seasonal_job_analysis:         'requirements_json',
  seasonal_application_packages: 'validation_json',
  seasonal_email_queue:          'error_class',
  seasonal_applications:         'candidate_id',
  seasonal_daily_quota:          'timezone',
  seasonal_logs:                 'correlation_id',
  seasonal_portfolio:            'is_public',
  // Os perfis da v1 tinham outra forma; na v3 passam a ser o perfil do ambiente.
  gupy_profiles:                 'skills_json',
  indeed_profiles:               'skills_json',
  seasonal_profiles:             'skills_json'
};

/** Schema genérico da v1, proibido pela spec §44. */
const LEGACY_TABLES = [
  'jobs', 'candidate_profile', 'candidate_profile_tech', 'resumes',
  'applications_queue', 'sent_history', 'daily_quotas', 'system_settings',
  'system_logs', 'email_templates', 'received_emails',
  'seasonal_documents', 'seasonal_integration_config'
];

/** Renomeia as tabelas remodeladas para `__v1`. */
function prepareV2Tables() {
  const renamed = [];
  for (const [table, requiredColumn] of Object.entries(V2_RESHAPED)) {
    if (!tableExists(table)) continue;
    if (columnsOf(table).includes(requiredColumn)) continue;
    try {
      db.exec(`DROP TABLE IF EXISTS ${table}__v1;`);
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}__v1;`);
      renamed.push(table);
    } catch (e) { /* segue: createSchema recria a tabela do zero */ }
  }

  // Tabelas com FK para as renomeadas precisam sair também, senão apontam para o lugar errado.
  for (const t of ['gupy_saved_jobs', 'gupy_discarded_jobs', 'indeed_saved_jobs',
                   'indeed_discarded_jobs', 'seasonal_saved_jobs', 'seasonal_discarded_jobs']) {
    if (tableExists(t)) { try { db.exec(`DROP TABLE IF EXISTS ${t};`); } catch (e) {} }
  }

  return renamed;
}

/**
 * Copia da v1 o que ainda vale, na ordem de importância:
 *   1. seasonal_applications — histórico de envios (proteção anti-duplicata, §62)
 *   2. seasonal_jobs — ordens de serviço já coletadas
 *   3. tabela genérica `jobs` — as linhas em formato DOL viram seasonal_jobs (§44)
 *   4. seasonal_documents — vira a Biblioteca de Currículos (§5.2)
 *   5. seasonal_daily_quota — contagem do dia, para não zerar a trava
 */
function backfillFromV1() {
  const report = { applications: 0, seasonalJobs: 0, fromLegacyJobs: 0, resumes: 0, quota: 0 };

  // 1. Histórico de candidaturas enviadas — o mais crítico de preservar.
  if (tableExists('seasonal_applications__v1')) {
    const rows = db.prepare('SELECT * FROM seasonal_applications__v1').all();
    const ins = db.prepare(`INSERT INTO seasonal_applications
      (candidate_id, seasonal_job_id, job_order_id, recipient_email, employer_name, subject, content_sent, sent_at, status)
      VALUES (1,?,?,?,?,?,?,?,?)
      ON CONFLICT(candidate_id, seasonal_job_id, recipient_email) DO NOTHING`);
    for (const r of rows) {
      try {
        ins.run(r.seasonal_job_id, r.job_order_id || '', r.recipient_email, r.employer_name || '',
                r.subject || '', r.content_sent || null, r.sent_at || null, r.status || 'SENT');
        report.applications++;
      } catch (e) {}
    }
  }

  // 2 e 3. Ordens de serviço, da v1 e da tabela genérica.
  const insertJob = db.prepare(`
    INSERT INTO seasonal_jobs (
      job_order_id, visa_type, job_title, normalized_title, soc_code, employer_name,
      employer_city, employer_state, employer_phone, employer_email, attorney_name,
      attorney_email, wage_rate, wage_unit, start_date, end_date, openings,
      housing_provided, duties_description, special_requirements,
      application_method, application_email, raw_json, collected_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(job_order_id) DO NOTHING
  `);

  const copyJobRow = (r) => {
    if (!r.job_order_id) return false;
    const email = r.employer_email || r.attorney_email || null;
    try {
      insertJob.run(
        r.job_order_id, r.visa_type || 'H-2A', r.job_title || 'Sem título',
        r.normalized_title || r.job_title || null, r.soc_code || null,
        r.employer_name || 'Empregador não informado',
        r.employer_city || null, r.employer_state || null, r.employer_phone || null,
        r.employer_email || null, r.attorney_name || null, r.attorney_email || null,
        r.wage_rate == null ? null : r.wage_rate, r.wage_unit || 'Hour',
        r.start_date || null, r.end_date || null, r.openings || 1,
        r.housing_provided == null ? 0 : r.housing_provided,
        r.duties_description || null, r.special_requirements || null,
        email ? 'EMAIL' : (r.employer_phone ? 'PHONE' : 'UNKNOWN'),
        email, r.raw_json || null, r.collected_at || null
      );
      return true;
    } catch (e) { return false; }
  };

  if (tableExists('seasonal_jobs__v1')) {
    for (const r of db.prepare('SELECT * FROM seasonal_jobs__v1').all()) {
      if (copyJobRow(r)) report.seasonalJobs++;
    }
  }

  if (tableExists('jobs') && columnsOf('jobs').includes('job_order_id')) {
    for (const r of db.prepare('SELECT * FROM jobs').all()) {
      if (copyJobRow(r)) report.fromLegacyJobs++;
    }
  }

  // 4. Documentos viram a Biblioteca de Currículos.
  if (tableExists('seasonal_documents')) {
    const rows = db.prepare('SELECT * FROM seasonal_documents').all();
    const ins = db.prepare(`INSERT INTO core_resumes
      (name, country, career_track, doc_type, filename, original_name, file_path, file_size, is_default, is_active, created_at)
      VALUES (?,'US',?,?,?,?,?,?,?,?,?)`);
    for (const r of rows) {
      try {
        ins.run(r.title || r.original_name || 'Documento', r.category || 'geral',
                r.doc_type || 'resume', r.filename, r.original_name || r.filename,
                r.file_path, r.file_size || 0, r.is_default || 0,
                r.is_active == null ? 1 : r.is_active, r.uploaded_at || null);
        report.resumes++;
      } catch (e) {}
    }
  }

  // 5. Cota do dia corrente.
  if (tableExists('seasonal_daily_quota__v1')) {
    const rows = db.prepare('SELECT * FROM seasonal_daily_quota__v1').all();
    const ins = db.prepare(`INSERT INTO seasonal_daily_quota (date_str, count_sent, max_limit)
                            VALUES (?,?,?) ON CONFLICT(date_str) DO NOTHING`);
    for (const r of rows) {
      try { ins.run(r.date_str, r.count_sent || 0, r.max_limit || 50); report.quota++; } catch (e) {}
    }
  }

  return report;
}

/**
 * Migração v3 — elimina o Perfil Mestre e a Biblioteca compartilhada.
 *
 * O spec de infraestrutura §1A/§1K torna o modelo compartilhado arquiteturalmente
 * incorreto: cada plataforma é dona do próprio perfil e dos próprios currículos.
 *
 * A regra §1J é explícita sobre como migrar:
 *   - não apagar currículos existentes em silêncio;
 *   - exigir mapeamento EXPLÍCITO do usuário para atribuir a um ambiente;
 *   - remover a dependência de runtime do modelo antigo.
 *
 * Por isso os documentos vão para `core_unassigned_documents` e ficam esperando
 * o usuário escolher a qual plataforma/país pertencem. Copiá-los para todos os
 * ambientes violaria o isolamento que a migração existe para criar.
 */
function migrateSharedCandidateModel() {
  const report = { documentsPreserved: 0, profileSeeds: 0, dropped: [] };

  if (tableExists('core_resumes')) {
    const rows = db.prepare('SELECT * FROM core_resumes').all();
    const ins = db.prepare(`INSERT INTO core_unassigned_documents
      (legacy_id, name, original_country, career_track, doc_type, filename, original_name,
       file_path, mime_type, file_size, extracted_text, extraction_confidence, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const r of rows) {
      try {
        ins.run(r.id, r.name, r.country, r.career_track, r.doc_type, r.filename,
                r.original_name, r.file_path, r.mime_type, r.file_size,
                r.extracted_text, r.extraction_confidence, r.created_at);
        report.documentsPreserved++;
      } catch (e) {}
    }
  }

  // O perfil mestre antigo vira o ponto de partida do ambiente correspondente ao
  // país que ele declarava — e SOMENTE dele. Os demais ambientes nascem vazios.
  if (tableExists('core_master_profile')) {
    const p = db.prepare('SELECT * FROM core_master_profile ORDER BY id LIMIT 1').get();
    if (p && (p.full_name || p.email)) {
      const country = String(p.country || 'BR').toUpperCase() === 'US' ? 'US' : 'BR';
      const attrs = tableExists('core_profile_attributes')
        ? db.prepare('SELECT kind, value FROM core_profile_attributes WHERE profile_id = ?').all(p.id)
        : [];
      const listOf = k => JSON.stringify(attrs.filter(a => a.kind === k).map(a => a.value));

      // Semeia apenas gupy_profiles do país declarado. Indeed e Seasonal
      // permanecem vazios: presumir que o mesmo perfil serve aos três seria
      // exatamente a sincronização que o §1D proíbe.
      try {
        db.prepare(`INSERT INTO gupy_profiles
          (country, full_name, email, phone, city, state, headline, summary,
           years_of_experience, availability_from, availability_to, workplace_preference,
           work_authorization, drivers_license, skills_json, tools_json, languages_json,
           certifications_json, industries_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(country) DO UPDATE SET
            full_name = CASE WHEN gupy_profiles.full_name = '' THEN excluded.full_name ELSE gupy_profiles.full_name END,
            email     = CASE WHEN gupy_profiles.email = ''     THEN excluded.email     ELSE gupy_profiles.email END`)
          .run(country, p.full_name || '', p.email || '', p.phone || '', p.city || '', p.state || '',
               p.headline || '', p.summary || '', p.years_of_experience,
               p.availability_from, p.availability_to, p.workplace_preference || 'remote',
               p.work_authorization, p.drivers_license,
               listOf('skill'), listOf('tool'), listOf('language'),
               listOf('certification'), listOf('industry'));
        report.profileSeeds = 1;
        report.seededEnvironment = `gupy/${country}`;
      } catch (e) {}
    }
  }

  for (const t of ['core_ats_issues', 'core_resume_analysis', 'core_resumes',
                   'core_profile_attributes', 'core_master_profile']) {
    if (!tableExists(t)) continue;
    try { db.exec(`DROP TABLE IF EXISTS ${t};`); report.dropped.push(t); } catch (e) {}
  }

  return report;
}

/**
 * Migração v4 — identidade e autorização por usuário (spec de autenticação §23, §24).
 *
 * Perfis e currículos passam a pertencer a um usuário identificado. Como a
 * chave única muda de `(country)` para `(user_id, country)`, as tabelas são
 * reconstruídas: SQLite não altera constraint por ALTER TABLE.
 *
 * Os dados existentes são atribuídos ao primeiro usuário — o operador que já
 * vinha usando a instalação. Nada é descartado.
 */
const V4_RESHAPED = {
  gupy_profiles: 'user_id',
  gupy_resumes: 'user_id',
  indeed_profiles: 'user_id',
  indeed_resumes: 'user_id',
  seasonal_profiles: 'user_id',
  seasonal_resumes: 'user_id'
};

function prepareV4Tables() {
  const renamed = [];
  for (const [table, requiredColumn] of Object.entries(V4_RESHAPED)) {
    if (!tableExists(table)) continue;
    if (columnsOf(table).includes(requiredColumn)) continue;
    try {
      db.exec(`DROP TABLE IF EXISTS ${table}__v3;`);
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}__v3;`);
      renamed.push(table);
    } catch (e) { /* createSchema recria do zero */ }
  }
  // As análises referenciam os currículos: saem para não apontar para o lugar errado.
  for (const t of ['gupy_resume_analysis', 'indeed_resume_analysis', 'seasonal_resume_analysis']) {
    if (tableExists(t)) { try { db.exec(`DROP TABLE IF EXISTS ${t};`); } catch (e) {} }
  }
  return renamed;
}

/** Copia perfis e currículos da v3, atribuindo-os ao usuário informado. */
function backfillFromV3(userId) {
  const report = { profiles: 0, resumes: 0 };

  const copy = (table, extraCols) => {
    const src = `${table}__v3`;
    if (!tableExists(src)) return 0;

    const targetCols = columnsOf(table).filter(c => c !== 'id' && c !== 'user_id');
    const srcCols = columnsOf(src);
    const shared = targetCols.filter(c => srcCols.includes(c));
    if (!shared.length) return 0;

    const rows = db.prepare(`SELECT * FROM ${src}`).all();
    const stmt = db.prepare(
      `INSERT INTO ${table} (user_id, ${shared.join(', ')})
       VALUES (?, ${shared.map(() => '?').join(', ')})`
    );

    let n = 0;
    for (const r of rows) {
      try { stmt.run(userId, ...shared.map(c => r[c])); n++; } catch (e) { /* linha inválida */ }
    }
    return n;
  };

  for (const t of ['gupy_profiles', 'indeed_profiles', 'seasonal_profiles']) report.profiles += copy(t);
  for (const t of ['gupy_resumes', 'indeed_resumes', 'seasonal_resumes']) report.resumes += copy(t);

  for (const t of Object.keys(V4_RESHAPED)) {
    try { db.exec(`DROP TABLE IF EXISTS ${t}__v3;`); } catch (e) {}
  }

  return report;
}

/**
 * Garante que exista um usuário para receber os dados já cadastrados.
 *
 * Sem Google configurado, a aplicação opera em modo operador local — o que é
 * declarado explicitamente, nunca disfarçado de login do Google (spec §33).
 */
function ensureBootstrapUser() {
  const existing = db.prepare('SELECT id FROM core_users ORDER BY id LIMIT 1').get();
  if (existing) return existing.id;

  const info = db.prepare(
    `INSERT INTO core_users (email, email_verified, display_name, auth_mode, last_login_at)
     VALUES (NULL, 0, 'Operador local', 'local_operator', CURRENT_TIMESTAMP)`
  ).run();
  const userId = Number(info.lastInsertRowid);

  db.prepare(
    `INSERT OR IGNORE INTO core_auth_identities (user_id, provider, subject, email)
     VALUES (?, 'local', 'local-operator', NULL)`
  ).run(userId);

  return userId;
}

/**
 * Corrige a chave única de `indeed_jobs`.
 *
 * A tabela nasceu com `UNIQUE(external_id)` e o resto do produto assume
 * `UNIQUE(country, external_id)` — o mesmo que `gupy_jobs` sempre teve. As
 * duas consequências eram reais:
 *
 *   1. o `ON CONFLICT(country, external_id)` do upsert não encontrava
 *      constraint correspondente e TODA importação do Indeed falhava, vaga a
 *      vaga, com o erro absorvido pelo coletor do pipeline;
 *   2. o mesmo `external_id` em BR e US colidia, furando o isolamento por
 *      país que o produto garante.
 *
 * SQLite não altera constraint por ALTER TABLE, então a tabela é reconstruída.
 * Nada é descartado: as linhas são copiadas antes da troca.
 */
function fixIndeedUniqueConstraint() {
  if (!tableExists('indeed_jobs')) return { changed: false, reason: 'tabela ausente' };

  const correct = db.prepare("PRAGMA index_list('indeed_jobs')").all().some(i => {
    if (!i.unique) return false;
    const cols = db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all().map(c => c.name);
    return cols.length === 2 && cols.includes('country') && cols.includes('external_id');
  });
  if (correct) return { changed: false, reason: 'já correta' };

  try {
    db.exec('PRAGMA foreign_keys = OFF;');
    // Sem `legacy_alter_table`, o SQLite reescreve as FKs das tabelas
    // dependentes para o NOVO nome — e elas passam a apontar para uma tabela
    // que este procedimento vai apagar. Com o modo legado ligado, elas
    // continuam referenciando "indeed_jobs", que é recriada logo abaixo.
    db.exec('PRAGMA legacy_alter_table = ON;');
    db.exec('ALTER TABLE indeed_jobs RENAME TO indeed_jobs__oldkey;');
    db.exec('PRAGMA legacy_alter_table = OFF;');
    createSchema();                                   // recria com a chave certa

    const target = columnsOf('indeed_jobs');
    const source = columnsOf('indeed_jobs__oldkey');
    const shared = target.filter(c => c !== 'id' && source.includes(c));

    // A chave nova é mais restritiva: linhas que colidiriam são ignoradas em
    // vez de abortar a migração inteira.
    const copied = db.prepare(
      `INSERT OR IGNORE INTO indeed_jobs (${shared.join(', ')})
       SELECT ${shared.join(', ')} FROM indeed_jobs__oldkey`
    ).run();

    db.exec('DROP TABLE indeed_jobs__oldkey;');

    logCore('database', 'indeed_unique_fixed',
      `Chave única de indeed_jobs corrigida para (country, external_id). ${copied.changes} linha(s) preservada(s).`,
      { columns: shared.length });

    return { changed: true, rowsPreserved: Number(copied.changes) };
  } catch (e) {
    // Deixa a tabela antiga no lugar se algo falhar — não perde dado.
    try {
      if (tableExists('indeed_jobs__oldkey') && !tableExists('indeed_jobs')) {
        db.exec('ALTER TABLE indeed_jobs__oldkey RENAME TO indeed_jobs;');
      }
    } catch (e2) { /* nada mais a fazer */ }
    return { changed: false, error: e.message };
  } finally {
    try { db.exec('PRAGMA foreign_keys = ON;'); } catch (e) {}
  }
}

/**
 * Repara tabelas cuja foreign key ficou apontando para `indeed_jobs__oldkey`.
 *
 * Uma execução anterior desta migração renomeou `indeed_jobs` sem o modo
 * legado ligado; o SQLite reescreveu as FKs das tabelas dependentes para o
 * nome temporário, que depois foi apagado. O sintoma é um erro de "no such
 * table" a cada gravação de análise.
 *
 * Estas tabelas guardam dado DERIVADO — análise e pontuação são recalculadas
 * na próxima importação. Recriá-las é seguro; deixá-las quebradas não é.
 */
function repairDanglingIndeedFks() {
  const broken = db.prepare(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND sql LIKE '%indeed_jobs__oldkey%'`
  ).all().map(r => r.name);

  if (!broken.length) return { repaired: [] };

  try {
    db.exec('PRAGMA foreign_keys = OFF;');
    for (const t of broken) {
      try { db.exec(`DROP TABLE IF EXISTS ${t};`); } catch (e) { /* segue */ }
    }
    createSchema();
    logCore('database', 'indeed_fk_repaired',
      `Referências órfãs corrigidas em: ${broken.join(', ')}. Análises serão recalculadas na próxima importação.`,
      { tables: broken });
    return { repaired: broken };
  } finally {
    try { db.exec('PRAGMA foreign_keys = ON;'); } catch (e) {}
  }
}

/**
 * Teto diário de e-mails: 50 → 300 (decisão do operador, 2026-09-11, com F1.3).
 *
 * O `DEFAULT` do schema só vale para linha nova; a instalação existente guarda
 * o valor antigo, e o limite efetivo é o MENOR entre código e banco. Sem esta
 * migração o código diria 300 e o sistema continuaria enviando 50.
 *
 * Sobe apenas o que ainda está no padrão antigo. Um valor que o operador
 * baixou de propósito (10, 20) é decisão dele e permanece.
 */
const OLD_DAILY_CAP = 50;
const NEW_DAILY_CAP = 300;

/**
 * Foco amplo (2026-09-11): o operador decidiu que o sistema não é mais só de
 * motorista de caminhão. Uma única vez, o foco existente vira "todas as
 * vagas"; depois disso a escolha na tela manda e esta migração não toca mais.
 */
function migrateJobFocus() {
  const KEY = 'job_focus_migrated_broad_v1';
  try {
    const done = db.prepare('SELECT value FROM core_system_settings WHERE key = ?').get(KEY);
    if (done) return { migrated: false, reason: 'already' };
    const r = db.prepare('UPDATE seasonal_config SET require_truck_driver_match = 0 WHERE require_truck_driver_match = 1').run();
    db.prepare(`INSERT INTO core_system_settings (key, value, description) VALUES (?, '1', ?)
                ON CONFLICT(key) DO UPDATE SET value = '1'`)
      .run(KEY, 'Migração única: foco das candidaturas passou a "todas as vagas H-2A/H-2B".');
    if (r.changes > 0) {
      logCore('database', 'job_focus_migrated',
        'Foco das candidaturas ampliado de "só motorista de caminhão" para "todas as vagas H-2A/H-2B" (decisão do operador).',
        { rows: r.changes });
    }
    return { migrated: r.changes > 0 };
  } catch (e) { return { migrated: false, error: e.message }; }
}

/**
 * Preenche o link público das vagas importadas antes de a coluna existir.
 * A regra é a mesma do adaptador: H-400/H-300 direto; JO-A-300-N → H-300-N.
 * A flag de publicação das ordens H-2A fica em 0 até o próximo reimport,
 * que traz a data de aceite; as H-2B já nascem publicadas.
 */
function migrateDolLinks() {
  try {
    const a = db.prepare(`UPDATE seasonal_jobs
      SET dol_url = 'https://seasonaljobs.dol.gov/jobs/' || job_order_id, dol_published = 1
      WHERE dol_url IS NULL AND job_order_id GLOB 'H-[34]00-[0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]'`).run();
    const b = db.prepare(`UPDATE seasonal_jobs
      SET dol_url = 'https://seasonaljobs.dol.gov/jobs/H-300-' || substr(job_order_id, 10)
      WHERE dol_url IS NULL AND job_order_id GLOB 'JO-A-300-[0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]'`).run();
    return { h2b: a.changes, h2a: b.changes };
  } catch (e) { return { error: e.message }; }
}

/**
 * Limite diário "automático" (2026-09-14): o operador pediu 300 e-mails por
 * conta Gmail cadastrada. O teto global passou a ser 300 × contas ativas, e
 * daily_email_limit = 0 significa "acompanhar o teto". Uma única vez, quem
 * ainda tinha o antigo 300 fixo passa para automático.
 */
/**
 * Base de divulgação do DOL (2026-09-14): vagas de temporadas passadas, de
 * empregadores que contratam pelo programa todo ano, importadas de um JSON.
 *
 *   origin / origin_ref   de onde a vaga veio: 'dol' (feed/índice) ou
 *                         'disclosure' (base de divulgação + arquivo de origem)
 *   employer_key/title_key chaves canônicas para achar a mesma vaga com
 *                         grafia diferente — é por elas que uma vaga da base
 *                         some quando o mesmo empregador já tem o mesmo cargo
 *                         nas vagas atuais
 *   merged_cases_json     pedidos do DOL que foram dobrados neste card
 *   dup_hidden            1 quando a vaga da base está oculta porque o mesmo
 *                         empregador tem o mesmo cargo entre as vagas atuais;
 *                         recalculado a cada importação (feed ou base)
 *   templates.audience    modelo de e-mail para vagas atuais, para a base
 *                         (candidatura à próxima temporada) ou para ambas
 */
function migrateDisclosureBase() {
  const report = { keys: 0, seeded: false };
  addColumnIfMissing('seasonal_jobs', 'origin', "TEXT DEFAULT 'dol'");
  addColumnIfMissing('seasonal_jobs', 'origin_ref', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'employer_key', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'title_key', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'merged_cases_json', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'dup_hidden', 'INTEGER DEFAULT 0');
  addColumnIfMissing('seasonal_email_templates', 'audience', "TEXT DEFAULT 'ANY'");
  try {
    db.exec("UPDATE seasonal_jobs SET origin = 'dol' WHERE origin IS NULL;");
    db.exec("UPDATE seasonal_email_templates SET audience = 'ANY' WHERE audience IS NULL;");
    db.exec('CREATE INDEX IF NOT EXISTS idx_seasonal_dedup ON seasonal_jobs(employer_key, title_key, employer_state);');
  } catch (e) { /* segue */ }
  // Chaves das vagas que já existiam — calculadas em JS, uma vez.
  try {
    const keys = require('../core/jobs/dedupKeys');
    const rows = db.prepare('SELECT id, employer_name, job_title FROM seasonal_jobs WHERE employer_key IS NULL OR title_key IS NULL').all();
    if (rows.length) {
      const up = db.prepare('UPDATE seasonal_jobs SET employer_key = ?, title_key = ? WHERE id = ?');
      db.exec('BEGIN');
      try {
        for (const r of rows) up.run(keys.employerKey(r.employer_name), keys.titleKey(r.job_title), r.id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      report.keys = rows.length;
    }
  } catch (e) { report.error = e.message; }
  // Modelo de e-mail para a base: uma vez, se ainda não houver nenhum.
  const KEY = 'recurring_templates_v1';
  try {
    if (!db.prepare('SELECT value FROM core_system_settings WHERE key = ?').get(KEY)) {
      const has = db.prepare("SELECT COUNT(*) c FROM seasonal_email_templates WHERE audience = 'RECURRING'").get().c;
      if (!has) {
        const ins = db.prepare(`INSERT INTO seasonal_email_templates (kind, visa_type, audience, content, active, sort_order) VALUES (?,?,?,?,1,?)`);
        ins.run('subject', 'ANY', 'RECURRING', 'Application for the upcoming {visto} season — {vaga} — {nome}', 50);
        ins.run('body', 'ANY', 'RECURRING',
          'Dear Hiring Team at {empresa},\n\n' +
          'I understand that {empresa} hired {vaga} workers through the {visto} program for the {ano_vaga} season in {cidade}, {estado} (DOL case #{job_order}). ' +
          'I would like to apply for a position on your team for the upcoming season.\n\n' +
          'I am available to start when your next season begins and can provide my resume, references and any documents you need for the visa process.\n\n' +
          'Thank you for your time. I would be glad to answer any questions.\n\n' +
          'Best regards,\n{nome}\n{email}\n{telefone}', 50);
        report.seeded = true;
      }
      db.prepare(`INSERT INTO core_system_settings (key, value, description) VALUES (?, '1', ?)
                  ON CONFLICT(key) DO UPDATE SET value = '1'`)
        .run(KEY, 'Migração única: modelo de e-mail para empregadores da base de divulgação (temporada seguinte).');
    }
  } catch (e) { report.templatesError = e.message; }
  return report;
}

function migrateDailyLimitAuto() {
  // v2: a v1 não zerava a trava do sistema (max_seasonal_emails_per_day); roda de novo, idempotente.
  const KEY = 'daily_limit_auto_v2';
  try {
    if (db.prepare('SELECT value FROM core_system_settings WHERE key = ?').get(KEY)) return { migrated: false };
    const r = db.prepare('UPDATE seasonal_config SET daily_email_limit = 0 WHERE daily_email_limit = 300').run();
    db.prepare("UPDATE core_system_settings SET value = '0', updated_at = CURRENT_TIMESTAMP WHERE key = 'max_seasonal_emails_per_day' AND value = '300'").run();
    db.prepare(`INSERT INTO core_system_settings (key, value, description) VALUES (?, '1', ?)
                ON CONFLICT(key) DO UPDATE SET value = '1'`)
      .run(KEY, 'Migração única: limite diário passou a acompanhar 300 × contas Gmail ativas.');
    return { migrated: r.changes > 0 };
  } catch (e) { return { migrated: false, error: e.message }; }
}

function migrateDailyEmailCap() {
  const report = { config: false, setting: false };

  try {
    const r = db.prepare('UPDATE seasonal_config SET daily_email_limit = ? WHERE daily_email_limit = ?')
      .run(NEW_DAILY_CAP, OLD_DAILY_CAP);
    report.config = r.changes > 0;
  } catch (e) { /* tabela ausente num banco recém-criado; o seed cuida */ }

  try {
    const r = db.prepare(
      "UPDATE core_system_settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'max_seasonal_emails_per_day' AND value = ?"
    ).run(String(NEW_DAILY_CAP), String(OLD_DAILY_CAP));
    report.setting = r.changes > 0;
  } catch (e) { /* idem */ }

  if (report.config || report.setting) {
    logCore('database', 'daily_cap_migrated',
      `Teto diário de e-mails elevado de ${OLD_DAILY_CAP} para ${NEW_DAILY_CAP} (decisão do operador, com o rodízio de contas).`,
      report);
  }
  return report;
}

/** Remove o schema genérico e as tabelas __v1 já drenadas. */
function dropLegacyAndV1() {
  const dropped = [];

  for (const t of LEGACY_TABLES) {
    if (!tableExists(t)) continue;
    try { db.exec(`DROP TABLE IF EXISTS ${t};`); dropped.push(t); } catch (e) {}
  }

  for (const t of Object.keys(V2_RESHAPED)) {
    const v1 = `${t}__v1`;
    if (!tableExists(v1)) continue;
    try { db.exec(`DROP TABLE IF EXISTS ${v1};`); dropped.push(v1); } catch (e) {}
  }

  return dropped;
}

// ---------------------------------------------------------------------------
// SCHEMA
// ---------------------------------------------------------------------------

function createSchema() {
  db.exec(`
    -- =======================================================================
    -- CORE — infraestrutura, Perfil Mestre e Biblioteca de Currículos
    -- =======================================================================

    CREATE TABLE IF NOT EXISTS core_system_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      category TEXT DEFAULT 'general',
      description TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS core_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      severity TEXT DEFAULT 'info',
      module TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_id TEXT,
      message TEXT NOT NULL,
      metadata_json TEXT,
      correlation_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_core_logs_ts ON core_audit_logs(timestamp DESC);

    -- ATENÇÃO (spec de infraestrutura §1A, §1K): NÃO existe Perfil Mestre nem
    -- Biblioteca de Currículos compartilhada. Cada plataforma é dona do próprio
    -- perfil e dos próprios currículos, com escopo explícito de país. As tabelas
    -- core_master_profile / core_resumes / core_profile_attributes foram removidas
    -- na migração v3 e seus documentos preservados em core_unassigned_documents.

    -- =======================================================================
    -- IDENTIDADE E SESSÃO (spec de autenticação §3, §4, §16, §24)
    --
    -- Identidade compartilhada, contexto de produto isolado: o mesmo usuário do
    -- Google acessa os três produtos, mas cada ambiente tem dados próprios.
    -- =======================================================================

    CREATE TABLE IF NOT EXISTS core_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      email_verified INTEGER DEFAULT 0,
      display_name TEXT DEFAULT '',
      avatar_url TEXT,
      status TEXT DEFAULT 'ACTIVE',          -- ACTIVE | SUSPENDED
      auth_mode TEXT DEFAULT 'google',       -- google | local_operator
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_login_at TEXT
    );

    -- A chave imutável é o "sub" do Google, nunca o e-mail (spec §3).
    CREATE TABLE IF NOT EXISTS core_auth_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,                -- google | local
      subject TEXT NOT NULL,                 -- claim "sub"
      email TEXT,
      email_verified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT,
      UNIQUE(provider, subject),
      FOREIGN KEY (user_id) REFERENCES core_users(id) ON DELETE CASCADE
    );

    -- Sessão da NOSSA aplicação, criada após verificar a identidade do Google.
    -- As colunas product e country carregam o contexto isolado (spec §4, §22).
    CREATE TABLE IF NOT EXISTS core_sessions (
      id TEXT PRIMARY KEY,                   -- token opaco, aleatório
      user_id INTEGER NOT NULL,
      product TEXT,                          -- GUPY | INDEED | SEASONAL | NULL
      country TEXT,                          -- BR | US | NULL
      user_agent TEXT,
      ip_hash TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
      revoked_at TEXT,
      FOREIGN KEY (user_id) REFERENCES core_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON core_sessions(user_id, revoked_at);

    -- Conexão com conta de PROVEDOR — coisa diferente do login na aplicação
    -- (spec §17). Campos de credencial ficam vazios enquanto não existir fluxo
    -- oficial de vinculação (spec §16).
    CREATE TABLE IF NOT EXISTS core_provider_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,                -- GUPY | INDEED | GMAIL
      status TEXT DEFAULT 'NOT_SUPPORTED',   -- NOT_SUPPORTED | AVAILABLE | CONNECTED | REQUIRES_REAUTH | REVOKED | ERROR
      external_account_id TEXT,
      external_account_email TEXT,
      auth_type TEXT,                        -- oauth2 | none
      encrypted_credential TEXT,             -- cifrado; nunca em texto puro
      granted_scopes TEXT,
      connected_at TEXT,
      last_success_at TEXT,
      last_failure_at TEXT,
      revoked_at TEXT,
      metadata_json TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, provider),
      FOREIGN KEY (user_id) REFERENCES core_users(id) ON DELETE CASCADE
    );

    -- Registro dos pacotes de regras conhecidos (spec §55 do spec de produto).
    -- =======================================================================
    -- CONTAS DE ENVIO (F1.3) — várias contas do Gmail em rodízio
    --
    -- Uma conta só, disparando volume constante, é o que o Google estrangula
    -- primeiro. Distribuir entre contas é a defesa — e poder DESATIVAR uma
    -- conta bloqueada sem parar as outras é o que mantém o robô de pé.
    --
    -- Os tokens vivem AQUI, cifrados, e não em arquivo: o backup do sistema
    -- copia o banco e não a pasta de segredos. Com o token em arquivo, restaurar
    -- um backup significava reautorizar todas as contas do zero.
    --
    -- A chave de cifra continua FORA do banco (APP_ENCRYPTION_KEY), como o
    -- secretBox exige: chave e segredo cifrado nunca na mesma tabela.
    -- =======================================================================

    CREATE TABLE IF NOT EXISTS core_gmail_senders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      email TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      tokens_enc TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      is_primary INTEGER DEFAULT 0,
      -- NULL = divide o teto global igualmente entre as contas ativas.
      daily_limit INTEGER,
      rotation_order INTEGER DEFAULT 0,
      last_used_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      error_class TEXT,
      consecutive_failures INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_gmail_senders_rotation
      ON core_gmail_senders(user_id, is_active, rotation_order);

    -- Contagem por conta e por dia. Mesma mecânica da cota global: a checagem
    -- e o incremento acontecem na MESMA instrução SQL, então duas execuções
    -- concorrentes nunca ultrapassam o limite da conta.
    CREATE TABLE IF NOT EXISTS core_gmail_sender_quota (
      date_str TEXT NOT NULL,
      sender_id INTEGER NOT NULL,
      count_sent INTEGER DEFAULT 0,
      max_limit INTEGER NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (date_str, sender_id)
    );

    CREATE TABLE IF NOT EXISTS core_ats_rule_sets (
      id TEXT PRIMARY KEY,
      country TEXT NOT NULL,
      platform TEXT,
      label TEXT,
      base_id TEXT,
      registered_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Saúde das integrações — infraestrutura, não dado de candidato (spec §73).
    CREATE TABLE IF NOT EXISTS core_integration_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,                -- GUPY | INDEED | SEASONAL_DOL | GMAIL
      environment TEXT NOT NULL DEFAULT '',  -- BR | US | '' quando não se aplica
      status TEXT DEFAULT 'NOT_CONFIGURED',
      last_check_at TEXT,
      last_success_at TEXT,
      last_error_at TEXT,
      latency_ms INTEGER,
      error_code TEXT,
      capabilities_json TEXT,
      metadata_json TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(provider, environment)
    );

    -- Documentos herdados da biblioteca compartilhada da v2, aguardando
    -- atribuição EXPLÍCITA a um ambiente (spec §1J: não apagar, não atribuir
    -- silenciosamente, exigir mapeamento pelo usuário).
    CREATE TABLE IF NOT EXISTS core_unassigned_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      legacy_id INTEGER,
      name TEXT NOT NULL,
      original_country TEXT,
      career_track TEXT,
      doc_type TEXT DEFAULT 'resume',
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT,
      file_size INTEGER DEFAULT 0,
      extracted_text TEXT,
      extraction_confidence TEXT,
      assigned_to TEXT,                      -- ex.: "gupy/BR" — preenchido ao atribuir
      assigned_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- =======================================================================
    -- CANDIDATO POR PLATAFORMA E PAÍS  (spec §1B, §1C, §1G)
    --
    -- Cada bloco abaixo é independente. Um currículo da Gupy NUNCA aparece no
    -- Indeed; um currículo BR nunca é usado como fallback nos EUA (§1E).
    -- =======================================================================

    CREATE TABLE IF NOT EXISTS gupy_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      country TEXT NOT NULL,
      full_name TEXT DEFAULT '', email TEXT DEFAULT '', phone TEXT DEFAULT '',
      city TEXT DEFAULT '', state TEXT DEFAULT '',
      headline TEXT DEFAULT '', summary TEXT DEFAULT '',
      years_of_experience REAL,
      availability_from TEXT, availability_to TEXT,
      workplace_preference TEXT DEFAULT 'remote',
      work_authorization TEXT, drivers_license TEXT,
      skills_json TEXT DEFAULT '[]', tools_json TEXT DEFAULT '[]',
      languages_json TEXT DEFAULT '[]', certifications_json TEXT DEFAULT '[]',
      industries_json TEXT DEFAULT '[]', education_json TEXT DEFAULT '[]',
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, country)
    );

    CREATE TABLE IF NOT EXISTS gupy_resumes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      country TEXT NOT NULL,
      name TEXT NOT NULL,
      career_track TEXT NOT NULL DEFAULT 'geral',
      doc_type TEXT NOT NULL DEFAULT 'resume',
      filename TEXT NOT NULL, original_name TEXT NOT NULL,
      file_path TEXT NOT NULL, storage_key TEXT,
      mime_type TEXT, file_size INTEGER DEFAULT 0, sha256 TEXT,
      extracted_text TEXT, extraction_confidence TEXT, ats_health INTEGER,
      is_default INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, archived INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_gupy_resume_scope ON gupy_resumes(user_id, country, career_track, is_active);

    CREATE TABLE IF NOT EXISTS gupy_resume_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resume_id INTEGER NOT NULL, rule_set_version TEXT NOT NULL, platform TEXT,
      score INTEGER, status TEXT,
      components_json TEXT, weights_json TEXT, signals_json TEXT, issues_json TEXT,
      analyzed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(resume_id, rule_set_version),
      FOREIGN KEY (resume_id) REFERENCES gupy_resumes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS indeed_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      country TEXT NOT NULL,
      full_name TEXT DEFAULT '', email TEXT DEFAULT '', phone TEXT DEFAULT '',
      city TEXT DEFAULT '', state TEXT DEFAULT '',
      headline TEXT DEFAULT '', summary TEXT DEFAULT '',
      years_of_experience REAL,
      availability_from TEXT, availability_to TEXT,
      workplace_preference TEXT DEFAULT 'remote',
      work_authorization TEXT, drivers_license TEXT,
      skills_json TEXT DEFAULT '[]', tools_json TEXT DEFAULT '[]',
      languages_json TEXT DEFAULT '[]', certifications_json TEXT DEFAULT '[]',
      industries_json TEXT DEFAULT '[]', education_json TEXT DEFAULT '[]',
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, country)
    );

    CREATE TABLE IF NOT EXISTS indeed_resumes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      country TEXT NOT NULL,
      name TEXT NOT NULL,
      career_track TEXT NOT NULL DEFAULT 'geral',
      doc_type TEXT NOT NULL DEFAULT 'resume',
      filename TEXT NOT NULL, original_name TEXT NOT NULL,
      file_path TEXT NOT NULL, storage_key TEXT,
      mime_type TEXT, file_size INTEGER DEFAULT 0, sha256 TEXT,
      extracted_text TEXT, extraction_confidence TEXT, ats_health INTEGER,
      is_default INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, archived INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_indeed_resume_scope ON indeed_resumes(user_id, country, career_track, is_active);

    CREATE TABLE IF NOT EXISTS indeed_resume_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resume_id INTEGER NOT NULL, rule_set_version TEXT NOT NULL, platform TEXT,
      score INTEGER, status TEXT,
      components_json TEXT, weights_json TEXT, signals_json TEXT, issues_json TEXT,
      analyzed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(resume_id, rule_set_version),
      FOREIGN KEY (resume_id) REFERENCES indeed_resumes(id) ON DELETE CASCADE
    );

    -- Seasonal é US-only: a coluna de país existe para uniformidade do código,
    -- mas é sempre 'US' e não é configurável (spec §4.3 do spec de produto).
    CREATE TABLE IF NOT EXISTS seasonal_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      country TEXT NOT NULL DEFAULT 'US',
      full_name TEXT DEFAULT '', email TEXT DEFAULT '', phone TEXT DEFAULT '',
      city TEXT DEFAULT '', state TEXT DEFAULT '',
      headline TEXT DEFAULT '', summary TEXT DEFAULT '',
      years_of_experience REAL,
      availability_from TEXT, availability_to TEXT,
      workplace_preference TEXT DEFAULT 'onsite',
      work_authorization TEXT, drivers_license TEXT,
      skills_json TEXT DEFAULT '[]', tools_json TEXT DEFAULT '[]',
      languages_json TEXT DEFAULT '[]', certifications_json TEXT DEFAULT '[]',
      industries_json TEXT DEFAULT '[]', education_json TEXT DEFAULT '[]',
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, country)
    );

    CREATE TABLE IF NOT EXISTS seasonal_resumes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      country TEXT NOT NULL DEFAULT 'US',
      name TEXT NOT NULL,
      career_track TEXT NOT NULL DEFAULT 'geral',
      doc_type TEXT NOT NULL DEFAULT 'resume',  -- resume | recommendation_letter | other
      filename TEXT NOT NULL, original_name TEXT NOT NULL,
      file_path TEXT NOT NULL, storage_key TEXT,
      mime_type TEXT, file_size INTEGER DEFAULT 0, sha256 TEXT,
      extracted_text TEXT, extraction_confidence TEXT, ats_health INTEGER,
      is_default INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, archived INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_seasonal_resume_scope ON seasonal_resumes(user_id, career_track, doc_type, is_active);

    CREATE TABLE IF NOT EXISTS seasonal_resume_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resume_id INTEGER NOT NULL, rule_set_version TEXT NOT NULL, platform TEXT,
      score INTEGER, status TEXT,
      components_json TEXT, weights_json TEXT, signals_json TEXT, issues_json TEXT,
      analyzed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(resume_id, rule_set_version),
      FOREIGN KEY (resume_id) REFERENCES seasonal_resumes(id) ON DELETE CASCADE
    );

    -- =======================================================================
    -- GUPY  (BR | US)  — spec §4.1, §26
    -- =======================================================================

    CREATE TABLE IF NOT EXISTS gupy_country_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      country TEXT UNIQUE NOT NULL,
      target_role TEXT DEFAULT '',
      career_track TEXT DEFAULT 'geral',
      default_resume_id INTEGER,
      min_salary_month REAL,
      min_salary_year REAL,
      workplace_preference TEXT DEFAULT 'remote',
      fit_threshold INTEGER DEFAULT 70,
      ats_threshold INTEGER DEFAULT 70,
      top_priority_threshold INTEGER DEFAULT 90,
      strong_match_threshold INTEGER DEFAULT 80,
      possible_match_threshold INTEGER DEFAULT 70,
      onboarding_step INTEGER DEFAULT 0,
      onboarding_done INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS gupy_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      country TEXT NOT NULL DEFAULT 'BR',
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      normalized_title TEXT,
      company TEXT NOT NULL,
      location TEXT,
      workplace_type TEXT DEFAULT 'remote',
      job_type TEXT,
      salary_month REAL,
      salary_min REAL,
      salary_max REAL,
      salary_currency TEXT,
      salary_period TEXT,
      salary_source TEXT DEFAULT 'employer',
      apply_url TEXT NOT NULL,
      career_page_url TEXT,
      published_date TEXT,
      description TEXT,
      requirements TEXT,
      category TEXT,
      content_hash TEXT,
      raw_json TEXT,
      collected_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(country, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gupy_country ON gupy_jobs(country);

    CREATE TABLE IF NOT EXISTS gupy_job_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER UNIQUE NOT NULL,
      requirements_json TEXT,
      concerns_json TEXT,
      analysis_version TEXT,
      content_hash TEXT,
      analyzed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES gupy_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gupy_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER UNIQUE NOT NULL,
      fit_score INTEGER, fit_version TEXT, fit_components_json TEXT, fit_weights_json TEXT,
      fit_evidence_json TEXT, fit_confidence TEXT,
      ats_score INTEGER, ats_version TEXT, ats_components_json TEXT, ats_status TEXT,
      opportunity_score INTEGER, opportunity_version TEXT, opportunity_components_json TEXT,
      category TEXT,
      warnings_json TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES gupy_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gupy_saved_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER UNIQUE NOT NULL, notes TEXT,
      saved_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES gupy_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gupy_discarded_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER UNIQUE NOT NULL, reason TEXT,
      discarded_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES gupy_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gupy_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      country TEXT NOT NULL DEFAULT 'BR',
      params_json TEXT,
      duration_ms INTEGER,
      results_found INTEGER DEFAULT 0,
      new_results INTEGER DEFAULT 0,
      duplicates INTEGER DEFAULT 0,
      filtered_out INTEGER DEFAULT 0,
      analyzed INTEGER DEFAULT 0,
      recommended INTEGER DEFAULT 0,
      errors_json TEXT,
      executed_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS gupy_integration_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      country TEXT UNIQUE NOT NULL DEFAULT 'BR',
      mcp_url TEXT DEFAULT '',
      mcp_token_ref TEXT DEFAULT '',
      is_connected INTEGER DEFAULT 0,
      auth_status TEXT DEFAULT 'UNKNOWN',
      health_status TEXT DEFAULT 'DISCONNECTED',
      tools_json TEXT,
      last_success_at TEXT,
      last_failure_at TEXT,
      last_search_at TEXT,
      last_error TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS gupy_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      country TEXT,
      level TEXT DEFAULT 'info',
      action TEXT NOT NULL,
      message TEXT NOT NULL,
      entity_id TEXT,
      correlation_id TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gupy_logs ON gupy_logs(timestamp DESC);

    -- =======================================================================
    -- INDEED  (BR | US)  — spec §4.2, §27
    -- =======================================================================

    CREATE TABLE IF NOT EXISTS indeed_country_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      country TEXT UNIQUE NOT NULL,
      target_role TEXT DEFAULT '',
      career_track TEXT DEFAULT 'geral',
      default_resume_id INTEGER,
      min_salary_month REAL,
      min_salary_year REAL,
      workplace_preference TEXT DEFAULT 'remote',
      fit_threshold INTEGER DEFAULT 70,
      ats_threshold INTEGER DEFAULT 70,
      top_priority_threshold INTEGER DEFAULT 90,
      strong_match_threshold INTEGER DEFAULT 80,
      possible_match_threshold INTEGER DEFAULT 70,
      onboarding_step INTEGER DEFAULT 0,
      onboarding_done INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS indeed_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      country TEXT NOT NULL DEFAULT 'US',
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      normalized_title TEXT,
      company TEXT NOT NULL,
      location_city TEXT,
      location_state TEXT,
      is_remote INTEGER DEFAULT 0,
      salary_month REAL,
      salary_min REAL,
      salary_max REAL,
      salary_currency TEXT DEFAULT 'USD',
      salary_period TEXT DEFAULT 'year',
      salary_source TEXT DEFAULT 'employer',
      job_url TEXT NOT NULL,
      published_date TEXT,
      description TEXT,
      requirements TEXT,
      category TEXT,
      visa_sponsorship INTEGER DEFAULT 0,
      content_hash TEXT,
      raw_json TEXT,
      collected_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(country, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_indeed_country ON indeed_jobs(country);

    CREATE TABLE IF NOT EXISTS indeed_job_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER UNIQUE NOT NULL,
      requirements_json TEXT, concerns_json TEXT,
      analysis_version TEXT, content_hash TEXT,
      analyzed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES indeed_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS indeed_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER UNIQUE NOT NULL,
      fit_score INTEGER, fit_version TEXT, fit_components_json TEXT, fit_weights_json TEXT,
      fit_evidence_json TEXT, fit_confidence TEXT,
      ats_score INTEGER, ats_version TEXT, ats_components_json TEXT, ats_status TEXT,
      opportunity_score INTEGER, opportunity_version TEXT, opportunity_components_json TEXT,
      category TEXT, warnings_json TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES indeed_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS indeed_saved_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER UNIQUE NOT NULL, notes TEXT,
      saved_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES indeed_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS indeed_discarded_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER UNIQUE NOT NULL, reason TEXT,
      discarded_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES indeed_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS indeed_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      country TEXT NOT NULL DEFAULT 'US',
      params_json TEXT, duration_ms INTEGER,
      results_found INTEGER DEFAULT 0, new_results INTEGER DEFAULT 0,
      duplicates INTEGER DEFAULT 0, filtered_out INTEGER DEFAULT 0,
      analyzed INTEGER DEFAULT 0, recommended INTEGER DEFAULT 0,
      errors_json TEXT, executed_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS indeed_integration_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      country TEXT UNIQUE NOT NULL DEFAULT 'US',
      mcp_url TEXT DEFAULT '', mcp_token_ref TEXT DEFAULT '',
      is_connected INTEGER DEFAULT 0,
      auth_status TEXT DEFAULT 'UNKNOWN',
      health_status TEXT DEFAULT 'DISCONNECTED',
      tools_json TEXT,
      last_success_at TEXT, last_failure_at TEXT, last_search_at TEXT, last_error TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS indeed_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      country TEXT, level TEXT DEFAULT 'info',
      action TEXT NOT NULL, message TEXT NOT NULL,
      entity_id TEXT, correlation_id TEXT, metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_indeed_logs ON indeed_logs(timestamp DESC);

    -- =======================================================================
    -- SEASONAL JOBS  (somente US)  — spec §4.3, §28
    -- =======================================================================

    CREATE TABLE IF NOT EXISTS seasonal_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      -- perfil sazonal
      h2a_preference INTEGER DEFAULT 1,
      h2b_preference INTEGER DEFAULT 1,
      preferred_states TEXT DEFAULT '',
      preferred_occupations TEXT DEFAULT '',
      excluded_occupations TEXT DEFAULT '',
      min_hourly_wage REAL DEFAULT 0,
      available_from TEXT, available_to TEXT,
      desired_weekly_hours INTEGER,
      housing_required INTEGER DEFAULT 1,
      transportation_required INTEGER DEFAULT 0,
      english_level TEXT DEFAULT '',
      physical_labor_ready INTEGER DEFAULT 1,
      pref_hospitality INTEGER DEFAULT 0,
      pref_agriculture INTEGER DEFAULT 0,
      pref_construction INTEGER DEFAULT 0,
      pref_maintenance INTEGER DEFAULT 0,
      pref_driving INTEGER DEFAULT 0,
      -- automação (spec §29, §30, §31)
      automation_mode TEXT DEFAULT 'MANUAL',            -- MANUAL | ASSISTED | AUTOMATIC
      email_review_mode TEXT DEFAULT 'ALWAYS_REVIEW',   -- ALWAYS_REVIEW | REVIEW_FLAGGED | FULLY_AUTOMATIC
      auto_queue_fit_threshold INTEGER DEFAULT 85,
      auto_queue_ats_threshold INTEGER DEFAULT 75,
      auto_queue_opportunity_threshold INTEGER DEFAULT 85,
      -- prioridade 2027 (spec §33)
      target_hiring_year INTEGER DEFAULT 2027,
      queue_weights_json TEXT,
      -- envio
      pause_email_sending INTEGER DEFAULT 0,
      daily_email_limit INTEGER DEFAULT 300,
      gmail_user TEXT DEFAULT '',
      gmail_connected INTEGER DEFAULT 0,
      gmail_auth_status TEXT DEFAULT 'DISCONNECTED',
      -- integração
      dol_feed_url TEXT DEFAULT '',
      auto_sync_enabled INTEGER DEFAULT 0,
      health_status TEXT DEFAULT 'DISCONNECTED',
      last_success_at TEXT, last_failure_at TEXT, last_error TEXT,
      onboarding_step INTEGER DEFAULT 0,
      onboarding_done INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS seasonal_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_order_id TEXT UNIQUE NOT NULL,
      visa_type TEXT NOT NULL,
      job_title TEXT NOT NULL,
      normalized_title TEXT,
      soc_code TEXT,
      employer_name TEXT NOT NULL,
      employer_city TEXT, employer_state TEXT,
      employer_phone TEXT, employer_email TEXT,
      attorney_name TEXT, attorney_email TEXT,
      wage_rate REAL, wage_unit TEXT DEFAULT 'Hour',
      start_date TEXT, end_date TEXT,
      openings INTEGER DEFAULT 1,
      weekly_hours INTEGER,
      housing_provided INTEGER DEFAULT 0,
      transportation_provided INTEGER DEFAULT 0,
      duties_description TEXT,
      special_requirements TEXT,
      career_track TEXT,
      application_method TEXT DEFAULT 'UNKNOWN',   -- EMAIL | PHONE | WEBSITE | OTHER | UNKNOWN
      application_email TEXT,
      application_url TEXT,
      -- linha do tempo (spec §33)
      timeline_class TEXT, timeline_priority TEXT, timeline_weight INTEGER,
      timeline_label TEXT, timeline_explanation TEXT, timeline_period TEXT,
      content_hash TEXT,
      raw_json TEXT,
      collected_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_seasonal_timeline ON seasonal_jobs(timeline_priority, timeline_weight DESC);

    CREATE TABLE IF NOT EXISTS seasonal_job_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER UNIQUE NOT NULL,
      requirements_json TEXT, concerns_json TEXT,
      analysis_version TEXT, content_hash TEXT,
      analyzed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES seasonal_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS seasonal_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER UNIQUE NOT NULL,
      fit_score INTEGER, fit_version TEXT, fit_components_json TEXT, fit_weights_json TEXT,
      fit_evidence_json TEXT, fit_confidence TEXT,
      ats_score INTEGER, ats_version TEXT, ats_components_json TEXT, ats_status TEXT,
      opportunity_score INTEGER, opportunity_version TEXT, opportunity_components_json TEXT,
      queue_priority REAL, queue_breakdown_json TEXT,
      category TEXT, warnings_json TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES seasonal_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS seasonal_saved_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER UNIQUE NOT NULL, notes TEXT,
      saved_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES seasonal_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS seasonal_discarded_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER UNIQUE NOT NULL, reason TEXT,
      discarded_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES seasonal_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS seasonal_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      params_json TEXT, duration_ms INTEGER,
      results_found INTEGER DEFAULT 0, new_results INTEGER DEFAULT 0,
      duplicates INTEGER DEFAULT 0, filtered_out INTEGER DEFAULT 0,
      analyzed INTEGER DEFAULT 0, recommended INTEGER DEFAULT 0,
      errors_json TEXT, executed_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS seasonal_application_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER UNIQUE NOT NULL,
      selected_resume_id INTEGER,
      selected_resume_reason TEXT,
      selected_doc_ids_json TEXT,
      recipient_email TEXT NOT NULL,
      recipient_kind TEXT,
      email_subject TEXT NOT NULL,
      email_body TEXT NOT NULL,
      cover_letter TEXT NOT NULL,
      attachments_json TEXT,
      validation_status TEXT DEFAULT 'PENDING',   -- PASSED | FAILED | PENDING
      validation_json TEXT,
      requires_review INTEGER DEFAULT 1,
      review_reasons_json TEXT,
      approved_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES seasonal_jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS seasonal_email_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id INTEGER UNIQUE NOT NULL,
      job_id INTEGER NOT NULL,
      recipient_email TEXT NOT NULL,
      email_subject TEXT NOT NULL,
      email_body TEXT NOT NULL,
      attachments_json TEXT,
      status TEXT DEFAULT 'QUEUED',
      queue_priority REAL DEFAULT 0,
      attempts INTEGER DEFAULT 0,
      error_class TEXT,
      last_error TEXT,
      next_attempt_at TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (package_id) REFERENCES seasonal_application_packages(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES seasonal_jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_queue_status ON seasonal_email_queue(status, queue_priority DESC);

    CREATE TABLE IF NOT EXISTS seasonal_email_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id INTEGER,
      job_id INTEGER,
      event TEXT NOT NULL,
      detail TEXT,
      metadata_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS seasonal_daily_quota (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date_str TEXT UNIQUE NOT NULL,
      count_sent INTEGER DEFAULT 0,
      max_limit INTEGER DEFAULT 50,
      timezone TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS seasonal_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL DEFAULT 1,
      seasonal_job_id INTEGER NOT NULL,
      job_order_id TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      employer_name TEXT NOT NULL,
      subject TEXT NOT NULL,
      content_sent TEXT,
      attachments_json TEXT,
      sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
      status TEXT DEFAULT 'SENT',
      UNIQUE(candidate_id, seasonal_job_id, recipient_email)
    );

    -- Modelos de assunto/corpo do e-mail (F1.1). Cada envio usa o modelo
    -- MENOS usado até então, para que os e-mails não saiam idênticos em massa.
    CREATE TABLE IF NOT EXISTS seasonal_email_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,                 -- subject | body
      visa_type TEXT DEFAULT 'ANY',       -- ANY | H-2A | H-2B
      content TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      use_count INTEGER DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Preferências do front H2B (tema, modo de tela, onboarding, tour...).
    -- Chave/valor simples: mesmo papel do localStorage do sistema de
    -- referência, só que persistido no servidor para sobreviver à troca de aparelho.
    CREATE TABLE IF NOT EXISTS seasonal_ui_prefs (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Notificações internas do front H2B (F4.2): eventos que o usuário vê no sino.
    CREATE TABLE IF NOT EXISTS seasonal_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      link TEXT,
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS seasonal_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      level TEXT DEFAULT 'info',
      action TEXT NOT NULL, message TEXT NOT NULL,
      entity_id TEXT, correlation_id TEXT, metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_seasonal_logs ON seasonal_logs(timestamp DESC);

    -- =======================================================================
    -- v5 — AGENTES E ROBÔS AUTÔNOMOS
    -- (spec de agentes §27, §41, §49, §50, §51, §52, §58, §72)
    -- =======================================================================

    -- §27 — Perfil de motorista do Seasonal. Vive separado de seasonal_profiles
    -- porque é um vocabulário próprio do produto, e porque o valor ausente aqui
    -- significa UNKNOWN (§18), não string vazia.
    CREATE TABLE IF NOT EXISTS seasonal_driver_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      truck_driving_experience REAL,          -- anos
      tractor_trailer_experience REAL,        -- anos
      manual_transmission_experience TEXT,    -- YES | NO | UNKNOWN
      cdl_status TEXT,                        -- HELD | NOT_HELD | EXPIRED | UNKNOWN
      cdl_class TEXT,                         -- A | B | C | UNKNOWN
      cdl_endorsements TEXT,                  -- "H,N,T" | UNKNOWN
      can_obtain_cdl INTEGER,                 -- 1 | 0 | NULL(UNKNOWN)
      driving_record TEXT,                    -- CLEAN | VIOLATIONS | UNKNOWN
      english_level TEXT,                     -- NONE|BASIC|INTERMEDIATE|ADVANCED|NATIVE|UNKNOWN
      long_distance_experience TEXT,
      agricultural_hauling_experience TEXT,
      equipment_experience TEXT,
      lifting_capacity TEXT,
      availability_start TEXT, availability_end TEXT,
      accepted_states TEXT DEFAULT '',
      h2a_interest INTEGER DEFAULT 1,
      h2b_interest INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id)
    );

    -- §41, §42, §57 — ações que o sistema PREPARA mas não executa.
    CREATE TABLE IF NOT EXISTS seasonal_manual_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      kind TEXT NOT NULL,                     -- WHATSAPP_MESSAGE | PHONE_CALL | OPEN_WEBSITE
      channel_value TEXT,
      message TEXT,
      deep_link TEXT,
      status TEXT DEFAULT 'PENDING',          -- PENDING | DONE | DISMISSED
      instruction TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      UNIQUE(job_id, kind),
      FOREIGN KEY (job_id) REFERENCES seasonal_jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_manual_actions ON seasonal_manual_actions(status, created_at DESC);

    -- §50, §72 — trilha de auditoria de cada passo autônomo, da descoberta ao
    -- estado final. É o que permite responder "por que este e-mail saiu?".
    CREATE TABLE IF NOT EXISTS core_agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correlation_id TEXT,
      product TEXT NOT NULL,                  -- gupy | indeed | seasonal
      agent TEXT NOT NULL,
      job_id INTEGER,
      entity_ref TEXT,
      state_from TEXT, state_to TEXT,
      outcome TEXT,                           -- PASS | FAIL | SKIP | BLOCK
      summary TEXT,
      detail_json TEXT,
      duration_ms INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs ON core_agent_runs(product, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_job ON core_agent_runs(job_id, created_at DESC);

    -- §49 — o despertador. Cada tarefa periódica tem uma linha e um histórico.
    CREATE TABLE IF NOT EXISTS core_scheduler_jobs (
      id TEXT PRIMARY KEY,                    -- seasonal_import | seasonal_dispatch | ...
      label TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      enabled INTEGER DEFAULT 0,
      last_run_at TEXT, last_status TEXT, last_message TEXT,
      last_duration_ms INTEGER,
      next_run_at TEXT,
      consecutive_failures INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS core_scheduler_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      status TEXT,                            -- OK | FAILED | SKIPPED
      message TEXT,
      metrics_json TEXT,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_scheduler_runs ON core_scheduler_runs(job_id, started_at DESC);

    -- §58 — controle de custo de IA. Registra o papel, não o conteúdo.
    CREATE TABLE IF NOT EXISTS core_ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      provider TEXT, model TEXT,
      prompt_chars INTEGER DEFAULT 0,
      completion_chars INTEGER DEFAULT 0,
      ok INTEGER DEFAULT 1,
      error TEXT,
      duration_ms INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ai_usage ON core_ai_usage(created_at DESC);

    -- Portfólio público do motorista (funcionalidade fora do spec, preservada)
    CREATE TABLE IF NOT EXISTS seasonal_portfolio (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT DEFAULT '', headline TEXT DEFAULT '', tagline TEXT DEFAULT '',
      bio_english TEXT DEFAULT '', years_driving INTEGER DEFAULT 0, years_farming INTEGER DEFAULT 0,
      cdl_info TEXT DEFAULT '', equipment_list TEXT DEFAULT '',
      photo_profile_url TEXT DEFAULT '', photo_truck_url TEXT DEFAULT '', photo_farm_url TEXT DEFAULT '',
      why_hire_me TEXT DEFAULT '', phone TEXT DEFAULT '', whatsapp TEXT DEFAULT '',
      email TEXT DEFAULT '', public_slug TEXT DEFAULT 'motorista', is_public INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// ---------------------------------------------------------------------------
// SEEDS
// ---------------------------------------------------------------------------

function seedDefaults() {
  const settings = [
    ['application_timezone', 'America/Sao_Paulo', 'general', 'Fuso horário usado para a virada da cota diária'],
    ['max_seasonal_emails_per_day', '0', 'safety', 'Trava absoluta de e-mails de candidatura por dia (0 = automático: 300 × contas Gmail ativas)'],
    ['global_pause_all_automations', '0', 'safety', 'Pausa geral de todas as automações'],
    ['ai_provider', 'none', 'ai', 'Provedor de IA configurado (none = heurística determinística)'],
    ['ai_api_key_ref', '', 'ai', 'Referência à variável de ambiente com a chave (nunca a chave em si)'],
    ['llm_model', '', 'ai', 'Modelo LLM, quando um provedor estiver configurado'],
    ['schema_notes', 'Isolamento por prefixo: core_ / gupy_ / indeed_ / seasonal_', 'general', 'Nota de arquitetura'],
    // Agentes autônomos (spec de agentes §49, §63)
    ['scheduler_enabled', '0', 'automation', 'Liga o agendador que faz os robôs trabalharem sem o usuário'],
    ['scheduler_tick_seconds', '60', 'automation', 'Intervalo com que o agendador verifica o que está vencido'],
    ['agent_audit_retention_days', '90', 'automation', 'Dias de retenção da trilha de auditoria dos agentes']
  ];
  const ins = db.prepare('INSERT OR IGNORE INTO core_system_settings (key, value, category, description) VALUES (?,?,?,?)');
  for (const s of settings) ins.run(s[0], s[1], s[2], s[3]);

  // Um perfil vazio por ambiente. Cada plataforma/país nasce independente e
  // sem dados fictícios — o usuário preenche cada um separadamente (spec §1B).
  const uid = ensureBootstrapUser();
  const gp = db.prepare('INSERT OR IGNORE INTO gupy_profiles (user_id, country) VALUES (?,?)');
  gp.run(uid,'BR'); gp.run(uid,'US');
  const ip = db.prepare('INSERT OR IGNORE INTO indeed_profiles (user_id, country) VALUES (?,?)');
  ip.run(uid,'BR'); ip.run(uid,'US');
  db.prepare('INSERT OR IGNORE INTO seasonal_profiles (user_id, country) VALUES (?,?)').run(uid,'US');

  // Configuração por país
  const gc = db.prepare('INSERT OR IGNORE INTO gupy_country_config (country) VALUES (?)');
  gc.run('BR'); gc.run('US');
  const ic = db.prepare('INSERT OR IGNORE INTO indeed_country_config (country) VALUES (?)');
  ic.run('BR'); ic.run('US');

  const gi = db.prepare('INSERT OR IGNORE INTO gupy_integration_config (country) VALUES (?)');
  gi.run('BR'); gi.run('US');
  const ii = db.prepare('INSERT OR IGNORE INTO indeed_integration_config (country) VALUES (?)');
  ii.run('BR'); ii.run('US');

  const sc = db.prepare('SELECT COUNT(*) c FROM seasonal_config').get();
  if (!sc || sc.c === 0) db.prepare('INSERT INTO seasonal_config DEFAULT VALUES').run();

  const sp = db.prepare('SELECT COUNT(*) c FROM seasonal_portfolio').get();
  if (!sp || sp.c === 0) db.prepare('INSERT INTO seasonal_portfolio DEFAULT VALUES').run();

  // Registro dos pacotes de regras ATS conhecidos (§55)
  try {
    const { BASES, EXTENSIONS } = require('../core/ats/rules');
    const rs = db.prepare(`INSERT OR IGNORE INTO core_ats_rule_sets (id, country, platform, label, base_id) VALUES (?,?,?,?,?)`);
    for (const k of Object.keys(BASES)) {
      const b = BASES[k];
      rs.run(b.id, b.country, null, b.label, null);
    }
    for (const k of Object.keys(EXTENSIONS)) {
      const e = EXTENSIONS[k];
      rs.run(e.id, e.country, e.platform, e.label, e.extends);
    }
  } catch (err) { /* pacotes carregam depois; não bloqueia o boot */ }
}

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------

function safeMeta(metadata) {
  if (!metadata) return null;
  // Nunca registra segredos (spec §74).
  const REDACT = /token|secret|password|senha|api[_-]?key|authorization|refresh|access[_-]?token/i;
  const clean = {};
  for (const k of Object.keys(metadata)) {
    clean[k] = REDACT.test(k) ? '[REDACTED]' : metadata[k];
  }
  try { return JSON.stringify(clean); } catch (e) { return null; }
}

function makeLogger(table, hasCountry) {
  return function (action, message, metadata = null, level = 'info', extra = {}) {
    try {
      if (hasCountry) {
        db.prepare(`INSERT INTO ${table} (country, level, action, message, entity_id, correlation_id, metadata_json)
                    VALUES (?,?,?,?,?,?,?)`)
          .run(extra.country || null, level, action, message, extra.entityId || null, extra.correlationId || null, safeMeta(metadata));
      } else {
        db.prepare(`INSERT INTO ${table} (level, action, message, entity_id, correlation_id, metadata_json)
                    VALUES (?,?,?,?,?,?)`)
          .run(level, action, message, extra.entityId || null, extra.correlationId || null, safeMeta(metadata));
      }
    } catch (e) {
      console.error(`[log:${table}]`, e.message);
    }
  };
}

const logGupy = makeLogger('gupy_logs', true);
const logIndeed = makeLogger('indeed_logs', true);
const logSeasonal = makeLogger('seasonal_logs', false);

function logCore(module, action, message, metadata = null, entityId = null, severity = 'info', correlationId = null) {
  try {
    db.prepare(`INSERT INTO core_audit_logs (severity, module, action, entity_id, message, metadata_json, correlation_id)
                VALUES (?,?,?,?,?,?,?)`)
      .run(severity, module, action, entityId, message, safeMeta(metadata), correlationId);
  } catch (e) {
    console.error('[log:core]', e.message);
  }
}

// ---------------------------------------------------------------------------
// BOOT
// ---------------------------------------------------------------------------

function initDatabase() {
  const from = getSchemaVersion();
  const result = { from, to: SCHEMA_VERSION, renamed: [], backfill: null, dropped: [] };

  // FKs desligadas durante a migração estrutural; religadas ao final.
  try { db.exec('PRAGMA foreign_keys = OFF;'); } catch (e) {}

  if (from < 2) {
    result.renamed = prepareV2Tables();
  }

  createSchema();

  if (from < 2) {
    result.backfill = backfillFromV1();
    result.dropped = dropLegacyAndV1();
  }

  // v3 — fim do Perfil Mestre e da Biblioteca compartilhada (spec §1A, §1J).
  if (from < 3) {
    result.sharedModel = migrateSharedCandidateModel();
  }

  // v4 — identidade e autorização por usuário (spec de autenticação §23, §24).
  if (from < 4) {
    const renamed = prepareV4Tables();
    createSchema();                                  // recria com user_id
    const userId = ensureBootstrapUser();
    result.identity = Object.assign({ renamed, userId }, backfillFromV3(userId));
  } else {
    ensureBootstrapUser();
  }

  // Colunas acrescentadas depois da v2 entram aqui, sem DROP.
  addColumnIfMissing('seasonal_jobs', 'weekly_hours', 'INTEGER');
  addColumnIfMissing('core_resumes', 'archived', 'INTEGER DEFAULT 0');

  // `indeed_jobs` foi criada por uma versão anterior sem estas colunas, e
  // `CREATE TABLE IF NOT EXISTS` não altera tabela existente. O upsert do
  // produto grava as quatro — sem elas, TODA importação do Indeed falhava
  // vaga a vaga, com o erro engolido pelo coletor de erros do pipeline.
  addColumnIfMissing('indeed_jobs', 'salary_month', 'REAL');
  addColumnIfMissing('indeed_jobs', 'salary_source', "TEXT DEFAULT 'employer'");
  addColumnIfMissing('indeed_jobs', 'published_date', 'TEXT');
  addColumnIfMissing('indeed_jobs', 'content_hash', 'TEXT');

  result.indeedUnique = fixIndeedUniqueConstraint();
  result.danglingFks = repairDanglingIndeedFks();

  // --- Procedência da ordem de serviço no feed do DOL (F4.3) ----------------
  //
  // O feed é uma janela móvel de 20 dias: a ordem aparece, permanece algumas
  // publicações e sai. Sem estas colunas não se sabe de que safra a vaga é nem
  // se ela continua publicada — e o `dolAdapter` já documentava que a
  // persistência histórica é obrigatória.
  //
  //   first_seen_feed    data da publicação em que a ordem apareceu pela 1ª vez
  //   last_seen_feed     data da publicação mais recente em que ela ainda estava
  //   feed_appearances   em quantas publicações ela já apareceu
  //   feed_key           qual dos três feeds a trouxe (jo | h2a | h2b)
  addColumnIfMissing('seasonal_jobs', 'first_seen_feed', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'last_seen_feed', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'feed_appearances', 'INTEGER DEFAULT 0');
  addColumnIfMissing('seasonal_jobs', 'feed_key', 'TEXT');
  // Link público no site do DOL e se a página já existe (F4.7).
  addColumnIfMissing('seasonal_jobs', 'dol_url', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'dol_published', 'INTEGER DEFAULT 0');
  // Estado do caso no índice do DOL: ativa (recrutamento aberto), status
  // textual, data do aceite, até quando fica ativa, última verificação.
  addColumnIfMissing('seasonal_jobs', 'dol_active', 'INTEGER');
  addColumnIfMissing('seasonal_jobs', 'dol_status', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'dol_accepted_at', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'dol_active_until', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'dol_checked_at', 'TEXT');
  // Um e-mail por destinatário a cada N dias (0 = desligado).
  addColumnIfMissing('seasonal_config', 'recipient_cooldown_days', 'INTEGER DEFAULT 30');
  // O histórico de envios carrega a própria cópia de título/visto/estado da
  // vaga: continua legível e exportável mesmo que a vaga mude ou suma.
  addColumnIfMissing('seasonal_applications', 'job_title', 'TEXT');
  addColumnIfMissing('seasonal_applications', 'visa_type', 'TEXT');
  addColumnIfMissing('seasonal_applications', 'employer_state', 'TEXT');
  try {
    db.exec(`UPDATE seasonal_applications SET
               job_title = (SELECT j.job_title FROM seasonal_jobs j WHERE j.id = seasonal_applications.seasonal_job_id),
               visa_type = (SELECT j.visa_type FROM seasonal_jobs j WHERE j.id = seasonal_applications.seasonal_job_id),
               employer_state = (SELECT j.employer_state FROM seasonal_jobs j WHERE j.id = seasonal_applications.seasonal_job_id)
             WHERE job_title IS NULL;`);
  } catch (e) { /* preenchimento é conveniência */ }
  result.dailyLimitAuto = migrateDailyLimitAuto();
  result.disclosureBase = migrateDisclosureBase();
  result.dolLinks = migrateDolLinks();
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_seasonal_feed_window
             ON seasonal_jobs(last_seen_feed DESC, first_seen_feed);`);
  } catch (e) { /* índice é otimização, não requisito */ }

  // --- Documento por tipo de visto (F1.2) -----------------------------------
  //
  // H-2A é agricultura; H-2B não é. São conversas diferentes, com empregadores
  // diferentes, e o acervo atual já tem as duas convivendo. Um documento pode
  // declarar-se de um tipo específico ou servir aos dois (ANY).
  //
  // O padrão é ANY para não invalidar documento já cadastrado: quem não escolheu
  // continua servindo a tudo, exatamente como antes.
  addColumnIfMissing('seasonal_resumes', 'visa_type', "TEXT DEFAULT 'ANY'");

  result.dailyCap = migrateDailyEmailCap();
  result.jobFocus = migrateJobFocus();

  // v5 — classificação de motorista, CDL e canais na própria vaga, para que a
  // ordenação e os filtros aconteçam em SQL (spec de agentes §25, §28, §31, §44).
  addColumnIfMissing('seasonal_jobs', 'truck_classification', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'truck_confidence', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'truck_soc_matched', 'INTEGER DEFAULT 0');
  addColumnIfMissing('seasonal_jobs', 'truck_reasons_json', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'truck_gate_version', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'cdl_requirement', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'cdl_class_required', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'cdl_evidence', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'driver_requirements_json', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'channels_json', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'application_state', "TEXT DEFAULT 'DISCOVERED'");
  addColumnIfMissing('seasonal_jobs', 'decision', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'decision_reasons_json', 'TEXT');
  addColumnIfMissing('seasonal_jobs', 'employer_supports_whatsapp', 'INTEGER DEFAULT 0');

  // Chaves de automação do produto Seasonal (§16, §25, §32, §49).
  addColumnIfMissing('seasonal_config', 'truck_gate_enabled', 'INTEGER DEFAULT 1');
  // Foco das candidaturas: 1 = só motorista de caminhão (regra original do
  // produto), 0 = todas as vagas H-2A/H-2B. Desde 2026-09-11 o padrão é AMPLO,
  // por decisão do operador — o portão de caminhão vira só informação.
  addColumnIfMissing('seasonal_config', 'require_truck_driver_match', 'INTEGER DEFAULT 0');
  addColumnIfMissing('seasonal_config', 'scheduler_enabled', 'INTEGER DEFAULT 0');
  addColumnIfMissing('seasonal_config', 'import_interval_minutes', 'INTEGER DEFAULT 1440');
  addColumnIfMissing('seasonal_config', 'dispatch_interval_minutes', 'INTEGER DEFAULT 60');

  // Perfis de motorista para os usuários já existentes (§27).
  if (tableExists('seasonal_driver_profiles') && tableExists('core_users')) {
    try {
      const users = db.prepare('SELECT id FROM core_users').all();
      const ins = db.prepare('INSERT OR IGNORE INTO seasonal_driver_profiles (user_id) VALUES (?)');
      for (const u of users) ins.run(u.id);
    } catch (e) { /* não bloqueia o boot */ }
  }

  seedDefaults();
  setSchemaVersion(SCHEMA_VERSION);

  try { db.exec('PRAGMA foreign_keys = ON;'); } catch (e) {}

  if (result.dropped.length) {
    const b = result.backfill || {};
    logCore('database', 'schema_migrated_v2',
      `Schema genérico removido conforme spec §44. Preservados: ${b.applications || 0} candidatura(s) enviada(s), ` +
      `${(b.seasonalJobs || 0) + (b.fromLegacyJobs || 0)} ordem(ns) de serviço, ${b.resumes || 0} documento(s).`,
      { dropped: result.dropped, renamed: result.renamed, backfill: result.backfill });
  }

  return result;
}

const migration = initDatabase();

module.exports = {
  db,
  dbPath,
  initDatabase,
  migration,
  uploadsRoot,
  backupDir,
  storagePaths,
  SCHEMA_VERSION,
  logCore, logGupy, logIndeed, logSeasonal,
  tableExists, columnsOf
};
