/**
 * Seasonal Hiring Timeline Engine (spec §33, §34, §64, §65).
 *
 * Regra de negócio central do Seasonal Jobs: a fila de e-mails NÃO é ordenada
 * apenas por Match Score. A prioridade estratégica considera QUANDO o empregador
 * precisa do trabalhador, favorecendo fortemente períodos de trabalho em 2027.
 *
 * Se o período não puder ser extraído com confiança, o resultado é UNKNOWN_DATE
 * e o sistema NÃO inventa uma data (spec §33).
 */

const TIMELINE_CLASS = {
  TARGET_2027:       'TARGET_2027',
  CURRENT_2026:      'CURRENT_2026',
  FUTURE_AFTER_2027: 'FUTURE_AFTER_2027',
  UNKNOWN_DATE:      'UNKNOWN_DATE'
};

const TIMELINE_PRIORITY = {
  VERY_HIGH: 'VERY_HIGH',
  HIGH:      'HIGH',
  NORMAL:    'NORMAL',
  LOW:       'LOW',
  UNKNOWN:   'UNKNOWN'
};

/** Peso numérico usado na ordenação da fila. */
const PRIORITY_WEIGHT = {
  VERY_HIGH: 100,
  HIGH:      75,
  NORMAL:    45,
  LOW:       20,
  UNKNOWN:   30   // acima de LOW: uma data desconhecida não deve ser punida como um período claramente ruim
};

const TARGET_YEAR = 2027;

const MONTHS = {
  jan: 1, feb: 2, fev: 2, mar: 3, apr: 4, abr: 4, may: 5, mai: 5, jun: 6,
  jul: 7, aug: 8, ago: 8, sep: 9, set: 9, oct: 10, out: 10, nov: 11, dec: 12, dez: 12
};

/**
 * Converte valores heterogêneos de data em { year, month } ou null.
 * Aceita ISO (2027-01-15), mm/aaaa, "Jan 2027", "January 15, 2027".
 */
function parseDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;

  // ISO / aaaa-mm-dd
  let m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (m) return { year: +m[1], month: +m[2], day: m[3] ? +m[3] : 1, raw: s };

  // dd/mm/aaaa ou mm/aaaa
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return { year: +m[3], month: +m[2], day: +m[1], raw: s };

  m = s.match(/^(\d{1,2})\/(\d{4})/);
  if (m) return { year: +m[2], month: +m[1], day: 1, raw: s };

  // "Jan 2027", "January 15, 2027"
  m = s.match(/([a-zç]{3,})\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{4})/i);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon) return { year: +m[3], month: mon, day: m[2] ? +m[2] : 1, raw: s };
  }

  // Ano isolado
  m = s.match(/\b(20\d{2})\b/);
  if (m) return { year: +m[1], month: null, day: null, raw: s };

  return null;
}

function toOrdinal(d) {
  if (!d) return null;
  return d.year * 12 + (d.month || 1);
}

/**
 * Extrai o período de trabalho a partir dos campos disponíveis na vaga.
 * Tenta os campos estruturados primeiro; só então recorre ao texto livre.
 */
function extractPeriod(job) {
  const candidates = [
    ['start_date', 'end_date'],
    ['employment_start_date', 'employment_end_date'],
    ['requested_worker_start_date', 'contract_end_date'],
    ['contract_start', 'contract_end']
  ];

  for (const [sk, ek] of candidates) {
    const start = parseDate(job[sk]);
    const end = parseDate(job[ek]);
    if (start || end) {
      return { start, end, source: `campos ${sk}/${ek}`, confidence: 'HIGH' };
    }
  }

  // Fallback: procura um intervalo no texto livre.
  const text = [job.duties_description, job.special_requirements, job.description, job.raw_json]
    .filter(Boolean).join(' ');
  const range = text.match(
    /((?:\d{1,2}\/)?(?:\d{1,2}\/)?\d{4}|[a-zç]{3,}\.?\s+\d{1,2}?,?\s*\d{4})\s*(?:[-–—]|to|até|a)\s*((?:\d{1,2}\/)?(?:\d{1,2}\/)?\d{4}|[a-zç]{3,}\.?\s+\d{1,2}?,?\s*\d{4})/i
  );
  if (range) {
    const start = parseDate(range[1]);
    const end = parseDate(range[2]);
    if (start || end) return { start, end, source: 'texto livre da vaga', confidence: 'MEDIUM' };
  }

  return { start: null, end: null, source: null, confidence: 'NONE' };
}

