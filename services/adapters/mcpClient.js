/**
 * Cliente MCP e adapters de Gupy/Indeed (spec §40, §41, §42).
 *
 * Diferente da versão anterior, `testConnection()` PODE REPROVAR: ela executa
 * o handshake de verdade contra a URL configurada, com timeout, e classifica a
 * falha em um estado legível pelo usuário. Sem URL configurada o adapter reporta
 * NOT_CONFIGURED — nunca HEALTHY.
 *
 * Fixtures existem apenas em modo explícito (`fixtureMode`), sempre rotulado na
 * resposta, para permitir desenvolvimento sem credencial (spec §0.7).
 */

const HEALTH = {
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  REQUIRES_ATTENTION: 'REQUIRES_ATTENTION',
  DISCONNECTED: 'DISCONNECTED',
  SCHEMA_CHANGED: 'SCHEMA_CHANGED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  AUTH_ERROR: 'AUTH_ERROR',
  ERROR: 'ERROR',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  CUSTOM_CLIENT_ACCESS_UNAVAILABLE: 'CUSTOM_CLIENT_ACCESS_UNAVAILABLE'
};

/**
 * Capacidades internas (spec §8). O produto raciocina sobre CAPACIDADES, não
 * sobre nomes de tool do provedor — que mudam sem aviso. O adapter descobre as
 * tools em runtime e decide qual atende cada capacidade.
 */
const CAPABILITY = {
  JOB_SEARCH: 'JOB_SEARCH',
  JOB_DETAIL: 'JOB_DETAIL',
  COMPANY_DATA: 'COMPANY_DATA',
  RESUME_ANALYSIS: 'RESUME_ANALYSIS'
};

/** Padrões de nome que costumam atender cada capacidade, do mais ao menos específico. */
const CAPABILITY_PATTERNS = {
  JOB_SEARCH:      [/search[_-]?jobs?/i, /jobs?[_-]?search/i, /find[_-]?jobs?/i, /list[_-]?jobs?/i, /vagas/i],
  JOB_DETAIL:      [/job[_-]?detail/i, /get[_-]?job/i, /job[_-]?info/i],
  COMPANY_DATA:    [/company[_-]?(data|detail|info)/i, /employer/i],
  RESUME_ANALYSIS: [/resume/i, /curriculo/i, /cv[_-]?analysis/i]
};

/** Mapeia a lista de tools do servidor para as capacidades internas. */
function mapCapabilities(toolNames) {
  const map = {};
  for (const cap of Object.keys(CAPABILITY_PATTERNS)) {
    const hit = CAPABILITY_PATTERNS[cap]
      .map(re => toolNames.find(t => re.test(t)))
      .find(Boolean);
    map[cap] = hit ? { available: true, tool: hit } : { available: false, tool: null };
  }
  return map;
}

const DEFAULT_TIMEOUT_MS = 8000;

/** Erro de integração com mensagem já pronta para o usuário (spec §42). */
class IntegrationError extends Error {
  constructor(health, userMessage, technical, retryable = true) {
    super(userMessage);
    this.name = 'IntegrationError';
    this.health = health;
    this.userMessage = userMessage;
    this.technical = technical;
    this.retryable = retryable;
  }
}

/**
 * Lê o corpo de uma resposta MCP.
 *
 * O transporte Streamable HTTP pode devolver JSON puro OU um fluxo de eventos
 * (SSE), a critério do servidor — e o da Gupy escolhe SSE:
 *
 *     event: message
 *     data: {"result":{...}}
 *
 * Tratar as duas formas é exigência do transporte, não gentileza: parsear só
 * JSON faz uma integração perfeitamente saudável parecer quebrada.
 */
function parseMcpBody(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('corpo vazio');

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);

  // Enquadramento SSE: interessa a última linha `data:` com JSON válido.
  const payloads = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.*)$/);
    if (m && m[1] && m[1] !== '[DONE]') payloads.push(m[1]);
  }
  for (let i = payloads.length - 1; i >= 0; i--) {
    try { return JSON.parse(payloads[i]); } catch (e) { /* tenta o anterior */ }
  }

  return JSON.parse(trimmed);   // deixa o erro original subir
}

