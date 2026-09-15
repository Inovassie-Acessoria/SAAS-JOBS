#!/usr/bin/env node
/**
 * Backup do banco, seguro com a aplicação rodando.
 *
 *   npm run backup                    grava em BACKUP_DIR (padrão: ./data/backups)
 *   npm run backup -- /caminho/destino
 *
 * No VPS, com o Docker:
 *   docker compose exec api npm run backup
 *   docker cp $(docker compose ps -q api):/app/data/backups ./backups-local
 *
 * Usa `VACUUM INTO`, que produz um arquivo íntegro mesmo com escritas
 * acontecendo — diferente de copiar o .db com `cp`, que pode capturar um
 * estado inconsistente por causa do WAL.
 *
 * O que se perde sem backup, na ordem em que dói:
 *   1. a autorização do Gmail  — reautorizar é rápido, mas é manual
 *   2. o perfil e os currículos — retrabalho de verdade
 *   3. o histórico de candidaturas enviadas — é ele que impede envio duplicado
 *   4. as vagas e análises — recuperáveis, o robô importa de novo
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { db, backupDir } = require('../config/database');

const KEEP = parseInt(process.env.BACKUP_KEEP || '14', 10);

const destDir = process.argv[2] || backupDir;
if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(destDir, `h2a-${stamp}.db`);

console.log('');
console.log('  Backup do banco');
console.log('  ' + '-'.repeat(60));

try {
  // VACUUM INTO exige que o destino não exista.
  // Aspas SIMPLES: com aspas duplas o SQLite lê o caminho como nome de coluna.
  const literal = `'${target.replace(/'/g, "''")}'`;
  db.exec(`VACUUM INTO ${literal}`);
} catch (e) {
  console.error(`  FALHOU: ${e.message}`);
  console.error('');
  process.exit(1);
}

const size = fs.statSync(target).size;
console.log(`  Arquivo : ${target}`);
console.log(`  Tamanho : ${(size / 1024 / 1024).toFixed(2)} MB`);

// Um backup que não pode ser lido não é um backup: confere antes de anunciar.
try {
  const { DatabaseSync } = require('node:sqlite');
  const check = new DatabaseSync(target, { readOnly: true });
  const jobs = ['gupy_jobs', 'indeed_jobs', 'seasonal_jobs'].reduce((acc, t) => {
    try { return acc + check.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch (e) { return acc; }
  }, 0);
  let sent = 0;
  try { sent = check.prepare('SELECT COUNT(*) c FROM seasonal_applications').get().c; } catch (e) {}
  check.close();
  console.log(`  Conteúdo: ${jobs} vaga(s), ${sent} candidatura(s) enviada(s)`);
  console.log('  Íntegro : sim — o arquivo abre e responde a consultas');
} catch (e) {
  console.error(`  ATENÇÃO : o arquivo foi gravado mas não pôde ser lido de volta — ${e.message}`);
  process.exit(1);
}

// Rotação: mantém os N mais recentes.
const existing = fs.readdirSync(destDir)
  .filter(f => /^h2a-.*\.db$/.test(f))
  .sort()
  .reverse();

const excess = existing.slice(KEEP);
for (const f of excess) {
  try { fs.unlinkSync(path.join(destDir, f)); } catch (e) { /* segue */ }
}

console.log(`  Guardados: ${Math.min(existing.length, KEEP)} (limite ${KEEP})`);
if (excess.length) console.log(`  Removidos: ${excess.length} mais antigo(s)`);

console.log('');
console.log('  Lembrete: um backup que mora no mesmo servidor não protege contra');
console.log('  a perda do servidor. Copie para fora periodicamente.');
console.log('');
