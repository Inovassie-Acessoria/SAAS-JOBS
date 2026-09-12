/**
 * Prioridade estratégica 2027 (spec §33, §34, §64, §65, §77).
 *
 * O §77 pede fixtures explícitas:
 *   Job A — começa em nov/2026
 *   Job B — começa em jan/2027
 *   Job C — começa em mar/2027
 *   Job D — data desconhecida
 * e exige que a ordenação resultante seja EXPLICÁVEL.
 */

const test = require('node:test');
const assert = require('node:assert');

const tl = require('../core/timeline/hiringTimelineEngine');
const { TIMELINE_CLASS, TIMELINE_PRIORITY } = tl;

const JOB_A = { job_order_id: 'A', job_title: 'Nov 2026 → fev 2027', start_date: '2026-11-01', end_date: '2027-02-28' };
const JOB_B = { job_order_id: 'B', job_title: 'Jan 2027', start_date: '2027-01-15', end_date: '2027-10-20' };
const JOB_C = { job_order_id: 'C', job_title: 'Mar 2027', start_date: '2027-03-01', end_date: '2027-11-01' };
const JOB_D = { job_order_id: 'D', job_title: 'Sem data' };
const JOB_E = { job_order_id: 'E', job_title: 'Só 2026', start_date: '2026-03-01', end_date: '2026-09-30' };
const JOB_F = { job_order_id: 'F', job_title: 'Depois de 2027', start_date: '2029-01-01', end_date: '2029-08-01' };

// ---------------------------------------------------------------------------

test('§33 — parser de datas aceita os formatos que o feed do DOL usa', () => {
  assert.deepStrictEqual(pick(tl.parseDate('2027-01-15')), { year: 2027, month: 1 });
  assert.deepStrictEqual(pick(tl.parseDate('01/2027')), { year: 2027, month: 1 });
  assert.deepStrictEqual(pick(tl.parseDate('15/01/2027')), { year: 2027, month: 1 });
  assert.deepStrictEqual(pick(tl.parseDate('Jan 2027')), { year: 2027, month: 1 });
  assert.deepStrictEqual(pick(tl.parseDate('January 15, 2027')), { year: 2027, month: 1 });
  assert.strictEqual(tl.parseDate('2027').year, 2027);
  assert.strictEqual(tl.parseDate(''), null);
  assert.strictEqual(tl.parseDate(null), null);
  assert.strictEqual(tl.parseDate('sem data alguma'), null);

  function pick(d) { return d ? { year: d.year, month: d.month } : null; }
});

test('§77 — as quatro fixtures do spec são classificadas corretamente', () => {
  const a = tl.classifyTimeline(JOB_A);
  const b = tl.classifyTimeline(JOB_B);
  const c = tl.classifyTimeline(JOB_C);
  const d = tl.classifyTimeline(JOB_D);

  // A começa no fim de 2026 e se estende por 2027 → alvo, prioridade alta
  assert.strictEqual(a.timelineClass, TIMELINE_CLASS.TARGET_2027);
  assert.strictEqual(a.priority, TIMELINE_PRIORITY.HIGH);

  // B e C começam dentro de 2027 → prioridade máxima
  assert.strictEqual(b.timelineClass, TIMELINE_CLASS.TARGET_2027);
  assert.strictEqual(b.priority, TIMELINE_PRIORITY.VERY_HIGH);
  assert.strictEqual(c.timelineClass, TIMELINE_CLASS.TARGET_2027);
  assert.strictEqual(c.priority, TIMELINE_PRIORITY.VERY_HIGH);

  // D não tem data → não pode ser inventada
  assert.strictEqual(d.timelineClass, TIMELINE_CLASS.UNKNOWN_DATE);
  assert.strictEqual(d.priority, TIMELINE_PRIORITY.UNKNOWN);
  assert.match(d.label, /não disponível/i);
  assert.match(d.explanation, /não presume/i);
});

test('§64 — 2026-only e pós-2027 recebem prioridade menor, sem serem descartados', () => {
  const e = tl.classifyTimeline(JOB_E);
  assert.strictEqual(e.timelineClass, TIMELINE_CLASS.CURRENT_2026);
  assert.strictEqual(e.priority, TIMELINE_PRIORITY.NORMAL);
  assert.ok(e.weight > 0, 'continua elegível');

  const f = tl.classifyTimeline(JOB_F);
  assert.strictEqual(f.timelineClass, TIMELINE_CLASS.FUTURE_AFTER_2027);
  assert.strictEqual(f.priority, TIMELINE_PRIORITY.LOW);
  assert.ok(f.weight > 0);
});

test('§33 — data desconhecida pesa mais que período claramente ruim', () => {
  const unknown = tl.classifyTimeline(JOB_D).weight;
  const after = tl.classifyTimeline(JOB_F).weight;
  assert.ok(unknown > after,
    'não saber a data não pode ser punido como saber que a data é ruim');
});

test('§34 — a estratégia 2027 pode colocar uma vaga tecnicamente mais fraca na frente', () => {
  // Cenário literal do spec §34.
  const items = [
    { id: 1, jobOrderId: 'P1', timeline: tl.classifyTimeline(JOB_B), opportunityScore: 92, fitScore: 90, atsScore: 80, completeness: 100, freshness: 60 },
    { id: 2, jobOrderId: 'P2', timeline: tl.classifyTimeline(JOB_C), opportunityScore: 95, fitScore: 88, atsScore: 80, completeness: 100, freshness: 60 },
    { id: 3, jobOrderId: 'P3', timeline: tl.classifyTimeline({ start_date: '2026-12-01', end_date: '2026-12-31' }), opportunityScore: 97, fitScore: 96, atsScore: 90, completeness: 100, freshness: 90 }
  ];

  const ranked = tl.rankQueue(items);
  const positions = ranked.reduce((acc, r) => { acc[r.jobOrderId] = r.queuePosition; return acc; }, {});

  assert.ok(positions.P1 < positions.P3,
    'a vaga de jan/2027 deve vir antes da vaga de dez/2026, mesmo com scores menores');
  assert.ok(positions.P2 < positions.P3,
    'a vaga de mar/2027 também deve vir antes');
});

