/**
 * Descoberta de vagas por navegador (spec de agentes §45, §46).
 *
 * POR QUE ISTO EXISTE
 * -------------------
 * A §45 manda preferir MCP, API e feeds estruturados. Ela está certa, e o
 * Seasonal segue esse caminho com o feed do DOL. Mas Gupy e Indeed não
 * publicam endpoint que este backend possa consumir: os quatro ambientes ficam
 * sem URL nenhuma e a descoberta real desses dois produtos simplesmente não
 * acontece. Preferir a API não ajuda quando a API não existe.
 *
 * A §46 já autoriza um Browser Agent para "abrir a URL da vaga, navegar até a
 * página do provedor e preparar a informação visível". É exatamente esse o
 * papel aqui: LER listagens públicas. Nada além disso.
 *
 * O QUE ESTE MÓDULO NÃO FAZ
 * -------------------------
 * Não preenche formulário de candidatura, não clica em "Candidatar-se" e não
 * submete nada. Essa fronteira não é uma convenção: o Policy Gate nega
 * BROWSER_SUBMIT para todos os provedores, e o método correspondente aqui
 * lança erro em vez de existir.
 *
 * Não pede, não lê e não guarda a sua senha. O login é feito por você, na
 * janela visível, com as suas mãos. A sessão sobrevive entre execuções porque
 * o Chrome grava o perfil em disco — o mesmo mecanismo que mantém você logado
 * no navegador do dia a dia.
 *
 * EDUCAÇÃO DE ACESSO
 * ------------------
 * Uma página por vez, com pausa entre elas, e um teto de páginas por execução.
 * Isto é uma busca de emprego pessoal, com o volume de uma pessoa — não um
 * raspador de catálogo.
 */

const fs = require('fs');
const path = require('path');
const { HEALTH, IntegrationError } = require('./mcpClient');

const VERSION = 'browser-discovery-v1';

/** Pausa entre navegações, em ms. Deliberadamente folgada. */
const DEFAULT_DELAY_MS = 2500;
/** Teto de páginas de resultado por execução. */
const DEFAULT_MAX_PAGES = 3;
/** Tempo máximo esperando a listagem aparecer. */
const SELECTOR_TIMEOUT_MS = 20000;
/** Tempo que a janela fica aberta esperando você fazer login. */
const LOGIN_WAIT_MS = 180000;

const PROFILE_ROOT = path.join(__dirname, '..', '..', 'private_uploads', '.secrets', 'browser');

// ---------------------------------------------------------------------------
// Localizar o Chrome instalado
// ---------------------------------------------------------------------------

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (e) { /* segue */ }
  }
  return null;
}

/** Onde o Chrome guarda os perfis do usuário, por sistema operacional. */
function defaultChromeUserDataDir() {
  if (process.env.CHROME_USER_DATA_DIR) return process.env.CHROME_USER_DATA_DIR;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!home) return null;
  if (process.platform === 'win32') {
    return path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  }
  return path.join(home, '.config', 'google-chrome');
}

/**
 * Lista os perfis reais do Chrome, com a conta de cada um.
 *
 * O nome de diretório ("Profile 30") não diz nada a quem olha; a conta diz
 * tudo. O índice fica no arquivo `Local State`, não dentro de cada perfil.
 */
