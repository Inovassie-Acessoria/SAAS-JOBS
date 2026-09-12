/**
 * H2 Dream — envio manual (modal) e envio automático (assistente + painel).
 *
 * Manual: prepara o pacote no servidor (currículo, carta, assunto/corpo em
 * rotação, validação + Truth Guard), mostra tudo para revisão e só então
 * despacha AQUELE pacote. Automático: grava as escolhas do assistente na
 * configuração do Seasonal, liga o agendador e acompanha a fila.
 */
H2B.send = (function () {
  const { $, $$, esc, money, fmtUSDate, visaTag, toast, err, openModal, closeModal, state } = H2B;

  const env = () => API.env('seasonal', 'US');

  // ═══════════════════════════════════════════════════════════ MANUAL

  const ms = { job: null, resumes: [], resumeId: null, prepared: null, busy: false };

  async function openManual(job) {
    if (!job) return;
    ms.job = job; ms.prepared = null; ms.resumeId = null; ms.busy = false;
    $('#sm-sub').textContent = `${job.employer_name} · ${job.employer_city || ''} ${job.employer_state || ''}`;
    $('#sm-body').innerHTML = '<div class="skel" style="height:90px"></div>';
    $('#sm-foot').innerHTML = '';
    openModal('send-modal');
    try {
      const r = await env().resumes({ docType: 'resume' });
      ms.resumes = (r.resumes || []).filter(x => x.is_active);
    } catch (e) { ms.resumes = []; }
    renderPrepare();
  }

  function recipientOf(j) { return j.application_email || j.employer_email || j.attorney_email || ''; }

  function resumeSlots(selectedId, includeAuto) {
    const auto = includeAuto ? `<div class="cv-slot ${selectedId === null ? 'sel' : ''}" data-cv="auto"><i class="ti ti-wand"></i><div style="flex:1"><b>Automático</b><div class="hint">O sistema escolhe pelo tipo de visto (H-2A / H-2B) e pelo cargo.</div></div></div>` : '';
    if (!ms.resumes.length) return auto + `<div class="alert al-amber"><i class="ti ti-file-off"></i><div>Nenhum currículo enviado. <a href="#" data-open-editor style="color:var(--blue);font-weight:700">Enviar agora</a>.</div></div>`;
    return auto + ms.resumes.map(r => `<div class="cv-slot ${selectedId === r.id ? 'sel' : ''}" data-cv="${r.id}"><i class="ti ti-file-text"></i><div style="flex:1;min-width:0"><b>${esc(r.name)}</b> ${r.is_default ? '<span class="tag tb">padrão</span>' : ''} ${r.visa_type && r.visa_type !== 'ANY' ? visaTag(r.visa_type) : ''}<div class="hint">${esc(r.original_name)} · ${Math.round((r.file_size || 0) / 1024)} KB</div></div></div>`).join('');
  }

  function renderPrepare() {
    const j = ms.job;
    const to = recipientOf(j);
    const tpl = state.templates;
    $('#sm-body').innerHTML = `
      <div class="chip-row">
        <div class="chip" style="flex:1 1 100%"><div class="chip-l">Vaga</div><div class="chip-v">${esc(j.job_title)} ${visaTag(j.visa_type)}</div></div>
        <div class="chip"><div class="chip-l">Empresa</div><div class="chip-v">${esc(j.employer_name)}</div></div>
        <div class="chip"><div class="chip-l">Para</div><div class="chip-v" style="color:var(--blue)">${esc(to || '— sem e-mail —')}</div></div>
        <div class="chip"><div class="chip-l">Salário</div><div class="chip-v">${money(j.wage_rate, j.wage_unit)}</div></div>
        <div class="chip"><div class="chip-l">Ordem</div><div class="chip-v">#${esc(j.job_order_id)}</div></div>
      </div>
      <div class="jd-section-title" style="margin-top:4px">Currículo</div>
      <div id="sm-cvs">${resumeSlots(ms.resumeId, true)}</div>
      ${tpl && !tpl.recommended ? `<div class="alert al-amber" style="margin-top:10px"><i class="ti ti-mail-opened"></i><div>${tpl.subjects || tpl.bodies ? 'Poucos modelos de e-mail cadastrados' : 'Sem modelos de e-mail'} — o sistema usa o texto padrão. <a href="#" data-open-editor style="color:var(--blue);font-weight:700">Cadastrar modelos</a></div></div>` : ''}
      <div class="hint" style="margin-top:10px">Ao preparar, o sistema monta o e-mail com seus dados, anexa currículo e cartas, e passa tudo pelo Truth Guard. Nada sai sem passar.</div>
    `;
    $('#sm-foot').innerHTML = `<button class="btn btn-secondary" data-close="send-modal">Cancelar</button><button class="btn btn-primary" id="sm-prepare" style="flex:1" ${to ? '' : 'disabled'}><i class="ti ti-sparkles"></i> Preparar e-mail</button>`;
    $('#sm-cvs').onclick = (ev) => {
      const s = ev.target.closest('[data-cv]'); if (!s) return;
      ms.resumeId = s.dataset.cv === 'auto' ? null : Number(s.dataset.cv);
      $$('#sm-cvs .cv-slot').forEach(x => x.classList.toggle('sel', x === s));
    };
    $('#sm-prepare').onclick = prepare;
    $('#sm-body').querySelectorAll('[data-open-editor]').forEach(a => a.onclick = (e) => { e.preventDefault(); closeModal('send-modal'); H2B.profile.openEditor(); });
  }

  async function prepare() {
    if (ms.busy) return;
    ms.busy = true;
    const btn = $('#sm-prepare'); if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin spin-sm"></span> Preparando…'; }
    try {
      const body = {}; if (ms.resumeId) body.resumeId = ms.resumeId;
      ms.prepared = await API.seasonal.preparePackage(ms.job.id, body);
      renderReview();
    } catch (e) { err(e); if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-sparkles"></i> Preparar e-mail'; } }
    ms.busy = false;
  }

  function renderReview() {
    const p = ms.prepared;
    const pkg = p.package || {};
    const v = p.validation || { checks: [] };
    const checks = (v.checks || []).map(c => `<div style="display:flex;gap:8px;align-items:flex-start;padding:5px 0;border-bottom:1px solid var(--border);font-size:12.5px"><span style="flex:none">${c.ok ? '✅' : (c.blocking ? '❌' : '⚠️')}</span><div style="flex:1"><b>${esc(c.label)}</b>${c.detail ? `<div class="hint">${esc(c.detail)}</div>` : ''}</div></div>`).join('');
    const att = (p.attachments || []).map(a => `<span class="tag tb">📎 ${esc(a.filename)}</span>`).join(' ') || '<span class="tag ta">sem anexos</span>';
    const passed = v.status === 'PASSED';
    const review = p.review || {};
    $('#sm-body').innerHTML = `
      ${passed ? `<div class="alert al-green"><i class="ti ti-shield-check"></i><div><b>Pronto para enviar.</b> ${review.requiresReview ? 'O sistema pediu sua revisão — leia e confirme.' : 'Validação e Truth Guard aprovaram.'}</div></div>`
               : `<div class="alert al-red"><i class="ti ti-shield-x"></i><div><b>Bloqueado.</b> ${esc((v.blockingFailures || []).join(' · ') || 'Corrija os itens em vermelho.')}</div></div>`}
      ${(review.reasons || []).length ? `<div class="alert al-amber" style="margin-top:8px"><i class="ti ti-eye"></i><div>${review.reasons.map(r => esc(typeof r === 'string' ? r : r.message || r.label || JSON.stringify(r))).join('<br>')}</div></div>` : ''}
      <div class="jd-section-title">E-mail</div>
      <div class="chip-row"><div class="chip" style="flex:1 1 100%"><div class="chip-l">Para</div><div class="chip-v" style="color:var(--blue)">${esc(pkg.recipient_email)}</div></div>
      <div class="chip" style="flex:1 1 100%"><div class="chip-l">Assunto</div><div class="chip-v">${esc(pkg.email_subject)}</div></div></div>
      <div class="prof-mini"><div class="prof-mini-lbl">Corpo</div><div style="font-size:13px;line-height:1.6;white-space:pre-wrap;max-height:260px;overflow:auto">${esc(pkg.email_body)}</div></div>
      <div style="margin-top:8px;display:flex;gap:5px;flex-wrap:wrap">${att}</div>
      ${p.resume ? `<div class="hint" style="margin-top:6px">Currículo: <b>${esc(p.resume.name)}</b> — ${esc(p.resumeReason || '')}</div>` : ''}
      <div class="jd-section-title">Verificações</div>
      <div>${checks}</div>
    `;
    $('#sm-foot').innerHTML = passed
      ? `<button class="btn btn-secondary" id="sm-back">Voltar</button><button class="btn btn-success" id="sm-send" style="flex:1"><i class="ti ti-send"></i> Enviar agora</button>`
      : `<button class="btn btn-secondary" id="sm-back">Voltar</button><button class="btn btn-primary" id="sm-fix" style="flex:1"><i class="ti ti-user-edit"></i> Corrigir perfil</button>`;
    $('#sm-back').onclick = renderPrepare;
    if (passed) $('#sm-send').onclick = sendNow;
    else $('#sm-fix').onclick = () => { closeModal('send-modal'); H2B.sv('profile', { subtab: 'me' }); };
    $('.modal .mbody', $('#send-modal')).scrollTop = 0;
  }

  async function sendNow() {
    if (ms.busy) return;
    const q = state.quota;
    if (q && q.remaining <= 0) { H2B.warn({ icon: '⛔', title: 'Cota do dia esgotada', text: `Você já enviou ${q.countSent} de ${q.maxLimit} hoje. A cota vira à meia-noite (${esc(q.timezone)}).` }); return; }
    ms.busy = true;
    const btn = $('#sm-send'); btn.disabled = true; btn.innerHTML = '<span class="spin spin-sm"></span> Enviando…';
    try {
      const pkg = ms.prepared.package;
      if (ms.prepared.review && ms.prepared.review.requiresReview) await API.seasonal.approvePackage(pkg.id);
      const r = await API.seasonal.dispatch({ max: 1, packageId: pkg.id });
      if (r.sent >= 1) {
        closeModal('send-modal');
        H2B.success('Candidatura enviada! 🎉', `E-mail para <b>${esc(pkg.recipient_email)}</b> saiu com sucesso.<br><span class="hint">${esc(ms.job.job_title)} — ${esc(ms.job.employer_name)}</span>`);
        await H2B.refreshCore();
        if (H2B.jobs) { H2B.jobs.refreshSelected(); H2B.jobs.loadFacets(); H2B.jobs.load(true); }
        H2B.loadNotifications();
      } else {
        const d = (r.details || [])[0] || {};
        const why = r.userMessage || d.error || d.reason || d.status || 'O e-mail não saiu. Veja os Logs para o motivo.';
        H2B.warn({ icon: '📭', title: 'Não foi enviado', text: esc(why) });
        btn.disabled = false; btn.innerHTML = '<i class="ti ti-send"></i> Tentar de novo';
      }
    } catch (e) { err(e); btn.disabled = false; btn.innerHTML = '<i class="ti ti-send"></i> Tentar de novo'; }
    ms.busy = false;
  }

  // ═══════════════════════════════════════════════════════════ AUTOMÁTICO

  const as = {
    step: 1,
    visa: { 'H-2A': true, 'H-2B': true },
    titles: [], states: [], minWage: '',
    resumeId: null,
    limit: 100, pace: 30, rigor: 'all', review: 'FULLY_AUTOMATIC',
    facets: null, resumes: [], cfg: null, queue: null, busy: false
  };
  const RIGOR = {
    best: { label: 'Só as melhores', fit: 85, opp: 85, ats: 75, hint: 'Poucos envios, muito bem encaixados.' },
    good: { label: 'Boas', fit: 70, opp: 70, ats: 60, hint: 'Equilíbrio entre volume e encaixe.' },
    all:  { label: 'Todas elegíveis', fit: 0, opp: 0, ats: 0, hint: 'Máximo volume. Truth Guard continua rígido.' }
  };

  function restoreFromConfig(cfg) {
    if (!cfg) return;
    as.visa = { 'H-2A': Boolean(cfg.h2a_preference), 'H-2B': Boolean(cfg.h2b_preference) };
    as.states = String(cfg.preferred_states || '').split(',').map(s => s.trim()).filter(Boolean);
    as.titles = String(cfg.preferred_occupations || '').split(',').map(s => s.trim()).filter(Boolean);
    as.minWage = cfg.min_hourly_wage ? String(cfg.min_hourly_wage) : '';
    as.limit = Number(cfg.daily_email_limit) || 100;
    as.review = cfg.email_review_mode === 'ALWAYS_REVIEW' ? 'REVIEW_FLAGGED' : (cfg.email_review_mode || 'FULLY_AUTOMATIC');
    const f = Number(cfg.auto_queue_fit_threshold);
    as.rigor = f >= 85 ? 'best' : f >= 70 ? 'good' : 'all';
    // Escolhas feitas no assistente (mesmo sem ligar) ficam no servidor e
    // voltam no próximo acesso — de qualquer aparelho.
    const w = state.prefs.auto_wizard;
    if (w && typeof w === 'object') {
      as.pace = w.pace || as.pace; as.step = w.step || 1;
      if (w.visa) as.visa = w.visa;
      if (Array.isArray(w.titles)) as.titles = w.titles;
      if (Array.isArray(w.states)) as.states = w.states;
      if (w.minWage !== undefined) as.minWage = w.minWage;
      if (w.limit) as.limit = w.limit;
      if (w.rigor) as.rigor = w.rigor;
      if (w.review) as.review = w.review;
      if (w.resumeId !== undefined) as.resumeId = w.resumeId;
    }
  }

  async function openAuto() {
    $('#auto-modal-overlay').style.display = 'flex';
    document.body.style.overflow = 'hidden';
    $('#auto-body').innerHTML = '<div class="skel" style="height:120px;margin:14px"></div>';
    try {
      const [cfgR, facets, resumes, sched, queue, tpl] = await Promise.all([
        API.seasonal.getConfig(), API.seasonal.facets(), env().resumes({ docType: 'resume' }),
        API.core.scheduler(), API.seasonal.queue({ limit: 50 }), API.seasonal.templates().catch(() => null)
      ]);
      as.cfg = cfgR.config; as.facets = facets; as.resumes = (resumes.resumes || []).filter(r => r.is_active);
      state.scheduler = sched; as.queue = queue; if (tpl) state.templates = summarizeTemplates(tpl);
      restoreFromConfig(as.cfg);
      H2B.renderGlobals();
    } catch (e) { err(e); }
    if (H2B.autoIsOn()) renderDashboard(); else renderWizard();
  }
  function summarizeTemplates(t) {
    const s = (t.subjects || []).filter(x => x.active).length, b = (t.bodies || []).filter(x => x.active).length;
    return { subjects: s, bodies: b, minimum: t.minimum || 3, ready: s >= 1 && b >= 1, recommended: s >= (t.minimum || 3) && b >= (t.minimum || 3) };
  }
  function closeAuto() {
    $('#auto-modal-overlay').style.display = 'none';
    if (!$$('.overlay.show').length) document.body.style.overflow = '';
  }

  // ---------------------------------------------------------------- wizard

  function stepHdr(n, title, sub, done, active) {
    return `<div class="wizard-step-hdr"><div class="wizard-step-n ${done ? 'done' : active ? 'active' : ''}">${done ? '✓' : n}</div><div><div class="wizard-step-title">${title}</div><div class="wizard-step-sub">${sub}</div></div></div>`;
  }
  function renderWizard() {
    const f = as.facets || { titles: [], states: [] };
    const t = f.totals || {};
    const step = as.step;
    const cur = (n) => step === n, done = (n) => step > n, lock = (n) => step < n ? 'locked' : '';
    const titles = (f.titles || []).slice(0, 80);
    const states = (f.states || []);
    const rigor = RIGOR[as.rigor];
    $('#auto-hero-sub').textContent = 'Configure uma vez. O robô envia por você todo dia, dentro da cota.';
    $('#auto-body').innerHTML = `
      <div class="wizard-step ${lock(1)}">
        ${stepHdr(1, 'Tipo de visto', 'Quais programas o robô deve cobrir?', done(1), cur(1))}
        <div class="source-btns" style="grid-template-columns:repeat(3,1fr)">
          <button class="source-btn ${as.visa['H-2A'] && !as.visa['H-2B'] ? 'sel' : ''}" data-visa="H-2A"><div class="source-btn-icon">🌾</div><div class="source-btn-label">H-2A</div><div class="source-btn-count">${t.h2a || 0} vagas · agro</div></button>
          <button class="source-btn ${as.visa['H-2B'] && !as.visa['H-2A'] ? 'sel' : ''}" data-visa="H-2B"><div class="source-btn-icon">🏨</div><div class="source-btn-label">H-2B</div><div class="source-btn-count">${t.h2b || 0} vagas · não-agro</div></button>
          <button class="source-btn ${as.visa['H-2A'] && as.visa['H-2B'] ? 'sel' : ''}" data-visa="both"><div class="source-btn-icon">🇺🇸</div><div class="source-btn-label">Ambos</div><div class="source-btn-count">${t.total || 0} vagas</div></button>
        </div>
        ${cur(1) ? `<button class="btn btn-primary w100" style="margin-top:12px" data-next="2">Continuar <i class="ti ti-arrow-right"></i></button>` : ''}
      </div>
      <div class="wizard-step ${lock(2)}">
        ${stepHdr(2, 'Cargos', as.titles.length ? `${as.titles.length} selecionado(s)` : 'Todos os cargos (recomendado para volume)', done(2), cur(2))}
        ${cur(2) ? `<input class="input" id="aw-title-q" placeholder="Filtrar cargos…" style="margin-bottom:8px">
        <div class="cat-chips-row" id="aw-titles" style="max-height:220px;overflow:auto">${titles.map(x => `<button class="cat-chip-sel ${as.titles.includes(x.title) ? 'sel' : ''}" data-title="${esc(x.title)}">${esc(x.title)} <span style="opacity:.6">${x.total}</span></button>`).join('') || '<div class="hint">Importe o feed para ver os cargos.</div>'}</div>
        <div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-secondary" data-next="1"><i class="ti ti-arrow-left"></i></button><button class="btn btn-secondary" id="aw-titles-clear">Todos</button><button class="btn btn-primary" style="flex:1" data-next="3">Continuar <i class="ti ti-arrow-right"></i></button></div>` : ''}
      </div>
      <div class="wizard-step ${lock(3)}">
        ${stepHdr(3, 'Onde e quanto', as.states.length ? `${as.states.join(', ')}${as.minWage ? ' · ≥ $' + as.minWage + '/h' : ''}` : (as.minWage ? `Todos os estados · ≥ $${as.minWage}/h` : 'Todos os estados, qualquer salário'), done(3), cur(3))}
        ${cur(3) ? `<div class="cat-chips-row" style="max-height:200px;overflow:auto">${states.map(s => `<button class="cat-chip-sel ${as.states.includes(s.state) ? 'sel' : ''}" data-state="${s.state}">${s.state} <span style="opacity:.6">${s.total}</span></button>`).join('')}</div>
        <div class="field" style="margin-top:10px"><label>Salário mínimo por hora (opcional)</label><input class="input" id="aw-wage" type="number" step="0.5" min="0" value="${esc(as.minWage)}" placeholder="Ex.: 16"></div>
        <div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-secondary" data-next="2"><i class="ti ti-arrow-left"></i></button><button class="btn btn-secondary" id="aw-states-clear">Todos</button><button class="btn btn-primary" style="flex:1" data-next="4">Continuar <i class="ti ti-arrow-right"></i></button></div>` : ''}
      </div>
      <div class="wizard-step ${lock(4)}">
        ${stepHdr(4, 'Currículo', as.resumeId ? (as.resumes.find(r => r.id === as.resumeId) || {}).name || 'Escolhido' : 'Automático por tipo de visto', done(4), cur(4))}
        ${cur(4) ? `<div id="aw-cvs">${(function () { ms.resumes = as.resumes; return resumeSlots(as.resumeId, true); })()}</div>
        <div style="display:flex;gap:8px;margin-top:12px"><button class="btn btn-secondary" data-next="3"><i class="ti ti-arrow-left"></i></button><button class="btn btn-primary" style="flex:1" data-next="5">Continuar <i class="ti ti-arrow-right"></i></button></div>` : ''}
      </div>
      <div class="wizard-step ${lock(5)}">
        ${stepHdr(5, 'Ritmo e limite', `${as.limit}/dia · a cada ${as.pace} min · ${rigor.label}`, false, cur(5))}
        ${cur(5) ? `
        <div class="field"><label>Limite por dia: <b id="aw-limit-lbl">${as.limit}</b> e-mails <span class="hint">(teto do sistema: ${state.quota ? state.quota.absoluteCap : 300})</span></label>
          <input type="range" id="aw-limit" min="10" max="${state.quota ? state.quota.absoluteCap : 300}" step="10" value="${as.limit}" style="width:100%"></div>
        <div class="field"><label>Ritmo da fila</label><div class="cat-chips-row">${[15, 30, 60, 120].map(p => `<button class="cat-chip-sel ${as.pace === p ? 'sel' : ''}" data-pace="${p}">a cada ${p} min</button>`).join('')}</div></div>
        <div class="field"><label>Rigor do encaixe</label><div class="cat-chips-row">${Object.entries(RIGOR).map(([k, r]) => `<button class="cat-chip-sel ${as.rigor === k ? 'sel' : ''}" data-rigor="${k}">${r.label}</button>`).join('')}</div><div class="hint" id="aw-rigor-hint">${rigor.hint}</div></div>
        <div class="field"><label>Revisão</label><div class="cat-chips-row">
          <button class="cat-chip-sel ${as.review === 'FULLY_AUTOMATIC' ? 'sel' : ''}" data-review="FULLY_AUTOMATIC">Envia sem me perguntar</button>
          <button class="cat-chip-sel ${as.review === 'REVIEW_FLAGGED' ? 'sel' : ''}" data-review="REVIEW_FLAGGED">Segura as duvidosas para eu revisar</button></div></div>
        <div class="gmail-risk-warn" style="margin:10px 0 0"><b>Contas de envio:</b> ${sendersLine()}</div>
        <div style="display:flex;gap:8px;margin-top:14px"><button class="btn btn-secondary" data-next="4"><i class="ti ti-arrow-left"></i></button><button class="auto-start-mega" id="aw-start" style="flex:1;padding:12px">🚀 Ligar envio automático</button></div>` : ''}
      </div>
    `;
    wireWizard();
  }
  function sendersLine() {
    const s = state.senders;
    if (!s || !s.senders || !s.senders.length) return 'nenhuma conta Gmail conectada — <a href="#" data-goto-settings style="color:var(--blue);font-weight:800">conectar</a>.';
    return `${s.active} ativa(s) de ${s.total} · capacidade ${s.dailyCapacity}/dia.`;
  }
  function wireWizard() {
    const body = $('#auto-body');
    body.onclick = (ev) => {
      const v = ev.target.closest('[data-visa]'); if (v) { const k = v.dataset.visa; as.visa = k === 'both' ? { 'H-2A': true, 'H-2B': true } : { 'H-2A': k === 'H-2A', 'H-2B': k === 'H-2B' }; renderWizard(); return; }
      const n = ev.target.closest('[data-next]'); if (n) { collect(); as.step = Number(n.dataset.next); persistWizard(); renderWizard(); body.scrollTop = 0; return; }
      const t = ev.target.closest('[data-title]'); if (t) { const x = t.dataset.title; as.titles = as.titles.includes(x) ? as.titles.filter(y => y !== x) : as.titles.concat(x); t.classList.toggle('sel'); persistWizard(); return; }
      const s = ev.target.closest('[data-state]'); if (s) { const x = s.dataset.state; as.states = as.states.includes(x) ? as.states.filter(y => y !== x) : as.states.concat(x); s.classList.toggle('sel'); persistWizard(); return; }
      const cv = ev.target.closest('[data-cv]'); if (cv) { as.resumeId = cv.dataset.cv === 'auto' ? null : Number(cv.dataset.cv); $('#aw-cvs .cv-slot').forEach(x => x.classList.toggle('sel', x === cv)); persistWizard(); return; }
      const p = ev.target.closest('[data-pace]'); if (p) { as.pace = Number(p.dataset.pace); $('[data-pace]', body).forEach(x => x.classList.toggle('sel', x === p)); persistWizard(); return; }
      const r = ev.target.closest('[data-rigor]'); if (r) { as.rigor = r.dataset.rigor; $('[data-rigor]', body).forEach(x => x.classList.toggle('sel', x === r)); $('#aw-rigor-hint').textContent = RIGOR[as.rigor].hint; persistWizard(); return; }
      const rv = ev.target.closest('[data-review]'); if (rv) { as.review = rv.dataset.review; $('[data-review]', body).forEach(x => x.classList.toggle('sel', x === rv)); persistWizard(); return; }
      if (ev.target.closest('#aw-titles-clear')) { as.titles = []; renderWizard(); return; }
      if (ev.target.closest('#aw-states-clear')) { as.states = []; renderWizard(); return; }
      if (ev.target.closest('[data-goto-settings]')) { ev.preventDefault(); closeAuto(); H2B.sv('settings'); return; }
      if (ev.target.closest('[data-open-editor]')) { ev.preventDefault(); closeAuto(); H2B.profile.openEditor(); return; }
      if (ev.target.closest('#aw-start')) { collect(); openPreflight(); return; }
    };
    const tq = $('#aw-title-q'); if (tq) tq.oninput = () => { const q = tq.value.toLowerCase(); $$('#aw-titles [data-title]').forEach(b => { b.style.display = b.dataset.title.toLowerCase().includes(q) ? '' : 'none'; }); };
    const lim = $('#aw-limit'); if (lim) { lim.oninput = () => { as.limit = Number(lim.value); $('#aw-limit-lbl').textContent = as.limit; }; lim.onchange = persistWizard; }
    const wg = $('#aw-wage'); if (wg) wg.onchange = () => { as.minWage = wg.value.trim(); persistWizard(); };
  }
  function collect() {
    const w = $('#aw-wage'); if (w) as.minWage = w.value.trim();
    const lim = $('#aw-limit'); if (lim) as.limit = Number(lim.value);
    persistWizard();
  }
  function persistWizard() {
    H2B.savePrefs({ auto_wizard: {
      step: as.step, pace: as.pace, visa: as.visa, titles: as.titles, states: as.states,
      minWage: as.minWage, limit: as.limit, rigor: as.rigor, review: as.review, resumeId: as.resumeId
    } });
  }

  // ---------------------------------------------------------------- pré-voo

  async function openPreflight() {
    $('#pf-body').innerHTML = '<div class="skel" style="height:80px"></div>';
    $('#pf-foot').innerHTML = '';
    openModal('preflight-modal');
    const checks = [];
    try {
      const [senders, profile, driver, cfgR, tpl] = await Promise.all([
        API.gmailSenders.list().catch(() => null), env().profile().catch(() => null),
        API.seasonal.driverProfile().catch(() => null), API.seasonal.getConfig(), API.seasonal.templates().catch(() => null)
      ]);
      state.senders = senders;
      const active = senders && senders.senders ? senders.senders.filter(s => s.isActive) : [];
      const gmailOk = active.length > 0 || Boolean(cfgR.config.gmail_connected);
      checks.push({ ok: gmailOk, block: true, label: 'Conta Gmail conectada', detail: gmailOk ? `${active.length || 1} conta(s) pronta(s)` : 'Conecte pelo menos uma conta em Configurações', fix: 'settings' });
      const p = profile && profile.profile;
      const pOk = Boolean(p && p.fullName && p.email);
      checks.push({ ok: pOk, block: true, label: 'Nome e e-mail no perfil', detail: pOk ? `${p.fullName} · ${p.email}` : 'Preencha em Perfil › Eu', fix: 'profile' });
      const cvOk = as.resumes.length > 0;
      checks.push({ ok: cvOk, block: true, label: 'Currículo enviado', detail: cvOk ? `${as.resumes.length} currículo(s)` : 'Envie um PDF em Perfil › Currículos', fix: 'editor' });
      const ts = tpl ? summarizeTemplates(tpl) : null;
      checks.push({ ok: Boolean(ts && ts.recommended), block: false, label: '3+ assuntos e 3+ corpos de e-mail', detail: ts ? `${ts.subjects} assunto(s), ${ts.bodies} corpo(s)` : 'Sem modelos: o robô usa o texto padrão', fix: 'editor' });
      const d = driver && driver.profile ? driver.profile : driver;
      const critical = d && d.criticalUnknowns ? d.criticalUnknowns : [];
      const yearsOk = p && p.yearsOfExperience !== null && p.yearsOfExperience !== undefined && p.yearsOfExperience !== '';
      checks.push({ ok: yearsOk, block: false, label: 'Anos de experiência no perfil', detail: yearsOk ? `${p.yearsOfExperience} ano(s)` : 'Vagas que pedem experiência mínima ficarão em revisão', fix: 'profile' });
      if (state.truckFocus) checks.push({ ok: critical.length === 0, block: false, label: 'Perfil de motorista completo', detail: critical.length ? `Faltam: ${critical.join(', ')} — vagas de caminhão ficarão em revisão` : 'Truth Guard tem o que precisa', fix: 'profile' });
      else checks.push({ ok: true, block: false, label: 'Foco: todas as vagas H-2A/H-2B', detail: critical.length ? 'Perfil de motorista incompleto — só as vagas de caminhão ficarão em revisão' : 'Qualquer ocupação concorre' });
      const feedOk = Boolean(cfgR.config.dol_feed_url) && cfgR.config.health_status !== 'ERROR';
      checks.push({ ok: feedOk, block: true, label: 'Feed do DOL configurado', detail: feedOk ? `saúde: ${cfgR.config.health_status}` : 'Configure a URL do feed em Configurações', fix: 'settings' });
      const q = state.quota || {};
      checks.push({ ok: true, block: false, label: 'Cota do dia', detail: `${q.countSent || 0} enviados · limite escolhido ${as.limit}/dia · teto ${q.absoluteCap || 300}` });
    } catch (e) { err(e); }
    const allBlockOk = checks.filter(c => c.block).every(c => c.ok);
    $('#pf-body').innerHTML = checks.map(c => `<div style="display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--border)"><span style="font-size:18px;flex:none">${c.ok ? '✅' : c.block ? '❌' : '⚠️'}</span><div style="flex:1"><div style="font-weight:800;font-size:13.5px">${esc(c.label)}</div><div class="hint">${esc(c.detail)}</div></div>${!c.ok && c.fix ? `<button class="btn btn-secondary btn-xs" data-fix="${c.fix}">Resolver</button>` : ''}</div>`).join('')
      + `<div class="hint" style="margin-top:10px">Itens com ❌ impedem ligar. Itens com ⚠️ só reduzem o alcance.</div>`;
    $('#pf-foot').innerHTML = `<button class="btn btn-secondary" data-close="preflight-modal">Voltar</button><button class="btn btn-success" id="pf-go" style="flex:1" ${allBlockOk ? '' : 'disabled'}><i class="ti ti-rocket"></i> Ligar agora</button>`;
    $('#pf-body').onclick = (ev) => {
      const f = ev.target.closest('[data-fix]'); if (!f) return;
      closeModal('preflight-modal'); closeAuto();
      if (f.dataset.fix === 'editor') H2B.profile.openEditor(); else H2B.sv(f.dataset.fix, { subtab: 'me' });
    };
    $('#pf-go').onclick = turnOn;
  }

  async function turnOn() {
    if (as.busy) return; as.busy = true;
    const btn = $('#pf-go'); btn.disabled = true; btn.innerHTML = '<span class="spin spin-sm"></span> Ligando…';
    try {
      const r = RIGOR[as.rigor];
      await API.seasonal.saveConfig({
        h2a_preference: as.visa['H-2A'] ? 1 : 0, h2b_preference: as.visa['H-2B'] ? 1 : 0,
        preferred_states: as.states.join(','), preferred_occupations: as.titles.join(','),
        min_hourly_wage: as.minWage === '' ? 0 : Number(as.minWage),
        daily_email_limit: as.limit,
        automation_mode: 'AUTOMATIC', email_review_mode: as.review,
        auto_queue_fit_threshold: r.fit, auto_queue_opportunity_threshold: r.opp, auto_queue_ats_threshold: r.ats
      });
      if (as.resumeId) await env().updateResume(as.resumeId, { is_default: true }).catch(() => {});
      await API.seasonal.pause(false);
      await API.core.schedulerEnable(true);
      await API.core.schedulerTask('seasonal_dispatch', { enabled: true, intervalMinutes: as.pace });
      await API.core.schedulerTask('seasonal_prepare_packages', { enabled: true, intervalMinutes: Math.max(15, as.pace) });
      // Prepara a fila já — assim o painel mostra a próxima vaga sem esperar o tick.
      API.core.runTask('seasonal_prepare_packages').catch(() => {});
      closeModal('preflight-modal');
      toast('Envio automático ligado 🚀', 'auto');
      await H2B.refreshCore();
      as.queue = await API.seasonal.queue({ limit: 50 }).catch(() => as.queue);
      renderDashboard();
      H2B.loadNotifications();
    } catch (e) { err(e); btn.disabled = false; btn.innerHTML = '<i class="ti ti-rocket"></i> Ligar agora'; }
    as.busy = false;
  }

  async function turnOff() {
    try {
      await API.seasonal.saveConfig({ automation_mode: 'MANUAL' });
      await API.core.schedulerTask('seasonal_dispatch', { enabled: false });
      await API.core.schedulerTask('seasonal_prepare_packages', { enabled: false });
      toast('Envio automático desligado');
      await H2B.refreshCore();
      as.step = 5; renderWizard();
    } catch (e) { err(e); }
  }

  // ---------------------------------------------------------------- painel

  function renderDashboard() {
    const q = state.quota || { countSent: 0, maxLimit: 0, remaining: 0 };
    const cfg = as.cfg || {};
    const paused = Boolean(cfg.pause_email_sending);
    const items = (as.queue && as.queue.queue) || [];
    const queued = items.filter(i => i.status === 'QUEUED' || i.status === 'DEFERRED');
    const review = items.filter(i => i.status === 'AWAITING_REVIEW');
    const next = queued[0] || null;
    const pct = q.maxLimit ? Math.min(100, Math.round(q.countSent / q.maxLimit * 100)) : 0;
    const disp = ((state.scheduler || {}).tasks || []).find(t => t.id === 'seasonal_dispatch') || {};
    $('#auto-hero-sub').textContent = `Ligado · ${q.countSent}/${q.maxLimit} hoje · a cada ${disp.interval_minutes || as.pace} min`;
    const banner = paused
      ? `<div class="auto-status-banner asb-paused"><i class="ti ti-player-pause"></i> Pausado — nada sai até você retomar.</div>`
      : q.remaining <= 0 ? `<div class="auto-status-banner asb-done"><i class="ti ti-check"></i> Cota do dia concluída. Volta à meia-noite.</div>`
      : queued.length ? `<div class="auto-status-banner asb-sending"><span class="live-dot"></span> Enviando… ${queued.length} na fila${disp.next_run_at ? ` · próximo ciclo ${H2B.fmtDateTime(disp.next_run_at)}` : ''}</div>`
      : `<div class="auto-status-banner asb-waiting"><i class="ti ti-hourglass"></i> Aguardando vagas novas que passem nos seus filtros.</div>`;
    $('#auto-body').innerHTML = `
      <div class="auto-dashboard">
        <div class="auto-dash-box"><div class="auto-dash-val">${q.countSent}</div><div class="auto-dash-lbl">Hoje</div></div>
        <div class="auto-dash-box"><div class="auto-dash-val" style="color:var(--green)">${q.remaining}</div><div class="auto-dash-lbl">Restam</div></div>
        <div class="auto-dash-box"><div class="auto-dash-val" style="color:var(--amber)">${queued.length}</div><div class="auto-dash-lbl">Na fila</div></div>
        <div class="auto-dash-box"><div class="auto-dash-val" style="color:var(--purple)">${review.length}</div><div class="auto-dash-lbl">Revisão</div></div>
      </div>
      ${banner}
      <div class="auto-prog-bg" style="margin:-4px 0 12px"><div class="auto-prog-fill" style="width:${pct}%"></div></div>
      ${next ? `<div class="next-job-card"><div class="next-job-title">▶ Próxima da fila</div><div class="next-job-info">${esc(next.job_title)} — ${esc(next.employer_name)}</div><div class="next-job-sub">${esc(next.employer_state || '')} · ${money(next.wage_rate, 'Hour')} · ${esc(next.recipient_email)}</div></div>` : ''}
      ${review.length ? `<div class="alert al-purple" style="margin-bottom:12px"><i class="ti ti-eye"></i><div><b>${review.length} candidatura(s) esperando sua revisão.</b> <a href="#" data-review-list style="color:var(--purple);font-weight:800">Revisar agora</a></div></div>` : ''}
      <div class="auto-controls-row">
        ${paused ? `<button class="btn btn-success" id="ad-resume"><i class="ti ti-player-play"></i> Retomar</button>` : `<button class="btn btn-secondary" id="ad-pause"><i class="ti ti-player-pause"></i> Pausar</button>`}
        <button class="btn btn-primary" id="ad-run"><i class="ti ti-send"></i> Rodar fila agora</button>
        <button class="btn btn-secondary" id="ad-edit"><i class="ti ti-adjustments"></i> Editar</button>
        <button class="btn btn-danger" id="ad-off"><i class="ti ti-power"></i> Desligar</button>
      </div>
      <div class="home-card">
        <div class="home-section-title">Configuração ativa</div>
        <div class="jd-tags">
          ${cfg.h2a_preference ? visaTag('H-2A') : ''}${cfg.h2b_preference ? visaTag('H-2B') : ''}
          <span class="tag">${as.states.length ? as.states.join(', ') : 'todos os estados'}</span>
          <span class="tag">${as.titles.length ? as.titles.length + ' cargo(s)' : 'todos os cargos'}</span>
          ${as.minWage ? `<span class="tag tg">≥ $${esc(as.minWage)}/h</span>` : ''}
          <span class="tag tp">${RIGOR[as.rigor].label}</span>
          <span class="tag">${cfg.email_review_mode === 'FULLY_AUTOMATIC' ? 'sem revisão' : 'revisa duvidosas'}</span>
        </div>
      </div>
      <div id="ad-review-list" style="margin-top:12px"></div>
    `;
    const body = $('#auto-body');
    const pause = $('#ad-pause'); if (pause) pause.onclick = async () => { try { await API.seasonal.pause(true); as.cfg.pause_email_sending = 1; toast('Envio pausado'); renderDashboard(); } catch (e) { err(e); } };
    const res = $('#ad-resume'); if (res) res.onclick = async () => { try { await API.seasonal.pause(false); as.cfg.pause_email_sending = 0; toast('Envio retomado', 'auto'); renderDashboard(); } catch (e) { err(e); } };
    $('#ad-run').onclick = async () => {
      const b = $('#ad-run'); b.disabled = true; b.innerHTML = '<span class="spin spin-sm"></span> Enviando…';
      try {
        await API.core.runTask('seasonal_prepare_packages').catch(() => {});
        const r = await API.seasonal.dispatch({ max: 10 });
        toast(r.userMessage || `${r.sent || 0} enviado(s), ${r.failed || 0} falha(s)`, r.sent ? 'ok' : undefined);
        await H2B.refreshCore(); as.queue = await API.seasonal.queue({ limit: 50 }); renderDashboard(); H2B.loadNotifications();
      } catch (e) { err(e); b.disabled = false; b.innerHTML = '<i class="ti ti-send"></i> Rodar fila agora'; }
    };
    $('#ad-edit').onclick = () => { as.step = 1; renderWizard(); };
    $('#ad-off').onclick = () => H2B.warn({ icon: '🛑', title: 'Desligar o envio automático?', text: 'A fila fica guardada. Você pode religar quando quiser.', danger: 'Desligar', okLabel: 'Manter ligado', onDanger: turnOff });
    body.onclick = (ev) => { if (ev.target.closest('[data-review-list]')) { ev.preventDefault(); renderReviewList(review); } };
  }

  function renderReviewList(items) {
    $('#ad-review-list').innerHTML = `<div class="home-section-title">Aguardando revisão</div>` + items.map(i => `
      <div class="hcard"><div class="hcard-main">
        <div class="hcard-job">${esc(i.job_title)}</div>
        <div class="hcard-co"><i class="ti ti-building"></i> ${esc(i.employer_name)} · ${esc(i.employer_state || '')}</div>
        <div class="hcard-to"><i class="ti ti-mail"></i><span>${esc(i.recipient_email)}</span></div>
        ${(i.reviewReasons || []).length ? `<div class="hint" style="margin:4px 0">${i.reviewReasons.map(r => esc(typeof r === 'string' ? r : r.message || r.label || '')).join(' · ')}</div>` : ''}
        <div class="hcard-footer"><button class="btn btn-success btn-xs" data-approve="${i.package_id}"><i class="ti ti-check"></i> Aprovar</button><button class="btn btn-secondary btn-xs" data-view-job="${i.job_id}">Ver vaga</button></div>
      </div></div>`).join('');
    $('#ad-review-list').onclick = async (ev) => {
      const a = ev.target.closest('[data-approve]'); if (a) { try { await API.seasonal.approvePackage(a.dataset.approve); toast('Aprovada — entra na fila', 'ok'); as.queue = await API.seasonal.queue({ limit: 50 }); renderDashboard(); } catch (e) { err(e); } return; }
      const v = ev.target.closest('[data-view-job]'); if (v) { closeAuto(); H2B.sv('jobs', { jobId: Number(v.dataset.viewJob) }); }
    };
  }

  $('#auto-close').onclick = closeAuto;

  return { openManual, openAuto, closeAuto, turnOff, as };
})();
