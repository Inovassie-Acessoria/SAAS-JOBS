/**
 * Gmail via OAuth 2.0 (spec §40, §49; §34 do build prompt original).
 *
 * A senha do usuário NUNCA é armazenada, e o caminho de "senha de aplicativo"
 * foi removido. Os tokens ficam em arquivo com permissão restrita, fora do
 * diretório servido pela aplicação, e jamais aparecem em log (spec §74).
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { db, logSeasonal, logCore, uploadsRoot } = require('../config/database');
const secretBox = require('../core/security/secretBox');

const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/userinfo.email'];
const TOKEN_DIR = path.join(uploadsRoot, '.secrets');
const TOKEN_PATH = path.join(TOKEN_DIR, 'gmail_token.json');

function ensureTokenDir() {
  if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
}

/**
 * As credenciais vêm do ambiente OU do que o usuário configurou pela tela.
 * A resolução — e a precedência entre as duas origens — vive em um único
 * lugar, para que o login e o Gmail nunca discordem sobre qual cliente usar.
 */
function credentials(req) {
  const c = require('./googleCredentialsService').resolve(req);
  return {
    clientId: c.clientId,
    clientSecret: c.clientSecret,
    redirectUri: c.gmailRedirectUri
  };
}

function isConfigured() {
  const c = credentials();
  return Boolean(c.clientId && c.clientSecret);
}

function oauthClient(req) {
  const c = credentials(req);
  if (!isConfigured()) {
    const e = new Error('As credenciais do Google não estão configuradas. Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no ambiente.');
    e.userFacing = true;
    throw e;
  }
  return new google.auth.OAuth2(c.clientId, c.clientSecret, c.redirectUri);
}

/**
 * Grava os tokens CIFRADOS (spec §27, §32).
 *
 * O refresh token é uma credencial de longa duração: em texto puro, qualquer
 * leitura do disco daria acesso permanente à conta. A chave fica em
 * APP_ENCRYPTION_KEY, fora do arquivo e fora do banco.
 */
function saveTokens(tokens) {
  ensureTokenDir();

  if (!secretBox.isConfigured()) {
    const e = new Error(
      'Não é possível guardar a autorização do Gmail com segurança: APP_ENCRYPTION_KEY não está definida. ' +
      'Gere uma chave e adicione ao .env antes de conectar a conta.'
    );
    e.userFacing = true;
    throw e;
  }

  fs.writeFileSync(TOKEN_PATH, secretBox.encryptJson(tokens), { mode: 0o600 });
}

function loadTokens() {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    const raw = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (!raw) return null;

    if (secretBox.isEncrypted(raw)) return secretBox.decryptJson(raw);

    // Arquivo da versão anterior, em texto puro: recifra na primeira leitura e
    // reescreve, para que o segredo não continue exposto em disco.
    const legacy = JSON.parse(raw);
    try {
      saveTokens(legacy);
      logCore('gmail', 'tokens_encrypted',
        'Tokens do Gmail que estavam em texto puro foram recifrados em repouso.');
    } catch (e) {
      logCore('gmail', 'tokens_encryption_pending',
        'Tokens do Gmail estão em texto puro e não puderam ser cifrados: APP_ENCRYPTION_KEY ausente.',
        null, null, 'warn');
    }
    return legacy;
  } catch (e) {
    logCore('gmail', 'tokens_unreadable',
      'Não foi possível ler a autorização do Gmail. Pode ser chave de criptografia trocada ou arquivo corrompido.',
      null, null, 'error');
    return null;
  }
}

function clearTokens() {
  try { if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH); } catch (e) {}
}

function setConnectionState({ connected, user = '', authStatus }) {
  db.prepare(`UPDATE seasonal_config SET gmail_connected = ?, gmail_user = ?,
              gmail_auth_status = ?, updated_at = CURRENT_TIMESTAMP`)
    .run(connected ? 1 : 0, user || '', authStatus);
}

