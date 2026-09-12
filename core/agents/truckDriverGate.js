/**
 * Truck Driver Gate — filtro determinístico de primeiro estágio (spec de agentes
 * §24, §25, §26).
 *
 * Seasonal Jobs existe para UMA coisa: vagas de motorista de caminhão. Esta é
 * uma regra de negócio inegociável (§24). O portão roda ANTES de qualquer
 * análise cara e não usa LLM — é código determinístico e auditável (§10, §25).
 *
 * As três decisões que o portão precisa acertar (§66):
 *
 *   Heavy and Tractor-Trailer Truck Driver + SOC 53-3032.00 → CONFIRMED
 *   Farm Worker cuja descrição diz "occasionally drive truck" → NOT_TRUCK_DRIVER
 *   Papel de motorista com SOC ambíguo                        → REVIEW_REQUIRED
 *
 * O erro caro aqui não é deixar passar pouco — é classificar uma vaga agrícola
 * genérica como motorista porque o texto menciona dirigir de vez em quando.
 * Por isso a direção incidental é detectada explicitamente e REBAIXA a vaga.
 */

const VERSION = 'truck-gate-v1';

/** SOC alvo do produto (§24). */
const TARGET_SOC = '53-3032.00';
const TARGET_SOC_BASE = '53-3032';

/**
 * SOCs vizinhos. Nenhum deles é o alvo, mas todos são ocupações de direção —
 * merecem revisão humana em vez de descarte silencioso (§26, §54).
 */
const RELATED_SOC = {
  '53-3033': 'Light Truck Drivers',
  '53-3031': 'Driver/Sales Workers',
  '53-3032': 'Heavy and Tractor-Trailer Truck Drivers',
  '53-3053': 'Shuttle Drivers and Chauffeurs',
  '53-3058': 'Passenger Vehicle Drivers',
  '45-2091': 'Agricultural Equipment Operators',
  '53-7051': 'Industrial Truck and Tractor Operators'   // empilhadeira — NÃO é caminhão
};

/** SOCs de direção que não são caminhão pesado, mas também não são desqualificantes. */
const DRIVING_SOC_PREFIX = ['53-30'];

/** SOC que parece caminhão e não é: empilhadeira, trator industrial. */
const FALSE_FRIEND_SOC = ['53-7051', '53-7061', '45-2091'];

// ---------------------------------------------------------------------------
// Sinais textuais
// ---------------------------------------------------------------------------

/** Termos que, sozinhos, caracterizam caminhão pesado / carreta (§26). */
const HEAVY_TITLE = [
  'tractor trailer', 'tractor-trailer', 'semi truck', 'semi-truck', 'semi trailer',
  'heavy truck', 'heavy and tractor', 'tractor trailer truck driver',
  'class a driver', 'class a cdl', 'cdl a driver', 'cdl class a',
  'otr driver', 'over the road driver', 'long haul', 'long-haul',
  'truck driver', 'truck drivers', 'driver truck', 'grain hauler', 'grain truck driver',
  'dump truck driver', 'tanker driver', 'flatbed driver', 'freight driver',
  'motorista de caminhao', 'caminhoneiro'
];

/** Termos de direção genérica — sugerem motorista, mas não caminhão pesado. */
const GENERIC_DRIVING = [
  'driver', 'driving', 'delivery driver', 'shuttle driver', 'bus driver',
  'chauffeur', 'van driver', 'pickup driver', 'operator of vehicles'
];

/** Ocupações que NÃO são de motorista, ainda que citem direção (§25). */
const NON_DRIVING_OCCUPATION = [
  'farmworker', 'farm worker', 'farm laborer', 'field worker', 'harvest',
  'crop', 'picker', 'packing', 'packer', 'nursery worker', 'greenhouse',
  'housekeeper', 'housekeeping', 'maid', 'server', 'waiter', 'waitress',
  'cook', 'kitchen', 'dishwasher', 'landscap', 'groundskeep', 'mower',
  'construction laborer', 'carpenter', 'roofer', 'concrete', 'framer',
  'meat', 'poultry', 'slaughter', 'fish', 'seafood processing',
  'livestock worker', 'herder', 'shepherd', 'sheep', 'dairy worker',
  'maintenance worker', 'janitor', 'custodian', 'amusement', 'lifeguard',
  'forestry', 'tree planter', 'reforestation'
];

