/**
 * Índice de busca público do seasonaljobs.dol.gov.
 *
 * É o que o próprio site consulta (POST /datahub/search, Azure Cognitive
 * Search). Verificado em 2026-09-14: 201.403 casos indexados, 5.485 ativos.
 * Ele complementa o feed ZIP em duas coisas que o feed não tem:
 *
 *   - o ESTADO de cada caso (active, case_status, active_date, accepted_date),
 *     que diz se a vaga ainda está aberta ao recrutamento ou foi retirada;
 *   - TODAS as vagas ativas, e não só a janela de 20 dias do feed.
 *
 * Não é uma API documentada: pode mudar sem aviso. Por isso o feed continua
 * sendo a fonte primária, e qualquer falha aqui degrada em silêncio — nunca
 * derruba a importação.
 */

const { toIsoDate, dolPublicLink } = require('./dolAdapter');

const SEARCH_URL = process.env.DOL_INDEX_SEARCH_URL
  || 'https://api.seasonaljobs.dol.gov/datahub/search?api-version=2020-06-30';
const PAGE = 1000;           // máximo aceito pelo índice por requisição
const LOOKUP_BATCH = 60;     // casos por consulta de status
const TIMEOUT_MS = 45000;

/** O índice grafa o estado por extenso ("CALIFORNIA"); o banco usa a sigla. */
const STATE_CODES = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA', COLORADO: 'CO', CONNECTICUT: 'CT',
  DELAWARE: 'DE', 'DISTRICT OF COLUMBIA': 'DC', FLORIDA: 'FL', GEORGIA: 'GA', HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL',
  INDIANA: 'IN', IOWA: 'IA', KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
  MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO', MONTANA: 'MT',
  NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ', 'NEW MEXICO': 'NM', 'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH', OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA',
  'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC', 'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT',
  VERMONT: 'VT', VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY',
  'PUERTO RICO': 'PR', GUAM: 'GU', 'VIRGIN ISLANDS': 'VI', 'AMERICAN SAMOA': 'AS', 'NORTHERN MARIANA ISLANDS': 'MP'
};

function stateCode(v) {
  if (!v) return null;
  const s = String(v).trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(s)) return s;
  return STATE_CODES[s] || s.slice(0, 2);
}

function clean(v) {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' || /^(n\/?a|none|null|-)$/i.test(t) ? null : t;
}

