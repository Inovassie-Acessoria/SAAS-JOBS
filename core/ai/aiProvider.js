/**
 * Abstração de provedor de IA (spec de agentes §4, §5, §59).
 *
 * A §5 é uma decisão de arquitetura, não de gosto: "Do not couple the system
 * permanently to one model vendor." O resto do produto conversa com `AIProvider`
 * e nunca com o SDK de um fornecedor.
 *
 * A §4 delimita o que o LLM pode e não pode fazer:
 *
 *   PODE   interpretar vaga · separar obrigatório de preferencial · casar
 *          habilidades semanticamente · explicar ATS · escrever carta e e-mail
 *
 *   NÃO PODE  aplicar a cota de 50/dia · impedir duplicata · autorizar ·
 *             autenticar · garantir integridade · decidir regra de negócio
 *
 * Tudo dessa segunda lista é código determinístico, e continua sendo mesmo com
 * um LLM configurado. O provedor padrão é o `none` — o sistema funciona inteiro
 * sem nenhuma chave de API, com heurística e ontologia.
 */

const schemas = require('./schemas');

const VERSION = 'ai-provider-v1';

/** Erro de provedor — sempre carrega se vale a pena tentar de novo. */
class AIProviderError extends Error {
  constructor(message, { retryable = false, provider = null, cause = null } = {}) {
    super(message);
    this.name = 'AIProviderError';
    this.retryable = retryable;
    this.provider = provider;
    this.cause = cause;
    this.userFacing = true;
  }
}

/**
 * Contrato que todo provedor implementa.
 *
 * Os métodos de negócio (§5) são finais: eles montam o prompt, chamam
 * `complete()` e validam a saída contra o schema. Um provedor concreto só
 * precisa implementar `complete()` e `healthCheck()`.
 */
class AIProvider {
  constructor({ id, model = null, apiKey = null, timeoutMs = 45000, maxRetries = 2 } = {}) {
    this.id = id;
    this.model = model;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    /** Contabilidade de custo (§58) — quem chama pode ler e registrar. */
    this.usage = { calls: 0, promptChars: 0, completionChars: 0, failures: 0 };
  }

  /** Identidade legível na interface e nos logs. */
  describe() {
    return { id: this.id, model: this.model, configured: this.isConfigured(), version: VERSION };
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  /**
   * Completa um prompt. Implementado pelo provedor concreto.
   * @returns {Promise<string>} texto bruto da resposta
   */
  async complete() {
    throw new AIProviderError(`O provedor "${this.id}" não implementa complete().`, { provider: this.id });
  }

  /** Verifica credencial e disponibilidade sem gastar uma análise inteira. */
  async healthCheck() {
    return { ok: false, message: `O provedor "${this.id}" não implementa healthCheck().` };
  }

  // -------------------------------------------------------------------------
  // Execução com schema (§6)
  // -------------------------------------------------------------------------

  /**
   * Chama o modelo e valida a resposta contra um schema. Uma resposta fora do
   * schema é retentada uma vez com instrução corretiva; persistindo, é falha.
   */
  async structured({ system, prompt, schema, temperature = 0.2, maxTokens = 2000, label = 'structured' }) {
    let lastErrors = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const correction = lastErrors
        ? `\n\nSua resposta anterior foi rejeitada pelo validador:\n${lastErrors.join('\n')}\nResponda SOMENTE com o JSON corrigido.`
        : '';

      this.usage.calls++;
      this.usage.promptChars += (system || '').length + prompt.length;

      let raw;
      try {
        raw = await this.complete({
          system, prompt: prompt + correction, temperature, maxTokens, label
        });
      } catch (err) {
        this.usage.failures++;
        if (err.retryable && attempt < this.maxRetries) { lastErrors = [err.message]; continue; }
        throw err;
      }

      this.usage.completionChars += String(raw || '').length;

      const result = schemas.parseAndValidate(raw, schema);
      if (result.ok) return { data: result.value, raw, attempts: attempt + 1, provider: this.id };

      lastErrors = result.errors;
    }

    this.usage.failures++;
    throw new AIProviderError(
      `O provedor "${this.id}" não devolveu uma resposta válida para "${label}": ${(lastErrors || []).join('; ')}`,
      { retryable: false, provider: this.id }
    );
  }

