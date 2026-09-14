#!/usr/bin/env node
/**
 * Prepara o arquivo de ambiente do servidor e diz exatamente o que fazer.
 *
 *   npm run deploy:prepare -- vagas.seudominio.com.br
 *
 * Gera `.env.production` com uma chave de criptografia NOVA e as URLs já
 * apontando para o seu domínio. O arquivo não vai para o repositório nem para
 * a imagem Docker — ele é copiado para o VPS por fora, uma vez.
 *
 * Por que uma chave nova, e não a da sua máquina: a chave local nunca cifrou
 * nada que vá para o servidor, e chave que circula por e-mail ou chat deixa de
 * ser segredo. A autorização do Gmail é feita no próprio servidor, depois.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const secretBox = require('../core/security/secretBox');

const domain = String(process.argv[2] || '').trim()
  .replace(/^https?:\/\//, '').replace(/\/+$/, '');

if (!domain) {
  console.error('');
  console.error('  Informe o domínio que vai apontar para o VPS:');
  console.error('');
  console.error('      npm run deploy:prepare -- vagas.seudominio.com.br');
  console.error('');
  console.error('  O domínio precisa ter um registro A apontando para o IP do VPS ANTES');
  console.error('  de subir — é assim que o Caddy consegue emitir o certificado HTTPS.');
  console.error('');
  process.exit(1);
}

if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
  console.error(`\n  "${domain}" não parece um domínio válido.\n`);
  process.exit(1);
}

const outPath = path.join(__dirname, '..', '.env.production');

if (fs.existsSync(outPath)) {
  console.error('');
  console.error(`  ${outPath} já existe.`);
  console.error('  Apague-o manualmente se quiser gerar outro — sobrescrever trocaria a');
  console.error('  chave de criptografia e invalidaria a autorização do Gmail já feita.');
  console.error('');
  process.exit(1);
}

const base = `https://${domain}`;
const key = secretBox.generateKey();

const content = `# Ambiente de PRODUÇÃO — ${domain}
# Gerado por "npm run deploy:prepare" em ${new Date().toISOString()}
#
# Este arquivo contém segredos. Ele não entra no Git nem na imagem Docker.
# Copie-o para o VPS como .env, ao lado do docker-compose.yml.

# --- Identidade do servidor --------------------------------------------------
APP_ENV=production
NODE_ENV=production
PORT=3000
APP_BASE_URL=${base}

# Endereço público lido pelo Caddy. Vazio = HTTP na porta 80.
DOMAIN=${domain}

# --- Chave de criptografia dos segredos --------------------------------------
# GUARDE UMA CÓPIA EM LUGAR SEGURO.
# Perder esta chave significa reautorizar o Gmail do zero. Trocá-la depois de
# conectar a conta invalida o token já gravado.
APP_ENCRYPTION_KEY=${key}

# --- Banco -------------------------------------------------------------------
# Caminho dentro do container; o volume app-data o mantém entre reinícios.
DB_PATH=/app/data/h2a_system.db

# --- Google / Gmail ----------------------------------------------------------
# Estas DUAS URIs precisam estar cadastradas no mesmo OAuth Client, no
# Google Cloud Console. Um endereço diferente produz redirect_uri_mismatch.
#
#   ${base}/api/seasonal/gmail/callback
#   ${base}/api/auth/google/callback
#
# Client ID e Secret podem ficar aqui OU ser preenchidos pela tela de Ajustes
# depois que o sistema subir. Pela tela é mais simples e o segredo fica cifrado.
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
# As URIs de retorno são DERIVADAS de APP_BASE_URL — não as fixe aqui. Trocou
# de domínio? Rode "npm run domain -- <novo-dominio>" e reinicie.
# GOOGLE_REDIRECT_URI=${base}/api/seasonal/gmail/callback
# GOOGLE_SIGNIN_REDIRECT_URI=${base}/api/auth/google/callback

# Origem permitida para o navegador (mesmo domínio do app).
CORS_ORIGIN=${base}

# --- Descoberta de vagas -----------------------------------------------------
# Gupy: MCP oficial, sem token e sem navegador.
GUPY_MCP_URL=https://candidates.mcp.api.gupy.io/mcp

# Seasonal: feed oficial do DOL.
SEASONAL_FEED_BASE_URL=https://api.seasonaljobs.dol.gov

# Indeed: sem API pública para backend próprio; usa navegador.
INDEED_BROWSER_DISCOVERY=true

# --- Navegador ---------------------------------------------------------------
# No servidor não há tela nem Chrome pessoal: sempre invisível e perfil próprio.
CHROME_PATH=/usr/bin/chromium-browser
BROWSER_HEADLESS=true
BROWSER_NO_SANDBOX=true
CHROME_PROFILE_MODE=dedicated
BROWSER_MAX_PAGES=3

# --- Sessão ------------------------------------------------------------------
SESSION_COOKIE_SECURE=true
SESSION_TTL_SECONDS=2592000

# --- Fuso da virada da cota diária de e-mails --------------------------------
APPLICATION_TIMEZONE=America/Sao_Paulo
`;

fs.writeFileSync(outPath, content, { mode: 0o600 });

const line = (s = '') => console.log('  ' + s);

console.log('');
console.log('='.repeat(78));
console.log('  ARQUIVO DE PRODUÇÃO GERADO');
console.log('='.repeat(78));
console.log('');
line(`Arquivo  : ${outPath}`);
line(`Domínio  : ${base}`);
line(`Chave    : gerada agora (${key.length} caracteres, base64)`);
console.log('');
line('-'.repeat(74));
line('ANTES DE SUBIR — no Google Cloud Console, cadastre as DUAS URIs:');
line('');
line(`   ${base}/api/seasonal/gmail/callback`);
line(`   ${base}/api/auth/google/callback`);
line('-'.repeat(74));
console.log('');
line('NO SEU DNS — aponte o domínio para o IP do VPS antes de subir:');
line('');
line(`   Tipo A   ${domain}   ->   <IP do seu VPS>`);
line('');
line('Sem isso o Caddy não consegue emitir o certificado e o site não abre em HTTPS.');
console.log('');
line('-'.repeat(74));
line('NO VPS — depois de enviar o código:');
line('');
line('   # 1. o arquivo de ambiente vai como .env');
line('   scp .env.production usuario@IP:/opt/jobintel/.env');
line('');
line('   # 2. no servidor');
line('   cd /opt/jobintel');
line('   docker compose up -d --build');
line('');
line('   # 3. conferir que subiu');
line('   docker compose ps');
line('   docker compose logs -f api');
line('');
line('   # 4. a varredura, de dentro do container');
line('   docker compose exec api npm run readiness');
line('-'.repeat(78));
console.log('');
line('DEPOIS, pelo navegador, em ' + base + ' :');
line('   1. Ajustes do Seasonal  -> criar/colar o cliente OAuth do Google');
line('   2. Entrar com o Google  -> autorizar o envio pelo Gmail');
line('   3. Perfil e currículo   -> preencher, por ambiente');
line('   4. Central de Robôs     -> LIGAR o agendador');
console.log('');
line('O passo 4 é o que faz o sistema trabalhar com o seu computador desligado.');
line('Sem ele tudo funciona, mas só quando você pede.');
console.log('');
