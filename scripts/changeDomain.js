#!/usr/bin/env node
/**
 * Troca o domínio público do sistema em UM lugar.
 *
 *   node scripts/changeDomain.js saas.inovassie.com.br
 *   node scripts/changeDomain.js saas.inovassie.com.br --file .env.production
 *   node scripts/changeDomain.js saas.inovassie.com.br --dry-run
 *
 * O que ele faz: reescreve, no arquivo de ambiente, TODAS as variáveis que
 * carregam o domínio — APP_BASE_URL, DOMAIN, CORS_ORIGIN, GOOGLE_REDIRECT_URI,
 * GOOGLE_SIGNIN_REDIRECT_URI e GOOGLE_AUTH_REDIRECT_URI — e nada mais. Segredos,
 * chaves e o resto do arquivo ficam intactos, byte a byte.
 *
 * Por que existe: quem troca de domínio muda APP_BASE_URL e esquece as outras.
 * O Google então recebe um redirect_uri do domínio antigo e responde
 * "redirect_uri_mismatch". Este script fecha essa porta.
 *
 * Depois de rodar: reinicie o servidor e cadastre as duas URIs impressas no
 * OAuth Client do Google Cloud Console.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const domainArg = args.find(a => !a.startsWith('--')) || '';
const dryRun = args.includes('--dry-run');
const fileArg = (() => { const i = args.indexOf('--file'); return i >= 0 ? args[i + 1] : null; })();

const domain = domainArg.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();

/** Domínio raiz para a lista de "domínios autorizados": trata com.br, co.uk etc. */
function rootDomain(host) {
  const parts = host.replace(/:[0-9]+$/, '').split('.');
  const secondLevel = /^(com|net|org|gov|edu|co)$/i.test(parts[parts.length - 2] || '') && (parts[parts.length - 1] || '').length === 2;
  return parts.slice(secondLevel ? -3 : -2).join('.');
}

function fail(msg) { console.error(`\n  ${msg}\n`); process.exit(1); }

if (!domain) fail('Uso: node scripts/changeDomain.js <dominio>   (ex.: saas.inovassie.com.br)');
if (!/^[a-z0-9.-]+\.[a-z]{2,}(:[0-9]+)?$/i.test(domain) && !/^localhost(:[0-9]+)?$/.test(domain)) {
  fail(`"${domain}" não parece um domínio válido. Informe só o host, sem https:// e sem barra.`);
}

const isLocal = /^localhost/.test(domain);
const base = `${isLocal ? 'http' : 'https'}://${domain}`;

const candidates = fileArg ? [fileArg] : ['.env', '.env.production'];
const envPath = candidates.map(f => path.resolve(process.cwd(), f)).find(f => fs.existsSync(f));
if (!envPath) fail(`Nenhum arquivo de ambiente encontrado (${candidates.join(', ')}). Use --file <caminho>.`);

const NEW_VALUES = {
  APP_BASE_URL: base,
  DOMAIN: isLocal ? '' : domain,
  CORS_ORIGIN: base,
  GOOGLE_REDIRECT_URI: `${base}/api/seasonal/gmail/callback`,
  GOOGLE_SIGNIN_REDIRECT_URI: `${base}/api/auth/google/callback`,
  GOOGLE_AUTH_REDIRECT_URI: `${base}/api/auth/google/callback`
};

const original = fs.readFileSync(envPath, 'utf8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
const lines = original.split(/\r?\n/);
const changes = [];
const seen = new Set();

const out = lines.map(line => {
  const m = line.match(/^\s*(#\s*)?([A-Z0-9_]+)\s*=(.*)$/);
  if (!m) return line;
  const [, commented, key, rawValue] = m;
  if (!(key in NEW_VALUES)) return line;
  // Só toca a primeira ocorrência ATIVA; uma linha comentada com a mesma chave
  // fica como está (é documentação, não configuração).
  if (commented || seen.has(key)) return line;
  seen.add(key);
  const oldValue = rawValue.trim();
  const newValue = NEW_VALUES[key];
  if (oldValue === newValue) return line;
  changes.push({ key, oldValue, newValue });
  return `${key}=${newValue}`;
});

// Variáveis ausentes que precisam existir para o domínio valer em todo lugar.
const insertAt = out.length && out[out.length - 1] === '' ? out.length - 1 : out.length;
for (const key of ['APP_BASE_URL', 'CORS_ORIGIN']) {
  if (!seen.has(key)) { out.splice(insertAt, 0, `${key}=${NEW_VALUES[key]}`); changes.push({ key, oldValue: '(ausente)', newValue: NEW_VALUES[key] }); }
}

console.log(`\n  Arquivo: ${envPath}`);
console.log(`  Domínio: ${base}\n`);
if (!changes.length) {
  console.log('  Nada a mudar — o arquivo já aponta para este domínio.\n');
} else {
  for (const c of changes) console.log(`  ${c.key.padEnd(28)} ${c.oldValue || '(vazio)'}  ->  ${c.newValue || '(vazio)'}`);
  console.log('');
  if (dryRun) {
    console.log('  (--dry-run: nada foi gravado)\n');
  } else {
    fs.writeFileSync(envPath, out.join(eol), 'utf8');
    console.log('  Gravado.\n');
  }
}

console.log('  Próximos passos:');
console.log('   1. Reinicie o servidor (o .env só é lido no boot).');
console.log('   2. Google Cloud Console -> APIs e serviços -> Credenciais -> seu OAuth Client:');
console.log('      "URIs de redirecionamento autorizados" precisa conter EXATAMENTE:');
console.log(`        ${NEW_VALUES.GOOGLE_REDIRECT_URI}`);
console.log(`        ${NEW_VALUES.GOOGLE_SIGNIN_REDIRECT_URI}`);
console.log(`      "Origens JavaScript autorizadas": ${base}`);
console.log('   3. Tela de consentimento OAuth -> "Domínios autorizados": o domínio raiz');
console.log(`      (${rootDomain(domain)}) e a página inicial ${base}/.`);
if (!isLocal) {
  console.log('   4. Se as variáveis também estiverem no painel da hospedagem (hPanel/Docker),');
  console.log('      elas MANDAM sobre o .env — atualize lá também.');
}
console.log('');
