/**
 * Filtros combináveis da lista de vagas: estado no DOL × ordenação × ano ×
 * localização × salário — tudo AND, nada se exclui.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'h2a-filters-')), 'filters.db');

const { db } = require('../config/database');
const seasonal = require('../services/seasonalService');

function job(id, extra) {
  return Object.assign({
    job_order_id: id, visa_type: 'H-2A', job_title: 'Farmworker', normalized_title: 'Farmworker', soc_code: '45-2092',
    employer_name: 'Emp ' + id, employer_city: 'City', employer_state: 'CA', employer_phone: null,
    employer_email: null, attorney_name: null, attorney_email: null, wage_rate: 17.5, wage_unit: 'Hour',
    start_date: '2026-11-01', end_date: '2027-03-01', openings: 5, weekly_hours: 40, housing_provided: 1,
    transportation_provided: 1, duties_description: 'Work.', special_requirements: null,
    application_method: 'EMAIL', application_email: id.toLowerCase() + '@x.com', application_url: null, raw_json: '{}',
    feed_date: '2026-09-10', feed_key: 'jo', dol_active: null
  }, extra || {});
}

test.before(() => {
  // Salários em unidades diferentes; anos e estados variados; estados no DOL variados.
  seasonal.upsertJob(job('A-HOUR-CA', { wage_rate: 17.5, wage_unit: 'Hour', employer_state: 'CA', start_date: '2026-11-01', dol_active: 1 }), 'h');
  seasonal.upsertJob(job('B-MONTH-WY', { wage_rate: 2400, wage_unit: 'Month', weekly_hours: 48, employer_state: 'WY', start_date: '2026-10-01', dol_active: 1 }), 'h');
  seasonal.upsertJob(job('C-HOUR-TX', { wage_rate: 22, wage_unit: 'Hour', employer_state: 'TX', start_date: '2027-02-01', dol_active: 1 }), 'h');
  seasonal.upsertJob(job('D-WEEK-TX', { wage_rate: 600, wage_unit: 'Week', weekly_hours: 40, employer_state: 'TX', start_date: '2026-12-01', dol_active: 0, dol_status: 'Withdrawn' }), 'h');
  seasonal.upsertJob(job('E-UNKNOWN-FL', { wage_rate: 16, wage_unit: 'Hour', employer_state: 'FL', start_date: '2026-11-15', dol_active: null }), 'h');
  seasonal.upsertJob(job('F-STARTED-FL', { wage_rate: 19, wage_unit: 'Hour', employer_state: 'FL', start_date: '2025-01-01', end_date: '2027-06-01', dol_active: 1 }), 'h');
});

const ids = (rows) => rows.map(r => r.job_order_id);

test('ordenar por salário compara por hora equivalente, não pelo número bruto', () => {
  const rows = seasonal.listJobs({ sort: 'wage' });
  const order = ids(rows);
  // $2.400/mês a 48 h/semana ≈ $11,54/h — fica atrás de todas as vagas por hora.
  assert.strictEqual(order[0], 'C-HOUR-TX', '22/h é o maior');
  assert.strictEqual(order[order.length - 1], 'B-MONTH-WY', 'o salário mensal convertido é o menor');
  const monthly = rows.find(r => r.job_order_id === 'B-MONTH-WY');
  assert.ok(Math.abs(monthly.hourly_wage - 2400 / (48 * 52 / 12)) < 0.01);
  const weekly = rows.find(r => r.job_order_id === 'D-WEEK-TX');
  assert.strictEqual(weekly.hourly_wage, 15);
});

test('salário mínimo também usa o valor por hora equivalente', () => {
  const order = ids(seasonal.listJobs({ minWage: 15.5 }));
  assert.ok(!order.includes('B-MONTH-WY'), 'US$ 2.400/mês não é ≥ 15,5/h');
  assert.ok(!order.includes('D-WEEK-TX'), '600/semana = 15/h');
  assert.ok(order.includes('A-HOUR-CA') && order.includes('C-HOUR-TX'));
});

test('filtro por ano de início', () => {
  assert.deepStrictEqual(ids(seasonal.listJobs({ years: '2027' })), ['C-HOUR-TX']);
  const both = ids(seasonal.listJobs({ years: '2026,2027' }));
  assert.strictEqual(both.length, 5);
  assert.ok(!both.includes('F-STARTED-FL'));
  assert.strictEqual(seasonal.listJobs({ years: 'abcd' }).length, 6, 'ano inválido é ignorado, não zera a lista');
});

test('"ativas primeiro": ativa e futura, depois sem verificação, depois ativa já iniciada, depois inativa', () => {
  const rows = seasonal.listJobs({ sort: 'active' });
  const tier = Object.fromEntries(rows.map(r => [r.job_order_id, r.dol_tier]));
  assert.strictEqual(tier['A-HOUR-CA'], 0);
  assert.strictEqual(tier['E-UNKNOWN-FL'], 1);
  assert.strictEqual(tier['F-STARTED-FL'], 2);
  assert.strictEqual(tier['D-WEEK-TX'], 3);
  const tiers = rows.map(r => r.dol_tier);
  assert.deepStrictEqual(tiers, [...tiers].sort((a, b) => a - b), 'a lista precisa vir em camadas crescentes');
  // A prioridade padrão também põe quem recruta no DOL na frente.
  const def = seasonal.listJobs({});
  assert.strictEqual(def[def.length - 1].job_order_id, 'D-WEEK-TX', 'a retirada vem por último na prioridade padrão');
});

test('combinação: ativas no DOL + maior salário + localização + ano — tudo ao mesmo tempo', () => {
  const rows = seasonal.listJobs({ dolActive: 1, sort: 'wage', states: 'CA,TX,WY', years: '2026' });
  // Ativa (A, B, C, F), em CA/TX/WY (A, B, C, D) e início em 2026 (A, B, D, E) → A e B; por hora: A (17,5) antes de B (11,5).
  assert.deepStrictEqual(ids(rows), ['A-HOUR-CA', 'B-MONTH-WY']);

  // Localização: estado marcado aparece; desmarcado some.
  assert.deepStrictEqual(ids(seasonal.listJobs({ states: 'FL', sort: 'wage' })), ['F-STARTED-FL', 'E-UNKNOWN-FL']);
  assert.strictEqual(seasonal.listJobs({ states: 'AK' }).length, 0);
  assert.strictEqual(seasonal.listJobs({ states: '' }).length, 6, 'lista vazia = todos os estados');
});

test('facetas trazem anos e, por estado, quantas estão ativas', () => {
  const f = seasonal.facets();
  const y2026 = f.years.find(y => y.year === '2026');
  assert.ok(y2026 && y2026.total === 4 && y2026.active === 2, JSON.stringify(f.years));
  const tx = f.states.find(s => s.state === 'TX');
  assert.strictEqual(tx.total, 2);
  assert.strictEqual(tx.active, 1);
});