function listChromeProfiles(userDataDir = defaultChromeUserDataDir()) {
  if (!userDataDir || !fs.existsSync(userDataDir)) return [];

  let cache = {};
  try {
    const state = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'));
    cache = (state.profile && state.profile.info_cache) || {};
  } catch (e) { /* segue com o que der para descobrir do disco */ }

  const dirs = fs.readdirSync(userDataDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
    .map(d => d.name);

  return dirs.map(dir => {
    const info = cache[dir] || {};
    return {
      directory: dir,
      account: info.user_name || null,
      label: info.name || dir,
      isDefault: dir === 'Default',
      path: path.join(userDataDir, dir)
    };
  }).sort((a, b) => (a.isDefault ? -1 : b.isDefault ? 1 : a.directory.localeCompare(b.directory)));
}

/**
 * Argumentos exigidos para rodar o Chromium dentro de um container.
 *
 *   --no-sandbox              o sandbox do Chromium precisa de privilégios que
 *                             o container não concede ao usuário sem root. A
 *                             troca correta é rodar sem privilégio E sem
 *                             sandbox, com o container fazendo o isolamento.
 *   --disable-dev-shm-usage   o /dev/shm padrão do Docker tem 64MB; sem isto o
 *                             navegador estoura a memória compartilhada e
 *                             morre no meio de uma página grande.
 *
 * Só entram quando declarados: numa máquina de trabalho o sandbox fica ligado.
 */
function containerArgs() {
  if (String(process.env.BROWSER_NO_SANDBOX || '').toLowerCase() !== 'true') return [];
  return ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
}

/** O Chrome trava o perfil em uso; saber disso antes evita um erro obscuro. */
function chromeIsRunning() {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf8', timeout: 8000 });
      return /chrome\.exe/i.test(out);
    }
    const out = execSync('pgrep -x chrome || pgrep -x google-chrome || true', { encoding: 'utf8', timeout: 8000 });
    return Boolean(out.trim());
  } catch (e) {
    return false;   // na dúvida, deixa tentar e falhar com o erro do Chrome
  }
}

// ---------------------------------------------------------------------------
// Perfis de site
//
// Ficam isolados de propósito: quando a Gupy ou o Indeed mudam o HTML, o
// conserto é aqui, num só lugar, sem tocar na lógica de navegação.
// ---------------------------------------------------------------------------

const SITE_PROFILES = {
  /**
   * Gupy — portal público de vagas.
   *
   * Duas particularidades que só aparecem olhando o HTML real:
   *
   *   1. a busca vive num caminho, não numa query string:
   *      /job-search/term=motorista  (com "?" o site cai na home)
   *   2. a paginação é BOTÃO com JavaScript, sem href. Não dá para montar a
   *      URL da página 2 — é preciso clicar.
   */
  gupy: {
    label: 'Gupy',
    paginate: 'click',
    buildUrl({ keywords }) {
      const q = encodeURIComponent(String(keywords || '').trim());
      return `https://portal.gupy.io/job-search/term=${q}`;
    },
    listSelector: ['a[href*=".gupy.io/job/"]', '[data-testid="listing-details"]'],
    loginWall: ['input[type="password"]'],
    nextSelector: (n) => `[aria-label="Página ${n}"]`,
    extract: `(() => {
      const n = (s) => (s || '').replace(/\\s+/g, ' ').trim();
      const cards = Array.from(document.querySelectorAll('a[href*=".gupy.io/job/"]'));
      return cards.map(a => {
        const href = a.getAttribute('href') || '';
        const h3 = a.querySelector('h3');
        const title = n(h3 && h3.textContent);
        const full = n(a.textContent);
        // A empresa é o texto que vem ANTES do título dentro do mesmo cartão.
        let company = '';
        if (title) { const i = full.indexOf(title); if (i > 0) company = full.slice(0, i); }
        const loc = a.querySelector('[data-testid="job-location"]');
        const pub = full.match(/Publicada em:\\s*(\\d{2}\\/\\d{2}\\/\\d{4})/);
        let workplace = 'onsite';
        if (/Remoto/i.test(full)) workplace = 'remote';
        else if (/H[íi]brido/i.test(full)) workplace = 'hybrid';
        const jt = full.match(/\\b(Efetivo|Estágio|Tempor[áa]rio|Aprendiz|Freelancer|Terceiro|Est[áa]gio)\\b/);
        return {
          external_id: (href.split('/job/')[1] || href).split('?')[0],
          title: title,
          company: company,
          location: n(loc && loc.textContent),
          workplace_type: workplace,
          job_type: jt ? jt[1] : null,
          published_label: pub ? pub[1] : null,
          apply_url: href,
          description: full.slice(0, 1200)
        };
      }).filter(j => j.title && j.apply_url);
    })()`
  },

  /**
   * Indeed — busca pública por query string, paginação por URL e por botão.
   * Os `data-testid` do site são estáveis o bastante para servirem de âncora.
   */
  indeed: {
    label: 'Indeed',
    paginate: 'url',
    buildUrl({ keywords, country, location, page = 1 }) {
      const host = country === 'BR' ? 'https://br.indeed.com' : 'https://www.indeed.com';
      const q = encodeURIComponent(String(keywords || '').trim());
      const l = encodeURIComponent(String(location || '').trim());
      const start = (page - 1) * 10;
      return `${host}/jobs?q=${q}&l=${l}${start ? `&start=${start}` : ''}`;
    },
    listSelector: ['.job_seen_beacon', '[data-testid="slider_item"]'],
    loginWall: ['#login-email-input', 'form[action*="account/login"]'],
    blockedSignal: /captcha|verifique que voc|unusual traffic|are you a human/i,
    extract: `(() => {
      const n = (s) => (s || '').replace(/\\s+/g, ' ').trim();
      const cards = Array.from(document.querySelectorAll('.job_seen_beacon, [data-testid="slider_item"]'));
      return cards.map(c => {
        const link = c.querySelector('a[href*="/rc/clk"], a[href*="/viewjob"], h2 a, a[id^="job_"]');
        const href = link ? link.getAttribute('href') || '' : '';
        let jk = null;
        try { jk = new URLSearchParams(href.split('?')[1] || '').get('jk'); } catch (e) {}
        const t = (sel) => { const e = c.querySelector(sel); return e ? n(e.textContent) : ''; };
        // O título mora em h3.jobTitle > a > span[title]. Era h2 em versões
        // anteriores do site, e o span carrega o texto limpo no atributo title.
        const titleEl = c.querySelector('h3.jobTitle span[title], h3.jobTitle a, h2 a span, h2 span, [data-testid="jobTitle"]');
        // O testid de salário vem com dois valores separados por espaço
        // ("attribute_snippet_testid salary-snippet-container"), então casar
        // por igualdade exata não funciona.
        const salaryEl = c.querySelector('[data-testid^="attribute_snippet_testid"], .salary-snippet');
        return {
          external_id: jk || href.split('?')[0],
          title: titleEl ? n(titleEl.getAttribute('title') || titleEl.textContent) : '',
          company: t('[data-testid="company-name"], .companyName'),
          location: t('[data-testid="text-location"], .companyLocation'),
          salary_text: salaryEl ? n(salaryEl.textContent) : '',
          apply_url: href ? new URL(href, document.baseURI).href : '',
          description: t('[data-testid="belowJobSnippet"], .job-snippet').slice(0, 1200)
        };
      }).filter(j => j.title && j.apply_url);
    })()`
  }
};

// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Adaptador de navegador. Implementa o MESMO contrato do adaptador MCP
 * (`searchJobs`, `testConnection`, `fixtureMode`), para entrar no lugar dele
 * sem que o `boardService` precise saber a diferença.
 */
class BrowserAdapter {
  /**
   * @param {object} cfg
   * @param {string} cfg.provider   'gupy' | 'indeed'
   * @param {string} cfg.country    'BR' | 'US'
   * @param {boolean} [cfg.headless] padrão: false — você precisa poder ver e logar
   * @param {number} [cfg.maxPages]
   * @param {number} [cfg.delayMs]
   */
  constructor(cfg = {}) {
    this.provider = String(cfg.provider || '').toLowerCase();
    this.site = SITE_PROFILES[this.provider];
    if (!this.site) throw new Error(`Provedor sem perfil de navegação: ${cfg.provider}`);

    this.country = String(cfg.country || 'BR').toUpperCase();
    this.headless = cfg.headless === undefined
      ? process.env.BROWSER_HEADLESS === 'true'
      : Boolean(cfg.headless);
    this.maxPages = Math.max(1, Math.min(10, Number(cfg.maxPages) || DEFAULT_MAX_PAGES));
    this.delayMs = Number(cfg.delayMs) || DEFAULT_DELAY_MS;
    this.fixtureMode = false;
    this.version = VERSION;
    this.onProgress = typeof cfg.onProgress === 'function' ? cfg.onProgress : () => {};

    // Perfil: dedicado (padrão) ou um perfil real do Chrome do usuário.
    this.profileMode = cfg.profileMode || process.env.CHROME_PROFILE_MODE || 'dedicated';
    this.userDataDir = cfg.userDataDir || process.env.CHROME_USER_DATA_DIR || null;
    this.profileDirectory = cfg.profileDirectory || process.env.CHROME_PROFILE_DIRECTORY || null;
  }

