/**
 * Isolamento de candidato por plataforma e país (spec de infraestrutura §1A–§1K).
 *
 * O invariante que estes testes protegem (§1K):
 *
 *   > Toda plataforma é dona do próprio perfil, currículos, preferências,
 *   > contexto de ATS e histórico. Nenhuma plataforma consome automaticamente
 *   > dados de candidato de outra.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'h2a-env-'));
process.env.DB_PATH = path.join(TMP, 'env.db');

const { db } = require('../config/database');
const candidate = require('../services/candidateService');
const atsService = require('../services/atsService');
const auth = require('../services/authService');

// Todos os ambientes deste arquivo pertencem ao MESMO usuário: o que se verifica
// aqui é a separação por plataforma e país. A separação ENTRE usuários é coberta
// em auth.test.js.
const USER = auth.localOperator().id;
const envOf = (p, c) => candidate.environment(p, c, USER);

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

const ALL_ENVS = [
  ['gupy', 'BR'], ['gupy', 'US'],
  ['indeed', 'BR'], ['indeed', 'US'],
  ['seasonal', 'US']
];

/** Cria um arquivo de currículo real para o ambiente. */
function seedResume(platform, country, name, careerTrack = 'geral', docType = 'resume') {
  const store = envOf(platform, country);
  const file = path.join(TMP, `${platform}-${country}-${name.replace(/\W/g, '')}.txt`);
  fs.writeFileSync(file, `${name}\ncandidate@example.invalid\n\nExperience\nGoogle Ads and Meta Ads campaigns\n\nEducation\nBachelor\n\nSkills\nGoogle Ads, Meta Ads`);
  return store.addResume(
    { path: file, filename: path.basename(file), originalname: `${name}.txt`, size: fs.statSync(file).size },
    { name, career_track: careerTrack, doc_type: docType }
  ).resume;
}

// ---------------------------------------------------------------------------

test('§1A — o modelo compartilhado não existe mais no banco', () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);

  for (const forbidden of ['core_master_profile', 'core_resumes', 'core_profile_attributes', 'core_resume_analysis']) {
    assert.ok(!tables.includes(forbidden),
      `${forbidden} é proibida pelo §1A e não pode existir`);
  }

  // E as tabelas por ambiente existem.
  for (const p of ['gupy', 'indeed', 'seasonal']) {
    assert.ok(tables.includes(`${p}_profiles`), `${p}_profiles deve existir`);
    assert.ok(tables.includes(`${p}_resumes`), `${p}_resumes deve existir`);
    assert.ok(tables.includes(`${p}_resume_analysis`), `${p}_resume_analysis deve existir`);
  }
});

test('§1B — cada ambiente tem um perfil independente', () => {
  // Preenche apenas Gupy BR.
  envOf('gupy', 'BR').updateProfile({
    full_name: 'Perfil Gupy Brasil', email: 'gupy.br@example.invalid',
    skills: 'Google Ads, Meta Ads'
  });

  const gupyBr = envOf('gupy', 'BR').getProfile();
  assert.strictEqual(gupyBr.fullName, 'Perfil Gupy Brasil');
  assert.deepStrictEqual(gupyBr.skills, ['Google Ads', 'Meta Ads']);
  assert.strictEqual(gupyBr.isEmpty, false);

  // Todos os outros continuam vazios — nada foi sincronizado (§1D).
  for (const [p, c] of ALL_ENVS) {
    if (p === 'gupy' && c === 'BR') continue;
    const other = envOf(p, c).getProfile();
    assert.strictEqual(other.fullName, '', `${p}/${c} não pode ter recebido o nome do Gupy BR`);
    assert.deepStrictEqual(other.skills, [], `${p}/${c} não pode ter recebido as skills do Gupy BR`);
    assert.strictEqual(other.isEmpty, true);
  }
});

