#!/usr/bin/env node
/**
 * Mostra os perfis do Chrome desta máquina e como apontar o robô para um deles.
 *
 *   npm run browser:profiles
 *
 * O nome de diretório ("Profile 30") não diz nada; a conta diz. Este script
 * junta os dois, para você escolher pelo e-mail e não por adivinhação.
 */

require('dotenv').config();

const {
  listChromeProfiles, defaultChromeUserDataDir, chromeIsRunning, PROFILE_ROOT
} = require('../services/adapters/browserAdapter');

const userDataDir = defaultChromeUserDataDir();
const profiles = listChromeProfiles(userDataDir);
const mode = (process.env.CHROME_PROFILE_MODE || 'dedicated').toLowerCase();
const chosen = process.env.CHROME_PROFILE_DIRECTORY || null;

console.log('');
console.log('='.repeat(78));
console.log('  PERFIS DO CHROME');
console.log('='.repeat(78));
console.log('');
console.log(`  Pasta de perfis : ${userDataDir || '(não encontrada)'}`);
console.log(`  Chrome aberto   : ${chromeIsRunning() ? 'SIM' : 'não'}`);
console.log('');

if (!profiles.length) {
  console.log('  Nenhum perfil encontrado. Se o Chrome está instalado em outro lugar,');
  console.log('  informe CHROME_USER_DATA_DIR no arquivo .env.');
  console.log('');
  process.exit(0);
}

console.log('  ' + 'diretório'.padEnd(14) + 'conta'.padEnd(38) + 'apelido');
console.log('  ' + '-'.repeat(74));
for (const p of profiles) {
  const marker = chosen === p.directory ? '>' : ' ';
  console.log(`${marker} ` + p.directory.padEnd(14) +
              String(p.account || '(sem conta Google)').padEnd(38) +
              (p.label || ''));
}

console.log('');
console.log('-'.repeat(78));
console.log(`  MODO ATUAL: ${mode === 'system' ? 'SISTEMA — usando o seu Chrome' : 'DEDICADO — perfil próprio do robô'}`);
if (mode === 'system') console.log(`  Perfil escolhido: ${chosen || 'Default'}`);
else console.log(`  Perfil do robô: ${PROFILE_ROOT}`);
console.log('-'.repeat(78));
console.log('');
console.log('  Para usar um perfil SEU, acrescente ao .env:');
console.log('');
console.log('      CHROME_PROFILE_MODE=system');
console.log(`      CHROME_PROFILE_DIRECTORY=${(profiles[0] || {}).directory || 'Default'}`);
console.log('');
console.log('  Três coisas a saber antes de escolher esse modo:');
console.log('');
console.log('   1. O Chrome precisa estar TOTALMENTE fechado enquanto o robô roda.');
console.log('      Ele trava o perfil em uso — inclusive com janela minimizada na bandeja.');
console.log('');
console.log('   2. O robô passa a enxergar tudo que esse perfil tem logado:');
console.log('      e-mail, banco, redes. O perfil dedicado não tem esse alcance.');
console.log('');
console.log('   3. Este perfil existe só NESTA máquina. No VPS ele não existe —');
console.log('      então o modo sistema não sobrevive à mudança para o servidor.');
console.log('');
console.log('  Para voltar ao padrão: CHROME_PROFILE_MODE=dedicated');
console.log('');
