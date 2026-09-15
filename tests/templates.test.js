/**
 * Modelos de assunto/corpo em rotação (F1.1) e apoio ao front H2B.
 */
const test = require('node:test');
const assert = require('node:assert');

const fs = require('fs');
const os = require('os');
const path = require('path');

// Banco próprio: este teste apaga modelos e notificações — no banco real isso
// já apagou os modelos do usuário uma vez.
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'h2a-templates-')), 'templates.db');
const templates = require('../services/seasonalTemplateService');
const ui = require('../services/seasonalUiService');
const seasonal = require('../services/seasonalService');

test('rotação escolhe o modelo menos usado e respeita o tipo de visto', () => {
  templates.save({
    subjects: [{ content: 'S1 {vaga}' }, { content: 'S2 {empresa}', visa_type: 'H-2B' }, { content: 'S3 {nome}' }],
    bodies: [{ content: 'B1 {job_order}' }, { content: 'B2 {estado}' }]
  });
  const job = { job_title: 'Driver', employer_name: 'ACME', job_order_id: 'H-1', employer_state: 'TX', visa_type: 'H-2A' };
  const profile = { fullName: 'Ana' };

  const a = templates.compose({ job, profile });
  const b = templates.compose({ job, profile });
  const c = templates.compose({ job, profile });
  // H-2A nunca recebe o assunto marcado H-2B.
  assert.deepStrictEqual([a.subject, b.subject, c.subject].sort(), ['S1 Driver', 'S1 Driver', 'S3 Ana'].sort());
  assert.deepStrictEqual([a.body, b.body].sort(), ['B1 H-1', 'B2 TX']);
  assert.strictEqual(a.subjectTemplateId !== b.subjectTemplateId, true);

  const h2b = templates.compose({ job: Object.assign({}, job, { visa_type: 'H-2B' }), profile });
  assert.strictEqual(h2b.subject, 'S2 ACME'); // ainda sem uso: é o menos usado

  const st = templates.status();
  assert.strictEqual(st.subjects, 3);
  assert.strictEqual(st.recommended, false); // só 2 corpos
  templates.save({ subjects: [], bodies: [] });
  assert.strictEqual(templates.compose({ job, profile }).subject, null);
});

test('variável desconhecida fica visível; edição preserva contador de uso', () => {
  const [s] = templates.save({ subjects: [{ content: '{vaga} {xyz}' }] }).subjects;
  assert.strictEqual(templates.render(s.content, templates.context({ job: { job_title: 'X' } })), 'X {xyz}');
  templates.compose({ job: { job_title: 'X' }, profile: {} });
  const again = templates.save({ subjects: [{ id: s.id, content: 'novo' }] }).subjects[0];
  assert.strictEqual(again.id, s.id);
  assert.strictEqual(again.use_count, 1);
  templates.save({ subjects: [], bodies: [] });
});

test('preferências de interface aceitam só chaves conhecidas', () => {
  const p = ui.setPrefs({ theme: 'dark', screen_mode: 'cel', hacker: 'x' });
  assert.strictEqual(p.theme, 'dark');
  assert.strictEqual(p.screen_mode, 'cel');
  assert.strictEqual(p.hacker, undefined);
  ui.setPrefs({ theme: 'light', screen_mode: 'auto' });
});

test('notificações: cria, conta não lidas, marca lidas', () => {
  ui.clearNotifications();
  ui.notify('sent', 'Enviado', 'corpo', 'job:1');
  ui.notify('failed', 'Falhou');
  assert.strictEqual(ui.listNotifications().unread, 2);
  ui.markRead();
  assert.strictEqual(ui.listNotifications().unread, 0);
  ui.clearNotifications();
});

test('filtros mestres do listJobs são parametrizados e combináveis', () => {
  const all = seasonal.listJobs({ limit: 1000 });
  const tx = seasonal.listJobs({ states: 'TX', limit: 1000 });
  assert.ok(tx.every(j => j.employer_state === 'TX'));
  assert.ok(tx.length <= all.length);
  const inj = seasonal.listJobs({ q: "x' OR 1=1 --", limit: 10 });
  assert.ok(Array.isArray(inj));
  const wage = seasonal.listJobs({ minWage: 20, limit: 1000 });
  assert.ok(wage.every(j => Number(j.wage_rate) >= 20));
  const months = seasonal.listJobs({ startMonths: '01,13,zz', limit: 1000 });
  assert.ok(months.every(j => String(j.start_date).slice(5, 7) === '01'));
  const f = seasonal.facets();
  assert.ok(Array.isArray(f.states) && 'total' in f.totals);
});

test('getJob devolve o id da VAGA, não o da linha de match', () => {
  const first = seasonal.listJobs({ limit: 1 })[0];
  if (!first) return;
  const g = seasonal.getJob(first.id);
  assert.strictEqual(g.id, first.id);
  assert.strictEqual(g.job_order_id, first.job_order_id);
});

test('updateConfig: string vazia LIMPA listas de texto; número vazio mantém o atual', () => {
  seasonal.updateConfig({ preferred_states: 'TX,FL', preferred_occupations: 'harvest', daily_email_limit: 120 });
  let c = seasonal.getConfig();
  assert.strictEqual(c.preferred_states, 'TX,FL');
  assert.strictEqual(c.daily_email_limit, 120);

  seasonal.updateConfig({ preferred_states: '', preferred_occupations: '', daily_email_limit: '' });
  c = seasonal.getConfig();
  assert.strictEqual(c.preferred_states, '', '"todos os estados" precisa apagar a lista anterior');
  assert.strictEqual(c.preferred_occupations, '');
  assert.strictEqual(c.daily_email_limit, 120, 'input numérico vazio não é uma escolha');
  seasonal.updateConfig({ daily_email_limit: 300 });
});
