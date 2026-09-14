/**
 * Credenciais do cliente OAuth do Google (spec de autenticação §27, §32).
 *
 * Existe por um motivo prático: até aqui, as credenciais só podiam vir de
 * variáveis de ambiente. Quem não tem acesso ao arquivo `.env` do servidor
 * ficava sem NENHUM caminho para conectar o Gmail — o botão simplesmente não
 * aparecia, sem dizer o que fazer a respeito.
 *
 * Ordem de precedência, deliberada:
 *
 *   1. variável de ambiente  — quem opera o servidor manda
 *   2. banco (cifrado)       — o que o usuário configurou pela tela
 *
 * O ambiente vem primeiro para que uma implantação gerenciada não seja
 * sobrescrita pela interface.
 *
 * O `client_secret` é guardado CIFRADO com AES-256-GCM. A chave mora em
 * APP_ENCRYPTION_KEY, fora do banco — o secretBox documenta a regra: nunca
 * guardar a chave e o segredo cifrado na mesma tabela.
 *
 * O `client_secret` NUNCA é devolvido por nenhuma rota. A interface recebe
 * apenas se ele existe e as últimas letras do client_id, o suficiente para o
 * usuário conferir que configurou o cliente certo.
 */

const { db, logCore } = require('../config/database');
const secretBox = require('../core/security/secretBox');

const KEY_CLIENT_ID = 'google_oauth_client_id';
const KEY_CLIENT_SECRET = 'google_oauth_client_secret_enc';

/** Caminho de callback do Gmail — precisa bater com o Google Cloud Console. */
const GMAIL_CALLBACK_PATH = '/api/seasonal/gmail/callback';
/** Caminho de callback do login na aplicação (Google Sign-In). */
const SIGNIN_CALLBACK_PATH = '/api/auth/google/callback';

function readSetting(key) {
  const r = db.prepare('SELECT value FROM core_system_settings WHERE key = ?').get(key);
  return r && r.value ? r.value : '';
}

function writeSetting(key, value, description) {
  db.prepare(
    `INSERT INTO core_system_settings (key, value, category, description) VALUES (?,?,'auth',?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  ).run(key, value, description || '');
}

/** Client ID armazenado. Não é segredo — o Google o expõe na própria URL. */
function storedClientId() {
  return readSetting(KEY_CLIENT_ID);
}

/** Decifra o client_secret guardado. Devolve '' quando não há ou não dá. */
function storedClientSecret() {
  const raw = readSetting(KEY_CLIENT_SECRET);
  if (!raw) return '';
  try {
    return secretBox.isEncrypted(raw) ? secretBox.decrypt(raw) : raw;
  } catch (e) {
    // Chave trocada ou valor corrompido: tratamos como ausente, e dizemos.
    logCore('auth', 'google_secret_unreadable',
      'O client_secret do Google não pôde ser decifrado. Pode ser APP_ENCRYPTION_KEY trocada.',
      null, null, 'error');
    return '';
  }
}

/**
 * Base pública da aplicação — a ÚNICA fonte da verdade sobre o domínio.
 *
 * Ordem: APP_BASE_URL (ou PUBLIC_BASE_URL) → o endereço pelo qual a requisição
 * chegou (atrás de proxy: X-Forwarded-Proto / X-Forwarded-Host) → localhost.
 *
 * O caso que este desenho evita: o servidor trocou de domínio e o `.env`
 * continuou apontando para o antigo. O Google então recebe um redirect_uri
 * que não está cadastrado e devolve "redirect_uri_mismatch" — sem dizer que
 * a culpa é de uma variável esquecida. Por isso `domainCheck()` compara o
 * configurado com o endereço real do acesso e avisa ANTES de mandar para o
 * Google.
 */
function explicitBaseUrl() {
  const explicit = process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || '';
  return explicit ? explicit.trim().replace(/\/+$/, '') : '';
}

/** Endereço pelo qual esta requisição chegou, respeitando o proxy reverso. */
function requestBaseUrl(req) {
  if (!req || !req.headers) return '';
  const fwdProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const fwdHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = fwdHost || String(req.headers.host || '').trim();
  if (!host || !/^[a-z0-9.-]+(:[0-9]+)?$/i.test(host)) return '';
  const proto = fwdProto || req.protocol || 'http';
  return `${proto}://${host}`;
}

function baseUrl(req) {
  return explicitBaseUrl() || requestBaseUrl(req) || `http://localhost:${process.env.PORT || 3000}`;
}

function gmailRedirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `${baseUrl(req)}${GMAIL_CALLBACK_PATH}`;
}

