/**
 * Schemas de saída estruturada do LLM (spec de agentes §6).
 *
 * "LLM responses used in business logic must be structured. Use Pydantic or
 * equivalent schema validation. Do not base critical workflow decisions on
 * free-form paragraphs."
 *
 * Aqui o equivalente é um validador declarativo pequeno, sem dependência nova.
 * Ele faz o que interessa e nada além: valida tipo, faixa, enum e obrigatoriedade,
 * e devolve o objeto COERCIDO ou a lista de erros. Um LLM que responde fora do
 * schema é tratado como falha do provedor, não como resultado aproveitável.
 */

const VERSION = 'ai-schemas-v1';

// ---------------------------------------------------------------------------
// Validador
// ---------------------------------------------------------------------------

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Valida `value` contra `schema` e devolve `{ ok, value, errors }`.
 * A coerção é conservadora: aceita "87" para número, mas nunca inventa campo.
 */
function validate(value, schema, path = '$') {
  const errors = [];

  const fail = (msg) => { errors.push(`${path}: ${msg}`); return { ok: false, value: undefined, errors }; };

  if (value === undefined || value === null) {
    if (schema.default !== undefined) return { ok: true, value: schema.default, errors };
    if (schema.required === false) return { ok: true, value: null, errors };
    return fail('campo obrigatório ausente');
  }

  switch (schema.type) {
    case 'integer':
    case 'number': {
      const n = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
      if (!Number.isFinite(n)) return fail(`esperado número, recebido ${typeOf(value)}`);
      const rounded = schema.type === 'integer' ? Math.round(n) : n;
      if (schema.min !== undefined && rounded < schema.min) return fail(`abaixo do mínimo ${schema.min} (recebido ${rounded})`);
      if (schema.max !== undefined && rounded > schema.max) return fail(`acima do máximo ${schema.max} (recebido ${rounded})`);
      return { ok: true, value: rounded, errors };
    }

    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value, errors };
      const s = String(value).toLowerCase();
      if (['true', 'yes', 'sim', '1'].includes(s)) return { ok: true, value: true, errors };
      if (['false', 'no', 'nao', 'não', '0'].includes(s)) return { ok: true, value: false, errors };
      return fail(`esperado booleano, recebido "${value}"`);
    }

    case 'string': {
      if (typeof value !== 'string') return fail(`esperado texto, recebido ${typeOf(value)}`);
      const s = value.trim();
      if (schema.minLength && s.length < schema.minLength) return fail(`texto com menos de ${schema.minLength} caracteres`);
      if (schema.maxLength && s.length > schema.maxLength) {
        return { ok: true, value: s.slice(0, schema.maxLength), errors };
      }
      return { ok: true, value: s, errors };
    }

    case 'enum': {
      const s = String(value).trim().toUpperCase();
      const allowed = schema.values.map(v => String(v).toUpperCase());
      const i = allowed.indexOf(s);
      if (i === -1) return fail(`valor "${value}" fora do conjunto permitido (${schema.values.join(', ')})`);
      return { ok: true, value: schema.values[i], errors };
    }

    case 'array': {
      if (!Array.isArray(value)) return fail(`esperado lista, recebido ${typeOf(value)}`);
      if (schema.maxItems && value.length > schema.maxItems) value = value.slice(0, schema.maxItems);
      const out = [];
      value.forEach((item, i) => {
        const r = validate(item, schema.items, `${path}[${i}]`);
        if (r.ok) out.push(r.value);
        else errors.push(...r.errors);
      });
      if (errors.length) return { ok: false, value: undefined, errors };
      if (schema.minItems && out.length < schema.minItems) return fail(`lista com menos de ${schema.minItems} item(ns)`);
      return { ok: true, value: out, errors };
    }

    case 'object': {
      if (typeOf(value) !== 'object') return fail(`esperado objeto, recebido ${typeOf(value)}`);
      const out = {};
      for (const [key, sub] of Object.entries(schema.properties || {})) {
        const r = validate(value[key], sub, `${path}.${key}`);
        if (r.ok) { if (r.value !== null || sub.required === false) out[key] = r.value; }
        else errors.push(...r.errors);
      }
      if (errors.length) return { ok: false, value: undefined, errors };
      return { ok: true, value: out, errors };
    }

    default:
      return fail(`tipo de schema desconhecido: ${schema.type}`);
  }
}

/**
 * Extrai JSON de uma resposta de LLM, tolerando cerca de markdown e texto
 * ao redor. Não "conserta" JSON quebrado — devolve erro, que é a resposta
 * honesta quando o provedor não cumpriu o contrato.
 */
