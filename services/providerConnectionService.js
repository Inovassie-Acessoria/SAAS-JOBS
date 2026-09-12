/**
 * Conexões com contas de PROVEDOR (spec de autenticação §9, §14, §16, §17, §31).
 *
 * Uma conexão de provedor é uma relação de autorização entre a nossa aplicação
 * e uma plataforma externa. Ela é diferente de três coisas com que costuma ser
 * confundida:
 *
 *   1. do login na nossa aplicação (Google Sign-In);
 *   2. da saúde da fonte de dados (o MCP da Gupy estar no ar não significa que
 *      a conta da Gupy do usuário esteja vinculada — spec §8, §31);
 *   3. da permissão do Gmail, que é incremental e pedida à parte (§18).
 *
 * Enquanto um provedor não oferecer fluxo OFICIAL de vinculação, o estado é
 * NOT_SUPPORTED e nenhum campo de credencial é preenchido (§16). Jamais pedimos
 * senha de Gupy ou Indeed, e nunca copiamos sessão de navegador (§33).
 */

const { db, logCore } = require('../config/database');

const PROVIDER = { GUPY: 'GUPY', INDEED: 'INDEED', GMAIL: 'GMAIL' };

const STATUS = {
  NOT_SUPPORTED: 'NOT_SUPPORTED',     // não existe fluxo oficial para o nosso caso
  AVAILABLE: 'AVAILABLE',             // existe fluxo oficial, ainda não conectado
  CONNECTED: 'CONNECTED',
  REQUIRES_REAUTH: 'REQUIRES_REAUTH',
  REVOKED: 'REVOKED',
  ERROR: 'ERROR'
};

/**
 * O que cada provedor permite HOJE, conforme a documentação oficial verificada
 * em 2026-09-02. Estes textos são o que a interface mostra — e o motivo de não
 * existir botão "Entrar com a Gupy" nem "Entrar com o Indeed".
 */
const PROVIDER_CAPABILITY = {
  GUPY: {
    label: 'Conta Gupy',
    accountLinkSupported: false,
    envFlag: 'GUPY_ACCOUNT_LINK_ENABLED',
    defaultStatus: STATUS.NOT_SUPPORTED,
    statusLabel: 'Vinculação oficial de conta não disponível',
    explanation:
      'A documentação pública da Gupy descreve o MCP de candidatos (busca de vagas e análise de currículo) e como conectá-lo a clientes de IA. Ela não documenta um fluxo OAuth para vincular uma conta específica de candidato a uma aplicação como esta.',
    personalization:
      'A personalização das vagas da Gupy usa o perfil e o currículo que você cadastrou aqui, no ambiente da Gupy — não uma sessão da sua conta na Gupy.',
    doNotConfuseWith: 'GUPY_MCP'
  },
  INDEED: {
    label: 'Conta Indeed',
    accountLinkSupported: false,
    envFlag: 'INDEED_ACCOUNT_LINK_ENABLED',
    defaultStatus: STATUS.NOT_SUPPORTED,
    statusLabel: 'Conexão para cliente próprio ainda não disponível',
    explanation:
      'O Indeed documenta um MCP remoto em beta com busca de vagas, detalhe, dados de empresa e leitura do currículo da conta. O fluxo suportado hoje pede login com conta Indeed, mas a documentação disponibiliza a conexão apenas via Claude Connector — não há endpoint nem credencial publicados para um backend próprio.',
    personalization:
      'A personalização das vagas do Indeed usa o perfil e o currículo cadastrados aqui, no ambiente do Indeed.',
    doNotConfuseWith: 'INDEED_MCP'
  },
  GMAIL: {
    label: 'Gmail',
    accountLinkSupported: true,
    envFlag: 'GMAIL_ENABLED',
    defaultStatus: STATUS.AVAILABLE,
    statusLabel: 'Autorização separada, pedida quando você conectar',
    explanation:
      'O envio das candidaturas do Seasonal Jobs usa a API do Gmail com OAuth 2.0 e escopo mínimo de envio. Esta permissão é incremental: entrar com o Google no Job Intelligence não a concede.',
    personalization: null,
    doNotConfuseWith: null
  }
};

function envEnabled(flag) { return process.env[flag] === 'true'; }

/** O servidor tem as credenciais necessárias para executar o fluxo oficial? */
function providerConfigured(provider) {
  if (provider === 'GMAIL') {
    return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  }
  return false;
}

// ---------------------------------------------------------------------------

