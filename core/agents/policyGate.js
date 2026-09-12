/**
 * Policy Gate — o portão de toda ação externa (spec de agentes §53, §71.25).
 *
 * Nenhum componente fala com o mundo sem passar por aqui. O portão responde
 * ALLOWED ou DENIED a partir de quatro entradas (§53):
 *
 *     provider · action · application · rules
 *
 * As regras que ele aplica não são preferência de implementação, são as regras
 * inegociáveis da §71:
 *
 *   §71.3  Gupy e Indeed PREPARAM candidaturas; quem submete é o usuário,
 *          salvo capacidade oficial de submissão do provedor.
 *   §71.4  Indeed nunca via bot de navegador de terceiros.
 *   §71.5  Seasonal PODE enviar e-mail automaticamente.
 *   §71.18 WhatsApp é manual por padrão.
 *   §71.19 Telefone listado não é consentimento de WhatsApp.
 *   §71.25 Toda ação externa passa por este portão.
 *
 * O portão é fail-closed: ação desconhecida, provedor desconhecido ou entrada
 * incompleta resultam em DENIED.
 */

const VERSION = 'policy-gate-v1';

const OUTCOME = {
  ALLOWED: 'ALLOWED',
  DENIED: 'DENIED'
};

const PROVIDER = {
  GUPY: 'GUPY',
  INDEED: 'INDEED',
  SEASONAL: 'SEASONAL'
};

const ACTION = {
  /** Leitura e preparo — internos, não tocam o empregador. */
  DISCOVER_JOBS: 'DISCOVER_JOBS',
  ANALYZE_JOB: 'ANALYZE_JOB',
  PREPARE_APPLICATION: 'PREPARE_APPLICATION',
  /** Ações externas de verdade. */
  AUTO_SUBMIT: 'AUTO_SUBMIT',
  SEND_APPLICATION_EMAIL: 'SEND_APPLICATION_EMAIL',
  SEND_WHATSAPP: 'SEND_WHATSAPP',
  MAKE_PHONE_CALL: 'MAKE_PHONE_CALL',
  BROWSER_SUBMIT: 'BROWSER_SUBMIT',
  OPEN_ORIGINAL_JOB: 'OPEN_ORIGINAL_JOB'
};

/**
 * Matriz de autonomia por provedor (§1 do spec de agentes).
 * `null` significa "depende de condições" e cai nas regras específicas abaixo.
 */
const AUTONOMY = {
  GUPY: {
    DISCOVER_JOBS: true,
    ANALYZE_JOB: true,
    PREPARE_APPLICATION: true,
    OPEN_ORIGINAL_JOB: true,
    AUTO_SUBMIT: null,          // só com capacidade oficial declarada (§20)
    BROWSER_SUBMIT: false,      // §20 — não construir em cima de bot de navegador
    SEND_APPLICATION_EMAIL: false,
    SEND_WHATSAPP: false,
    MAKE_PHONE_CALL: false
  },
  INDEED: {
    DISCOVER_JOBS: true,
    ANALYZE_JOB: true,
    PREPARE_APPLICATION: true,
    OPEN_ORIGINAL_JOB: true,
    AUTO_SUBMIT: false,         // §71.4 — proibido, sem exceção por configuração
    BROWSER_SUBMIT: false,
    SEND_APPLICATION_EMAIL: false,
    SEND_WHATSAPP: false,
    MAKE_PHONE_CALL: false
  },
  SEASONAL: {
    DISCOVER_JOBS: true,
    ANALYZE_JOB: true,
    PREPARE_APPLICATION: true,
    OPEN_ORIGINAL_JOB: true,
    AUTO_SUBMIT: false,
    BROWSER_SUBMIT: false,
    SEND_APPLICATION_EMAIL: null, // depende das condições da §36/§38/§39
    SEND_WHATSAPP: null,          // §43 — só com canal oficial configurado
    MAKE_PHONE_CALL: false
  }
};

function deny(code, message, checks = []) {
  return { outcome: OUTCOME.DENIED, allowed: false, code, message, checks, version: VERSION };
}