async function httpJson(url, { method = 'POST', body = null, token = null, timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      method,
      headers: Object.assign(
        // O transporte Streamable HTTP do MCP exige que o cliente aceite os
        // DOIS tipos. Só com "application/json" o servidor devolve HTTP 406
        // ("Client must accept both application/json and text/event-stream"),
        // e a integração inteira parecia indisponível por causa do cabeçalho.
        { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        token ? { Authorization: `Bearer ${token}` } : {}
      ),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    const text = await res.text();

    if (res.status === 401 || res.status === 403) {
      throw new IntegrationError(
        HEALTH.REQUIRES_ATTENTION,
        'A autenticação expirou ou foi recusada. Reconecte a conta para continuar buscando vagas.',
        `HTTP ${res.status}`, false
      );
    }
    if (res.status === 429) {
      throw new IntegrationError(
        HEALTH.DEGRADED,
        'O serviço está limitando as requisições no momento. Tente novamente em alguns minutos.',
        'HTTP 429', true
      );
    }
    if (res.status >= 500) {
      throw new IntegrationError(
        HEALTH.DEGRADED,
        'O serviço externo está indisponível no momento. Suas vagas e análises já salvas estão seguras.',
        `HTTP ${res.status}`, true
      );
    }
    if (!res.ok) {
      throw new IntegrationError(
        HEALTH.ERROR,
        'O serviço respondeu de forma inesperada. Verifique a configuração da integração.',
        `HTTP ${res.status}: ${text.slice(0, 200)}`, false
      );
    }

    try {
      return parseMcpBody(text);
    } catch (e) {
      throw new IntegrationError(
        HEALTH.ERROR,
        'A resposta do serviço não pôde ser interpretada. A integração pode ter mudado de formato.',
        `Resposta não-JSON: ${text.slice(0, 200)}`, false
      );
    }
  } catch (err) {
    if (err instanceof IntegrationError) throw err;
    if (err.name === 'AbortError') {
      throw new IntegrationError(
        HEALTH.DEGRADED,
        `A conexão excedeu ${Math.round(timeout / 1000)} segundos sem resposta. Suas vagas já salvas continuam disponíveis.`,
        'Timeout', true
      );
    }
    throw new IntegrationError(
      HEALTH.DISCONNECTED,
      'Não foi possível alcançar o serviço. Verifique o endereço configurado e sua conexão.',
      err.message, true
    );
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------

class McpAdapter {
  /**
   * @param {object} cfg { name, url, token, requiredTools, fixtures }
   */
  constructor(cfg) {
    this.name = cfg.name;
    this.url = cfg.url || '';
    this.token = cfg.token || '';
    this.requiredTools = cfg.requiredTools || [];
    this.fixtures = cfg.fixtures || null;
    this.fixtureMode = Boolean(cfg.fixtureMode);
  }

  isConfigured() { return Boolean(this.url && this.url.trim()); }

  /**
   * Diagnóstico em etapas (spec §40). Cada etapa reporta seu próprio resultado,
   * então a UI consegue dizer EM QUAL passo a conexão falhou.
   */
  async testConnection() {
    const steps = [];
    const startedAt = Date.now();
    const add = (name, ok, detail) => steps.push({ step: name, ok, detail });

    if (this.fixtureMode) {
      add('Modo fixture', true, 'Adapter operando com dados de exemplo locais. Nenhuma conexão externa é feita.');
      return {
        success: true, health: HEALTH.DEGRADED, fixtureMode: true, steps,
        tools: this.requiredTools,
        userMessage: 'Rodando com dados de exemplo. Configure a URL do MCP para buscar vagas reais.'
      };
    }

    if (!this.isConfigured()) {
      add('Configuração', false, 'Nenhuma URL de MCP configurada para esta integração.');
      return {
        success: false, health: HEALTH.NOT_CONFIGURED, steps, tools: [],
        userMessage: `A integração ${this.name} ainda não foi configurada. Informe o endereço do servidor MCP para começar.`
      };
    }

    try {
      // 1. Servidor alcançável + 2. protocolo MCP
      const init = await httpJson(this.url, {
        body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'job-intelligence', version: '2.0' } } },
        token: this.token
      });
      add('Servidor alcançável', true, this.url);

      if (!init || (!init.result && !init.error)) {
        add('Protocolo MCP', false, 'A resposta não segue o formato JSON-RPC do MCP.');
        return { success: false, health: HEALTH.ERROR, steps, tools: [],
                 userMessage: 'O endereço respondeu, mas não parece ser um servidor MCP.' };
      }
      if (init.error) {
        add('Protocolo MCP', false, init.error.message || 'Erro retornado pelo servidor.');
        return { success: false, health: HEALTH.ERROR, steps, tools: [],
                 userMessage: 'O servidor MCP recusou a inicialização.' };
      }
      add('Protocolo MCP', true, `Versão ${(init.result.protocolVersion) || 'não informada'}`);
      add('Autenticação', true, this.token ? 'Token aceito.' : 'Servidor não exigiu autenticação.');

      // 3. Ferramentas disponíveis
      const toolsRes = await httpJson(this.url, {
        body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        token: this.token
      });
      const tools = ((toolsRes.result && toolsRes.result.tools) || []).map(t => t.name);
      add('Ferramentas detectadas', tools.length > 0, tools.length ? tools.join(', ') : 'Nenhuma ferramenta exposta.');

      // Descoberta de capacidades (§8): o produto não fixa nomes de tool.
      const capabilities = mapCapabilities(tools);
      this.capabilities = capabilities;

      const needed = this.requiredCapabilities || ['JOB_SEARCH'];
      const missing = needed.filter(cap => !capabilities[cap] || !capabilities[cap].available);

      if (missing.length) {
        add('Capacidades necessárias', false, `Sem tool que atenda: ${missing.join(', ')}`);
        return {
          success: false, health: HEALTH.REQUIRES_ATTENTION, steps, tools, capabilities,
          userMessage: `O servidor está conectado, mas não oferece busca de vagas (${missing.join(', ')}). A descoberta de vagas ficará indisponível até o provedor expor essa capacidade.`
        };
      }

      const resolved = needed.map(c => `${c} → ${capabilities[c].tool}`).join(', ');
      add('Capacidades necessárias', true, resolved);

      // Requisição de teste segura (§9): busca mínima, só para validar o formato.
      try {
        const probe = await this.callToolByCapability('JOB_SEARCH', { limit: 1, keywords: '' });
        const looksValid = probe && (Array.isArray(probe) || typeof probe === 'object');
        add('Requisição de teste', Boolean(looksValid),
            looksValid ? 'Resposta recebida e interpretável.' : 'Resposta em formato inesperado.');
        if (!looksValid) {
          return {
            success: false, health: HEALTH.SCHEMA_CHANGED, steps, tools, capabilities,
            userMessage: 'O servidor respondeu, mas em um formato que não reconhecemos. A integração pode ter mudado.'
          };
        }
      } catch (probeErr) {
        add('Requisição de teste', false, probeErr.technical || probeErr.message);
        return {
          success: false,
          health: probeErr.health || HEALTH.ERROR,
          steps, tools, capabilities,
          userMessage: probeErr.userMessage || 'A busca de teste não pôde ser concluída.'
        };
      }

      return {
        success: true, health: HEALTH.HEALTHY, steps, tools, capabilities,
        latencyMs: Date.now() - startedAt,
        userMessage: `${this.name} conectado e operando.`
      };
    } catch (err) {
      const e = err instanceof IntegrationError ? err : new IntegrationError(HEALTH.ERROR, 'Falha inesperada.', err.message, false);
      add('Conexão', false, e.technical);
      return { success: false, health: e.health, steps, tools: [], userMessage: e.userMessage, retryable: e.retryable };
    }
  }

  async healthCheck() {
    if (this.fixtureMode) return { health: HEALTH.DEGRADED, fixtureMode: true };
    if (!this.isConfigured()) return { health: HEALTH.NOT_CONFIGURED };
    const r = await this.testConnection();
    return { health: r.health, tools: r.tools, userMessage: r.userMessage };
  }

  /** Chama uma tool MCP e devolve o payload já desembrulhado. */
  async callTool(toolName, args = {}) {
    if (this.fixtureMode) {
      if (!this.fixtures || !this.fixtures[toolName]) {
        throw new IntegrationError(HEALTH.ERROR, `Não há dados de exemplo para "${toolName}".`, 'fixture ausente', false);
      }
      return this.fixtures[toolName](args);
    }
    if (!this.isConfigured()) {
      throw new IntegrationError(
        HEALTH.NOT_CONFIGURED,
        `A integração ${this.name} não está configurada. Configure-a em Integrações antes de buscar vagas.`,
        'sem URL', false
      );
    }

    const res = await httpJson(this.url, {
      body: { jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: toolName, arguments: args } },
      token: this.token
    });

    if (res.error) {
      throw new IntegrationError(HEALTH.ERROR,
        'O serviço recusou a busca. Verifique os filtros e tente novamente.',
        res.error.message || 'erro MCP', false);
    }

    const content = res.result && res.result.content;
    if (Array.isArray(content)) {
      const textNode = content.find(c => c.type === 'text');
      if (textNode) {
        try { return JSON.parse(textNode.text); }
        catch (e) { return { raw: textNode.text }; }
      }
    }
    return res.result;
  }

  /**
   * Chama a tool que atende uma CAPACIDADE, descobrindo-a se necessário (§8).
   * O produto nunca precisa saber como o provedor batizou a ferramenta.
   */
  async callToolByCapability(capability, args = {}) {
    if (this.fixtureMode) return this.callTool(capability, args);

    if (!this.capabilities) await this.discoverCapabilities();

    const entry = this.capabilities && this.capabilities[capability];
    if (!entry || !entry.available) {
      throw new IntegrationError(
        HEALTH.REQUIRES_ATTENTION,
        `Este provedor não oferece a capacidade necessária (${capability}) no momento.`,
        `capacidade ${capability} indisponível`, false
      );
    }
    return this.callTool(entry.tool, args);
  }

  /** Lista as tools do servidor e mapeia para capacidades internas. */
  async discoverCapabilities() {
    if (this.fixtureMode) {
      this.capabilities = mapCapabilities(Object.keys(this.fixtures || {}));
      return this.capabilities;
    }
    if (!this.isConfigured()) {
      throw new IntegrationError(HEALTH.NOT_CONFIGURED,
        `A integração ${this.name} não está configurada.`, 'sem URL', false);
    }

    const res = await httpJson(this.url, {
      body: { jsonrpc: '2.0', id: Date.now(), method: 'tools/list', params: {} },
      token: this.token
    });
    const tools = ((res.result && res.result.tools) || []).map(t => t.name);
    this.discoveredTools = tools;
    this.capabilities = mapCapabilities(tools);
    return this.capabilities;
  }

  async searchJobs(params) { return this.callToolByCapability(CAPABILITY.JOB_SEARCH, params); }
  async getJobDetails(id) { return this.callToolByCapability(CAPABILITY.JOB_DETAIL, { id }); }
}