function getConnection(userId, provider) {
  const p = String(provider || '').toUpperCase();
  if (!PROVIDER[p]) throw new Error(`Provedor desconhecido: ${provider}`);

  let row = db.prepare('SELECT * FROM core_provider_connections WHERE user_id = ? AND provider = ?')
    .get(Number(userId), p);

  if (!row) {
    const cap = PROVIDER_CAPABILITY[p];
    db.prepare(`INSERT INTO core_provider_connections (user_id, provider, status, auth_type)
                VALUES (?,?,?,?)`)
      .run(Number(userId), p, resolveDefaultStatus(p), cap.accountLinkSupported ? 'oauth2' : 'none');
    row = db.prepare('SELECT * FROM core_provider_connections WHERE user_id = ? AND provider = ?')
      .get(Number(userId), p);
  }

  // Auto-correção: uma linha gravada quando a capacidade do provedor era
  // descrita de outro jeito não pode continuar afirmando algo incorreto.
  const cap = PROVIDER_CAPABILITY[p];
  const inconsistente =
    (cap.accountLinkSupported && row.status === STATUS.NOT_SUPPORTED) ||
    (!cap.accountLinkSupported && row.status === STATUS.AVAILABLE);

  if (inconsistente) {
    const corrigido = resolveDefaultStatus(p);
    db.prepare(`UPDATE core_provider_connections SET status = ?, auth_type = ?, updated_at = CURRENT_TIMESTAMP
                WHERE user_id = ? AND provider = ?`)
      .run(corrigido, cap.accountLinkSupported ? 'oauth2' : 'none', Number(userId), p);
    row.status = corrigido;
  }

  return row;
}

/**
 * O estado padrão distingue duas coisas que não podem ser confundidas:
 *
 *   NOT_SUPPORTED — o PROVEDOR não oferece fluxo oficial de vinculação para um
 *                   cliente como o nosso. Ligar uma flag não cria a capacidade.
 *   AVAILABLE     — o fluxo existe; falta apenas o usuário conectar (ou o
 *                   servidor ter as credenciais configuradas).
 *
 * Marcar o Gmail como NOT_SUPPORTED seria tão incorreto quanto marcar o Indeed
 * como AVAILABLE: em ambos os casos estaríamos descrevendo mal o provedor.
 */
function resolveDefaultStatus(provider) {
  const cap = PROVIDER_CAPABILITY[provider];
  return cap.accountLinkSupported ? STATUS.AVAILABLE : STATUS.NOT_SUPPORTED;
}

/** Visão de uma conexão para a interface, sem nenhum segredo. */
function describe(userId, provider) {
  const p = String(provider).toUpperCase();
  const cap = PROVIDER_CAPABILITY[p];
  const row = getConnection(userId, p);

  return {
    provider: p,
    label: cap.label,
    status: row.status,
    statusLabel: row.status === STATUS.CONNECTED
      ? `Conectado${row.external_account_email ? ` como ${row.external_account_email}` : ''}`
      : (cap.accountLinkSupported && !providerConfigured(p)
          ? 'Fluxo oficial disponível, mas as credenciais do Google não estão configuradas neste servidor'
          : cap.statusLabel),
    accountLinkSupported: cap.accountLinkSupported,
    // Só é conectável quando o provedor oferece o fluxo E este servidor tem
    // as credenciais para executá-lo. Sem isso, a interface explica o motivo.
    canConnect: cap.accountLinkSupported && envEnabled(cap.envFlag) && providerConfigured(p),
    externalAccountEmail: row.external_account_email,
    grantedScopes: row.granted_scopes ? row.granted_scopes.split(' ') : [],
    connectedAt: row.connected_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    revokedAt: row.revoked_at,
    explanation: cap.explanation,
    personalization: cap.personalization,
    // Deixa explícito que conexão de conta ≠ saúde da fonte de dados (§31).
    doNotConfuseWith: cap.doNotConfuseWith,
    hasStoredCredential: Boolean(row.encrypted_credential)
  };
}

function listConnections(userId) {
  return Object.keys(PROVIDER).map(p => describe(userId, p));
}

/**
 * Registra uma conexão bem-sucedida. Só é chamada por um provedor que tenha
 * fluxo oficial — hoje, apenas o Gmail.
 */
