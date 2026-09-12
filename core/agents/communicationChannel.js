/**
 * Communication Channel Agent (spec de agentes §40, §41, §42, §43, §44).
 *
 * A Recruitment Information do DOL pode trazer EMAIL, PHONE ou WEBSITE. Cada
 * canal tem um nível de automação diferente e a diferença é jurídica, não
 * técnica:
 *
 *   EMAIL explicitamente listado  → AUTO         (§32, §36)
 *   PHONE                         → MANUAL       (§41)
 *   WHATSAPP                      → MANUAL_DRAFT (§41, §42)
 *   WEBSITE                       → MANUAL
 *
 * A regra da §41 é a mais fácil de violar por descuido:
 *
 *     número de telefone listado  ≠  consentimento para WhatsApp
 *
 * Por isso o agente NUNCA devolve automação para WhatsApp. Ele prepara a
 * mensagem em inglês e cria uma ação manual — quem envia é o usuário (§42).
 */

const VERSION = 'channel-agent-v1';

const AUTOMATION = {
  AUTO: 'AUTO',                   // o robô executa sozinho
  MANUAL_DRAFT: 'MANUAL_DRAFT',   // o robô escreve, o usuário envia
  MANUAL: 'MANUAL',               // o usuário faz tudo
  UNAVAILABLE: 'UNAVAILABLE'      // o canal não existe nesta vaga
};

const ELIGIBILITY = {
  ELIGIBLE: 'ELIGIBLE',
  UNKNOWN_CONSENT: 'UNKNOWN_CONSENT',
  NOT_ELIGIBLE: 'NOT_ELIGIBLE'
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Normaliza um telefone dos EUA para E.164 quando possível. */
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^0-9]/g, '');
  if (digits.length === 10) return { e164: `+1${digits}`, national: digits, country: 'US' };
  if (digits.length === 11 && digits.startsWith('1')) return { e164: `+${digits}`, national: digits.slice(1), country: 'US' };
  if (digits.length > 11) return { e164: `+${digits}`, national: digits, country: null };
  if (digits.length >= 8) return { e164: null, national: digits, country: null };
  return null;
}

function formatPhone(p) {
  if (!p || !p.national || p.national.length !== 10) return p ? (p.e164 || p.national) : null;
  return `(${p.national.slice(0, 3)}) ${p.national.slice(3, 6)}-${p.national.slice(6)}`;
}

/**
 * Classifica os canais de uma vaga (§44).
 *
 * @param {object} job   linha de `seasonal_jobs`
 * @param {object} [rules]  regras do usuário/provedor que o Policy Gate também lê
 * @returns {{email:object, phone:object, whatsapp:object, website:object,
 *            primary:string, automatable:boolean, manualActions:string[]}}
 */
function classify(job = {}, rules = {}) {
  // --- E-MAIL ---
  const emailCandidates = [
    { value: job.application_email, kind: 'APPLICATION' },
    { value: job.employer_email, kind: 'EMPLOYER' },
    { value: job.attorney_email, kind: 'ATTORNEY' }
  ].filter(c => c.value && EMAIL_RE.test(String(c.value).trim()));

  const chosenEmail = emailCandidates[0] || null;

  // A §36 exige e-mail EXPLICITAMENTE listado para candidatura. O e-mail do
  // representante legal serve, mas é sinalizado — não é o empregador direto.
  const email = chosenEmail
    ? {
        available: true,
        value: String(chosenEmail.value).trim(),
        kind: chosenEmail.kind,
        explicitlyListed: chosenEmail.kind === 'APPLICATION' || chosenEmail.kind === 'EMPLOYER',
        automation: AUTOMATION.AUTO,
        alternatives: emailCandidates.slice(1).map(c => ({ value: c.value, kind: c.kind })),
        note: chosenEmail.kind === 'ATTORNEY'
          ? 'O destinatário é o representante legal, não o empregador direto.'
          : null
      }
    : { available: false, value: null, kind: null, explicitlyListed: false,
        automation: AUTOMATION.UNAVAILABLE, alternatives: [], note: 'A vaga não informa e-mail de candidatura.' };

  // --- TELEFONE ---
  const phoneRaw = job.employer_phone || job.application_phone || null;
  const parsed = normalizePhone(phoneRaw);
  const phone = parsed
    ? {
        available: true,
        value: parsed.e164 || parsed.national,
        display: formatPhone(parsed),
        raw: String(phoneRaw).trim(),
        automation: AUTOMATION.MANUAL,
        note: 'Ligação é sempre ação do usuário. O sistema não faz chamadas (§44).'
      }
    : { available: false, value: null, display: null, raw: null,
        automation: AUTOMATION.UNAVAILABLE, note: null };

  // --- WHATSAPP ---
  // Existência de telefone NÃO implica canal de WhatsApp (§41).
  let whatsappEligibility;
  if (!parsed) {
    whatsappEligibility = ELIGIBILITY.NOT_ELIGIBLE;
  } else if (rules.whatsappCloudApiConfigured && rules.whatsappConsent === true
             && job.employer_supports_whatsapp === 1) {
    whatsappEligibility = ELIGIBILITY.ELIGIBLE;
  } else {
    whatsappEligibility = ELIGIBILITY.UNKNOWN_CONSENT;
  }

  const whatsapp = {
    available: Boolean(parsed),
    eligibility: whatsappEligibility,
    // Mesmo ELIGIBLE só vira AUTO depois do Policy Gate — aqui o padrão é rascunho.
    automation: parsed ? AUTOMATION.MANUAL_DRAFT : AUTOMATION.UNAVAILABLE,
    value: parsed ? (parsed.e164 || parsed.national) : null,
    deepLink: parsed && parsed.e164 ? `https://wa.me/${parsed.e164.replace('+', '')}` : null,
    note: parsed
      ? 'Um número listado para recrutamento não estabelece opt-in de WhatsApp (§41). O sistema prepara a mensagem; você envia.'
      : null
  };

  // --- WEBSITE ---
  const website = job.application_url
    ? { available: true, value: String(job.application_url).trim(), automation: AUTOMATION.MANUAL,
        note: 'Formulários de site exigem ação do usuário (§46).' }
    : { available: false, value: null, automation: AUTOMATION.UNAVAILABLE, note: null };

  // --- Consolidação ---
  const primary = email.available ? 'EMAIL'
    : phone.available ? 'PHONE'
    : website.available ? 'WEBSITE'
    : 'NONE';

  const manualActions = [];
  if (!email.available && phone.available) manualActions.push('WHATSAPP_MESSAGE');
  if (!email.available && phone.available) manualActions.push('PHONE_CALL');
  if (!email.available && website.available) manualActions.push('OPEN_WEBSITE');

  return {
    email, phone, whatsapp, website,
    primary,
    automatable: email.available && email.explicitlyListed,
    manualActions,
    version: VERSION
  };
}