function signinRedirectUri(req) {
  return process.env.GOOGLE_SIGNIN_REDIRECT_URI || process.env.GOOGLE_AUTH_REDIRECT_URI
    || `${baseUrl(req)}${SIGNIN_CALLBACK_PATH}`;
}

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch (e) { return ''; }
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/;

/**
 * Confere se o domínio configurado bate com o domínio pelo qual o usuário
 * está acessando. Localhost e rede interna são ignorados: em desenvolvimento
 * é normal acessar por 127.0.0.1 com APP_BASE_URL apontando para produção.
 *
 * Devolve `mismatch: true` com a lista exata de variáveis a corrigir — é a
 * mensagem que a tela mostra no lugar do erro 400 do Google.
 */
function domainCheck(req) {
  const requestBase = requestBaseUrl(req);
  const requestHost = hostOf(requestBase);
  const gmailUri = gmailRedirectUri(req);
  const signinUri = signinRedirectUri(req);
  const configuredHosts = [...new Set([hostOf(explicitBaseUrl()), hostOf(gmailUri), hostOf(signinUri)].filter(Boolean))];

  const local = !requestHost || LOCAL_HOST.test(requestHost);
  const wrong = local ? [] : configuredHosts.filter(h => h !== requestHost);

  const differs = (v) => v && hostOf(v) && hostOf(v) !== requestHost;
  const vars = [];
  if (differs(process.env.APP_BASE_URL)) vars.push('APP_BASE_URL');
  if (differs(process.env.PUBLIC_BASE_URL)) vars.push('PUBLIC_BASE_URL');
  if (differs(process.env.GOOGLE_REDIRECT_URI)) vars.push('GOOGLE_REDIRECT_URI');
  if (differs(process.env.GOOGLE_SIGNIN_REDIRECT_URI)) vars.push('GOOGLE_SIGNIN_REDIRECT_URI');
  if (differs(process.env.GOOGLE_AUTH_REDIRECT_URI)) vars.push('GOOGLE_AUTH_REDIRECT_URI');
  if (differs(process.env.CORS_ORIGIN)) vars.push('CORS_ORIGIN');
  if (process.env.DOMAIN && String(process.env.DOMAIN).trim().toLowerCase() !== requestHost) vars.push('DOMAIN');

  const mismatch = !local && wrong.length > 0;
  return {
    requestBase, requestHost, configuredHosts, mismatch, local,
    variablesToFix: mismatch ? vars : [],
    gmailRedirectUri: gmailUri, signinRedirectUri: signinUri,
    expectedGmailRedirectUri: requestBase ? `${requestBase}${GMAIL_CALLBACK_PATH}` : gmailUri,
    expectedSigninRedirectUri: requestBase ? `${requestBase}${SIGNIN_CALLBACK_PATH}` : signinUri,
    message: mismatch
      ? `O servidor está configurado para ${wrong.join(', ')}, mas você está acessando por ${requestHost}. ` +
        `Corrija no ambiente do servidor (${vars.length ? vars.join(', ') : 'APP_BASE_URL'}) para ${requestBase} e reinicie — ` +
        `ou rode "node scripts/changeDomain.js ${requestHost}". Depois, no Google Cloud Console, cadastre ` +
        `${requestBase}${GMAIL_CALLBACK_PATH} e ${requestBase}${SIGNIN_CALLBACK_PATH} em "URIs de redirecionamento autorizados".`
      : null
  };
}

/**
 * Exige coerência de domínio antes de iniciar um fluxo OAuth. Sem isto o
 * usuário é mandado ao Google só para receber um 400 sem explicação.
 */
function assertDomainConsistent(req) {
  const c = domainCheck(req);
  if (c.mismatch) {
    const e = new Error(c.message);
    e.userFacing = true; e.status = 409; e.code = 'DOMAIN_MISMATCH'; e.domainCheck = c;
    throw e;
  }
  return c;
}

/**
 * As credenciais em vigor, com a origem de cada uma.
 * `source` é o que permite à interface explicar POR QUE algo está como está.
 */
