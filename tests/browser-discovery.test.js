/**
 * Descoberta por navegador (§45, §46) e os defeitos de schema que ela expôs.
 *
 * Nenhum teste aqui acessa a rede. O que se verifica é o contrato: montagem de
 * URL, forma do adaptador, a fronteira que ele não pode cruzar, e o schema do
 * Indeed — que estava quebrado de um jeito silencioso.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Banco isolado: nada aqui toca o banco de produção.
const tmpDb = path.join(os.tmpdir(), `h2a-browser-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY
  || require('crypto').randomBytes(32).toString('base64');

const { db } = require('../config/database');
const { BrowserAdapter, SITE_PROFILES, findChrome } = require('../services/adapters/browserAdapter');
const policyGate = require('../core/agents/policyGate');

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch (e) { /* já removido */ }
  }
});

// ---------------------------------------------------------------------------
// Montagem de URL — foi aqui que a Gupy quebrou na primeira versão
// ---------------------------------------------------------------------------

test('§46 — a busca da Gupy usa caminho, não query string', () => {
  const url = SITE_PROFILES.gupy.buildUrl({ keywords: 'motorista carreteiro' });

  // Com "?" o portal devolve a home, não a listagem. O separador é "/".
  assert.ok(url.includes('/job-search/term='),
    `a URL precisa usar /job-search/term= — veio: ${url}`);
  assert.ok(!url.includes('/job-search?'),
    'com "?" o Gupy cai na home e a busca devolve zero vagas');
  assert.ok(url.includes('motorista%20carreteiro') || url.includes('motorista+carreteiro'),
    'os termos precisam vir codificados');
});

test('§46 — o Indeed pagina por URL, com start em múltiplos de 10', () => {
  const p1 = SITE_PROFILES.indeed.buildUrl({ keywords: 'motorista', country: 'BR', page: 1 });
  const p3 = SITE_PROFILES.indeed.buildUrl({ keywords: 'motorista', country: 'BR', page: 3 });

  assert.ok(p1.startsWith('https://br.indeed.com/'), 'BR usa o domínio brasileiro');
  assert.ok(!p1.includes('start='), 'a primeira página não leva start');
  assert.ok(p3.includes('start=20'), `página 3 começa em 20 — veio: ${p3}`);

  const us = SITE_PROFILES.indeed.buildUrl({ keywords: 'driver', country: 'US', page: 1 });
  assert.ok(us.startsWith('https://www.indeed.com/'), 'US usa o domínio americano');
});

test('§46 — a Gupy pagina por clique, e declara isso', () => {
  assert.strictEqual(SITE_PROFILES.gupy.paginate, 'click',
    'o botão de página da Gupy não tem href; montar URL não funciona');
  assert.strictEqual(typeof SITE_PROFILES.gupy.nextSelector, 'function');
  assert.ok(SITE_PROFILES.gupy.nextSelector(2).includes('Página 2'));

  assert.strictEqual(SITE_PROFILES.indeed.paginate, 'url');
});

// ---------------------------------------------------------------------------
// A fronteira: ler pode, enviar não
// ---------------------------------------------------------------------------

test('§46, §71.4 — o adaptador recusa submeter candidatura', async () => {
  const a = new BrowserAdapter({ provider: 'indeed', country: 'BR' });
  await assert.rejects(
    () => a.submitApplication({}),
    (err) => /não submete candidaturas/i.test(err.userMessage || err.message),
    'submitApplication precisa falhar explicitamente, não existir em silêncio'
  );
});

test('§53 — buscar é permitido, submeter por navegador não', () => {
  for (const provider of ['GUPY', 'INDEED']) {
    const discover = policyGate.evaluate({
      provider, action: 'DISCOVER_JOBS', application: {}, userRules: {}, providerRules: {}
    });
    assert.strictEqual(discover.outcome, 'ALLOWED',
      `${provider} precisa poder descobrir vagas — sem isso não há robô nenhum`);

    const submit = policyGate.evaluate({
      provider, action: 'BROWSER_SUBMIT', application: {}, userRules: {}, providerRules: {}
    });
    assert.strictEqual(submit.outcome, 'DENIED',
      `${provider} não pode submeter por navegador`);
  }
});

// ---------------------------------------------------------------------------
// Forma do adaptador — precisa ser intercambiável com o MCP
// ---------------------------------------------------------------------------

test('§45 — o adaptador de navegador cumpre o mesmo contrato do MCP', () => {
  const a = new BrowserAdapter({ provider: 'gupy', country: 'BR' });

  for (const m of ['searchJobs', 'testConnection']) {
    assert.strictEqual(typeof a[m], 'function', `falta o método ${m}`);
  }
  assert.strictEqual(a.fixtureMode, false,
    'navegador lê dado real; marcar como fixture mentiria na interface');

  // O perfil precisa ficar fora de qualquer diretório servido estaticamente.
  const dir = a.profileDir();
  assert.ok(dir.includes('private_uploads'), 'a sessão não pode ficar em diretório público');
  assert.ok(!dir.includes(`${path.sep}public${path.sep}`));
});