function allow(message, checks = []) {
  return { outcome: OUTCOME.ALLOWED, allowed: true, code: 'ALLOWED', message, checks, version: VERSION };
}

function check(id, label, passed, detail = null) {
  return { id, label, passed: Boolean(passed), detail };
}

/**
 * Avalia uma ação externa.
 *
 * @param {object} req
 * @param {string} req.provider     GUPY | INDEED | SEASONAL
 * @param {string} req.action       ver ACTION
 * @param {object} [req.application] estado da candidatura envolvida
 * @param {object} [req.rules]      regras do usuário e do provedor
 * @returns {{outcome:string, allowed:boolean, code:string, message:string, checks:object[]}}
 */
function evaluate(req = {}) {
  const provider = String(req.provider || '').toUpperCase();
  const action = String(req.action || '').toUpperCase();
  const app = req.application || {};
  const rules = req.rules || {};
  const checks = [];

  // ---- Entradas -----------------------------------------------------------
  if (!PROVIDER[provider]) {
    return deny('UNKNOWN_PROVIDER', `Provedor "${req.provider}" não é reconhecido. O portão nega o que não conhece.`);
  }
  if (!ACTION[action]) {
    return deny('UNKNOWN_ACTION', `Ação "${req.action}" não é reconhecida. O portão nega o que não conhece.`);
  }

  // ---- Pausas globais — valem para qualquer ação externa -------------------
  const EXTERNAL = new Set([ACTION.AUTO_SUBMIT, ACTION.SEND_APPLICATION_EMAIL,
                            ACTION.SEND_WHATSAPP, ACTION.MAKE_PHONE_CALL, ACTION.BROWSER_SUBMIT]);
  const isExternal = EXTERNAL.has(action);

  if (isExternal && rules.globalPause) {
    return deny('GLOBAL_PAUSE',
      'Todas as automações estão pausadas nas configurações do sistema. Nenhuma ação externa sai daqui.',
      [check('global_pause', 'Pausa geral desativada', false)]);
  }
  checks.push(check('global_pause', 'Pausa geral desativada', !rules.globalPause));

  // ---- Matriz de autonomia ------------------------------------------------
  const verdict = AUTONOMY[provider][action];

  if (verdict === false) {
    const why = {
      [`${PROVIDER.INDEED}|${ACTION.AUTO_SUBMIT}`]:
        'O Indeed não admite submissão automática por terceiros. A candidatura final permanece nos mecanismos oficiais (§21, §71.4).',
      [`${PROVIDER.GUPY}|${ACTION.BROWSER_SUBMIT}`]:
        'A arquitetura não é construída sobre automação de navegador para submissão (§20, §46).',
      [`${PROVIDER.INDEED}|${ACTION.BROWSER_SUBMIT}`]:
        'Proibido: bot de navegador de terceiros para Indeed Apply (§71.4).',
      [`${PROVIDER.SEASONAL}|${ACTION.BROWSER_SUBMIT}`]:
        'O Seasonal usa dados estruturados do DOL e e-mail, não automação de navegador (§45).'
    }[`${provider}|${action}`];

    return deny('ACTION_NOT_PERMITTED',
      why || `A ação ${action} não é permitida para ${provider}.`,
      checks.concat([check('autonomy_matrix', `${provider} pode executar ${action}`, false)]));
  }

  if (verdict === true) {
    checks.push(check('autonomy_matrix', `${provider} pode executar ${action}`, true));
    return allow(`${action} é permitida para ${provider}.`, checks);
  }

  // ---- Condicionais -------------------------------------------------------

  // Gupy: submissão automática só existe se houver capacidade OFICIAL (§20).
  if (provider === PROVIDER.GUPY && action === ACTION.AUTO_SUBMIT) {
    const hasOfficial = Boolean(rules.officialSubmissionCapability);
    checks.push(check('official_submission_capability',
      'A Gupy expõe capacidade oficial de submissão', hasOfficial,
      'Enquanto não existir, a candidatura termina em revisão do usuário (§20, §71.3).'));
    if (!hasOfficial) {
      return deny('NO_OFFICIAL_SUBMISSION',
        'A Gupy não expõe capacidade oficial de submissão. O pacote fica pronto para revisão e o usuário conclui no site oficial.',
        checks);
    }
    return allow('Submissão via capacidade oficial da Gupy.', checks);
  }

  // Seasonal: envio de e-mail — o caminho automático da §32, com as travas
  // das §36, §38 e §39 avaliadas aqui, não no agente que gera o texto.
  if (provider === PROVIDER.SEASONAL && action === ACTION.SEND_APPLICATION_EMAIL) {
    const conditions = [
      check('email_explicitly_listed', 'A vaga lista e-mail de candidatura',
        Boolean(app.applicationEmailListed),
        'A §36 exige e-mail explicitamente informado para candidatura.'),
      check('truck_driver_match', 'A ocupação da vaga está dentro do foco escolhido',
        app.truckDriverMatch === true, 'No foco "só motorista" só passa caminhão confirmado; no foco amplo, qualquer ocupação (§24, ampliada em 2026-09-11).'),
      check('truth_validation', 'O Truth Guard aprovou os textos',
        app.truthValidationPassed === true, 'Nada sem lastro sai do sistema (§17).'),
      check('correct_resume', 'O currículo é do ambiente Seasonal',
        app.resumeFromCorrectEnvironment === true, 'Nunca usar currículo de outra plataforma (§11).'),
      check('not_duplicate', 'Ainda não houve envio para esta vaga e destinatário',
        app.alreadyApplied !== true, 'Duplicata bloqueada (§39).'),
      check('quota_available', 'Há cota diária disponível',
        app.quotaAvailable === true, 'Teto absoluto de 50 envios bem-sucedidos por dia (§38).'),
      check('sending_not_paused', 'O envio não está pausado',
        rules.emailSendingPaused !== true, 'A pausa impede o envio, mas não a descoberta nem o preparo.')
    ];

    const failed = conditions.filter(c => !c.passed);
    const all = checks.concat(conditions);

    if (failed.length) {
      return deny('SEASONAL_CONDITIONS_NOT_MET',
        `Envio bloqueado: ${failed.map(f => f.label.toLowerCase()).join('; ')}.`, all);
    }
    return allow('Todas as condições da candidatura automática do Seasonal foram atendidas.', all);
  }

  // WhatsApp: manual por padrão. Telefone listado NÃO é consentimento (§41, §43).
  if (action === ACTION.SEND_WHATSAPP) {
    const conditions = [
      check('official_channel', 'Existe um canal oficial de WhatsApp Business configurado',
        Boolean(rules.whatsappCloudApiConfigured),
        'A §43 exige fluxo oficial da API do WhatsApp Business.'),
      check('explicit_consent', 'Há opt-in explícito registrado',
        rules.whatsappConsent === true,
        'A §41 é clara: número de telefone listado não estabelece consentimento de WhatsApp.'),
      check('provider_supports', 'O empregador/provedor declara suportar o canal',
        app.employerSupportsWhatsapp === true, 'Condição da §43.')
    ];
    const failed = conditions.filter(c => !c.passed);
    const all = checks.concat(conditions);

    if (failed.length) {
      return deny('WHATSAPP_MANUAL_ONLY',
        'O WhatsApp permanece manual: ' + failed.map(f => f.label.toLowerCase()).join('; ') +
        '. O sistema prepara a mensagem e você a envia (§41, §42).',
        all);
    }
    return allow('Canal oficial de WhatsApp configurado com consentimento registrado.', all);
  }

  return deny('NO_RULE', `Nenhuma regra cobre ${provider}/${action}. O portão nega por precaução.`, checks);
}

/**
 * Açúcar sintático para os pontos de chamada mais comuns.
 * Lança erro `userFacing` quando a ação é negada — o chamador não precisa
 * lembrar de checar o retorno.
 */
function requireAllowed(req) {
  const r = evaluate(req);
  if (!r.allowed) {
    const err = new Error(r.message);
    err.userFacing = true;
    err.policy = r;
    err.status = 403;
    throw err;
  }
  return r;
}

module.exports = {
  VERSION, OUTCOME, PROVIDER, ACTION, AUTONOMY,
  evaluate, requireAllowed
};
