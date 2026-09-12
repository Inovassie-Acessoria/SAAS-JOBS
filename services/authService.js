/**
 * Autenticação da APLICAÇÃO (spec de autenticação §1A, §3, §4, §18, §19).
 *
 * Distinção que organiza tudo:
 *
 *   Login na aplicação   → quem é o usuário do Job Intelligence
 *   Conexão de provedor  → autorização separada com Gupy / Indeed / Gmail
 *
 * Entrar com o Google NÃO autentica o usuário na Gupy, no Indeed nem concede
 * permissão de envio no Gmail. O login base pede apenas escopos de identidade
 * (openid, email, profile); a permissão do Gmail é incremental e vem depois.
 */

const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { db, logCore } = require('../config/database');

// Login base: SOMENTE identidade (spec §19).
const LOGIN_SCOPES = ['openid', 'email', 'profile'];

const SESSION_COOKIE = 'ji_session';
const STATE_COOKIE = 'ji_oauth_state';
const DEFAULT_TTL_SECONDS = 7 * 24 * 3600;

class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.userFacing = true;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

/**
 * O login com Google aceita um cliente OAuth próprio (GOOGLE_AUTH_*) e, quando
 * ele não existe, reaproveita o mesmo cliente configurado para o Gmail. Um
 * único OAuth Client no Google Cloud pode atender aos dois, bastando cadastrar
 * as duas URIs de redirecionamento — é um passo a menos para quem está
 * configurando, sem impedir quem quer clientes separados.
 *
 * `enabled` continua sendo uma decisão EXPLÍCITA. Ter credencial não liga o
 * login sozinho: ligá-lo por acidente trocaria o modo operador local por uma
 * tela de login que o usuário talvez ainda não consiga atravessar.
 */
function config() {
  const shared = require('./googleCredentialsService');
  const fallback = shared.resolve();
  const enabledSetting = (() => {
    try {
      const r = db.prepare("SELECT value FROM core_system_settings WHERE key = 'google_signin_enabled'").get();
      return r && r.value === '1';
    } catch (e) { return false; }
  })();

  return {
    enabled: process.env.GOOGLE_AUTH_ENABLED === 'true' || enabledSetting,
    clientId: process.env.GOOGLE_AUTH_CLIENT_ID || fallback.clientId,
    clientSecret: process.env.GOOGLE_AUTH_CLIENT_SECRET || fallback.clientSecret,
    redirectUri: process.env.GOOGLE_AUTH_REDIRECT_URI || shared.signinRedirectUri(),
    ttlSeconds: parseInt(process.env.SESSION_TTL_SECONDS || String(DEFAULT_TTL_SECONDS), 10),
    cookieSecure: process.env.SESSION_COOKIE_SECURE !== 'false',
    sameSite: process.env.SESSION_COOKIE_SAMESITE || 'Lax'
  };
}

/** O login com Google só está disponível quando de fato configurado. */
function googleConfigured() {
  const c = config();
  return Boolean(c.enabled && c.clientId && c.clientSecret);
}

/**
 * Modo operador local: quando o Google não está configurado, a instalação opera
 * com um único usuário local, SEM autenticação.
 *
 * Isto é declarado abertamente na interface e nos diagnósticos — não é um login
 * do Google falsificado (spec §33). Serve para uso local; em produção o spec §26
 * exige domínio próprio com HTTPS e o cliente do Google configurado.
 */
function localOperatorMode() { return !googleConfigured(); }

function oauthClient() {
  const c = config();
  if (!googleConfigured()) {
    throw new AuthError(
      'O login com Google não está configurado neste servidor. Defina GOOGLE_AUTH_CLIENT_ID e GOOGLE_AUTH_CLIENT_SECRET.',
      503
    );
  }
  return new OAuth2Client(c.clientId, c.clientSecret, c.redirectUri);
}

// ---------------------------------------------------------------------------
// Usuários e identidades
// ---------------------------------------------------------------------------

function getUser(id) {
  return db.prepare('SELECT * FROM core_users WHERE id = ?').get(Number(id)) || null;
}

/** Usuário do modo operador local — criado na migração, nunca duplicado. */
function localOperator() {
  let u = db.prepare("SELECT * FROM core_users WHERE auth_mode = 'local_operator' ORDER BY id LIMIT 1").get();
  if (!u) {
    const info = db.prepare(
      `INSERT INTO core_users (email, email_verified, display_name, auth_mode, last_login_at)
       VALUES (NULL, 0, 'Operador local', 'local_operator', CURRENT_TIMESTAMP)`
    ).run();
    db.prepare(
      `INSERT OR IGNORE INTO core_auth_identities (user_id, provider, subject) VALUES (?, 'local', 'local-operator')`
    ).run(Number(info.lastInsertRowid));
    u = getUser(Number(info.lastInsertRowid));
  }
  return u;
}

