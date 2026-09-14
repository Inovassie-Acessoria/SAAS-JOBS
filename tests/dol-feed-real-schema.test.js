/**
 * Esquema REAL dos feeds do DOL (verificado em 2026-09-14).
 *
 * O bug que estes testes fecham: o normalizador esperava snake_case
 * (case_number, employer_name…) e o feed publicado é camelCase (caseNumber,
 * empBusinessName…). Resultado em produção: 1.201 registros baixados, 1.201
 * rejeitados como "sem job_order_id", zero vagas na tela — sem nenhum aviso.
 *
 * As amostras abaixo são registros reais, reduzidos aos campos que importam.
 */

const test = require('node:test');
const assert = require('node:assert');
const { normalizeDolRecord, toIsoDate, DolAdapter } = require('../services/adapters/dolAdapter');

// 9142B — pedido H-2B com Notice of Acceptance (feed "h2b")
const H2B = {
  caseNumber: 'H-400-26245-212581',
  tempneedJobtitle: 'Snow Removal Laborer', tempneedSoc: '37-3011.00',
  tempneedSocTitle: 'Landscaping and Groundskeeping Workers', tempneedWkrPos: 13,
  tempneedStart: '01-Dec-2026', tempneedEnd: '31-Mar-2027',
  empBusinessName: 'Green Forest Landscaping, LLC.', empCity: 'Lehi', empState: 'UT', empPhone: '+18014047176',
  emppocEmail: 'greenforestjose@gmail.com',
  attyFirstname: 'Maritza', attyLastname: 'Navarrete', attyBizname: 'NK Consulting Inc', attyEmail: 'nkconsultingutah@gmail.com',
  jobDuties: 'Remove snow and ice from sidewalks, walkways, driveways, parking lots.',
  jobHoursTotal: 35, jobMinedu: 'None', jobMinexpmonths: 0, jobMintrainingmonths: 0,
  jobMinspecialreq: 'Must be at least 18 years of age due to the operation of equipment.',
  jobCity: 'Lehi', jobState: 'UT',
  wageFrom: 20.19, wageTo: null, wagePer: 'Hour',
  recIsDailyTransport: 1, recIsLodging: 0,
  recApplyPhone: '+18018675375', recApplyEmail: 'greenforestjobs@gmail.com', recApplyUrl: 'N/A'
};

// 790/790A — ordem de serviço H-2A (feed "jo")
const JO = {
  caseNumber: 'JO-A-300-26257-231716',
  jobTitle: 'FARM LABOR', jobWrksNeeded: 2, jobWrksNeededH2a: 2,
  jobBeginDate: '12-Nov-2026', jobEndDate: '31-Aug-2027', jobHoursTotal: 48,
  jobDuties: 'EMPLOYEES WILL BE PICKING AND HARVESTING ONION AND FRESH PEAS.',
  jobWageOffer: 15.81, jobWagePer: 'Hour',
  jobMinedu: 'None', jobMinexpmonths: 3, jobIsDriver: 1, jobIsLifting: 1, jobLiftingWeight: 75,
  jobAddReqinfo: 'TRAINING WITH EMPLOYER. HEAVY BENDING AND STOOPING.',
  jobCity: 'Baxley', jobState: 'GA',
  housingAddr1: '600 Cecil Way', housingType: 'Employer-provided (including mobile or range)',
  transportDescDaily: 'Employer will provide free DAILY transportation.',
  recApplyPhone: '+19125551234', recApplyEmail: 'mcgintyflying@gmail.com', recApplyUrl: null,
  socCode: '45-2092.00', socTitle: 'Farmworkers and Laborers, Crop',
  empBusinessName: 'MCGINTY FLYING SERVICE INC', emppocEmail: 'owner@mcginty.invalid', emppocPhone: '+13185551234',
  swapocEmail: 'swa@state.invalid'   // contato da agência estadual — NUNCA é destinatário
};

test('registro H-2B real (9142B) vira uma vaga completa, com e-mail de candidatura', () => {
  const n = normalizeDolRecord(H2B, 'h2b');
  assert.strictEqual(n.job_order_id, 'H-400-26245-212581');
  assert.strictEqual(n.visa_type, 'H-2B');
  assert.strictEqual(n.job_title, 'Snow Removal Laborer');
  assert.strictEqual(n.soc_code, '37-3011.00');
  assert.strictEqual(n.employer_name, 'Green Forest Landscaping, LLC.');
  assert.strictEqual(n.employer_state, 'UT');
  assert.strictEqual(n.openings, 13);
  assert.strictEqual(n.weekly_hours, 35);
  assert.strictEqual(n.wage_rate, 20.19);
  assert.strictEqual(n.wage_unit, 'Hour');
  assert.strictEqual(n.start_date, '2026-12-01');
  assert.strictEqual(n.end_date, '2027-03-31');
  assert.strictEqual(n.housing_provided, 0);
  assert.strictEqual(n.transportation_provided, 1);
  // candidatura explícita tem precedência sobre o contato do empregador e o agente
  assert.strictEqual(n.application_email, 'greenforestjobs@gmail.com');
  assert.strictEqual(n.employer_email, 'greenforestjose@gmail.com');
  assert.strictEqual(n.attorney_email, 'nkconsultingutah@gmail.com');
  assert.strictEqual(n.attorney_name, 'Maritza Navarrete');
  assert.strictEqual(n.application_method, 'EMAIL');
  assert.strictEqual(n.application_url, null, '"N/A" não é uma URL');
  assert.match(n.special_requirements, /at least 18 years/);
});