function parseJson(raw) {
  if (raw && typeof raw === 'object') return { ok: true, value: raw };
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: 'resposta vazia' };

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : text;

  const start = body.search(/[[{]/);
  if (start === -1) return { ok: false, error: 'nenhum objeto JSON na resposta' };

  const open = body[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, end = -1, inString = false, escaped = false;

  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return { ok: false, error: 'JSON incompleto na resposta' };

  try {
    return { ok: true, value: JSON.parse(body.slice(start, end + 1)) };
  } catch (e) {
    return { ok: false, error: `JSON inválido: ${e.message}` };
  }
}

/** Parse + validação em um passo. É a única forma suportada de consumir LLM. */
function parseAndValidate(raw, schema) {
  const p = parseJson(raw);
  if (!p.ok) return { ok: false, value: undefined, errors: [p.error] };
  return validate(p.value, schema);
}

// ---------------------------------------------------------------------------
// Schemas de negócio
// ---------------------------------------------------------------------------

const CONFIDENCE = { type: 'enum', values: ['HIGH', 'MEDIUM', 'LOW'] };

/** §6 — a saída canônica da análise de vaga. */
const JOB_ANALYSIS = {
  type: 'object',
  properties: {
    fit_score: { type: 'integer', min: 0, max: 100 },
    ats_score: { type: 'integer', min: 0, max: 100 },
    mandatory_requirements: {
      type: 'object',
      properties: {
        matched: { type: 'integer', min: 0 },
        total: { type: 'integer', min: 0 }
      }
    },
    critical_gap: { type: 'boolean' },
    recommendation: { type: 'enum', values: ['APPLY', 'REVIEW_REQUIRED', 'DO_NOT_APPLY'] },
    confidence: CONFIDENCE
  }
};

/** §9 — saída do Job Parser Agent. */
const PARSED_JOB = {
  type: 'object',
  properties: {
    normalized_title: { type: 'string', maxLength: 200, required: false, default: null },
    seniority: { type: 'enum', values: ['ENTRY', 'MID', 'SENIOR', 'LEAD', 'UNKNOWN'], required: false, default: 'UNKNOWN' },
    mandatory_requirements: {
      type: 'array', maxItems: 40, default: [],
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: 300 },
          kind: { type: 'enum', values: ['MANDATORY', 'PREFERRED', 'CONTEXTUAL', 'AMBIGUOUS'] },
          confidence: CONFIDENCE
        }
      }
    },
    preferred_requirements: {
      type: 'array', maxItems: 40, default: [],
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: 300 },
          kind: { type: 'enum', values: ['MANDATORY', 'PREFERRED', 'CONTEXTUAL', 'AMBIGUOUS'] },
          confidence: CONFIDENCE
        }
      }
    },
    skills: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 40, default: [] },
    tools: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 40, default: [] },
    languages: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 10, default: [] },
    certifications: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: 20, default: [] },
    experience_required_years: { type: 'number', min: 0, max: 60, required: false, default: null },
    application_email: { type: 'string', maxLength: 200, required: false, default: null },
    application_url: { type: 'string', maxLength: 500, required: false, default: null }
  }
};

/** §33 — carta de apresentação. */
const COVER_LETTER = {
  type: 'object',
  properties: {
    body: { type: 'string', minLength: 120, maxLength: 4000 },
    claims_used: {
      type: 'array', maxItems: 30, default: [],
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string', maxLength: 300 },
          profile_field: { type: 'string', maxLength: 80 }
        }
      }
    }
  }
};

/** §34 — e-mail de candidatura. */
const APPLICATION_EMAIL = {
  type: 'object',
  properties: {
    subject: { type: 'string', minLength: 8, maxLength: 200 },
    body: { type: 'string', minLength: 120, maxLength: 6000 }
  }
};

/** §14 — equivalência semântica com confiança declarada. */
const SEMANTIC_MATCH = {
  type: 'object',
  properties: {
    matches: {
      type: 'array', maxItems: 60, default: [],
      items: {
        type: 'object',
        properties: {
          job_term: { type: 'string', maxLength: 120 },
          candidate_term: { type: 'string', maxLength: 120 },
          relationship: { type: 'enum', values: ['EXACT', 'SEMANTIC_EQUIVALENT', 'RELATED', 'NONE'] },
          confidence: CONFIDENCE
        }
      }
    }
  }
};

module.exports = {
  VERSION,
  validate, parseJson, parseAndValidate,
  JOB_ANALYSIS, PARSED_JOB, COVER_LETTER, APPLICATION_EMAIL, SEMANTIC_MATCH
};