/**
 * Classifica a linha do tempo conforme o algoritmo conceitual do spec §64.
 * Retorna sempre uma explicação legível (§34: "Make the ranking logic explainable").
 */
function classifyTimeline(job, targetYear = TARGET_YEAR) {
  const period = extractPeriod(job);
  const { start, end } = period;

  if (!start && !end) {
    return {
      timelineClass: TIMELINE_CLASS.UNKNOWN_DATE,
      priority: TIMELINE_PRIORITY.UNKNOWN,
      weight: PRIORITY_WEIGHT.UNKNOWN,
      period,
      targetYear,
      label: 'Período de trabalho não disponível',
      explanation: 'Não foi possível extrair o período de contratação desta vaga. O sistema não presume uma data.'
    };
  }

  const startOrd = toOrdinal(start);
  const endOrd = toOrdinal(end) || startOrd;
  const effStart = startOrd || endOrd;

  const yearStart = targetYear * 12 + 1;
  const yearEnd = targetYear * 12 + 12;

  const overlaps2027 = effStart <= yearEnd && endOrd >= yearStart;
  const startsIn2027 = start && start.year === targetYear;
  const startsLatePrevYear = start && start.year === targetYear - 1 && (start.month || 1) >= 10;
  const extendsInto2027 = endOrd >= yearStart;
  const onlyBefore = endOrd < yearStart;
  const startsAfter = effStart > yearEnd;

  const fmt = d => {
    if (!d) return '—';
    if (!d.month) return String(d.year);
    return `${String(d.month).padStart(2, '0')}/${d.year}`;
  };
  const periodLabel = `${fmt(start)} – ${fmt(end)}`;

  if (startsIn2027) {
    return {
      timelineClass: TIMELINE_CLASS.TARGET_2027,
      priority: TIMELINE_PRIORITY.VERY_HIGH,
      weight: PRIORITY_WEIGHT.VERY_HIGH,
      period, targetYear, periodLabel,
      label: `Prioridade ${targetYear}`,
      explanation: `O período de trabalho começa em ${targetYear} (${periodLabel}), exatamente a janela de contratação priorizada.`
    };
  }

  if (startsLatePrevYear && extendsInto2027) {
    return {
      timelineClass: TIMELINE_CLASS.TARGET_2027,
      priority: TIMELINE_PRIORITY.HIGH,
      weight: PRIORITY_WEIGHT.HIGH,
      period, targetYear, periodLabel,
      label: `Entra em ${targetYear}`,
      explanation: `O contrato começa no fim de ${targetYear - 1} e se estende por ${targetYear} (${periodLabel}), atendendo a necessidade de mão de obra na janela priorizada.`
    };
  }

  if (overlaps2027) {
    return {
      timelineClass: TIMELINE_CLASS.TARGET_2027,
      priority: TIMELINE_PRIORITY.HIGH,
      weight: PRIORITY_WEIGHT.HIGH,
      period, targetYear, periodLabel,
      label: `Sobrepõe ${targetYear}`,
      explanation: `O período de trabalho (${periodLabel}) se sobrepõe a ${targetYear}.`
    };
  }

  if (onlyBefore) {
    return {
      timelineClass: TIMELINE_CLASS.CURRENT_2026,
      priority: TIMELINE_PRIORITY.NORMAL,
      weight: PRIORITY_WEIGHT.NORMAL,
      period, targetYear, periodLabel,
      label: `Encerra antes de ${targetYear}`,
      explanation: `O contrato termina antes de ${targetYear} (${periodLabel}). Continua elegível, mas sem a prioridade estratégica.`
    };
  }

  if (startsAfter) {
    return {
      timelineClass: TIMELINE_CLASS.FUTURE_AFTER_2027,
      priority: TIMELINE_PRIORITY.LOW,
      weight: PRIORITY_WEIGHT.LOW,
      period, targetYear, periodLabel,
      label: `Posterior a ${targetYear}`,
      explanation: `O período começa depois de ${targetYear} (${periodLabel}), fora da janela priorizada.`
    };
  }

  return {
    timelineClass: TIMELINE_CLASS.UNKNOWN_DATE,
    priority: TIMELINE_PRIORITY.UNKNOWN,
    weight: PRIORITY_WEIGHT.UNKNOWN,
    period, targetYear, periodLabel,
    label: 'Período indeterminado',
    explanation: 'As datas encontradas não permitem classificar a janela de contratação com segurança.'
  };
}

