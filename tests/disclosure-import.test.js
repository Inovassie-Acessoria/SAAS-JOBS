/**
 * Base de divulgação do DOL: importação com curadoria.
 *
 *   - só pedidos certificados e completos viram vaga;
 *   - e-mail: "como se candidatar" → contato do empregador → nunca advogado;
 *   - mesmo empregador + cargo + cidade/estado = um card (datas diferentes se
 *     juntam; cidade diferente é outro card); as vagas da mesma data somam;
 *   - a vaga da base some enquanto o mesmo empregador tiver o mesmo cargo no
 *     mesmo estado entre as vagas atuais — e reaparece se a atual sumir
 *     (a marca é recalculada a cada importação);
 *   - na ordenação "ativas primeiro" a base vem depois das atuais e antes
 *     das retiradas; a fila automática segue a mesma ordem;
 *   - o e-mail para a base fala da próxima temporada, com modelo próprio.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'h2a-disclosure-')), 'disc.db');

const { db } = require('../config/database');
const seasonal = require('../services/seasonalService');
const imp = require('../services/disclosureImportService');
const templates = require('../services/seasonalTemplateService');
const emailService = require('../services/seasonalEmailService');
const keys = require('../core/jobs/dedupKeys');

function row(caseNumber, extra = {}) {
  const base = {
    case_number: caseNumber, status_category: 'certified', case_status: 'Determination Issued - Certification', has_full_job_details: true,
    job: { job_title: 'Landscape Laborer', soc_code: '37-3011.00', soc_title: 'Landscaping and Groundskeeping Workers', workers_requested: 5, workers_certified: 5, education_level: 'None', training_months: 0, work_experience_months: 3, special_requirements: 'Must lift 50 lbs.' },
    dates: { received_date: '2025-01-10T10:00:00', decision_date: '2025-02-01', employment_begin_date: '2025-04-01', employment_end_date: '2025-11-30' },
    employer: { name: 'Green Valley Landscaping, LLC', city: 'Austin', state: 'TX', phone: '15125550100' },
    employer_contact: { first_name: 'Ann', last_name: 'Lee', email: 'ann@greenvalley.com', phone: '15125550100' },
    representation: { email: 'lawyer@lawfirm.com', lawfirm_or_business_name: 'Big Law' },
    worksite: { city: 'Austin', state: 'TX' },
    wage: { rate_from: 17.5, rate_to: 17.5, per: 'Hour', overtime_available: 'Y', overtime_rate_from: 26.25 },
    schedule: { anticipated_hours_per_week: 40, hourly_schedule_begin: '7:00 AM', hourly_schedule_end: '3:30 PM' },
    how_to_apply: { phone: 'N/A', email: 'jobs@greenvalley.com', website: 'N/A' },
    extra_conditions: { daily_transportation: 'Y', board_lodging_other_facilities: 'N', employer_provided_tools_equipment: 'Y' },
    source_file: 'H-2B_Disclosure_Data_FY2025_Q3.xlsx'
  };
  const merged = JSON.parse(JSON.stringify(base));
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && merged[k] && typeof merged[k] === 'object') Object.assign(merged[k], v);
    else merged[k] = v;
  }
  return merged;
}

function dolJob(id, extra) {
  return Object.assign({
    job_order_id: id, visa_type: 'H-2B', job_title: 'Landscape Laborers', normalized_title: 'Landscape Laborers', soc_code: '37-3011',
    employer_name: 'Green Valley Landscaping LLC', employer_city: 'Austin', employer_state: 'TX', employer_phone: null,
    employer_email: null, attorney_name: null, attorney_email: null, wage_rate: 18, wage_unit: 'Hour',
    start_date: '2026-04-01', end_date: '2026-11-30', openings: 5, weekly_hours: 40, housing_provided: 0,
    transportation_provided: 0, duties_description: 'Mow, trim, plant.', special_requirements: null,
    application_method: 'EMAIL', application_email: 'jobs@greenvalley.com', application_url: null, raw_json: '{}',
    feed_date: '2026-09-10', feed_key: 'h2b', dol_active: 1, dol_status: 'Accepted - Active'
  }, extra || {});
}

test.before(() => {
  const store = require('../services/candidateService').environment('seasonal', 'US', 1);
  store.updateProfile({ full_name: 'Teste Base', email: 't@example.com', years_of_experience: 3, skills: ['landscaping'], summary: 'Landscaper.' });
  seasonal.updateConfig({});
});

test('chaves de deduplicação ignoram forma jurídica, pontuação, caixa e plural', () => {
  assert.strictEqual(keys.employerKey('Green Valley Landscaping, L.L.C.'), keys.employerKey('GREEN VALLEY LANDSCAPING LLC'));
  assert.notStrictEqual(keys.employerKey('Sunshine Farms'), keys.employerKey('Sunshine Ranch'), 'Farms e Ranch são empregadores diferentes');
  assert.strictEqual(keys.titleKey('Landscape Laborers'), keys.titleKey('LANDSCAPE LABORER'));
  assert.strictEqual(keys.titleKey('Cooks'), 'cook');
  assert.notStrictEqual(keys.titleKey('Line Cook'), keys.titleKey('Cook'));
});

test('normalização: e-mail de "como se candidatar", senão contato do empregador, nunca advogado', () => {
  const a = imp.normalizeRecord(row('H-400-25001-000001'));
  assert.strictEqual(a.application_email, 'jobs@greenvalley.com');
  assert.strictEqual(a.application_method, 'EMAIL');
  assert.strictEqual(a.employer_email, 'ann@greenvalley.com');
  assert.strictEqual(a.attorney_email, null, 'advogado nunca vira destinatário');
  assert.strictEqual(a.visa_type, 'H-2B');
  assert.strictEqual(a.origin, 'disclosure');
  assert.strictEqual(a.soc_code, '37-3011');
  assert.strictEqual(a.transportation_provided, 1);
  assert.strictEqual(a.housing_provided, 0);
  assert.match(a.duties_description, /Schedule: 7:00 AM to 3:30 PM, 40 hours per week/);
  assert.match(a.special_requirements, /3 months of experience/);
  assert.match(a.special_requirements, /Must lift 50 lbs/);

  // Só site em "como se candidatar": cai no contato do empregador.
  const b = imp.normalizeRecord(row('H-400-25001-000002', { how_to_apply: { email: 'N/A', website: 'https://greenvalley.com/jobs' } }));
  assert.strictEqual(b.application_email, 'ann@greenvalley.com');
  assert.strictEqual(b.application_method, 'EMAIL');
  assert.strictEqual(b.application_url, 'https://greenvalley.com/jobs');

  // Sem e-mail nenhum (só advogado): site, e nada de advogado.
  const c = imp.normalizeRecord(row('H-400-25001-000003', { how_to_apply: { email: null, website: 'www.greenvalley.com' }, employer_contact: { email: null } }));
  assert.strictEqual(c.application_email, null);
  assert.strictEqual(c.application_method, 'WEBSITE');
  assert.strictEqual(c.application_url, 'http://www.greenvalley.com');

  // Estado por extenso vira sigla; unidade de salário do DOL é preservada.
  const d = imp.normalizeRecord(row('H-400-25001-000004', { worksite: { state: 'FLORIDA', city: 'Naples' }, wage: { rate_from: 2400, per: 'Month' } }));
  assert.strictEqual(d.employer_state, 'FL');
  assert.strictEqual(d.wage_unit, 'Month');
  assert.strictEqual(d.wage_rate, 2400);
});

test('linhas pendentes de loteria ou sem cargo não viram vaga', () => {
  assert.strictEqual(imp.rejectReason(row('H-400-25184-149281', { status_category: 'pending_lottery', has_full_job_details: false, job: { job_title: null } })), 'not_certified');
  assert.strictEqual(imp.rejectReason(row('H-400-25184-149282', { job: { job_title: '' } })), 'no_title');
  assert.strictEqual(imp.rejectReason(row('H-400-25184-149283')), null);
});

test('curadoria: mesmo empregador + cargo + cidade = um card; cidade diferente = outro', () => {
  const jobs = [
    imp.normalizeRecord(row('H-400-25001-000010')),                                                     // Austin, abr/2025
    imp.normalizeRecord(row('H-400-25001-000011', { job: { workers_certified: 3 } })),                  // Austin, mesma data → soma
    imp.normalizeRecord(row('H-400-25001-000012', { dates: { employment_begin_date: '2025-10-01', employment_end_date: '2026-03-31' }, job: { workers_certified: 2 }, how_to_apply: { email: null }, employer_contact: { email: null } })), // Austin, data diferente e mais recente, sem e-mail
    imp.normalizeRecord(row('H-400-25001-000013', { worksite: { city: 'Dallas' }, employer: { name: 'GREEN VALLEY LANDSCAPING LLC' } })), // Dallas → outro card
    imp.normalizeRecord(row('H-400-25001-000014', { job: { job_title: 'Housekeeper' } }))              // outro cargo → outro card
  ];
  const { representatives, mergedRows, mergedGroups } = imp.curate(jobs);
  assert.strictEqual(representatives.length, 3);
  assert.strictEqual(mergedRows, 2);
  assert.strictEqual(mergedGroups, 1);
  const austin = representatives.find(j => j.employer_city === 'Austin' && /Landscape/.test(j.job_title));
  assert.strictEqual(austin.job_order_id, 'H-400-25001-000012', 'fica o pedido mais recente');
  assert.strictEqual(austin.openings, 2, 'só somam pedidos da mesma temporada');
  assert.strictEqual(austin.application_email, 'jobs@greenvalley.com', 'o e-mail vem de um pedido irmão quando o representante não tem');
  assert.deepStrictEqual(austin.merged_cases.map(m => m.case).sort(), ['H-400-25001-000010', 'H-400-25001-000011']);
});

test('importação: grava, esconde quem já tem a mesma vaga atual e reaparece quando a atual some', async () => {
  // Vaga ATUAL do DOL do mesmo empregador/cargo/estado, com grafia diferente.
  seasonal.upsertJob(dolJob('H-400-26100-000001'), 'h1');
  const rows = [
    row('H-400-25001-000020'),                                                                              // Green Valley, Austin — duplicada da atual
    row('H-400-25001-000021', { employer: { name: 'Blue Lake Resort Inc' }, employer_contact: { email: 'hr@bluelake.com' }, how_to_apply: { email: 'hr@bluelake.com' }, job: { job_title: 'Housekeeper' }, worksite: { city: 'Tahoe City', state: 'CA' } }),
    row('H-400-25001-000022', { employer: { name: 'Blue Lake Resort Inc' }, employer_contact: { email: 'hr@bluelake.com' }, how_to_apply: { email: 'hr@bluelake.com' }, job: { job_title: 'Housekeepers' }, worksite: { city: 'Tahoe City', state: 'CA' }, dates: { employment_begin_date: '2024-05-01', employment_end_date: '2024-10-31' } }),
    row('H-400-25184-149281', { status_category: 'pending_lottery', has_full_job_details: false, job: { job_title: null } })
  ];
  const report = await imp.run({ rows, enrich: false, userId: 1, sourceRef: 'teste.json' });
  assert.strictEqual(report.received, 4);
  assert.strictEqual(report.usable, 3);
  assert.deepStrictEqual(report.skipped, { not_certified: 1 });
  assert.strictEqual(report.cards, 2);
  assert.strictEqual(report.mergedRows, 1);
  assert.strictEqual(report.hiddenByCurrent, 1);
  assert.strictEqual(report.withEmail, 2);

  const stored = db.prepare("SELECT job_order_id, origin, origin_ref, employer_key, title_key, merged_cases_json FROM seasonal_jobs WHERE origin = 'disclosure' ORDER BY job_order_id").all();
  assert.strictEqual(stored.length, 2);
  assert.strictEqual(stored[0].origin_ref, 'teste.json');
  assert.ok(stored.every(r => r.employer_key && r.title_key));
  const blue = stored.find(r => r.job_order_id === 'H-400-25001-000021');
  assert.ok(blue, 'fica o pedido mais recente (2025) do Blue Lake');
  assert.deepStrictEqual(JSON.parse(blue.merged_cases_json).map(m => m.case), ['H-400-25001-000022']);

  // Lista: a atual aparece, a da base do mesmo empregador/cargo não; a do Blue Lake sim.
  const ids = seasonal.listJobs({}).map(j => j.job_order_id);
  assert.ok(ids.includes('H-400-26100-000001'));
  assert.ok(!ids.includes('H-400-25001-000020'), 'a base some quando a atual existe');
  assert.ok(ids.includes('H-400-25001-000021'));
  assert.strictEqual(seasonal.listJobs({ origin: 'disclosure' }).length, 1);
  assert.strictEqual(seasonal.listJobs({ origin: 'dol' }).length, 1);
  const f = seasonal.facets();
  assert.strictEqual(f.totals.disclosure, 1);
  assert.strictEqual(f.totals.current, 1);
  assert.ok(!seasonal.suggest('Green Valley').some(s => s.kind === 'order' && s.label === 'H-400-25001-000020'));

  // A atual é descartada? Continua existindo como 'dol' → a base continua oculta.
  // A atual some do acervo → a base volta.
  db.prepare("DELETE FROM seasonal_jobs WHERE job_order_id = 'H-400-26100-000001'").run();
  assert.ok(!seasonal.listJobs({}).map(j => j.job_order_id).includes('H-400-25001-000020'), 'até a próxima importação, a marca fica');
  assert.strictEqual(seasonal.refreshDuplicateFlags(), 0);
  assert.ok(seasonal.listJobs({}).map(j => j.job_order_id).includes('H-400-25001-000020'), 'sem a atual, a base reaparece');

  // Reimportar o mesmo arquivo não duplica.
  const again = await imp.run({ rows, enrich: false, userId: 1, sourceRef: 'teste.json' });
  assert.strictEqual(again.newJobs, 0);
  assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM seasonal_jobs WHERE origin = 'disclosure'").get().c, 2);
});

test('ordenação e fila: base depois das atuais e antes das retiradas', () => {
  // Pelo pipeline, como o feed faz — só vaga pontuada entra na fila.
  seasonal.runPipeline([
    dolJob('H-400-26100-000002', { employer_name: 'Other Co', job_title: 'Cook', employer_state: 'ME', dol_active: 0, dol_status: 'Withdrawn', application_email: 'x@other.com' }),
    dolJob('H-400-26100-000003', { employer_name: 'Active Co', job_title: 'Server', employer_state: 'ME', dol_active: 1, application_email: 'y@active.com', start_date: '2027-01-01' })
  ], { cfg: seasonal.getConfig(), profile: seasonal.candidateProfile(1), userId: 1 });
  const rows = seasonal.listJobs({ sort: 'active' });
  const tier = Object.fromEntries(rows.map(r => [r.job_order_id, r.dol_tier]));
  assert.strictEqual(tier['H-400-26100-000003'], 0);
  assert.strictEqual(tier['H-400-25001-000021'], 3, 'base = camada 3');
  assert.strictEqual(tier['H-400-26100-000002'], 4, 'retirada = camada 4');
  const ranked = seasonal.rankedCandidates(50).map(i => i.jobOrderId);
  assert.ok(ranked.indexOf('H-400-26100-000003') < ranked.indexOf('H-400-25001-000021'));
  assert.ok(!ranked.includes('H-400-26100-000002'), 'retirada nunca entra na fila');
});

test('e-mail para a base: modelo de "próxima temporada" e texto gerado coerente', () => {
  const job = db.prepare("SELECT * FROM seasonal_jobs WHERE job_order_id = 'H-400-25001-000021'").get();
  assert.strictEqual(templates.audienceOf(job), 'RECURRING');
  const c = templates.compose({ job, profile: { fullName: 'Ana' }, consume: false });
  assert.match(c.subject, /upcoming H-2B season — Housekeeper — Ana/);
  assert.match(c.body, /hired Housekeeper workers through the H-2B program for the 2025 season in Tahoe City, CA/);
  // Vaga atual não recebe o modelo da base.
  const current = { origin: 'dol', visa_type: 'H-2B', job_title: 'Server' };
  assert.strictEqual(templates.pick('subject', 'H-2B', templates.audienceOf(current)), null, 'sem modelo ANY/CURRENT cadastrado, nada é escolhido');
  // Texto gerado pelo sistema (sem modelo) também fala da próxima temporada.
  const letter = emailService.buildCoverLetter({ job, profile: { fullName: 'Ana' }, resume: null });
  assert.match(letter, /I would like to apply for a position on your team for the upcoming season/);
  assert.doesNotMatch(letter, /I am applying for the .* position under DOL job order/);
  // Editor: o público é gravado e devolvido.
  const saved = templates.save({ subjects: [{ content: 'Hi {vaga}', visa_type: 'ANY', audience: 'CURRENT' }] });
  assert.strictEqual(saved.subjects[0].audience, 'CURRENT');
  assert.ok(saved.audiences.some(a => a.value === 'RECURRING'));
});