  profileDir() {
    const dir = path.join(PROFILE_ROOT, `${this.provider}-${this.country.toLowerCase()}`);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * Qual perfil do Chrome usar.
   *
   *   dedicado (padrão) — perfil próprio desta aplicação
   *   sistema           — um perfil real do seu Chrome, já logado
   *
   * O padrão é dedicado por três motivos concretos, não por preciosismo:
   *
   *   1. o Chrome TRAVA um perfil em uso; com o modo sistema, o Chrome
   *      precisa estar completamente fechado enquanto o robô trabalha;
   *   2. o perfil real carrega todas as suas sessões — banco, e-mail, tudo —
   *      e a automação passaria a alcançar qualquer uma delas;
   *   3. o perfil real mora NESTA máquina. No VPS ele não existe, então o
   *      modo sistema não sobrevive à mudança que é o objetivo do projeto.
   */
  resolveProfile() {
    const mode = String(this.profileMode || '').toLowerCase();

    if (mode === 'system' || mode === 'sistema') {
      const userDataDir = this.userDataDir || defaultChromeUserDataDir();
      if (!userDataDir || !fs.existsSync(userDataDir)) {
        throw new IntegrationError(HEALTH.NOT_CONFIGURED,
          'O diretório de perfis do Chrome não foi encontrado. Informe CHROME_USER_DATA_DIR no .env.',
          `caminho testado: ${userDataDir || '(nenhum)'}`, false);
      }
      const profileDirectory = this.profileDirectory || 'Default';
      const full = path.join(userDataDir, profileDirectory);
      if (!fs.existsSync(full)) {
        throw new IntegrationError(HEALTH.NOT_CONFIGURED,
          `O perfil "${profileDirectory}" não existe neste Chrome. Rode "npm run browser:profiles" para ver os disponíveis.`,
          full, false);
      }
      return { mode: 'system', userDataDir, profileDirectory };
    }

    return { mode: 'dedicated', userDataDir: this.profileDir(), profileDirectory: null };
  }

  /**
   * Sobe o Chrome já instalado na máquina, com perfil próprio desta aplicação.
   *
   * Perfil próprio, e não o seu perfil pessoal do Chrome, por dois motivos: o
   * Chrome recusa abrir um perfil que já está em uso por outra janela, e
   * misturar as sessões daria a esta aplicação acesso a tudo que você tem
   * logado no navegador do dia a dia.
   */
  async launch() {
    let puppeteer;
    try {
      puppeteer = require('puppeteer-core');
    } catch (e) {
      throw new IntegrationError(HEALTH.ERROR,
        'O componente de navegação não está instalado. Rode "npm install puppeteer-core" no servidor.',
        e.message, false);
    }

    const executablePath = findChrome();
    if (!executablePath) {
      throw new IntegrationError(HEALTH.NOT_CONFIGURED,
        'Nenhum Chrome ou Edge foi encontrado nesta máquina. Instale o Google Chrome, ' +
        'ou informe o caminho do executável em CHROME_PATH no arquivo .env.',
        'chrome não localizado', false);
    }

    const profile = this.resolveProfile();
    this.activeProfile = profile;

    if (profile.mode === 'system' && chromeIsRunning()) {
      throw new IntegrationError(HEALTH.REQUIRES_ATTENTION,
        'O Chrome está aberto e mantém o perfil travado. Feche TODAS as janelas do Chrome ' +
        '(inclusive as que ficam na bandeja do sistema) e rode de novo. ' +
        'Se preferir não fechar o navegador, use o perfil dedicado: CHROME_PROFILE_MODE=dedicated',
        'perfil do Chrome em uso', true);
    }

    const profileArgs = profile.profileDirectory
      ? [`--profile-directory=${profile.profileDirectory}`]
      : [];

    this.browser = await puppeteer.launch({
      executablePath,
      headless: this.headless,
      userDataDir: profile.userDataDir,
      // Viewport explícito em headless: com `null` a janela nasce minúscula e
      // sites entregam o layout mobile, cujos seletores são outros — o sintoma
      // é "zero vagas" numa busca que funciona perfeitamente no navegador.
      defaultViewport: this.headless ? { width: 1440, height: 900 } : null,
      args: [
        '--no-first-run', '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1440,900'
      ].concat(profileArgs).concat(containerArgs())
    });

    this.page = await this.browser.newPage();
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    return this.browser;
  }

  async close() {
    try { if (this.browser) await this.browser.close(); } catch (e) { /* já fechado */ }
    this.browser = null;
    this.page = null;
  }

  /** Detecta parede de login. Não tenta atravessá-la — devolve o fato. */
  async atLoginWall() {
    for (const sel of this.site.loginWall) {
      const found = await this.page.$(sel).catch(() => null);
      if (found) return true;
    }
    return false;
  }

  /**
   * Espera VOCÊ fazer login na janela aberta.
   * Não digita credencial, não preenche campo, não clica em nada.
   */
  async waitForUserLogin() {
    if (this.headless) {
      throw new IntegrationError(HEALTH.ERROR,
        `O ${this.site.label} pediu login e o navegador está em modo invisível. ` +
        'Rode a busca com a janela visível uma vez para entrar na sua conta — ' +
        'a sessão fica salva e as próximas execuções podem ser invisíveis.',
        'login exigido em modo headless', false);
    }

    this.onProgress({
      phase: 'login',
      message: `O ${this.site.label} pediu login. Entre na janela que abriu — eu não toco nos seus dados. ` +
               'Assim que a listagem aparecer, eu sigo sozinho.'
    });

    const deadline = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(3000);
      if (!(await this.atLoginWall())) return true;
    }
    throw new IntegrationError(HEALTH.ERROR,
      `O login no ${this.site.label} não foi concluído no tempo previsto. Tente de novo quando puder acompanhar a janela.`,
      'timeout de login', true);
  }

