/**
 * Isolamento entre produtos e países (spec §76, §1, §50).
 *
 * Verifica que:
 *   Gupy Brasil não mostra resultados dos EUA e vice-versa;
 *   Indeed Brasil não mostra dados do Indeed USA;
 *   Seasonal é exclusivamente US;
 *   Gupy nunca vê dados do Indeed e o inverso;
 *   não existe tabela genérica de vagas (§44 do build prompt original).
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'h2a-iso-'));
process.env.DB_PATH = path.join(TMP, 'iso.db');

const { db } = require('../config/database');
const { gupyService, indeedService } = require('../services/boardService');
const seasonal = require('../services/seasonalService');
const candidate = require('../services/candidateService');
const auth = require('../services/authService');

const USER = auth.localOperator().id;
const envOf = (p, c) => candidate.environment(p, c, USER);

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

// --- fixtures diretas no banco, uma por combinação produto × país ---------

function seed() {
  db.prepare('DELETE FROM gupy_jobs').run();
  db.prepare('DELETE FROM indeed_jobs').run();
  db.prepare('DELETE FROM seasonal_jobs').run();

  const g = db.prepare(`INSERT INTO gupy_jobs (country, external_id, title, company, apply_url, description, requirements)
                        VALUES (?,?,?,?,?,?,?)`);
  g.run('BR', 'g-br-1', 'Vaga Gupy Brasil', 'Empresa BR', 'https://example.invalid/1', 'desc', 'req');
  g.run('BR', 'g-br-2', 'Outra Gupy Brasil', 'Empresa BR2', 'https://example.invalid/2', 'desc', 'req');
  g.run('US', 'g-us-1', 'Gupy USA Role', 'Company US', 'https://example.invalid/3', 'desc', 'req');

  const i = db.prepare(`INSERT INTO indeed_jobs (country, external_id, title, company, job_url, description, requirements)
                        VALUES (?,?,?,?,?,?,?)`);
  i.run('BR', 'i-br-1', 'Vaga Indeed Brasil', 'Empresa BR', 'https://example.invalid/4', 'desc', 'req');
  i.run('US', 'i-us-1', 'Indeed USA Role', 'Company US', 'https://example.invalid/5', 'desc', 'req');
  i.run('US', 'i-us-2', 'Another Indeed USA', 'Company US2', 'https://example.invalid/6', 'desc', 'req');

  db.prepare(`INSERT INTO seasonal_jobs (job_order_id, visa_type, job_title, employer_name, employer_state)
              VALUES ('s-1','H-2A','Farm Worker','US Farm','IA')`).run();
}

seed();

// ---------------------------------------------------------------------------

test('§76 — Gupy Brasil não mostra vagas dos EUA', () => {
  const br = gupyService.listJobs('BR', { view: 'all' });
  assert.strictEqual(br.length, 2);
  for (const j of br) {
    assert.strictEqual(j.country, 'BR');
    assert.ok(!j.external_id.includes('us'), `vaga US vazou para o Brasil: ${j.external_id}`);
  }
});

test('§76 — Gupy USA não mostra vagas do Brasil', () => {
  const us = gupyService.listJobs('US', { view: 'all' });
  assert.strictEqual(us.length, 1);
  assert.strictEqual(us[0].country, 'US');
  assert.strictEqual(us[0].external_id, 'g-us-1');
});

test('§76 — Indeed Brasil e Indeed USA não se misturam', () => {
  const br = indeedService.listJobs('BR', { view: 'all' });
  const us = indeedService.listJobs('US', { view: 'all' });

  assert.strictEqual(br.length, 1);
  assert.strictEqual(us.length, 2);
  assert.ok(br.every(j => j.country === 'BR'));
  assert.ok(us.every(j => j.country === 'US'));

  const brIds = new Set(br.map(j => j.external_id));
  assert.ok(us.every(j => !brIds.has(j.external_id)));
});

test('§76 — Gupy nunca vê dados do Indeed, e o inverso', () => {
  const gupyAll = [...gupyService.listJobs('BR', {}), ...gupyService.listJobs('US', {})];
  const indeedAll = [...indeedService.listJobs('BR', {}), ...indeedService.listJobs('US', {})];

  assert.ok(gupyAll.every(j => j.external_id.startsWith('g-')), 'Gupy só devolve vagas Gupy');
  assert.ok(indeedAll.every(j => j.external_id.startsWith('i-')), 'Indeed só devolve vagas Indeed');

  const gupyIds = new Set(gupyAll.map(j => j.external_id));
  assert.ok(indeedAll.every(j => !gupyIds.has(j.external_id)));
});

test('§76 — Seasonal não aparece em Gupy nem em Indeed', () => {
  const boards = [
    ...gupyService.listJobs('BR', {}), ...gupyService.listJobs('US', {}),
    ...indeedService.listJobs('BR', {}), ...indeedService.listJobs('US', {})
  ];
  assert.ok(boards.every(j => j.job_order_id === undefined),
    'nenhuma vaga de board pode carregar identificador de ordem de serviço sazonal');
  assert.ok(!boards.some(j => j.external_id === 's-1'));
});

test('§4.3 — Seasonal é exclusivamente US e não tem noção de país configurável', () => {
  assert.strictEqual(seasonal.COUNTRY, 'US');
  const cols = db.prepare('PRAGMA table_info(seasonal_jobs)').all().map(c => c.name);
  assert.ok(!cols.includes('country'), 'seasonal_jobs não deve ter coluna de país — o produto é US-only');

  const cfgCols = db.prepare('PRAGMA table_info(seasonal_config)').all().map(c => c.name);
  assert.ok(!cfgCols.includes('country'));
});

test('§76 — operar vaga de outro país pelo escopo errado é recusado', () => {
  const brJob = db.prepare("SELECT id FROM gupy_jobs WHERE external_id = 'g-br-1'").get();

  assert.throws(
    () => gupyService.saveJob('US', brJob.id),
    /não encontrada neste país/i,
    'salvar uma vaga BR pelo escopo US deve falhar'
  );

  // No escopo correto funciona.
  assert.deepStrictEqual(gupyService.saveJob('BR', brJob.id), { success: true });
});

test('§76 — getJob respeita a fronteira de país', () => {
  const usJob = db.prepare("SELECT id FROM gupy_jobs WHERE external_id = 'g-us-1'").get();
  assert.ok(gupyService.getJob('US', usJob.id), 'existe no escopo correto');
  assert.strictEqual(gupyService.getJob('BR', usJob.id), null, 'invisível no escopo errado');
});

test('§50/§44 — não existe tabela genérica de vagas', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);

  assert.ok(!tables.includes('jobs'), 'a tabela genérica `jobs` não pode existir');
  assert.ok(!tables.includes('candidate_profile'));
  assert.ok(!tables.includes('resumes'));

  // Nenhuma tabela de vagas pode ter uma coluna `source` discriminando plataforma.
  for (const t of ['gupy_jobs', 'indeed_jobs', 'seasonal_jobs']) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
    assert.ok(!cols.includes('source'),
      `${t} não pode ter coluna "source" — é isso que a §44 proíbe`);
  }

  // Os três produtos têm tabelas próprias, com o prefixo do produto.
  for (const p of ['gupy', 'indeed', 'seasonal']) {
    assert.ok(tables.includes(`${p}_jobs`));
    assert.ok(tables.includes(`${p}_matches`));
    assert.ok(tables.includes(`${p}_job_analysis`));
  }
});

test('§1A — o candidato pertence à plataforma, não a um modelo compartilhado', () => {
  // O spec de infraestrutura §1A REVERTEU a decisão anterior: o Perfil Mestre e
  // a Biblioteca compartilhada passaram a ser arquiteturalmente incorretos.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);

  for (const forbidden of ['core_master_profile', 'core_resumes', 'core_profile_attributes']) {
    assert.ok(!tables.includes(forbidden), `${forbidden} é proibida pelo §1A`);
  }

  for (const p of ['gupy', 'indeed', 'seasonal']) {
    assert.ok(tables.includes(`${p}_profiles`), `${p}_profiles deve existir`);
    assert.ok(tables.includes(`${p}_resumes`), `${p}_resumes deve existir`);
  }

  // A configuração de busca por produto e país continua separada.
  assert.ok(tables.includes('gupy_country_config'));
  assert.ok(tables.includes('indeed_country_config'));
  assert.ok(tables.includes('seasonal_config'));
});

test('§1B/§1C — currículos são filtrados por ambiente, não por um catálogo único', () => {
  const seed = (platform, country, name, track) => {
    db.prepare(`INSERT INTO ${platform}_resumes
      (country, name, career_track, doc_type, filename, original_name, file_path)
      VALUES (?,?,?,?,?,?,?)`)
      .run(country, name, track, 'resume', 'x.pdf', 'x.pdf', '/tmp/x.pdf');
  };

  seed('gupy', 'BR', 'BR Paid Media', 'paid_media');
  seed('gupy', 'US', 'US Paid Media', 'paid_media');
  seed('seasonal', 'US', 'US Hospitality', 'hospitality');

  const gupyBr = envOf('gupy', 'BR').listResumes();
  const gupyUs = envOf('gupy', 'US').listResumes();
  const seasonal = envOf('seasonal', 'US').listResumes();

  assert.deepStrictEqual(gupyBr.map(r => r.name), ['BR Paid Media']);
  assert.deepStrictEqual(gupyUs.map(r => r.name), ['US Paid Media']);
  assert.deepStrictEqual(seasonal.map(r => r.name), ['US Hospitality']);

  // O Indeed nunca vê nada do que foi cadastrado na Gupy ou no Seasonal.
  assert.deepStrictEqual(envOf('indeed', 'US').listResumes(), []);

  // Filtro por trilha continua funcionando, dentro do ambiente.
  const porTrilha = envOf('seasonal', 'US').listResumes({ careerTrack: 'hospitality' });
  assert.strictEqual(porTrilha.length, 1);
  assert.strictEqual(porTrilha[0].name, 'US Hospitality');
});

test('§1I — a recomendação escolhe dentro do ambiente e justifica', () => {
  const rec = envOf('seasonal', 'US').recommendResume({ careerTrack: 'hospitality' });
  assert.ok(rec.resume, 'deve devolver um currículo existente do próprio ambiente');
  assert.strictEqual(rec.resume.name, 'US Hospitality');
  assert.strictEqual(rec.environment, 'seasonal/US');
  assert.ok(rec.reason && rec.reason.length > 10, 'a escolha precisa vir com motivo');

  // Ambiente sem currículo NÃO recebe o de outro como alternativa (§1E).
  const vazio = envOf('indeed', 'BR').recommendResume({});
  assert.strictEqual(vazio.resume, null);
  assert.match(vazio.reason, /Nenhum currículo configurado para indeed\/BR/);
  assert.match(vazio.reason, /não usa o currículo de outra plataforma/i);
});

test('§74 — logs de cada produto ficam no seu próprio escopo', () => {
  db.prepare('DELETE FROM gupy_logs').run();
  db.prepare('DELETE FROM indeed_logs').run();

  gupyService.saveJob('BR', db.prepare("SELECT id FROM gupy_jobs WHERE external_id = 'g-br-2'").get().id);
  indeedService.saveJob('US', db.prepare("SELECT id FROM indeed_jobs WHERE external_id = 'i-us-1'").get().id);

  const gLogs = gupyService.logs('BR');
  const iLogs = indeedService.logs('US');

  assert.ok(gLogs.length > 0);
  assert.ok(iLogs.length > 0);

  // Um log do Indeed jamais aparece na tela do Gupy.
  const gupyBrLogs = db.prepare("SELECT COUNT(*) v FROM gupy_logs").get().v;
  const indeedUsLogs = db.prepare("SELECT COUNT(*) v FROM indeed_logs").get().v;
  assert.ok(gupyBrLogs > 0 && indeedUsLogs > 0);
  assert.ok(gLogs.every(l => l.country === 'BR' || l.country === null));
});

test('§74 — segredos nunca chegam ao log', () => {
  const { logCore } = require('../config/database');
  logCore('test', 'secret_check', 'mensagem', {
    mcp_token: 'super-secreto-123',
    api_key: 'sk-ant-xxxx',
    refresh_token: 'rt-yyyy',
    password: 'senha',
    innocuous: 'valor visível'
  });

  const row = db.prepare("SELECT metadata_json FROM core_audit_logs WHERE action = 'secret_check' ORDER BY id DESC LIMIT 1").get();
  const meta = JSON.parse(row.metadata_json);

  assert.strictEqual(meta.mcp_token, '[REDACTED]');
  assert.strictEqual(meta.api_key, '[REDACTED]');
  assert.strictEqual(meta.refresh_token, '[REDACTED]');
  assert.strictEqual(meta.password, '[REDACTED]');
  assert.strictEqual(meta.innocuous, 'valor visível');
  assert.ok(!row.metadata_json.includes('super-secreto-123'));
});
