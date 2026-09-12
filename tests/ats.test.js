/**
 * Testes do motor ATS (spec §75).
 *
 * Cobre: seleção de regra por país, separação Brasil × EUA, equivalência
 * semântica, obrigatório × preferencial, afirmações sem lastro, flags de
 * formato, cálculo por componente e persistência da versão da regra.
 */

const test = require('node:test');
const assert = require('node:assert');

const { resolveRuleSet, analyze, buildSuggestions } = require('../core/ats/atsRuleEngine');
const { BASES, EXTENSIONS } = require('../core/ats/rules');
const ontology = require('../core/match/skillOntology');
const {
  classifyOne, evaluateRequirement, evaluateJob, KIND, STATUS
} = require('../core/match/requirementClassifier');
const formatAnalyzer = require('../core/ats/formatAnalyzer');

function extraction(text, extra = {}) {
  return Object.assign({
    text, pages: Math.max(1, Math.ceil(text.length / 3000)),
    confidence: 'HIGH', format: 'docx', hasImages: false, warnings: []
  }, extra);
}

const RESUME_US_GOOD = `
Maria Silva
maria.silva@example.com
+1 (555) 200-3000
Austin, TX

Professional Summary
Performance marketing professional focused on paid acquisition.

Experience
Paid Media Manager — Example Retail — 03/2021 - 09/2025
- Led Google Ads and Meta Ads campaigns across acquisition funnels
- Reduced cost per acquisition by 28% over four quarters
- Built reporting in Looker Studio and GA4

Marketing Analyst — Example Agency — 01/2019 - 02/2021
- Managed campaign budgets and reporting
- Improved conversion rate by 15%

Education
Bachelor of Business Administration — Example University — 2018

Skills
Google Ads, Meta Ads, GA4, Looker Studio, SQL
`.trim();

// ---------------------------------------------------------------------------

test('§8 — seleção do pacote de regras por país e plataforma', () => {
  const cases = [
    ['BR', 'gupy', 'br-gupy-v1', 'br-general-v1'],
    ['US', 'gupy', 'us-gupy-v1', 'us-general-v1'],
    ['BR', 'indeed', 'br-indeed-v1', 'br-general-v1'],
    ['US', 'indeed', 'us-indeed-v1', 'us-general-v1'],
    ['US', 'seasonal', 'us-seasonal-v1', 'us-general-v1'],
    ['BR', null, 'br-general-v1', 'br-general-v1'],
    ['US', null, 'us-general-v1', 'us-general-v1']
  ];

  for (const [country, platform, expectedVersion, expectedBase] of cases) {
    const rs = resolveRuleSet(country, platform);
    assert.strictEqual(rs.version, expectedVersion, `${country}/${platform}`);
    assert.strictEqual(rs.baseId, expectedBase);
    assert.strictEqual(rs.country, country);
  }
});

