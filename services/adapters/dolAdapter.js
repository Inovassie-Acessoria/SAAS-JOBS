/**
 * Seasonal Jobs — feeds oficiais do Departamento do Trabalho dos EUA.
 *
 * Fatos verificados no spec de infraestrutura (§17, §18, 2026-09-02):
 *
 *   - a página oficial rotula os feeds como JSON, mas os links resolvem para
 *     downloads em ZIP sob api.seasonaljobs.dol.gov;
 *   - os feeds são publicados diariamente à meia-noite (horário do leste dos EUA);
 *   - cada feed cobre uma janela móvel dos 20 dias anteriores.
 *
 * Consequências que este adapter implementa:
 *
 *   - NÃO presumir que o corpo da resposta é JSON: inspecionar o Content-Type,
 *     validar o arquivo e extrair com segurança (§18);
 *   - proteger contra ZIP Slip — nomes de arquivo dentro do ZIP não são confiáveis;
 *   - a janela de 20 dias torna a persistência histórica obrigatória (§21), o que
 *     acontece no banco, não aqui.
 */

const zlib = require('zlib');
const path = require('path');
const { HEALTH, IntegrationError } = require('./mcpClient');
const { readZipEntries } = require('../../core/documents/textExtract');
const fixtures = require('./fixtures');

const DEFAULT_BASE_URL = 'https://api.seasonaljobs.dol.gov';

/** Os três feeds oficiais e o que cada um contém (§17). */
const FEEDS = {
  jo:  { slug: 'jo',  label: '790/790A — ordens de serviço H-2A', form: '790/790A' },
  h2a: { slug: 'h2a', label: '9142A — pedidos H-2A com Notice of Acceptance', form: '9142A' },
  h2b: { slug: 'h2b', label: '9142B — pedidos H-2B com Notice of Acceptance', form: '9142B' }
};

const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024;   // recusa downloads absurdos
const MAX_ENTRY_BYTES   = 200 * 1024 * 1024;  // proteção contra zip bomb

const VISA_H2A = 'H-2A';
const VISA_H2B = 'H-2B';

// ---------------------------------------------------------------------------
// Extração segura
// ---------------------------------------------------------------------------

/**
 * Rejeita nomes de arquivo perigosos dentro do ZIP (ZIP Slip).
 * O spec §18 é explícito: não confiar em nomes nem caminhos do arquivo.
 */
function isSafeEntryName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 400) return false;

  const normalized = name.replace(/\\/g, '/');

  if (normalized.startsWith('/')) return false;                 // caminho absoluto
  if (/^[a-zA-Z]:/.test(normalized)) return false;              // unidade do Windows
  if (normalized.split('/').includes('..')) return false;       // traversal
  if (normalized.includes('\0')) return false;                  // byte nulo

  // Normalização final não pode escapar do diretório-raiz virtual.
  const resolved = path.posix.normalize('/' + normalized);
  return resolved.startsWith('/') && !resolved.startsWith('/..');
}

/**
 * Extrai entradas do arquivo, descartando com registro tudo que for inseguro.
 * @returns {{entries: Array, rejected: Array}}
 */
function safeExtract(buffer) {
  if (buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new IntegrationError(HEALTH.SCHEMA_CHANGED,
      'O arquivo baixado do DOL não é um ZIP válido. O formato da fonte pode ter mudado.',
      'assinatura ZIP ausente', false);
  }

  let raw;
  try {
    raw = readZipEntries(buffer);
  } catch (e) {
    throw new IntegrationError(HEALTH.SCHEMA_CHANGED,
      'Não foi possível abrir o arquivo enviado pelo DOL.', e.message, false);
  }

  const entries = [];
  const rejected = [];

  for (const e of raw) {
    if (!isSafeEntryName(e.name)) {
      rejected.push({ name: String(e.name).slice(0, 120), reason: 'nome de arquivo inseguro (path traversal)' });
      continue;
    }
    if (e.data && e.data.length > MAX_ENTRY_BYTES) {
      rejected.push({ name: e.name, reason: 'arquivo interno grande demais' });
      continue;
    }
    entries.push(e);
  }

  return { entries, rejected };
}

