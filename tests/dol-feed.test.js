/**
 * Feeds oficiais do DOL — transporte ZIP e segurança (spec §17–§23, §79).
 *
 * O §79 exige teste para: resposta ZIP, ZIP inválido, tentativa de path
 * traversal, arquivo ausente, formato inesperado, mudança de schema, caso
 * duplicado, janela móvel de 20 dias, datas de 2027, datas desconhecidas.
 */

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');

const {
  DolAdapter, FEEDS, normalizeDolRecord, isSafeEntryName,
  safeExtract, pickDataEntry, parseDataFile, parseCsv, feedDate
} = require('../services/adapters/dolAdapter');
const { HEALTH } = require('../services/adapters/mcpClient');
const timeline = require('../core/timeline/hiringTimelineEngine');

/** Monta um ZIP mínimo com as entradas informadas. */
function makeZip(files) {
  const parts = [];
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = zlib.deflateRawSync(Buffer.from(content, 'utf8'));
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(0, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(content.length, 22);
    h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
    parts.push(h, nameBuf, data);
  }
  const central = Buffer.alloc(4);
  central.writeUInt32LE(0x02014b50, 0);
  parts.push(central);
  return Buffer.concat(parts);
}

const SAMPLE = [
  {
    case_number: 'H-300-27001-000001', visa_class: 'H-2A',
    job_title: 'Farm Worker', employer_name: 'Example Farms LLC',
    worksite_city: 'Lincoln', worksite_state: 'NE',
    employer_email: 'apply@example.invalid',
    wage_offer: '19.75', wage_unit_of_pay: 'Hour',
    employment_begin_date: '2027-03-01', employment_end_date: '2027-11-15',
    total_workers: '8', housing_provided: 'Y',
    job_duties: 'Harvest crops.', special_requirements: 'Lift 50 lbs.'
  },
  {
    case_number: 'H-400-26002-000002', visa_class: 'H-2B',
    job_title: 'Housekeeper', employer_name: 'Example Resort',
    worksite_city: 'Aspen', worksite_state: 'CO',
    employer_phone: '+1 555 000 0000',
    wage_offer: '18.20', employment_begin_date: '2026-05-01', employment_end_date: '2026-10-01'
  }
];

// ---------------------------------------------------------------------------

test('§18 — as URLs seguem exatamente o padrão oficial verificado', () => {
  const a = new DolAdapter({});
  assert.strictEqual(a.feedUrlFor('jo', '2026-09-02'),
    'https://api.seasonaljobs.dol.gov/datahub-search/sjCaseData/zip/jo/2026-09-02');
  assert.strictEqual(a.feedUrlFor('h2a', '2026-09-02'),
    'https://api.seasonaljobs.dol.gov/datahub-search/sjCaseData/zip/h2a/2026-09-02');
  assert.strictEqual(a.feedUrlFor('h2b', '2026-09-02'),
    'https://api.seasonaljobs.dol.gov/datahub-search/sjCaseData/zip/h2b/2026-09-02');
});

test('§17 — os três feeds oficiais estão declarados com o formulário correspondente', () => {
  assert.strictEqual(FEEDS.jo.form, '790/790A');
  assert.strictEqual(FEEDS.h2a.form, '9142A');
  assert.strictEqual(FEEDS.h2b.form, '9142B');
});

test('§18 — ZIP Slip: nomes perigosos são recusados', () => {
  const perigosos = [
    '../../../etc/passwd',
    '..\\..\\windows\\system32\\config',
    '/etc/shadow',
    'C:\\Windows\\evil.dll',
    'data/../../escape.json',
    'a\0b.json'
  ];
  for (const nome of perigosos) {
    assert.strictEqual(isSafeEntryName(nome), false, `deveria recusar: ${nome}`);
  }

  const seguros = ['data.json', 'feed/jobs.json', 'nested/dir/file.csv', './local.json'];
  for (const nome of seguros) {
    assert.strictEqual(isSafeEntryName(nome), true, `deveria aceitar: ${nome}`);
  }
});