test('§1D — atualizar um perfil não propaga para nenhum outro', () => {
  envOf('indeed', 'US').updateProfile({
    full_name: 'Perfil Indeed USA', skills: 'Kubernetes, Terraform'
  });

  assert.strictEqual(envOf('indeed', 'US').getProfile().fullName, 'Perfil Indeed USA');

  // Gupy BR mantém exatamente o que tinha.
  const gupyBr = envOf('gupy', 'BR').getProfile();
  assert.strictEqual(gupyBr.fullName, 'Perfil Gupy Brasil');
  assert.deepStrictEqual(gupyBr.skills, ['Google Ads', 'Meta Ads']);

  // Indeed BR — mesma plataforma, outro país — continua intocado (§1C).
  assert.strictEqual(envOf('indeed', 'BR').getProfile().isEmpty, true);
});

test('§1C — Brasil e EUA da mesma plataforma são independentes', () => {
  envOf('gupy', 'US').updateProfile({ full_name: 'Perfil Gupy USA' });

  assert.strictEqual(envOf('gupy', 'BR').getProfile().fullName, 'Perfil Gupy Brasil');
  assert.strictEqual(envOf('gupy', 'US').getProfile().fullName, 'Perfil Gupy USA');
});

test('§1B — currículos ficam no ambiente onde foram enviados', () => {
  const gBr = seedResume('gupy', 'BR', 'Curriculo Gupy BR');
  const gUs = seedResume('gupy', 'US', 'Resume Gupy US');
  const iUs = seedResume('indeed', 'US', 'Resume Indeed US');
  const sUs = seedResume('seasonal', 'US', 'Resume Seasonal');

  const names = (p, c) => envOf(p, c).listResumes().map(r => r.name);

  assert.deepStrictEqual(names('gupy', 'BR'), ['Curriculo Gupy BR']);
  assert.deepStrictEqual(names('gupy', 'US'), ['Resume Gupy US']);
  assert.deepStrictEqual(names('indeed', 'US'), ['Resume Indeed US']);
  assert.deepStrictEqual(names('seasonal', 'US'), ['Resume Seasonal']);
  assert.deepStrictEqual(names('indeed', 'BR'), [], 'Indeed BR não recebeu nada');

  // Cada plataforma tem seu próprio espaço de ids. O que importa é que a leitura
  // por id JAMAIS devolva o documento de outro ambiente — mesmo quando o número
  // coincide, o registro retornado é sempre o da tabela do próprio ambiente.
  const byId = (p, c, id) => envOf(p, c).getResume(id);

  assert.strictEqual(byId('gupy', 'BR', gBr.id).name, 'Curriculo Gupy BR');

  for (const [p, c, alheio] of [
    ['gupy', 'US', gBr],      // outro país da mesma plataforma
    ['indeed', 'US', gUs],    // outra plataforma
    ['seasonal', 'US', iUs],
    ['gupy', 'US', sUs]
  ]) {
    const got = byId(p, c, alheio.id);
    if (got !== null) {
      assert.notStrictEqual(got.name, alheio.name,
        `${p}/${c} devolveu o documento "${alheio.name}", que pertence a outro ambiente`);
      assert.ok(envOf(p, c).listResumes().some(r => r.id === got.id),
        `${p}/${c} só pode devolver documento da própria lista`);
    }
  }

  // E o conteúdo em si nunca cruza: nenhum ambiente enxerga o arquivo do outro.
  const allNames = new Map(ALL_ENVS.map(([p, c]) =>
    [`${p}/${c}`, envOf(p, c).listResumes().map(r => r.name)]));
  assert.ok(!allNames.get('indeed/US').includes('Resume Gupy US'));
  assert.ok(!allNames.get('gupy/US').includes('Resume Indeed US'));
  assert.ok(!allNames.get('gupy/BR').includes('Resume Seasonal'));
});