/**
 * Gupy — MCP público de candidatos.
 *
 * Endpoint oficial documentado (verificado em 2026-09-02):
 *   https://candidates.mcp.api.gupy.io/mcp
 *
 * A documentação oficial não descreve token para esta conexão, então o adapter
 * NÃO exige um (spec §5: "do NOT invent a mandatory Gupy token"). O campo de
 * autenticação existe e é opcional, para o caso de a Gupy passar a exigir.
 */
const GUPY_OFFICIAL_MCP_URL = 'https://candidates.mcp.api.gupy.io/mcp';

class GupyAdapter extends McpAdapter {
  constructor(cfg = {}) {
    super(Object.assign({
      name: 'Gupy MCP',
      // A capacidade necessária é "buscar vagas"; o nome da tool é descoberto
      // em runtime (§8), não fixado aqui.
      requiredCapabilities: ['JOB_SEARCH']
    }, cfg, {
      url: cfg.url || process.env.GUPY_MCP_URL || GUPY_OFFICIAL_MCP_URL
    }));
    this.authMode = cfg.authMode || process.env.GUPY_MCP_AUTH_MODE || 'none';
    this.officialUrl = GUPY_OFFICIAL_MCP_URL;
  }

  isOfficialEndpoint() { return this.url === GUPY_OFFICIAL_MCP_URL; }

