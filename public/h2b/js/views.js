/**
 * H2 Dream — telas simples: início, histórico, pesquisa, logs, notificações,
 * notícias e configurações (contas Gmail, feed DOL, limites, agendador).
 */
H2B.views = (function () {
  const { $, $$, esc, toast, err, openModal, closeModal, state, visaTag, money, fmtDateTime, fmtUSDate } = H2B;
  const env = () => API.env('seasonal', 'US');

  // ═══════════════════════════════════════════════════════════ INÍCIO

  async function renderHome() {
    H2B.renderIdentity();
    const d = state.dashboard || (await H2B.refreshCore());
    if (!d) return;
    try { state.stats = await API.seasonal.stats(); $('#hs-sent').textContent = state.stats.total; } catch (e) { /* silencioso */ }
    const att = d.attention || [];
    const card = $('#home-attention-card');
    card.classList.toggle('gone', !att.length);
    $('#home-attention').innerHTML = att.map(a => `<div class="alert ${a.severity === 'HIGH' ? 'al-red' : a.severity === 'MEDIUM' ? 'al-amber' : 'al-blue'}" data-action="${esc(a.action || '')}" style="cursor:pointer"><i class="ti ${a.severity === 'HIGH' ? 'ti-alert-octagon' : 'ti-alert-triangle'}"></i><div><b>${esc(a.title)}</b><div class="hint">${esc(a.detail || '')}</div></div></div>`).join('');
    $('#home-attention').onclick = (ev) => {
      const a = ev.target.closest('[data-action]'); if (!a) return;
      const map = { documents: () => H2B.sv('profile', { subtab: 'cvs' }), queue: () => H2B.sv('logs'), gmail: () => H2B.sv('settings'), profile: () => H2B.sv('profile'), integration: () => H2B.sv('settings') };
      (map[a.dataset.action] || (() => H2B.sv('settings')))();
    };
    // Próximo passo: o primeiro item que falta na jornada.
    const steps = [];
    const p = state.profile || {};
    if (!p.fullName || !p.email) steps.push({ t: 'Preencha nome e e-mail', s: 'Sem isso nenhuma candidatura sai.', go: () => H2B.sv('profile', { subtab: 'me' }) });
    if (att.some(a => a.action === 'documents')) steps.push({ t: 'Envie seu currículo em PDF', s: 'Vai como anexo em toda candidatura.', go: () => H2B.profile.openEditor() });
    const s = state.senders;
    if (s && !s.active && !(d.integration && d.integration.gmailConnected)) steps.push({ t: 'Conecte uma conta Gmail', s: 'De onde os e-mails vão sair. Mais de uma = mais alcance.', go: () => H2B.sv('settings') });
    if (state.templates && !state.templates.recommended) steps.push({ t: 'Cadastre 3 assuntos e 3 corpos', s: 'Evita e-mails idênticos em massa.', go: () => H2B.profile.openEditor() });
    if (!d.integration.configured) steps.push({ t: 'Configure o feed do DOL', s: 'É de onde as vagas vêm.', go: () => H2B.sv('settings') });
    if (!steps.length && !H2B.autoIsOn()) steps.push({ t: 'Ligue o envio automático', s: 'Tudo pronto. O robô cuida do resto.', go: () => H2B.send.openAuto() });
    const ns = $('#home-next-step');
    ns.classList.toggle('gone', !steps.length);
    if (steps.length) { $('#home-next-title').textContent = steps[0].t; $('#home-next-sub').textContent = steps[0].s; $('#home-next-btn').onclick = steps[0].go; ns.onclick = (ev) => { if (!ev.target.closest('button')) steps[0].go(); }; }
    if (!state.templates) { try { const t = await API.seasonal.templates(); const sN = t.subjects.filter(x => x.active).length, bN = t.bodies.filter(x => x.active).length; state.templates = { subjects: sN, bodies: bN, minimum: 3, ready: sN >= 1 && bN >= 1, recommended: sN >= 3 && bN >= 3 }; } catch (e) { /* */ } }
  }

  // ═══════════════════════════════════════════════════════════ HISTÓRICO

  const hs = { items: [], q: '' };
  async function renderHist() {
    const list = $('#hist-list');
    list.innerHTML = '<div class="skel" style="height:80px"></div>';
    try {
      const [sent, stats] = await Promise.all([API.seasonal.sent(), API.seasonal.stats()]);
      hs.items = sent.applications || [];
      $('#hst-total').textContent = stats.total; $('#hst-today').textContent = stats.today; $('#hst-7').textContent = stats.last7; $('#hst-emp').textContent = stats.employers;
      $('#sb-hist-badge').textContent = stats.total;
      $('#hist-sub').textContent = `${stats.total} candidatura(s) enviada(s) · fuso ${stats.timezone}`;
    } catch (e) { list.innerHTML = `<div class="empty-state"><p>${esc(e.message)}</p></div>`; return; }
    drawHist();
  }
  function drawHist() {
    const q = hs.q.toLowerCase();
    const hidden = state.prefs.hist_reset_at || null;
    const items = hs.items.filter(i => (!hidden || i.sent_at > hidden) && (!q || [i.employer_name, i.subject, i.recipient_email, i.job_order_id].join(' ').toLowerCase().includes(q)));
    $('#hist-list').innerHTML = items.length ? items.map(i => `
      <div class="hcard" data-hist="${i.id}"><div class="hcard-main">
        <div class="hcard-top"><div class="hcard-job">${esc(i.subject)}</div><span class="tag ${i.status === 'SENT' ? 'tg' : 'ta'}">${esc(i.status)}</span></div>
        <div class="hcard-co"><i class="ti ti-building"></i> ${esc(i.employer_name)}</div>
        <div class="hcard-to"><i class="ti ti-mail"></i><span>${esc(i.recipient_email)}</span></div>
        <div class="hcard-footer"><span class="tag">#${esc(i.job_order_id)}</span><span class="tag">${fmtDateTime(i.sent_at)}</span>${(safeJson(i.attachments_json, []) || []).length ? `<span class="tag tb">📎 ${safeJson(i.attachments_json, []).length}</span>` : ''}</div>
      </div></div>`).join('')
      : `<div class="empty-state"><i class="ti ti-send-off"></i><p>Nada enviado ainda</p><small>${hidden ? 'O histórico foi limpo visualmente. ' : ''}Quando um e-mail sair, ele aparece aqui com o texto completo.</small></div>`;
  }
  function safeJson(s, f) { try { return JSON.parse(s || ''); } catch (e) { return f; } }
  function openHist(id) {
    const i = hs.items.find(x => x.id === Number(id)); if (!i) return;
    const att = safeJson(i.attachments_json, []) || [];
    $('#hm-title').textContent = i.employer_name; $('#hm-sub').textContent = `${fmtDateTime(i.sent_at)} · ${i.recipient_email}`;
    $('#hm-body').innerHTML = `
      <div class="chip-row"><div class="chip" style="flex:1 1 100%"><div class="chip-l">Assunto</div><div class="chip-v">${esc(i.subject)}</div></div><div class="chip"><div class="chip-l">Ordem</div><div class="chip-v">#${esc(i.job_order_id)}</div></div><div class="chip"><div class="chip-l">Status</div><div class="chip-v">${esc(i.status)}</div></div></div>
      <div class="prof-mini"><div class="prof-mini-lbl">Texto enviado</div><div style="font-size:13px;line-height:1.6;white-space:pre-wrap">${esc(i.content_sent || '')}</div></div>
      <div style="margin-top:8px;display:flex;gap:5px;flex-wrap:wrap">${att.map(a => `<span class="tag tb">📎 ${esc(a.filename || a)}</span>`).join('') || '<span class="tag ta">sem anexos</span>'}</div>`;
    $('#hm-foot').innerHTML = `<button class="btn btn-secondary" data-close="hist-modal">Fechar</button><button class="btn btn-primary" id="hm-job" style="flex:1"><i class="ti ti-briefcase"></i> Ver vaga</button>`;
    $('#hm-job').onclick = () => { closeModal('hist-modal'); H2B.sv('jobs', { jobId: i.seasonal_job_id }); };
    openModal('hist-modal');
  }
  function exportCsv() {
    const rows = [['data', 'empresa', 'ordem', 'destinatario', 'assunto', 'status']].concat(hs.items.map(i => [i.sent_at, i.employer_name, i.job_order_id, i.recipient_email, i.subject, i.status]));
    const csv = rows.map(r => r.map(v => `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })); a.download = `historico-h2dream-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  }

  // ═══════════════════════════════════════════════════════════ PESQUISA

  const pq = { q: '', src: 'all', timer: null };
  async function runSearch() {
    const q = pq.q.trim();
    const out = $('#pesq-results');
    $('#pesq-hint').classList.toggle('gone', q.length >= 2);
    if (q.length < 2) { out.innerHTML = ''; return; }
    out.innerHTML = '<div class="skel" style="height:60px;margin:0 12px"></div>';
    const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
    const hl = (s) => esc(s).replace(re, '<span class="pesq-highlight">$1</span>');
    const html = [];
    try {
      if (pq.src !== 'hist') {
        const p = { q, limit: 60, view: 'all' };
        if (pq.src === 'H-2A' || pq.src === 'H-2B') p.visaType = pq.src;
        const r = await API.seasonal.listJobs(p);
        (r.jobs || []).forEach(j => html.push(`<div class="pesq-result-card" data-job="${j.id}"><span class="pesq-src-badge pesq-src-seasonal">vaga</span><div class="pesq-result-title">${hl(j.job_title)}</div><div class="pesq-result-co">${hl(j.employer_name)}</div><div class="pesq-result-meta">${visaTag(j.visa_type)}<span class="pesq-result-pill tag">${hl((j.employer_city || '') + ', ' + (j.employer_state || ''))}</span><span class="pesq-result-pill tag tg">${money(j.wage_rate, j.wage_unit)}</span><span class="pesq-result-pill tag">#${hl(j.job_order_id)}</span>${j.is_applied ? '<span class="pesq-result-pill tag tg">✓ enviada</span>' : ''}</div></div>`));
      }
      if (pq.src === 'all' || pq.src === 'hist') {
        if (!hs.items.length) { try { hs.items = (await API.seasonal.sent()).applications || []; } catch (e) { /* */ } }
        hs.items.filter(i => [i.employer_name, i.subject, i.recipient_email, i.job_order_id].join(' ').toLowerCase().includes(q.toLowerCase())).slice(0, 40)
          .forEach(i => html.push(`<div class="pesq-result-card" data-hist="${i.id}"><span class="pesq-src-badge pesq-src-hist">histórico</span><div class="pesq-result-title">${hl(i.subject)}</div><div class="pesq-result-co">${hl(i.employer_name)}</div><div class="pesq-result-meta"><span class="pesq-result-pill tag">${hl(i.recipient_email)}</span><span class="pesq-result-pill tag">${fmtDateTime(i.sent_at)}</span></div></div>`));
      }
    } catch (e) { err(e); }
    out.innerHTML = html.join('') || `<div class="empty-state"><i class="ti ti-zoom-cancel"></i><p>Nada encontrado para “${esc(q)}”</p></div>`;
  }

  // ═══════════════════════════════════════════════════════════ LOGS

  const lg = { queue: [], logs: [], q: '', status: 'all' };
  async function renderLogs() {
    try {
      const [qr, lr, st] = await Promise.all([API.seasonal.queue({ limit: 300 }), API.seasonal.logs(), API.seasonal.stats()]);
      lg.queue = qr.queue || []; lg.logs = lr.logs || []; state.quota = qr.quota;
      $('#lg-sent').textContent = `${st.today}/${st.dailyLimit}`;
      $('#lg-queue').textContent = lg.queue.filter(i => i.status === 'QUEUED' || i.status === 'DEFERRED').length;
      $('#lg-review').textContent = lg.queue.filter(i => i.status === 'AWAITING_REVIEW').length;
      $('#lg-failed').textContent = lg.queue.filter(i => i.status === 'FAILED').length;
      const max = Math.max(1, ...st.series.map(x => x.n));
      $('#logs-chart').innerHTML = st.series.map(x => `<div class="chart-bar" data-v="${x.n}" style="height:${Math.round(x.n / max * 100)}%"></div>`).join('');
      $('#logs-chart-lbl').innerHTML = st.series.map(x => `<div class="chart-lbl">${x.day.slice(8)}</div>`).join('');
    } catch (e) { err(e); }
    drawLogs();
  }
  const ST = { SENT: 'ls-enviado', FAILED: 'ls-falhou', QUEUED: 'ls-sistema', DEFERRED: 'ls-pausado', AWAITING_REVIEW: 'ls-duplicado', SKIPPED: 'ls-pulado', CANCELLED: 'ls-cancelado' };
  const STL = { SENT: 'enviado', FAILED: 'falhou', QUEUED: 'na fila', DEFERRED: 'adiado', AWAITING_REVIEW: 'revisão', SKIPPED: 'pulado', CANCELLED: 'cancelado' };
  function drawLogs() {
    const q = lg.q.toLowerCase();
    const items = lg.queue.filter(i => (lg.status === 'all' || i.status === lg.status) && (!q || [i.employer_name, i.job_title, i.recipient_email, i.last_error].join(' ').toLowerCase().includes(q)));
    $('#logs-list').innerHTML = items.length ? items.map(i => `
      <div class="log-entry" data-job="${i.job_id}" ${i.status === 'AWAITING_REVIEW' ? `data-pkg="${i.package_id}"` : ''}>
        <span class="log-status ${ST[i.status] || 'ls-sistema'}">${STL[i.status] || i.status}</span>
        <div class="log-main"><div class="log-company">${esc(i.job_title)} — ${esc(i.employer_name)}</div><div class="log-email">${esc(i.recipient_email)}</div>
          <div class="log-meta">${visaTag(i.visa_type)} ${i.attempts ? `· ${i.attempts} tentativa(s)` : ''} ${i.next_attempt_at ? `· próxima ${fmtDateTime(i.next_attempt_at)}` : ''} ${i.status === 'AWAITING_REVIEW' ? '· <b style="color:var(--purple)">toque para aprovar</b>' : ''}</div>
          ${i.last_error ? `<div class="log-error">${esc(i.last_error)}</div>` : ''}${(i.reviewReasons || []).length ? `<div class="log-error" style="color:var(--purple)">${i.reviewReasons.map(r => esc(typeof r === 'string' ? r : r.message || r.label || '')).join(' · ')}</div>` : ''}</div>
        <span class="log-date">${fmtDateTime(i.sent_at || i.created_at)}</span>
      </div>`).join('') : '<div class="empty-state"><i class="ti ti-inbox"></i><p>Fila vazia</p><small>Prepare uma candidatura nas vagas ou ligue o envio automático.</small></div>';
    const sys = lg.logs.filter(l => !q || [l.action, l.message].join(' ').toLowerCase().includes(q)).slice(0, 80);
    $('#syslogs-list').innerHTML = sys.length ? sys.map(l => `<div class="log-entry" style="cursor:default"><span class="log-status ${l.level === 'error' ? 'ls-falhou' : l.level === 'warn' ? 'ls-duplicado' : 'ls-sistema'}">${esc(l.level)}</span><div class="log-main"><div class="log-company">${esc(l.action)}</div><div class="log-meta">${esc(l.message)}</div></div><span class="log-date">${fmtDateTime(l.timestamp)}</span></div>`).join('') : '<div class="empty-state"><p>Sem eventos.</p></div>';
  }

  // ═══════════════════════════════════════════════════════════ NOTIFICAÇÕES

  const NK = { sent: '✉️', failed: '⚠️', quota: '⛔', import: '📥', system: '🔔', review: '👀', sender: '📮' };
  async function renderNotif() {
    await H2B.loadNotifications();
    const n = state.notifications.notifications || [];
    $('#notif-list').innerHTML = n.length ? n.map(x => `<div class="notif-card ${x.read ? '' : 'unread'}" data-nid="${x.id}" ${x.link ? `data-link="${esc(x.link)}"` : ''}><div class="notif-ico" style="background:var(--sf3)">${NK[x.kind] || '🔔'}</div><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:800">${esc(x.title)}</div>${x.body ? `<div class="hint">${esc(x.body)}</div>` : ''}<div class="hint" style="margin-top:3px">${H2B.relTime(x.created_at)} atrás</div></div></div>`).join('')
      : '<div class="empty-state"><i class="ti ti-bell-off"></i><p>Sem notificações</p><small>Envios, falhas, cota e importações aparecem aqui.</small></div>';
    API.seasonal.readNotifications(null).then(() => H2B.loadNotifications()).catch(() => {});
  }

  // ═══════════════════════════════════════════════════════════ NOTÍCIAS

  async function renderNews() {
    const el = $('#news-list');
    el.innerHTML = '<div class="skel" style="height:80px"></div>';
    try {
      const [searches, facets, sched] = await Promise.all([API.seasonal.searches(), API.seasonal.facets(), API.core.schedulerHistory({ taskId: 'seasonal_import', limit: 10 })]);
      const runs = (searches.searches || []).slice(0, 10);
      const t = facets.totals || {};
      const html = [];
      html.push(`<div class="news-card"><h3>📊 Situação do feed</h3><div class="news-date">${t.lastFeed ? 'última publicação vista: ' + H2B.fmtUSDate(t.lastFeed) : 'sem publicação registrada'}</div><p>${t.total || 0} vagas abertas · ${t.h2a || 0} H-2A · ${t.h2b || 0} H-2B · ${t.withEmail || 0} com e-mail de candidatura.</p></div>`);
      runs.forEach(r => {
        const m = safeJson(r.metrics_json || r.result_json, null) || {};
        const errs = safeJson(r.errors_json, []) || [];
        html.push(`<div class="news-card"><h3>${errs.length ? '⚠️ Importação com erro' : '📥 Importação do DOL'}</h3><div class="news-date">${fmtDateTime(r.created_at || r.started_at)} · ${r.duration_ms ? Math.round(r.duration_ms / 1000) + 's' : ''}</div><p>${errs.length ? esc(errs.join('; ')) : `${r.results_found != null ? r.results_found + ' recebidas' : ''}${r.new_results != null ? ' · ' + r.new_results + ' novas' : ''}${r.analyzed != null ? ' · ' + r.analyzed + ' analisadas' : ''}${r.recommended != null ? ' · ' + r.recommended + ' recomendadas' : ''}${r.filtered_out ? ' · ' + r.filtered_out + ' filtradas' : ''}` || 'Concluída.'}</p></div>`);
      });
      ((sched && sched.history) || []).slice(0, 5).forEach(h => html.push(`<div class="news-card"><h3>🤖 Robô de importação — ${esc(h.status)}</h3><div class="news-date">${fmtDateTime(h.finished_at || h.started_at)}</div><p>${esc(h.message || '')}</p></div>`));
      el.innerHTML = html.join('');
    } catch (e) { el.innerHTML = `<div class="empty-state"><p>${esc(e.message)}</p></div>`; }
  }

  // ═══════════════════════════════════════════════════════════ CONFIGURAÇÕES

  /**
   * Domínio configurado no servidor ≠ domínio pelo qual o usuário está
   * acessando: é a causa do "redirect_uri_mismatch" do Google. Mostra o que
   * mudar, em vez de deixar o botão mandar o usuário para um erro 400.
   */
  function domainAlert(creds) {
    const d = creds && creds.domain;
    if (!d || !d.mismatch) return '';
    return `<div class="alert al-red"><i class="ti ti-world-off"></i><div><b>Domínio do servidor não bate com este endereço.</b>
      O servidor está configurado para <code>${esc(d.configuredHosts.join(', '))}</code>, mas você está em <code>${esc(d.requestHost)}</code> — o Google vai recusar com <i>redirect_uri_mismatch</i>.
      <div class="hint" style="margin-top:6px">No servidor: <code>npm run domain -- ${esc(d.requestHost)}</code> (ou ajuste ${esc((d.variablesToFix || []).join(', ') || 'APP_BASE_URL')} no .env / painel da hospedagem) e reinicie.
      Depois cadastre no Google Cloud: <code>${esc(d.expectedGmailRedirectUri)}</code> e <code>${esc(d.expectedSigninRedirectUri)}</code>.</div></div></div>`;
  }

  async function renderSettings() {
    const el = $('#settings-body');
    el.innerHTML = '<div class="skel" style="height:120px"></div>';
    let cfg, senders, creds, gmail, sched, discarded = [];
    try {
      [cfg, senders, creds, gmail, sched] = await Promise.all([API.seasonal.getConfig(), API.gmailSenders.list(), API.googleCredentials.status(), API.seasonal.gmailStatus(), API.core.scheduler()]);
      cfg = cfg.config; state.senders = senders; state.scheduler = sched;
      discarded = (await API.seasonal.listJobs({ view: 'discarded', limit: 50 })).jobs || [];
    } catch (e) { el.innerHTML = `<div class="empty-state"><p>${esc(e.message)}</p></div>`; return; }
    const mode = H2B.ls('h2b_screen_mode') || 'auto';
    const q = state.quota || {};
    el.innerHTML = `
      <div style="font-family:'Sora',sans-serif;font-size:19px;font-weight:800;margin-bottom:12px">Configurações</div>

      <div class="prof-card" style="margin-bottom:12px">
        <div class="prof-card-hd"><i class="ti ti-target"></i><span>Foco das candidaturas</span><span class="tag ${Number(cfg.require_truck_driver_match) === 1 ? 'ta' : 'tg'}" style="margin-left:auto">${Number(cfg.require_truck_driver_match) === 1 ? 'só caminhão' : 'todas as vagas'}</span></div>
        <div class="prof-card-bd">
          <div class="source-btns" style="grid-template-columns:1fr 1fr">
            <button class="source-btn ${Number(cfg.require_truck_driver_match) !== 1 ? 'sel' : ''}" data-focus="0"><div class="source-btn-icon">🌎</div><div class="source-btn-label">Todas as vagas</div><div class="source-btn-count">colheita, hotelaria, construção, paisagismo, fábrica, caminhão…</div></button>
            <button class="source-btn ${Number(cfg.require_truck_driver_match) === 1 ? 'sel' : ''}" data-focus="1"><div class="source-btn-icon">🚛</div><div class="source-btn-label">Só motorista de caminhão</div><div class="source-btn-count">SOC 53-3032 confirmado pelo portão</div></button>
          </div>
          <div class="hint">Ao trocar, todas as vagas já importadas passam de novo pela cadeia de decisão. O Truth Guard continua igual: nenhum e-mail afirma o que o seu perfil não sustenta.</div>
        </div>
      </div>

      <div class="prof-card" style="margin-bottom:12px">
        <div class="prof-card-hd"><i class="ti ti-brand-google"></i><span>Contas de envio (Gmail)</span><span class="tag ${senders.active ? 'tg' : 'tr'}" style="margin-left:auto">${senders.active} ativa(s)</span></div>
        <div class="prof-card-bd">
          ${domainAlert(creds)}
          ${!creds.configured ? `<div class="alert al-amber"><i class="ti ti-key"></i><div><b>Credenciais do Google ainda não configuradas.</b> Preencha abaixo antes de conectar contas.</div></div>` : ''}
          ${senders.singleAccountWarning && senders.active <= 1 ? `<div class="alert al-blue"><i class="ti ti-info-circle"></i><div>Com uma conta só, tudo sai dela. Conecte 2–3 contas: o sistema alterna e ninguém passa do limite.</div></div>` : ''}
          ${(senders.senders || []).map(s => `<div class="doc-file-card" style="flex-wrap:wrap">
              <div class="doc-file-icon" style="background:${s.isActive ? 'var(--greenl)' : 'var(--sf3)'}">📮</div>
              <div style="flex:1;min-width:140px"><div class="doc-file-name">${esc(s.email)} ${s.isPrimary ? '<span class="tag tb">principal</span>' : ''}</div><div class="doc-file-size">hoje ${s.todaySent}/${s.todayLimit} · ${s.limitSource}${s.lastError ? ` · <span style="color:var(--red)">${esc(s.errorClass || 'erro')}</span>` : ''}</div></div>
              <input class="input sender-limit" type="number" min="1" max="${senders.providerHardLimit}" value="${s.dailyLimit || ''}" placeholder="auto" data-limit="${s.id}" style="width:74px;height:32px;padding:4px 8px" title="Limite diário desta conta">
              <button class="btn btn-secondary btn-xs" data-toggle="${s.id}" data-active="${s.isActive ? 1 : 0}">${s.isActive ? 'Pausar' : 'Ativar'}</button>
              <button class="btn btn-secondary btn-xs" data-remove="${s.id}"><i class="ti ti-trash"></i></button>
            </div>`).join('') || (gmail.connected ? `<div class="doc-file-card"><div class="doc-file-icon" style="background:var(--greenl)">📮</div><div style="flex:1"><div class="doc-file-name">${esc(gmail.user)}</div><div class="doc-file-size">conta principal (modo antigo)</div></div></div>` : '<div class="hint">Nenhuma conta conectada.</div>')}
          <div class="hint">Capacidade hoje: <b>${senders.dailyCapacity}</b> de ${senders.globalCap} (teto do sistema ${q.absoluteCap || 300}).</div>
          <button class="btn btn-primary" id="st-add-sender" ${creds.configured ? '' : 'disabled'}><i class="ti ti-plus"></i> Conectar outra conta Gmail</button>
        </div>
      </div>

      <div class="prof-card" style="margin-bottom:12px">
        <div class="prof-card-hd"><i class="ti ti-key"></i><span>Credenciais do Google (OAuth)</span><span class="tag ${creds.configured ? 'tg' : 'ta'}" style="margin-left:auto">${creds.configured ? 'ok' : 'faltando'}</span></div>
        <div class="prof-card-bd">
          ${creds.managedByEnv ? '<div class="hint">Definidas pelo ambiente do servidor (.env). Não editáveis aqui.</div>' : `
          <div class="field"><label>Client ID</label><input class="input" id="st-cid" placeholder="xxxx.apps.googleusercontent.com" value="${creds.hasClientId ? esc(creds.clientIdMasked || '') : ''}"></div>
          <div class="field"><label>Client Secret ${creds.hasClientSecret ? '<span class="tag tg">guardado (criptografado)</span>' : ''}</label><input class="input" id="st-csec" type="password" placeholder="${creds.hasClientSecret ? '•••••••• (deixe vazio para manter)' : 'GOCSPX-…'}"></div>
          <div class="hint">URIs para cadastrar no Google Cloud ("URIs de redirecionamento autorizados"):<br><code>${esc(creds.gmailRedirectUri || '')}</code><br><code>${esc(creds.signinRedirectUri || '')}</code><br>Domínio do sistema: <code>${esc(creds.baseUrl || '')}</code> ${creds.baseUrlSource === 'env' ? '(APP_BASE_URL)' : '(derivado do endereço de acesso — defina APP_BASE_URL em produção)'}</div>
          <div style="display:flex;gap:6px"><button class="btn btn-primary btn-sm" id="st-save-creds"><i class="ti ti-device-floppy"></i> Salvar</button><a class="btn btn-secondary btn-sm" href="${esc(creds.consoleUrl)}" target="_blank" rel="noopener">Google Cloud ↗</a></div>`}
        </div>
      </div>

      <div class="prof-card" style="margin-bottom:12px">
        <div class="prof-card-hd"><i class="ti ti-rss"></i><span>Feed do DOL (vagas)</span><span class="tag ${cfg.health_status === 'HEALTHY' ? 'tg' : cfg.health_status === 'ERROR' ? 'tr' : 'ta'}" style="margin-left:auto">${esc(cfg.health_status)}</span></div>
        <div class="prof-card-bd">
          <div class="field"><label>URL do feed</label><input class="input" id="st-feed" value="${esc(cfg.dol_feed_url || '')}" placeholder="https://…"></div>
          <div class="hint">Última importação OK: ${cfg.last_success_at ? fmtDateTime(cfg.last_success_at) : '—'}${cfg.last_error ? ` · último erro: <span style="color:var(--red)">${esc(cfg.last_error)}</span>` : ''}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-primary btn-sm" id="st-save-feed"><i class="ti ti-device-floppy"></i> Salvar</button><button class="btn btn-secondary btn-sm" id="st-test-feed"><i class="ti ti-plug"></i> Testar</button><button class="btn btn-secondary btn-sm" id="st-import"><i class="ti ti-download"></i> Importar agora</button></div>
        </div>
      </div>

      <div class="prof-card" style="margin-bottom:12px">
        <div class="prof-card-hd"><i class="ti ti-gauge"></i><span>Limites e pausa</span></div>
        <div class="prof-card-bd">
          <div class="field"><label>Limite global por dia (teto ${q.absoluteCap || 300})</label><input class="input" id="st-limit" type="number" min="1" max="${q.absoluteCap || 300}" value="${cfg.daily_email_limit}"></div>
          <div class="field"><label>Fuso horário da cota</label><div class="hint">${esc(q.timezone || '—')} · vira em ${q.reset ? fmtDateTime(q.reset) : '—'}</div></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-primary btn-sm" id="st-save-limit"><i class="ti ti-device-floppy"></i> Salvar limite</button>
            ${cfg.pause_email_sending ? '<button class="btn btn-success btn-sm" id="st-unpause"><i class="ti ti-player-play"></i> Retomar envios</button>' : '<button class="btn btn-danger btn-sm" id="st-pause"><i class="ti ti-player-pause"></i> Pausar todos os envios</button>'}</div>
        </div>
      </div>

      <div class="prof-card" style="margin-bottom:12px">
        <div class="prof-card-hd"><i class="ti ti-robot"></i><span>Agendador (robôs)</span><span class="tag ${sched.enabled ? 'tg' : 'ta'}" style="margin-left:auto">${sched.enabled ? 'ligado' : 'desligado'}</span></div>
        <div class="prof-card-bd">
          ${(sched.tasks || []).map(t => `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12.5px"><span class="tag ${t.enabled ? 'tg' : ''}">${t.enabled ? 'on' : 'off'}</span><div style="flex:1;min-width:0"><b>${esc(t.label || t.id)}</b><div class="hint">a cada ${t.interval_minutes} min · última: ${t.last_run_at ? fmtDateTime(t.last_run_at) : '—'} ${t.last_status ? '· ' + esc(t.last_status) : ''}</div></div><button class="btn btn-secondary btn-xs" data-run="${t.id}">Rodar</button></div>`).join('')}
          <div style="display:flex;gap:6px"><button class="btn ${sched.enabled ? 'btn-secondary' : 'btn-primary'} btn-sm" id="st-sched">${sched.enabled ? 'Desligar agendador' : 'Ligar agendador'}</button></div>
        </div>
      </div>

      <div class="prof-card" style="margin-bottom:12px">
        <div class="prof-card-hd"><i class="ti ti-palette"></i><span>Aparência</span></div>
        <div class="prof-card-bd">
          <div style="display:flex;gap:6px"><button class="btn btn-secondary btn-sm" id="st-theme"><i class="ti ti-moon"></i> Alternar tema</button></div>
          <div class="field"><label>Modo de tela</label><div style="display:flex;gap:4px">${['auto', 'cel', 'pc'].map(m => `<button class="mode-sel-btn ${mode === m ? 'active' : ''}" data-mode2="${m}"><i class="ti ${m === 'auto' ? 'ti-device-desktop-analytics' : m === 'cel' ? 'ti-device-mobile' : 'ti-device-laptop'}"></i> ${m === 'auto' ? 'Automático' : m === 'cel' ? 'Celular' : 'Computador'}</button>`).join('')}</div></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-secondary btn-sm" id="st-tour"><i class="ti ti-compass"></i> Rever o tour</button><button class="btn btn-secondary btn-sm" id="st-ob"><i class="ti ti-refresh"></i> Refazer primeiro acesso</button><button class="btn btn-secondary btn-sm" id="st-hist-reset"><i class="ti ti-eraser"></i> Limpar histórico (visual)</button></div>
        </div>
      </div>

      <div class="prof-card">
        <div class="prof-card-hd"><i class="ti ti-trash"></i><span>Vagas descartadas</span><span class="tag" style="margin-left:auto">${discarded.length}</span></div>
        <div class="prof-card-bd">
          ${discarded.map(j => `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12.5px"><div style="flex:1;min-width:0"><b>${esc(j.job_title)}</b><div class="hint">${esc(j.employer_name)} · ${esc(j.employer_state || '')}</div></div><button class="btn btn-secondary btn-xs" data-restore="${j.id}">Restaurar</button></div>`).join('') || '<div class="hint">Nenhuma.</div>'}
        </div>
      </div>
      <div class="hint" style="margin-top:14px;text-align:center">H2 Dream · uso pessoal · dados neste servidor<br><a href="/privacidade" target="_blank" rel="noopener" style="color:var(--blue)">Política de Privacidade</a> · <a href="/termos" target="_blank" rel="noopener" style="color:var(--blue)">Termos de Serviço</a></div>
    `;

    // --- wiring ---
    const addBtn = $('#st-add-sender'); if (addBtn) addBtn.onclick = async () => {
      // A janela abre ANTES do await: depois de uma resposta de rede o clique já
      // não conta como gesto do usuário e o bloqueador de popup engole o open.
      const popup = window.open('about:blank', 'gmail-oauth', 'width=520,height=680');
      try {
        const r = await API.gmailSenders.addUrl();
        if (popup) { popup.location.href = r.url; toast('Autorize a conta na janela do Google'); }
        else { window.location.href = r.url; }
      } catch (e) { if (popup) popup.close(); err(e); }
    };
    el.onclick = async (ev) => {
      const t = ev.target.closest('[data-toggle]'); if (t) { try { await API.gmailSenders.setActive(t.dataset.toggle, t.dataset.active !== '1'); toast('Conta atualizada', 'ok'); renderSettings(); } catch (e) { err(e); } return; }
      const rm = ev.target.closest('[data-remove]'); if (rm) { H2B.warn({ icon: '📮', title: 'Remover esta conta?', text: 'Ela deixa de enviar. Você pode conectar de novo depois.', danger: 'Remover', okLabel: 'Cancelar', onDanger: async () => { try { await API.gmailSenders.remove(rm.dataset.remove); toast('Conta removida'); renderSettings(); } catch (e) { err(e); } } }); return; }
      const run = ev.target.closest('[data-run]'); if (run) { run.disabled = true; try { const r = await API.core.runTask(run.dataset.run); toast(r.message || r.status || 'Rodou', 'ok'); renderSettings(); } catch (e) { err(e); run.disabled = false; } return; }
      const rs = ev.target.closest('[data-restore]'); if (rs) { try { await API.seasonal.saveJob(rs.dataset.restore, ''); toast('Vaga restaurada (nas salvas)', 'ok'); renderSettings(); } catch (e) { err(e); } return; }
      const fc = ev.target.closest('[data-focus]'); if (fc) {
        const want = Number(fc.dataset.focus);
        if (want === (Number(cfg.require_truck_driver_match) === 1 ? 1 : 0)) return;
        fc.disabled = true; toast('Reclassificando as vagas…');
        try {
          const r = await API.seasonal.saveConfig({ require_truck_driver_match: want });
          state.truckFocus = want === 1; state.config = r.config;
          toast(`Foco: ${want === 1 ? 'só caminhão' : 'todas as vagas'}${r.reprocessed ? ` · ${r.reprocessed.processed} vaga(s) reclassificada(s)` : ''}`, 'ok');
          await H2B.refreshCore(); renderSettings();
        } catch (e) { err(e); fc.disabled = false; }
        return;
      }
      const md = ev.target.closest('[data-mode2]'); if (md) { H2B.applyMode(md.dataset.mode2); H2B.savePrefs({ screen_mode: md.dataset.mode2 }); $$('[data-mode2]', el).forEach(b => b.classList.toggle('active', b === md)); return; }
    };
    el.onchange = async (ev) => { const l = ev.target.closest('[data-limit]'); if (l) { try { await API.gmailSenders.setLimit(l.dataset.limit, l.value === '' ? null : Number(l.value)); toast('Limite da conta salvo', 'ok'); } catch (e) { err(e); } } };
    const sc = $('#st-save-creds'); if (sc) sc.onclick = async () => { try { const id = $('#st-cid').value.trim(); const sec = $('#st-csec').value; if (!id) { toast('Informe o Client ID', 'err'); return; } await API.googleCredentials.save(id, sec || undefined); toast('Credenciais salvas', 'ok'); renderSettings(); } catch (e) { err(e); } };
    $('#st-feed').onchange = async () => { try { await API.seasonal.saveConfig({ dol_feed_url: $('#st-feed').value.trim() }); H2B.saved('Feed'); } catch (e) { err(e); } };
    $('#st-limit').onchange = async () => { try { await API.seasonal.saveConfig({ daily_email_limit: Number($('#st-limit').value) }); H2B.saved('Limite diário'); await H2B.refreshCore(); } catch (e) { err(e); } };
    $('#st-save-feed').onclick = async () => { try { await API.seasonal.saveConfig({ dol_feed_url: $('#st-feed').value.trim() }); toast('Feed salvo', 'ok'); renderSettings(); } catch (e) { err(e); } };
    $('#st-test-feed').onclick = async () => { const b = $('#st-test-feed'); b.disabled = true; try { const r = await API.seasonal.testIntegration(); toast(r.message || (r.ok || r.success ? 'Feed OK' : 'Falhou'), r.ok || r.success ? 'ok' : 'err'); } catch (e) { err(e); } b.disabled = false; };
    $('#st-import').onclick = async () => { const b = $('#st-import'); b.disabled = true; b.innerHTML = '<span class="spin spin-sm"></span> Importando…'; try { const r = await API.seasonal.import({}); const m = r.metrics || {}; const q = (m.autoQueued && m.autoQueued.queued) || 0; toast(`Feed do DOL: ${m.received || 0} recebidas · ${m.newJobs || 0} novas · ${m.analyzed || 0} analisadas · ${m.recommended || 0} recomendadas${q ? ' · ' + q + ' na fila' : ''}`, 'ok', 7000); if (m.warnings && m.warnings.length) toast(m.warnings[0], undefined, 8000); await H2B.refreshCore(); renderSettings(); } catch (e) { err(e); b.disabled = false; b.innerHTML = '<i class="ti ti-download"></i> Importar agora'; } };
    $('#st-save-limit').onclick = async () => { try { await API.seasonal.saveConfig({ daily_email_limit: Number($('#st-limit').value) }); toast('Limite salvo', 'ok'); await H2B.refreshCore(); renderSettings(); } catch (e) { err(e); } };
    const pz = $('#st-pause'); if (pz) pz.onclick = async () => { try { await API.seasonal.pause(true); toast('Envios pausados'); renderSettings(); } catch (e) { err(e); } };
    const up = $('#st-unpause'); if (up) up.onclick = async () => { try { await API.seasonal.pause(false); toast('Envios retomados', 'ok'); renderSettings(); } catch (e) { err(e); } };
    $('#st-sched').onclick = async () => { try { await API.core.schedulerEnable(!sched.enabled); toast(sched.enabled ? 'Agendador desligado' : 'Agendador ligado', 'ok'); await H2B.refreshCore(); renderSettings(); } catch (e) { err(e); } };
    $('#st-theme').onclick = H2B.toggleTheme;
    $('#st-tour').onclick = () => H2B.profile.startTour();
    $('#st-ob').onclick = () => H2B.profile.startOnboarding();
    $('#st-hist-reset').onclick = () => H2B.warn({ icon: '🧹', title: 'Limpar o histórico da tela?', text: 'Os envios continuam registrados no servidor (a proteção contra duplicados usa isso). Só a lista visível recomeça do zero.', danger: 'Limpar visual', okLabel: 'Cancelar', onDanger: () => { H2B.savePrefs({ hist_reset_at: new Date().toISOString().replace('T', ' ').slice(0, 19) }); toast('Histórico limpo na tela'); } });
  }

  // OAuth em janela filha avisa quando termina.
  window.addEventListener('message', (ev) => {
    if (ev.origin !== window.location.origin || !ev.data) return;
    if (ev.data.type === 'gmail-oauth-done') { toast('Conta Gmail conectada', 'ok'); H2B.refreshCore(); if (state.view === 'settings') renderSettings(); }
    else if (ev.data.type === 'gmail-oauth-failed') { toast(ev.data.message || 'O Google não concluiu a autorização.', 'err', 12000); }
  });

  // ═══════════════════════════════════════════════════════════ wiring

  H2B.onShow.home = renderHome;
  H2B.onShow.hist = () => { renderHist(); };
  H2B.onShow.pesquisa = () => { setTimeout(() => $('#pesq-q').focus(), 100); if (pq.q) runSearch(); };
  H2B.onShow.logs = renderLogs;
  H2B.onShow.notif = renderNotif;
  H2B.onShow.news = renderNews;
  H2B.onShow.settings = renderSettings;

  $('#hist-q').oninput = (ev) => { hs.q = ev.target.value; drawHist(); };
  $('#hist-refresh').onclick = renderHist;
  $('#hist-export').onclick = exportCsv;
  $('#hist-list').onclick = (ev) => { const c = ev.target.closest('[data-hist]'); if (c) openHist(c.dataset.hist); };
  $('#pesq-q').oninput = (ev) => { pq.q = ev.target.value; clearTimeout(pq.timer); pq.timer = setTimeout(runSearch, 260); };
  $$('.pesq-src-chip').forEach(c => c.onclick = () => { $$('.pesq-src-chip').forEach(x => x.classList.toggle('active', x === c)); pq.src = c.dataset.src; runSearch(); });
  $('#pesq-results').onclick = (ev) => {
    const j = ev.target.closest('[data-job]'); if (j) { H2B.sv('jobs', { jobId: Number(j.dataset.job) }); return; }
    const h = ev.target.closest('[data-hist]'); if (h) openHist(h.dataset.hist);
  };
  $('#logs-q').oninput = (ev) => { lg.q = ev.target.value; drawLogs(); };
  $('#logs-status').onchange = (ev) => { lg.status = ev.target.value; drawLogs(); };
  $('#logs-refresh').onclick = renderLogs;
  $('#logs-list').onclick = async (ev) => {
    const e = ev.target.closest('.log-entry'); if (!e) return;
    if (e.dataset.pkg) { H2B.warn({ icon: '👀', title: 'Aprovar esta candidatura?', text: 'Ela entra na fila e sai no próximo ciclo (ou agora, em Rodar fila).', danger: 'Aprovar e enfileirar', okLabel: 'Ver vaga', onDanger: async () => { try { await API.seasonal.approvePackage(e.dataset.pkg); toast('Aprovada', 'ok'); renderLogs(); } catch (x) { err(x); } }, onOk: () => H2B.sv('jobs', { jobId: Number(e.dataset.job) }) }); return; }
    H2B.sv('jobs', { jobId: Number(e.dataset.job) });
  };
  $('#notif-readall').onclick = async () => { try { await API.seasonal.readNotifications(null); renderNotif(); } catch (e) { err(e); } };
  $('#notif-clear').onclick = async () => { try { await API.seasonal.clearNotifications(); renderNotif(); } catch (e) { err(e); } };

  function tick() { if (state.view === 'logs') renderLogs(); else if (state.view === 'home') renderHome(); }

  return { renderHome, renderHist, renderLogs, renderSettings, renderNotif, renderNews, tick };
})();