/**
 * URL para o usuário autorizar. Nenhum segredo é exposto para o cliente.
 *
 * Com `addSender`, o objetivo é ACRESCENTAR uma conta ao rodízio, não trocar a
 * atual. Aí `select_account` é obrigatório: sem ele o Google reautoriza em
 * silêncio a conta já logada no navegador, e a segunda conta nunca entra — o
 * usuário clica, "dá certo", e nada muda.
 */
function getAuthUrl({ addSender = false, req = null } = {}) {
  // `req` permite derivar o redirect_uri do endereço real do acesso quando o
  // ambiente não fixa APP_BASE_URL — e é o que a checagem de domínio usa.
  const client = oauthClient(req);
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: addSender ? 'consent select_account' : 'consent',
    scope: SCOPES,
    state: addSender ? 'add_sender' : 'primary'
  });
}

/**
 * Traduz a resposta de erro do Google para uma frase que diz o que fazer.
 *
 * Sem isto, qualquer recusa na troca do código virava "Algo deu errado" na
 * janela de autorização — e o motivo real (URI de retorno não cadastrada,
 * segredo trocado, código reutilizado) ficava só no log, onde ninguém olha na
 * hora. O código do Google segue junto para que o log e a tela concordem.
 */
function describeGoogleError(err, req = null) {
  const data = (err && err.response && err.response.data) || {};
  const code = String(data.error || (err && err.code) || '').trim();
  const detail = String(data.error_description || (err && err.message) || '').trim();
  const redirectUri = credentials(req).redirectUri;

  const known = {
    redirect_uri_mismatch:
      'O Google recusou o endereço de retorno. No Google Cloud Console, abra o OAuth Client e cadastre ' +
      `exatamente esta URI em "URIs de redirecionamento autorizados": ${redirectUri}`,
    invalid_client:
      'O Google não reconheceu o Client ID ou o Client Secret. Confira se os dois vêm do MESMO OAuth Client ' +
      'e se o Client Secret não foi redefinido no console depois de configurado aqui.',
    unauthorized_client:
      'Este OAuth Client não está autorizado para esse tipo de fluxo. Ele precisa ser do tipo "Aplicativo da Web".',
    invalid_grant:
      'O código de autorização expirou ou já foi usado. Feche esta janela e clique em Conectar de novo.',
    invalid_request:
      'O Google considerou o pedido malformado. Confira o Client ID e a URI de retorno cadastrada.'
  };

  const e = new Error(known[code] ||
    `O Google recusou a autorização (${code || 'erro desconhecido'}${detail ? `: ${detail}` : ''}).`);
  e.userFacing = true;
  e.status = 400;
  e.googleError = code || null;
  e.googleDetail = detail || null;
  return e;
}

async function handleCallback(code, { userId = 1, req = null } = {}) {
  // O mesmo redirect_uri do início do fluxo precisa ir na troca do código.
  const client = oauthClient(req);

  let tokens;
  try {
    ({ tokens } = await client.getToken(code));
  } catch (err) {
    const e = describeGoogleError(err, req);
    logCore('gmail', 'oauth_exchange_failed',
      `A troca do código de autorização falhou: ${e.googleError || 'erro'}${e.googleDetail ? ` — ${e.googleDetail}` : ''}.`,
      { googleError: e.googleError, redirectUri: credentials(req).redirectUri }, null, 'error');
    throw e;
  }

  if (!tokens.refresh_token) {
    const existing = loadTokens();
    if (existing && existing.refresh_token) tokens.refresh_token = existing.refresh_token;
  }
  saveTokens(tokens);
  client.setCredentials(tokens);

  let email = '';
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const info = await oauth2.userinfo.get();
    email = (info.data && info.data.email) || '';
  } catch (e) { /* o e-mail é informativo; a conexão não depende dele */ }

  // Toda autorização concluída entra no rodízio de contas (F1.3) — inclusive a
  // primeira. Assim não existem dois caminhos divergentes: "a conta" e "as
  // contas extras" são a mesma coisa, e o rodízio com uma conta só é o
  // comportamento antigo, sem código separado para ele.
  let sender = null;
  try {
    const senders = require('./gmailSenderService');
    sender = senders.upsertFromOAuth({ email, tokens, displayName: email, userId });
  } catch (e) {
    // Sem registro de contas o envio único ainda funciona pelo token em arquivo.
    logCore('gmail', 'sender_register_failed',
      `A conta autorizou, mas não entrou no rodízio: ${e.message}`, { email }, null, 'warn');
  }

  setConnectionState({ connected: true, user: email, authStatus: 'OK' });
  logSeasonal('gmail_connected', `Conta do Gmail conectada${email ? `: ${email}` : ''}.`);
  logCore('gmail', 'oauth_connected', 'Autorização do Gmail concluída.', { user: email });

  return { connected: true, email, sender };
}