test('§46 — provedor sem perfil de navegação é recusado na construção', () => {
  assert.throws(() => new BrowserAdapter({ provider: 'linkedin', country: 'BR' }),
    /perfil de navega/i);
});

test('o diagnóstico funciona sem rede e informa o que falta', async () => {
  const a = new BrowserAdapter({ provider: 'indeed', country: 'BR' });
  const r = await a.testConnection();

  assert.ok(Array.isArray(r.steps) && r.steps.length >= 3);
  assert.ok(typeof r.userMessage === 'string' && r.userMessage.length > 10);

  const submitStep = r.steps.find(s => /submiss/i.test(s.label));
  assert.ok(submitStep, 'o diagnóstico precisa declarar que a submissão é bloqueada');

  // Sem Chrome instalado o diagnóstico reprova, em vez de fingir que está pronto.
  if (!findChrome()) assert.strictEqual(r.success, false);
});

// ---------------------------------------------------------------------------
// Escolha de perfil do Chrome
// ---------------------------------------------------------------------------

test('o padrão é o perfil dedicado, fora de diretório público', () => {
  const a = new BrowserAdapter({ provider: 'gupy', country: 'BR' });
  const p = a.resolveProfile();

  assert.strictEqual(p.mode, 'dedicated',
    'usar o perfil pessoal por padrão daria à automação todas as sessões do usuário');
  assert.strictEqual(p.profileDirectory, null);
  assert.ok(p.userDataDir.includes('private_uploads'));
});

test('o modo sistema aponta para o perfil real escolhido', () => {
  const { listChromeProfiles } = require('../services/adapters/browserAdapter');
  const existing = listChromeProfiles();
  if (!existing.length) return;   // máquina sem Chrome: nada a verificar

  const target = existing[0].directory;
  const a = new BrowserAdapter({
    provider: 'gupy', country: 'BR', profileMode: 'system', profileDirectory: target
  });
  const p = a.resolveProfile();

  assert.strictEqual(p.mode, 'system');
  assert.strictEqual(p.profileDirectory, target);
  assert.ok(!p.userDataDir.includes('private_uploads'),
    'no modo sistema o diretório é o do Chrome do usuário');
});

test('perfil inexistente é recusado com instrução, não com erro obscuro', () => {
  const { listChromeProfiles } = require('../services/adapters/browserAdapter');
  if (!listChromeProfiles().length) return;

  const a = new BrowserAdapter({
    provider: 'gupy', country: 'BR', profileMode: 'system', profileDirectory: 'Profile 9999'
  });
  assert.throws(() => a.resolveProfile(), (err) => {
    const msg = err.userMessage || err.message;
    return /não existe/i.test(msg) && /browser:profiles/.test(msg);
  }, 'a mensagem precisa dizer como descobrir os perfis válidos');
});

// ---------------------------------------------------------------------------
// Schema do Indeed — dois defeitos que faziam a importação falhar em silêncio
// ---------------------------------------------------------------------------

test('regressão — indeed_jobs tem as colunas que o upsert grava', () => {
  const cols = db.prepare('PRAGMA table_info(indeed_jobs)').all().map(c => c.name);

  // A tabela nascia sem estas quatro, e o upsert as referenciava. Cada vaga
  // falhava com "no such column", e o erro era absorvido pelo pipeline —
  // o usuário via "0 vagas" sem nenhuma pista do motivo.
  for (const c of ['salary_month', 'salary_source', 'published_date', 'content_hash']) {
    assert.ok(cols.includes(c), `indeed_jobs precisa da coluna ${c}`);
  }
});

test('regressão — a chave única do Indeed inclui o país', () => {
  const indexes = db.prepare("PRAGMA index_list('indeed_jobs')").all();

  const hasCompound = indexes.some(i => {
    if (!i.unique) return false;
    const cols = db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all().map(c => c.name);
    return cols.length === 2 && cols.includes('country') && cols.includes('external_id');
  });

  assert.ok(hasCompound,
    'sem UNIQUE(country, external_id) o ON CONFLICT do upsert não casa e ' +
    'a mesma vaga em BR e US colide, furando o isolamento por país');
});

test('regressão — a mesma vaga pode existir em BR e US sem colidir', () => {
  const ins = db.prepare(
    `INSERT INTO indeed_jobs (country, external_id, title, company, job_url)
     VALUES (?,?,?,?,?)`
  );

  ins.run('BR', 'mesmo-id-nos-dois', 'Motorista', 'Empresa', 'https://exemplo/1');
  ins.run('US', 'mesmo-id-nos-dois', 'Driver', 'Company', 'https://exemplo/2');

  const n = db.prepare(
    'SELECT COUNT(*) c FROM indeed_jobs WHERE external_id = ?'
  ).get('mesmo-id-nos-dois').c;

  assert.strictEqual(n, 2, 'BR e US são ambientes independentes');

  db.prepare('DELETE FROM indeed_jobs WHERE external_id = ?').run('mesmo-id-nos-dois');
});

test('regressão — nenhuma tabela referencia a tabela temporária da migração', () => {
  const dangling = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%indeed_jobs__oldkey%'`
  ).all();

  assert.deepStrictEqual(dangling, [],
    'FK apontando para a tabela temporária quebra toda gravação de análise');
});
