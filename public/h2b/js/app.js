/**
 * H2 Dream — núcleo do front.
 *
 * Reproduz a casca do sistema de referência: telas trocadas por `sv()`,
 * drawer, tema claro/escuro, modo de tela (auto/celular/PC), toasts, modais,
 * splash e notificações. Tudo fala com o backend pelo `API` global (/js/api.js).
 *
 * Estado de interface fica em localStorage (resposta imediata) E no servidor
 * (/api/seasonal/ui/prefs) para que celular e PC vejam a mesma coisa.
 */
window.H2B = (function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const state = {
    view: 'home',
    prefs: {},
    profile: null,
    dashboard: null,
    quota: null,
    senders: null,
    scheduler: null,
    templates: null,
    notifications: { notifications: [], unread: 0 },
    // Foco das candidaturas: false = todas as vagas H-2A/H-2B (padrão); true = só caminhão.
    truckFocus: false,
    config: null,
    online: navigator.onLine,
    firstLoad: true
  };

  // ------------------------------------------------------------ utilidades

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function ls(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, String(val));
    } catch (e) { /* modo privado */ }
    return val;
  }

  function fmtDate(s, opts) {
    if (!s) return '—';
    const d = new Date(String(s).includes('T') || String(s).includes('Z') ? s : String(s).replace(' ', 'T') + (String(s).length <= 19 ? 'Z' : ''));
    if (isNaN(d.getTime())) return String(s);
    return d.toLocaleDateString('pt-BR', opts || { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function fmtDateTime(s) {
    if (!s) return '—';
    const d = new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return String(s);
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function fmtUSDate(s) {
    // Datas do DOL vêm como YYYY-MM-DD; sem fuso.
    if (!s) return '—';
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(s);
  }
  function money(v, unit) {
    if (v === null || v === undefined || v === '') return '—';
    const n = Number(v);
    if (!isFinite(n)) return String(v);
    return `$${n.toFixed(2)}${unit ? '/' + (String(unit).toLowerCase() === 'hour' ? 'h' : unit) : ''}`;
  }
  function relTime(s) {
    if (!s) return '';
    const d = new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z');
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'agora';
    if (diff < 3600) return `${Math.floor(diff / 60)} min`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
    return `${Math.floor(diff / 86400)} d`;
  }
  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'G';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Bom dia,' : h < 18 ? 'Boa tarde,' : 'Boa noite,';
  }
  const VISA_ICON = { 'H-2A': '🌾', 'H-2B': '🏨' };
  function visaTag(v) {
    if (v === 'H-2A') return `<span class="tag tgr">🌾 H-2A</span>`;
    if (v === 'H-2B') return `<span class="tag tb">🏨 H-2B</span>`;
    return `<span class="tag">${esc(v || '—')}</span>`;
  }

  // ------------------------------------------------------------ toasts

  function toast(msg, kind, ms) {
    const wrap = $('#tw');
    const t = document.createElement('div');
    t.className = 't' + (kind === 'ok' ? ' g' : kind === 'err' ? ' r' : kind === 'auto' ? ' au' : '');
    t.innerHTML = esc(msg);
    wrap.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms || (kind === 'err' ? 5200 : 3200));
  }
  const ok = (m) => toast(m, 'ok');
  /** Toast curto de gravação automática — não empilha se já houver um igual. */
  function saved(what) {
    const wrap = $('#tw');
    const last = wrap.lastElementChild;
    if (last && last.dataset.saved === what && last.classList.contains('show')) return;
    const t = document.createElement('div');
    t.className = 't g'; t.dataset.saved = what; t.textContent = `✓ ${what} salvo no servidor`;
    wrap.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 1600);
  }
  const err = (e) => toast(e && e.message ? e.message : String(e), 'err');

  // ------------------------------------------------------------ modais

  function openModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('show');
    document.body.style.overflow = 'hidden';
  }
  function closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('show');
    if (!$$('.overlay.show').length && $('#auto-modal-overlay').style.display !== 'flex') document.body.style.overflow = '';
  }
  function warn({ icon, title, text, okLabel, danger, onDanger, onOk }) {
    $('#warn-icon').textContent = icon || '⚠️';
    $('#warn-title').textContent = title || '';
    $('#warn-text').innerHTML = text || '';
    $('#warn-ok').textContent = okLabel || 'Entendi';
    const d = $('#warn-danger');
    d.classList.toggle('gone', !danger);
    d.textContent = danger || '';
    d.onclick = () => { $('#warn-ov').classList.remove('show'); if (onDanger) onDanger(); };
    $('#warn-ok').onclick = () => { $('#warn-ov').classList.remove('show'); if (onOk) onOk(); };
    $('#warn-ov').classList.add('show');
  }
  function success(title, text, cb) {
    $('#suc-title').textContent = title || 'Enviado!';
    $('#suc-text').innerHTML = text || '';
    $('#success-overlay').style.display = 'flex';
    $('#suc-ok').onclick = () => { $('#success-overlay').style.display = 'none'; if (cb) cb(); };
  }

  // ------------------------------------------------------------ tema / modo

  function applyTheme(theme) {
    const dark = theme === 'dark';
    if (dark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    $$('#theme-toggle-btn i, #theme-toggle-btn-sidebar i, #dr-theme i').forEach(i => { i.className = dark ? 'ti ti-sun' : 'ti ti-moon'; });
    const lbl = $('#theme-lbl-sidebar'); if (lbl) lbl.textContent = dark ? 'Tema claro' : 'Tema escuro';
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0b0a1f' : '#4f46e5');
    ls('h2b_theme', theme);
  }
  function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    savePrefs({ theme: next });
  }
  const MODE_LABEL = { auto: 'Auto', cel: 'Celular', pc: 'PC' };
  function applyMode(mode) {
    document.documentElement.classList.remove('force-cel', 'force-pc');
    if (mode === 'cel') document.documentElement.classList.add('force-cel');
    if (mode === 'pc') document.documentElement.classList.add('force-pc');
    $$('.sbm-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    const lbl = $('#dr-mode-lbl'); if (lbl) lbl.textContent = MODE_LABEL[mode] || 'Auto';
    ls('h2b_screen_mode', mode);
  }
  function cycleMode() {
    const cur = ls('h2b_screen_mode') || 'auto';
    const next = cur === 'auto' ? 'cel' : cur === 'cel' ? 'pc' : 'auto';
    applyMode(next);
    savePrefs({ screen_mode: next });
    toast(`Modo de tela: ${MODE_LABEL[next]}`);
  }

  // ------------------------------------------------------------ prefs

  async function loadPrefs() {
    try {
      const r = await API.seasonal.uiPrefs();
      state.prefs = r.prefs || {};
      if (state.prefs.theme) applyTheme(state.prefs.theme);
      if (state.prefs.screen_mode) applyMode(state.prefs.screen_mode);
    } catch (e) { /* offline: fica com o localStorage */ }
  }
  let prefTimer = null, prefBuf = {};
  function flushPrefs() {
    clearTimeout(prefTimer); prefTimer = null;
    const b = prefBuf; prefBuf = {};
    if (!Object.keys(b).length) return;
    // keepalive: a requisição sobrevive ao fechamento da aba.
    try { fetch('/api/seasonal/ui/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b), keepalive: true }).catch(() => {}); } catch (e) { /* silencioso */ }
  }
  function savePrefs(obj) {
    Object.assign(state.prefs, obj);
    Object.assign(prefBuf, obj);
    clearTimeout(prefTimer);
    prefTimer = setTimeout(flushPrefs, 400);
  }
  window.addEventListener('pagehide', flushPrefs);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushPrefs(); });

  // ------------------------------------------------------------ navegação

  const VIEWS = ['home', 'jobs', 'hist', 'pesquisa', 'logs', 'profile', 'notif', 'news', 'settings'];
  const onShow = {};
  function sv(name, opts) {
    if (!VIEWS.includes(name)) name = 'home';
    if (state.view === 'profile' && H2B.profile && H2B.profile.ps && H2B.profile.ps.flush) H2B.profile.ps.flush();
    state.view = name;
    VIEWS.forEach(v => { const el = $('#v-' + v); if (el) el.classList.toggle('gone', v !== name); });
    $$('[data-sv]').forEach(b => b.classList.toggle('active', b.dataset.sv === name && (b.classList.contains('bn') || b.classList.contains('sb-item'))));
    $('#mob-detail').classList.remove('show');
    closeDrawer();
    if (onShow[name]) { try { onShow[name](opts || {}); } catch (e) { console.error(e); } }
    savePrefs({ last_view: name });
    const sc = $('#v-' + name + ' .view-scroll'); if (sc && !(opts && opts.keepScroll)) sc.scrollTop = 0;
  }

  function openDrawer() { $('#drawer-ov').classList.add('show'); $('#drawer').classList.add('show'); }
  function closeDrawer() { $('#drawer-ov').classList.remove('show'); $('#drawer').classList.remove('show'); }

  // ------------------------------------------------------------ identidade

  function renderIdentity() {
    const p = state.profile || {};
    const name = p.fullName || state.prefs.display_name || 'Candidato';
    const email = p.email || '—';
    const av = state.prefs.avatar || initials(name);
    $$('#hdr-av, #sb-av, #dr-av, #prof-av').forEach(el => { el.textContent = av; });
    $$('#sb-name, #dr-name, #prof-name').forEach(el => { el.textContent = name; });
    $$('#sb-email, #dr-email, #prof-email').forEach(el => { el.textContent = email; });
    $('#home-greeting').textContent = greeting();
    $('#home-name').textContent = name.split(' ')[0] || name;
  }

  // ------------------------------------------------------------ notificações

  async function loadNotifications() {
    try {
      state.notifications = await API.seasonal.notifications();
      const n = state.notifications.unread || 0;
      const b = $('#hdr-notif-badge'); b.textContent = n > 99 ? '99+' : n; b.classList.toggle('gone', !n);
      const s = $('#sb-notif-badge'); s.textContent = n; s.classList.toggle('gone', !n);
    } catch (e) { /* silencioso */ }
  }

  // ------------------------------------------------------------ dados base

  async function refreshCore() {
    const [dash, quota, senders, sched, cfg] = await Promise.allSettled([
      API.seasonal.dashboard(), API.seasonal.quota(), API.gmailSenders.list(), API.core.scheduler(), API.seasonal.getConfig()
    ]);
    if (dash.status === 'fulfilled') state.dashboard = dash.value;
    if (cfg.status === 'fulfilled') { state.config = cfg.value.config; state.truckFocus = Number(state.config.require_truck_driver_match) === 1; }
    if (quota.status === 'fulfilled') state.quota = quota.value;
    if (senders.status === 'fulfilled') state.senders = senders.value;
    if (sched.status === 'fulfilled') state.scheduler = sched.value;
    renderGlobals();
    return dash.status === 'fulfilled' ? dash.value : null;
  }

  function autoIsOn() {
    const s = state.scheduler;
    if (!s || !s.enabled || s.globallyPaused) return false;
    const t = (s.tasks || []).find(x => x.id === 'seasonal_dispatch');
    return Boolean(t && t.enabled);
  }

  function renderGlobals() {
    const d = state.dashboard;
    const q = state.quota;
    if (q) $('#home-tag-quota').textContent = `${q.countSent}/${q.maxLimit} hoje`;
    $('#home-tag-visa').textContent = state.truckFocus ? '🚛 Só motorista de caminhão' : '🌾 H-2A · 🏨 H-2B · todas as ocupações';
    if (d) {
      $('#hs-jobs').textContent = d.secondary.total;
      $('#hs-sent').textContent = (d.kpis && d.kpis.sentTotal !== undefined) ? d.kpis.sentTotal : (state.stats ? state.stats.total : '—');
      $('#hs-today').textContent = d.kpis.sentToday;
      $('#sb-jobs-badge').textContent = d.secondary.total;
      const bj = $('#bn-jobs-badge'); bj.textContent = d.kpis.recommended; bj.classList.toggle('gone', !d.kpis.recommended);
    }
    const on = autoIsOn();
    $('#sb-auto-badge').classList.toggle('gone', !on);
    $('#sb-auto-open').classList.toggle('is-active', on);
    $('#bn-auto').classList.toggle('is-active', on);
    $('#bn-auto-dot').classList.toggle('gone', !on);
    $('#bn-auto-dot').classList.toggle('is-auto', on);
    $('#home-auto-sub').textContent = on
      ? `Ligado — ${q ? q.countSent + ' de ' + q.maxLimit + ' enviados hoje' : 'enviando dentro da cota'}.`
      : 'Configure uma vez, o sistema envia por você todo dia.';
  }

  // ------------------------------------------------------------ boot

  function wireShell() {
    document.addEventListener('click', (ev) => {
      const svEl = ev.target.closest('[data-sv]');
      if (svEl) { ev.preventDefault(); sv(svEl.dataset.sv, { subtab: svEl.dataset.subtab }); return; }
      const closeEl = ev.target.closest('[data-close]');
      if (closeEl) { closeModal(closeEl.dataset.close); return; }
    });
    $$('.overlay').forEach(ov => ov.addEventListener('click', (ev) => { if (ev.target === ov) closeModal(ov.id); }));
    $('#hdr-menu-btn').onclick = openDrawer;
    $('#drawer-ov').onclick = closeDrawer;
    $('#drawer-close').onclick = closeDrawer;
    $('#theme-toggle-btn').onclick = toggleTheme;
    $('#theme-toggle-btn-sidebar').onclick = (e) => { e.stopPropagation(); toggleTheme(); };
    $('#dr-theme').onclick = toggleTheme;
    $('#dr-mode').onclick = cycleMode;
    $$('.sbm-btn').forEach(b => b.onclick = () => { applyMode(b.dataset.mode); savePrefs({ screen_mode: b.dataset.mode }); });
    $('#hdr-notif-btn').onclick = () => sv('notif');
    $('#mob-back').onclick = () => $('#mob-detail').classList.remove('show');
    $('#sb-auto-open').onclick = () => H2B.send.openAuto();
    $('#bn-auto').onclick = () => H2B.send.openAuto();
    $('#dr-auto').onclick = () => { closeDrawer(); H2B.send.openAuto(); };
    $('#home-auto-card').onclick = () => H2B.send.openAuto();
    $('#hs-editor').onclick = () => H2B.profile.openEditor();
    $('#hs-tour').onclick = () => H2B.profile.startTour();
    $('#dr-tour').onclick = () => { closeDrawer(); H2B.profile.startTour(); };
    $('#prof-edit-btn').onclick = () => H2B.profile.openEditor();

    window.addEventListener('online', () => { state.online = true; $('#offline-banner').style.display = 'none'; toast('Conexão de volta'); });
    window.addEventListener('offline', () => { state.online = false; $('#offline-banner').style.display = 'flex'; });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $$('.overlay.show').forEach(o => closeModal(o.id)); closeDrawer(); } });

    // Ícones Tabler: se a fonte não carregar, o CSS cai nos emojis.
    setTimeout(() => {
      const probe = document.createElement('i'); probe.className = 'ti ti-home'; probe.style.position = 'absolute'; probe.style.opacity = '0';
      document.body.appendChild(probe);
      const fam = getComputedStyle(probe, '::before').fontFamily || '';
      if (!/tabler/i.test(fam)) document.documentElement.classList.add('no-ti');
      probe.remove();
    }, 1500);
  }

  async function boot() {
    wireShell();
    applyTheme(ls('h2b_theme') || 'light');
    applyMode(ls('h2b_screen_mode') || 'auto');

    const msg = $('#splash-msg');
    try {
      msg.textContent = 'Carregando preferências…';
      await loadPrefs();
      msg.textContent = 'Carregando seu perfil…';
      try { state.profile = (await API.env('seasonal', 'US').profile()).profile; } catch (e) { state.profile = null; }
      renderIdentity();
      msg.textContent = 'Buscando vagas…';
      await refreshCore();
      loadNotifications();
    } catch (e) {
      console.error(e);
    }

    $('#app').style.display = 'flex';
    const sp = $('#h2b-splash');
    sp.style.opacity = '0';
    setTimeout(() => sp.remove(), 420);

    const start = state.prefs.last_view && VIEWS.includes(state.prefs.last_view) ? state.prefs.last_view : 'home';
    sv(start === 'notif' ? 'home' : start);

    if (!state.prefs.onboarding_done) H2B.profile.startOnboarding();
    else if (!state.prefs.tour_done) setTimeout(() => H2B.profile.startTour(), 600);

    // Atualização periódica leve: cota, robô, notificações.
    setInterval(async () => { if (document.hidden || !state.online) return; await refreshCore(); loadNotifications(); if (H2B.views && H2B.views.tick) H2B.views.tick(); }, 45000);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/h2b/sw.js').catch(() => {});
  }

  return {
    $, $$, esc, ls, state, fmtDate, fmtDateTime, fmtUSDate, money, relTime, initials, visaTag, VISA_ICON,
    toast, ok, err, saved, openModal, closeModal, warn, success,
    applyTheme, toggleTheme, applyMode, savePrefs,
    sv, onShow, openDrawer, closeDrawer, renderIdentity, refreshCore, renderGlobals, autoIsOn, loadNotifications,
    boot
  };
})();
