/**
 * H2 Dream — botão de tradução (Google Tradutor, widget de site).
 *
 * A interface já é em português; o que está em inglês é o conteúdo das vagas
 * (título, descrição, requisitos), que vem do DOL. O <body> inteiro leva
 * `notranslate` e só o conteúdo das vagas libera com `translate="yes"` —
 * deixar o Google detectar idioma por trecho estraga rótulo curto ("Ver no
 * DOL" virava "Não veja DOL"). O que a lista insere depois também é
 * traduzido, porque o widget observa o DOM. Sem chave, sem custo, sem passar
 * pelo servidor.
 *
 * A escolha vive no servidor (/api/seasonal/ui/prefs, `lang`), como toda
 * preferência: o cookie `googtrans` que o widget usa é só o mecanismo dele,
 * regravado a cada abertura a partir da preferência salva.
 *
 * O e-mail enviado ao empregador nunca passa por aqui: é texto do servidor,
 * sempre em inglês. As áreas que mostram esse texto levam `notranslate`.
 */
H2B.lang = (function () {
  const { $, $$, state, toast } = H2B;
  const COOKIE = 'googtrans';
  const SRC = 'https://translate.google.com/translate_a/element.js?cb=__h2bGoogleTranslateInit';
  let loading = null;
  let current = 'en';

  // ------------------------------------------------------------ cookie do widget

  function domains() {
    const host = location.hostname;
    const parts = host.split('.');
    const out = [null, host];
    // Em produção o widget também grava no domínio pai (.inovassie.com.br).
    if (parts.length >= 2 && !/^\d+$/.test(parts[parts.length - 1])) out.push('.' + parts.slice(-2).join('.'));
    return out;
  }
  function setCookie(value) {
    for (const d of domains()) {
      document.cookie = `${COOKIE}=${value}; path=/; max-age=31536000; SameSite=Lax${d ? '; domain=' + d : ''}`;
    }
  }
  function clearCookie() {
    for (const d of domains()) document.cookie = `${COOKIE}=; path=/; max-age=0${d ? '; domain=' + d : ''}`;
  }

  // ------------------------------------------------------------ widget

  function ready() {
    return Boolean(window.google && window.google.translate && window.google.translate.TranslateElement && $('#google_translate_element select'));
  }
  function ensureWidget() {
    if (ready()) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      if (!$('#google_translate_element')) {
        const host = document.createElement('div');
        host.id = 'google_translate_element'; host.className = 'notranslate'; host.setAttribute('aria-hidden', 'true');
        document.body.appendChild(host);
      }
      window.__h2bGoogleTranslateInit = function () {
        try {
          new window.google.translate.TranslateElement({ pageLanguage: 'en', includedLanguages: 'pt,en', autoDisplay: false }, 'google_translate_element');
          resolve();
        } catch (e) { reject(e); }
      };
      const s = document.createElement('script');
      s.src = SRC; s.async = true;
      s.onerror = () => reject(new Error('Não consegui carregar o Google Tradutor. Verifique a conexão.'));
      document.head.appendChild(s);
      setTimeout(() => reject(new Error('O Google Tradutor demorou demais para responder.')), 20000);
    }).catch(e => { loading = null; throw e; });
    return loading;
  }
  function waitFor(fn, ms) {
    return new Promise(resolve => {
      const t0 = Date.now();
      (function tick() { const v = fn(); if (v) return resolve(v); if (Date.now() - t0 > ms) return resolve(null); setTimeout(tick, 150); })();
    });
  }
  function isTranslated() { return /translated-/.test(document.documentElement.className); }

  async function translateTo(lang) {
    // O widget lê o cookie ao iniciar; se já estava carregado, a caixa de
    // seleção (escondida) é quem manda.
    setCookie('/en/' + lang);
    await ensureWidget();
    const combo = await waitFor(() => $('#google_translate_element select'), 8000);
    if (!combo) throw new Error('O Google Tradutor não inicializou.');
    if (combo.value !== lang) { combo.value = lang; combo.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  async function restore() {
    // O botão "Mostrar o original" do banner (escondido) do Google desfaz a
    // tradução no lugar, sem recarregar. Se não der, recarrega sem o cookie.
    let done = false;
    try {
      const ifr = $('body > .skiptranslate iframe');
      const doc = ifr && ifr.contentDocument;
      const btn = doc && Array.from(doc.querySelectorAll('button')).find(b => /\.restore$/.test(b.id) || /original/i.test(b.textContent));
      if (btn) { btn.click(); done = true; }
    } catch (e) { /* iframe inacessível: cai no reload */ }
    clearCookie();
    if (!done && isTranslated()) location.reload();
  }

  // ------------------------------------------------------------ interface

  function renderState(lang) {
    current = lang;
    const lbl = $('#lang-lbl'); if (lbl) lbl.textContent = lang === 'pt' ? 'PT' : 'EN';
    const btn = $('#lang-btn'); if (btn) { btn.classList.toggle('on', lang === 'pt'); btn.title = lang === 'pt' ? 'Vagas traduzidas para português — clique para trocar' : 'Traduzir as vagas (Google Tradutor)'; }
    $$('#lang-menu .lang-opt').forEach(b => b.classList.toggle('on', b.dataset.lang === lang));
    const dl = $('#dr-lang-lbl'); if (dl) dl.textContent = lang === 'pt' ? 'Português' : 'English';
  }
  function closeMenu() { const m = $('#lang-menu'); if (m) m.classList.add('gone'); }

  async function set(lang, { persist = true, quiet = false } = {}) {
    lang = lang === 'pt' ? 'pt' : 'en';
    closeMenu();
    const before = current;
    renderState(lang);
    try {
      if (lang === 'pt') await translateTo('pt');
      else await restore();
      if (persist) H2B.savePrefs({ lang });
      if (!quiet) toast(lang === 'pt' ? 'Vagas traduzidas para português 🇧🇷' : 'Texto original em inglês 🇺🇸', 'ok');
    } catch (e) {
      renderState(before);
      if (!quiet) toast(e.message || 'Não consegui traduzir agora.');
      else console.warn('tradução:', e.message);
    }
  }

  function wire() {
    const btn = $('#lang-btn'); if (!btn) return;
    btn.onclick = (ev) => { ev.stopPropagation(); $('#lang-menu').classList.toggle('gone'); };
    $('#lang-menu').onclick = (ev) => { ev.stopPropagation(); const o = ev.target.closest('[data-lang]'); if (o) set(o.dataset.lang); };
    document.addEventListener('click', closeMenu);
    const dl = $('#dr-lang'); if (dl) dl.onclick = () => { H2B.closeDrawer(); set(current === 'pt' ? 'en' : 'pt'); };
  }

  /** No boot, depois das preferências: aplica a escolha salva, sem aviso. */
  function boot() {
    wire();
    const lang = state.prefs.lang === 'pt' ? 'pt' : 'en';
    renderState(lang);
    if (lang === 'pt') return set('pt', { persist: false, quiet: true });
    // Sobra de sessão antiga não pode traduzir sozinha na próxima abertura.
    clearCookie();
    return Promise.resolve();
  }

  return { set, boot, isTranslated, current: () => current };
})();