/** Escolhe, entre as entradas, a que contém os dados das ordens de serviço. */
function pickDataEntry(entries) {
  const byExt = ext => entries.filter(e => e.name.toLowerCase().endsWith(ext));
  const candidates = byExt('.json').concat(byExt('.ndjson')).concat(byExt('.jsonl')).concat(byExt('.csv'));
  const pool = candidates.length ? candidates : entries;
  if (!pool.length) return null;
  // O maior arquivo é, na prática, o conjunto de dados.
  return pool.reduce((a, b) => ((b.data ? b.data.length : 0) > (a.data ? a.data.length : 0) ? b : a));
}

/** Interpreta o arquivo de dados de acordo com o formato real, não com a extensão. */
function parseDataFile(entry) {
  const text = entry.data.toString('utf8').trim();
  if (!text) return { records: [], format: 'empty' };

  // JSON — array ou objeto envelopando a lista
  if (text[0] === '[' || text[0] === '{') {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return { records: parsed, format: 'json-array' };
      for (const k of ['jobs', 'results', 'data', 'items', 'records', 'value', 'caseData']) {
        if (Array.isArray(parsed[k])) return { records: parsed[k], format: `json-object.${k}` };
      }
      return { records: [parsed], format: 'json-object' };
    } catch (e) { /* pode ser NDJSON */ }
  }

  // NDJSON — um objeto JSON por linha
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length && lines[0].trim()[0] === '{') {
    const records = [];
    let bad = 0;
    for (const l of lines) {
      try { records.push(JSON.parse(l)); } catch (e) { bad++; }
    }
    if (records.length) return { records, format: 'ndjson', malformedLines: bad };
  }

  // CSV com cabeçalho
  if (lines.length > 1 && lines[0].includes(',')) {
    return { records: parseCsv(lines), format: 'csv' };
  }

  throw new IntegrationError(HEALTH.SCHEMA_CHANGED,
    'O arquivo de dados do DOL veio num formato que não reconhecemos. Nenhuma vaga foi importada e as já salvas continuam intactas.',
    `formato desconhecido em ${entry.name}`, false);
}

/** CSV com aspas — suficiente para os feeds do DOL, sem dependência externa. */
function parseCsv(lines) {
  const split = (line) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cur += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
  };

  const header = split(lines[0]);
  return lines.slice(1).map(line => {
    const cells = split(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] !== undefined ? cells[i] : null; });
    return row;
  });
}

// ---------------------------------------------------------------------------
// Normalização (§19 — mapeamento documentado em docs/integrations/seasonal)
// ---------------------------------------------------------------------------

/**
 * Nomes REAIS dos campos, verificados no feed publicado em 2026-09-14:
 *
 *   h2b (9142B)  caseNumber, tempneedJobtitle, tempneedSoc, tempneedWkrPos,
 *                tempneedStart/End ("01-Dec-2026"), empBusinessName, jobCity,
 *                jobState, jobDuties, jobMinspecialreq, jobMinexpmonths,
 *                wageFrom, wagePer, recIsLodging, recIsDailyTransport,
 *                recApplyEmail/Phone/Url, emppocEmail, attyEmail
 *   jo (790/790A) caseNumber, jobTitle, jobWrksNeededH2a, jobBeginDate/EndDate,
 *                jobDuties, jobAddReqinfo, jobIsLifting, jobLiftingWeight,
 *                jobIsDriver, jobWageOffer, jobWagePer, housing*, transportDesc*,
 *                recApplyEmail/Phone/Url, emppocEmail, socCode
 *
 * O feed é camelCase. A versão anterior deste normalizador esperava snake_case
 * (case_number, employer_name…) e rejeitava TODOS os registros reais como
 * "sem job_order_id" — a importação terminava com zero vagas sem dizer por quê.
 * Os nomes antigos continuam aceitos (fixtures, testes, CSV manual).
 */
