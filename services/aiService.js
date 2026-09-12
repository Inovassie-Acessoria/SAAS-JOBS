/**
 * Resolução do provedor de IA a partir da configuração (spec de agentes §5, §58, §59).
 *
 * `core/ai/` não conhece banco nem HTTP — é essa camada que lê a configuração,
 * resolve a chave a partir da VARIÁVEL DE AMBIENTE e entrega um AIProvider
 * pronto. O banco guarda o NOME da variável, nunca a chave (§74 do spec de infra).
 *
 * A §59 recomenda um único LLM forte para a V1, com prompts diferentes por
 * papel — e não um modelo por agente. É o que este arquivo faz: um provedor,
 * vários papéis.
 *
 * A §58 exige controle de custo. Cada chamada é contabilizada em
 * `core_ai_usage`, com o rótulo do papel que a originou.
 */

const { db, logCore } = require('../config/database');
const { AIProvider, AIProviderError } = require('../core/ai/aiProvider');
const { REGISTRY, DEFAULT_MODEL, DEFAULT_KEY_ENV, DeterministicProvider } = require('../core/ai/providers');

let cached = null;
let cachedSignature = null;

function getSetting(key, fallback = '') {
  try {
    const r = db.prepare('SELECT value FROM core_system_settings WHERE key = ?').get(key);
    return r && r.value !== null && r.value !== '' ? r.value : fallback;
  } catch (e) {
    return fallback;
  }
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO core_system_settings (key, value, category, description)
              VALUES (?,?, 'ai', '')
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
    .run(key, String(value == null ? '' : value));
}

/**
 * Lê a configuração atual de IA.
 * `apiKeyRef` é o NOME da variável de ambiente; o valor nunca é persistido.
 */
function readConfig() {
  const providerId = String(getSetting('ai_provider', 'none') || 'none').toLowerCase();
  const apiKeyRef = getSetting('ai_api_key_ref', DEFAULT_KEY_ENV[providerId] || '');
  const model = getSetting('llm_model', '') || DEFAULT_MODEL[providerId] || null;
  return { providerId, apiKeyRef, model };
}

/** Constrói (ou reaproveita) o provedor correspondente à configuração atual. */
function getProvider() {
  const cfg = readConfig();
  const keyValue = cfg.apiKeyRef ? (process.env[cfg.apiKeyRef] || '') : '';
  const signature = `${cfg.providerId}|${cfg.model}|${cfg.apiKeyRef}|${keyValue ? 'set' : 'unset'}`;

  if (cached && cachedSignature === signature) return cached;

  const Ctor = REGISTRY[cfg.providerId] || DeterministicProvider;
  cached = new Ctor({ model: cfg.model || undefined, apiKey: keyValue || null });
  cachedSignature = signature;
  return cached;
}

/** Invalida o cache — usado depois de mudar a configuração. */
function reset() {
  cached = null;
  cachedSignature = null;
}

/** Há um LLM de verdade disponível agora? */
function llmAvailable() {
  const p = getProvider();
  return !(p instanceof DeterministicProvider) && p.isConfigured();
}

/**
 * Estado da IA para a interface e para o relatório de prontidão.
 * Nunca devolve a chave — só se a variável está preenchida.
 */
function status() {
  const cfg = readConfig();
  const provider = getProvider();
  const keySet = Boolean(cfg.apiKeyRef && process.env[cfg.apiKeyRef]);

  return {
    provider: cfg.providerId,
    model: provider.model,
    apiKeyRef: cfg.apiKeyRef || null,
    apiKeyPresent: keySet,
    llmAvailable: llmAvailable(),
    describe: provider.describe(),
    usage: usageSummary(),
    /** O que falta para ligar o LLM, dito em uma frase. */
    requirement: cfg.providerId === 'none'
      ? 'Nenhum LLM configurado. O sistema opera em modo determinístico — análise por ontologia e regras, textos por template com lastro no perfil.'
      : keySet
        ? null
        : `Defina a variável de ambiente ${cfg.apiKeyRef || DEFAULT_KEY_ENV[cfg.providerId] || 'da chave'} no servidor e reinicie o processo.`
  };
}