function resolve(req) {
  const envId = process.env.GOOGLE_CLIENT_ID || '';
  const envSecret = process.env.GOOGLE_CLIENT_SECRET || '';

  const dbId = storedClientId();
  const dbSecret = storedClientSecret();

  const clientId = envId || dbId;
  const clientSecret = envSecret || dbSecret;

  return {
    clientId,
    clientSecret,
    gmailRedirectUri: gmailRedirectUri(req),
    signinRedirectUri: signinRedirectUri(req),
    source: envId && envSecret ? 'env' : (clientId && clientSecret ? 'database' : 'none'),
    configured: Boolean(clientId && clientSecret)
  };
}

/** Mascara o client_id para conferência visual, sem expor o valor inteiro. */
function maskClientId(id) {
  if (!id) return '';
  const head = id.slice(0, 12);
  const tail = id.length > 24 ? id.slice(-16) : '';
  return tail ? `${head}…${tail}` : `${head}…`;
}

/**
 * Estado para a interface. NUNCA inclui o client_secret.
 */
function status(req) {
  const r = resolve(req);
  return {
    domain: domainCheck(req),
    configured: r.configured,
    source: r.source,
    managedByEnv: r.source === 'env',
    editable: r.source !== 'env',
    clientIdMasked: maskClientId(r.clientId),
    hasClientId: Boolean(r.clientId),
    hasClientSecret: Boolean(r.clientSecret),
    encryptionConfigured: secretBox.isConfigured(),
    gmailRedirectUri: r.gmailRedirectUri,
    signinRedirectUri: r.signinRedirectUri,
    baseUrl: baseUrl(req),
    baseUrlSource: explicitBaseUrl() ? 'env' : (requestBaseUrl(req) ? 'request' : 'localhost'),
    consoleUrl: 'https://console.cloud.google.com/apis/credentials'
  };
}

const CLIENT_ID_SHAPE = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i;

/**
 * Grava as credenciais informadas pela tela.
 *
 * Valida a FORMA do client_id antes de aceitar: um erro de cópia aqui produz
 * um `invalid_client` no Google que não explica nada ao usuário. Melhor
 * recusar cedo e dizer exatamente o que se espera.
 */
function save({ clientId, clientSecret }) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();

  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    const e = new Error(
      'Estas credenciais vêm de variáveis de ambiente neste servidor e não podem ser alteradas pela interface. ' +
      'Edite GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no ambiente.'
    );
    e.userFacing = true;
    throw e;
  }

  if (!id || !secret) {
    const e = new Error('Informe o Client ID e o Client Secret.');
    e.userFacing = true;
    throw e;
  }

  if (!CLIENT_ID_SHAPE.test(id)) {
    const e = new Error(
      'O Client ID não tem o formato esperado. Ele termina em ".apps.googleusercontent.com" — ' +
      'copie o campo "ID do cliente" do OAuth 2.0 Client ID, não a chave de API nem o número do projeto.'
    );
    e.userFacing = true;
    throw e;
  }

  if (!secretBox.isConfigured()) {
    const e = new Error(
      'Não é possível guardar o Client Secret com segurança: APP_ENCRYPTION_KEY não está definida no servidor. ' +
      'Defina a chave no arquivo .env e reinicie a aplicação.'
    );
    e.userFacing = true;
    throw e;
  }

  writeSetting(KEY_CLIENT_ID, id, 'Client ID do OAuth do Google (não é segredo)');
  writeSetting(KEY_CLIENT_SECRET, secretBox.encrypt(secret), 'Client Secret do OAuth do Google, cifrado em repouso');

  logCore('auth', 'google_credentials_saved',
    'Credenciais do cliente OAuth do Google configuradas pela interface.',
    { clientId: maskClientId(id) });

  return status();
}

/** Remove as credenciais guardadas no banco. Não toca no ambiente. */
function clear() {
  db.prepare('DELETE FROM core_system_settings WHERE key IN (?,?)').run(KEY_CLIENT_ID, KEY_CLIENT_SECRET);
  logCore('auth', 'google_credentials_cleared', 'Credenciais do cliente OAuth do Google removidas.');
  return status();
}

module.exports = {
  KEY_CLIENT_ID, KEY_CLIENT_SECRET,
  GMAIL_CALLBACK_PATH, SIGNIN_CALLBACK_PATH,
  baseUrl, gmailRedirectUri, signinRedirectUri,
  resolve, status, save, clear, maskClientId,
  requestBaseUrl, explicitBaseUrl, domainCheck, assertDomainConsistent
};