  // -------------------------------------------------------------------------
  // Métodos de negócio (§5)
  // -------------------------------------------------------------------------

  async analyzeJob({ job, profile }) {
    return this.structured({
      label: 'analyze_job',
      system: PROMPTS.analyzeJob.system,
      prompt: PROMPTS.analyzeJob.user(job, profile),
      schema: schemas.JOB_ANALYSIS
    });
  }

  async extractRequirements({ job }) {
    return this.structured({
      label: 'extract_requirements',
      system: PROMPTS.extractRequirements.system,
      prompt: PROMPTS.extractRequirements.user(job),
      schema: schemas.PARSED_JOB,
      maxTokens: 3000
    });
  }

  async compareCandidate({ job, profile }) {
    return this.structured({
      label: 'compare_candidate',
      system: PROMPTS.compareCandidate.system,
      prompt: PROMPTS.compareCandidate.user(job, profile),
      schema: schemas.SEMANTIC_MATCH
    });
  }

  async generateCoverLetter({ job, profile, driverProfile, resume }) {
    return this.structured({
      label: 'generate_cover_letter',
      system: PROMPTS.coverLetter.system,
      prompt: PROMPTS.coverLetter.user(job, profile, driverProfile, resume),
      schema: schemas.COVER_LETTER,
      temperature: 0.3,
      maxTokens: 1500
    });
  }

