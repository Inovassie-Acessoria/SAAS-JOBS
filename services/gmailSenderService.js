/**
 * Contas de envio do Gmail, em rodízio (F1.3).
 *
 * O PROBLEMA QUE ISTO RESOLVE
 * ---------------------------
 * Uma conta só, disparando volume constante de mensagens parecidas, é o que o
 * Google estrangula primeiro — e quando estrangula, o robô inteiro para. O
 * sistema de referência é explícito sobre a defesa:
 *
 *   "O envio alterna 1 por 1 entre os e-mails marcados (1 do primeiro, 1 do
 *    segundo... e recomeça). Desmarque um e-mail se ele estiver bloqueado."
 *
 * As duas metades importam igualmente. Distribuir reduz a chance de bloqueio;
 * poder DESATIVAR a conta bloqueada sem parar as outras é o que garante que um
 * bloqueio não derruba a operação.
 *
 * ONDE OS TOKENS MORAM
 * --------------------
 * No banco, cifrados com AES-256-GCM. Não em arquivo — e o motivo é concreto:
 * o `npm run backup` copia o banco e NÃO a pasta `.secrets`. Com token em
 * arquivo, restaurar um backup significava reautorizar todas as contas do zero.
 *
 * A chave de cifra continua fora do banco, em APP_ENCRYPTION_KEY, como o
 * secretBox exige.
 *
 * DUAS COTAS, NÃO UMA
 * -------------------
 * Cada envio precisa passar por duas reservas atômicas: a do dia (teto do
 * produto) e a da conta (teto daquela conta). As duas usam a mesma mecânica de
 * checagem-e-incremento numa única instrução SQL que já prova, em teste com seis
 * processos concorrentes, que o envio excedente não sai.
 */

const { db, logCore, logSeasonal } = require('../config/database');
const secretBox = require('../core/security/secretBox');

/**
 * Teto por conta quando nada foi configurado.
 *
 * Alinhado ao teto do produto (300/dia) dividido pelas três contas que o
 * operador pretende usar: 100 cada. Era 80, e 3 × 80 = 240 entregava menos
 * que o combinado sem ninguém perceber — o limite por conta virava o gargalo
 * silencioso do limite global.
 *
 * Com mais contas a fatia cai (4 contas → 75 cada); com menos, o teto do
 * produto continua mandando (2 contas → 100 cada = 200, não 300). Nos dois
 * casos fica bem abaixo dos 500/dia que o Gmail corta.
 */
const DEFAULT_PER_SENDER_LIMIT = 300;

/**
 * O Gmail gratuito corta em 500 mensagens por 24h por conta. Nenhuma
 * configuração pode prometer mais do que o provedor entrega.
 */
const PROVIDER_HARD_LIMIT = 500;

/** Falhas de autorização seguidas antes de tirar a conta do rodízio sozinha. */
const AUTO_DEACTIVATE_AFTER = 3;

// ---------------------------------------------------------------------------
// Dia corrente, no fuso configurado
// ---------------------------------------------------------------------------

function timezone() {
  try {
    const r = db.prepare("SELECT value FROM core_system_settings WHERE key = 'application_timezone'").get();
    return (r && r.value) || 'America/Sao_Paulo';
  } catch (e) { return 'America/Sao_Paulo'; }
}

