/**
 * §66 — TESTING: TRUCK DRIVER
 *
 * As três fixtures que o spec de agentes nomeia:
 *
 *   Heavy and Tractor-Trailer Truck Driver + SOC 53-3032.00 → CONFIRMED
 *   Farm Worker cuja descrição diz "occasionally drive truck" → NOT_TRUCK_DRIVER
 *   Papel de motorista com SOC ambíguo                        → REVIEW_REQUIRED
 *
 * A segunda é a mais importante das três. É o erro que o §25 antecipa e proíbe:
 * classificar uma vaga agrícola como motorista porque o texto menciona dirigir
 * de vez em quando. Se este teste passar a falhar, o produto começa a se
 * candidatar para colheita de morango.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const gate = require('../core/agents/truckDriverGate');
const { CLASSIFICATION } = gate;

// ---------------------------------------------------------------------------
// As fixtures nomeadas pela §66
// ---------------------------------------------------------------------------

test('§66 — Heavy and Tractor-Trailer Truck Driver com SOC 53-3032.00 é CONFIRMED', () => {
  const r = gate.classify({
    job_title: 'Heavy and Tractor-Trailer Truck Driver',
    soc_code: '53-3032.00',
    duties_description: 'Operate tractor-trailer to transport agricultural products. Pre-trip inspection, log book, DOT regulations.'
  });

  assert.strictEqual(r.classification, CLASSIFICATION.CONFIRMED);
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.socMatched, true);
  assert.strictEqual(r.confidence, 'HIGH');
  assert.ok(r.reasons[0].includes('53-3032.00'), 'a razão precisa citar o SOC que decidiu');
});

test('§66, §25 — Farm Worker que "occasionally drives truck" NÃO é vaga de motorista', () => {
  const r = gate.classify({
    job_title: 'Farm Worker',
    soc_code: '45-2092.00',
    duties_description:
      'Plant, cultivate and harvest vegetables by hand. Sort and pack produce. ' +
      'Workers may occasionally drive truck to transport produce to the packing shed as needed.'
  });

  assert.strictEqual(r.classification, CLASSIFICATION.NOT);
  assert.strictEqual(r.pass, false);
  assert.ok(r.reasons.join(' ').includes('incidental') || r.reasons.join(' ').includes('não é de motorista'),
    'a razão precisa deixar claro que a direção é incidental');
});

test('§66 — papel de motorista com SOC ambíguo vai para REVIEW_REQUIRED', () => {
  const r = gate.classify({
    job_title: 'Driver',
    soc_code: '53-3033.00',       // Light Truck Drivers — da família, mas não o alvo
    duties_description: 'Deliver goods to customer locations. Load and unload vehicle.'
  });

  assert.strictEqual(r.classification, CLASSIFICATION.REVIEW);
  assert.strictEqual(r.pass, false, 'REVIEW não passa automaticamente — a decisão é humana');
});

// ---------------------------------------------------------------------------
// Casos que o §25 e o §26 exigem, além das três fixtures
// ---------------------------------------------------------------------------

test('§25 — sem SOC, título inequívoco de carreta é PROBABLE, não CONFIRMED', () => {
  const r = gate.classify({
    job_title: 'Tractor-Trailer Truck Driver',
    duties_description: 'Haul grain between farm and elevator. Operate semi truck. Pre-trip inspection required.'
  });

  assert.strictEqual(r.classification, CLASSIFICATION.PROBABLE);
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.socMatched, false);
  assert.ok(r.reasons.join(' ').match(/deveres|SOC/i),
    'sem confirmação oficial, a razão precisa dizer no que a classificação se apoiou');
});

test('§25 — empilhadeira não é caminhão, mesmo com "truck" no nome da ocupação', () => {
  const r = gate.classify({
    job_title: 'Industrial Truck and Tractor Operator',
    soc_code: '53-7051.00',
    duties_description: 'Operate forklift to move materials within the warehouse.'
  });

  assert.strictEqual(r.classification, CLASSIFICATION.NOT);
  assert.ok(r.reasons[0].includes('53-7051'), 'a razão cita o SOC que descartou');
});

test('§26 — título de caminhão com SOC de outra família vira REVIEW, não CONFIRMED', () => {
  const r = gate.classify({
    job_title: 'Truck Driver',
    soc_code: '45-2091.00',      // Agricultural Equipment Operators
    duties_description: 'Operate farm machinery.'
  });

  assert.strictEqual(r.classification, CLASSIFICATION.REVIEW);
  assert.ok(r.reasons.join(' ').includes('conflito'), 'o conflito entre título e SOC precisa ser nomeado');
});

test('§26 — o SOC alvo decide mesmo quando o título é genérico', () => {
  const r = gate.classify({
    job_title: 'Driver',
    soc_code: '53-3032',          // sem os dois dígitos finais
    duties_description: 'Transport goods.'
  });

  assert.strictEqual(r.classification, CLASSIFICATION.CONFIRMED);
  assert.strictEqual(r.socCode, '53-3032.00', 'o SOC é normalizado para a forma canônica');
});

test('§24 — housekeeper com menção a dirigir permanece fora do alvo', () => {
  const r = gate.classify({
    job_title: 'Housekeeper',
    duties_description: 'Clean guest rooms. Must be able to drive between properties when needed.'
  });

  assert.strictEqual(r.classification, CLASSIFICATION.NOT);
});

test('§25 — vaga sem nenhum sinal de direção não é motorista', () => {
  const r = gate.classify({
    job_title: 'Landscape Laborer',
    duties_description: 'Mow lawns, trim hedges, plant shrubs.'
  });

  assert.strictEqual(r.classification, CLASSIFICATION.NOT);
  assert.strictEqual(r.confidence, 'HIGH');
});

// ---------------------------------------------------------------------------
// Normalização de SOC — o dado oficial chega em formatos diferentes
// ---------------------------------------------------------------------------

test('§24 — o SOC é reconhecido em todas as formas que o dado oficial usa', () => {
  for (const raw of ['53-3032.00', '53-3032', '533032', '53.3032.00', '53-3032.99']) {
    const n = gate.normalizeSoc(raw);
    assert.strictEqual(n.base, '53-3032', `falhou para "${raw}"`);
  }
  assert.strictEqual(gate.normalizeSoc(''), null);
  assert.strictEqual(gate.normalizeSoc('abc'), null);
});

// ---------------------------------------------------------------------------
// O portão em si
// ---------------------------------------------------------------------------

test('§25 — o portão separa passar, revisar e barrar', () => {
  const confirmed = gate.gate({ job_title: 'Heavy Truck Driver', soc_code: '53-3032.00' });
  assert.strictEqual(confirmed.pass, true);
  assert.strictEqual(confirmed.needsHumanReview, false);

  const review = gate.gate({ job_title: 'Driver', soc_code: '53-3053.00' });
  assert.strictEqual(review.pass, false);
  assert.strictEqual(review.needsHumanReview, true, 'ambiguidade vai para humano, não para o lixo');

  const blocked = gate.gate({ job_title: 'Crop Harvest Worker', duties_description: 'Pick apples.' });
  assert.strictEqual(blocked.pass, false);
  assert.strictEqual(blocked.needsHumanReview, false);
});

test('§26 — toda classificação carrega a razão que a produziu', () => {
  const casos = [
    { job_title: 'Heavy and Tractor-Trailer Truck Driver', soc_code: '53-3032.00' },
    { job_title: 'Farm Worker', duties_description: 'may occasionally drive truck' },
    { job_title: 'Driver', soc_code: '53-3033.00' },
    { job_title: 'Cook', duties_description: 'Prepare meals.' }
  ];

  for (const c of casos) {
    const r = gate.classify(c);
    assert.ok(r.reasons.length > 0, `sem razão para: ${c.job_title}`);
    assert.ok(r.version, 'a versão do algoritmo precisa acompanhar a classificação');
  }
});
