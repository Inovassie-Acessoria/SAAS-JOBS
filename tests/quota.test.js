/**
 * Cota diária de e-mails e proteção anti-duplicata (spec §32, §61, §62, §78).
 *
 * O §78 exige o teste de concorrência: com a contagem em 49 e três workers
 * tentando enviar ao mesmo tempo, apenas UM pode passar. Aqui isso é verificado
 * de duas formas — na mesma instância e em PROCESSOS SEPARADOS, que é o cenário
 * real de múltiplos workers.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'h2a-quota-'));
process.env.DB_PATH = path.join(TMP, 'quota.db');

const { db } = require('../config/database');
const emailService = require('../services/seasonalEmailService');

function resetQuota(count, limit = emailService.ABSOLUTE_DAILY_CAP) {
  const day = emailService.todayKey();
  db.prepare('DELETE FROM seasonal_daily_quota').run();
  db.prepare('INSERT INTO seasonal_daily_quota (date_str, count_sent, max_limit, timezone) VALUES (?,?,?,?)')
    .run(day, count, limit, emailService.getTimezone());
  return day;
}

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
});

// ---------------------------------------------------------------------------

/**
 * O teto passou de 50 para 300 em 2026-09-11, por decisão do operador, junto
 * com o rodízio de contas (F1.3).
 *
 * Estes testes deixaram de afirmar o NÚMERO e passaram a afirmar a GARANTIA:
 * nenhuma configuração ultrapassa o teto vigente, e o envio de número teto+1
 * não sai sob concorrência. Era essa propriedade que protegia a conta — não o
 * valor 50. Fixar o número aqui só faria o teste quebrar a cada revisão
 * legítima do limite, ensinando a equipe a atualizar o teste sem pensar.
 */
const CAP = emailService.ABSOLUTE_DAILY_CAP;

test('§32 — nenhuma configuração eleva o teto absoluto', () => {
  db.prepare('UPDATE seasonal_config SET daily_email_limit = ?').run(CAP * 10);
  db.prepare("UPDATE core_system_settings SET value = ? WHERE key = 'max_seasonal_emails_per_day'")
    .run(String(CAP * 20));

  assert.strictEqual(emailService.configuredLimit(), CAP,
    'nem a configuração do produto nem a do sistema podem passar do teto');

  // Um limite MENOR é respeitado — o teto é máximo, não valor fixo.
  db.prepare("UPDATE core_system_settings SET value = '10' WHERE key = 'max_seasonal_emails_per_day'").run();
  assert.strictEqual(emailService.configuredLimit(), 10);

  db.prepare("UPDATE core_system_settings SET value = ? WHERE key = 'max_seasonal_emails_per_day'").run(String(CAP));
  db.prepare('UPDATE seasonal_config SET daily_email_limit = ?').run(CAP);
});

test('§32 — o teto vigente é 300, e é um valor deliberado', () => {
  // Este é o único teste que cita o número. Ele existe para que uma mudança
  // acidental do teto falhe alto, em vez de passar despercebida — mas está
  // separado da garantia, que não depende de qual é o número.
  assert.strictEqual(CAP, 300,
    'o teto foi definido em 300/dia pelo operador; mudá-lo é decisão, não detalhe');
});