test('§8 — pesos sempre somam 1 após overrides de plataforma', () => {
  for (const [c, p] of [['BR', 'gupy'], ['US', 'gupy'], ['BR', 'indeed'], ['US', 'indeed'], ['US', 'seasonal'], ['BR', null]]) {
    const rs = resolveRuleSet(c, p);
    const sum = Object.values(rs.weights).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${c}/${p} somou ${sum}`);
  }
});

test('§9 vs §10 — as regras de Brasil e EUA são realmente diferentes', () => {
  const br = resolveRuleSet('BR', null);
  const us = resolveRuleSet('US', null);

  // Foto: aceita no Brasil, contra a convenção nos EUA.
  assert.strictEqual(br.format.allowPhoto, true);
  assert.strictEqual(us.format.allowPhoto, false);

  // Número de páginas esperado difere.
  assert.strictEqual(br.format.maxPages, 3);
  assert.strictEqual(us.format.maxPages, 2);

  // Seções obrigatórias são nomeadas no idioma de cada mercado.
  assert.deepStrictEqual(br.sections.required, ['experiencia', 'formacao', 'competencias']);
  assert.deepStrictEqual(us.sections.required, ['experience', 'education', 'skills']);

  // Regras exclusivas de cada país.
  const brIds = br.conventions.map(c => c.id);
  const usIds = us.conventions.map(c => c.id);
  assert.ok(usIds.includes('us-personal-details'), 'EUA deve sinalizar dados pessoais');
  assert.ok(!brIds.includes('us-personal-details'), 'Brasil não deve aplicar a regra de dados pessoais dos EUA');
  assert.ok(usIds.includes('us-no-achievements'), 'EUA deve cobrar conquistas com métrica');
  assert.ok(!brIds.includes('us-no-achievements'));
});

test('§10 — foto e dados pessoais são penalizados apenas no currículo US', () => {
  const withPhoto = extraction(RESUME_US_GOOD + '\nEstado civil: casado\nData de nascimento: 01/01/1990', { hasImages: true });

  const us = analyze({ extraction: withPhoto, country: 'US', platform: null });
  const br = analyze({ extraction: withPhoto, country: 'BR', platform: null });

  const usPhoto = us.issues.find(i => i.id === 'us-photo');
  const brPhoto = br.issues.find(i => i.id === 'br-photo');

  assert.ok(usPhoto, 'EUA deve emitir issue de foto');
  assert.strictEqual(usPhoto.severity, 'HIGH');
  assert.ok(brPhoto, 'Brasil também sinaliza, porém com severidade menor');
  assert.strictEqual(brPhoto.severity, 'LOW');

  const usPersonal = us.issues.find(i => i.id === 'us-personal-details');
  assert.ok(usPersonal, 'EUA deve sinalizar dados pessoais desnecessários');
  assert.ok(usPersonal.evidence.length > 0, 'a issue deve trazer evidência');
  assert.ok(!br.issues.find(i => i.id === 'us-personal-details'));
});

test('§11 — analisador de formato detecta coluna dupla, tabela e caixa de texto', () => {
  const twoColumn = extraction(
    Array.from({ length: 12 }, (_, i) =>
      `Experiência ${i} na empresa exemplo        Habilidade ${i} em nível avançado`).join('\n')
  );
  const rs = resolveRuleSet('BR', null);
  const signals = formatAnalyzer.analyzeFormat(twoColumn, rs);
  assert.strictEqual(signals.columns, 2, 'deve inferir duas colunas pelos vãos internos');
  assert.ok(signals.columnEvidence, 'deve trazer a evidência do que observou');

  const boxed = analyze({ extraction: extraction(RESUME_US_GOOD, { hasTextBoxes: true }), country: 'US' });
  const issue = boxed.issues.find(i => i.id === 'us-textboxes');
  assert.ok(issue);
  assert.strictEqual(issue.severity, 'CRITICAL');
  assert.strictEqual(boxed.status, 'RISKY', 'issue crítica deve levar o status a RISKY');
});

test('§11 — status do formato reflete a gravidade encontrada', () => {
  const clean = analyze({ extraction: extraction(RESUME_US_GOOD), country: 'US' });
  assert.ok(['EXCELLENT', 'GOOD'].includes(clean.status), `esperava GOOD/EXCELLENT, veio ${clean.status}`);

  const noEmail = analyze({ extraction: extraction(RESUME_US_GOOD.replace('maria.silva@example.com', '')), country: 'US' });
  assert.strictEqual(noEmail.status, 'RISKY', 'sem e-mail extraível o status deve ser RISKY');
});

test('§12 — toda issue traz severidade, motivo, correção e a versão da regra', () => {
  const out = analyze({ extraction: extraction(RESUME_US_GOOD, { hasImages: true }), country: 'US', platform: 'indeed' });
  assert.ok(out.issues.length > 0);
  for (const i of out.issues) {
    assert.ok(i.severity, 'severidade');
    assert.ok(i.why && i.why.length > 20, 'motivo explicado');
    assert.ok(i.correction && i.correction.length > 10, 'correção recomendada');
    assert.strictEqual(i.ruleSetVersion, 'us-indeed-v1', 'versão da regra registrada');
    assert.ok(i.countryRule === 'US');
  }
  // Ordenação por severidade
  const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  for (let i = 1; i < out.issues.length; i++) {
    assert.ok(order[out.issues[i - 1].severity] <= order[out.issues[i].severity], 'issues ordenadas por gravidade');
  }
});

test('§14/§53 — equivalência semântica devolve confiança e nunca conta como exata', () => {
  const exact = ontology.matchRequirement('Google Ads', ['Google Ads']);
  assert.strictEqual(exact.type, 'EXACT');
  assert.strictEqual(exact.weight, 1);

  // Exemplo literal do spec: Performance Marketing ↔ Paid Media
  const semantic = ontology.matchRequirement('Performance Marketing', ['Paid Media']);
  assert.strictEqual(semantic.type, 'SEMANTIC');
  assert.strictEqual(semantic.confidence, 'HIGH');
  assert.ok(semantic.weight < 1, 'equivalente não pode valer o mesmo que literal');

  // Adjacência vale menos ainda
  const adjacent = ontology.matchRequirement('Power BI', ['SQL']);
  assert.strictEqual(adjacent.type, 'SEMANTIC');
  assert.strictEqual(adjacent.confidence, 'MEDIUM');
  assert.ok(adjacent.weight < semantic.weight, 'MEDIUM deve pesar menos que HIGH');

  const none = ontology.matchRequirement('Kubernetes', ['Housekeeping', 'Hospitality']);
  assert.strictEqual(none.type, 'NONE');
  assert.strictEqual(none.weight, 0);
});

test('§53 — equivalência de confiança baixa não vira cobertura plena', () => {
  const { COVERAGE_WEIGHT } = ontology;
  assert.ok(COVERAGE_WEIGHT.LOW < 0.5, 'LOW deve cobrir menos da metade');
  assert.ok(COVERAGE_WEIGHT.MEDIUM < COVERAGE_WEIGHT.HIGH);
  assert.strictEqual(COVERAGE_WEIGHT.EXACT, 1.0);
});

test('§15 — obrigatório, preferencial, contextual e ambíguo são distinguidos', () => {
  assert.strictEqual(classifyOne('Required: 5+ years of paid media experience').kind, KIND.MANDATORY);
  assert.strictEqual(classifyOne('Preferred: experience with Power BI').kind, KIND.PREFERRED);
  assert.strictEqual(classifyOne('Desejável conhecimento em SQL').kind, KIND.PREFERRED);
  assert.strictEqual(classifyOne('Obrigatório: domínio de Google Ads').kind, KIND.MANDATORY);
  assert.strictEqual(classifyOne('3 anos de experiência com React').kind, KIND.CONTEXTUAL);

  // Gate obrigatório é reconhecido mesmo sem a palavra "required"
  const gate = classifyOne('Valid driver license and clean record');
  assert.strictEqual(gate.kind, KIND.MANDATORY);
  assert.strictEqual(gate.hardGate, 'drivers_license');
});

test('§15 — 4.7 anos para requisito de 5+ resulta em revisão contextual, não reprovação', () => {
  const req = classifyOne('Required: 5+ years of paid media experience');
  const near = evaluateRequirement(req, { skills: ['Paid Media'], yearsOfExperience: 4.7 });
  assert.strictEqual(near.status, STATUS.NEAR, 'diferença pequena deve virar NEAR');

  const met = evaluateRequirement(req, { skills: ['Paid Media'], yearsOfExperience: 6 });
  assert.strictEqual(met.status, STATUS.MET);

  const far = evaluateRequirement(req, { skills: ['Paid Media'], yearsOfExperience: 1 });
  assert.strictEqual(far.status, STATUS.NOT_MET);
});

test('§15/§54 — requisito crítico sem informação fica UNRESOLVED, nunca presumido', () => {
  const req = classifyOne("Valid driver's license required");

  const unknown = evaluateRequirement(req, { skills: [], attributes: {} });
  assert.strictEqual(unknown.status, STATUS.UNRESOLVED,
    'sem informação o sistema não pode presumir nem a favor nem contra');
  assert.ok(/não pode presumir/i.test(unknown.explanation));

  const has = evaluateRequirement(req, { skills: [], attributes: { drivers_license: 'CNH categoria E' } });
  assert.strictEqual(has.status, STATUS.MET);
  assert.strictEqual(has.evidence, 'CNH categoria E');

  const hasnt = evaluateRequirement(req, { skills: [], attributes: { drivers_license: false } });
  assert.strictEqual(hasnt.status, STATUS.NOT_MET);
});

test('§16 — falta de preferencial não pesa como falta de obrigatório', () => {
  const job = {
    title: 'Paid Media Manager',
    requirements: [
      'Required: Google Ads campaign management',
      'Required: Meta Ads experience',
      'Preferred: Power BI dashboards',
      'Preferred: experience with TikTok Ads'
    ].join('\n')
  };
  const profile = { skills: ['Google Ads', 'Meta Ads'], yearsOfExperience: 5, attributes: {} };
  const report = evaluateJob(job, profile);

  assert.ok(report.mandatoryCoverage.ratio > 0.9, 'obrigatórios plenamente cobertos');
  assert.ok(report.preferredCoverage.ratio < 0.6, 'preferenciais em falta');
  assert.strictEqual(report.hasBlockingGap, false, 'faltar preferencial não é lacuna bloqueante');
});

test('§13/§54 — sugestão nunca manda afirmar experiência sem lastro no perfil', () => {
  const job = { title: 'Data Analyst', description: 'Build dashboards in Power BI and query with SQL.', requirements: 'Required: Power BI. Required: SQL.' };
  const analysis = analyze({
    extraction: extraction('John Doe\njohn@example.com\n\nExperience\nHousekeeper — Example Resort — 01/2020 - 12/2024\n\nSkills\nHousekeeping'),
    country: 'US', job, candidateSkills: ['Housekeeping']
  });

  const suggestions = buildSuggestions(analysis, {
    job,
    masterProfile: { skills: ['Housekeeping'] }
  });

  const gaps = suggestions.filter(s => s.type === 'GAP');
  assert.ok(gaps.length > 0, 'deve existir ao menos uma lacuna real');
  for (const g of gaps) {
    assert.strictEqual(g.canAssert, false);
    assert.ok(/não inclua/i.test(g.recommendation), 'a recomendação deve desaconselhar afirmar o que não existe');
  }
  for (const s of suggestions.filter(x => x.type === 'REWRITE')) {
    assert.ok(s.basedOn, 'toda sugestão de reescrita precisa citar o fato do perfil que a sustenta');
  }
});

test('§18/§52 — score traz componentes, pesos e versão; pesos renormalizam sem vaga', () => {
  const out = analyze({ extraction: extraction(RESUME_US_GOOD), country: 'US', platform: 'gupy' });

  assert.strictEqual(out.version, 'us-gupy-v1');
  assert.ok(typeof out.score === 'number' && out.score >= 0 && out.score <= 100);
  assert.ok(out.components.resume_parsing_quality !== undefined);
  assert.strictEqual(out.components.keyword_coverage, null, 'sem vaga, cobertura de termos não é avaliável');

  const activeWeights = Object.values(out.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(activeWeights - 1) < 1e-6, `pesos ativos devem somar 1, somaram ${activeWeights}`);
  assert.ok(out.weights.keyword_coverage === undefined, 'componente nulo não deve receber peso');
});

test('§7 — nenhuma saída promete aprovação ou probabilidade de contratação', () => {
  const out = analyze({ extraction: extraction(RESUME_US_GOOD), country: 'US' });
  assert.ok(out.disclaimer, 'o aviso é obrigatório');
  assert.ok(/não.*prev/i.test(out.disclaimer) || /não é uma previsão/i.test(out.disclaimer));

  const forbidden = /probabilidade de (aprova|contrata)|vai passar|garante/i;
  assert.ok(!forbidden.test(JSON.stringify(out.issues)), 'issues não podem prometer aprovação');
  assert.ok(!forbidden.test(out.disclaimer.replace(/não[^.]*/gi, '')));
});

test('§55 — o pacote de regras é versionado e todos estão registrados', () => {
  const ids = Object.keys(BASES).concat(Object.keys(EXTENSIONS));
  for (const id of ids) {
    assert.ok(/^(br|us)-[a-z]+-v\d+$/.test(id), `id versionado inválido: ${id}`);
  }
  for (const key of Object.keys(EXTENSIONS)) {
    assert.ok(BASES[EXTENSIONS[key].extends], `extensão ${key} aponta para base inexistente`);
  }
});

test('§16 do build prompt — extração de baixa confiança rebaixa o resultado e avisa', () => {
  const bad = extraction('texto curto', { confidence: 'LOW', warnings: ['PDF possivelmente digitalizado.'] });
  const out = analyze({ extraction: bad, country: 'BR' });

  assert.strictEqual(out.status, 'RISKY');
  assert.strictEqual(out.confidence, 'LOW');
  assert.ok(out.warnings.length >= 1, 'deve avisar que a análise tem confiança reduzida');
  assert.ok(out.warnings.some(w => /confiança reduzida/i.test(w)));
});