function todayKey(tz = timezone()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// Registro de contas
// ---------------------------------------------------------------------------

function rowToSender(r, { withTokens = false } = {}) {
  if (!r) return null;
  const out = {
    id: r.id,
    email: r.email,
    displayName: r.display_name || '',
    isActive: Boolean(r.is_active),
    isPrimary: Boolean(r.is_primary),
    dailyLimit: r.daily_limit == null ? null : Number(r.daily_limit),
    rotationOrder: r.rotation_order,
    lastUsedAt: r.last_used_at,
    lastSuccessAt: r.last_success_at,
    lastError: r.last_error,
    errorClass: r.error_class,
    consecutiveFailures: r.consecutive_failures || 0,
    createdAt: r.created_at
  };
  if (withTokens) out.tokens = decryptTokens(r.tokens_enc);
  return out;
}

function decryptTokens(enc) {
  if (!enc) return null;
  try {
    return secretBox.isEncrypted(enc) ? secretBox.decryptJson(enc) : JSON.parse(enc);
  } catch (e) {
    logCore('gmail', 'sender_tokens_unreadable',
      'Tokens de uma conta de envio não puderam ser decifrados. Pode ser APP_ENCRYPTION_KEY trocada.',
      null, null, 'error');
    return null;
  }
}

/** Lista as contas. NUNCA devolve token — quem precisa pede explicitamente. */
function list(userId = 1) {
  return db.prepare(
    'SELECT * FROM core_gmail_senders WHERE user_id = ? ORDER BY is_primary DESC, rotation_order ASC, id ASC'
  ).all(Number(userId)).map(r => rowToSender(r));
}

function get(id, userId = 1) {
  const r = db.prepare('SELECT * FROM core_gmail_senders WHERE id = ? AND user_id = ?')
    .get(Number(id), Number(userId));
  return rowToSender(r);
}

function getWithTokens(id, userId = 1) {
  const r = db.prepare('SELECT * FROM core_gmail_senders WHERE id = ? AND user_id = ?')
    .get(Number(id), Number(userId));
  return rowToSender(r, { withTokens: true });
}

function activeSenders(userId = 1) {
  return db.prepare(
    'SELECT * FROM core_gmail_senders WHERE user_id = ? AND is_active = 1 ORDER BY rotation_order ASC, id ASC'
  ).all(Number(userId)).map(r => rowToSender(r));
}

/**
 * Cadastra ou atualiza uma conta a partir de uma autorização concluída.
 *
 * Reautorizar a MESMA conta atualiza os tokens e reativa — é o caminho de
 * recuperação depois de um bloqueio, e não deve criar uma conta duplicada.
 */
function upsertFromOAuth({ email, tokens, displayName = '', userId = 1 }) {
  if (!email) {
    const e = new Error('A autorização não devolveu o e-mail da conta. Tente novamente.');
    e.userFacing = true;
    throw e;
  }
  if (!secretBox.isConfigured()) {
    const e = new Error(
      'Não é possível guardar a autorização com segurança: APP_ENCRYPTION_KEY não está definida no servidor.'
    );
    e.userFacing = true;
    throw e;
  }

  const existing = db.prepare('SELECT * FROM core_gmail_senders WHERE user_id = ? AND email = ?')
    .get(Number(userId), email);

  // Reautorização costuma vir SEM refresh_token — o Google só o entrega na
  // primeira concessão. Perder o que já tínhamos deixaria a conta inutilizável
  // depois do primeiro access_token expirar.
  let merged = tokens;
  if (existing) {
    const old = decryptTokens(existing.tokens_enc) || {};
    merged = Object.assign({}, old, tokens);
    if (!merged.refresh_token && old.refresh_token) merged.refresh_token = old.refresh_token;
  }

  const enc = secretBox.encryptJson(merged);

  if (existing) {
    db.prepare(`UPDATE core_gmail_senders
                SET tokens_enc = ?, display_name = ?, is_active = 1,
                    last_error = NULL, error_class = NULL, consecutive_failures = 0,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`)
      .run(enc, displayName || existing.display_name || '', existing.id);

    logCore('gmail', 'sender_reauthorized', `Conta de envio reautorizada: ${email}.`, { email });
    return Object.assign(get(existing.id, userId), { created: false });
  }

  const count = db.prepare('SELECT COUNT(*) c FROM core_gmail_senders WHERE user_id = ?')
    .get(Number(userId)).c;

  const info = db.prepare(`INSERT INTO core_gmail_senders
      (user_id, email, display_name, tokens_enc, is_active, is_primary, rotation_order)
      VALUES (?,?,?,?,1,?,?)`)
    .run(Number(userId), email, displayName || '', enc, count === 0 ? 1 : 0, count);

  logCore('gmail', 'sender_added', `Nova conta de envio: ${email}.`, { email, total: count + 1 });
  logSeasonal('sender_added', `Conta de envio adicionada: ${email}. Agora são ${count + 1} em rodízio.`);

  return Object.assign(get(Number(info.lastInsertRowid), userId), { created: true });
}

function setActive(id, active, userId = 1) {
  const s = get(id, userId);
  if (!s) { const e = new Error('Conta de envio não encontrada.'); e.userFacing = true; e.status = 404; throw e; }

  db.prepare(`UPDATE core_gmail_senders SET is_active = ?, updated_at = CURRENT_TIMESTAMP,
              consecutive_failures = CASE WHEN ? = 1 THEN 0 ELSE consecutive_failures END
              WHERE id = ? AND user_id = ?`)
    .run(active ? 1 : 0, active ? 1 : 0, Number(id), Number(userId));

  logSeasonal(active ? 'sender_enabled' : 'sender_disabled',
    `Conta ${s.email} ${active ? 'reativada' : 'desativada'} no rodízio de envio.`);
  return get(id, userId);
}

/** Teto diário desta conta. Acima do limite do provedor não existe promessa. */
function setDailyLimit(id, limit, userId = 1) {
  const s = get(id, userId);
  if (!s) { const e = new Error('Conta de envio não encontrada.'); e.userFacing = true; e.status = 404; throw e; }

  let v = limit === null || limit === '' ? null : parseInt(limit, 10);
  if (v !== null) {
    if (!Number.isFinite(v) || v < 0) {
      const e = new Error('O limite diário precisa ser um número igual ou maior que zero.');
      e.userFacing = true;
      throw e;
    }
    v = Math.min(v, PROVIDER_HARD_LIMIT);
  }

  db.prepare('UPDATE core_gmail_senders SET daily_limit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
    .run(v, Number(id), Number(userId));
  return get(id, userId);
}

function remove(id, userId = 1) {
  const s = get(id, userId);
  if (!s) { const e = new Error('Conta de envio não encontrada.'); e.userFacing = true; e.status = 404; throw e; }

  db.prepare('DELETE FROM core_gmail_senders WHERE id = ? AND user_id = ?').run(Number(id), Number(userId));
  db.prepare('DELETE FROM core_gmail_sender_quota WHERE sender_id = ?').run(Number(id));

  // A conta primária não pode simplesmente sumir: promove a próxima ativa.
  if (s.isPrimary) {
    const next = db.prepare(
      'SELECT id FROM core_gmail_senders WHERE user_id = ? AND is_active = 1 ORDER BY rotation_order ASC LIMIT 1'
    ).get(Number(userId));
    if (next) db.prepare('UPDATE core_gmail_senders SET is_primary = 1 WHERE id = ?').run(next.id);
  }

  logCore('gmail', 'sender_removed', `Conta de envio removida: ${s.email}.`, { email: s.email });
  return { removed: true, email: s.email };
}

// ---------------------------------------------------------------------------
// Cota por conta
// ---------------------------------------------------------------------------

/**
 * Teto efetivo de uma conta.
 *
 * Sem limite próprio, a conta recebe uma fatia igual do teto global do dia —
 * assim acrescentar uma conta redistribui em vez de multiplicar o risco sem
 * ninguém perceber.
 */
function effectiveLimit(sender, globalCap, activeCount) {
  if (sender.dailyLimit != null) return Math.min(sender.dailyLimit, PROVIDER_HARD_LIMIT);
  if (!activeCount) return 0;
  const share = Math.ceil(globalCap / activeCount);
  return Math.min(share, DEFAULT_PER_SENDER_LIMIT, PROVIDER_HARD_LIMIT);
}

function ensureQuotaRow(senderId, limit, dateStr = todayKey()) {
  db.prepare(`INSERT INTO core_gmail_sender_quota (date_str, sender_id, count_sent, max_limit)
              VALUES (?,?,0,?)
              ON CONFLICT(date_str, sender_id) DO UPDATE SET max_limit = ?`)
    .run(dateStr, Number(senderId), Number(limit), Number(limit));
  return db.prepare('SELECT * FROM core_gmail_sender_quota WHERE date_str = ? AND sender_id = ?')
    .get(dateStr, Number(senderId));
}

/**
 * Reserva UMA unidade da cota DESTA conta, de forma atômica.
 * Mesma mecânica da cota global: checagem e incremento na mesma instrução.
 */
function reserveSlot(senderId, limit, dateStr = todayKey()) {
  ensureQuotaRow(senderId, limit, dateStr);
  const r = db.prepare(`UPDATE core_gmail_sender_quota
                        SET count_sent = count_sent + 1, updated_at = CURRENT_TIMESTAMP
                        WHERE date_str = ? AND sender_id = ? AND count_sent < max_limit`)
    .run(dateStr, Number(senderId));
  return r.changes === 1;
}

/** Devolve a reserva quando o e-mail NÃO saiu. A cota conta sucessos. */
function releaseSlot(senderId, dateStr = todayKey()) {
  db.prepare(`UPDATE core_gmail_sender_quota
              SET count_sent = MAX(0, count_sent - 1), updated_at = CURRENT_TIMESTAMP
              WHERE date_str = ? AND sender_id = ?`)
    .run(dateStr, Number(senderId));
}

// ---------------------------------------------------------------------------
// Rodízio
// ---------------------------------------------------------------------------

/**
 * Escolhe a próxima conta e já reserva a vaga dela.
 *
 * Rodízio de verdade — um envio por conta, em ordem, recomeçando. Conta sem
 * cota disponível é pulada, não trava a fila. Devolve `null` quando nenhuma
 * conta ativa tem vaga: aí quem chamou decide se adia ou para.
 *
 * @param {number} globalCap teto do produto para o dia
 * @returns {{sender:object, limit:number, dateStr:string}|null}
 */
function nextAvailable({ globalCap, userId = 1, only = null, dateStr = todayKey() } = {}) {
  let pool = activeSenders(userId);
  if (Array.isArray(only) && only.length) {
    const allow = new Set(only.map(Number));
    pool = pool.filter(s => allow.has(s.id));
  }
  if (!pool.length) return null;

  // Quem enviou MENOS hoje vai primeiro.
  //
  // A ordenação óbvia seria por `last_used_at`, mas CURRENT_TIMESTAMP tem
  // precisão de segundo: dois envios no mesmo segundo empatam e a alternância
  // "1 por 1" deixa de ser exata. A contagem do dia não empata por acidente —
  // e, de quebra, reequilibra sozinha quando uma conta volta do bloqueio com a
  // contagem atrasada.
  const sentToday = new Map();
  for (const row of db.prepare(
    'SELECT sender_id, count_sent FROM core_gmail_sender_quota WHERE date_str = ?'
  ).all(dateStr)) {
    sentToday.set(row.sender_id, row.count_sent);
  }

  pool.sort((a, b) => {
    const ca = sentToday.get(a.id) || 0;
    const cb = sentToday.get(b.id) || 0;
    if (ca !== cb) return ca - cb;
    return a.rotationOrder - b.rotationOrder;
  });

  for (const s of pool) {
    const limit = effectiveLimit(s, globalCap, pool.length);
    if (limit <= 0) continue;
    if (reserveSlot(s.id, limit, dateStr)) {
      db.prepare('UPDATE core_gmail_senders SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(s.id);
      return { sender: s, limit, dateStr };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resultado do envio
// ---------------------------------------------------------------------------

function recordSuccess(senderId) {
  db.prepare(`UPDATE core_gmail_senders
              SET last_success_at = CURRENT_TIMESTAMP, consecutive_failures = 0,
                  last_error = NULL, error_class = NULL, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`).run(Number(senderId));
}

/**
 * Registra a falha e, se for de autorização, tira a conta do rodízio.
 *
 * Autorização revogada não melhora com tentativa: insistir só gasta a fila e
 * deixa o robô parecendo quebrado. Desativar a conta e seguir com as outras é
 * exatamente o "desmarque a conta bloqueada" do sistema de referência — feito
 * automaticamente, porque ninguém está olhando às 3 da manhã.
 */
function recordFailure(senderId, { errorClass, reason }) {
  const s = get(senderId);
  if (!s) return null;

  const fails = (s.consecutiveFailures || 0) + 1;
  const authProblem = errorClass === 'PERMANENT' && /auth|credential|invalid_grant|unauthorized|401|403/i.test(reason || '');
  const shouldDeactivate = authProblem || fails >= AUTO_DEACTIVATE_AFTER;

  db.prepare(`UPDATE core_gmail_senders
              SET consecutive_failures = ?, last_error = ?, error_class = ?,
                  is_active = CASE WHEN ? = 1 THEN 0 ELSE is_active END,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`)
    .run(fails, String(reason || '').slice(0, 400), errorClass || null,
         shouldDeactivate ? 1 : 0, Number(senderId));

  if (shouldDeactivate) {
    logSeasonal('sender_auto_disabled',
      `Conta ${s.email} saiu do rodízio após ${fails} falha(s): ${reason}. ` +
      'As demais contas continuam enviando.', { email: s.email }, 'warn');
    logCore('gmail', 'sender_auto_disabled', `Conta de envio desativada: ${s.email}.`,
      { email: s.email, reason }, null, 'warn');
  }

  return { deactivated: shouldDeactivate, consecutiveFailures: fails };
}

// ---------------------------------------------------------------------------
// Situação para a interface
// ---------------------------------------------------------------------------

function status({ globalCap = 50, userId = 1 } = {}) {
  const dateStr = todayKey();
  const all = list(userId);
  const active = all.filter(s => s.isActive);

  const senders = all.map(s => {
    const limit = effectiveLimit(s, globalCap, active.length || 1);
    const q = db.prepare('SELECT count_sent FROM core_gmail_sender_quota WHERE date_str = ? AND sender_id = ?')
      .get(dateStr, s.id);
    const sent = q ? q.count_sent : 0;
    return Object.assign({}, s, {
      todaySent: sent,
      todayLimit: limit,
      todayRemaining: Math.max(0, limit - sent),
      limitSource: s.dailyLimit != null ? 'configurado' : 'fatia do teto diário'
    });
  });

  const capacity = senders.filter(s => s.isActive).reduce((a, s) => a + s.todayLimit, 0);

  return {
    date: dateStr,
    timezone: timezone(),
    total: all.length,
    active: active.length,
    senders,
    dailyCapacity: Math.min(capacity, globalCap),
    globalCap,
    // Uma conta só é o cenário de risco que este recurso existe para evitar.
    singleAccountWarning: active.length <= 1,
    providerHardLimit: PROVIDER_HARD_LIMIT
  };
}

module.exports = {
  DEFAULT_PER_SENDER_LIMIT, PROVIDER_HARD_LIMIT, AUTO_DEACTIVATE_AFTER,
  todayKey, timezone,
  list, get, getWithTokens, activeSenders,
  upsertFromOAuth, setActive, setDailyLimit, remove,
  effectiveLimit, ensureQuotaRow, reserveSlot, releaseSlot,
  nextAvailable, recordSuccess, recordFailure, status
};
