#!/usr/bin/env node
/**
 * Primeiro login nos provedores que só têm listagem por navegador.
 *
 *   npm run browser:login -- gupy
 *   npm run browser:login -- indeed br
 *
 * Abre uma janela VISÍVEL do Chrome no perfil que o robô usa. Você entra na
 * sua conta com as suas mãos — este script não digita, não lê e não guarda
 * credencial nenhuma. Quando você termina, a sessão fica gravada no perfil em
 * disco e as buscas seguintes podem rodar sem janela, inclusive no VPS.
 *
 * IMPORTANTE, e verificado na prática: a BUSCA funciona sem login nenhum nos
 * dois sites. O login não é pré-requisito para o robô achar vaga — ele serve
 * para resultados personalizados e para você concluir a candidatura sem ter
 * que entrar na hora. Se a busca já está trazendo vagas, isto aqui é opcional.
 */

require('dotenv').config();

const readline = require('readline');
const { BrowserAdapter, SITE_PROFILES, findChrome } = require('../services/adapters/browserAdapter');

const LOGIN_URL = {
  gupy: () => 'https://portal.gupy.io/signin',
  indeed: (country) => country === 'BR'
    ? 'https://secure.indeed.com/account/login?hl=pt_BR&co=BR'
    : 'https://secure.indeed.com/account/login'
};

/** Sinais de que a sessão está ativa. Vários por site: o HTML muda. */
const LOGGED_IN_HINTS = {
  gupy: ['[data-testid="user-menu"]', 'a[href*="/candidates"]', 'button[aria-label*="perfil" i]', 'img[alt*="avatar" i]'],
  indeed: ['[data-gnav-element-name="AccountMenu"]', '#gnav-AccountMenu', 'a[href*="/myjobs"]', '[data-testid="AccountMenu"]']
};

const provider = String(process.argv[2] || '').toLowerCase();
const country = String(process.argv[3] || 'BR').toUpperCase();

if (!SITE_PROFILES[provider]) {
  console.error(`\nProvedor inválido: "${provider || '(vazio)'}"`);
  console.error('Use: npm run browser:login -- gupy      (ou indeed)\n');
  process.exit(1);
}

const site = SITE_PROFILES[provider];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('\nNenhum Chrome ou Edge encontrado. Instale o Google Chrome, ou defina CHROME_PATH no .env\n');
    process.exit(1);
  }

  const adapter = new BrowserAdapter({ provider, country, headless: false });

  console.log('');
  console.log('='.repeat(74));
  console.log(`  LOGIN NO ${site.label.toUpperCase()}${provider === 'indeed' ? ` — ${country}` : ''}`);
  console.log('='.repeat(74));
  console.log('');
  console.log(`  Navegador : ${chrome}`);
  console.log(`  Perfil    : ${adapter.profileDir()}`);
  console.log('');
  console.log('  Uma janela do Chrome vai abrir. Entre na sua conta normalmente.');
  console.log('  Este script não digita nada e não vê a sua senha.');
  console.log('');
  console.log('  Quando eu detectar o menu da sua conta, salvo a sessão e fecho sozinho.');
  console.log('  Se quiser parar antes, feche a janela.');
  console.log('');

  await adapter.launch();

  const url = LOGIN_URL[provider](country);
  await adapter.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    .catch(e => console.log(`  (aviso ao abrir a página: ${e.message})`));

  console.log(`  Aberto: ${url}`);
  console.log('  Aguardando o login…');
  console.log('');

  const hints = LOGGED_IN_HINTS[provider] || [];
  const deadline = Date.now() + 10 * 60 * 1000;   // 10 minutos, com folga
  let loggedIn = false;
  let browserClosed = false;

  adapter.browser.on('disconnected', () => { browserClosed = true; });

  // Só sinal POSITIVO conta. A versão anterior também aceitava "a URL não
  // parece de login", e isso dava falso positivo em segundos — anunciava
  // sessão salva sem ninguém ter entrado. Um relatório errado é pior que
  // nenhum: o usuário levaria a suposição para o VPS e descobriria lá.
  while (Date.now() < deadline && !browserClosed) {
    await sleep(3000);
    if (browserClosed) break;

    try {
      for (const sel of hints) {
        const found = await adapter.page.$(sel).catch(() => null);
        if (found) { loggedIn = true; break; }
      }
      if (loggedIn) break;
    } catch (e) { /* página navegando; tenta de novo */ }
  }

  if (loggedIn) {
    // Um instante para o Chrome gravar cookies e storage em disco.
    await sleep(2500);
    console.log('  ' + '-'.repeat(70));
    console.log(`  SESSÃO SALVA — o robô já pode buscar no ${site.label} sem abrir janela.`);
    console.log('  ' + '-'.repeat(70));
  } else if (browserClosed) {
    console.log('  Janela fechada antes da confirmação.');
    console.log('  Se você chegou a entrar, a sessão provavelmente foi salva mesmo assim —');
    console.log(`  rode "npm run browser:check -- ${provider}" para conferir.`);
  } else {
    console.log('  Tempo esgotado sem detectar o login.');
    console.log('  Isso também acontece quando o site muda o menu da conta — nesse caso');
    console.log('  a sessão pode estar válida. Confira com "npm run browser:check".');
  }

  console.log('');
  await adapter.close();
}

main().catch(err => {
  console.error('\nFalhou:', err.userMessage || err.message, '\n');
  process.exit(1);
});