/** Atualiza a configuração de IA. A chave em si NUNCA passa por aqui. */
function updateConfig({ provider, apiKeyRef, model }) {
  if (provider !== undefined) {
    const p = String(provider).toLowerCase();
    if (!REGISTRY[p]) {
      const e = new Error(`Provedor de IA desconhecido: "${provider}". Válidos: ${Object.keys(REGISTRY).join(', ')}.`);
      e.userFacing = true;
      throw e;
    }
    setSetting('ai_provider', p);
    if (apiKeyRef === undefined && DEFAULT_KEY_ENV[p]) setSetting('ai_api_key_ref', DEFAULT_KEY_ENV[p]);
    if (model === undefined && DEFAULT_MODEL[p]) setSetting('llm_model', DEFAULT_MODEL[p]);
  }

  if (apiKeyRef !== undefined) {
    const ref = String(apiKeyRef).trim();
    // Um valor que parece uma chave de verdade é recusado: o campo é o NOME da variável.
    if (/^(sk-|AIza|xai-|anthropic-)/i.test(ref) || ref.length > 64) {
      const e = new Error('Este campo recebe o NOME da variável de ambiente (ex.: ANTHROPIC_API_KEY), nunca a chave. A chave fica no servidor.');
      e.userFacing = true;
      throw e;
    }
    setSetting('ai_api_key_ref', ref);
  }

  if (model !== undefined) setSetting('llm_model', String(model).trim());

  reset();
  const s = status();
  logCore('ai', 'config_updated', `Provedor de IA definido como "${s.provider}" (modelo ${s.model || 'padrão'}).`,
    { provider: s.provider, model: s.model, apiKeyRef: s.apiKeyRef, apiKeyPresent: s.apiKeyPresent });
  return s;
}

async function testConnection() {
  const provider = getProvider();
  const r = await provider.healthCheck();
  logCore('ai', 'health_check', r.message, { provider: provider.id, ok: r.ok }, null, r.ok ? 'info' : 'warn');
  return Object.assign({ provider: provider.id, model: provider.model }, r);
}

// ---------------------------------------------------------------------------
// Contabilidade de uso (§58)
// ---------------------------------------------------------------------------

function recordUsage({ role, provider, model, promptChars = 0, completionChars = 0, ok = true, error = null, durationMs = 0 }) {
  try {
    db.prepare(`INSERT INTO core_ai_usage (role, provider, model, prompt_chars, completion_chars, ok, error, duration_ms)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(role, provider, model, promptChars, completionChars, ok ? 1 : 0, error, durationMs);
  } catch (e) { /* contabilidade nunca derruba o fluxo */ }
}

function usageSummary(days = 30) {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS calls,
             SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok_calls,
             SUM(prompt_chars) AS prompt_chars,
             SUM(completion_chars) AS completion_chars
      FROM core_ai_usage
      WHERE created_at >= datetime('now', ?)
    `).get(`-${Number(days)} days`);
    return {
      windowDays: days,
      calls: row.calls || 0,
      okCalls: row.ok_calls || 0,
      promptChars: row.prompt_chars || 0,
      completionChars: row.completion_chars || 0
    };
  } catch (e) {
    return { windowDays: days, calls: 0, okCalls: 0, promptChars: 0, completionChars: 0 };
  }
}

/**
 * Executa um papel do LLM com contabilidade e degradação explícita.
 *
 * Se não houver LLM, devolve `{ unavailable: true }` — quem chama segue pelo
 * caminho determinístico. Nenhuma etapa do produto DEPENDE do LLM (§4).
 */
async function run(role, fn) {
  const provider = getProvider();
  if (!llmAvailable()) return { unavailable: true, provider: provider.id };

  const started = Date.now();
  const before = Object.assign({}, provider.usage);

  try {
    const result = await fn(provider);
    recordUsage({
      role, provider: provider.id, model: provider.model,
      promptChars: provider.usage.promptChars - before.promptChars,
      completionChars: provider.usage.completionChars - before.completionChars,
      ok: true, durationMs: Date.now() - started
    });
    return result;
  } catch (err) {
    recordUsage({
      role, provider: provider.id, model: provider.model,
      promptChars: provider.usage.promptChars - before.promptChars,
      completionChars: 0, ok: false, error: err.message, durationMs: Date.now() - started
    });
    logCore('ai', 'call_failed', `Falha no papel "${role}": ${err.message}`,
      { role, provider: provider.id, retryable: Boolean(err.retryable) }, null, 'warn');
    // Falha de LLM degrada para determinístico — nunca derruba a candidatura.
    return { unavailable: true, provider: provider.id, error: err.message };
  }
}

module.exports = {
  AIProvider, AIProviderError,
  getProvider, reset, llmAvailable, status, readConfig, updateConfig,
  testConnection, run, recordUsage, usageSummary,
  DEFAULT_KEY_ENV, DEFAULT_MODEL
};