  /**
   * Traduz entre o contrato genérico do produto e a API real da Gupy.
   *
   * Duas diferenças que faziam a busca voltar vazia mesmo com a conexão
   * saudável — o pior tipo de falha, porque nada acusa erro:
   *
   *   1. o parâmetro de busca chama-se `term`, não `keywords`;
   *   2. as vagas vêm em `data.data`, e o `boardService` procura `jobs`.
   *
   * A tradução vive aqui, no adaptador, para que o serviço de produto continue
   * sem saber o formato de nenhum provedor específico.
   */
  async searchJobs(params = {}) {
    const args = {
      term: params.keywords || params.term || '',
      limit: Math.min(100, Number(params.limit) || 50),
      offset: Number(params.offset) || 0
    };
    if (params.city) args.city = params.city;
    if (params.state) args.state = params.state;

    const res = await this.callToolByCapability(CAPABILITY.JOB_SEARCH, args);

    const inner = (res && res.data) || res || {};
    const rows = Array.isArray(inner.data) ? inner.data
               : Array.isArray(inner) ? inner
               : [];

    return {
      jobs: rows.map(j => GupyAdapter.normalizeJob(j)),
      pagination: inner.pagination || null,
      fixtureMode: false
    };
  }

  /** Campos verificados contra a resposta real da tool `search_jobs`. */
  static normalizeJob(j) {
    const city = j.city || '';
    const state = j.state || '';
    return {
      external_id: String(j.id != null ? j.id : ''),
      title: j.name || 'Sem título',
      normalized_title: j.name || null,
      // `careerPageName` é o nome público da empresa ("Trabalhe na Sollo").
      company: j.careerPageName || (j.companyId ? `Empresa ${j.companyId}` : 'Empresa não informada'),
      location: [city, state].filter(Boolean).join(' - '),
      workplace_type: /remot/i.test(j.type || '') ? 'remote' : 'onsite',
      job_type: j.type || null,
      salary_month: typeof j.salary === 'number' ? j.salary : null,
      apply_url: j.jobUrl || '',
      published_date: j.publishedDate || null,
      description: j.description || '',
      raw_json: j
    };
  }
}