/** Marcadores de direção INCIDENTAL — o caso que a §25 manda não confundir. */
const INCIDENTAL_MARKERS = [
  'occasionally drive', 'occasionally operate', 'may drive', 'may be required to drive',
  'may occasionally', 'as needed drive', 'when needed drive', 'if needed drive',
  'incidental driving', 'some driving', 'light driving', 'drive as needed',
  'ability to drive', 'must be able to drive', 'willing to drive',
  'other duties include driving', 'occasional driving', 'drive farm vehicles',
  'drive tractor', 'operate tractor', 'drive atv', 'drive utility vehicle'
];

/** Deveres centrados na operação do veículo (§26). */
const CENTRAL_DUTY_MARKERS = [
  'transport', 'haul', 'hauling', 'deliver load', 'delivery of goods',
  'operate a tractor-trailer', 'operate tractor-trailer', 'operate semi',
  'drive truck', 'drives truck', 'driving truck', 'truck driving',
  'load and unload', 'pre-trip inspection', 'pretrip inspection', 'post-trip',
  'dot regulations', 'department of transportation', 'hours of service',
  'log book', 'logbook', 'eld', 'commercial motor vehicle', 'cmv',
  'freight', 'cargo', 'trailer', 'gross vehicle weight', 'gvwr',
  'interstate', 'intrastate', 'route', 'mileage'
];

// ---------------------------------------------------------------------------

const CLASSIFICATION = {
  CONFIRMED: 'TRUCK_DRIVER_CONFIRMED',
  PROBABLE: 'TRUCK_DRIVER_PROBABLE',
  NOT: 'NOT_TRUCK_DRIVER',
  REVIEW: 'REVIEW_REQUIRED'
};

const CLASSIFICATION_LABEL = {
  TRUCK_DRIVER_CONFIRMED: 'Motorista de caminhão — confirmado',
  TRUCK_DRIVER_PROBABLE: 'Motorista de caminhão — provável',
  NOT_TRUCK_DRIVER: 'Não é vaga de motorista de caminhão',
  REVIEW_REQUIRED: 'Precisa de revisão humana'
};

function normalize(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s.\-/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normaliza um código SOC para a forma `53-3032.00`, aceitando as variações que
 * aparecem no dado oficial: `53-3032`, `533032`, `53.3032`, `53-3032.00`.
 */
function normalizeSoc(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^0-9]/g, '');
  if (digits.length < 6) return null;
  const base = `${digits.slice(0, 2)}-${digits.slice(2, 6)}`;
  const detail = digits.length >= 8 ? digits.slice(6, 8) : '00';
  return { base, full: `${base}.${detail}` };
}

function countHits(haystack, needles) {
  const hits = [];
  for (const n of needles) {
    if (haystack.includes(n)) hits.push(n);
  }
  return hits;
}

/**
 * Mede o quanto os deveres giram em torno de operar o veículo (§26).
 * Não é contagem de palavra solta: exige marcadores de operação de transporte.
 */
function dutyCentrality(dutiesText) {
  const t = normalize(dutiesText);
  if (!t) return { score: 0, hits: [], hasText: false };
  const hits = countHits(t, CENTRAL_DUTY_MARKERS);
  // Normaliza pelo tamanho: um texto longo com dois marcadores é menos central
  // que um texto curto com dois marcadores.
  const words = t.split(' ').length;
  const density = hits.length / Math.max(1, Math.sqrt(words / 20));
  return { score: Math.min(100, Math.round(density * 25)), hits, hasText: true };
}

/**
 * Classifica uma ordem de serviço do Seasonal quanto a ser vaga de motorista.
 *
 * @param {object} job  linha de `seasonal_jobs` ou objeto normalizado equivalente
 * @returns {{classification:string, label:string, pass:boolean, confidence:string,
 *            socCode:string|null, socMatched:boolean, incidental:boolean,
 *            signals:object, reasons:string[], version:string}}
 */