// ---------------------------------------------------------------------------
// Gerador de mensagem de WhatsApp (§42)
// ---------------------------------------------------------------------------

/**
 * Monta a mensagem em inglês que o usuário enviará manualmente (§42).
 *
 * Cada bloco só entra se o dado existir. A mensagem passa pelo Truth Guard
 * antes de ser exibida — o mesmo padrão da carta e do e-mail (§17).
 */
function buildWhatsappMessage({ job = {}, profile = {}, driverProfile = {} } = {}) {
  const name = profile.fullName || null;
  const lines = [];

  lines.push(name ? `Hello, my name is ${name}.` : 'Hello,');
  lines.push('');

  const title = job.job_title || 'seasonal';
  const driving = ['TRUCK_DRIVER_CONFIRMED', 'TRUCK_DRIVER_PROBABLE', 'REVIEW_REQUIRED'].includes(String(job.truck_classification || ''))
    || /\b(driver|driving|truck|cdl|chauffeur|hauler|hauling)\b/i.test([job.job_title, job.special_requirements].filter(Boolean).join(' '));
  lines.push(
    `I found your ${title} position${job.job_order_id ? ` (job order #${job.job_order_id})` : ''} ` +
    'listed on SeasonalJobs.dol.gov and I am interested in applying.'
  );

  // Experiência — só o que o perfil realmente declara (§17).
  const years = driverProfile.truck_driving_experience;
  if (driving && years !== null && years !== undefined && String(years).toUpperCase() !== 'UNKNOWN' && Number(years) > 0) {
    lines.push('');
    lines.push(`I have ${years} year(s) of truck driving experience.`);
  } else if (Number(profile.yearsOfExperience) > 0) {
    lines.push('');
    lines.push(`I have ${profile.yearsOfExperience} year(s) of professional experience.`);
  }

  // CDL — jamais afirmada sem registro explícito no perfil (§17, §18).
  const cdlStatus = driverProfile.cdl_status;
  if (driving && cdlStatus && String(cdlStatus).toUpperCase() === 'HELD') {
    const cls = driverProfile.cdl_class && String(driverProfile.cdl_class).toUpperCase() !== 'UNKNOWN'
      ? ` Class ${String(driverProfile.cdl_class).toUpperCase()}` : '';
    lines.push(`I hold a valid CDL${cls}.`);
  }

  // Disponibilidade
  const from = driverProfile.availability_start || profile.availabilityFrom;
  const to = driverProfile.availability_end || profile.availabilityTo;
  if (from || to) {
    lines.push('');
    lines.push(`I am available${from ? ` from ${from}` : ''}${to ? ` through ${to}` : ''}.`);
  }

  lines.push('');
  lines.push('I would be happy to send my resume and any additional information you need.');
  lines.push('');
  lines.push('Thank you.');
  if (name) lines.push(name);

  return lines.join('\n');
}

/**
 * Monta a ação manual completa para telefone/WhatsApp (§41, §42, §57).
 * O retorno é o que a interface precisa para oferecer "ABRIR WHATSAPP".
 */
function buildManualAction({ job, profile, driverProfile, channels }) {
  const ch = channels || classify(job);
  if (!ch.phone.available) return null;

  const message = buildWhatsappMessage({ job, profile, driverProfile });

  return {
    kind: 'WHATSAPP_MESSAGE',
    jobId: job.id || null,
    jobOrderId: job.job_order_id || null,
    employer: job.employer_name || null,
    phone: ch.phone.value,
    phoneDisplay: ch.phone.display,
    deepLink: ch.whatsapp.deepLink,
    message,
    automation: AUTOMATION.MANUAL_DRAFT,
    instruction: 'O sistema não envia esta mensagem. Revise o texto, abra o WhatsApp e envie você mesmo (§41).',
    version: VERSION
  };
}

module.exports = {
  VERSION, AUTOMATION, ELIGIBILITY,
  normalizePhone, formatPhone,
  classify, buildWhatsappMessage, buildManualAction
};
