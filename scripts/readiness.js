#!/usr/bin/env node
/**
 * Varredura de prontidão pela linha de comando.
 *
 *   npm run readiness           relatório em texto
 *   npm run readiness -- --json saída JSON, para CI ou monitoramento
 *
 * Código de saída 1 quando há bloqueador — assim a varredura serve de gate de
 * deploy: o container não é promovido enquanto faltar o essencial.
 */

// Sem isto a varredura lê um ambiente vazio e acusa como ausente tudo que já
// está configurado no .env — um relatório errado é pior que nenhum.
require('dotenv').config();

const readiness = require('../services/readinessService');

const asJson = process.argv.includes('--json');
const report = readiness.check({ userId: 1 });

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(readiness.toText(report));
}

process.exit(report.blockers.length ? 1 : 0);