/**
 * Ordena candidaturas para a fila (spec §34, §64).
 * Ordem: prioridade de timeline → Opportunity → Fit → ATS → completude → frescor.
 * Pesos configuráveis; nada fixado permanentemente no código (spec §64).
 */
const DEFAULT_QUEUE_WEIGHTS = {
  timeline:      0.40,
  opportunity:   0.25,
  fit:           0.15,
  ats:           0.10,
  completeness:  0.06,
  freshness:     0.04
};

function queuePriorityScore(item, weights = DEFAULT_QUEUE_WEIGHTS) {
  const t = item.timeline ? item.timeline.weight : PRIORITY_WEIGHT.UNKNOWN;
  const parts = {
    timeline:     t,
    opportunity:  Number(item.opportunityScore) || 0,
    fit:          Number(item.fitScore) || 0,
    ats:          Number(item.atsScore) || 0,
    completeness: Number(item.completeness) || 0,
    freshness:    Number(item.freshness) || 0
  };

  let total = 0;
  const contributions = {};
  for (const k of Object.keys(weights)) {
    const c = parts[k] * weights[k];
    contributions[k] = Number(c.toFixed(2));
    total += c;
  }

  return { score: Number(total.toFixed(2)), contributions, parts, weights };
}

/**
 * Ordena a fila e anexa a explicação de cada posição (spec §34).
 *
 * Dois modos:
 *
 *   'tiered' (padrão) — a prioridade de linha do tempo é o critério PRIMÁRIO, e a
 *     pontuação ponderada decide dentro de cada faixa. É o que a §33 pede ao
 *     dizer "strongly favor TARGET_2027" e o que a §64 descreve ao listar os
 *     critérios em ordem. Sem isso, uma vaga de 2026 com scores muito altos
 *     ultrapassa uma de 2027 — exatamente o que a §34 diz que NÃO deve acontecer.
 *
 *   'weighted' — soma ponderada pura, para quem quiser que o mérito possa
 *     superar a janela de contratação.
 *
 * Os pesos seguem configuráveis nos dois modos (spec §64).
 */
function rankQueue(items, weights = DEFAULT_QUEUE_WEIGHTS, mode = 'tiered') {
  const scored = items.map(i => {
    const p = queuePriorityScore(i, weights);
    return Object.assign({}, i, {
      queuePriority: p.score,
      queueBreakdown: Object.assign({}, p, { mode }),
      _tier: i.timeline ? i.timeline.weight : PRIORITY_WEIGHT.UNKNOWN
    });
  });

  scored.sort((a, b) => {
    if (mode === 'tiered') {
      // Peso de timeline zerado desliga o tiering: o operador optou por ignorá-la.
      const tieringOn = (weights.timeline || 0) > 0;
      if (tieringOn && b._tier !== a._tier) return b._tier - a._tier;
    }
    if (b.queuePriority !== a.queuePriority) return b.queuePriority - a.queuePriority;
    return b._tier - a._tier;
  });

  return scored.map((item, idx) => {
    delete item._tier;
    return Object.assign(item, {
      queuePosition: idx + 1,
      queueExplanation: item.timeline
        ? `Posição ${idx + 1}: ${item.timeline.label}. ${item.timeline.explanation} Opportunity ${item.opportunityScore ?? '—'}, Fit ${item.fitScore ?? '—'}, ATS ${item.atsScore ?? '—'}.`
        : `Posição ${idx + 1}.`
    });
  });
}

module.exports = {
  TIMELINE_CLASS,
  TIMELINE_PRIORITY,
  PRIORITY_WEIGHT,
  DEFAULT_QUEUE_WEIGHTS,
  TARGET_YEAR,
  parseDate,
  extractPeriod,
  classifyTimeline,
  queuePriorityScore,
  rankQueue
};
