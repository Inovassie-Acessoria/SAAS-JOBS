/**
 * F4.3 — procedência da ordem no feed do DOL (safra e janela de publicação).
 * F1.2 — documento por tipo de visto (H-2A × H-2B).
 *
 * Os dois recursos existem por causa de fatos do dado oficial:
 *
 *   o feed é uma janela móvel de 20 dias, então sem marcar a publicação de
 *   origem o acervo vira um monte indistinto;
 *
 *   H-2A é agricultura e H-2B não é, e o acervo real tem os dois convivendo.
 *
 * Nada aqui acessa a rede.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const tmpDb = path.join(os.tmpdir(), `h2a-feed-visa-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY
  || crypto.randomBytes(32).toString('base64');

const { db } = require('../config/database');
const candidate = require('../services/candidateService');
const seasonal = require('../services/seasonalService');

test.after(() => {
  for (const s of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + s); } catch (e) { /* já removido */ }
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UPSERT = `INSERT INTO seasonal_jobs
  (job_order_id, visa_type, job_title, employer_name, employer_state,
   application_method, application_email,
   first_seen_feed, last_seen_feed, feed_appearances, feed_key)
  VALUES (?,?,?,?,?,'EMAIL','rh@exemplo.com',?,?,1,'jo')
  ON CONFLICT(job_order_id) DO UPDATE SET
    first_seen_feed = COALESCE(seasonal_jobs.first_seen_feed, excluded.first_seen_feed),
    last_seen_feed = MAX(COALESCE(seasonal_jobs.last_seen_feed,''), COALESCE(excluded.last_seen_feed,'')),
    feed_appearances = COALESCE(seasonal_jobs.feed_appearances,0) + 1`;

function publishJob(id, feedDate, visa = 'H-2A') {
  db.prepare(UPSERT).run(id, visa, 'Heavy Truck Driver', 'Empregador Teste', 'IOWA',
                         feedDate, feedDate);
}

function addResume(name, visaType) {
  db.prepare(`INSERT INTO seasonal_resumes
    (user_id, country, name, career_track, doc_type, filename, original_name, file_path, visa_type, is_active)
    VALUES (1,'US',?, 'driving','resume',?,?,?,?,1)`)
    .run(name, `${name}.pdf`, `${name}.pdf`, `/tmp/${name}.pdf`, visaType);
}

function clearResumes() {
  db.prepare('DELETE FROM seasonal_resumes').run();
}

// ---------------------------------------------------------------------------
// F4.3 — procedência no feed
// ---------------------------------------------------------------------------

test('F4.3 — seasonal_jobs registra a publicação de origem', () => {
  const cols = db.prepare('PRAGMA table_info(seasonal_jobs)').all().map(c => c.name);
  for (const c of ['first_seen_feed', 'last_seen_feed', 'feed_appearances', 'feed_key']) {
    assert.ok(cols.includes(c), `falta a coluna ${c}`);
  }
});

test('F4.3 — a primeira aparição nunca é sobrescrita', () => {
  publishJob('F43-A', '2026-09-01');
  publishJob('F43-A', '2026-09-05');
  publishJob('F43-A', '2026-09-09');

  const r = db.prepare(
    'SELECT first_seen_feed, last_seen_feed, feed_appearances FROM seasonal_jobs WHERE job_order_id = ?'
  ).get('F43-A');

  assert.strictEqual(r.first_seen_feed, '2026-09-01',
    'a safra da vaga é a PRIMEIRA publicação; sobrescrever perde essa informação');
  assert.strictEqual(r.last_seen_feed, '2026-09-09', 'a última aparição avança');
  assert.strictEqual(r.feed_appearances, 3);
});

test('F4.3 — publicação fora de ordem não retrocede a última aparição', () => {
  publishJob('F43-B', '2026-09-08');
  publishJob('F43-B', '2026-09-02');   // reimportação de um feed antigo

  const r = db.prepare(
    'SELECT first_seen_feed, last_seen_feed FROM seasonal_jobs WHERE job_order_id = ?'
  ).get('F43-B');

  assert.strictEqual(r.last_seen_feed, '2026-09-08',
    'reimportar feed antigo não pode fazer a vaga parecer que saiu da janela');
  assert.strictEqual(r.first_seen_feed, '2026-09-08',
    'a primeira gravação permanece; COALESCE não substitui por data menor');
});

test('F4.3 — as safras são derivadas, não uma tabela nova', () => {
  publishJob('F43-C', '2026-07-15');
  publishJob('F43-D', '2026-07-20', 'H-2B');

  const s = seasonal.seasons();
  const julho = s.seasons.find(x => x.season === '2026-07');

  assert.ok(julho, 'julho/2026 precisa aparecer como safra');
  assert.strictEqual(julho.total, 2);
  assert.strictEqual(julho.h2a, 1);
  assert.strictEqual(julho.h2b, 1);
  assert.strictEqual(julho.label, 'jul/2026', 'o rótulo é legível ao usuário');
});

