/**
 * Backup automático do banco e exportação do histórico.
 *
 * O que se perde sem backup, na ordem em que dói:
 *   1. o histórico de candidaturas enviadas — é ele que impede envio duplicado
 *      e prova o que foi mandado para quem;
 *   2. o perfil, os currículos e os modelos de e-mail — retrabalho de verdade;
 *   3. a autorização das contas Gmail — reautorizar é rápido, mas é manual;
 *   4. as vagas e análises — recuperáveis, o robô importa de novo.
 *
 * `VACUUM INTO` produz um arquivo íntegro mesmo com escritas acontecendo —
 * diferente de copiar o .db com `cp`, que pode capturar um estado
 * inconsistente por causa do WAL. Todo backup é reaberto e conferido antes de
 * ser anunciado: um backup que não abre não é um backup.
 *
 * Um backup que mora no mesmo disco não protege contra a perda do disco. Por
 * isso existe o download pelo painel e a exportação em JSON do histórico.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { db, dbPath, backupDir, storagePaths, logCore } = require('../config/database');

const KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP || '14', 10) || 14);
const NAME_RE = /^h2a-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.db$/;
/** Sem backup há mais tempo que isto, o painel e a prontidão avisam. */
const STALE_HOURS = 48;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function count(conn, sql) {
  try { return conn.prepare(sql).get().c; } catch (e) { return null; }
}

/** Reabre o arquivo e confere integridade + conteúdo. */
function verifyFile(file) {
  const conn = new DatabaseSync(file, { readOnly: true });
  try {
    const ic = conn.prepare('PRAGMA integrity_check').get();
    const integrity = ic ? String(Object.values(ic)[0]) : 'unknown';
    return {
      ok: integrity === 'ok',
      integrity,
      jobs: count(conn, 'SELECT COUNT(*) c FROM seasonal_jobs'),
      applications: count(conn, 'SELECT COUNT(*) c FROM seasonal_applications'),
      templates: count(conn, 'SELECT COUNT(*) c FROM seasonal_email_templates'),
      senders: count(conn, 'SELECT COUNT(*) c FROM core_gmail_senders')
    };
  } finally { conn.close(); }
}

/** Mantém os N mais recentes; devolve os nomes removidos. */
function rotate(dir, keep) {
  const files = list(dir).map(f => f.file);
  const excess = files.slice(keep);
  const removed = [];
  for (const f of excess) {
    try { fs.unlinkSync(path.join(dir, f)); removed.push(f); } catch (e) { /* segue */ }
  }
  return removed;
}

/**
 * Faz um backup agora. Lança se o arquivo não puder ser gravado ou não abrir
 * de volta — a chamada síncrona é deliberada: dura poucos segundos e não pode
 * ser interrompida por outra escrita no meio.
 */
function run({ dir = backupDir, keep = KEEP, reason = 'manual' } = {}) {
  ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = path.join(dir, `h2a-${stamp}.db`);
  // VACUUM INTO exige que o destino não exista (dois backups no mesmo segundo).
  if (fs.existsSync(target)) fs.unlinkSync(target);

  // Aspas SIMPLES: com aspas duplas o SQLite lê o caminho como nome de coluna.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

  let verify;
  try { verify = verifyFile(target); } catch (e) { verify = { ok: false, integrity: e.message }; }
  if (!verify.ok) {
    try { fs.unlinkSync(target); } catch (e) { /* segue */ }
    throw new Error(`Backup gravado mas não passou na conferência (${verify.integrity}). Arquivo descartado.`);
  }

  const size = fs.statSync(target).size;
  const removed = rotate(dir, keep);
  // Com o backup feito, o WAL pode ser compactado de volta no arquivo principal.
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { /* otimização */ }

  const result = { file: path.basename(target), path: target, size, keep, removed, reason, ...verify, createdAt: new Date().toISOString() };
  try {
    logCore('backup', 'backup_done',
      `Backup ${result.file} (${(size / 1024 / 1024).toFixed(2)} MB): ${verify.jobs} vaga(s), ${verify.applications} candidatura(s).`,
      { reason, removed: removed.length });
  } catch (e) { /* log é acessório */ }
  return result;
}

function list(dir = backupDir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => NAME_RE.test(f))
    .map(f => {
      const st = fs.statSync(path.join(dir, f));
      const m = f.match(NAME_RE);
      const iso = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3Z');
      return { file: f, size: st.size, createdAt: iso };
    })
    .sort((a, b) => (a.file < b.file ? 1 : -1));
}

/** Caminho absoluto de um backup pelo nome — só nomes que o próprio serviço gera. */
function resolveFile(name, dir = backupDir) {
  if (!NAME_RE.test(String(name || ''))) return null;
  const p = path.join(dir, name);
  return fs.existsSync(p) ? p : null;
}

function fileSize(p) { try { return fs.statSync(p).size; } catch (e) { return 0; } }