/**
 * Resolve (ou cria) o usuário a partir da identidade verificada do Google.
 * A chave é o claim `sub`, estável; o e-mail pode mudar (spec §3).
 */
function resolveGoogleUser(payload) {
  const sub = payload.sub;
  if (!sub) throw new AuthError('A identidade do Google veio sem identificador estável.');

  const identity = db.prepare(
    "SELECT * FROM core_auth_identities WHERE provider = 'google' AND subject = ?"
  ).get(sub);

  if (identity) {
    db.prepare(`UPDATE core_users SET email = ?, email_verified = ?, display_name = ?, avatar_url = ?,
                last_login_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(payload.email || null, payload.email_verified ? 1 : 0,
           payload.name || '', payload.picture || null, identity.user_id);
    db.prepare(`UPDATE core_auth_identities SET email = ?, email_verified = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(payload.email || null, payload.email_verified ? 1 : 0, identity.id);
    return getUser(identity.user_id);
  }

  // Primeira entrada deste Google: se já existe o operador local, ele é
  // promovido, para que os dados já cadastrados continuem com o dono.
  const local = db.prepare("SELECT * FROM core_users WHERE auth_mode = 'local_operator' ORDER BY id LIMIT 1").get();
  let userId;

  if (local) {
    db.prepare(`UPDATE core_users SET email = ?, email_verified = ?, display_name = ?, avatar_url = ?,
                auth_mode = 'google', last_login_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(payload.email || null, payload.email_verified ? 1 : 0,
           payload.name || '', payload.picture || null, local.id);
    userId = local.id;
    logCore('auth', 'local_operator_promoted',
      'O operador local passou a ser identificado por uma conta Google. Os dados já cadastrados seguem com o mesmo dono.',
      { userId });
  } else {
    const info = db.prepare(
      `INSERT INTO core_users (email, email_verified, display_name, avatar_url, auth_mode, last_login_at)
       VALUES (?,?,?,?, 'google', CURRENT_TIMESTAMP)`
    ).run(payload.email || null, payload.email_verified ? 1 : 0, payload.name || '', payload.picture || null);
    userId = Number(info.lastInsertRowid);
  }

  db.prepare(
    `INSERT OR IGNORE INTO core_auth_identities (user_id, provider, subject, email, email_verified, last_seen_at)
     VALUES (?, 'google', ?, ?, ?, CURRENT_TIMESTAMP)`
  ).run(userId, sub, payload.email || null, payload.email_verified ? 1 : 0);

  logCore('auth', 'user_signed_in', `Login com Google concluído${payload.email ? `: ${payload.email}` : ''}.`, { userId });
  return getUser(userId);
}

// ---------------------------------------------------------------------------
// Fluxo OAuth
// ---------------------------------------------------------------------------

/** URL de autorização com `state` assinado, para proteção CSRF (spec §3, §35). */
function beginLogin({ returnTo = '/' } = {}) {
  const client = oauthClient();
  const state = crypto.randomBytes(24).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');

  const url = client.generateAuthUrl({
    scope: LOGIN_SCOPES,          // apenas identidade — nada de gmail.send aqui (§19)
    access_type: 'online',        // o login não precisa de refresh token
    include_granted_scopes: true, // preserva permissões já concedidas (§18)
    state,
    nonce,
    prompt: 'select_account'
  });

  return { url, state, nonce, returnTo };
}

/**
 * Troca o código pela identidade e verifica o ID token.
 * Valida assinatura, emissor, audiência e expiração (spec §3).
 */
async function completeLogin({ code, state, expectedState, nonce, userAgent, ip }) {
  if (!code) throw new AuthError('Código de autorização ausente.', 400);
  if (!expectedState || !state || state !== expectedState) {
    throw new AuthError('A verificação de segurança do login falhou. Tente entrar novamente.', 400);
  }

  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw new AuthError('O Google não devolveu uma identidade verificável.');

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: config().clientId
  });
  const payload = ticket.getPayload();

  if (!payload) throw new AuthError('Não foi possível ler a identidade do Google.');
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
    throw new AuthError('A identidade recebida não foi emitida pelo Google.');
  }
  if (payload.aud !== config().clientId) {
    throw new AuthError('A identidade recebida foi emitida para outra aplicação.');
  }
  if (nonce && payload.nonce && payload.nonce !== nonce) {
    throw new AuthError('A verificação de integridade do login falhou.');
  }

  const user = resolveGoogleUser(payload);
  const session = createSession(user.id, { userAgent, ip });
  return { user, session };
}

// ---------------------------------------------------------------------------
// Sessões
// ---------------------------------------------------------------------------

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 32);
}

function createSession(userId, { product = null, country = null, userAgent = null, ip = null } = {}) {
  const id = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config().ttlSeconds * 1000).toISOString();

  db.prepare(`INSERT INTO core_sessions (id, user_id, product, country, user_agent, ip_hash, expires_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, userId, product, country, (userAgent || '').slice(0, 200), hashIp(ip), expiresAt);

  return { id, userId, expiresAt };
}

/**
 * Interpreta um instante gravado no banco.
 *
 * Duas formas convivem: o ISO com `Z` que createSession grava, e o formato do
 * SQLite (`YYYY-MM-DD HH:MM:SS`, sempre UTC) que qualquer CURRENT_TIMESTAMP
 * produz. O JavaScript lê a segunda como hora LOCAL — o que, dependendo do
 * fuso, faria uma sessão expirada continuar valendo. Normalizar aqui evita isso.
 */
function parseDbTimestamp(value) {
  if (!value) return NaN;
  const s = String(value).trim();
  // Formato do SQLite, sem fuso declarado: tratar como UTC.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return Date.parse(s.replace(' ', 'T') + 'Z');
  }
  return Date.parse(s);
}

/** Devolve a sessão válida, ou null. Sessão expirada ou revogada não vale. */
function getSession(sessionId) {
  if (!sessionId) return null;
  const s = db.prepare('SELECT * FROM core_sessions WHERE id = ?').get(String(sessionId));
  if (!s) return null;
  if (s.revoked_at) return null;

  const expiresAt = parseDbTimestamp(s.expires_at);
  // Data ilegível é tratada como expirada: na dúvida, não autentica.
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

  db.prepare('UPDATE core_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(s.id);
  return s;
}

/** Grava o contexto de produto/país na sessão (spec §4, §22). */
function setSessionContext(sessionId, { product, country }) {
  db.prepare('UPDATE core_sessions SET product = ?, country = ? WHERE id = ?')
    .run(product || null, country || null, String(sessionId));
}

/** Encerrar a sessão NÃO desconecta o Google nem revoga o Gmail (spec §34). */
function revokeSession(sessionId) {
  db.prepare('UPDATE core_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL')
    .run(String(sessionId));
  return { signedOut: true };
}

function revokeAllSessions(userId, exceptId = null) {
  const r = exceptId
    ? db.prepare('UPDATE core_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id != ? AND revoked_at IS NULL').run(userId, exceptId)
    : db.prepare('UPDATE core_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL').run(userId);
  return { revoked: r.changes };
}

function listSessions(userId) {
  return db.prepare(`SELECT id, product, country, user_agent, created_at, expires_at, last_seen_at, revoked_at
                     FROM core_sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 50`)
    .all(userId)
    .map(s => Object.assign(s, {
      // O token nunca é devolvido inteiro para a interface.
      id: s.id.slice(0, 8) + '…',
      active: !s.revoked_at && parseDbTimestamp(s.expires_at) > Date.now()
    }));
}

function purgeExpiredSessions() {
  const r = db.prepare("DELETE FROM core_sessions WHERE expires_at < datetime('now','-30 day')").run();
  return { removed: r.changes };
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** HttpOnly + Secure + SameSite, como o spec §4 pede. */
function buildCookie(name, value, { maxAgeSeconds, clear = false } = {}) {
  const c = config();
  const parts = [`${name}=${clear ? '' : encodeURIComponent(value)}`, 'Path=/', 'HttpOnly'];
  if (c.cookieSecure) parts.push('Secure');
  parts.push(`SameSite=${c.sameSite}`);
  parts.push(clear ? 'Max-Age=0' : `Max-Age=${maxAgeSeconds || c.ttlSeconds}`);
  return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Estado para a interface
// ---------------------------------------------------------------------------

function authStatus(user) {
  const c = config();
  return {
    googleConfigured: googleConfigured(),
    localOperatorMode: localOperatorMode(),
    loginScopes: LOGIN_SCOPES,
    user: user ? {
      id: user.id,
      email: user.email,
      displayName: user.display_name || (user.auth_mode === 'local_operator' ? 'Operador local' : ''),
      avatarUrl: user.avatar_url,
      authMode: user.auth_mode,
      lastLoginAt: user.last_login_at
    } : null,
    // Aviso honesto: em modo local não há autenticação de verdade.
    notice: localOperatorMode()
      ? 'Esta instalação está em modo operador local: não há login e qualquer pessoa com acesso à porta do servidor usa o sistema. Configure o login com Google antes de expor a aplicação na internet.'
      : null,
    // Entrar com o Google não concede nada além de identidade (§18, §19).
    disclaimer: 'Entrar com o Google identifica você no Job Intelligence. Isso não conecta sua conta da Gupy ou do Indeed, nem autoriza o envio de e-mails pelo Gmail — essas permissões são pedidas separadamente.'
  };
}

module.exports = {
  LOGIN_SCOPES, SESSION_COOKIE, STATE_COOKIE, AuthError,
  config, googleConfigured, localOperatorMode,
  getUser, localOperator, resolveGoogleUser,
  beginLogin, completeLogin,
  createSession, getSession, setSessionContext,
  revokeSession, revokeAllSessions, listSessions, purgeExpiredSessions,
  parseCookies, buildCookie, authStatus, parseDbTimestamp
};
