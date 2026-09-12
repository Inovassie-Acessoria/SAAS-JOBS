/**
 * Criptografia autenticada para segredos em repouso (spec §32, §74).
 *
 * AES-256-GCM: confidencialidade + autenticidade. O texto cifrado carrega o
 * nonce e a tag de autenticação, então adulterar o arquivo faz a decifragem
 * falhar em vez de devolver lixo silenciosamente.
 *
 * A chave vive FORA do banco, em `APP_ENCRYPTION_KEY`. O spec é explícito:
 * "never store encryption key and encrypted token in the same database table".
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

class EncryptionKeyMissing extends Error {
  constructor(message) {
    super(message);
    this.name = 'EncryptionKeyMissing';
    this.userFacing = true;
  }
}

/**
 * Deriva a chave de 32 bytes a partir de `APP_ENCRYPTION_KEY`.
 * Aceita base64, hex ou uma frase — nesse caso deriva com scrypt.
 */
function loadKey() {
  const raw = process.env.APP_ENCRYPTION_KEY || '';
  if (!raw.trim()) {
    throw new EncryptionKeyMissing(
      'A chave de criptografia não está configurada. Defina APP_ENCRYPTION_KEY no ambiente para que os tokens possam ser guardados com segurança.'
    );
  }

  // base64 de 32 bytes
  if (/^[A-Za-z0-9+/]{43}=$/.test(raw.trim())) {
    const b = Buffer.from(raw.trim(), 'base64');
    if (b.length === KEY_BYTES) return b;
  }
  // hex de 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(raw.trim())) {
    return Buffer.from(raw.trim(), 'hex');
  }
  // frase: deriva de forma determinística
  return crypto.scryptSync(raw, 'job-intelligence/secretbox/v1', KEY_BYTES);
}

function isConfigured() {
  try { loadKey(); return true; } catch (e) { return false; }
}

/** Gera uma chave nova, pronta para colar no .env. */
function generateKey() {
  return crypto.randomBytes(KEY_BYTES).toString('base64');
}

/**
 * Cifra um texto.
 * @returns {string} `v1.<nonce b64>.<tag b64>.<ciphertext b64>`
 */
function encrypt(plaintext) {
  const key = loadKey();
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce);

  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, nonce.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

/** Decifra. Lança se a chave estiver errada ou o conteúdo tiver sido adulterado. */
function decrypt(payload) {
  const key = loadKey();
  const parts = String(payload || '').split('.');

  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Formato de segredo inválido ou de uma versão desconhecida.');
  }

  const nonce = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct = Buffer.from(parts[3], 'base64');

  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Segredo corrompido: nonce ou tag com tamanho inesperado.');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Conveniência para objetos (tokens OAuth). */
function encryptJson(obj) { return encrypt(JSON.stringify(obj)); }
function decryptJson(payload) { return JSON.parse(decrypt(payload)); }

/** Detecta se um valor gravado já está cifrado no formato deste módulo. */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(VERSION + '.') && value.split('.').length === 4;
}

module.exports = {
  ALGORITHM, VERSION, EncryptionKeyMissing,
  isConfigured, generateKey,
  encrypt, decrypt, encryptJson, decryptJson, isEncrypted
};
