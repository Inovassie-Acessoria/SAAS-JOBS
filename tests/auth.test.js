/**
 * Autenticação da aplicação e conexões de provedor
 * (spec de autenticação §35, §36, §37, §38, §39, §42).
 *
 * A distinção que estes testes protegem:
 *
 *   login na aplicação  ≠  conta do provedor  ≠  permissão do Gmail
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'h2a-auth-'));
process.env.DB_PATH = path.join(TMP, 'auth.db');

const { db } = require('../config/database');
const auth = require('../services/authService');
const providers = require('../services/providerConnectionService');
const candidate = require('../services/candidateService');
const atsService = require('../services/atsService');

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

function makeUser(email, sub) {
  return auth.resolveGoogleUser({
    sub, email, email_verified: true, name: email.split('@')[0], picture: null
  });
}

// ---------------------------------------------------------------------------
// §19 — escopos do login base
// ---------------------------------------------------------------------------

test('§19 — o login base pede apenas escopos de identidade', () => {
  assert.deepStrictEqual(auth.LOGIN_SCOPES, ['openid', 'email', 'profile']);

  for (const proibido of ['gmail.send', 'gmail.readonly', 'drive', 'calendar', 'mail.google.com']) {
    assert.ok(!auth.LOGIN_SCOPES.some(s => s.includes(proibido)),
      `o login base não pode pedir ${proibido}`);
  }
});

test('§18 — entrar com o Google não concede permissão de Gmail', () => {
  const status = auth.authStatus(null);
  assert.match(status.disclaimer, /não conecta sua conta da Gupy ou do Indeed/i);
  assert.match(status.disclaimer, /nem autoriza o envio de e-mails pelo Gmail/i);
});

// ---------------------------------------------------------------------------
// §3 — identidade
// ---------------------------------------------------------------------------

test('§3 — a chave imutável é o sub do Google, não o e-mail', () => {
  const u1 = makeUser('pessoa@example.invalid', 'google-sub-aaa');
  assert.ok(u1.id);

  // Mesmo `sub`, e-mail trocado: continua sendo o MESMO usuário.
  const u2 = auth.resolveGoogleUser({
    sub: 'google-sub-aaa', email: 'novo-email@example.invalid', email_verified: true, name: 'Pessoa'
  });
  assert.strictEqual(u2.id, u1.id, 'trocar de e-mail não pode criar outro usuário');
  assert.strictEqual(u2.email, 'novo-email@example.invalid');

  // `sub` diferente: usuário diferente.
  const u3 = makeUser('outra@example.invalid', 'google-sub-bbb');
  assert.notStrictEqual(u3.id, u1.id);

  const identities = db.prepare("SELECT * FROM core_auth_identities WHERE provider = 'google'").all();
  assert.strictEqual(identities.length, 2);
});

test('§3 — a identidade do Google promove o operador local, preservando os dados', () => {
  // Simula uma instalação que já vinha em modo local.
  const tmpDb = fs.mkdtempSync(path.join(os.tmpdir(), 'h2a-promote-'));
  const child = require('node:child_process');
  const script = path.join(tmpDb, 'run.js');

  fs.writeFileSync(script, `
    process.env.DB_PATH = ${JSON.stringify(path.join(tmpDb, 'p.db'))};
    const auth = require(${JSON.stringify(path.join(__dirname, '..', 'services', 'authService.js').replace(/\\\\/g, '/'))});
    const candidate = require(${JSON.stringify(path.join(__dirname, '..', 'services', 'candidateService.js').replace(/\\\\/g, '/'))});

    const local = auth.localOperator();
    candidate.environment('gupy', 'BR', local.id).updateProfile({ full_name: 'Dado do operador local' });

    const promoted = auth.resolveGoogleUser({ sub: 'sub-promote', email: 'dono@example.invalid', email_verified: true, name: 'Dono' });
    const profile = candidate.environment('gupy', 'BR', promoted.id).getProfile();

    process.stdout.write(JSON.stringify({
      sameUser: promoted.id === local.id,
      authMode: promoted.auth_mode,
      preservedName: profile.fullName
    }));
  `);

  const out = JSON.parse(child.execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 90000 }));
  assert.strictEqual(out.sameUser, true, 'o operador local vira o mesmo usuário do Google');
  assert.strictEqual(out.authMode, 'google');
  assert.strictEqual(out.preservedName, 'Dado do operador local', 'os dados já cadastrados seguem com o dono');

  try { fs.rmSync(tmpDb, { recursive: true, force: true }); } catch (e) {}
});

// ---------------------------------------------------------------------------
// §4, §34, §35 — sessões
// ---------------------------------------------------------------------------

test('§4 — sessão válida, expirada e revogada', () => {
  const u = makeUser('sessao@example.invalid', 'sub-sessao');
  const s = auth.createSession(u.id, { userAgent: 'teste', ip: '127.0.0.1' });

  assert.ok(auth.getSession(s.id), 'sessão recém-criada é válida');

  // Revogada deixa de valer imediatamente (§34).
  auth.revokeSession(s.id);
  assert.strictEqual(auth.getSession(s.id), null);

  // Expirada também.
  const s2 = auth.createSession(u.id, {});
  db.prepare("UPDATE core_sessions SET expires_at = datetime('now','-1 hour') WHERE id = ?").run(s2.id);
  assert.strictEqual(auth.getSession(s2.id), null, 'sessão expirada não autentica');

  // Token inexistente.
  assert.strictEqual(auth.getSession('inexistente'), null);
  assert.strictEqual(auth.getSession(null), null);
});

test('§4 — o cookie de sessão é HttpOnly, Secure e SameSite', () => {
  process.env.SESSION_COOKIE_SECURE = 'true';
  const cookie = auth.buildCookie(auth.SESSION_COOKIE, 'valor-do-token');

  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=\d+/);

  const limpo = auth.buildCookie(auth.SESSION_COOKIE, '', { clear: true });
  assert.match(limpo, /Max-Age=0/);
});

test('§30 — a listagem de sessões não devolve o token inteiro', () => {
  const u = makeUser('listagem@example.invalid', 'sub-listagem');
  const s = auth.createSession(u.id, { userAgent: 'navegador de teste' });

  const lista = auth.listSessions(u.id);
  assert.ok(lista.length >= 1);
  for (const item of lista) {
    assert.ok(item.id.endsWith('…'), 'o identificador exibido é truncado');
    assert.ok(!item.id.includes(s.id), 'o token completo nunca chega à interface');
  }
});

test('§34 — encerrar outras sessões não derruba a atual', () => {
  const u = makeUser('multi@example.invalid', 'sub-multi');
  const atual = auth.createSession(u.id, {});
  const outra1 = auth.createSession(u.id, {});
  const outra2 = auth.createSession(u.id, {});

  const r = auth.revokeAllSessions(u.id, atual.id);
  assert.ok(r.revoked >= 2);

  assert.ok(auth.getSession(atual.id), 'a sessão atual continua válida');
  assert.strictEqual(auth.getSession(outra1.id), null);
  assert.strictEqual(auth.getSession(outra2.id), null);
});

test('§4/§22 — a sessão carrega contexto de produto e país', () => {
  const u = makeUser('contexto@example.invalid', 'sub-contexto');
  const s = auth.createSession(u.id, {});

  auth.setSessionContext(s.id, { product: 'GUPY', country: 'BR' });
  const carregada = auth.getSession(s.id);
  assert.strictEqual(carregada.product, 'GUPY');
  assert.strictEqual(carregada.country, 'BR');
});

// ---------------------------------------------------------------------------
// §23, §36 — autorização por usuário + produto + país
// ---------------------------------------------------------------------------

test('§23 — sem usuário resolvido não há acesso a ambiente', () => {
  for (const invalido of [undefined, null, 0, -1, 'abc', NaN]) {
    assert.throws(
      () => candidate.environment('gupy', 'BR', invalido),
      /Usuário não identificado/,
      `deveria recusar userId = ${String(invalido)}`
    );
  }
});

test('§36 — um usuário não enxerga o perfil nem o currículo de outro', () => {
  const a = makeUser('usuario-a@example.invalid', 'sub-a');
  const b = makeUser('usuario-b@example.invalid', 'sub-b');

  candidate.environment('gupy', 'BR', a.id).updateProfile({
    full_name: 'Pessoa A', skills: 'Google Ads'
  });
  candidate.environment('gupy', 'BR', b.id).updateProfile({
    full_name: 'Pessoa B', skills: 'Kubernetes'
  });

  const pa = candidate.environment('gupy', 'BR', a.id).getProfile();
  const pb = candidate.environment('gupy', 'BR', b.id).getProfile();

  assert.strictEqual(pa.fullName, 'Pessoa A');
  assert.strictEqual(pb.fullName, 'Pessoa B');
  assert.deepStrictEqual(pa.skills, ['Google Ads']);
  assert.deepStrictEqual(pb.skills, ['Kubernetes']);

  // Currículo de A é invisível para B.
  const file = path.join(TMP, 'curriculo-a.txt');
  fs.writeFileSync(file, 'Pessoa A\na@example.invalid\n\nExperience\nGoogle Ads campaigns');
  const doc = candidate.environment('gupy', 'BR', a.id).addResume(
    { path: file, filename: 'curriculo-a.txt', originalname: 'curriculo-a.txt', size: 60 },
    { name: 'Currículo de A' }
  ).resume;

  assert.ok(candidate.environment('gupy', 'BR', a.id).getResume(doc.id));
  assert.strictEqual(candidate.environment('gupy', 'BR', b.id).getResume(doc.id), null,
    'o currículo de A não pode ser lido pelo usuário B');
  assert.deepStrictEqual(candidate.environment('gupy', 'BR', b.id).listResumes(), []);
});

test('§36 — a combinação usuário + produto + país é respeitada nas três dimensões', () => {
  const u = makeUser('tres-dimensoes@example.invalid', 'sub-3d');

  candidate.environment('gupy', 'BR', u.id).updateProfile({ full_name: 'Gupy BR' });
  candidate.environment('gupy', 'US', u.id).updateProfile({ full_name: 'Gupy US' });
  candidate.environment('indeed', 'BR', u.id).updateProfile({ full_name: 'Indeed BR' });
  candidate.environment('seasonal', 'US', u.id).updateProfile({ full_name: 'Seasonal' });

  assert.strictEqual(candidate.environment('gupy', 'BR', u.id).getProfile().fullName, 'Gupy BR');
  assert.strictEqual(candidate.environment('gupy', 'US', u.id).getProfile().fullName, 'Gupy US');
  assert.strictEqual(candidate.environment('indeed', 'BR', u.id).getProfile().fullName, 'Indeed BR');
  assert.strictEqual(candidate.environment('seasonal', 'US', u.id).getProfile().fullName, 'Seasonal');

  // Indeed US do mesmo usuário permanece vazio.
  assert.strictEqual(candidate.environment('indeed', 'US', u.id).getProfile().isEmpty, true);
});

test('§23 — o ATS também é escopado por usuário', () => {
  const a = db.prepare("SELECT id FROM core_users WHERE email = 'usuario-a@example.invalid'").get();
  const b = db.prepare("SELECT id FROM core_users WHERE email = 'usuario-b@example.invalid'").get();

  const centerA = atsService.atsCenter('gupy', 'BR', a.id);
  const centerB = atsService.atsCenter('gupy', 'BR', b.id);

  assert.ok(centerA.resumes.length >= 1);
  assert.strictEqual(centerB.resumes.length, 0, 'B não vê os currículos de A');

  const docA = centerA.resumes[0];
  assert.throws(
    () => atsService.analyzeResume('gupy', 'BR', docA.id, { userId: b.id }),
    /não encontrado/i,
    'B não pode analisar o currículo de A'
  );
});

// ---------------------------------------------------------------------------
// §9, §12, §16, §31, §37, §38 — conexões de provedor
// ---------------------------------------------------------------------------

test('§9/§37 — a conta Gupy é NOT_SUPPORTED e isso não bloqueia a busca', () => {
  const u = makeUser('gupy-conta@example.invalid', 'sub-gupy');
  const c = providers.describe(u.id, 'GUPY');

  assert.strictEqual(c.status, 'NOT_SUPPORTED');
  assert.strictEqual(c.accountLinkSupported, false);
  assert.strictEqual(c.canConnect, false, 'não existe botão de conectar conta Gupy');
  assert.match(c.explanation, /não documenta um fluxo OAuth/i);
  assert.match(c.personalization, /perfil e o currículo que você cadastrou aqui/i);

  // Ligar a flag de ambiente NÃO inventa a capacidade.
  process.env.GUPY_ACCOUNT_LINK_ENABLED = 'true';
  assert.strictEqual(providers.resolveDefaultStatus('GUPY'), 'NOT_SUPPORTED',
    'a flag não pode criar um fluxo que o provedor não oferece');
  delete process.env.GUPY_ACCOUNT_LINK_ENABLED;
});

test('§12/§38 — a conta Indeed não exibe estado Connected falso', () => {
  const u = makeUser('indeed-conta@example.invalid', 'sub-indeed');
  const c = providers.describe(u.id, 'INDEED');

  assert.strictEqual(c.status, 'NOT_SUPPORTED');
  assert.notStrictEqual(c.status, 'CONNECTED');
  assert.match(c.statusLabel, /não disponível/i);
  assert.match(c.explanation, /apenas via Claude Connector/i);

  // Marcar como conectado é recusado enquanto não houver fluxo oficial (§16).
  assert.throws(
    () => providers.markConnected(u.id, 'INDEED', { accountEmail: 'x@example.invalid' }),
    /Não existe fluxo oficial de vinculação/i
  );
});

test('§16 — nenhuma credencial é gravada onde não há fluxo oficial', () => {
  const u = makeUser('sem-credencial@example.invalid', 'sub-cred');
  for (const p of ['GUPY', 'INDEED']) {
    const row = providers.getConnection(u.id, p);
    assert.strictEqual(row.encrypted_credential, null, `${p} não pode ter credencial gravada`);
    assert.strictEqual(row.auth_type, 'none');
    assert.strictEqual(providers.describe(u.id, p).hasStoredCredential, false);
  }
});

test('§31 — fonte de dados e conta do provedor são estados distintos', () => {
  const u = makeUser('matriz@example.invalid', 'sub-matriz');
  const matriz = providers.healthMatrix(u.id, {
    gupyMcp: 'HEALTHY',
    indeedMcp: 'CUSTOM_CLIENT_ACCESS_UNAVAILABLE',
    seasonalDol: 'HEALTHY',
    gmail: 'DISCONNECTED'
  });

  const by = Object.fromEntries(matriz.map(m => [m.key, m]));

  // O MCP da Gupy saudável NÃO significa conta vinculada (§8, §31).
  assert.strictEqual(by.GUPY_MCP.status, 'HEALTHY');
  assert.strictEqual(by.GUPY_ACCOUNT.status, 'NOT_SUPPORTED');
  assert.strictEqual(by.GUPY_MCP.kind, 'data_source');
  assert.strictEqual(by.GUPY_ACCOUNT.kind, 'provider_account');
  assert.match(by.GUPY_MCP.note, /Não é a sua conta da Gupy/i);

  assert.strictEqual(by.INDEED_MCP.status, 'CUSTOM_CLIENT_ACCESS_UNAVAILABLE');
  assert.strictEqual(by.INDEED_ACCOUNT.status, 'NOT_SUPPORTED');

  // Login da aplicação é uma terceira coisa.
  assert.strictEqual(by.APPLICATION_AUTH.kind, 'auth');
});

test('§39 — o Gmail é conexão separada, com escopo mínimo', () => {
  const u = makeUser('gmail@example.invalid', 'sub-gmail');

  // Antes de conectar: disponível, não conectado.
  const antes = providers.describe(u.id, 'GMAIL');
  assert.notStrictEqual(antes.status, 'CONNECTED');

  // Conectar registra a conta REAL do remetente, que pode diferir do login (§20).
  const depois = providers.markConnected(u.id, 'GMAIL', {
    accountEmail: 'candidaturas@example.invalid',
    scopes: ['https://www.googleapis.com/auth/gmail.send']
  });

  assert.strictEqual(depois.status, 'CONNECTED');
  assert.strictEqual(depois.externalAccountEmail, 'candidaturas@example.invalid');
  assert.notStrictEqual(depois.externalAccountEmail, u.email,
    'o remetente pode ser diferente da conta de login — e a interface mostra qual é');
  assert.deepStrictEqual(depois.grantedScopes, ['https://www.googleapis.com/auth/gmail.send']);
  assert.ok(!depois.grantedScopes.some(s => s.includes('readonly') || s.includes('mail.google.com')),
    'apenas o escopo de envio é concedido');
});

test('§34 — desconectar um provedor é independente de sair da aplicação', () => {
  const u = db.prepare("SELECT id FROM core_users WHERE email = 'gmail@example.invalid'").get();
  const s = auth.createSession(u.id, {});

  providers.disconnect(u.id, 'GMAIL');
  assert.strictEqual(providers.describe(u.id, 'GMAIL').status, 'REVOKED');
  assert.strictEqual(providers.describe(u.id, 'GMAIL').hasStoredCredential, false);

  // A sessão da aplicação continua de pé.
  assert.ok(auth.getSession(s.id), 'desconectar o Gmail não desloga da aplicação');
});

test('§9 — desconectar um provedor sem vinculação explica em vez de falhar', () => {
  const u = makeUser('desconectar@example.invalid', 'sub-desc');
  const r = providers.disconnect(u.id, 'GUPY');
  assert.match(r.message, /não há conexão de conta/i);
  assert.strictEqual(r.status, 'NOT_SUPPORTED');
});

// ---------------------------------------------------------------------------
// §33, §42 — o que nunca pode existir
// ---------------------------------------------------------------------------

test('§33 — não existe caminho para senha de provedor no código', () => {
  const arquivos = [
    'services/authService.js',
    'services/providerConnectionService.js',
    'services/adapters/mcpClient.js',
    'server.js'
  ];

  // Só o CÓDIGO conta: comentários que documentam a proibição são removidos
  // antes da varredura, senão o próprio aviso "nunca pedimos senha" acusaria.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const proibidos = [
    /gupy[_-]?password/i,
    /indeed[_-]?password/i,
    /provider[_-]?password/i,
    /document\.cookie/i,
    /puppeteer|playwright|headless/i,
    /session[_-]?hijack/i
  ];

  for (const f of arquivos) {
    const src = stripComments(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
    for (const re of proibidos) {
      assert.ok(!re.test(src), `${f} contém padrão proibido: ${re}`);
    }
  }

  // E nenhuma dependência de automação de navegador entrou no manifesto.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies || {});
  for (const proibida of ['puppeteer', 'playwright', 'selenium-webdriver', 'cheerio']) {
    assert.ok(!deps.includes(proibida), `${proibida} não pode ser dependência: §33 proíbe raspar sessão de provedor`);
  }
});

test('§33 — o schema não tem coluna para senha de provedor', () => {
  const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of tabelas) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name.toLowerCase());
    for (const c of cols) {
      assert.ok(!/password|senha/.test(c),
        `a tabela ${t} tem a coluna "${c}" — senha de provedor jamais é armazenada`);
    }
  }

  // A única credencial guardada é cifrada, e só para provedores com fluxo oficial.
  const cols = db.prepare('PRAGMA table_info(core_provider_connections)').all().map(c => c.name);
  assert.ok(cols.includes('encrypted_credential'), 'a credencial, quando existe, é sempre cifrada');
  assert.ok(!cols.includes('credential'), 'não existe campo de credencial em texto puro');
});

test('§42 — os invariantes de autenticação estão codificados, não só documentados', () => {
  // 1. Login não é conexão de provedor: serviços separados.
  assert.ok(typeof auth.beginLogin === 'function');
  assert.ok(typeof providers.listConnections === 'function');
  assert.ok(!auth.markConnected, 'o serviço de auth não gerencia conexão de provedor');
  assert.ok(!providers.createSession, 'o serviço de provedor não cria sessão de aplicação');

  // 2. O modo operador local é declarado, não disfarçado.
  const antes = process.env.GOOGLE_AUTH_ENABLED;
  delete process.env.GOOGLE_AUTH_ENABLED;
  const status = auth.authStatus(auth.localOperator());
  assert.strictEqual(status.localOperatorMode, true);
  assert.strictEqual(status.googleConfigured, false);
  assert.match(status.notice, /não há login/i);
  assert.strictEqual(status.user.authMode, 'local_operator',
    'o modo local nunca se apresenta como login do Google');
  if (antes !== undefined) process.env.GOOGLE_AUTH_ENABLED = antes;
});

test('§26 — sem credenciais do Google, iniciar o login é recusado com explicação', () => {
  const antes = { e: process.env.GOOGLE_AUTH_ENABLED, i: process.env.GOOGLE_AUTH_CLIENT_ID };
  delete process.env.GOOGLE_AUTH_ENABLED;
  delete process.env.GOOGLE_AUTH_CLIENT_ID;

  assert.throws(() => auth.beginLogin(), /não está configurado/i);
  assert.strictEqual(auth.googleConfigured(), false);

  if (antes.e !== undefined) process.env.GOOGLE_AUTH_ENABLED = antes.e;
  if (antes.i !== undefined) process.env.GOOGLE_AUTH_CLIENT_ID = antes.i;
});

test('§35 — o state do OAuth protege contra CSRF', async () => {
  process.env.GOOGLE_AUTH_ENABLED = 'true';
  process.env.GOOGLE_AUTH_CLIENT_ID = 'client-de-teste.apps.googleusercontent.com';
  process.env.GOOGLE_AUTH_CLIENT_SECRET = 'segredo-de-teste';

  const inicio = auth.beginLogin();
  assert.ok(inicio.url.includes('accounts.google.com'));
  assert.ok(inicio.state && inicio.state.length >= 20, 'state precisa ser imprevisível');
  assert.ok(inicio.url.includes('state='));

  // Escopos na URL: só identidade.
  assert.ok(inicio.url.includes('openid'));
  assert.ok(!inicio.url.includes('gmail'), 'a URL de login não pode pedir escopo de Gmail');

  // State divergente é recusado antes de qualquer troca de código.
  await assert.rejects(
    () => auth.completeLogin({ code: 'x', state: 'aaa', expectedState: 'bbb' }),
    /verificação de segurança do login falhou/i
  );
  await assert.rejects(
    () => auth.completeLogin({ code: 'x', state: 'aaa', expectedState: null }),
    /verificação de segurança/i
  );
  await assert.rejects(
    () => auth.completeLogin({ code: '', state: 'a', expectedState: 'a' }),
    /Código de autorização ausente/i
  );

  delete process.env.GOOGLE_AUTH_ENABLED;
  delete process.env.GOOGLE_AUTH_CLIENT_ID;
  delete process.env.GOOGLE_AUTH_CLIENT_SECRET;
});