function normalizeDolRecord(r, feedKey = 'jo') {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = r[k] !== undefined ? r[k] : r[k.toUpperCase()] !== undefined ? r[k.toUpperCase()] : undefined;
      if (v === undefined || v === null) continue;
      const t = String(v).trim();
      if (t === '' || /^(n\/?a|none|null|-)$/i.test(t)) continue;
      return v;
    }
    return null;
  };
  const email = (...keys) => {
    const v = pick(...keys);
    if (!v) return null;
    const m = String(v).match(/[^\s<>,;"']+@[^\s<>,;"']+\.[a-z]{2,}/i);
    return m ? m[0].toLowerCase() : null;
  };
  const yes = (v) => v === 1 || v === true || /^(1|true|y|yes|sim|x)$/i.test(String(v == null ? '' : v).trim());

  // --- contatos: candidatura explícita > ponto de contato do empregador > agente
  const applyEmail = email('recApplyEmail', 'apply_email', 'APPLY_EMAIL');
  const employerEmail = email('emppocEmail', 'emppocAddEmail', 'employer_email', 'contact_email', 'email', 'EMPLOYER_EMAIL');
  const attorneyEmail = email('attyEmail', 'attorney_email', 'agent_email', 'representative_email', 'ATTORNEY_EMAIL', 'AGENT_ATTORNEY_EMAIL');
  const applyUrlRaw = pick('recApplyUrl', 'apply_url', 'application_url', 'website', 'url', 'EMPLOYER_WEBSITE');
  const applyUrl = applyUrlRaw && /^https?:\/\/|^www\./i.test(String(applyUrlRaw)) ? String(applyUrlRaw).trim() : null;
  const phone = pick('recApplyPhone', 'emppocPhone', 'empPhone', 'employer_phone', 'contact_phone', 'phone', 'EMPLOYER_PHONE');

  let method = 'UNKNOWN';
  if (applyEmail || employerEmail || attorneyEmail) method = 'EMAIL';
  else if (applyUrl) method = 'WEBSITE';
  else if (phone) method = 'PHONE';

  // --- visto: pelo feed de origem, com o número do caso como confirmação
  const caseNumber = String(pick('caseNumber', 'clearanceOrderNumber', 'job_order_id', 'case_number', 'eta_case_number', 'CASE_NUMBER', 'id') || '').trim();
  const visaRaw = String(pick('visa_type', 'visa_class', 'program', 'VISA_CLASS') || '').toUpperCase();
  const visa = feedKey === 'h2b' || visaRaw.includes('H-2B') || visaRaw.includes('H2B') || /^H-400/.test(caseNumber)
    ? VISA_H2B : VISA_H2A;

  const title = pick('tempneedJobtitle', 'jobTitle', 'job_title', 'title', 'occupation_title', 'JOB_TITLE')
    || pick('tempneedSocTitle', 'socTitle', 'jobSocTitle') || 'Sem título';

  // --- requisitos estruturados viram texto: é o que o classificador lê
  const reqLines = [];
  const expMonths = parseInt(pick('jobMinexpmonths') || '0', 10);
  if (expMonths > 0) reqLines.push(`${expMonths} months of experience required.`);
  const trainMonths = parseInt(pick('jobMintrainingmonths') || '0', 10);
  if (trainMonths > 0) reqLines.push(`${trainMonths} months of training required.`);
  const edu = pick('jobMinedu');
  if (edu) reqLines.push(`Minimum education: ${edu}.`);
  if (yes(r.jobIsLifting)) reqLines.push(`Must be able to lift ${pick('jobLiftingWeight') || '50'} lb.`);
  if (yes(r.jobIsDriver)) reqLines.push("Valid driver's license required.");
  if (yes(r.jobIsBackground)) reqLines.push('Background check required.');
  if (yes(r.jobIsDrugScreen)) reqLines.push('Drug screening required.');
  if (yes(r.jobIsCert)) reqLines.push('Certification required.');
  const freeReq = pick('jobMinspecialreq', 'jobAddReqinfo', 'special_requirements', 'job_requirements', 'requirements', 'SPECIAL_REQUIREMENTS');
  if (freeReq) reqLines.push(String(freeReq));
  const specialRequirements = reqLines.length ? reqLines.join('\n') : null;

  // --- moradia: H-2A (790) sempre traz endereço de alojamento; H-2B usa recIsLodging
  const housing = yes(r.recIsLodging) || yes(r.jobHousingTransport)
    || Boolean(pick('housingAddr1') || pick('housingType'))
    || yes(pick('housing_provided', 'housing', 'employer_provided_housing', 'HOUSING_PROVIDED'));
  const transport = yes(r.recIsDailyTransport) || yes(r.isDailyTransport)
    || /provide/i.test(String(pick('transportDescDaily') || ''))
    || yes(pick('transportation_provided', 'transportation'));

  const attyName = [pick('attyFirstname'), pick('attyLastname')].filter(Boolean).join(' ')
    || pick('attyBizname', 'attorney_name', 'agent_name', 'ATTORNEY_NAME');

  // Página pública da vaga no site do DOL (verificado em 2026-09-14):
  //   https://seasonaljobs.dol.gov/jobs/<número do PEDIDO>
  // O pedido H-2B (9142B) já vem com esse número (H-400-…). A ordem H-2A
  // (790) vem como JO-A-300-N, e o site indexa pelo pedido H-300-N — mesmo
  // sufixo, conversão determinística. A página só existe depois que o DOL
  // aceita o pedido; o feed diz isso em dateAcceptanceLtrIssued. Sem aceite,
  // o link fica marcado como "publicação pendente" e o reimport diário corrige.
  const dol = dolPublicLink(caseNumber, feedKey, Boolean(pick('dateAcceptanceLtrIssued')));

  return {
    job_order_id: caseNumber,
    visa_type: visa,
    job_title: title,
    normalized_title: title,
    soc_code: pick('tempneedSoc', 'socCode', 'jobSoc', 'soc_code', 'occupation_code', 'SOC_CODE'),
    employer_name: pick('empBusinessName', 'empTradeName', 'employer_name', 'employer', 'company', 'EMPLOYER_NAME') || 'Empregador não informado',
    employer_city: pick('jobCity', 'empCity', 'employer_city', 'worksite_city', 'city', 'WORKSITE_CITY'),
    employer_state: pick('jobState', 'empState', 'employer_state', 'worksite_state', 'state', 'WORKSITE_STATE'),
    employer_phone: phone,
    employer_email: employerEmail,
    attorney_name: attyName || null,
    attorney_email: attorneyEmail,
    wage_rate: numberOrNull(pick('wageFrom', 'jobWageOffer', 'wage_rate', 'wage_offer', 'hourly_wage', 'basic_rate_from', 'WAGE_OFFER')),
    wage_unit: pick('wagePer', 'jobWagePer', 'wage_unit', 'pay_unit', 'WAGE_UNIT_OF_PAY') || 'Hour',
    start_date: toIsoDate(pick('tempneedStart', 'jobBeginDate', 'begin_date', 'start_date', 'employment_begin_date', 'EMPLOYMENT_BEGIN_DATE')),
    end_date: toIsoDate(pick('tempneedEnd', 'jobEndDate', 'end_date', 'employment_end_date', 'EMPLOYMENT_END_DATE')),
    openings: parseInt(pick('tempneedWkrPos', 'jobWrksNeededH2a', 'jobWrksNeeded', 'openings', 'total_workers', 'workers_needed', 'TOTAL_WORKERS') || '1', 10) || 1,
    weekly_hours: parseInt(pick('jobHoursTotal', 'hours_per_week', 'weekly_hours', 'BASIC_NUMBER_OF_HOURS') || '0', 10) || null,
    housing_provided: housing ? 1 : 0,
    transportation_provided: transport ? 1 : 0,
    duties_description: pick('jobDuties', 'job_duties', 'duties_description', 'description', 'JOB_DUTIES'),
    special_requirements: specialRequirements,
    application_method: method,
    application_email: applyEmail || employerEmail || attorneyEmail || null,
    application_url: applyUrl,
    provider_feed: feedKey,
    dol_url: dol.url,
    dol_published: dol.published ? 1 : 0,
    raw_json: JSON.stringify(r).slice(0, 20000)
  };
}

const DOL_JOB_PAGE = 'https://seasonaljobs.dol.gov/jobs/';

/**
 * Link público da vaga no seasonaljobs.dol.gov e se a página já existe.
 * Números fora do padrão (fixtures, CSV manual) não ganham link.
 */
function dolPublicLink(caseNumber, feedKey = 'jo', accepted = false) {
  const c = String(caseNumber || '').trim().toUpperCase();
  let m;
  if ((m = c.match(/^H-(300|400)-\d{5}-\d{6}$/))) {
    // 9142A / 9142B: o feed só publica pedidos já aceitos.
    return { url: DOL_JOB_PAGE + c, published: true, publicCase: c };
  }
  if ((m = c.match(/^JO-A-300-(\d{5}-\d{6})$/))) {
    const publicCase = `H-300-${m[1]}`;
    return { url: DOL_JOB_PAGE + publicCase, published: accepted, publicCase };
  }
  return { url: null, published: false, publicCase: null };
}

/**
 * Datas do feed chegam como "01-Dec-2026" (H-2B), "12-Nov-2026" (H-2A) ou ISO.
 * O banco e os filtros (mês de início, "ainda no período") esperam AAAA-MM-DD.
 */
const MONTHS_EN = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
function toIsoDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})-([A-Za-z]{3})[A-Za-z]*-(\d{4})$/);
  if (m && MONTHS_EN[m[2].toLowerCase()]) return `${m[3]}-${MONTHS_EN[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

function numberOrNull(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function truthy(v) {
  if (v == null) return false;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'y' || s === 'yes' || s === 'sim';
}

/** Data no formato do feed, no fuso do leste dos EUA (§20). */
function feedDate(offsetDays = 0, tz = 'America/New_York') {
  const d = new Date(Date.now() - offsetDays * 86400000);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(d);
  } catch (e) {
    return d.toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------

class DolAdapter {
  constructor(cfg = {}) {
    this.name = 'DOL Seasonal Jobs';
    this.baseUrl = (cfg.baseUrl || process.env.SEASONAL_FEED_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    // Compatibilidade: uma URL completa configurada manualmente continua válida.
    this.explicitUrl = cfg.feedUrl || '';
    this.fixtureMode = Boolean(cfg.fixtureMode);
    this.timeout = cfg.timeout || 60000;
    this.timezone = cfg.timezone || process.env.SEASONAL_SYNC_TIMEZONE || 'America/New_York';
  }

  isConfigured() { return Boolean(this.baseUrl || this.explicitUrl); }

  feedUrlFor(feedKey, date) {
    if (this.explicitUrl) return this.explicitUrl;
    const feed = FEEDS[feedKey] || FEEDS.jo;
    return `${this.baseUrl}/datahub-search/sjCaseData/zip/${feed.slug}/${date}`;
  }

  /** Baixa bytes crus e inspeciona o Content-Type — o corpo pode não ser JSON (§18). */
  async fetchArchive(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/zip, application/json' } });

      if (res.status === 404) {
        throw new IntegrationError(HEALTH.PROVIDER_UNAVAILABLE,
          'O DOL ainda não publicou o arquivo desta data. Os feeds saem à meia-noite do horário do leste dos EUA.',
          'HTTP 404', true);
      }
      if (res.status === 429) {
        throw new IntegrationError(HEALTH.DEGRADED,
          'O DOL está limitando as requisições. Tente novamente em alguns minutos.', 'HTTP 429', true);
      }
      if (res.status >= 500) {
        throw new IntegrationError(HEALTH.PROVIDER_UNAVAILABLE,
          'O serviço do DOL está indisponível no momento. Suas ordens já salvas continuam intactas.',
          `HTTP ${res.status}`, true);
      }
      if (!res.ok) {
        throw new IntegrationError(HEALTH.ERROR,
          'O DOL respondeu de forma inesperada.', `HTTP ${res.status}`, false);
      }

      const contentType = String(res.headers.get('content-type') || '').toLowerCase();
      const buffer = Buffer.from(await res.arrayBuffer());

      if (buffer.length > MAX_ARCHIVE_BYTES) {
        throw new IntegrationError(HEALTH.ERROR,
          'O arquivo do DOL veio maior do que o esperado e foi recusado por segurança.',
          `${buffer.length} bytes`, false);
      }
      if (!buffer.length) {
        throw new IntegrationError(HEALTH.PROVIDER_UNAVAILABLE,
          'O DOL devolveu um arquivo vazio para esta data.', 'corpo vazio', true);
      }

      return { buffer, contentType, url };
    } catch (err) {
      if (err instanceof IntegrationError) throw err;
      if (err.name === 'AbortError') {
        throw new IntegrationError(HEALTH.DEGRADED,
          `O download excedeu ${Math.round(this.timeout / 1000)} segundos. As ordens já importadas continuam disponíveis.`,
          'Timeout', true);
      }
      throw new IntegrationError(HEALTH.DISCONNECTED,
        'Não foi possível alcançar o serviço do DOL. Verifique sua conexão.', err.message, true);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Converte o download em registros, seja ele ZIP ou JSON direto. */
  decodeFeedPayload({ buffer, contentType }) {
    const looksZip = buffer.readUInt32LE(0) === 0x04034b50;
    const saysZip = contentType.includes('zip') || contentType.includes('octet-stream');

    if (looksZip || saysZip) {
      const { entries, rejected } = safeExtract(buffer);
      const dataEntry = pickDataEntry(entries);
      if (!dataEntry) {
        throw new IntegrationError(HEALTH.SCHEMA_CHANGED,
          'O arquivo do DOL não contém um arquivo de dados reconhecível.',
          `entradas: ${entries.map(e => e.name).join(', ') || 'nenhuma'}`, false);
      }
      const parsed = parseDataFile(dataEntry);
      return Object.assign({ transport: 'zip', entryName: dataEntry.name, rejectedEntries: rejected }, parsed);
    }

    // A página oficial rotula os feeds como JSON: se um dia voltar a ser, funciona.
    const parsed = parseDataFile({ name: 'response', data: buffer });
    return Object.assign({ transport: 'json', entryName: null, rejectedEntries: [] }, parsed);
  }

  async testConnection() {
    const steps = [];
    const startedAt = Date.now();
    const add = (step, ok, detail) => steps.push({ step, ok, detail });

    if (this.fixtureMode) {
      add('Modo fixture', true, 'Operando com ordens de serviço de exemplo. Nenhuma conexão externa é feita.');
      return { success: true, health: HEALTH.DEGRADED, fixtureMode: true, steps,
               userMessage: 'Rodando com dados de exemplo. Habilite o feed do DOL para importar ordens reais.' };
    }
    if (!this.isConfigured()) {
      add('Configuração', false, 'Nenhuma URL base configurada.');
      return { success: false, health: HEALTH.NOT_CONFIGURED, steps,
               userMessage: 'A fonte de dados do DOL ainda não foi configurada.' };
    }

    // O feed do dia pode não existir ainda; tenta hoje e recua até 3 dias.
    let lastError = null;
    for (let back = 0; back <= 3; back++) {
      const date = feedDate(back, this.timezone);
      const url = this.feedUrlFor('jo', date);
      try {
        const dl = await this.fetchArchive(url);
        add('Feed alcançável', true, `${url} (${Math.round(dl.buffer.length / 1024)} KB, ${dl.contentType || 'sem content-type'})`);

        const decoded = this.decodeFeedPayload(dl);
        add('Arquivo válido', true, decoded.transport === 'zip'
          ? `ZIP extraído com segurança${decoded.entryName ? `: ${decoded.entryName}` : ''}`
          : 'Resposta em JSON direto');
        if (decoded.rejectedEntries.length) {
          add('Entradas recusadas', true, `${decoded.rejectedEntries.length} arquivo(s) interno(s) descartado(s) por segurança`);
        }
        add('Registros reconhecidos', decoded.records.length > 0,
            `${decoded.records.length} registro(s), formato ${decoded.format}`);

        return {
          success: decoded.records.length > 0,
          health: decoded.records.length > 0 ? HEALTH.HEALTHY : HEALTH.SCHEMA_CHANGED,
          steps, latencyMs: Date.now() - startedAt, feedDate: date,
          userMessage: decoded.records.length > 0
            ? `Fonte do DOL conectada. Feed de ${date} com ${decoded.records.length} registro(s).`
            : 'O feed foi baixado, mas nenhum registro pôde ser lido. O formato da fonte pode ter mudado.'
        };
      } catch (err) {
        lastError = err;
        if (err.health === HEALTH.PROVIDER_UNAVAILABLE && back < 3) continue;
        break;
      }
    }

    const e = lastError instanceof IntegrationError
      ? lastError : new IntegrationError(HEALTH.ERROR, 'Falha inesperada.', String(lastError), false);
    add('Conexão', false, e.technical);
    return { success: false, health: e.health, steps, userMessage: e.userMessage, retryable: e.retryable };
  }

  async healthCheck() {
    if (this.fixtureMode) return { health: HEALTH.DEGRADED, fixtureMode: true };
    if (!this.isConfigured()) return { health: HEALTH.NOT_CONFIGURED };
    const r = await this.testConnection();
    return { health: r.health, userMessage: r.userMessage, latencyMs: r.latencyMs };
  }

  /**
   * Importa ordens de serviço já NORMALIZADAS.
   * @param {object} options { feeds:['jo','h2b'], date, daysBack }
   */
  async fetchJobs(options = {}) {
    if (this.fixtureMode || !this.isConfigured()) {
      const normalized = [];
      const rejected = [];
      for (const r of fixtures.dolRecords()) {
        const n = normalizeDolRecord(r, 'jo');
        if (n.job_order_id) normalized.push(n); else rejected.push({ reason: 'sem job_order_id' });
      }
      return { jobs: normalized, rejected, source: 'fixture', fixtureMode: true, feeds: [] };
    }

    // Padrão: ordens H-2A (790/790A) + pedidos H-2B (9142B). O 9142A não traz
    // título, funções nem salário — só repetiria o que o 790 já entrega.
    const wanted = Array.isArray(options.feeds) && options.feeds.length
      ? options.feeds.filter(f => FEEDS[f])
      : ['jo', 'h2b'];

    const all = [];
    const rejected = [];
    const feedReports = [];

    for (const feedKey of wanted) {
      let imported = false;
      let lastError = null;

      // O feed do dia pode ainda não existir; recua até 3 dias.
      for (let back = Number(options.daysBack || 0); back <= 3 && !imported; back++) {
        const date = options.date || feedDate(back, this.timezone);
        const url = this.feedUrlFor(feedKey, date);
        try {
          const dl = await this.fetchArchive(url);
          const decoded = this.decodeFeedPayload(dl);

          for (const r of decoded.records) {
            try {
              const n = normalizeDolRecord(r, feedKey);
              if (!n.job_order_id) { rejected.push({ feed: feedKey, reason: 'sem job_order_id' }); continue; }

              // Procedência: de QUAL publicação esta ordem veio.
              //
              // O feed do DOL é uma janela móvel dos 20 dias anteriores — uma
              // ordem entra, fica algumas publicações e sai. Sem gravar a data
              // da publicação, não há como saber de que safra a vaga é, nem se
              // ela ainda está publicada. O banco vira um monte indistinto.
              n.feed_date = date;
              n.feed_key = feedKey;

              all.push(n);
            } catch (e) {
              rejected.push({ feed: feedKey, reason: e.message });
            }
          }

          feedReports.push({
            feed: feedKey, label: FEEDS[feedKey].label, form: FEEDS[feedKey].form,
            date, url, transport: decoded.transport, format: decoded.format,
            received: decoded.records.length,
            rejectedEntries: decoded.rejectedEntries.length
          });
          imported = true;
        } catch (err) {
          lastError = err;
          if (err.health === HEALTH.PROVIDER_UNAVAILABLE) continue;
          break;
        }
      }

      if (!imported) {
        feedReports.push({ feed: feedKey, label: FEEDS[feedKey].label, error: lastError && lastError.userMessage });
        // Um feed indisponível não derruba os outros.
        if (wanted.length === 1) throw lastError;
      }
    }

    return { jobs: all, rejected, source: 'dol', fixtureMode: false, feeds: feedReports };
  }

  async fetchH2aJobOrders(o = {}) { return this.fetchJobs(Object.assign({}, o, { feeds: ['jo'] })); }
  async fetchH2aApplications(o = {}) { return this.fetchJobs(Object.assign({}, o, { feeds: ['h2a'] })); }
  async fetchH2bApplications(o = {}) { return this.fetchJobs(Object.assign({}, o, { feeds: ['h2b'] })); }
}

module.exports = {
  DolAdapter, FEEDS, DEFAULT_BASE_URL,
  normalizeDolRecord, toIsoDate, dolPublicLink, DOL_JOB_PAGE, isSafeEntryName, safeExtract, pickDataEntry, parseDataFile, parseCsv, feedDate,
  VISA_H2A, VISA_H2B
};