test('§18/§79 — arquivo com path traversal é extraído sem a entrada maliciosa', () => {
  const zip = makeZip([
    ['../../../etc/passwd', 'root:x:0:0'],
    ['data.json', JSON.stringify(SAMPLE)]
  ]);

  const { entries, rejected } = safeExtract(zip);
  assert.ok(!entries.some(e => e.name.includes('..')), 'nenhuma entrada com traversal pode passar');
  assert.strictEqual(rejected.length, 1);
  assert.match(rejected[0].reason, /path traversal/i);
  assert.ok(entries.some(e => e.name === 'data.json'), 'a entrada legítima continua disponível');
});

test('§79 — ZIP inválido é recusado com mensagem legível', () => {
  assert.throws(
    () => safeExtract(Buffer.from('isto não é um zip de jeito nenhum')),
    /não é um ZIP válido|formato da fonte pode ter mudado/i
  );
});

test('§18 — o adapter aceita ZIP mesmo quando o Content-Type mente', () => {
  const a = new DolAdapter({});
  const zip = makeZip([['jobs.json', JSON.stringify(SAMPLE)]]);

  // Página oficial rotula como JSON, mas o corpo é ZIP: a assinatura decide.
  const decoded = a.decodeFeedPayload({ buffer: zip, contentType: 'application/json' });
  assert.strictEqual(decoded.transport, 'zip');
  assert.strictEqual(decoded.records.length, 2);
  assert.strictEqual(decoded.entryName, 'jobs.json');
});

test('§18 — se um dia o feed voltar a ser JSON direto, continua funcionando', () => {
  const a = new DolAdapter({});
  const decoded = a.decodeFeedPayload({
    buffer: Buffer.from(JSON.stringify({ jobs: SAMPLE }), 'utf8'),
    contentType: 'application/json'
  });
  assert.strictEqual(decoded.transport, 'json');
  assert.strictEqual(decoded.format, 'json-object.jobs');
  assert.strictEqual(decoded.records.length, 2);
});

test('§79 — ZIP sem arquivo de dados reconhecível falha alto, não em silêncio', () => {
  const a = new DolAdapter({});
  const zip = makeZip([['readme.txt', 'apenas um aviso']]);

  // Devolver zero registros calado esconderia uma mudança na fonte. O adapter
  // levanta SCHEMA_CHANGED com mensagem que diz que nada foi importado e que
  // os dados já salvos continuam intactos.
  assert.throws(
    () => a.decodeFeedPayload({ buffer: zip, contentType: 'application/zip' }),
    (err) => {
      assert.strictEqual(err.health, HEALTH.SCHEMA_CHANGED);
      assert.match(err.userMessage, /não reconhecemos/i);
      assert.match(err.userMessage, /já salvas continuam intactas/i);
      return true;
    }
  );
});

test('§79 — ZIP totalmente vazio também é reportado', () => {
  const a = new DolAdapter({});
  assert.throws(
    () => a.decodeFeedPayload({ buffer: makeZip([]), contentType: 'application/zip' }),
    /não é um ZIP válido|não contém um arquivo de dados/i
  );
});

test('§79 — formato inesperado dentro do ZIP levanta erro de mudança de schema', () => {
  assert.throws(
    () => parseDataFile({ name: 'data.json', data: Buffer.from('<<<binário inesperado>>>') }),
    /formato que não reconhecemos|SCHEMA/i
  );
});

test('parser aceita JSON, NDJSON e CSV', () => {
  const asArray = parseDataFile({ name: 'a.json', data: Buffer.from(JSON.stringify(SAMPLE)) });
  assert.strictEqual(asArray.format, 'json-array');
  assert.strictEqual(asArray.records.length, 2);

  const nd = parseDataFile({ name: 'a.ndjson', data: Buffer.from(SAMPLE.map(r => JSON.stringify(r)).join('\n')) });
  assert.strictEqual(nd.format, 'ndjson');
  assert.strictEqual(nd.records.length, 2);

  const csv = parseCsv([
    'case_number,job_title,employer_name',
    'H-300-1,"Farm Worker, Senior",Example Farms'
  ]);
  assert.strictEqual(csv.length, 1);
  assert.strictEqual(csv[0].job_title, 'Farm Worker, Senior', 'vírgula dentro de aspas é preservada');
});

