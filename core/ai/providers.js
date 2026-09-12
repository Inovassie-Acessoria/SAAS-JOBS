/**
 * Implementações de AIProvider (spec de agentes §5, §59).
 *
 *     DeterministicProvider   padrão — sem LLM, sem chave, sem custo
 *     OpenAIProvider
 *     GeminiProvider
 *     AnthropicProvider
 *
 * As três últimas falam HTTP direto com a API do fornecedor. Nenhum SDK entra
 * em `dependencies`: a §5 quer o produto desacoplado do vendor, e um SDK é
 * exatamente o acoplamento que ela evita. `fetch` é nativo no Node 22+.
 *
 * A chave NUNCA é lida de um campo salvo no banco. Ela vem de variável de
 * ambiente, e o banco guarda apenas o NOME da variável (§74 do spec de infra).
 */

const { AIProvider, AIProviderError } = require('./aiProvider');
const schemas = require('./schemas');

// ---------------------------------------------------------------------------
// Utilidades HTTP
// ---------------------------------------------------------------------------

/** Falha de rede/5xx/429 é retentável; 4xx de credencial não é. */
function classifyHttp(status, body) {
  if (status === 401 || status === 403) {
    return { retryable: false, message: 'Credencial recusada pelo provedor de IA. Verifique a chave configurada.' };
  }
  if (status === 429) {
    return { retryable: true, message: 'Limite de requisições do provedor de IA atingido. Tentando novamente.' };
  }
  if (status >= 500) {
    return { retryable: true, message: `O provedor de IA respondeu ${status}. Falha temporária.` };
  }
  return { retryable: false, message: `O provedor de IA recusou a requisição (${status}): ${String(body).slice(0, 300)}` };
}

async function postJson(url, { headers, body, timeoutMs, providerId }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, headers),
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err.name === 'AbortError';
    throw new AIProviderError(
      aborted ? `O provedor de IA não respondeu em ${timeoutMs}ms.` : `Falha de rede ao chamar o provedor de IA: ${err.message}`,
      { retryable: true, provider: providerId, cause: err }
    );
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) {
    const c = classifyHttp(res.status, text);
    throw new AIProviderError(c.message, { retryable: c.retryable, provider: providerId });
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new AIProviderError('O provedor de IA devolveu uma resposta que não é JSON.', { retryable: true, provider: providerId });
  }
}

// ---------------------------------------------------------------------------
// Provedor determinístico — o padrão do produto
// ---------------------------------------------------------------------------

/**
 * Sem LLM. Existe para que o sistema inteiro funcione sem nenhuma chave de API,
 * que é como ele roda hoje (§4: "Do NOT train a proprietary model in V1" não
 * obriga a ter um LLM para operar).
 *
 * Ele não finge ser um modelo: os métodos que exigiriam geração livre declaram
 * `unavailable: true`, e quem chama cai no caminho determinístico já existente
 * — ontologia, regras ATS e montagem de carta por template com lastro no perfil.
 */
class DeterministicProvider extends AIProvider {
  constructor(opts = {}) {
    super(Object.assign({ id: 'none', model: 'deterministic' }, opts));
  }

  isConfigured() { return true; }

  describe() {
    return {
      id: this.id,
      model: this.model,
      configured: true,
      llm: false,
      note: 'Nenhum LLM configurado. A análise usa ontologia curada e regras determinísticas; ' +
            'a carta e o e-mail são montados por template, com cada bloco condicionado a um fato do perfil.',
      version: this.constructor.name
    };
  }

  async healthCheck() {
    return { ok: true, message: 'Modo determinístico: nenhuma dependência externa é necessária.', llm: false };
  }

  async complete() {
    throw new AIProviderError(
      'Nenhum provedor de IA está configurado. Este passo usa o caminho determinístico.',
      { retryable: false, provider: this.id }
    );
  }

  /** Sinaliza indisponibilidade em vez de gerar texto sem modelo. */
  async analyzeJob() { return { unavailable: true, provider: this.id }; }
  async extractRequirements() { return { unavailable: true, provider: this.id }; }
  async compareCandidate() { return { unavailable: true, provider: this.id }; }
  async generateCoverLetter() { return { unavailable: true, provider: this.id }; }
  async generateApplicationEmail() { return { unavailable: true, provider: this.id }; }
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

class OpenAIProvider extends AIProvider {
  constructor(opts = {}) {
    super(Object.assign({ id: 'openai', model: 'gpt-4o-mini' }, opts));
    this.baseUrl = opts.baseUrl || 'https://api.openai.com/v1';
  }

