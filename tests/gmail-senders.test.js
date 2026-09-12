/**
 * F1.3 — várias contas do Gmail em rodízio.
 *
 * O recurso existe porque uma conta só, disparando volume constante, é o que o
 * Google estrangula primeiro — e quando estrangula, o robô inteiro para. A
 * defesa tem duas metades, e as duas são testadas aqui:
 *
 *   distribuir o envio entre contas, um a um;
 *   tirar a conta bloqueada do rodízio sem parar as outras.
 *
 * Nada aqui acessa a rede nem envia e-mail.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const tmpDb = path.join(os.tmpdir(), `h2a-senders-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY
  || crypto.randomBytes(32).toString('base64');

const { db } = require('../config/database');
const senders = require('../services/gmailSenderService');
const secretBox = require('../core/security/secretBox');

test.after(() => {
  for (const s of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + s); } catch (e) { /* já removido */ }
  }
});

function reset() {
  db.prepare('DELETE FROM core_gmail_senders').run();
  db.prepare('DELETE FROM core_gmail_sender_quota').run();
}

function add(email, tokens = { refresh_token: `rt_${email}`, access_token: 'at' }) {
  return senders.upsertFromOAuth({ email, tokens });
}

function drain(n, opts = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = senders.nextAvailable(Object.assign({ globalCap: 1000 }, opts));
    if (!p) { out.push(null); continue; }
    senders.recordSuccess(p.sender.id);
    out.push(p.sender.email);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Segredo em repouso
// ---------------------------------------------------------------------------

test('F1.3 — tokens ficam cifrados no banco, não em texto puro', () => {
  reset();
  add('um@gmail.com');

  const row = db.prepare('SELECT tokens_enc FROM core_gmail_senders LIMIT 1').get();
  assert.ok(secretBox.isEncrypted(row.tokens_enc), 'o token precisa estar cifrado em repouso');
  assert.ok(!row.tokens_enc.includes('rt_'), 'o refresh token não pode aparecer em claro');
});

test('F1.3 — nenhuma listagem devolve token', () => {
  reset();
  add('um@gmail.com');

  const payload = JSON.stringify({
    list: senders.list(),
    status: senders.status({ globalCap: 50 }),
    one: senders.get(senders.list()[0].id)
  });

  assert.ok(!payload.includes('rt_'), 'token vazou por alguma rota de leitura');
  assert.ok(!payload.includes('tokens_enc'), 'o campo cifrado também não deve sair');
});

test('F1.3 — quem precisa do token pede explicitamente', () => {
  reset();
  const s = add('um@gmail.com');
  const full = senders.getWithTokens(s.id);

  assert.ok(full.tokens, 'getWithTokens é o único caminho para o token');
  assert.strictEqual(full.tokens.refresh_token, 'rt_um@gmail.com');
});

// ---------------------------------------------------------------------------
// Rodízio
// ---------------------------------------------------------------------------

test('F1.3 — o envio alterna uma conta por vez, e recomeça', () => {
  reset();
  ['a@x.com', 'b@x.com', 'c@x.com'].forEach(e => add(e));
  senders.list().forEach(s => senders.setDailyLimit(s.id, 4));

  const seq = drain(9);

  // A alternância exata é o que o sistema de referência promete: "1 do
  // primeiro, 1 do segundo... e recomeça".
  assert.deepStrictEqual(seq.slice(0, 3).sort(), ['a@x.com', 'b@x.com', 'c@x.com'],
    'as três contas participam da primeira rodada');
  for (let i = 3; i < seq.length; i++) {
    assert.strictEqual(seq[i], seq[i - 3],
      `posição ${i} rompeu a alternância — o ciclo deve repetir a cada 3 contas`);
  }
});

test('F1.3 — a distribuição fica equilibrada entre as contas', () => {
  reset();
  ['a@x.com', 'b@x.com', 'c@x.com'].forEach(e => add(e));
  senders.list().forEach(s => senders.setDailyLimit(s.id, 10));

  drain(12);

  const st = senders.status({ globalCap: 1000 });
  for (const s of st.senders) {
    assert.strictEqual(s.todaySent, 4, `${s.email} devia ter 4 envios, teve ${s.todaySent}`);
  }
});

test('F1.3 — conta que atingiu o próprio limite é pulada, não travа a fila', () => {
  reset();
  const a = add('a@x.com');
  const b = add('b@x.com');
  senders.setDailyLimit(a.id, 1);
  senders.setDailyLimit(b.id, 5);

  const seq = drain(4).filter(Boolean);

  const deA = seq.filter(e => e === 'a@x.com').length;
  assert.strictEqual(deA, 1, 'a conta com limite 1 não pode enviar duas vezes');
  assert.strictEqual(seq.length, 4, 'a fila continua pelas outras contas');
});

test('F1.3 — conta desativada fica fora do rodízio', () => {
  reset();
  const a = add('a@x.com');
  add('b@x.com');
  senders.list().forEach(s => senders.setDailyLimit(s.id, 5));

  senders.setActive(a.id, false);
  const seq = drain(4).filter(Boolean);

  assert.ok(!seq.includes('a@x.com'), 'conta desativada não pode receber envio');
  assert.strictEqual(seq.length, 4);
});

test('F1.3 — sem conta com cota, devolve null em vez de estourar o limite', () => {
  reset();
  const a = add('a@x.com');
  senders.setDailyLimit(a.id, 2);

  const seq = drain(4);
  assert.deepStrictEqual(seq, ['a@x.com', 'a@x.com', null, null],
    'esgotada a cota, a resposta é "nenhuma conta disponível" — nunca um envio a mais');
});

test('F1.3 — a seleção pode ser restrita a contas escolhidas', () => {
  reset();
  const a = add('a@x.com');
  add('b@x.com');
  senders.list().forEach(s => senders.setDailyLimit(s.id, 5));

  const seq = drain(3, { only: [a.id] }).filter(Boolean);
  assert.ok(seq.every(e => e === 'a@x.com'),
    'restringir a seleção é como o usuário exclui uma conta de um envio específico');
});

// ---------------------------------------------------------------------------
// Cota atômica por conta
// ---------------------------------------------------------------------------

test('F1.3 — a reserva por conta é atômica', () => {
  reset();
  const a = add('a@x.com');

  // Com limite 3, apenas três reservas podem passar, por mais que se tente.
  let ok = 0;
  for (let i = 0; i < 10; i++) if (senders.reserveSlot(a.id, 3)) ok++;

  assert.strictEqual(ok, 3, 'a checagem e o incremento na mesma instrução impedem a quarta');

  const q = db.prepare('SELECT count_sent FROM core_gmail_sender_quota WHERE sender_id = ?').get(a.id);
  assert.strictEqual(q.count_sent, 3);
});

test('F1.3 — envio que falhou devolve a vaga da conta', () => {
  reset();
  const a = add('a@x.com');

  senders.reserveSlot(a.id, 2);
  senders.releaseSlot(a.id);

  const q = db.prepare('SELECT count_sent FROM core_gmail_sender_quota WHERE sender_id = ?').get(a.id);
  assert.strictEqual(q.count_sent, 0,
    'a cota conta envio BEM-SUCEDIDO; tentativa frustrada não pode consumir vaga');
});

test('F1.3 — o limite por conta nunca promete mais que o provedor entrega', () => {
  reset();
  const a = add('a@x.com');
  const s = senders.setDailyLimit(a.id, 99999);

  assert.strictEqual(s.dailyLimit, senders.PROVIDER_HARD_LIMIT,
    'o Gmail corta em 500/dia por conta; configurar acima disso seria promessa falsa');
});

// ---------------------------------------------------------------------------
// Conta bloqueada — o cenário que o recurso existe para sobreviver
// ---------------------------------------------------------------------------

test('F1.3 — autorização revogada tira a conta do rodízio na primeira falha', () => {
  reset();
  const a = add('a@x.com');
  add('b@x.com');

  const v = senders.recordFailure(a.id, {
    errorClass: 'PERMANENT',
    reason: 'invalid_grant: Token has been expired or revoked.'
  });

  assert.strictEqual(v.deactivated, true,
    'autorização revogada não melhora com tentativa — insistir só gasta a fila');
  assert.strictEqual(senders.get(a.id).isActive, false);
  assert.strictEqual(senders.activeSenders().length, 1, 'a outra conta continua ativa');
});

test('F1.3 — falha temporária não desativa de imediato, mas acumula', () => {
  reset();
  const a = add('a@x.com');

  const p1 = senders.recordFailure(a.id, { errorClass: 'TRANSIENT', reason: 'timeout' });
  assert.strictEqual(p1.deactivated, false, 'rede instável não é motivo para desligar a conta');
  assert.strictEqual(senders.get(a.id).isActive, true);

  senders.recordFailure(a.id, { errorClass: 'TRANSIENT', reason: 'timeout' });
  const p3 = senders.recordFailure(a.id, { errorClass: 'TRANSIENT', reason: 'timeout' });

  assert.strictEqual(p3.deactivated, true,
    `após ${senders.AUTO_DEACTIVATE_AFTER} falhas seguidas a conta sai — algo está errado com ela`);
});

test('F1.3 — sucesso zera o contador de falhas', () => {
  reset();
  const a = add('a@x.com');

  senders.recordFailure(a.id, { errorClass: 'TRANSIENT', reason: 'timeout' });
  senders.recordFailure(a.id, { errorClass: 'TRANSIENT', reason: 'timeout' });
  senders.recordSuccess(a.id);

  assert.strictEqual(senders.get(a.id).consecutiveFailures, 0);
  assert.strictEqual(senders.get(a.id).lastError, null);
});

test('F1.3 — reautorizar a conta bloqueada a traz de volta, sem duplicar', () => {
  reset();
  const a = add('a@x.com');
  senders.recordFailure(a.id, { errorClass: 'PERMANENT', reason: 'invalid_grant' });
  assert.strictEqual(senders.get(a.id).isActive, false);

  const again = add('a@x.com', { access_token: 'novo' });

  assert.strictEqual(again.created, false, 'reautorizar não cria uma segunda linha para a mesma conta');
  assert.strictEqual(senders.list().length, 1);
  assert.strictEqual(senders.get(a.id).isActive, true, 'reautorizar é o caminho de recuperação');
  assert.strictEqual(senders.get(a.id).consecutiveFailures, 0);
});

test('F1.3 — reautorização sem refresh_token preserva o que já havia', () => {
  reset();
  const a = add('a@x.com', { refresh_token: 'rt_original', access_token: 'at1' });

  // O Google só entrega refresh_token na primeira concessão. Perder o antigo
  // deixaria a conta inutilizável na primeira expiração do access_token.
  add('a@x.com', { access_token: 'at2' });

  const full = senders.getWithTokens(a.id);
  assert.strictEqual(full.tokens.refresh_token, 'rt_original',
    'o refresh token anterior tem de sobreviver a uma reautorização que não traz um novo');
  assert.strictEqual(full.tokens.access_token, 'at2', 'o access token novo entra');
});

// ---------------------------------------------------------------------------
// Situação para a interface
// ---------------------------------------------------------------------------

test('F1.3 — uma conta só é sinalizada como risco', () => {
  reset();
  add('a@x.com');
  assert.strictEqual(senders.status({ globalCap: 50 }).singleAccountWarning, true,
    'com uma conta só, a interface precisa avisar — é o cenário que este recurso evita');

  add('b@x.com');
  assert.strictEqual(senders.status({ globalCap: 50 }).singleAccountWarning, false);
});

test('F1.3 — sem limite próprio, a conta recebe fatia do teto do dia', () => {
  reset();
  ['a@x.com', 'b@x.com'].forEach(e => add(e));

  const st = senders.status({ globalCap: 50 });
  for (const s of st.senders) {
    assert.strictEqual(s.todayLimit, 25, 'duas contas dividem o teto de 50 ao meio');
    assert.strictEqual(s.limitSource, 'fatia do teto diário');
  }
  assert.strictEqual(st.dailyCapacity, 50,
    'a capacidade do dia não passa do teto do produto, por mais contas que existam');
});

test('F1.3 — a capacidade do dia nunca excede o teto do produto', () => {
  reset();
  ['a@x.com', 'b@x.com', 'c@x.com'].forEach(e => add(e));
  senders.list().forEach(s => senders.setDailyLimit(s.id, 400));

  const st = senders.status({ globalCap: 50 });
  assert.strictEqual(st.dailyCapacity, 50,
    'três contas a 400 somam 1200, mas o teto do produto continua mandando');
});

// ---------------------------------------------------------------------------
// Remoção
// ---------------------------------------------------------------------------

test('F1.3 — remover a conta primária promove a próxima', () => {
  reset();
  const a = add('a@x.com');
  const b = add('b@x.com');

  assert.strictEqual(senders.get(a.id).isPrimary, true);
  senders.remove(a.id);

  assert.strictEqual(senders.get(b.id).isPrimary, true,
    'o sistema não pode ficar sem conta primária depois de uma remoção');
  assert.strictEqual(senders.list().length, 1);
});

test('F1.3 — remover a conta leva a cota dela embora', () => {
  reset();
  const a = add('a@x.com');
  senders.reserveSlot(a.id, 5);

  senders.remove(a.id);

  const left = db.prepare('SELECT COUNT(*) c FROM core_gmail_sender_quota WHERE sender_id = ?').get(a.id).c;
  assert.strictEqual(left, 0, 'cota órfã contaria envio de uma conta que não existe mais');
});