function status() {
  const files = list();
  const last = files[0] || null;
  const lastAgeHours = last ? Math.round((Date.now() - new Date(last.createdAt).getTime()) / 36e5) : null;
  const paths = storagePaths();
  const warnings = [];
  const production = process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production';
  if (production && paths.dbInsideApp && !paths.fromEnv.DATA_DIR) {
    warnings.push({
      code: 'DB_INSIDE_APP',
      title: 'O banco mora dentro da pasta do aplicativo',
      detail: 'Um deploy que recria a pasta (clone novo, "rebuild") apaga o histórico junto. Defina DATA_DIR e UPLOADS_DIR apontando para uma pasta fora do app e mova os arquivos uma vez.'
    });
  }
  if (production && paths.backupsInsideApp && !paths.fromEnv.BACKUP_DIR) {
    warnings.push({
      code: 'BACKUPS_INSIDE_APP',
      title: 'Os backups ficam na mesma pasta do aplicativo',
      detail: 'Se a pasta for apagada, banco e backups vão juntos. Defina BACKUP_DIR fora do app — e baixe um backup de vez em quando pelo botão abaixo.'
    });
  }
  if (!last) warnings.push({ code: 'NO_BACKUP', title: 'Nenhum backup ainda', detail: 'O primeiro backup automático sai no próximo ciclo do agendador; faça um agora pelo botão.' });
  else if (lastAgeHours > STALE_HOURS) warnings.push({ code: 'STALE', title: `Último backup há ${lastAgeHours} h`, detail: 'O agendador deveria fazer um por dia. Confira se a automação está ligada.' });

  return {
    dir: backupDir, keep: KEEP, count: files.length, last, lastAgeHours, stale: !last || lastAgeHours > STALE_HOURS,
    files: files.slice(0, 30),
    db: { path: dbPath, size: fileSize(dbPath), walSize: fileSize(dbPath + '-wal') },
    paths, warnings,
    counts: {
      jobs: count(db, 'SELECT COUNT(*) c FROM seasonal_jobs'),
      applications: count(db, 'SELECT COUNT(*) c FROM seasonal_applications'),
      events: count(db, 'SELECT COUNT(*) c FROM seasonal_email_events'),
      templates: count(db, 'SELECT COUNT(*) c FROM seasonal_email_templates'),
      resumes: count(db, 'SELECT COUNT(*) c FROM seasonal_resumes'),
      senders: count(db, 'SELECT COUNT(*) c FROM core_gmail_senders')
    }
  };
}

/**
 * Histórico em JSON, legível fora do sistema. Não inclui segredo nenhum:
 * tokens, client_secret e senhas ficam de fora por construção — só as
 * tabelas listadas aqui entram, coluna a coluna.
 */
function exportHistory() {
  // Erro de consulta não é engolido: uma exportação que omite uma tabela em
  // silêncio é pior que uma que falha alto.
  const all = (sql) => db.prepare(sql).all();
  return {
    exportedAt: new Date().toISOString(),
    system: 'H2 Dream',
    applications: all(`SELECT a.id, a.job_order_id, a.recipient_email, a.employer_name, a.subject, a.content_sent,
                              a.attachments_json, a.sent_at, a.status,
                              COALESCE(a.job_title, j.job_title) AS job_title, COALESCE(a.visa_type, j.visa_type) AS visa_type,
                              COALESCE(a.employer_state, j.employer_state) AS employer_state, j.employer_city, j.dol_url
                         FROM seasonal_applications a LEFT JOIN seasonal_jobs j ON j.id = a.seasonal_job_id
                        ORDER BY a.sent_at`),
    emailEvents: all('SELECT id, queue_id, job_id, event, detail, created_at FROM seasonal_email_events ORDER BY id'),
    savedJobs: all('SELECT s.job_id, s.notes, s.saved_at, j.job_order_id, j.job_title, j.employer_name FROM seasonal_saved_jobs s LEFT JOIN seasonal_jobs j ON j.id = s.job_id'),
    discardedJobs: all('SELECT d.job_id, d.discarded_at, d.reason, j.job_order_id, j.job_title, j.employer_name FROM seasonal_discarded_jobs d LEFT JOIN seasonal_jobs j ON j.id = d.job_id'),
    manualActions: all('SELECT * FROM seasonal_manual_actions ORDER BY id'),
    templates: all('SELECT id, kind, visa_type, content, active, sort_order, use_count, last_used_at FROM seasonal_email_templates ORDER BY kind, sort_order, id'),
    profile: all('SELECT * FROM seasonal_profiles'),
    driverProfile: all('SELECT * FROM seasonal_driver_profiles'),
    resumes: all('SELECT id, name, original_name, filename, visa_type, is_default, is_active, archived, created_at FROM seasonal_resumes'),
    config: all(`SELECT h2a_preference, h2b_preference, preferred_states, preferred_occupations, excluded_occupations,
                        min_hourly_wage, available_from, available_to, automation_mode, email_review_mode,
                        daily_email_limit, recipient_cooldown_days, require_truck_driver_match, target_hiring_year
                   FROM seasonal_config`),
    senders: all('SELECT id, email, display_name, is_active, is_primary, daily_limit, created_at FROM core_gmail_senders'),
    uiPrefs: all('SELECT key, value FROM seasonal_ui_prefs'),
    dailyQuota: all('SELECT date_str, count_sent, max_limit FROM seasonal_daily_quota ORDER BY date_str')
  };
}

module.exports = { run, list, status, resolveFile, exportHistory, verifyFile, KEEP, STALE_HOURS, NAME_RE };
