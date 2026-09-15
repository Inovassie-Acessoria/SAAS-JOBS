/**
 * Nada pode fazer o histórico sumir.
 *
 *   - testes nunca abrem o banco real (NODE_ENV=test ganha banco temporário;
 *     DB_PATH apontando para o banco real é recusado);
 *   - o backup sai íntegro, é conferido, roda em rotação e aparece na listagem;
 *   - a exportação do histórico traz as candidaturas com a cópia da vaga;
 *   - uma reimportação mais pobre não apaga e-mail/descrição/salário já conhecidos;
 *   - a candidatura guarda a própria cópia de título/visto/estado da vaga.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'h2a-safety-'));
process.env.DB_PATH = path.join(TMP, 'safety.db');
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.BACKUP_KEEP = '2';

const database = require('../config/database');
const { db } = database;
const seasonal = require('../services/seasonalService');
const backup = require('../services/backupService');

const ROOT = path.join(__dirname, '..');
const REAL_DB = path.join(ROOT, 'data', 'h2a_system.db');

function runNode(code, env) {
  return execFileSync(process.execPath, ['-e', code], {
    cwd: ROOT, env: Object.assign({}, process.env, env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000
  });
}

test('NODE_ENV=test sem DB_PATH abre um banco temporário, nunca o real', () => {
  const out = runNode(`const d = require('./config/database'); process.stdout.write(d.dbPath);`,
    { NODE_ENV: 'test', DB_PATH: '' });
  assert.notStrictEqual(path.resolve(out), path.resolve(REAL_DB), 'o teste abriu o banco real');
  assert.ok(out.startsWith(os.tmpdir()), `esperado banco em ${os.tmpdir()}, veio ${out}`);
});

test('NODE_ENV=test com DB_PATH apontando para o banco real é recusado', () => {
  let failed = false;
  try {
    runNode(`require('./config/database');`, { NODE_ENV: 'test', DB_PATH: REAL_DB });
  } catch (e) { failed = true; assert.match(String(e.stderr), /Recusado/); }
  assert.ok(failed, 'deveria ter recusado abrir o banco real sob NODE_ENV=test');
});

test('os caminhos de dados são configuráveis por ambiente e reportados', () => {
  const p = database.storagePaths();
  assert.strictEqual(p.dbPath, path.resolve(process.env.DB_PATH));
  assert.strictEqual(p.backupDir, path.resolve(process.env.BACKUP_DIR));
  assert.strictEqual(typeof p.dbInsideApp, 'boolean');
  assert.strictEqual(p.fromEnv.BACKUP_DIR, true);
});

function job(id, extra) {
  return Object.assign({
    job_order_id: id, visa_type: 'H-2A', job_title: 'Farmworker', normalized_title: 'Farmworker', soc_code: '45-2092',
    employer_name: 'Fazenda Teste', employer_city: 'Fresno', employer_state: 'CA', employer_phone: null,
    employer_email: null, attorney_name: null, attorney_email: null, wage_rate: 17.5, wage_unit: 'Hour',
    start_date: '2026-11-01', end_date: '2027-03-01', openings: 5, weekly_hours: 40, housing_provided: 1,
    transportation_provided: 1, duties_description: 'Harvest grapes.', special_requirements: '3 months experience.',
    application_method: 'EMAIL', application_email: 'rh@fazenda.com', application_url: null, raw_json: '{}',
    feed_date: '2026-09-10', feed_key: 'jo'
  }, extra || {});
}

test('reimportação mais pobre não apaga e-mail, descrição nem salário já conhecidos', () => {
  seasonal.upsertJob(job('JO-A-300-1'), 'h1');
  // O índice trouxe a mesma ordem sem e-mail, sem descrição e sem salário.
  seasonal.upsertJob(job('JO-A-300-1', {
    application_email: null, application_method: 'UNKNOWN', duties_description: '', special_requirements: null, wage_rate: null,
    provider_feed: 'index', dol_active: 1, dol_status: 'Accepted - Active'
  }), 'h2');
  const r = db.prepare('SELECT application_email, application_method, duties_description, special_requirements, wage_rate, dol_active FROM seasonal_jobs WHERE job_order_id = ?').get('JO-A-300-1');
  assert.strictEqual(r.application_email, 'rh@fazenda.com');
  assert.strictEqual(r.application_method, 'EMAIL');
  assert.strictEqual(r.duties_description, 'Harvest grapes.');
  assert.strictEqual(r.special_requirements, '3 months experience.');
  assert.strictEqual(r.wage_rate, 17.5);
  assert.strictEqual(r.dol_active, 1, 'o que a fonte nova SABE (estado no DOL) entra');

  // Um valor novo de verdade continua substituindo.
  seasonal.upsertJob(job('JO-A-300-1', { application_email: 'novo@fazenda.com', wage_rate: 18 }), 'h3');
  const r2 = db.prepare('SELECT application_email, wage_rate FROM seasonal_jobs WHERE job_order_id = ?').get('JO-A-300-1');
  assert.strictEqual(r2.application_email, 'novo@fazenda.com');
  assert.strictEqual(r2.wage_rate, 18);
});

test('a candidatura guarda a própria cópia de título, visto e estado da vaga', () => {
  const cols = database.columnsOf('seasonal_applications');
  for (const c of ['job_title', 'visa_type', 'employer_state']) assert.ok(cols.includes(c), `coluna ${c} ausente`);
  const j = db.prepare('SELECT id FROM seasonal_jobs WHERE job_order_id = ?').get('JO-A-300-1');
  db.prepare(`INSERT INTO seasonal_applications (candidate_id, seasonal_job_id, job_order_id, recipient_email, employer_name, subject, content_sent, attachments_json, job_title, visa_type, employer_state)
              VALUES (1,?,?,?,?,?,?,?,?,?,?)`)
    .run(j.id, 'JO-A-300-1', 'novo@fazenda.com', 'Fazenda Teste', 'Application', 'body', '[]', 'Farmworker', 'H-2A', 'CA');
  const exp = backup.exportHistory();
  assert.strictEqual(exp.applications.length, 1);
  assert.strictEqual(exp.applications[0].job_title, 'Farmworker');
  assert.strictEqual(exp.applications[0].employer_state, 'CA');
  assert.ok(!JSON.stringify(exp).includes('tokens_enc'), 'a exportação não pode carregar segredos');
  for (const k of ['applications', 'emailEvents', 'savedJobs', 'discardedJobs', 'templates', 'profile', 'config', 'senders']) {
    assert.ok(Array.isArray(exp[k]), `exportação sem a seção ${k}`);
  }
});

test('backup: arquivo íntegro, conferido, listado, e a rotação mantém só os N mais recentes', () => {
  const a = backup.run({ reason: 'test' });
  assert.ok(fs.existsSync(a.path));
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.integrity, 'ok');
  assert.strictEqual(a.applications, 1, 'o backup precisa conter a candidatura gravada');
  assert.ok(a.jobs >= 1);

  // O arquivo abre sozinho e responde — é isso que faz dele um backup.
  const v = backup.verifyFile(a.path);
  assert.strictEqual(v.ok, true);

  // Rotação: BACKUP_KEEP=2 → o terceiro remove o primeiro.
  const files = [a.file];
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    // nomes têm resolução de segundo: garante nomes distintos
    while (Date.now() - t0 < 1100) { /* espera */ }
    files.push(backup.run({ reason: 'test' }).file);
  }
  const listed = backup.list().map(f => f.file);
  assert.strictEqual(listed.length, 2, `esperado 2 backups, há ${listed.length}`);
  assert.ok(!listed.includes(files[0]), 'o mais antigo deveria ter sido removido');
  assert.ok(listed.includes(files[2]));

  const st = backup.status();
  assert.strictEqual(st.count, 2);
  assert.strictEqual(st.stale, false);
  assert.strictEqual(st.last.file, files[2]);
  assert.strictEqual(st.counts.applications, 1);
  assert.ok(st.paths.dbPath);

  // Só nomes gerados pelo serviço podem ser resolvidos para download.
  assert.strictEqual(backup.resolveFile('../../.env'), null);
  assert.strictEqual(backup.resolveFile(files[2]), path.join(process.env.BACKUP_DIR, files[2]));
});

test('a tarefa de backup existe no agendador e liga junto com a automação', () => {
  const scheduler = require('../services/scheduler');
  assert.ok(scheduler.TASKS && scheduler.TASKS.db_backup, 'tarefa db_backup ausente');
  scheduler.setEnabled(true);
  const row = db.prepare("SELECT enabled FROM core_scheduler_jobs WHERE id = 'db_backup'").get();
  assert.strictEqual(Number(row.enabled), 1);
  scheduler.setEnabled(false);
});