test('F4.3 — "ainda publicada" é a última publicação importada', () => {
  const latest = db.prepare('SELECT MAX(last_seen_feed) v FROM seasonal_jobs').get().v;
  const atuais = seasonal.listJobs({ stillPublished: true, limit: 500 });

  assert.ok(atuais.length > 0, 'alguma vaga tem de estar na publicação mais recente');
  for (const j of atuais) {
    assert.strictEqual(j.last_seen_feed, latest,
      'o filtro só pode devolver ordens vistas na publicação mais recente');
  }
});

test('F4.3 — ordem anterior ao recurso é declarada, não inventada', () => {
  db.prepare(`INSERT INTO seasonal_jobs (job_order_id, visa_type, job_title, employer_name)
              VALUES ('F43-LEGADO','H-2A','Driver','Antigo')`).run();

  const s = seasonal.seasons();
  assert.ok(s.unmarked >= 1,
    'vaga sem marcação precisa ser contada à parte — atribuir safra a ela seria invenção');
  assert.ok(!s.seasons.some(x => x.season === null),
    'ordem sem data não pode virar uma safra fantasma');
});

// ---------------------------------------------------------------------------
// F1.2 — documento por tipo de visto
// ---------------------------------------------------------------------------

test('F1.2 — cada tipo de visto usa o próprio currículo', () => {
  clearResumes();
  addResume('agricola', 'H-2A');
  addResume('hotelaria', 'H-2B');

  const store = candidate.environment('seasonal', 'US', 1);

  assert.strictEqual(store.recommendResume({ visaType: 'H-2A' }).resume.name, 'agricola');
  assert.strictEqual(store.recommendResume({ visaType: 'H-2B' }).resume.name, 'hotelaria');
});

test('F1.2 — sem currículo do visto, o sistema recusa em vez de usar o do outro', () => {
  clearResumes();
  addResume('agricola', 'H-2A');

  const store = candidate.environment('seasonal', 'US', 1);
  const r = store.recommendResume({ visaType: 'H-2B' });

  assert.strictEqual(r.resume, null,
    'entregar o currículo de agricultura numa vaga não-agrícola erra a conversa inteira');
  assert.match(r.reason, /H-2B/);
  assert.match(r.reason, /não é usado como substituto/i,
    'a recusa precisa dizer por que, não só falhar');
});

test('F1.2 — documento ANY serve aos dois vistos', () => {
  clearResumes();
  addResume('generico', 'ANY');

  const store = candidate.environment('seasonal', 'US', 1);
  assert.strictEqual(store.recommendResume({ visaType: 'H-2A' }).resume.name, 'generico');
  assert.strictEqual(store.recommendResume({ visaType: 'H-2B' }).resume.name, 'generico');
});

test('F1.2 — específico do visto ganha de ANY quando os dois existem', () => {
  clearResumes();
  addResume('generico', 'ANY');
  addResume('agricola', 'H-2A');

  const store = candidate.environment('seasonal', 'US', 1);
  assert.strictEqual(store.recommendResume({ visaType: 'H-2A' }).resume.name, 'agricola',
    'havendo um currículo feito para o visto, ele vem antes do genérico');
});

test('F1.2 — sem informar visto, o comportamento anterior é preservado', () => {
  clearResumes();
  addResume('agricola', 'H-2A');

  const store = candidate.environment('seasonal', 'US', 1);
  const r = store.recommendResume({});

  assert.ok(r.resume, 'chamada sem visto não pode passar a falhar — é o caminho antigo');
});

// ---------------------------------------------------------------------------
// Isolamento: o campo é do Seasonal e não escapa para os outros produtos
// ---------------------------------------------------------------------------

test('F1.2 — visa_type existe só no Seasonal, e a fábrica compartilhada tolera isso', () => {
  const has = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name).includes('visa_type');

  assert.strictEqual(has('seasonal_resumes'), true);
  assert.strictEqual(has('gupy_resumes'), false, 'Gupy não tem visto; a coluna não pertence lá');
  assert.strictEqual(has('indeed_resumes'), false, 'Indeed não tem visto; a coluna não pertence lá');

  // A listagem dos outros produtos precisa continuar funcionando. Pedir a
  // coluna em todos foi o que quebrou 12 testes de isolamento numa tentativa
  // anterior — este teste existe para isso não voltar.
  for (const p of ['gupy', 'indeed']) {
    for (const c of ['BR', 'US']) {
      const store = candidate.environment(p, c, 1);
      assert.doesNotThrow(() => store.listResumes({}),
        `listResumes quebrou em ${p}/${c} — a coluna do Seasonal vazou para a consulta compartilhada`);
      const rows = store.listResumes({});
      assert.ok(Array.isArray(rows));
    }
  }
});