test('§34 — dentro de 2027, os scores voltam a decidir', () => {
  const items = [
    { id: 1, jobOrderId: 'baixo', timeline: tl.classifyTimeline(JOB_B), opportunityScore: 70, fitScore: 70, atsScore: 70, completeness: 100, freshness: 50 },
    { id: 2, jobOrderId: 'alto', timeline: tl.classifyTimeline(JOB_C), opportunityScore: 95, fitScore: 95, atsScore: 90, completeness: 100, freshness: 80 }
  ];
  const ranked = tl.rankQueue(items);
  assert.strictEqual(ranked[0].jobOrderId, 'alto',
    'com a mesma prioridade de timeline, o melhor Opportunity Score vem primeiro');
});

test('§34 — toda posição da fila vem com explicação legível', () => {
  const items = [JOB_A, JOB_B, JOB_C, JOB_D, JOB_E].map((j, i) => ({
    id: i + 1, jobOrderId: j.job_order_id,
    timeline: tl.classifyTimeline(j),
    opportunityScore: 85, fitScore: 85, atsScore: 80, completeness: 100, freshness: 60
  }));

  const ranked = tl.rankQueue(items);

  for (const r of ranked) {
    assert.ok(r.queueExplanation, `posição ${r.queuePosition} sem explicação`);
    assert.match(r.queueExplanation, new RegExp(`Posição ${r.queuePosition}`));
    assert.ok(r.queueBreakdown, 'a decomposição da pontuação precisa estar disponível');
    assert.ok(r.queueBreakdown.contributions.timeline !== undefined);
    assert.ok(r.queueBreakdown.weights, 'os pesos usados precisam ser expostos');
  }

  // A ordem tem que ser estritamente não-crescente na pontuação da fila.
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].queuePriority >= ranked[i].queuePriority);
  }
});

test('§64 — os pesos da fila são configuráveis, não fixados no código', () => {
  const items = [
    { id: 1, jobOrderId: 'timeline_forte', timeline: tl.classifyTimeline(JOB_B), opportunityScore: 60, fitScore: 60, atsScore: 60, completeness: 50, freshness: 50 },
    { id: 2, jobOrderId: 'score_forte', timeline: tl.classifyTimeline(JOB_E), opportunityScore: 99, fitScore: 99, atsScore: 99, completeness: 100, freshness: 100 }
  ];

  // Padrão: a janela de contratação é o critério primário, mesmo com scores
  // muito piores — é o que a §33 quer dizer com "strongly favor".
  assert.strictEqual(tl.rankQueue(items)[0].jobOrderId, 'timeline_forte');

  // Zerando o peso da timeline, o mérito puro assume.
  const semTimeline = tl.rankQueue(items, {
    timeline: 0, opportunity: 0.5, fit: 0.3, ats: 0.1, completeness: 0.05, freshness: 0.05
  });
  assert.strictEqual(semTimeline[0].jobOrderId, 'score_forte',
    'mudar os pesos tem que mudar a ordem — senão não são configuráveis de verdade');

  // O modo 'weighted' também devolve a decisão ao mérito.
  const ponderado = tl.rankQueue(items, tl.DEFAULT_QUEUE_WEIGHTS, 'weighted');
  assert.strictEqual(ponderado[0].jobOrderId, 'score_forte',
    'no modo ponderado puro, um score muito superior pode ultrapassar a janela');
  assert.strictEqual(ponderado[0].queueBreakdown.mode, 'weighted');
});

test('§33 — o ano-alvo é parametrizável', () => {
  const j2029 = { start_date: '2029-02-01', end_date: '2029-09-01' };

  const comAlvo2027 = tl.classifyTimeline(j2029, 2027);
  assert.strictEqual(comAlvo2027.timelineClass, TIMELINE_CLASS.FUTURE_AFTER_2027);

  const comAlvo2029 = tl.classifyTimeline(j2029, 2029);
  assert.strictEqual(comAlvo2029.timelineClass, TIMELINE_CLASS.TARGET_2027);
  assert.strictEqual(comAlvo2029.priority, TIMELINE_PRIORITY.VERY_HIGH);
  assert.match(comAlvo2029.label, /2029/);
});

test('§33 — o período também é extraído de texto livre quando não há campo', () => {
  const fromText = tl.extractPeriod({
    duties_description: 'Seasonal work running from 03/2027 to 11/2027 on the orchard.'
  });
  assert.ok(fromText.start, 'deve encontrar a data inicial no texto');
  assert.strictEqual(fromText.start.year, 2027);
  assert.strictEqual(fromText.confidence, 'MEDIUM',
    'texto livre tem confiança menor que campo estruturado');

  const structured = tl.extractPeriod({ start_date: '2027-03-01', end_date: '2027-11-01' });
  assert.strictEqual(structured.confidence, 'HIGH');
});

test('§65 — o rótulo do período é apresentável ao usuário', () => {
  const c = tl.classifyTimeline(JOB_B);
  assert.strictEqual(c.periodLabel, '01/2027 – 10/2027');

  const unknown = tl.classifyTimeline(JOB_D);
  assert.ok(!unknown.periodLabel, 'sem datas não se inventa rótulo de período');
  assert.match(unknown.label, /não disponível/i);
});