test('§1H — a chave de armazenamento declara plataforma e país', () => {
  const r = envOf('gupy', 'BR').listResumes()[0];
  assert.match(r.storage_key, /^users\/1\/gupy\/br\/resumes\/\d+\.txt$/,
    `chave deveria conter plataforma e país; veio: ${r.storage_key}`);

  const s = envOf('seasonal', 'US').listResumes()[0];
  assert.match(s.storage_key, /^users\/1\/seasonal\/us\/resumes\//);
});

test('§1E/§1I — recomendação de currículo nunca cruza ambientes', () => {
  // Indeed BR não tem currículo: a resposta é explícita, não o do Indeed US.
  const rec = envOf('indeed', 'BR').recommendResume({});
  assert.strictEqual(rec.resume, null);
  assert.match(rec.reason, /Nenhum currículo configurado para indeed\/BR/);
  assert.match(rec.reason, /não usa o currículo de outra plataforma/i);

  // Onde há currículo, vem o do próprio ambiente.
  const ok = envOf('indeed', 'US').recommendResume({});
  assert.ok(ok.resume);
  assert.strictEqual(ok.resume.name, 'Resume Indeed US');
  assert.strictEqual(ok.environment, 'indeed/US');
});

test('§1E — ATS de um ambiente sem currículo não usa o de outro', () => {
  const vazio = atsService.resolveEnvironmentAts('indeed', 'BR', { userId: USER });
  assert.strictEqual(vazio.score, null, 'sem currículo o score é nulo, nunca emprestado');
  assert.strictEqual(vazio.resume, null);
  assert.match(vazio.reason, /Nenhum currículo configurado/);

  const cheio = atsService.resolveEnvironmentAts('indeed', 'US', { userId: USER });
  assert.ok(typeof cheio.score === 'number', 'com currículo há score');
  assert.ok(cheio.resume);
});

test('§1E — a análise sempre roda sobre o documento do próprio ambiente', () => {
  const gupyBrResume = envOf('gupy', 'BR').listResumes()[0];

  // No ambiente correto, analisa o documento certo com a regra certa.
  const ok = atsService.analyzeResume('gupy', 'BR', gupyBrResume.id, { userId: USER });
  assert.strictEqual(ok.environment, 'gupy/BR');
  assert.strictEqual(ok.resume.name, 'Curriculo Gupy BR');
  assert.strictEqual(ok.analysis.version, 'br-gupy-v1');
  assert.ok(typeof ok.analysis.score === 'number');

  // Pedindo o MESMO número de id por outro ambiente, o resultado nunca é o
  // documento da Gupy BR: ou é o documento local de mesmo id, ou é recusado.
  for (const [p, c] of [['indeed', 'US'], ['gupy', 'US'], ['seasonal', 'US']]) {
    let out = null;
    try { out = atsService.analyzeResume(p, c, gupyBrResume.id, { userId: USER }); }
    catch (e) { assert.match(e.message, new RegExp(`não encontrado em ${p}/${c}`, 'i')); continue; }

    assert.strictEqual(out.environment, `${p}/${c}`);
    assert.notStrictEqual(out.resume.name, 'Curriculo Gupy BR',
      `${p}/${c} analisou um documento da Gupy BR`);
  }

  // Um id que não existe em ambiente nenhum é recusado com mensagem clara.
  assert.throws(
    () => atsService.analyzeResume('indeed', 'BR', 9999, { userId: USER }),
    /não encontrado em indeed\/BR/i
  );
});

test('§1E — o ATS Center de cada ambiente lista apenas os próprios currículos', () => {
  for (const [p, c] of ALL_ENVS) {
    const center = atsService.atsCenter(p, c, USER);
    assert.strictEqual(center.environment, `${p}/${c}`);
    const own = envOf(p, c).listResumes().map(r => r.id).sort();
    assert.deepStrictEqual(center.resumes.map(r => r.id).sort(), own,
      `${p}/${c} deve listar exatamente os próprios currículos`);
  }

  // E o ambiente sem currículo diz isso claramente.
  const vazio = atsService.atsCenter('indeed', 'BR', USER);
  assert.strictEqual(vazio.resumes.length, 0);
  assert.match(vazio.emptyMessage, /não reutiliza currículos de outras plataformas/i);
});

test('§1F — o pacote de regras ATS segue plataforma e país do ambiente', () => {
  assert.strictEqual(atsService.atsCenter('gupy', 'BR', USER).ruleSet.version, 'br-gupy-v1');
  assert.strictEqual(atsService.atsCenter('gupy', 'US', USER).ruleSet.version, 'us-gupy-v1');
  assert.strictEqual(atsService.atsCenter('indeed', 'US', USER).ruleSet.version, 'us-indeed-v1');
  assert.strictEqual(atsService.atsCenter('seasonal', 'US', USER).ruleSet.version, 'us-seasonal-v1');
});

test('§4.3 — Seasonal é US-only e ignora tentativa de outro país', () => {
  const env = candidate.resolveEnv('seasonal', 'BR');
  assert.strictEqual(env.country, 'US', 'Seasonal sempre resolve para US');

  const store = envOf('seasonal', 'BR');
  assert.strictEqual(store.country, 'US');
  assert.strictEqual(store.label, 'seasonal/US');
});

test('ambiente inválido é recusado com mensagem clara', () => {
  assert.throws(() => envOf('linkedin', 'BR'), /Plataforma inválida/);
  assert.throws(() => envOf('gupy', 'FR'), /País inválido/);
  assert.throws(() => envOf('gupy', ''), /País inválido/);
});

test('§1J — documentos herdados exigem atribuição explícita e viram cópia independente', () => {
  // Simula um documento vindo da biblioteca compartilhada da v2.
  const legacyFile = path.join(TMP, 'legacy.txt');
  fs.writeFileSync(legacyFile, 'Currículo herdado\nlegacy@example.invalid\n\nExperience\nPaid media');
  db.prepare(`INSERT INTO core_unassigned_documents
    (legacy_id, name, original_country, career_track, doc_type, filename, original_name,
     file_path, mime_type, file_size, extracted_text, extraction_confidence)
    VALUES (99,'Currículo herdado','BR','paid_media','resume','legacy.txt','legacy.txt',?, 'text/plain', 60, 'Paid media', 'HIGH')`)
    .run(legacyFile);

  const pending = candidate.listUnassignedDocuments();
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].assigned_to, null, 'nada é atribuído automaticamente');

  // Nenhum ambiente recebeu o documento sozinho.
  for (const [p, c] of ALL_ENVS) {
    assert.ok(!envOf(p, c).listResumes().some(r => r.name === 'Currículo herdado'),
      `${p}/${c} não pode ter recebido o documento sem atribuição explícita`);
  }

  // Atribuição explícita cria a cópia em UM ambiente.
  const out = candidate.assignDocument(pending[0].id, 'indeed', 'BR', USER);
  assert.strictEqual(out.environment, 'indeed/BR');
  assert.ok(out.resume);

  assert.ok(envOf('indeed', 'BR').listResumes().some(r => r.name === 'Currículo herdado'));
  assert.ok(!envOf('indeed', 'US').listResumes().some(r => r.name === 'Currículo herdado'),
    'a cópia ficou só no ambiente escolhido');

  // O original continua guardado, agora marcado (§1J.5).
  const after = candidate.listUnassignedDocuments({ includeAssigned: true });
  assert.strictEqual(after.length, 1, 'o registro original não é apagado');
  assert.match(after[0].assigned_to, /indeed\/BR/);

  // A cópia é independente: renomeá-la não altera o original.
  const copy = envOf('indeed', 'BR').listResumes().find(r => r.name === 'Currículo herdado');
  envOf('indeed', 'BR').updateResume(copy.id, { name: 'Renomeado' });
  assert.strictEqual(candidate.listUnassignedDocuments({ includeAssigned: true })[0].name, 'Currículo herdado');
});