  async complete({ system, prompt, temperature, maxTokens }) {
    if (!this.apiKey) {
      throw new AIProviderError('A chave da OpenAI não está disponível na variável de ambiente configurada.',
        { retryable: false, provider: this.id });
    }

    const data = await postJson(`${this.baseUrl}/chat/completions`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
      timeoutMs: this.timeoutMs,
      providerId: this.id,
      body: {
        model: this.model,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          system ? { role: 'system', content: system } : null,
          { role: 'user', content: prompt }
        ].filter(Boolean)
      }
    });

    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : null;
    if (!content) throw new AIProviderError('A OpenAI devolveu uma resposta vazia.', { retryable: true, provider: this.id });
    return content;
  }

  async healthCheck() {
    if (!this.apiKey) return { ok: false, message: 'Chave ausente na variável de ambiente configurada.' };
    try {
      const r = await this.complete({ system: 'Responda em JSON.', prompt: 'Devolva {"ok":true}.', temperature: 0, maxTokens: 20 });
      const p = schemas.parseJson(r);
      return { ok: p.ok, message: p.ok ? `Conectado ao modelo ${this.model}.` : 'Resposta inesperada do modelo.', llm: true };
    } catch (err) {
      return { ok: false, message: err.message, retryable: Boolean(err.retryable) };
    }
  }
}

// ---------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------

class GeminiProvider extends AIProvider {
  constructor(opts = {}) {
    super(Object.assign({ id: 'gemini', model: 'gemini-2.0-flash' }, opts));
    this.baseUrl = opts.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  }

  async complete({ system, prompt, temperature, maxTokens }) {
    if (!this.apiKey) {
      throw new AIProviderError('A chave do Gemini não está disponível na variável de ambiente configurada.',
        { retryable: false, provider: this.id });
    }

    const data = await postJson(
      `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      {
        timeoutMs: this.timeoutMs,
        providerId: this.id,
        body: {
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
            responseMimeType: 'application/json'
          }
        }
      }
    );

    const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content
      ? data.candidates[0].content.parts : null;
    const content = Array.isArray(parts) ? parts.map(p => p.text || '').join('') : null;
    if (!content) throw new AIProviderError('O Gemini devolveu uma resposta vazia.', { retryable: true, provider: this.id });
    return content;
  }

  async healthCheck() {
    if (!this.apiKey) return { ok: false, message: 'Chave ausente na variável de ambiente configurada.' };
    try {
      const r = await this.complete({ system: 'Responda em JSON.', prompt: 'Devolva {"ok":true}.', temperature: 0, maxTokens: 20 });
      const p = schemas.parseJson(r);
      return { ok: p.ok, message: p.ok ? `Conectado ao modelo ${this.model}.` : 'Resposta inesperada do modelo.', llm: true };
    } catch (err) {
      return { ok: false, message: err.message, retryable: Boolean(err.retryable) };
    }
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

class AnthropicProvider extends AIProvider {
  constructor(opts = {}) {
    super(Object.assign({ id: 'anthropic', model: 'claude-sonnet-5' }, opts));
    this.baseUrl = opts.baseUrl || 'https://api.anthropic.com/v1';
    this.apiVersion = opts.apiVersion || '2023-06-01';
  }

  async complete({ system, prompt, temperature, maxTokens }) {
    if (!this.apiKey) {
      throw new AIProviderError('A chave da Anthropic não está disponível na variável de ambiente configurada.',
        { retryable: false, provider: this.id });
    }

    const data = await postJson(`${this.baseUrl}/messages`, {
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': this.apiVersion },
      timeoutMs: this.timeoutMs,
      providerId: this.id,
      body: {
        model: this.model,
        max_tokens: maxTokens,
        temperature,
        system: system || undefined,
        messages: [{ role: 'user', content: prompt }]
      }
    });

    const content = Array.isArray(data && data.content)
      ? data.content.filter(b => b.type === 'text').map(b => b.text).join('')
      : null;
    if (!content) throw new AIProviderError('A Anthropic devolveu uma resposta vazia.', { retryable: true, provider: this.id });
    return content;
  }

  async healthCheck() {
    if (!this.apiKey) return { ok: false, message: 'Chave ausente na variável de ambiente configurada.' };
    try {
      const r = await this.complete({ system: 'Responda em JSON.', prompt: 'Devolva {"ok":true}.', temperature: 0, maxTokens: 32 });
      const p = schemas.parseJson(r);
      return { ok: p.ok, message: p.ok ? `Conectado ao modelo ${this.model}.` : 'Resposta inesperada do modelo.', llm: true };
    } catch (err) {
      return { ok: false, message: err.message, retryable: Boolean(err.retryable) };
    }
  }
}

const REGISTRY = {
  none: DeterministicProvider,
  deterministic: DeterministicProvider,
  openai: OpenAIProvider,
  gemini: GeminiProvider,
  google: GeminiProvider,
  anthropic: AnthropicProvider
};

/** Modelo padrão por provedor — sobrescrito pela configuração do usuário. */
const DEFAULT_MODEL = {
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  anthropic: 'claude-sonnet-5'
};

/** Variável de ambiente sugerida por provedor (§74 — a chave nunca vai ao banco). */
const DEFAULT_KEY_ENV = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY'
};

module.exports = {
  DeterministicProvider, OpenAIProvider, GeminiProvider, AnthropicProvider,
  REGISTRY, DEFAULT_MODEL, DEFAULT_KEY_ENV, classifyHttp
};