/**
 * Indeed — MCP oficial em beta, porém disponível apenas via Claude Connector
 * na data de verificação (2026-09-02).
 *
 * O spec §12/§13 é explícito: não presumir que um backend próprio pode conectar
 * hoje, não inventar URL nem token, e não criar um contorno não oficial. O
 * adapter existe com a fronteira correta e reporta o estado honestamente até que
 * o acesso para cliente próprio seja oficialmente liberado.
 */
class IndeedAdapter extends McpAdapter {
  constructor(cfg = {}) {
    super(Object.assign({ name: 'Indeed MCP', requiredCapabilities: ['JOB_SEARCH'] }, cfg));
    this.customClientEnabled =
      cfg.customClientEnabled !== undefined
        ? Boolean(cfg.customClientEnabled)
        : process.env.INDEED_CUSTOM_MCP_ENABLED === 'true';
  }

  async testConnection() {
    if (!this.customClientEnabled) {
      return {
        success: false,
        health: HEALTH.CUSTOM_CLIENT_ACCESS_UNAVAILABLE,
        steps: [
          { step: 'MCP oficial', ok: true,
            detail: 'O Indeed documenta um MCP remoto em beta (Streamable HTTP).' },
          { step: 'Acesso para cliente próprio', ok: false,
            detail: 'A documentação oficial disponibiliza a conexão apenas via Claude Connector. Não há endpoint nem credencial publicados para um backend próprio.' }
        ],
        tools: [],
        userMessage: 'O MCP do Indeed existe, mas hoje a conexão oficial é somente pelo Claude Connector. Assim que o acesso para cliente próprio for liberado, esta integração é ativada sem mudar o resto do produto.',
        actionable: false
      };
    }
    return super.testConnection();
  }

  async callTool(toolName, args = {}) {
    if (!this.customClientEnabled) {
      throw new IntegrationError(
        HEALTH.CUSTOM_CLIENT_ACCESS_UNAVAILABLE,
        'A busca no Indeed está indisponível: a conexão oficial para clientes próprios ainda não foi liberada. Suas vagas já salvas continuam acessíveis.',
        'INDEED_CUSTOM_MCP_ENABLED=false', false
      );
    }
    return super.callTool(toolName, args);
  }
}

module.exports = {
  parseMcpBody,
  HEALTH, CAPABILITY, mapCapabilities,
  IntegrationError, McpAdapter, GupyAdapter, IndeedAdapter, httpJson,
  GUPY_OFFICIAL_MCP_URL
};
