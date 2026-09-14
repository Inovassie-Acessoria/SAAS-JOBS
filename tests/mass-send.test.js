/**
 * Envio em massa (decisão do operador, 2026-09-14):
 *
 *   - teto do dia = 300 × contas Gmail ativas; limite 0 = automático;
 *   - um e-mail por destinatário a cada N dias (agentes aparecem em dezenas
 *     de ordens; sem isso o robô manda dezenas de e-mails para a mesma caixa);
 *   - o índice do DOL entra como fonte e como estado (ativa/inativa/retirada),
 *     e o estado manda na ordem da fila.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const tmpDb = path.join(os.tmpdir(), `mass-send-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const { db } = require('../config/database');
const senders = require('../services/gmailSenderService');
const emailService = require('../services/seasonalEmailService');
const seasonal = require('../services/seasonalService');
const index = require('../services/adapters/dolIndexClient');

function addSender(email) { return senders.upsertFromOAuth({ email, tokens: { refresh_token: `rt_${email}`, access_token: 'at' } }); }

test.before(() => {
  db.prepare('DELETE FROM core_gmail_senders').run();
  db.prepare('DELETE FROM core_gmail_sender_quota').run();
  db.prepare('UPDATE seasonal_config SET daily_email_limit = 0, recipient_cooldown_days = 30').run();
});

test('teto do dia escala com as contas ativas: 300 × n; limite 0 acompanha o teto', () => {
  assert.strictEqual(emailService.absoluteDailyCap(), 300, 'sem conta cadastrada vale uma conta');
  addSender('a@example.invalid'); addSender('b@example.invalid'); addSender('c@example.invalid');
  assert.strictEqual(emailService.absoluteDailyCap(), 900);
  assert.strictEqual(emailService.configuredLimit(), 900, 'daily_email_limit = 0 é automático');
  const q = emailService.getQuotaStatus();
  assert.strictEqual(q.maxLimit, 900);
  assert.strictEqual(q.absoluteCap, 900);
  assert.strictEqual(q.perAccountCap, 300);
  assert.strictEqual(q.automatic, true);

  // cada conta recebe 300 (fatia do teto), nunca acima do limite do provedor
  const st = senders.status({ globalCap: emailService.configuredLimit() });
  assert.strictEqual(st.dailyCapacity, 900);
  st.senders.forEach(s => assert.strictEqual(s.todayLimit, 300));

  // um limite explícito continua respeitado — e nunca passa do teto
  db.prepare('UPDATE seasonal_config SET daily_email_limit = 500').run();
  assert.strictEqual(emailService.configuredLimit(), 500);
  db.prepare('UPDATE seasonal_config SET daily_email_limit = 5000').run();
  assert.strictEqual(emailService.configuredLimit(), 900);
  db.prepare('UPDATE seasonal_config SET daily_email_limit = 0').run();

  // desativar uma conta reduz o teto na hora
  const one = senders.list()[0];
  senders.setActive(one.id, false);
  assert.strictEqual(emailService.absoluteDailyCap(), 600);
  senders.setActive(one.id, true);
});

test('updateConfig aceita 0 (automático) e limita ao teto', () => {
  assert.strictEqual(Number(seasonal.updateConfig({ daily_email_limit: 0 }).daily_email_limit), 0);
  assert.strictEqual(Number(seasonal.updateConfig({ daily_email_limit: 99999 }).daily_email_limit), 900);
  assert.strictEqual(Number(seasonal.updateConfig({ recipient_cooldown_days: 45 }).recipient_cooldown_days), 45);
  seasonal.updateConfig({ daily_email_limit: 0, recipient_cooldown_days: 30 });
});

test('um e-mail por destinatário a cada N dias: a segunda ordem do mesmo agente é pulada no despacho', async () => {
  db.prepare('DELETE FROM seasonal_email_queue').run();
  db.prepare('DELETE FROM seasonal_application_packages').run();
  db.prepare('DELETE FROM seasonal_applications').run();
  db.prepare("DELETE FROM seasonal_jobs WHERE job_order_id IN ('CD-1','CD-2')").run();
  const ins = db.prepare(`INSERT INTO seasonal_jobs (job_order_id, visa_type, job_title, employer_name, application_method, application_email, start_date)
                          VALUES (?,?,?,?,'EMAIL',?,'2027-03-01')`);
  ins.run('CD-1', 'H-2A', 'Farm Worker', 'Fazenda A', 'agent@example.invalid');
  ins.run('CD-2', 'H-2A', 'Harvest Worker', 'Fazenda B', 'agent@example.invalid');
  const j1 = db.prepare("SELECT id FROM seasonal_jobs WHERE job_order_id = 'CD-1'").get();
  const j2 = db.prepare("SELECT id FROM seasonal_jobs WHERE job_order_id = 'CD-2'").get();

  // já enviamos para o agente há 3 dias, pela ordem CD-1
  db.prepare(`INSERT INTO seasonal_applications (candidate_id, seasonal_job_id, job_order_id, recipient_email, employer_name, subject, sent_at)
              VALUES (1,?,?,?,?,?, datetime('now','-3 days'))`).run(j1.id, 'CD-1', 'agent@example.invalid', 'Fazenda A', 'S');

  // CD-2 está na fila para o MESMO destinatário
  db.prepare(`INSERT INTO seasonal_application_packages (job_id, recipient_email, email_subject, email_body, cover_letter, validation_status, requires_review)
              VALUES (?,?,?,?,?,'PASSED',0)`).run(j2.id, 'agent@example.invalid', 'S', 'B', 'C');
  const pkg = db.prepare('SELECT id FROM seasonal_application_packages WHERE job_id = ?').get(j2.id);
  db.prepare(`INSERT INTO seasonal_email_queue (package_id, job_id, recipient_email, email_subject, email_body, status)
              VALUES (?,?,?,?,?,'QUEUED')`).run(pkg.id, j2.id, 'agent@example.invalid', 'S', 'B');

  emailService.setPause(false);
  const r = await emailService.processQueue({ max: 5 });
  assert.strictEqual(r.sent, 0);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(r.details[0].reason, 'recipient_cooldown');
  const row = db.prepare('SELECT status, last_error FROM seasonal_email_queue WHERE package_id = ?').get(pkg.id);
  assert.strictEqual(row.status, 'SKIPPED');
  assert.match(row.last_error, /já recebeu candidatura/);

  // com o intervalo desligado, o item volta a ser elegível (vai falhar só no envio, por não haver Gmail de verdade)
  db.prepare('UPDATE seasonal_config SET recipient_cooldown_days = 0').run();
  db.prepare("UPDATE seasonal_email_queue SET status = 'QUEUED', last_error = NULL WHERE package_id = ?").run(pkg.id);
  const r2 = await emailService.processQueue({ max: 5 });
  assert.strictEqual(r2.skipped || 0, 0, 'sem intervalo, o destinatário repetido não é motivo de pular');
  db.prepare('UPDATE seasonal_config SET recipient_cooldown_days = 30').run();
});

test('registro do índice do DOL vira vaga com sigla de estado, e-mail, estado do caso e link', () => {
  const n = index.normalizeIndexRecord({
    case_number: 'H-300-26251-221529', case_status: 'Acceptance Issued', active: true,
    job_title: 'Mechanical Olive Harvester Operators', job_duties: 'Operate harvester.', work_hour_num_basic: 40, total_positions: 3,
    basic_rate_from: 31, pay_range_desc: 'Hour', begin_date: '2026-10-05T00:00:00Z', end_date: '2026-12-18T00:00:00Z',
    emp_exp_num_months: 3, special_req: 'Class C license.', education_level: 'None',
    employer_business_name: 'Mendoza Bros. Harvesting', employer_city: 'Santa Maria', employer_state: 'CALIFORNIA',
    employer_phone: '+18057209888', employer_email: 'brenda@mendozabros.com', visa_class: 'H-2A',
    worksite_city: 'Woodland', worksite_state: 'CALIFORNIA', accepted_date: '2026-09-14T00:00:00Z', active_date: '2026-11-11T00:00:00Z',
    soc_code_id: '45-2091.00', apply_email: 'info@mendozabros.com', apply_phone: '+18057209888', apply_url: 'N/A'
  });
  assert.strictEqual(n.job_order_id, 'JO-A-300-26251-221529', 'chaveada pelo 790, como o feed');
  assert.strictEqual(n.visa_type, 'H-2A');
  assert.strictEqual(n.employer_state, 'CA');
  assert.strictEqual(n.employer_city, 'Woodland');
  assert.strictEqual(n.application_email, 'info@mendozabros.com');
  assert.strictEqual(n.employer_email, 'brenda@mendozabros.com');
  assert.strictEqual(n.wage_rate, 31);
  assert.strictEqual(n.start_date, '2026-10-05');
  assert.strictEqual(n.openings, 3);
  assert.strictEqual(n.housing_provided, 1);
  assert.strictEqual(n.dol_active, 1);
  assert.strictEqual(n.dol_status, 'Acceptance Issued');
  assert.strictEqual(n.dol_accepted_at, '2026-09-14');
  assert.strictEqual(n.dol_active_until, '2026-11-11');
  assert.strictEqual(n.dol_url, 'https://seasonaljobs.dol.gov/jobs/H-300-26251-221529');
  assert.strictEqual(n.dol_published, 1);
  assert.match(n.special_requirements, /3 months of experience required/);
  const b = index.normalizeIndexRecord({ case_number: 'H-400-26245-212581', visa_class: 'H-2B', job_title: 'x', employer_state: 'UT', active: false, case_status: 'Determination Issued - Withdrawn' });
  assert.strictEqual(b.job_order_id, 'H-400-26245-212581');
  assert.strictEqual(b.visa_type, 'H-2B');
  assert.strictEqual(b.dol_active, 0);
  assert.strictEqual(b.housing_provided, 0);
});

test('fila do automático: ativa e futura primeiro, sem estado depois, iniciada em seguida, inativa por último; retirada nunca', () => {
  db.prepare("DELETE FROM seasonal_jobs WHERE job_order_id LIKE 'RK-%'").run();
  const ins = db.prepare(`INSERT INTO seasonal_jobs (job_order_id, visa_type, job_title, employer_name, application_method, application_email, start_date, dol_active, dol_status, dol_accepted_at)
                          VALUES (?,?,?,?,'EMAIL',?,?,?,?,?)`);
  ins.run('RK-inativa', 'H-2A', 'A', 'E1', 'e1@x.invalid', '2027-03-01', 0, 'Determination Issued - Certification', '2026-05-01');
  ins.run('RK-iniciada', 'H-2A', 'A', 'E2', 'e2@x.invalid', '2026-01-01', 1, 'Acceptance Issued', '2025-11-01');
  ins.run('RK-semestado', 'H-2A', 'A', 'E3', 'e3@x.invalid', '2027-03-01', null, null, null);
  ins.run('RK-ativa', 'H-2A', 'A', 'E4', 'e4@x.invalid', '2027-03-01', 1, 'Acceptance Issued', '2026-09-14');
  ins.run('RK-retirada', 'H-2A', 'A', 'E5', 'e5@x.invalid', '2027-03-01', 0, 'Determination Issued - Withdrawn', '2026-06-01');
  for (const id of ['RK-inativa', 'RK-iniciada', 'RK-semestado', 'RK-ativa', 'RK-retirada']) {
    const j = db.prepare('SELECT id FROM seasonal_jobs WHERE job_order_id = ?').get(id);
    db.prepare('INSERT OR REPLACE INTO seasonal_matches (job_id, fit_score, ats_score, opportunity_score, queue_priority) VALUES (?,80,80,80,50)').run(j.id);
  }
  const ranked = seasonal.rankedCandidates(100).filter(i => String(i.jobOrderId).startsWith('RK-'));
  assert.deepStrictEqual(ranked.map(i => i.jobOrderId), ['RK-ativa', 'RK-semestado', 'RK-iniciada', 'RK-inativa']);
  assert.ok(!ranked.some(i => i.jobOrderId === 'RK-retirada'), 'retirada pelo DOL não entra na fila');
});

test('listJobs filtra por estado no DOL', () => {
  const ativas = seasonal.listJobs({ dolActive: '1', limit: 500 }).map(j => j.job_order_id).filter(x => x.startsWith('RK-'));
  assert.deepStrictEqual(ativas.sort(), ['RK-ativa', 'RK-iniciada']);
  const inativas = seasonal.listJobs({ dolActive: '0', limit: 500 }).map(j => j.job_order_id).filter(x => x.startsWith('RK-'));
  assert.deepStrictEqual(inativas.sort(), ['RK-inativa', 'RK-retirada']);
});

test.after(() => { try { fs.unlinkSync(tmpDb); } catch (e) { /* */ } });