test('ordem H-2A real (790) vira uma vaga completa, com moradia e requisitos estruturados em texto', () => {
  const n = normalizeDolRecord(JO, 'jo');
  assert.strictEqual(n.job_order_id, 'JO-A-300-26257-231716');
  assert.strictEqual(n.visa_type, 'H-2A');
  assert.strictEqual(n.job_title, 'FARM LABOR');
  assert.strictEqual(n.soc_code, '45-2092.00');
  assert.strictEqual(n.openings, 2);
  assert.strictEqual(n.wage_rate, 15.81);
  assert.strictEqual(n.start_date, '2026-11-12');
  assert.strictEqual(n.end_date, '2027-08-31');
  assert.strictEqual(n.housing_provided, 1, 'H-2A com endereço de alojamento = moradia fornecida');
  assert.strictEqual(n.transportation_provided, 1);
  assert.strictEqual(n.application_email, 'mcgintyflying@gmail.com');
  assert.strictEqual(n.employer_email, 'owner@mcginty.invalid');
  assert.strictEqual(n.attorney_email, null);
  assert.ok(!JSON.stringify(n).includes('swa@state.invalid') || n.raw_json.includes('swa@state.invalid'),
    'o e-mail da agência estadual não vira contato de candidatura');
  assert.notStrictEqual(n.application_email, 'swa@state.invalid');
  // requisitos estruturados viram frases que o classificador entende
  assert.match(n.special_requirements, /3 months of experience required/);
  assert.match(n.special_requirements, /lift 75 lb/);
  assert.match(n.special_requirements, /driver's license required/);
  assert.match(n.special_requirements, /HEAVY BENDING/);
});

test('sem e-mail explícito, cai no contato do empregador; sem nenhum, telefone; "N/A" conta como vazio', () => {
  const a = normalizeDolRecord(Object.assign({}, H2B, { recApplyEmail: 'N/A' }), 'h2b');
  assert.strictEqual(a.application_email, 'greenforestjose@gmail.com');
  const b = normalizeDolRecord(Object.assign({}, H2B, { recApplyEmail: null, emppocEmail: 'n/a', attyEmail: null }), 'h2b');
  assert.strictEqual(b.application_method, 'PHONE');
  assert.strictEqual(b.application_email, null);
});

test('número do caso H-400 marca H-2B mesmo vindo de outro feed; JO-A marca H-2A', () => {
  assert.strictEqual(normalizeDolRecord({ caseNumber: 'H-400-1' }, 'jo').visa_type, 'H-2B');
  assert.strictEqual(normalizeDolRecord({ caseNumber: 'JO-A-300-1' }, 'jo').visa_type, 'H-2A');
});

test('datas do feed ("01-Dec-2026") viram AAAA-MM-DD; ISO e MM/DD/AAAA também', () => {
  assert.strictEqual(toIsoDate('01-Dec-2026'), '2026-12-01');
  assert.strictEqual(toIsoDate('12-Nov-2026'), '2026-11-12');
  assert.strictEqual(toIsoDate('2026-09-02T22:31:25.150Z'), '2026-09-02');
  assert.strictEqual(toIsoDate('3/7/2027'), '2027-03-07');
  assert.strictEqual(toIsoDate(null), null);
});

test('os nomes antigos (fixtures, CSV manual) continuam aceitos', () => {
  const n = normalizeDolRecord({ case_number: 'H-300-27001-000001', job_title: 'Operator', employer_name: 'X', employer_email: 'a@b.invalid', begin_date: '2027-03-01' }, 'jo');
  assert.strictEqual(n.job_order_id, 'H-300-27001-000001');
  assert.strictEqual(n.application_email, 'a@b.invalid');
  assert.strictEqual(n.start_date, '2027-03-01');
});

test('por padrão a importação lê ordens H-2A (790) e pedidos H-2B (9142B)', async () => {
  const a = new DolAdapter({ baseUrl: 'https://feed.invalid' });
  const asked = [];
  a.fetchArchive = async (url) => { asked.push(url); const e = new Error('offline'); e.health = 'PROVIDER_UNAVAILABLE'; e.userMessage = 'offline'; throw e; };
  const r = await a.fetchJobs({});
  assert.ok(asked.some(u => u.includes('/zip/jo/')), 'lê o feed jo');
  assert.ok(asked.some(u => u.includes('/zip/h2b/')), 'lê o feed h2b');
  assert.ok(!asked.some(u => u.includes('/zip/h2a/')), 'não lê o 9142A (sem título, funções nem salário)');
  assert.strictEqual(r.jobs.length, 0);
});