function emailOf(v) {
  const t = clean(v);
  if (!t) return null;
  const m = t.match(/[^\s<>,;"']+@[^\s<>,;"']+\.[a-z]{2,}/i);
  return m ? m[0].toLowerCase() : null;
}

async function post(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(SEARCH_URL, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (H2Dream)' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`Índice do DOL respondeu HTTP ${res.status}.`);
    const json = await res.json();
    if (json.error) throw new Error(`Índice do DOL: ${json.error.message || 'erro'}`);
    return json;
  } finally { clearTimeout(timer); }
}

/**
 * Número que o resto do sistema usa como identidade da vaga.
 *
 * O feed identifica a ordem H-2A pelo 790 (JO-A-300-N); o índice, pelo pedido
 * (H-300-N). Mesmo sufixo. Chavear as duas fontes pelo 790 evita a mesma vaga
 * entrar duas vezes. H-2B já é o mesmo número nos dois lugares.
 */
function internalCaseNumber(caseNumber) {
  const c = String(caseNumber || '').trim().toUpperCase();
  const m = c.match(/^H-300-(\d{5}-\d{6})$/);
  return m ? `JO-A-300-${m[1]}` : c;
}

/** Registro do índice → mesmo formato que o normalizador do feed produz. */
function normalizeIndexRecord(v) {
  const publicCase = String(v.case_number || '').trim().toUpperCase();
  const visa = String(v.visa_class || '').toUpperCase().includes('H-2B') || /^H-400/.test(publicCase) ? 'H-2B' : 'H-2A';
  const jobOrderId = internalCaseNumber(publicCase);
  const applyEmail = emailOf(v.apply_email);
  const employerEmail = emailOf(v.employer_email);
  const applyUrlRaw = clean(v.apply_url);
  const applyUrl = applyUrlRaw && /^https?:\/\/|^www\./i.test(applyUrlRaw) ? applyUrlRaw : null;
  const phone = clean(v.apply_phone) || clean(v.employer_phone);

  let method = 'UNKNOWN';
  if (applyEmail || employerEmail) method = 'EMAIL';
  else if (applyUrl) method = 'WEBSITE';
  else if (phone) method = 'PHONE';

  const req = [];
  const months = parseInt(v.emp_exp_num_months || 0, 10);
  if (months > 0) req.push(`${months} months of experience required.`);
  const training = parseInt(v.num_months_training || 0, 10);
  if (training > 0) req.push(`${training} months of training required.`);
  const edu = clean(v.education_level);
  if (edu) req.push(`Minimum education: ${edu}.`);
  const special = clean(v.special_req);
  if (special) req.push(special);

  const unit = clean(v.pay_range_desc) || 'Hour';
  const link = dolPublicLink(publicCase, visa === 'H-2B' ? 'h2b' : 'h2a', true);
  const title = clean(v.job_title) || clean(v.soc_title) || 'Sem título';

  return {
    job_order_id: jobOrderId,
    visa_type: visa,
    job_title: title,
    normalized_title: title,
    soc_code: clean(v.soc_code_id),
    employer_name: clean(v.employer_business_name) || clean(v.employer_trade_name) || 'Empregador não informado',
    employer_city: clean(v.worksite_city) || clean(v.employer_city),
    employer_state: stateCode(clean(v.worksite_state) || clean(v.employer_state)),
    employer_phone: phone,
    employer_email: employerEmail,
    attorney_name: null,
    attorney_email: null,
    wage_rate: Number.isFinite(Number(v.basic_rate_from)) && Number(v.basic_rate_from) > 0 ? Number(v.basic_rate_from) : null,
    wage_unit: unit,
    start_date: toIsoDate(v.begin_date),
    end_date: toIsoDate(v.end_date),
    openings: parseInt(v.total_positions || '1', 10) || 1,
    weekly_hours: parseInt(v.work_hour_num_basic || '0', 10) || null,
    // H-2A: moradia é exigência legal do programa. H-2B: o índice não informa.
    housing_provided: visa === 'H-2A' ? 1 : 0,
    transportation_provided: visa === 'H-2A' ? 1 : 0,
    duties_description: clean(v.job_duties),
    special_requirements: req.length ? req.join('\n') : null,
    application_method: method,
    application_email: applyEmail || employerEmail || null,
    application_url: applyUrl,
    provider_feed: 'index',
    dol_url: link.url,
    dol_published: 1,
    dol_active: v.active === true ? 1 : (v.active === false ? 0 : null),
    dol_status: clean(v.case_status),
    dol_accepted_at: toIsoDate(v.accepted_date),
    dol_active_until: toIsoDate(v.active_date),
    raw_json: JSON.stringify(v).slice(0, 20000)
  };
}

/** Todas as vagas ativas do índice, paginadas. */
async function fetchActive({ onPage = null } = {}) {
  const out = [];
  let skip = 0, total = null;
  for (;;) {
    const page = await post({
      search: '*', filter: 'active eq true', top: PAGE, skip, count: skip === 0,
      orderby: 'accepted_date desc'
    });
    if (total === null) total = page['@odata.count'] || 0;
    const rows = page.value || [];
    for (const v of rows) out.push(normalizeIndexRecord(v));
    if (onPage) onPage({ fetched: out.length, total });
    skip += rows.length;
    if (!rows.length || skip >= total || skip >= 100000) break;
  }
  return { jobs: out, total, rejected: [], source: 'index', fixtureMode: false, feeds: [{ feed: 'index', label: 'Índice do seasonaljobs.dol.gov (vagas ativas)', received: out.length }] };
}

/**
 * Estado atual de casos específicos, em lotes. Devolve um mapa
 * número-público → { active, status, acceptedAt, activeUntil } — casos não
 * indexados (pedido ainda não aceito) ficam de fora do mapa.
 */
async function lookupCases(publicCases) {
  const found = {};
  const list = [...new Set(publicCases.map(c => String(c || '').trim().toUpperCase()).filter(Boolean))];
  for (let i = 0; i < list.length; i += LOOKUP_BATCH) {
    const batch = list.slice(i, i + LOOKUP_BATCH);
    const page = await post({
      search: batch.map(c => `"${c}"`).join(' | '), searchFields: 'case_number', searchMode: 'any',
      top: batch.length, select: 'case_number,active,case_status,accepted_date,active_date,begin_date,end_date'
    });
    for (const v of page.value || []) {
      found[String(v.case_number).toUpperCase()] = {
        active: v.active === true ? 1 : 0,
        status: clean(v.case_status),
        acceptedAt: toIsoDate(v.accepted_date),
        activeUntil: toIsoDate(v.active_date)
      };
    }
  }
  return found;
}

/**
 * Registros completos de casos específicos (descrição, e-mail de candidatura,
 * estado), em lotes — mapa número-público → registro normalizado. Serve para
 * enriquecer a base de divulgação, que não traz a descrição das tarefas.
 */
async function fetchCases(publicCases, { onBatch = null } = {}) {
  const found = {};
  const list = [...new Set(publicCases.map(c => String(c || '').trim().toUpperCase()).filter(Boolean))];
  for (let i = 0; i < list.length; i += LOOKUP_BATCH) {
    const batch = list.slice(i, i + LOOKUP_BATCH);
    const page = await post({
      search: batch.map(c => `"${c}"`).join(' | '), searchFields: 'case_number', searchMode: 'any', top: batch.length
    });
    for (const v of page.value || []) found[String(v.case_number).toUpperCase()] = normalizeIndexRecord(v);
    if (onBatch) onBatch({ done: Math.min(i + LOOKUP_BATCH, list.length), total: list.length, found: Object.keys(found).length });
  }
  return found;
}

module.exports = { SEARCH_URL, STATE_CODES, stateCode, internalCaseNumber, normalizeIndexRecord, fetchActive, lookupCases, fetchCases };