function classify(job = {}) {
  const title = normalize(job.job_title || job.title || job.normalized_title);
  const duties = job.duties_description || job.description || '';
  const requirements = job.special_requirements || job.requirements || '';
  const body = normalize([duties, requirements].filter(Boolean).join(' '));
  const all = `${title} ${body}`.trim();

  const soc = normalizeSoc(job.soc_code);
  const reasons = [];

  const heavyTitleHits = countHits(title, HEAVY_TITLE);
  const heavyBodyHits = countHits(body, HEAVY_TITLE);
  const genericDrivingHits = countHits(title, GENERIC_DRIVING);
  const nonDrivingHits = countHits(title, NON_DRIVING_OCCUPATION);
  const nonDrivingBodyHits = countHits(body, NON_DRIVING_OCCUPATION);
  const incidentalHits = countHits(all, INCIDENTAL_MARKERS);
  const centrality = dutyCentrality(duties);

  const signals = {
    heavyTitle: heavyTitleHits,
    heavyBody: heavyBodyHits,
    genericDriving: genericDrivingHits,
    nonDrivingOccupation: nonDrivingHits,
    nonDrivingInBody: nonDrivingBodyHits,
    incidental: incidentalHits,
    dutyCentrality: centrality
  };

  const result = (classification, confidence) => ({
    classification,
    label: CLASSIFICATION_LABEL[classification],
    pass: classification === CLASSIFICATION.CONFIRMED || classification === CLASSIFICATION.PROBABLE,
    confidence,
    socCode: soc ? soc.full : null,
    socMatched: Boolean(soc && soc.base === TARGET_SOC_BASE),
    socLabel: soc ? (RELATED_SOC[soc.base] || null) : null,
    incidental: incidentalHits.length > 0 && heavyTitleHits.length === 0,
    signals,
    reasons,
    version: VERSION
  });

  // -------------------------------------------------------------------------
  // 1. SOC oficial — o caminho preferido da §25.
  // -------------------------------------------------------------------------
  if (soc && soc.base === TARGET_SOC_BASE) {
    reasons.push(`SOC ${soc.full} corresponde a Heavy and Tractor-Trailer Truck Drivers (${TARGET_SOC}).`);
    if (heavyTitleHits.length) reasons.push(`O título confirma: "${heavyTitleHits[0]}".`);
    return result(CLASSIFICATION.CONFIRMED, 'HIGH');
  }

  // SOC de empilhadeira / trator agrícola: parece caminhão, não é (§25).
  if (soc && FALSE_FRIEND_SOC.includes(soc.base) && !heavyTitleHits.length) {
    reasons.push(
      `SOC ${soc.full} (${RELATED_SOC[soc.base] || 'ocupação não rodoviária'}) não é motorista de caminhão pesado.`
    );
    return result(CLASSIFICATION.NOT, 'HIGH');
  }

  // -------------------------------------------------------------------------
  // 2. Ocupação claramente não-motorista + direção incidental (§25).
  //    Este é o caso que a spec proíbe classificar como motorista.
  // -------------------------------------------------------------------------
  if (nonDrivingHits.length && !heavyTitleHits.length) {
    if (incidentalHits.length) {
      reasons.push(
        `O título indica "${nonDrivingHits[0]}" e a menção a dirigir é incidental ` +
        `("${incidentalHits[0]}"). A §25 proíbe classificar isso como vaga de motorista.`
      );
    } else {
      reasons.push(`O título indica "${nonDrivingHits[0]}", uma ocupação que não é de motorista.`);
    }
    return result(CLASSIFICATION.NOT, 'HIGH');
  }

  // -------------------------------------------------------------------------
  // 3. Sem SOC alvo, mas com título inequívoco de caminhão pesado.
  //    Sem confirmação oficial não afirmamos CONFIRMED — o dado não sustenta.
  // -------------------------------------------------------------------------
  if (heavyTitleHits.length) {
    reasons.push(`O título contém "${heavyTitleHits[0]}", terminologia de caminhão pesado.`);

    if (soc && DRIVING_SOC_PREFIX.some(p => soc.base.startsWith(p))) {
      reasons.push(`SOC ${soc.full} (${RELATED_SOC[soc.base] || 'ocupação de transporte'}) é da família de transporte, mas não é o ${TARGET_SOC}.`);
      return result(CLASSIFICATION.PROBABLE, 'MEDIUM');
    }
    if (soc) {
      reasons.push(`SOC ${soc.full} não é de transporte rodoviário — há conflito entre título e código.`);
      return result(CLASSIFICATION.REVIEW, 'LOW');
    }
    if (centrality.hasText && centrality.score >= 25) {
      reasons.push(`Os deveres giram em torno da operação do veículo (${centrality.hits.slice(0, 3).join(', ')}).`);
      return result(CLASSIFICATION.PROBABLE, 'HIGH');
    }
    reasons.push('Não há SOC informado e os deveres não detalham a operação do veículo.');
    return result(CLASSIFICATION.PROBABLE, 'MEDIUM');
  }

  // -------------------------------------------------------------------------
  // 4. SOC de direção sem título de caminhão pesado → revisão (§26, §54).
  // -------------------------------------------------------------------------
  if (soc && DRIVING_SOC_PREFIX.some(p => soc.base.startsWith(p))) {
    reasons.push(
      `SOC ${soc.full} (${RELATED_SOC[soc.base] || 'ocupação de transporte'}) é de motorista, ` +
      'mas não do caminhão pesado alvo e o título não esclarece.'
    );
    return result(CLASSIFICATION.REVIEW, 'LOW');
  }

  // -------------------------------------------------------------------------
  // 5. Título genérico de motorista, sem SOC — ambíguo por definição (§66).
  // -------------------------------------------------------------------------
  if (genericDrivingHits.length) {
    if (incidentalHits.length && !centrality.hits.length) {
      reasons.push(`Menção a direção é incidental ("${incidentalHits[0]}") e os deveres não são de transporte.`);
      return result(CLASSIFICATION.NOT, 'MEDIUM');
    }
    reasons.push(`O título diz "${genericDrivingHits[0]}" sem indicar o porte do veículo, e não há SOC para desempatar.`);
    if (centrality.score >= 40) {
      reasons.push(`Os deveres, porém, são de transporte (${centrality.hits.slice(0, 3).join(', ')}).`);
      return result(CLASSIFICATION.REVIEW, 'MEDIUM');
    }
    return result(CLASSIFICATION.REVIEW, 'LOW');
  }

  // -------------------------------------------------------------------------
  // 6. Corpo do texto fala de caminhão pesado, título não.
  // -------------------------------------------------------------------------
  if (heavyBodyHits.length && centrality.score >= 40 && !nonDrivingBodyHits.length) {
    reasons.push(`O título não menciona caminhão, mas os deveres descrevem "${heavyBodyHits[0]}" com centralidade ${centrality.score}.`);
    return result(CLASSIFICATION.REVIEW, 'LOW');
  }

  // -------------------------------------------------------------------------
  // 7. Nada indica motorista.
  // -------------------------------------------------------------------------
  reasons.push('Nenhum sinal de ocupação de motorista de caminhão no título, no SOC ou nos deveres.');
  return result(CLASSIFICATION.NOT, 'HIGH');
}

/**
 * O portão em si (§25): devolve apenas se a vaga segue no funil do Seasonal.
 * REVIEW_REQUIRED não passa automaticamente — vai para ação humana (§54).
 */
function gate(job) {
  const c = classify(job);
  return {
    pass: c.pass,
    needsHumanReview: c.classification === CLASSIFICATION.REVIEW,
    classification: c.classification,
    reason: c.reasons[0] || null,
    detail: c
  };
}

module.exports = {
  VERSION,
  TARGET_SOC,
  TARGET_SOC_BASE,
  CLASSIFICATION,
  CLASSIFICATION_LABEL,
  RELATED_SOC,
  normalizeSoc,
  dutyCentrality,
  classify,
  gate
};
