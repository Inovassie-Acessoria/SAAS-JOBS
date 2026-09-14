/**
 * Cliente da API.
 *
 * Toda falha vira um erro com mensagem já pronta para o usuário (spec §42) —
 * a camada de views nunca precisa interpretar código HTTP.
 */

class ApiError extends Error {
  constructor(message, { status, correlationId, health } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.correlationId = correlationId;
    this.health = health;
  }
}

async function request(path, { method = 'GET', body = null, form = null, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: form ? undefined : (body ? { 'Content-Type': 'application/json' } : undefined),
      body: form ? form : (body ? JSON.stringify(body) : undefined),
      signal
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('Não foi possível falar com o servidor. Verifique se ele está rodando e tente novamente.');
  }

  let payload = null;
  const text = await res.text();
  if (text) {
    try { payload = JSON.parse(text); } catch (e) { payload = null; }
  }

  if (!res.ok) {
    const msg = (payload && payload.error)
      || (res.status === 404 ? 'Não encontramos o que você pediu.'
        : res.status === 429 ? 'Muitas requisições em pouco tempo. Aguarde um minuto.'
        : 'Algo deu errado no servidor. Seus dados salvos não foram afetados.');
    throw new ApiError(msg, {
      status: res.status,
      correlationId: payload && payload.correlationId,
      health: payload && payload.health
    });
  }

  return payload;
}

const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Board = Gupy ou Indeed, sempre com país no caminho. */
function board(product) {
  const base = (country) => `/api/${product}/${String(country).toLowerCase()}`;
  return {
    dashboard: (c) => request(`${base(c)}/dashboard`),
    getConfig: (c) => request(`${base(c)}/config`),
    saveConfig: (c, body) => request(`${base(c)}/config`, { method: 'PUT', body }),
    listJobs: (c, params) => request(`${base(c)}/jobs${qs(params)}`),
    getJob: (c, id) => request(`${base(c)}/jobs/${id}`),
    saveJob: (c, id, notes) => request(`${base(c)}/jobs/${id}/save`, { method: 'POST', body: { notes } }),
    discardJob: (c, id, reason) => request(`${base(c)}/jobs/${id}/discard`, { method: 'POST', body: { reason } }),
    search: (c, body) => request(`${base(c)}/search`, { method: 'POST', body }),
    searches: (c) => request(`${base(c)}/searches`),
    logs: (c) => request(`${base(c)}/logs`),
    integration: (c) => request(`${base(c)}/integration`),
    setIntegration: (c, body) => request(`${base(c)}/integration`, { method: 'PUT', body }),
    testIntegration: (c) => request(`${base(c)}/integration/test`, { method: 'POST' }),
    disconnect: (c) => request(`${base(c)}/integration/disconnect`, { method: 'POST' })
  };
}

/**
 * Candidato SEMPRE no escopo de um ambiente (plataforma + país).
 * Não existe cliente de perfil ou currículo global — o spec §1A o proíbe.
 */
function env(platform, country) {
  const base = `/api/env/${String(platform).toLowerCase()}/${String(country).toLowerCase()}`;
  return {
    label: `${platform}/${String(country).toUpperCase()}`,
    profile: () => request(`${base}/profile`),
    saveProfile: (body) => request(`${base}/profile`, { method: 'PUT', body }),

    resumes: (params) => request(`${base}/resumes${qs(params)}`),
    uploadResume: (form) => request(`${base}/resumes`, { method: 'POST', form }),
    updateResume: (id, body) => request(`${base}/resumes/${id}`, { method: 'PUT', body }),
    archiveResume: (id) => request(`${base}/resumes/${id}`, { method: 'DELETE' }),
    resumeSuggestions: (id) => request(`${base}/resumes/${id}/suggestions`),
    resumeFileUrl: (id) => `${base}/resumes/${id}/file`,

    atsCenter: () => request(`${base}/ats/center`),
    analyzeResume: (id, body) => request(`${base}/ats/analyze/${id}`, { method: 'POST', body: body || {} }),
    atsCompare: (body) => request(`${base}/ats/compare`, { method: 'POST', body })
  };
}