test('§32 — a chave do dia usa o fuso configurado, não UTC', () => {
  db.prepare("UPDATE core_system_settings SET value = 'Pacific/Kiritimati' WHERE key = 'application_timezone'").run();
  const kiritimati = emailService.todayKey();

  db.prepare("UPDATE core_system_settings SET value = 'Pacific/Niue' WHERE key = 'application_timezone'").run();
  const niue = emailService.todayKey();

  // Kiritimati (UTC+14) e Niue (UTC-11) estão 25 horas apart: nunca compartilham
  // a mesma data-calendário. Se a chave fosse derivada de UTC, seriam idênticas.
  assert.match(kiritimati, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(niue, /^\d{4}-\d{2}-\d{2}$/);
  assert.notStrictEqual(kiritimati, niue,
    'a chave do dia tem que mudar com o fuso configurado — se não muda, está usando UTC');

  db.prepare("UPDATE core_system_settings SET value = 'America/Sao_Paulo' WHERE key = 'application_timezone'").run();
  assert.strictEqual(emailService.getTimezone(), 'America/Sao_Paulo');

  const status = emailService.getQuotaStatus();
  assert.strictEqual(status.timezone, 'America/Sao_Paulo');
  assert.ok(status.reset.timezone === 'America/Sao_Paulo');
});

test('§61/§78 — a um do teto, apenas UMA reserva passa e o total para no teto', () => {
  const day = resetQuota(CAP - 1);

  // Três "workers" disputando a última vaga na mesma instância.
  const results = [
    emailService.reserveQuotaSlot(day),
    emailService.reserveQuotaSlot(day),
    emailService.reserveQuotaSlot(day)
  ];

  const granted = results.filter(Boolean).length;
  assert.strictEqual(granted, 1, 'exatamente uma reserva pode ser concedida');

  const row = db.prepare('SELECT * FROM seasonal_daily_quota WHERE date_str = ?').get(day);
  assert.strictEqual(row.count_sent, CAP, 'a contagem final tem que ser exatamente o teto');
  assert.strictEqual(emailService.getQuotaStatus().remaining, 0);
});

test('§78 — batido o teto, toda tentativa seguinte é recusada', () => {
  // Parte já a um do teto: o que se prova é que, cruzada a linha, nada mais
  // passa — não é preciso percorrer o teto inteiro para isso. A versão anterior
  // fazia 2×CAP UPDATEs e disputava disco com o resto da suíte a ponto de
  // estourar o timeout de outros testes.
  const day = resetQuota(CAP - 1);
  let granted = 0;
  const EXTRA = 25;
  for (let i = 0; i < 1 + EXTRA; i++) {
    if (emailService.reserveQuotaSlot(day)) granted++;
  }
  assert.strictEqual(granted, 1, `só a vaga que faltava pode ser concedida; ${EXTRA} tentativas além dela têm de falhar`);
  assert.strictEqual(
    db.prepare('SELECT count_sent v FROM seasonal_daily_quota WHERE date_str = ?').get(day).v, CAP);
});

test('§78 — concorrência REAL: 6 processos separados disputando a última vaga', () => {
  const day = resetQuota(CAP - 1);

  const worker = path.join(TMP, 'worker.js');
  fs.writeFileSync(worker, `
    process.env.DB_PATH = ${JSON.stringify(process.env.DB_PATH)};
    const svc = require(${JSON.stringify(path.join(__dirname, '..', 'services', 'seasonalEmailService.js').replace(/\\/g, '/'))});
    const ok = svc.reserveQuotaSlot(${JSON.stringify(day)});
    process.stdout.write(ok ? 'GRANTED' : 'DENIED');
  `);

  const outcomes = [];
  for (let i = 0; i < 6; i++) {
    try {
      outcomes.push(execFileSync(process.execPath, [worker], { encoding: 'utf8', timeout: 20000 }).trim());
    } catch (e) {
      outcomes.push('ERROR:' + (e.message || '').slice(0, 80));
    }
  }

  const granted = outcomes.filter(o => o === 'GRANTED').length;
  assert.strictEqual(granted, 1,
    `apenas um processo pode receber a última vaga; resultados: ${outcomes.join(', ')}`);

  const final = db.prepare('SELECT count_sent v FROM seasonal_daily_quota WHERE date_str = ?').get(day).v;
  assert.strictEqual(final, CAP, `a contagem final deve ser ${CAP}, veio ${final}`);
});

test('§61 — reserva devolvida quando o envio falha: a cota conta sucessos', () => {
  const day = resetQuota(10);

  assert.strictEqual(emailService.reserveQuotaSlot(day), true);
  assert.strictEqual(db.prepare('SELECT count_sent v FROM seasonal_daily_quota WHERE date_str = ?').get(day).v, 11);

  emailService.releaseQuotaSlot(day);
  assert.strictEqual(db.prepare('SELECT count_sent v FROM seasonal_daily_quota WHERE date_str = ?').get(day).v, 10,
    'uma tentativa frustrada não pode consumir a vaga do dia');
});

test('§61 — a devolução nunca leva a contagem abaixo de zero', () => {
  const day = resetQuota(0);
  emailService.releaseQuotaSlot(day);
  emailService.releaseQuotaSlot(day);
  assert.strictEqual(db.prepare('SELECT count_sent v FROM seasonal_daily_quota WHERE date_str = ?').get(day).v, 0);
});

test('§62 — o banco recusa candidatura duplicada para o mesmo destinatário', () => {
  db.prepare('DELETE FROM seasonal_applications').run();
  db.prepare(`INSERT INTO seasonal_jobs (job_order_id, visa_type, job_title, employer_name)
              VALUES ('DUP-1','H-2A','Test Role','Test Employer')
              ON CONFLICT(job_order_id) DO NOTHING`).run();
  const job = db.prepare("SELECT id FROM seasonal_jobs WHERE job_order_id = 'DUP-1'").get();

  const insert = () => db.prepare(`INSERT INTO seasonal_applications
    (candidate_id, seasonal_job_id, job_order_id, recipient_email, employer_name, subject)
    VALUES (1,?,?,?,?,?)`).run(job.id, 'DUP-1', 'jobs@example.invalid', 'Test Employer', 'Application');

  insert();
  assert.throws(insert, /UNIQUE|constraint/i,
    'a garantia é do schema, não só da aplicação');

  // Destinatário diferente na mesma vaga é permitido (empregador vs. advogado).
  db.prepare(`INSERT INTO seasonal_applications
    (candidate_id, seasonal_job_id, job_order_id, recipient_email, employer_name, subject)
    VALUES (1,?,?,?,?,?)`).run(job.id, 'DUP-1', 'attorney@example.invalid', 'Test Employer', 'Application');

  assert.strictEqual(db.prepare('SELECT COUNT(*) v FROM seasonal_applications').get().v, 2);
});

test('§63 — com a pausa ativa nenhum e-mail sai do sistema', async () => {
  resetQuota(0);
  emailService.setPause(true);

  const r = await emailService.processQueue();
  assert.strictEqual(r.sent, 0);
  assert.strictEqual(r.reason, 'PAUSED');
  assert.match(r.userMessage, /pausad/i);

  emailService.setPause(false);
  const cfg = db.prepare('SELECT pause_email_sending v FROM seasonal_config ORDER BY id LIMIT 1').get();
  assert.strictEqual(cfg.v, 0);
});

test('§61 — cota esgotada não descarta a fila: as candidaturas continuam enfileiradas', async () => {
  resetQuota(CAP);
  db.prepare('DELETE FROM seasonal_email_queue').run();
  db.prepare('DELETE FROM seasonal_application_packages').run();

  const job = db.prepare("SELECT id FROM seasonal_jobs WHERE job_order_id = 'DUP-1'").get();
  db.prepare(`INSERT INTO seasonal_application_packages
    (job_id, recipient_email, email_subject, email_body, cover_letter, validation_status)
    VALUES (?,?,?,?,?,'PASSED')`).run(job.id, 'x@example.invalid', 'S', 'B', 'C');
  const pkg = db.prepare('SELECT id FROM seasonal_application_packages WHERE job_id = ?').get(job.id);
  db.prepare(`INSERT INTO seasonal_email_queue (package_id, job_id, recipient_email, email_subject, email_body, status)
              VALUES (?,?,?,?,?,'QUEUED')`).run(pkg.id, job.id, 'x@example.invalid', 'S', 'B');

  const r = await emailService.processQueue();
  assert.strictEqual(r.sent, 0);
  assert.strictEqual(r.reason, 'QUOTA_REACHED');

  const still = db.prepare("SELECT COUNT(*) v FROM seasonal_email_queue WHERE status = 'QUEUED'").get().v;
  assert.strictEqual(still, 1, 'o excedente permanece na fila, nunca é descartado');
  assert.match(r.userMessage, /continuam na fila/i);
});

test('§40 do build prompt — erros transitórios e permanentes são classificados', () => {
  const permanent = [
    new Error('550 no such user here'),
    Object.assign(new Error('invalid_grant'), { responseCode: 401 }),
    new Error('ENOENT: attachment not found')
  ];
  for (const e of permanent) {
    assert.strictEqual(emailService.classifyError(e).class, 'PERMANENT', e.message);
  }

  const transient = [
    new Error('ETIMEDOUT'),
    Object.assign(new Error('rate limited'), { responseCode: 429 }),
    Object.assign(new Error('service unavailable'), { responseCode: 503 })
  ];
  for (const e of transient) {
    assert.strictEqual(emailService.classifyError(e).class, 'TRANSIENT', e.message);
  }

  assert.deepStrictEqual(emailService.RETRY_BACKOFF_MINUTES, [5, 30, 120],
    'o backoff exponencial do spec deve estar configurado');
});

test('§33 do build prompt — validação bloqueia envio sem currículo e sem anexo', () => {
  const job = { id: 1, end_date: '2027-12-31' };
  const profile = { fullName: 'Test', email: 't@example.invalid' };

  const noResume = emailService.validatePackage({
    job, profile, resume: null, attachments: [],
    recipient: 'x@example.invalid', body: 'x'.repeat(120), subject: 'Assunto'
  });

  assert.strictEqual(noResume.status, 'FAILED', 'sem currículo o pacote não pode passar');
  const ids = noResume.checks.filter(c => !c.ok).map(c => c.id);
  assert.ok(ids.includes('resume_exists'), 'a checagem de currículo deve reprovar');
  assert.ok(ids.includes('attachments'), 'a checagem de anexos deve reprovar');
  assert.ok(noResume.blockingFailures.length >= 2);

  const badEmail = emailService.validatePackage({
    job, profile, resume: { name: 'r', file_path: __filename },
    attachments: [{ filename: 'r.pdf', path: __filename }],
    recipient: 'nao-e-email', body: 'x'.repeat(120), subject: 'Assunto'
  });
  assert.strictEqual(badEmail.status, 'FAILED');
  assert.ok(badEmail.checks.find(c => c.id === 'email_format' && !c.ok));
});