async function authorizedClient() {
  const tokens = loadTokens();
  if (!tokens) {
    const e = new Error('A conta do Gmail não está conectada. Conecte-a em Integrações.');
    e.permanent = true; e.userFacing = true;
    throw e;
  }

  const client = oauthClient();
  client.setCredentials(tokens);

  client.on('tokens', (t) => {
    const merged = Object.assign({}, loadTokens() || {}, t);
    saveTokens(merged);
  });

  return client;
}

async function testConnection() {
  const steps = [];
  const add = (step, ok, detail) => steps.push({ step, ok, detail });

  if (!isConfigured()) {
    add('Credenciais do Google', false, 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET não definidos no ambiente.');
    setConnectionState({ connected: false, authStatus: 'NOT_CONFIGURED' });
    return {
      success: false, health: 'NOT_CONFIGURED', steps,
      userMessage: 'As credenciais do Google ainda não foram configuradas neste servidor.'
    };
  }
  add('Credenciais do Google', true, 'Client ID e secret presentes.');

  const tokens = loadTokens();
  if (!tokens) {
    add('Autorização', false, 'Nenhuma conta autorizada.');
    setConnectionState({ connected: false, authStatus: 'DISCONNECTED' });
    return {
      success: false, health: 'DISCONNECTED', steps,
      userMessage: 'Nenhuma conta do Gmail conectada. Clique em Conectar Gmail para autorizar o envio.'
    };
  }
  add('Autorização', true, 'Tokens presentes.');

  try {
    const client = await authorizedClient();
    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress;
    add('Conexão com o Gmail', true, `Conta ${email}`);
    setConnectionState({ connected: true, user: email, authStatus: 'OK' });
    return { success: true, health: 'HEALTHY', steps, email, userMessage: `Gmail conectado como ${email}.` };
  } catch (err) {
    const expired = /invalid_grant|unauthorized|invalid credentials/i.test(err.message || '');
    add('Conexão com o Gmail', false, expired ? 'Autorização expirada ou revogada.' : err.message);
    setConnectionState({ connected: false, authStatus: expired ? 'EXPIRED' : 'ERROR' });
    return {
      success: false,
      health: expired ? 'REQUIRES_ATTENTION' : 'ERROR',
      steps,
      userMessage: expired
        ? 'A autorização do Gmail expirou. Reconecte a conta para continuar enviando candidaturas.'
        : 'Não foi possível falar com o Gmail agora. As candidaturas continuam na fila.'
    };
  }
}

function disconnect() {
  clearTokens();
  setConnectionState({ connected: false, user: '', authStatus: 'DISCONNECTED' });
  logSeasonal('gmail_disconnected', 'Conta do Gmail desconectada.');
  return { connected: false };
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

function buildMime({ from, to, subject, text, attachments }) {
  const boundary = `b_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const lines = [];

  lines.push(`From: ${from}`);
  lines.push(`To: ${to}`);
  lines.push(`Subject: ${encodeHeader(subject)}`);
  lines.push('MIME-Version: 1.0');
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push('');
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\n'));

  for (const a of (attachments || [])) {
    const content = fs.readFileSync(a.path);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: application/octet-stream; name="${a.filename}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${a.filename}"`);
    lines.push('');
    lines.push(content.toString('base64').replace(/(.{76})/g, '$1\n'));
  }

  lines.push('');
  lines.push(`--${boundary}--`);

  return Buffer.from(lines.join('\r\n'), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeHeader(s) {
  return /[^\x20-\x7E]/.test(s)
    ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
    : s;
}

/**
 * Constrói um cliente autorizado para UMA conta específica do rodízio (F1.3).
 *
 * Os tokens de cada conta vivem cifrados no banco, não no arquivo único de
 * antes. A renovação do access_token é gravada de volta na própria conta — sem
 * isso, a primeira expiração deixaria aquela conta inutilizável.
 */
async function clientForSender(senderId) {
  const senders = require('./gmailSenderService');
  const s = senders.getWithTokens(senderId);

  if (!s || !s.tokens) {
    const e = new Error('A conta de envio não está autorizada. Reconecte-a em Contas de envio.');
    e.permanent = true; e.userFacing = true;
    throw e;
  }

  const client = oauthClient();
  client.setCredentials(s.tokens);

  client.on('tokens', (t) => {
    try {
      senders.upsertFromOAuth({ email: s.email, tokens: Object.assign({}, s.tokens, t) });
    } catch (e) { /* renovação é oportunista; o envio não depende de gravá-la */ }
  });

  return { client, email: s.email };
}

/**
 * Envia uma mensagem.
 *
 * Com `senderId`, sai pela conta indicada pelo rodízio. Sem ele, pela conta
 * única de antes — o caminho original continua funcionando para quem tem só
 * uma conta conectada.
 */
async function sendMail({ to, subject, text, attachments = [], senderId = null }) {
  let client, from;

  if (senderId) {
    const r = await clientForSender(senderId);
    client = r.client;
    from = r.email;
  } else {
    client = await authorizedClient();
    const cfg = db.prepare('SELECT gmail_user FROM seasonal_config ORDER BY id LIMIT 1').get();
    from = (cfg && cfg.gmail_user) || 'me';
  }

  const gmail = google.gmail({ version: 'v1', auth: client });

  const raw = buildMime({ from, to, subject, text, attachments });

  try {
    const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    return { messageId: res.data.id, threadId: res.data.threadId };
  } catch (err) {
    // Normaliza o erro para que o classificador da fila decida retry vs falha.
    const status = err.code || (err.response && err.response.status);
    const e = new Error(err.message || 'Falha no envio via Gmail.');
    e.responseCode = status;
    if (status === 401 || status === 403 || /invalid_grant/i.test(err.message || '')) {
      e.permanent = true;
      e.senderId = senderId || null;

      // Com rodízio, a falha é DAQUELA conta — marcar o Gmail todo como
      // desconectado faria o sistema parecer quebrado enquanto as outras contas
      // continuam perfeitamente capazes de enviar. Quem desativa a conta é o
      // registro de contas, que já sabe distinguir uma das outras.
      if (!senderId) setConnectionState({ connected: false, authStatus: 'EXPIRED' });
    }
    throw e;
  }
}

function status() {
  const cfg = db.prepare('SELECT gmail_connected, gmail_user, gmail_auth_status FROM seasonal_config ORDER BY id LIMIT 1').get() || {};
  return {
    configured: isConfigured(),
    connected: Boolean(cfg.gmail_connected),
    user: cfg.gmail_user || '',
    authStatus: cfg.gmail_auth_status || 'DISCONNECTED',
    hasTokens: fs.existsSync(TOKEN_PATH),
    encryptionConfigured: secretBox.isConfigured(),
    scopes: SCOPES
  };
}

module.exports = {
  SCOPES, isConfigured, getAuthUrl, handleCallback, describeGoogleError,
  testConnection, disconnect, sendMail, status, buildMime
};