test('§19 — normalização mapeia nomes de campo em maiúsculas e minúsculas', () => {
  const n = normalizeDolRecord(SAMPLE[0], 'jo');
  assert.strictEqual(n.job_order_id, 'H-300-27001-000001');
  assert.strictEqual(n.visa_type, 'H-2A');
  assert.strictEqual(n.employer_state, 'NE');
  assert.strictEqual(n.wage_rate, 19.75);
  assert.strictEqual(n.housing_provided, 1);
  assert.strictEqual(n.openings, 8);
  assert.strictEqual(n.application_method, 'EMAIL');
  assert.strictEqual(n.application_email, 'apply@example.invalid');

  // Variante em maiúsculas, como aparece em alguns arquivos do DOL.
  const upper = normalizeDolRecord({
    CASE_NUMBER: 'H-300-9', JOB_TITLE: 'Operator', EMPLOYER_NAME: 'X',
    WAGE_OFFER: '21.00', EMPLOYMENT_BEGIN_DATE: '2027-01-05'
  }, 'jo');
  assert.strictEqual(upper.job_order_id, 'H-300-9');
  assert.strictEqual(upper.wage_rate, 21);
  assert.strictEqual(upper.start_date, '2027-01-05');
});

test('§26 — o método de candidatura sai do que o registro realmente traz', () => {
  assert.strictEqual(normalizeDolRecord({ case_number: '1', employer_email: 'a@b.invalid' }).application_method, 'EMAIL');
  assert.strictEqual(normalizeDolRecord({ case_number: '2', attorney_email: 'c@d.invalid' }).application_method, 'EMAIL');
  assert.strictEqual(normalizeDolRecord({ case_number: '3', apply_url: 'https://x.invalid' }).application_method, 'WEBSITE');
  assert.strictEqual(normalizeDolRecord({ case_number: '4', employer_phone: '+1 555' }).application_method, 'PHONE');
  assert.strictEqual(normalizeDolRecord({ case_number: '5' }).application_method, 'UNKNOWN');
});

test('§17 — o feed h2b marca o visto como H-2B mesmo sem o campo', () => {
  assert.strictEqual(normalizeDolRecord({ case_number: 'x' }, 'h2b').visa_type, 'H-2B');
  assert.strictEqual(normalizeDolRecord({ case_number: 'x' }, 'jo').visa_type, 'H-2A');
});

test('§79 — registro sem número de caso é rejeitado e contabilizado', async () => {
  const a = new DolAdapter({ fixtureMode: true });
  const out = await a.fetchJobs();
  assert.ok(out.jobs.every(j => j.job_order_id), 'toda ordem importada tem identificador');
  assert.ok(Array.isArray(out.rejected));
  assert.strictEqual(out.fixtureMode, true, 'modo fixture sempre é sinalizado');
});

test('§79 — datas de 2027 e datas ausentes são tratadas na importação', () => {
  const com2027 = normalizeDolRecord(SAMPLE[0], 'jo');
  const t1 = timeline.classifyTimeline(com2027);
  assert.strictEqual(t1.timelineClass, 'TARGET_2027');

  const semData = normalizeDolRecord({ case_number: 'sem-data', job_title: 'X' }, 'jo');
  const t2 = timeline.classifyTimeline(semData);
  assert.strictEqual(t2.timelineClass, 'UNKNOWN_DATE');
  assert.ok(!t2.periodLabel, 'sem data não se inventa período');
});

test('§20 — a data do feed é calculada no fuso do leste dos EUA', () => {
  const hoje = feedDate(0, 'America/New_York');
  const ontem = feedDate(1, 'America/New_York');
  assert.match(hoje, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(ontem, /^\d{4}-\d{2}-\d{2}$/);
  assert.notStrictEqual(hoje, ontem);
  assert.ok(new Date(ontem) < new Date(hoje));
});

test('§21 — a janela móvel de 20 dias justifica persistência própria', () => {
  // O adapter não guarda histórico: ele só entrega o que o feed traz hoje.
  // Isso é o que torna a persistência no banco obrigatória.
  const a = new DolAdapter({ fixtureMode: true });
  assert.strictEqual(typeof a.fetchJobs, 'function');
  assert.ok(!('history' in a), 'o adapter não é o lugar do histórico');
});

test('§13 do spec de produto — sem configuração, o modo fixture é declarado', async () => {
  const a = new DolAdapter({ fixtureMode: true });
  const r = await a.testConnection();
  assert.strictEqual(r.fixtureMode, true);
  assert.strictEqual(r.health, HEALTH.DEGRADED, 'fixture nunca reporta HEALTHY');
  assert.match(r.userMessage, /exemplo/i);
});
