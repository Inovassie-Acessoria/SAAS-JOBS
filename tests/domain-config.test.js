/**
 * Domínio público e URIs de retorno do Google.
 *
 * O bug que estes testes fecham: o servidor trocou de domínio, o .env ficou
 * com o antigo, e o Google respondeu "redirect_uri_mismatch" sem explicar.
 * Agora a base vem de UMA fonte (APP_BASE_URL → endereço do acesso →
 * localhost), a incoerência é detectada ANTES de mandar o usuário ao Google,
 * e o script de troca de domínio reescreve todas as variáveis de uma vez.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const tmpDb = path.join(os.tmpdir(), `domain-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY || 'a'.repeat(64);

const creds = require('../services/googleCredentialsService');

const OLD = 'https://lightgrey-snake-465806.hostingersite.com';
const NEW_HOST = 'saas.inovassie.com.br';

function req(host, extra = {}) {
  return { headers: Object.assign({ host }, extra), protocol: 'http' };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const CLEAR = { APP_BASE_URL: undefined, PUBLIC_BASE_URL: undefined, GOOGLE_REDIRECT_URI: undefined, GOOGLE_SIGNIN_REDIRECT_URI: undefined, GOOGLE_AUTH_REDIRECT_URI: undefined, CORS_ORIGIN: undefined, DOMAIN: undefined };

test('sem APP_BASE_URL, a base vem do endereço do acesso (respeitando o proxy)', () => {
  withEnv(CLEAR, () => {
    const r = req(NEW_HOST, { 'x-forwarded-proto': 'https' });
    assert.strictEqual(creds.requestBaseUrl(r), `https://${NEW_HOST}`);
    assert.strictEqual(creds.resolve(r).gmailRedirectUri, `https://${NEW_HOST}/api/seasonal/gmail/callback`);
    assert.strictEqual(creds.resolve(r).signinRedirectUri, `https://${NEW_HOST}/api/auth/google/callback`);
    assert.strictEqual(creds.domainCheck(r).mismatch, false);
  });
});

test('X-Forwarded-Host tem precedência sobre Host (proxy reverso)', () => {
  withEnv(CLEAR, () => {
    const r = req('127.0.0.1:3000', { 'x-forwarded-host': NEW_HOST, 'x-forwarded-proto': 'https' });
    assert.strictEqual(creds.requestBaseUrl(r), `https://${NEW_HOST}`);
  });
});

test('APP_BASE_URL manda sobre o endereço do acesso', () => {
  withEnv(Object.assign({}, CLEAR, { APP_BASE_URL: `https://${NEW_HOST}/` }), () => {
    assert.strictEqual(creds.resolve(req('outro.host')).gmailRedirectUri, `https://${NEW_HOST}/api/seasonal/gmail/callback`);
  });
});

test('domínio antigo no .env + acesso pelo novo = mismatch com a lista exata de variáveis', () => {
  withEnv(Object.assign({}, CLEAR, {
    APP_BASE_URL: OLD,
    GOOGLE_REDIRECT_URI: `${OLD}/api/seasonal/gmail/callback`,
    DOMAIN: 'lightgrey-snake-465806.hostingersite.com'
  }), () => {
    const c = creds.domainCheck(req(NEW_HOST, { 'x-forwarded-proto': 'https' }));
    assert.strictEqual(c.mismatch, true);
    assert.deepStrictEqual(c.variablesToFix, ['APP_BASE_URL', 'GOOGLE_REDIRECT_URI', 'DOMAIN']);
    assert.strictEqual(c.expectedGmailRedirectUri, `https://${NEW_HOST}/api/seasonal/gmail/callback`);
    assert.match(c.message, /redirecionamento autorizados/);
    assert.match(c.message, new RegExp(NEW_HOST));
    assert.throws(() => creds.assertDomainConsistent(req(NEW_HOST)), (e) => e.status === 409 && e.code === 'DOMAIN_MISMATCH' && e.userFacing);
  });
});

test('acesso por localhost com APP_BASE_URL de produção NÃO é mismatch (desenvolvimento)', () => {
  withEnv(Object.assign({}, CLEAR, { APP_BASE_URL: `https://${NEW_HOST}` }), () => {
    for (const h of ['localhost:3000', '127.0.0.1:3000', '192.168.0.10:3000']) {
      const c = creds.domainCheck(req(h));
      assert.strictEqual(c.mismatch, false, h);
      assert.strictEqual(c.local, true, h);
    }
    assert.doesNotThrow(() => creds.assertDomainConsistent(req('localhost:3000')));
  });
});

test('status() expõe o diagnóstico de domínio sem expor o client_secret', () => {
  withEnv(Object.assign({}, CLEAR, { APP_BASE_URL: OLD }), () => {
    const s = creds.status(req(NEW_HOST));
    assert.strictEqual(s.domain.mismatch, true);
    assert.strictEqual(s.baseUrlSource, 'env');
    assert.strictEqual(JSON.stringify(s).includes('clientSecret'), false);
  });
});

test('scripts/changeDomain.js reescreve todas as variáveis de domínio e nada mais', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, [
    'APP_ENV=production',
    `APP_BASE_URL=${OLD}`,
    'DOMAIN=lightgrey-snake-465806.hostingersite.com',
    'APP_ENCRYPTION_KEY=nao-mexer',
    '# GOOGLE_REDIRECT_URI=comentario-fica',
    `GOOGLE_REDIRECT_URI=${OLD}/api/seasonal/gmail/callback`,
    `GOOGLE_SIGNIN_REDIRECT_URI=${OLD}/api/auth/google/callback`,
    'GOOGLE_CLIENT_SECRET=GOCSPX-nao-mexer',
    ''
  ].join('\n'));

  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'changeDomain.js'), NEW_HOST, '--file', envFile], { encoding: 'utf8' });
  const after = fs.readFileSync(envFile, 'utf8');

  assert.match(after, new RegExp(`^APP_BASE_URL=https://${NEW_HOST}$`, 'm'));
  assert.match(after, new RegExp(`^DOMAIN=${NEW_HOST}$`, 'm'));
  assert.match(after, new RegExp(`^GOOGLE_REDIRECT_URI=https://${NEW_HOST}/api/seasonal/gmail/callback$`, 'm'));
  assert.match(after, new RegExp(`^GOOGLE_SIGNIN_REDIRECT_URI=https://${NEW_HOST}/api/auth/google/callback$`, 'm'));
  assert.match(after, new RegExp(`^CORS_ORIGIN=https://${NEW_HOST}$`, 'm'), 'CORS_ORIGIN ausente é acrescentada');
  assert.match(after, /^APP_ENCRYPTION_KEY=nao-mexer$/m, 'segredos ficam intactos');
  assert.match(after, /^GOOGLE_CLIENT_SECRET=GOCSPX-nao-mexer$/m);
  assert.match(after, /^# GOOGLE_REDIRECT_URI=comentario-fica$/m, 'linha comentada não é tocada');
  assert.strictEqual(after.includes('hostingersite'), false, 'nenhum rastro do domínio antigo');
  assert.match(out, /inovassie\.com\.br\)/, 'domínio raiz com.br tratado corretamente');

  // Segunda execução é idempotente.
  const again = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'changeDomain.js'), NEW_HOST, '--file', envFile], { encoding: 'utf8' });
  assert.match(again, /Nada a mudar/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test.after(() => { try { fs.unlinkSync(tmpDb); } catch (e) { /* */ } });