  /**
   * Avança para a página `n` clicando no controle de paginação.
   * Necessário na Gupy, onde o botão não tem href e a URL não muda.
   */
  async clickNextPage(n) {
    if (!this.site.nextSelector) return false;
    const sel = this.site.nextSelector(n);
    const btn = await this.page.$(sel).catch(() => null);
    if (!btn) return false;

    this.onProgress({ phase: 'paginate', page: n, message: `Indo para a página ${n}…` });

    const before = await this.page.evaluate(
      `document.querySelectorAll('${this.site.listSelector[0].replace(/'/g, "\\'")}').length`
    ).catch(() => 0);

    await btn.click().catch(() => null);

    // A lista é trocada por JavaScript: espera o conteúdo mudar, não a navegação.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(700);
      const now = await this.page.evaluate(
        `document.querySelectorAll('${this.site.listSelector[0].replace(/'/g, "\\'")}').length`
      ).catch(() => 0);
      if (now > 0 && now !== before) return true;
      const active = await this.page.$(`[aria-current="true"][aria-label="Página ${n}"]`).catch(() => null);
      if (active) return true;
    }
    return true;   // clicou; se o conteúdo repetir, o dedupe resolve
  }

  /** Detecta desafio anti-robô, para não confundir bloqueio com "zero vagas". */
  async looksBlocked() {
    if (!this.site.blockedSignal) return false;
    const text = await this.page.evaluate('document.body ? document.body.innerText.slice(0,800) : ""')
      .catch(() => '');
    return this.site.blockedSignal.test(text);
  }

  /** Espera a listagem, tolerando variação de seletor entre versões do site. */
  async waitForList() {
    for (const sel of this.site.listSelector) {
      const ok = await this.page.waitForSelector(sel, { timeout: SELECTOR_TIMEOUT_MS / this.site.listSelector.length })
        .then(() => true).catch(() => false);
      if (ok) return sel;
    }
    return null;
  }

  /**
   * Busca vagas. Mesma assinatura do adaptador MCP.
   * @returns {{jobs: object[], fixtureMode: boolean, pagesRead: number, source: string}}
   */
  async searchJobs({ keywords = '', country, location = '', page = 1 } = {}) {
    const c = String(country || this.country).toUpperCase();
    const collected = [];
    const seen = new Set();
    let pagesRead = 0;
    const warnings = [];

    await this.launch();

    try {
      for (let p = page; p < page + this.maxPages; p++) {
        const first = p === page;

        if (first || this.site.paginate === 'url') {
          const url = this.site.buildUrl({ keywords, country: c, location, page: p });
          this.onProgress({ phase: 'navigate', page: p, url,
            message: `Abrindo ${this.site.label}, página ${p}…` });
          await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        } else {
          // Paginação por botão: não existe URL da página seguinte.
          const advanced = await this.clickNextPage(p);
          if (!advanced) {
            this.onProgress({ phase: 'page_end', page: p,
              message: `Não há página ${p} — a listagem terminou.` });
            break;
          }
        }

        if (await this.atLoginWall()) {
          await this.waitForUserLogin();
          const url = this.site.buildUrl({ keywords, country: c, location, page: p });
          await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        }

        if (await this.looksBlocked()) {
          warnings.push(
            `O ${this.site.label} respondeu com verificação anti-robô na página ${p}. ` +
            'Reduza a frequência das buscas ou rode com a janela visível para resolver o desafio uma vez.'
          );
          break;
        }

        const matched = await this.waitForList();
        if (!matched) {
          warnings.push(
            `Página ${p}: a listagem não apareceu com nenhum dos seletores conhecidos. ` +
            `O ${this.site.label} pode ter mudado o layout, ou a busca não retornou resultados.`
          );
          break;
        }

        const batch = await this.page.evaluate(this.site.extract).catch((e) => {
          warnings.push(`Página ${p}: falha ao ler a listagem — ${e.message}`);
          return [];
        });
        pagesRead++;

        let novos = 0;
        for (const j of batch) {
          const key = j.external_id || j.apply_url;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          collected.push(Object.assign({ source_provider: this.provider, source_country: c }, j));
          novos++;
        }

        this.onProgress({ phase: 'page_done', page: p, found: batch.length, new: novos,
          message: `Página ${p}: ${batch.length} vaga(s) lida(s), ${novos} inédita(s).` });

        if (!batch.length) break;

        // Educação de acesso: uma pausa real entre páginas.
        await sleep(this.delayMs);
      }
    } finally {
      await this.close();
    }

    return {
      jobs: collected,
      fixtureMode: false,
      pagesRead,
      warnings,
      source: `${this.site.label} (navegador)`,
      version: VERSION
    };
  }

  /** Diagnóstico, no mesmo formato do adaptador MCP. */
  async testConnection() {
    const steps = [];
    const add = (label, ok, detail) => steps.push({ label, ok, detail });

    const chrome = findChrome();
    add('Navegador instalado', Boolean(chrome), chrome || 'Nenhum Chrome ou Edge encontrado.');

    let puppeteerOk = true;
    try { require('puppeteer-core'); } catch (e) { puppeteerOk = false; }
    add('Componente de navegação', puppeteerOk, puppeteerOk ? 'puppeteer-core disponível' : 'puppeteer-core ausente');

    const dir = this.profileDir();
    const hasSession = fs.existsSync(path.join(dir, 'Default'));
    add('Sessão salva', hasSession,
        hasSession ? 'Existe um perfil salvo — o login anterior deve continuar valendo.'
                   : 'Ainda não há sessão salva. Na primeira busca a janela abre para você entrar.');

    add('Submissão automática', true, 'Bloqueada por política. Este componente apenas lê listagens.');

    const success = Boolean(chrome) && puppeteerOk;
    return {
      success,
      health: success ? (hasSession ? HEALTH.HEALTHY : HEALTH.DEGRADED) : HEALTH.NOT_CONFIGURED,
      fixtureMode: false,
      steps,
      userMessage: success
        ? `Navegação pronta para o ${this.site.label}.${hasSession ? '' : ' A primeira busca vai abrir a janela para você fazer login.'}`
        : 'A navegação não está pronta. Veja os passos acima.'
    };
  }

  /**
   * Fronteira explícita (§46, §71.4).
   * Existe como método para que a recusa seja um fato do código, e não a
   * ausência silenciosa de uma funcionalidade.
   */
  async submitApplication() {
    throw new IntegrationError(HEALTH.ERROR,
      'Este componente não submete candidaturas. Ele lê listagens e para antes do envio — ' +
      'a candidatura final acontece por você, nos mecanismos oficiais do provedor.',
      'BROWSER_SUBMIT negado por política', false);
  }
}

module.exports = {
  BrowserAdapter, SITE_PROFILES, VERSION, PROFILE_ROOT,
  findChrome, defaultChromeUserDataDir, listChromeProfiles, chromeIsRunning
};
