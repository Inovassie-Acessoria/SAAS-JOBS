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
 * Base pública da aplicação, usada para montar as URIs de redirecionamento.
 * Em produção, APP_BASE_URL é o endereço real; localmente cai no localhost.
 */
function baseUrl() {
  const explicit = process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || '';
  if (explicit) return explicit.replace(/\/+$/, '');
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
}

function gmailRedirectUri() {
  return process.env.GOOGLE_REDIRECT_URI || `${baseUrl()}${GMAIL_CALLBACK_PATH}`;
}

function signinRedirectUri() {
  return process.env.GOOGLE_SIGNIN_REDIRECT_URI || `${baseUrl()}${SIGNIN_CALLBACK_PATH}`;
}

/**
 * As credenciais em vigor, com a origem de cada uma.
 * `source` é o que permite à interface explicar POR QUE algo está como está.
 */
function resolve() {
  const envId = process.env.GOOGLE_CLIENT_ID || '';
  const envSecret = process.env.GOOGLE_CLIENT_SECRET || '';

  const dbId = storedClientId();
  const dbSecret = storedClientSecret();

  const clientId = envId || dbId;
  const clientSecret = envSecret || dbSecret;

  return {
    clientId,
    clientSecret,
    gmailRedirectUri: gmailRedirectUri(),
    signinRedirectUri: signinRedirectUri(),
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
function status() {
  const r = resolve();
  return {
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
    baseUrl: baseUrl(),
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
  resolve, status, save, clear, maskClientId
};