  async generateApplicationEmail({ job, profile, driverProfile, coverLetter }) {
    return this.structured({
      label: 'generate_application_email',
      system: PROMPTS.applicationEmail.system,
      prompt: PROMPTS.applicationEmail.user(job, profile, driverProfile, coverLetter),
      schema: schemas.APPLICATION_EMAIL,
      temperature: 0.3,
      maxTokens: 1500
    });
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * A instrução anti-invenção aparece em TODO prompt que gera texto voltado ao
 * empregador. Ela não substitui o Truth Guard — o guarda continua auditando a
 * saída (§17). Instrução de prompt é pedido; o guarda é garantia.
 */
const NO_FABRICATION = `
REGRA ABSOLUTA: você só pode afirmar o que estiver EXPLICITAMENTE nos dados do
candidato fornecidos abaixo. É proibido inventar ou estimar:
anos de experiência, CDL, licenças, endossos, certificações, escolaridade,
idiomas, empregadores anteriores, autorização de trabalho, métricas ou conquistas.
Se um dado estiver ausente ou marcado UNKNOWN, simplesmente NÃO o mencione.
Nunca escreva um valor aproximado no lugar de um dado que você não tem.`.trim();

function profileFacts(profile = {}, driverProfile = {}) {
  const known = (v) => v !== null && v !== undefined && v !== '' && String(v).toUpperCase() !== 'UNKNOWN';
  const lines = [];
  const add = (k, v) => { if (known(v)) lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`); };

  add('full_name', profile.fullName);
  add('years_of_experience', profile.yearsOfExperience);
  add('skills', profile.skills);
  add('tools', profile.tools);
  add('languages', profile.languages);
  add('certifications', profile.certifications);
  add('education', profile.education);
  add('drivers_license', profile.driversLicense);
  add('work_authorization', profile.workAuthorization);
  add('availability_from', profile.availabilityFrom);
  add('availability_to', profile.availabilityTo);

  for (const [k, v] of Object.entries(driverProfile || {})) {
    if (['id', 'user_id', 'created_at', 'updated_at'].includes(k)) continue;
    add(k, v);
  }

  return lines.length ? lines.join('\n') : '(nenhum dado declarado)';
}

function jobFacts(job = {}) {
  return [
    `title: ${job.job_title || job.title || ''}`,
    `employer: ${job.employer_name || job.company || ''}`,
    job.soc_code ? `soc_code: ${job.soc_code}` : null,
    job.employer_state ? `state: ${job.employer_state}` : null,
    job.wage_rate ? `wage: ${job.wage_rate}/${job.wage_unit || 'Hour'}` : null,
    job.start_date ? `start_date: ${job.start_date}` : null,
    job.end_date ? `end_date: ${job.end_date}` : null,
    `duties: ${(job.duties_description || job.description || '').slice(0, 4000)}`,
    `requirements: ${(job.special_requirements || job.requirements || '').slice(0, 2000)}`
  ].filter(Boolean).join('\n');
}

const JSON_ONLY = 'Responda SOMENTE com um objeto JSON válido, sem cerca de markdown e sem texto antes ou depois.';

const PROMPTS = {
  analyzeJob: {
    system: `Você analisa vagas para um sistema de candidatura. ${JSON_ONLY}
Você NÃO decide se a candidatura será enviada — essa decisão é de código determinístico.
Sua saída alimenta essa decisão, então precisa ser conservadora e honesta.`,
    user: (job, profile) => `VAGA:\n${jobFacts(job)}\n\nCANDIDATO:\n${profileFacts(profile)}\n
Devolva:
{"fit_score":0-100,"ats_score":0-100,"mandatory_requirements":{"matched":n,"total":n},
"critical_gap":true|false,"recommendation":"APPLY|REVIEW_REQUIRED|DO_NOT_APPLY","confidence":"HIGH|MEDIUM|LOW"}`
  },

  extractRequirements: {
    system: `Você extrai requisitos estruturados de descrições de vaga. ${JSON_ONLY}
Classifique cada requisito como MANDATORY, PREFERRED, CONTEXTUAL ou AMBIGUOUS.
AMBIGUOUS quando o texto não deixa claro se é exigência ou preferência — não chute.`,
    user: (job) => `VAGA:\n${jobFacts(job)}\n
Devolva os campos: normalized_title, seniority, mandatory_requirements[], preferred_requirements[],
skills[], tools[], languages[], certifications[], experience_required_years, application_email, application_url.`
  },

  compareCandidate: {
    system: `Você identifica equivalência semântica entre termos de vaga e do candidato (§14). ${JSON_ONLY}
"Performance Marketing" e "Paid Media" são SEMANTIC_EQUIVALENT com confiança HIGH.
Equivalência fraca recebe confiança LOW — nunca a apresente como correspondência plena.`,
    user: (job, profile) => `TERMOS DA VAGA:\n${jobFacts(job)}\n
TERMOS DO CANDIDATO:\n${[...(profile.skills || []), ...(profile.tools || [])].join(', ') || '(nenhum)'}\n
Devolva {"matches":[{"job_term","candidate_term","relationship","confidence"}]}.`
  },

  coverLetter: {
    system: `Você escreve cartas de apresentação em inglês americano para vagas sazonais
nos Estados Unidos (H-2A/H-2B). ${NO_FABRICATION}\n${JSON_ONLY}
Estilo: concisa (150-250 palavras), específica para a vaga, sem texto genérico de spam,
com terminologia americana do setor.`,
    user: (job, profile, driverProfile, resume) => `VAGA:\n${jobFacts(job)}\n
DADOS VERIFICADOS DO CANDIDATO (única fonte permitida):\n${profileFacts(profile, driverProfile)}\n
CURRÍCULO ANEXADO: ${resume ? (resume.original_name || resume.name) : '(nenhum)'}\n
Devolva {"body":"...","claims_used":[{"claim":"...","profile_field":"..."}]}.
Em claims_used, liste cada afirmação factual do texto e o campo do perfil que a sustenta.`
  },

  applicationEmail: {
    system: `Você escreve e-mails de candidatura em inglês americano. ${NO_FABRICATION}\n${JSON_ONLY}
O e-mail é único por vaga — nada de modelo genérico reaproveitado.`,
    user: (job, profile, driverProfile, coverLetter) => `VAGA:\n${jobFacts(job)}\n
DADOS VERIFICADOS DO CANDIDATO:\n${profileFacts(profile, driverProfile)}\n
CARTA JÁ APROVADA (use como base, não contradiga):\n${(coverLetter || '').slice(0, 2500)}\n
Devolva {"subject":"...","body":"..."}. O assunto deve citar o cargo e o número da ordem quando existir.`
  }
};

module.exports = { AIProvider, AIProviderError, PROMPTS, NO_FABRICATION, profileFacts, jobFacts, VERSION };
