#!/usr/bin/env node
/**
 * Confere se a sessão salva ainda vale, sem abrir janela.
 *
 *   npm run browser:check              todos os provedores
 *   npm run browser:check -- gupy      só um
 *
 * É o teste que importa antes de subir para o VPS: lá não há tela, então a
 * busca só funciona se a sessão gravada em disco continuar autenticada.
 */

require('dotenv').config();

const { BrowserAdapter, SITE_PROFILES } = require('../services/adapters/browserAdapter');

const only = String(process.argv[2] || '').toLowerCase();
const targets = only && SITE_PROFILES[only]
  ? [[only, 'BR']]
  : [['gupy', 'BR'], ['indeed', 'BR']];

async function check(provider, country) {
  const adapter = new BrowserAdapter({ provider, country });
  const site = SITE_PROFILES[provider];

  console.log('');
  console.log(`  ${site.label} (${country})`);
  console.log('  ' + '-'.repeat(60));

  const diag = await adapter.testConnection();
  for (const s of diag.steps) {
    console.log(`   ${s.ok ? 'OK   ' : 'FALTA'} ${s.label} — ${s.detail}`);
  }

  if (!diag.success) return { provider, ok: false, reason: 'ambiente incompleto' };

  // Prova real: busca headless de uma página, sem janela.
  console.log('   ...   buscando 1 página sem janela, para valer');
  const probe = new BrowserAdapter({ provider, country, headless: true, maxPages: 1, delayMs: 0 });

  try {
    const r = await probe.searchJobs({ keywords: 'motorista', country, location: '' });
    const n = r.jobs.length;
    if (n > 0) {
      console.log(`   OK    ${n} vaga(s) lida(s) sem janela — pronto para o VPS`);
      console.log(`         exemplo: "${(r.jobs[0].title || '').slice(0, 60)}" — ${(r.jobs[0].company || '?').slice(0, 40)}`);
      return { provider, ok: true, jobs: n };
    }
    console.log('   AVISO zero vagas lidas.');
    (r.warnings || []).forEach(w => console.log(`         ${w}`));
    return { provider, ok: false, reason: 'zero resultados' };
  } catch (e) {
    console.log(`   FALHA ${e.userMessage || e.message}`);
    return { provider, ok: false, reason: e.userMessage || e.message };
  }
}

(async () => {
  console.log('');
  console.log('='.repeat(70));
  console.log('  SESSÕES DE NAVEGADOR — a busca funciona sem tela?');
  console.log('='.repeat(70));

  const results = [];
  for (const [p, c] of targets) results.push(await check(p, c));

  console.log('');
  console.log('='.repeat(70));
  const ok = results.filter(r => r.ok);
  console.log(`  ${ok.length} de ${results.length} pronto(s) para rodar sem janela.`);
  for (const r of results.filter(x => !x.ok)) {
    console.log(`  ${r.provider}: ${r.reason} — rode "npm run browser:login -- ${r.provider}"`);
  }
  console.log('');

  process.exit(ok.length === results.length ? 0 : 1);
})().catch(e => { console.error('\nFalhou:', e.message, '\n'); process.exit(1); });