const API = {
  ApiError,
  env,

  auth: {
    status: () => request('/api/auth/status'),
    googleStart: () => request('/api/auth/google/start'),
    logout: () => request('/api/auth/logout', { method: 'POST' }),
    sessions: () => request('/api/auth/sessions'),
    revokeOthers: () => request('/api/auth/sessions/revoke-others', { method: 'POST' }),
    setContext: (product, country) => request('/api/auth/context', { method: 'PUT', body: { product, country } })
  },

  googleCredentials: {
    status: () => request('/api/core/google-credentials'),
    save: (clientId, clientSecret) =>
      request('/api/core/google-credentials', { method: 'PUT', body: { clientId, clientSecret } }),
    clear: () => request('/api/core/google-credentials', { method: 'DELETE' })
  },

  gmailSenders: {
    list: () => request('/api/core/gmail/senders'),
    addUrl: () => request('/api/core/gmail/senders/add-url'),
    setActive: (id, active) => request(`/api/core/gmail/senders/${id}`, { method: 'PUT', body: { active } }),
    setLimit: (id, dailyLimit) => request(`/api/core/gmail/senders/${id}`, { method: 'PUT', body: { dailyLimit } }),
    remove: (id) => request(`/api/core/gmail/senders/${id}`, { method: 'DELETE' })
  },

  account: {
    get: () => request('/api/account'),
    connections: () => request('/api/account/connections'),
    disconnect: (provider) => request(`/api/account/connections/${provider}/disconnect`, { method: 'POST' })
  },

  core: {
    health: () => request('/api/core/health'),
    ruleSets: () => request('/api/core/ats/rule-sets'),
    auditLogs: () => request('/api/core/audit-logs'),
    integrationStatus: () => request('/api/core/integrations'),

    // Documentos herdados da biblioteca compartilhada da v2 (spec §1J).
    unassignedDocuments: (params) => request(`/api/core/unassigned-documents${qs(params)}`),
    assignDocument: (id, platform, country) =>
      request(`/api/core/unassigned-documents/${id}/assign`, { method: 'POST', body: { platform, country } }),

    // --- Robôs autônomos (spec de agentes §49, §52, §55) ---
    awayReport: (hours) => request(`/api/core/away-report${qs({ hours })}`),
    scheduler: () => request('/api/core/scheduler'),
    schedulerEnable: (enabled) => request('/api/core/scheduler/enable', { method: 'POST', body: { enabled } }),
    schedulerTask: (id, body) => request(`/api/core/scheduler/tasks/${id}`, { method: 'PUT', body }),
    runTask: (id) => request(`/api/core/scheduler/tasks/${id}/run`, { method: 'POST' }),
    schedulerHistory: (params) => request(`/api/core/scheduler/history${qs(params)}`),
    agentRuns: (params) => request(`/api/core/agent-runs${qs(params)}`),
    agentsSelfCheck: () => request('/api/core/agents/self-check'),
    readiness: () => request('/api/core/readiness'),
    ai: () => request('/api/core/ai'),
    saveAi: (body) => request('/api/core/ai', { method: 'PUT', body }),
    testAi: () => request('/api/core/ai/test', { method: 'POST' })
  },

  gupy: board('gupy'),
  indeed: board('indeed'),

  seasonal: {
    dashboard: () => request('/api/seasonal/dashboard'),
    getConfig: () => request('/api/seasonal/config'),
    saveConfig: (body) => request('/api/seasonal/config', { method: 'PUT', body }),
    listJobs: (params) => request(`/api/seasonal/jobs${qs(params)}`),
    getJob: (id) => request(`/api/seasonal/jobs/${id}`),
    saveJob: (id, notes) => request(`/api/seasonal/jobs/${id}/save`, { method: 'POST', body: { notes } }),
    discardJob: (id, reason) => request(`/api/seasonal/jobs/${id}/discard`, { method: 'POST', body: { reason } }),
    import: (body) => request('/api/seasonal/import', { method: 'POST', body }),
    searches: () => request('/api/seasonal/searches'),
    logs: () => request('/api/seasonal/logs'),
    ranked: (limit) => request(`/api/seasonal/queue/ranked${qs({ limit })}`),
    preparePackage: (id, body) => request(`/api/seasonal/jobs/${id}/package`, { method: 'POST', body }),
    approvePackage: (id) => request(`/api/seasonal/packages/${id}/approve`, { method: 'POST' }),
    queue: (params) => request(`/api/seasonal/queue${qs(params)}`),
    dispatch: (body) => request('/api/seasonal/queue/dispatch', { method: 'POST', body: body || {} }),
    quota: () => request('/api/seasonal/quota'),
    pause: (paused) => request('/api/seasonal/pause', { method: 'POST', body: { paused } }),
    sent: () => request('/api/seasonal/sent'),
    testIntegration: () => request('/api/seasonal/integration/test', { method: 'POST' }),
    gmailStatus: () => request('/api/seasonal/gmail/status'),
    gmailAuthUrl: () => request('/api/seasonal/gmail/auth-url'),
    gmailTest: () => request('/api/seasonal/gmail/test', { method: 'POST' }),
    gmailDisconnect: () => request('/api/seasonal/gmail/disconnect', { method: 'POST' }),

    // --- Agentes do Seasonal (spec de agentes §27, §32, §41, §72) ---
    driverProfile: () => request('/api/seasonal/driver-profile'),
    saveDriverProfile: (body) => request('/api/seasonal/driver-profile', { method: 'PUT', body }),
    runAgents: (body) => request('/api/seasonal/agents/run', { method: 'POST', body: body || {} }),
    runAgentsOnJob: (id) => request(`/api/seasonal/jobs/${id}/agents/run`, { method: 'POST' }),
    jobAudit: (id) => request(`/api/seasonal/jobs/${id}/audit`),
    // --- Front H2B: filtros mestres, modelos, preferências, notificações, números ---
    facets: () => request('/api/seasonal/facets'),
    suggest: (q) => request(`/api/seasonal/suggest${qs({ q })}`),
    templates: () => request('/api/seasonal/templates'),
    saveTemplates: (body) => request('/api/seasonal/templates', { method: 'PUT', body }),
    previewTemplate: (body) => request('/api/seasonal/templates/preview', { method: 'POST', body }),
    uiPrefs: () => request('/api/seasonal/ui/prefs'),
    saveUiPrefs: (body) => request('/api/seasonal/ui/prefs', { method: 'PUT', body }),
    notifications: () => request('/api/seasonal/notifications'),
    readNotifications: (id) => request('/api/seasonal/notifications/read', { method: 'POST', body: { id: id || null } }),
    clearNotifications: () => request('/api/seasonal/notifications', { method: 'DELETE' }),
    stats: () => request('/api/seasonal/stats'),
    dolSync: (body) => request('/api/seasonal/dol/sync-status', { method: 'POST', body: body || {} }),
    manualActions: () => request('/api/seasonal/manual-actions'),
    resolveManualAction: (id, status) =>
      request(`/api/seasonal/manual-actions/${id}/resolve`, { method: 'POST', body: { status } })
  }
};

window.API = API;
