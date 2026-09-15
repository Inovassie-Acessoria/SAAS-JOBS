#!/usr/bin/env node
/**
 * Importa a base de divulgação do DOL (JSON) no acervo, com curadoria.
 *
 *   node scripts/importDisclosure.js caminho/vagas_h2b_certificadas.json
 *   node scripts/importDisclosure.js arquivo.json --no-enrich   (sem consultar o índice do DOL)
 *
 * Usa o mesmo banco do servidor (DATA_DIR / DB_PATH do .env). Pode rodar com o
 * servidor no ar: a gravação é uma transação só, curta.
 */
require('dotenv').config();
const path = require('path');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) {
  console.error('Uso: node scripts/importDisclosure.js <arquivo.json> [--no-enrich]');
  process.exit(2);
}
const enrich = !args.includes('--no-enrich');

(async () => {
  const svc = require('../services/disclosureImportService');
  let lastPhase = null;
  const report = await svc.run({
    file: path.resolve(file), enrich, userId: 1,
    onProgress: (p) => {
      if (p.phase !== lastPhase) { lastPhase = p.phase; process.stdout.write(`\n${p.phase}`); }
      if (p.total) process.stdout.write(`\r${p.phase}: ${p.done}/${p.total}      `);
    }
  });
  console.log('\n');
  console.log(`Linhas lidas:            ${report.received}`);
  console.log(`Aproveitáveis:           ${report.usable}  (ignoradas: ${JSON.stringify(report.skipped)})`);
  console.log(`Cards após curadoria:    ${report.cards}  (${report.mergedRows} pedido(s) dobrados em ${report.mergedGroups} grupo(s))`);
  console.log(`Índice do DOL:           ${report.enriched.attempted ? `${report.enriched.found} encontrados, ${report.enriched.withDuties} com descrição` : 'não consultado'}${report.enriched.error ? ' — ' + report.enriched.error : ''}`);
  console.log(`Com e-mail:              ${report.withEmail}   só site: ${report.websiteOnly}   sem contato: ${report.noContact}`);
  console.log(`Ocultas (já nas atuais): ${report.hiddenByCurrent}`);
  console.log(`Gravadas: ${report.stored}   novas: ${report.newJobs}   analisadas: ${report.analyzed}   filtradas pelo perfil: ${report.filteredOut}`);
  console.log(`Tempo: ${(report.durationMs / 1000).toFixed(1)} s`);
  if (report.errors.length) console.log('Erros:', JSON.stringify(report.errors, null, 1));
})().catch(e => { console.error('\nFalhou:', e.message); process.exit(1); });