function markConnected(userId, provider, { accountEmail, accountId, scopes, encryptedCredential = null } = {}) {
  const p = String(provider).toUpperCase();
  const cap = PROVIDER_CAPABILITY[p];

  if (!cap.accountLinkSupported) {
    throw new Error(
      `Não existe fluxo oficial de vinculação de conta para ${cap.label}. ` +
      'Marcar como conectado seria afirmar uma capacidade que o provedor não oferece.'
    );
  }

  getConnection(userId, p);
  db.prepare(`UPDATE core_provider_connections SET
      status = ?, external_account_email = ?, external_account_id = ?,
      granted_scopes = ?, encrypted_credential = ?, auth_type = 'oauth2',
      connected_at = CURRENT_TIMESTAMP, last_success_at = CURRENT_TIMESTAMP,
      revoked_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND provider = ?`)
    .run(STATUS.CONNECTED, accountEmail || null, accountId || null,
         Array.isArray(scopes) ? scopes.join(' ') : (scopes || null),
         encryptedCredential, Number(userId), p);

  logCore('provider', 'connection_established',
    `Conexão com ${cap.label} estabelecida${accountEmail ? ` (${accountEmail})` : ''}.`,
    { provider: p, userId });

  return describe(userId, p);
}

function markStatus(userId, provider, status, { reason = null } = {}) {
  const p = String(provider).toUpperCase();
  getConnection(userId, p);

  const isFailure = status === STATUS.ERROR || status === STATUS.REQUIRES_REAUTH || status === STATUS.REVOKED;
  db.prepare(`UPDATE core_provider_connections SET status = ?,
      last_failure_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE last_failure_at END,
      revoked_at = CASE WHEN ? = 'REVOKED' THEN CURRENT_TIMESTAMP ELSE revoked_at END,
      metadata_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND provider = ?`)
    .run(status, isFailure ? 1 : 0, status,
         reason ? JSON.stringify({ reason }) : null, Number(userId), p);

  return describe(userId, p);
}

/** Desconectar um provedor é independente de sair da aplicação (spec §34). */
function disconnect(userId, provider) {
  const p = String(provider).toUpperCase();
  const cap = PROVIDER_CAPABILITY[p];

  if (!cap.accountLinkSupported) {
    return Object.assign(describe(userId, p), {
      message: `Não há conexão de conta ${cap.label} para desconectar — a vinculação oficial não existe hoje.`
    });
  }

  getConnection(userId, p);
  db.prepare(`UPDATE core_provider_connections SET status = ?, encrypted_credential = NULL,
      granted_scopes = NULL, revoked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND provider = ?`)
    .run(STATUS.REVOKED, Number(userId), p);

  logCore('provider', 'connection_revoked', `Conexão com ${cap.label} desfeita pelo usuário.`,
    { provider: p, userId });

  return describe(userId, p);
}

/**
 * Painel de estados (spec §31). Mantém separado o que é diferente:
 * login da aplicação, fonte de dados (MCP/feed) e conta do provedor.
 */
function healthMatrix(userId, integrations = {}) {
  const conn = Object.fromEntries(listConnections(userId).map(c => [c.provider, c]));

  return [
    { key: 'APPLICATION_AUTH', label: 'Login na aplicação', kind: 'auth',
      status: integrations.applicationAuth || 'HEALTHY',
      note: 'Identifica você no Job Intelligence.' },

    { key: 'GUPY_MCP', label: 'Gupy — fonte de vagas', kind: 'data_source',
      status: integrations.gupyMcp || 'NOT_CONFIGURED',
      note: 'Conexão com o MCP público de candidatos. Não é a sua conta da Gupy.' },

    { key: 'GUPY_ACCOUNT', label: 'Gupy — conta do candidato', kind: 'provider_account',
      status: conn.GUPY.status, note: conn.GUPY.statusLabel },

    { key: 'INDEED_MCP', label: 'Indeed — fonte de vagas', kind: 'data_source',
      status: integrations.indeedMcp || 'CUSTOM_CLIENT_ACCESS_UNAVAILABLE',
      note: 'MCP oficial em beta, hoje disponível apenas via Claude Connector.' },

    { key: 'INDEED_ACCOUNT', label: 'Indeed — conta do candidato', kind: 'provider_account',
      status: conn.INDEED.status, note: conn.INDEED.statusLabel },

    { key: 'GMAIL', label: 'Gmail — envio de candidaturas', kind: 'provider_account',
      status: integrations.gmail || conn.GMAIL.status,
      note: conn.GMAIL.status === STATUS.CONNECTED && conn.GMAIL.externalAccountEmail
        ? `Enviando como ${conn.GMAIL.externalAccountEmail}`
        : 'Permissão separada do login, pedida ao conectar.' },

    { key: 'SEASONAL_DOL', label: 'Seasonal — feeds do DOL', kind: 'data_source',
      status: integrations.seasonalDol || 'NOT_CONFIGURED',
      note: 'Fonte pública de ordens de serviço. Não envolve conta de usuário.' }
  ];
}

module.exports = {
  PROVIDER, STATUS, PROVIDER_CAPABILITY,
  getConnection, describe, listConnections,
  markConnected, markStatus, disconnect, healthMatrix, resolveDefaultStatus
};
