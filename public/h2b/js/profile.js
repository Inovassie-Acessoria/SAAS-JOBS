/**
 * H2 Dream — perfil (Eu / Currículos / Números), editor de documentos e
 * modelos de e-mail, onboarding do primeiro acesso e tour do app.
 */
H2B.profile = (function () {
  const { $, $$, esc, toast, err, openModal, closeModal, state, visaTag } = H2B;
  const env = () => API.env('seasonal', 'US');

  const ENUM_LABEL = {
    manual_transmission_experience: { label: 'Dirige câmbio manual?', opts: { YES: 'Sim', NO: 'Não', UNKNOWN: 'Não sei' } },
    cdl_status: { label: 'CDL (habilitação comercial dos EUA)', opts: { HELD: 'Tenho', NOT_HELD: 'Não tenho', EXPIRED: 'Vencida', IN_PROGRESS: 'Tirando', UNKNOWN: 'Não informado' }, critical: true },
    cdl_class: { label: 'Classe da CDL', opts: { A: 'A', B: 'B', C: 'C', UNKNOWN: 'Não se aplica' } },
    driving_record: { label: 'Histórico de direção', opts: { CLEAN: 'Limpo', MINOR_VIOLATIONS: 'Infrações leves', MAJOR_VIOLATIONS: 'Infrações graves', UNKNOWN: 'Não informado' }, critical: true },
    english_level: { label: 'Inglês', opts: { NONE: 'Nenhum', BASIC: 'Básico', INTERMEDIATE: 'Intermediário', ADVANCED: 'Avançado', NATIVE: 'Nativo', UNKNOWN: 'Não informado' } },
    long_distance_experience: { label: 'Experiência em longa distância?', opts: { YES: 'Sim', NO: 'Não', UNKNOWN: 'Não sei' } },
    agricultural_hauling_experience: { label: 'Transporte agrícola?', opts: { YES: 'Sim', NO: 'Não', UNKNOWN: 'Não sei' } }
  };
  const NUM_LABEL = { truck_driving_experience: 'Anos dirigindo caminhão', tractor_trailer_experience: 'Anos com carreta (tractor-trailer)' };
  const TEXT_LABEL = { cdl_endorsements: 'Endossos da CDL (ex.: H, N, T)', equipment_experience: 'Equipamentos que opera', lifting_capacity: 'Capacidade de carga (ex.: 50 lb)', availability_start: 'Disponível a partir de (AAAA-MM-DD)', availability_end: 'Disponível até (AAAA-MM-DD)', accepted_states: 'Estados aceitos (ex.: TX, FL)' };

  const ps = { tab: 'me', profile: null, driver: null, resumes: [], stats: null, templates: null };

  // ------------------------------------------------------------ abas

  function showTab(tab) {
    if (ps.flush) ps.flush();
    ps.tab = tab;
    $$('#profile-subtabs .stab').forEach(b => b.classList.toggle('active', b.dataset.ptab === tab));
    ['me', 'cvs', 'num'].forEach(t => $('#ptab-' + t).classList.toggle('gone', t !== tab));
    if (tab === 'me') renderMe(); else if (tab === 'cvs') renderCvs(); else renderNum();
  }

  // ------------------------------------------------------------ EU

  async function renderMe() {
    const el = $('#ptab-me');
    el.innerHTML = '<div class="skel" style="height:120px"></div>';
    try {
      const [p, d] = await Promise.all([env().profile(), API.seasonal.driverProfile()]);
      ps.profile = p.profile; state.profile = p.profile; ps.driver = d.profile || d;
      H2B.renderIdentity();
    } catch (e) { el.innerHTML = `<div class="empty-state"><i class="ti ti-alert-circle"></i><p>${esc(e.message)}</p></div>`; return; }
    const p = ps.profile || {}, d = ps.driver || {};
    const f = (label, id, val, ph, type) => `<div class="field"><label>${label}</label><input class="input" id="${id}" type="${type || 'text'}" value="${esc(val === null || val === undefined || val === 'UNKNOWN' ? '' : val)}" placeholder="${ph || ''}"></div>`;
    const truckFocus = Boolean(state.truckFocus);
    const crit = (m) => (m.critical && truckFocus ? ' <span class="tag tr">crítico</span>' : '');
    const sel = (key) => { const m = ENUM_LABEL[key]; return `<div class="field"><label>${m.label}${crit(m)}</label><select class="input" data-dp="${key}">${Object.entries(m.opts).map(([k, l]) => `<option value="${k}" ${(d[key] || 'UNKNOWN') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`; };
    const blockers = (ps.driver && ps.driver.criticalUnknowns) || [];
    // Perfil de motorista: aberto por padrão só no foco caminhão ou se já tem dados.
    const hasDriverData = ['cdl_status', 'driving_record', 'truck_driving_experience', 'manual_transmission_experience'].some(k => d[k] !== undefined && d[k] !== null && d[k] !== 'UNKNOWN');
    const driverOpen = truckFocus || hasDriverData || state.prefs.driver_card_open === true;
    el.innerHTML = `
      ${truckFocus && blockers.length ? `<div class="banner al-amber" style="margin:0 0 12px"><i class="ti ti-alert-triangle"></i><div><b>Truth Guard sem base:</b> preencha ${blockers.map(b => `<b>${esc((ENUM_LABEL[b] || {}).label || NUM_LABEL[b] || b)}</b>`).join(', ')}. Sem isso, vagas de caminhão ficam em revisão.</div></div>` : ''}
      <div class="banner ${truckFocus ? 'al-amber' : 'al-blue'}" style="margin:0 0 12px;cursor:pointer" data-sv="settings"><i class="ti ${truckFocus ? 'ti-truck' : 'ti-world'}"></i><div><b>Foco atual: ${truckFocus ? 'só motorista de caminhão' : 'todas as vagas H-2A/H-2B'}.</b> ${truckFocus ? 'Vagas de outras ocupações são filtradas.' : 'Colheita, hotelaria, construção, paisagismo, fábrica, caminhão — tudo concorre.'} <span style="text-decoration:underline">Mudar em Configurações</span></div></div>
      <div class="prof-card" style="margin-bottom:12px">
        <div class="prof-card-hd"><i class="ti ti-id"></i><span>Dados pessoais</span></div>
        <div class="prof-card-bd">
          ${f('Nome completo', 'pf-name', p.fullName, 'Como aparece no passaporte')}
          <div class="field-row">${f('E-mail', 'pf-email', p.email, 'seu@email.com', 'email')}${f('Telefone (com DDI)', 'pf-phone', p.phone, '+55 11 99999-9999')}</div>
          <div class="field-row">${f('Cidade', 'pf-city', p.city, '')}${f('Estado', 'pf-state', p.state, '')}</div>
          ${f('Título profissional (inglês)', 'pf-headline', p.headline, 'Ex.: Farm and warehouse worker — 6 years')}
          <div class="field"><label>Resumo (inglês, 2–4 linhas) — entra na carta</label><textarea class="input" id="pf-summary" rows="3" placeholder="Hard-working seasonal worker with harvest, packing and forklift experience…">${esc(p.summary || '')}</textarea></div>
          <div class="field-row">${f('Anos de experiência (geral) <span class="tag tr">crítico</span>', 'pf-years', p.yearsOfExperience, '', 'number')}${f('Habilitação (Brasil)', 'pf-license', p.driversLicense, 'Ex.: CNH B, CNH E')}</div>
          <div class="hint">Vagas que pedem "N months/years experience" comparam com os anos acima. Vazio = a vaga para em revisão.</div>
          <div class="field"><label>Habilidades (inglês, separadas por vírgula)</label><input class="input" id="pf-skills" value="${esc((p.skills || []).join(', '))}" placeholder="harvest, packing, forklift, housekeeping, landscaping, welding, truck driving"></div>
          <div class="field"><label>Setores em que já trabalhou</label><input class="input" id="pf-industries" value="${esc((p.industries || []).join(', '))}" placeholder="agriculture, hospitality, construction, logistics"></div>
          <div class="field-row"><div class="field"><label>Idiomas</label><input class="input" id="pf-langs" value="${esc((p.languages || []).join(', '))}" placeholder="Portuguese, English (basic)"></div>${sel('english_level')}</div>
          <div class="field-row"><div class="field"><label>Certificações</label><input class="input" id="pf-certs" value="${esc((p.certifications || []).join(', '))}" placeholder="MOPP, NR-35, forklift"></div>${f(TEXT_LABEL.lifting_capacity, 'dp-lifting_capacity', d.lifting_capacity, 'Ex.: 50 lb')}</div>
          <div class="field-row">${f('Disponível a partir de', 'pf-from', p.availabilityFrom, 'AAAA-MM-DD')}${f('Disponível até', 'pf-to', p.availabilityTo, 'AAAA-MM-DD')}</div>
          <div class="hint">Cada campo é gravado no servidor assim que você sai dele. O botão só força a gravação agora.</div>
          <button class="btn btn-primary" id="pf-save"><i class="ti ti-device-floppy"></i> Salvar agora</button>
        </div>
      </div>
      <div class="prof-card" style="margin-bottom:12px">
        <div class="prof-card-hd" id="dp-head" style="cursor:pointer"><i class="ti ti-truck"></i><span>Perfil de motorista ${truckFocus ? '(Truth Guard)' : '— opcional, só para vagas de caminhão'}</span><i class="ti ${driverOpen ? 'ti-chevron-up' : 'ti-chevron-down'}" style="margin-left:auto;color:var(--t3)"></i></div>
        <div class="prof-card-bd ${driverOpen ? '' : 'gone'}" id="dp-body">
          <div class="hint">${truckFocus ? 'O sistema só afirma no e-mail o que está aqui. "Não informado" = a carta não fala do assunto.' : 'Preencha só se quiser concorrer a vagas de motorista de caminhão. Em outras ocupações, nada daqui entra no e-mail. "Não informado" = a carta não fala do assunto.'}</div>
          <div class="prof-mini"><div class="prof-mini-lbl">Interesse</div><div style="display:flex;gap:6px">
            <button class="btn btn-secondary ob-toggle ${d.h2a_interest === true ? 'on' : ''}" data-int="h2a_interest">🌾 H-2A</button>
            <button class="btn btn-secondary ob-toggle ${d.h2b_interest === true ? 'on' : ''}" data-int="h2b_interest">🏨 H-2B</button></div></div>
          <div class="field-row">${sel('cdl_status')}${sel('cdl_class')}</div>
          <div class="field"><label>Consegue tirar a CDL se contratado?</label><select class="input" data-dp="can_obtain_cdl"><option value="UNKNOWN" ${d.can_obtain_cdl === 'UNKNOWN' || d.can_obtain_cdl == null ? 'selected' : ''}>Não sei</option><option value="1" ${String(d.can_obtain_cdl) === '1' || d.can_obtain_cdl === true ? 'selected' : ''}>Sim</option><option value="0" ${String(d.can_obtain_cdl) === '0' || d.can_obtain_cdl === false ? 'selected' : ''}>Não</option></select></div>
          <div class="field-row">${f(NUM_LABEL.truck_driving_experience + (truckFocus ? ' <span class="tag tr">crítico</span>' : ''), 'dp-truck_driving_experience', d.truck_driving_experience, '0', 'number')}${f(NUM_LABEL.tractor_trailer_experience, 'dp-tractor_trailer_experience', d.tractor_trailer_experience, '0', 'number')}</div>
          <div class="field-row">${sel('driving_record')}${sel('manual_transmission_experience')}</div>
          <div class="field-row">${sel('long_distance_experience')}${sel('agricultural_hauling_experience')}</div>
          ${Object.entries(TEXT_LABEL).filter(([k]) => k !== 'lifting_capacity').map(([k, l]) => f(l, 'dp-' + k, d[k], '')).join('')}
          <button class="btn btn-primary" id="dp-save"><i class="ti ti-shield-check"></i> Salvar agora</button>
        </div>
      </div>
    `;
    $('#dp-head').onclick = () => { const b = $('#dp-body'); b.classList.toggle('gone'); const open = !b.classList.contains('gone'); $('#dp-head i:last-child').className = `ti ${open ? 'ti-chevron-up' : 'ti-chevron-down'}`; H2B.savePrefs({ driver_card_open: open }); };
    // ---- gravação: UMA rotina para as duas seções, disparada por qualquer
    // mudança (autosave) e pelos botões. Nada fica só na tela.
    const list = (id) => $('#' + id).value.split(',').map(x => x.trim()).filter(Boolean);
    function collectGeneral() {
      return {
        full_name: $('#pf-name').value.trim(), email: $('#pf-email').value.trim(), phone: $('#pf-phone').value.trim(),
        city: $('#pf-city').value.trim(), state: $('#pf-state').value.trim(), headline: $('#pf-headline').value.trim(),
        summary: $('#pf-summary').value.trim(), years_of_experience: $('#pf-years').value, drivers_license: $('#pf-license').value.trim(),
        availability_from: $('#pf-from').value.trim() || null, availability_to: $('#pf-to').value.trim() || null,
        skills: list('pf-skills'), languages: list('pf-langs'), certifications: list('pf-certs'), industries: list('pf-industries')
      };
    }
    function collectDriver() {
      const body = {};
      $$('[data-dp]', el).forEach(x => { body[x.dataset.dp] = x.value; });
      Object.keys(NUM_LABEL).forEach(k => { const inp = $('#dp-' + k); if (inp) body[k] = inp.value === '' ? 'UNKNOWN' : Number(inp.value); });
      Object.keys(TEXT_LABEL).forEach(k => { const inp = $('#dp-' + k); if (inp) body[k] = inp.value.trim() || 'UNKNOWN'; });
      body.h2a_interest = $('[data-int="h2a_interest"]', el).classList.contains('on');
      body.h2b_interest = $('[data-int="h2b_interest"]', el).classList.contains('on');
      if (body.can_obtain_cdl !== undefined && body.can_obtain_cdl !== 'UNKNOWN') body.can_obtain_cdl = body.can_obtain_cdl === '1';
      return body;
    }
    let saving = false, pending = false, saveTimer = null;
    async function saveAll({ silent } = {}) {
      if (saving) { pending = true; return; }
      saving = true;
      try {
        const [r, d] = await Promise.all([env().saveProfile(collectGeneral()), API.seasonal.saveDriverProfile(collectDriver())]);
        state.profile = r.profile; ps.profile = r.profile; ps.driver = d.profile || d; H2B.renderIdentity();
        if (silent) H2B.saved('Perfil'); else toast('Perfil salvo no servidor', 'ok');
      } catch (e) { err(e); }
      saving = false;
      if (pending) { pending = false; saveAll({ silent: true }); }
    }
    const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveAll({ silent: true }), 700); };
    // change = campo concluído (blur/enter/select); input em textos longos com debounce.
    el.addEventListener('change', (ev) => { if (ev.target.matches('input, select, textarea')) scheduleSave(); });
    el.addEventListener('input', (ev) => { if (ev.target.matches('textarea, input[type="text"], input[type="email"], input[type="number"]')) scheduleSave(); });
    el.querySelectorAll('[data-int]').forEach(b => b.onclick = () => { b.classList.toggle('on'); scheduleSave(); });
    $('#pf-save').onclick = () => { clearTimeout(saveTimer); saveAll(); };
    $('#dp-save').onclick = () => { clearTimeout(saveTimer); saveAll(); };
    // Saiu da tela com gravação pendente: grava agora.
    ps.flush = () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveAll({ silent: true }); } };
  }

  // ------------------------------------------------------------ CURRÍCULOS

  const DOC_LABEL = { resume: 'Currículo', cover_letter: 'Carta de apresentação', recommendation_letter: 'Carta de recomendação' };
  async function loadDocs() {
    const r = await env().resumes({});
    ps.resumes = r.resumes || [];
    return ps.resumes;
  }
  function docCard(r) {
    return `<div class="doc-file-card" data-doc="${r.id}">
      <div class="doc-file-icon ${r.doc_type !== 'resume' ? 'cover' : ''}">${r.doc_type === 'resume' ? '📄' : '✉️'}</div>
      <div style="flex:1;min-width:0">
        <div class="doc-file-name">${esc(r.name)} ${r.is_default ? '<span class="tag tb">padrão</span>' : ''} ${r.ats_health ? `<span class="tag ${r.ats_health === 'HEALTHY' ? 'tg' : 'ta'}">ATS ${esc(r.ats_health)}</span>` : ''}</div>
        <div class="doc-file-size">${esc(DOC_LABEL[r.doc_type] || r.doc_type)} · ${Math.round((r.file_size || 0) / 1024)} KB · ${r.text_length ? r.text_length + ' caracteres lidos' : '<span style="color:var(--red)">texto não extraído</span>'}</div>
      </div>
      <select class="fsel visa-sel" data-visa="${r.id}" title="Tipo de visto"><option value="ANY" ${r.visa_type === 'ANY' ? 'selected' : ''}>Ambos</option><option value="H-2A" ${r.visa_type === 'H-2A' ? 'selected' : ''}>H-2A</option><option value="H-2B" ${r.visa_type === 'H-2B' ? 'selected' : ''}>H-2B</option></select>
      <a class="btn btn-secondary btn-xs" href="${env().resumeFileUrl(r.id)}" target="_blank" rel="noopener" title="Abrir"><i class="ti ti-external-link"></i></a>
      ${r.doc_type === 'resume' && !r.is_default ? `<button class="btn btn-secondary btn-xs" data-default="${r.id}" title="Tornar padrão"><i class="ti ti-star"></i></button>` : ''}
      <button class="btn btn-secondary btn-xs" data-archive="${r.id}" title="Remover"><i class="ti ti-trash"></i></button>
    </div>`;
  }
  async function renderCvs() {
    const el = $('#ptab-cvs');
    el.innerHTML = '<div class="skel" style="height:120px"></div>';
    try { await loadDocs(); ps.templates = await API.seasonal.templates(); } catch (e) { el.innerHTML = `<div class="empty-state"><p>${esc(e.message)}</p></div>`; return; }
    const cvs = ps.resumes.filter(r => r.doc_type === 'resume');
    const letters = ps.resumes.filter(r => r.doc_type !== 'resume');
    const t = ps.templates; const sN = t.subjects.filter(x => x.active).length, bN = t.bodies.filter(x => x.active).length;
    el.innerHTML = `
      <div class="prof-card" style="margin-bottom:12px">
        <div class="prof-card-hd"><i class="ti ti-file-text"></i><span>Currículos (PDF)</span><span class="tag" style="margin-left:auto">${cvs.length}</span></div>
        <div class="prof-card-bd">
          ${cvs.map(docCard).join('') || '<div class="hint">Nenhum currículo. Envie um PDF em inglês — o robô não envia nada sem ele.</div>'}
          <button class="btn btn-primary" id="cv-up-btn"><i class="ti ti-upload"></i> Enviar currículo</button>
        </div>
      </div>
      <div class="prof-card" style="margin-bottom:12px">
        <div class="prof-card-hd"><i class="ti ti-mail"></i><span>Cartas (PDF)</span><span class="tag" style="margin-left:auto">${letters.length}</span></div>
        <div class="prof-card-bd">
          <div class="hint">Carta de apresentação e cartas de recomendação vão como anexo. Marque H-2A ou H-2B para a carta certa ir na vaga certa.</div>
          ${letters.map(docCard).join('')}
          <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-secondary btn-sm" id="cl-up-btn"><i class="ti ti-upload"></i> Carta de apresentação</button><button class="btn btn-secondary btn-sm" id="rl-up-btn"><i class="ti ti-upload"></i> Carta de recomendação</button></div>
        </div>
      </div>
      <div class="prof-card">
        <div class="prof-card-hd"><i class="ti ti-mail-opened"></i><span>Modelos de e-mail (rotação)</span></div>
        <div class="prof-card-bd">
          <div style="display:flex;gap:8px"><div class="stat-box" style="flex:1"><div class="stat-val" style="color:${sN >= 3 ? 'var(--green)' : 'var(--amber)'}">${sN}</div><div class="stat-lbl">Assuntos</div></div><div class="stat-box" style="flex:1"><div class="stat-val" style="color:${bN >= 3 ? 'var(--green)' : 'var(--amber)'}">${bN}</div><div class="stat-lbl">Corpos</div></div></div>
          <div class="hint">Cadastre 3 ou mais de cada. O sistema usa o menos usado a cada envio, para os e-mails não saírem iguais.</div>
          <button class="btn btn-primary" id="tpl-edit-btn"><i class="ti ti-pencil"></i> Editar modelos</button>
        </div>
      </div>
      <input type="file" id="doc-file" accept=".pdf,.docx" class="gone">
    `;
    const pick = (docType) => { const inp = $('#doc-file'); inp.dataset.docType = docType; inp.value = ''; inp.click(); };
    $('#cv-up-btn').onclick = () => pick('resume');
    $('#cl-up-btn').onclick = () => pick('cover_letter');
    $('#rl-up-btn').onclick = () => pick('recommendation_letter');
    $('#doc-file').onchange = async (ev) => {
      const file = ev.target.files[0]; if (!file) return;
      await upload(file, ev.target.dataset.docType);
      renderCvs();
    };
    $('#tpl-edit-btn').onclick = () => openEditor();
    el.onclick = async (ev) => {
      const d = ev.target.closest('[data-default]'); if (d) { try { await env().updateResume(d.dataset.default, { is_default: true }); toast('Currículo padrão atualizado', 'ok'); renderCvs(); } catch (e) { err(e); } return; }
      const a = ev.target.closest('[data-archive]'); if (a) { H2B.warn({ icon: '🗑️', title: 'Remover documento?', text: 'Ele deixa de ser anexado. Os envios já feitos não mudam.', danger: 'Remover', okLabel: 'Cancelar', onDanger: async () => { try { await env().archiveResume(a.dataset.archive); toast('Removido'); renderCvs(); } catch (e) { err(e); } } }); return; }
    };
    el.onchange = async (ev) => {
      const v = ev.target.closest('[data-visa]'); if (v) { try { await env().updateResume(v.dataset.visa, { visa_type: v.value }); toast('Tipo de visto salvo', 'ok'); } catch (e) { err(e); } }
    };
  }
  async function upload(file, docType) {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('name', file.name.replace(/\.[^.]+$/, ''));
    fd.append('doc_type', docType);
    fd.append('career_track', 'geral');
    fd.append('visa_type', 'ANY');
    if (docType === 'resume' && !ps.resumes.some(r => r.doc_type === 'resume')) fd.append('is_default', '1');
    toast('Enviando…');
    try {
      const r = await env().uploadResume(fd);
      const ex = r.extraction || {};
      if (ex.characters === 0) H2B.warn({ icon: '📄', title: 'PDF sem texto', text: 'O arquivo parece ser imagem escaneada. O ATS e o Truth Guard não conseguem ler. Exporte o currículo como PDF de texto.' });
      else toast(`${DOC_LABEL[docType]} enviado (${ex.characters} caracteres lidos)`, 'ok');
      return r;
    } catch (e) { err(e); return null; }
  }

  // ------------------------------------------------------------ NÚMEROS

  async function renderNum() {
    const el = $('#ptab-num');
    el.innerHTML = '<div class="skel" style="height:120px"></div>';
    try { ps.stats = await API.seasonal.stats(); state.stats = ps.stats; } catch (e) { el.innerHTML = `<div class="empty-state"><p>${esc(e.message)}</p></div>`; return; }
    const s = ps.stats;
    const max = Math.max(1, ...s.series.map(x => x.n));
    el.innerHTML = `
      <div class="stats-row" style="grid-template-columns:repeat(2,1fr)">
        <div class="stat-box"><div class="stat-val">${s.total}</div><div class="stat-lbl">Total enviados</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--green)">${s.today}<span style="font-size:13px;color:var(--t3)">/${s.dailyLimit}</span></div><div class="stat-lbl">Hoje</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--purple)">${s.last7}</div><div class="stat-lbl">Últimos 7 dias</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--amber)">${s.last30}</div><div class="stat-lbl">Últimos 30 dias</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--blue)">${s.employers}</div><div class="stat-lbl">Empresas</div></div>
        <div class="stat-box"><div class="stat-val" style="color:var(--red)">${s.failures}</div><div class="stat-lbl">Falhas na fila</div></div>
      </div>
      <div class="home-card" style="margin-bottom:12px">
        <div class="home-section-title">Envios por dia (14 dias)</div>
        <div class="chart-bars">${s.series.map(x => `<div class="chart-bar" data-v="${x.n}" style="height:${Math.round(x.n / max * 100)}%"></div>`).join('')}</div>
        <div style="display:flex">${s.series.map(x => `<div class="chart-lbl">${x.day.slice(8)}</div>`).join('')}</div>
      </div>
      <div class="home-card" style="margin-bottom:12px"><div class="home-section-title">Por tipo de visto</div><div class="jd-tags">${s.byVisa.map(v => `<span class="tag ${v.visa === 'H-2A' ? 'tgr' : 'tb'}">${H2B.VISA_ICON[v.visa] || ''} ${esc(v.visa)} · ${v.n}</span>`).join('') || '<span class="hint">Nada enviado ainda.</span>'}</div></div>
      <div class="home-card"><div class="home-section-title">Por estado</div><div class="jd-tags">${s.byState.map(v => `<span class="tag">${esc(v.state || '—')} · ${v.n}</span>`).join('') || '<span class="hint">Nada enviado ainda.</span>'}</div></div>
      <div class="hint" style="margin-top:10px">Primeiro envio: ${s.firstSent ? H2B.fmtDateTime(s.firstSent) : '—'} · fuso ${esc(s.timezone)}</div>
    `;
  }

  // ------------------------------------------------------------ EDITOR

  const ed = { subjects: [], bodies: [], vars: [] };
  async function openEditor() {
    openModal('editor-modal');
    $('#ed-body').innerHTML = '<div class="skel" style="height:120px"></div>';
    try {
      const [t] = await Promise.all([API.seasonal.templates(), loadDocs()]);
      ed.subjects = t.subjects.length ? t.subjects.map(x => ({ id: x.id, content: x.content, visa_type: x.visa_type, active: x.active })) : [{ content: '', visa_type: 'ANY', active: true }];
      ed.bodies = t.bodies.length ? t.bodies.map(x => ({ id: x.id, content: x.content, visa_type: x.visa_type, active: x.active })) : [{ content: '', visa_type: 'ANY', active: true }];
      ed.vars = t.variables || [];
    } catch (e) { err(e); }
    renderEditor();
  }
  function tplRow(kind, it, i) {
    const tag = kind === 'subject' ? 'input' : 'textarea';
    return `<div class="prof-mini" data-row="${kind}:${i}" style="margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><span class="prof-mini-lbl" style="margin:0">${kind === 'subject' ? 'Assunto' : 'Corpo'} ${i + 1}</span>
        <select class="fsel" data-tv="${kind}:${i}" style="height:26px;font-size:12px;margin-left:auto"><option value="ANY" ${it.visa_type === 'ANY' ? 'selected' : ''}>Ambos</option><option value="H-2A" ${it.visa_type === 'H-2A' ? 'selected' : ''}>H-2A</option><option value="H-2B" ${it.visa_type === 'H-2B' ? 'selected' : ''}>H-2B</option></select>
        <button class="btn btn-secondary btn-xs" data-rm="${kind}:${i}" title="Remover"><i class="ti ti-x"></i></button></div>
      <${tag} class="input" data-tc="${kind}:${i}" ${kind === 'body' ? 'rows="6"' : ''} placeholder="${kind === 'subject' ? 'Application for {vaga} — {nome}' : 'Dear {empresa} hiring team,\n\nI am applying for the {vaga} position (job order {job_order})…'}">${kind === 'body' ? esc(it.content) : ''}</${tag}>
    </div>`;
  }
  function renderEditor() {
    const cvs = ps.resumes.filter(r => r.doc_type === 'resume');
    const cls = ps.resumes.filter(r => r.doc_type === 'cover_letter');
    $('#ed-body').innerHTML = `
      <div class="jd-section-title" style="margin-top:0">1 · Currículo (PDF)</div>
      ${cvs.map(r => `<div class="doc-file-card" style="margin-bottom:6px"><div class="doc-file-icon">📄</div><div style="flex:1;min-width:0"><div class="doc-file-name">${esc(r.name)}${r.is_default ? ' <span class="tag tb">padrão</span>' : ''}</div><div class="doc-file-size">${r.visa_type === 'ANY' ? 'H-2A e H-2B' : r.visa_type} · ${Math.round((r.file_size || 0) / 1024)} KB</div></div></div>`).join('') || '<div class="alert al-amber"><i class="ti ti-file-off"></i><div>Sem currículo. Sem ele nada é enviado.</div></div>'}
      <button class="btn btn-secondary btn-sm" id="ed-up-cv"><i class="ti ti-upload"></i> Enviar currículo</button>
      <div class="jd-section-title">2 · Carta de apresentação (PDF, opcional)</div>
      ${cls.map(r => `<div class="doc-file-card" style="margin-bottom:6px"><div class="doc-file-icon cover">✉️</div><div style="flex:1;min-width:0"><div class="doc-file-name">${esc(r.name)}</div><div class="doc-file-size">${r.visa_type === 'ANY' ? 'H-2A e H-2B' : r.visa_type}</div></div></div>`).join('')}
      <button class="btn btn-secondary btn-sm" id="ed-up-cl"><i class="ti ti-upload"></i> Enviar carta</button>
      <div class="jd-section-title">3 · Assuntos do e-mail <span class="tag ${ed.subjects.filter(s => s.content.trim()).length >= 3 ? 'tg' : 'ta'}">${ed.subjects.filter(s => s.content.trim()).length}/3+</span></div>
      <div id="ed-subjects">${ed.subjects.map((s, i) => tplRow('subject', s, i)).join('')}</div>
      <button class="btn btn-secondary btn-sm" data-add="subject"><i class="ti ti-plus"></i> Outro assunto</button>
      <div class="jd-section-title">4 · Corpos do e-mail <span class="tag ${ed.bodies.filter(s => s.content.trim()).length >= 3 ? 'tg' : 'ta'}">${ed.bodies.filter(s => s.content.trim()).length}/3+</span></div>
      <div class="hint" style="margin-bottom:8px">Clique numa variável para inserir no campo em foco:</div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px" id="ed-vars">${ed.vars.map(v => `<span class="tpl-var" data-var="${v.key}" title="${esc(v.label)}">{${v.key}}</span>`).join('')}</div>
      <div id="ed-bodies">${ed.bodies.map((b, i) => tplRow('body', b, i)).join('')}</div>
      <button class="btn btn-secondary btn-sm" data-add="body"><i class="ti ti-plus"></i> Outro corpo</button>
      <div class="alert al-blue" style="margin-top:12px"><i class="ti ti-shield-check"></i><div>Escreva em inglês e só afirme o que está no seu perfil. O Truth Guard bloqueia o envio se o texto prometer o que o perfil não sustenta.</div></div>
      <input type="file" id="ed-file" accept=".pdf,.docx" class="gone">
    `;
    $$('#ed-subjects input[data-tc]').forEach((inp, i) => { inp.value = ed.subjects[i].content; });
    let focused = null;
    const body = $('#ed-body');
    body.addEventListener('focusin', (ev) => { if (ev.target.matches('[data-tc]')) focused = ev.target; });
    body.oninput = (ev) => { const t = ev.target.closest('[data-tc]'); if (t) { const [k, i] = t.dataset.tc.split(':'); (k === 'subject' ? ed.subjects : ed.bodies)[Number(i)].content = t.value; } };
    body.onchange = (ev) => { const t = ev.target.closest('[data-tv]'); if (t) { const [k, i] = t.dataset.tv.split(':'); (k === 'subject' ? ed.subjects : ed.bodies)[Number(i)].visa_type = t.value; } };
    body.onclick = (ev) => {
      const add = ev.target.closest('[data-add]'); if (add) { (add.dataset.add === 'subject' ? ed.subjects : ed.bodies).push({ content: '', visa_type: 'ANY', active: true }); renderEditor(); return; }
      const rm = ev.target.closest('[data-rm]'); if (rm) { const [k, i] = rm.dataset.rm.split(':'); (k === 'subject' ? ed.subjects : ed.bodies).splice(Number(i), 1); renderEditor(); return; }
      const v = ev.target.closest('[data-var]'); if (v) { if (!focused) { toast('Clique primeiro no campo onde quer inserir'); return; } const ins = `{${v.dataset.var}}`; const s = focused.selectionStart || 0, e = focused.selectionEnd || 0; focused.value = focused.value.slice(0, s) + ins + focused.value.slice(e); focused.dispatchEvent(new Event('input', { bubbles: true })); focused.focus(); focused.selectionStart = focused.selectionEnd = s + ins.length; return; }
      if (ev.target.closest('#ed-up-cv')) { const f = $('#ed-file'); f.dataset.docType = 'resume'; f.value = ''; f.click(); return; }
      if (ev.target.closest('#ed-up-cl')) { const f = $('#ed-file'); f.dataset.docType = 'cover_letter'; f.value = ''; f.click(); return; }
    };
    $('#ed-file').onchange = async (ev) => { const file = ev.target.files[0]; if (!file) return; await upload(file, ev.target.dataset.docType); await loadDocs(); renderEditor(); };
    let edTimer = null;
    const edAutosave = () => { clearTimeout(edTimer); edTimer = setTimeout(async () => {
      try {
        const t = await API.seasonal.saveTemplates({ subjects: ed.subjects.filter(x => x.content.trim()), bodies: ed.bodies.filter(x => x.content.trim()) });
        // ids novos voltam do servidor — a próxima edição atualiza em vez de duplicar.
        t.subjects.forEach((x, i) => { const local = ed.subjects.filter(y => y.content.trim())[i]; if (local) local.id = x.id; });
        t.bodies.forEach((x, i) => { const local = ed.bodies.filter(y => y.content.trim())[i]; if (local) local.id = x.id; });
        const sN = t.subjects.length, bN = t.bodies.length;
        state.templates = { subjects: sN, bodies: bN, minimum: 3, ready: sN >= 1 && bN >= 1, recommended: sN >= 3 && bN >= 3 };
        H2B.saved('Modelos de e-mail');
      } catch (e) { err(e); }
    }, 1200); };
    body.addEventListener('input', (ev) => { if (ev.target.matches('[data-tc]')) edAutosave(); });
    body.addEventListener('change', (ev) => { if (ev.target.matches('[data-tv]')) edAutosave(); });
    $('#ed-save').onclick = async () => {
      clearTimeout(edTimer);
      try {
        const t = await API.seasonal.saveTemplates({ subjects: ed.subjects.filter(s => s.content.trim()), bodies: ed.bodies.filter(b => b.content.trim()) });
        const sN = t.subjects.length, bN = t.bodies.length;
        state.templates = { subjects: sN, bodies: bN, minimum: 3, ready: sN >= 1 && bN >= 1, recommended: sN >= 3 && bN >= 3 };
        toast(`Modelos salvos: ${sN} assunto(s), ${bN} corpo(s)`, 'ok');
        if (sN < 3 || bN < 3) toast('Dica: 3+ de cada evita e-mails repetidos', undefined, 4000);
        closeModal('editor-modal');
        if (ps.tab === 'cvs' && state.view === 'profile') renderCvs();
      } catch (e) { err(e); }
    };
  }

  // ------------------------------------------------------------ ONBOARDING

  const ob = { step: 0, name: '', email: '', phone: '', h2a: true, h2b: true, english: 'BASIC', truck: false };
  function startOnboarding() {
    ob.step = 0;
    const p = state.profile || {};
    ob.name = p.fullName || ''; ob.email = p.email || ''; ob.phone = p.phone || '';
    $('#onboarding-overlay').style.display = 'flex';
    renderOb();
  }
  function renderOb() {
    const total = 4;
    $('#ob-progress').style.width = `${Math.round((ob.step + 1) / total * 100)}%`;
    const b = $('#ob-body');
    const steps = [
      () => `<div class="ob-step"><div class="ob-icon">👋</div><div class="ob-title">Bem-vindo ao H2 Dream</div><div class="ob-sub">Ele encontra vagas H-2A e H-2B no feed oficial do Departamento do Trabalho dos EUA e envia sua candidatura por e-mail — manual ou automático.</div>
        <div class="field"><label>Seu nome completo</label><input class="input" id="ob-name" value="${esc(ob.name)}" placeholder="Como está no passaporte"></div>
        <div class="field-row"><div class="field"><label>E-mail</label><input class="input" id="ob-email" type="email" value="${esc(ob.email)}"></div><div class="field"><label>Telefone</label><input class="input" id="ob-phone" value="${esc(ob.phone)}" placeholder="+55…"></div></div>
        <div class="ob-note" style="background:var(--bluel)">🔒 Seus dados ficam só neste servidor. Nenhuma senha é guardada — o Gmail entra por login do Google.</div>
        <button class="btn btn-primary w100" id="ob-next">Começar</button></div>`,
      () => `<div class="ob-step"><div class="ob-icon">🇺🇸</div><div class="ob-title">Qual visto te interessa?</div><div class="ob-sub">H-2A é agricultura (fazendas, colheita). H-2B é o resto (hotelaria, construção, paisagismo, caminhão…).</div>
        <div style="display:flex;gap:8px;margin-bottom:12px"><button class="btn btn-secondary ob-toggle ${ob.h2a ? 'on' : ''}" data-ob="h2a">🌾 H-2A</button><button class="btn btn-secondary ob-toggle ${ob.h2b ? 'on' : ''}" data-ob="h2b">🏨 H-2B</button></div>
        <div class="field"><label>Que tipo de vaga?</label><div style="display:flex;gap:6px"><button class="btn btn-secondary ob-toggle-eng ${!ob.truck ? 'on' : ''}" data-focus="all" style="flex:1">🌎 Todas as ocupações</button><button class="btn btn-secondary ob-toggle-eng ${ob.truck ? 'on' : ''}" data-focus="truck" style="flex:1">🚛 Só caminhão</button></div><div class="hint">"Todas" = colheita, hotelaria, construção, paisagismo, fábrica e também caminhão.</div></div>
        <div class="field"><label>Seu inglês</label><div class="ob-eng-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:6px">${[['NONE', 'Nenhum'], ['BASIC', 'Básico'], ['INTERMEDIATE', 'Intermediário'], ['ADVANCED', 'Avançado']].map(([k, l]) => `<button class="btn btn-secondary ob-toggle-eng ${ob.english === k ? 'on' : ''}" data-eng="${k}">${l}</button>`).join('')}</div></div>
        <div style="display:flex;gap:8px"><button class="btn btn-secondary" id="ob-back"><i class="ti ti-arrow-left"></i></button><button class="btn btn-primary" id="ob-next" style="flex:1">Continuar</button></div></div>`,
      () => `<div class="ob-step"><div class="ob-icon">📄</div><div class="ob-title">Seu currículo em inglês</div><div class="ob-sub">PDF com texto (não escaneado). Vai como anexo em toda candidatura.</div>
        <div id="ob-cv-status">${ps.resumes.some(r => r.doc_type === 'resume') ? '<div class="alert al-green"><i class="ti ti-check"></i><div>Currículo já enviado.</div></div>' : '<button class="btn btn-secondary w100" id="ob-up"><i class="ti ti-upload"></i> Escolher PDF</button>'}</div>
        <input type="file" id="ob-file" accept=".pdf,.docx" class="gone">
        <div class="ob-note" style="background:var(--amberl);margin-top:12px">💡 Você pode enviar depois em Perfil › Currículos. Sem currículo o envio fica bloqueado.</div>
        <div style="display:flex;gap:8px"><button class="btn btn-secondary" id="ob-back"><i class="ti ti-arrow-left"></i></button><button class="btn btn-primary" id="ob-next" style="flex:1">Continuar</button></div></div>`,
      () => `<div class="ob-step"><div class="ob-icon">🚀</div><div class="ob-title">Pronto para começar</div><div class="ob-sub">Falta conectar sua conta Gmail (em Configurações) e cadastrar 3 assuntos e 3 corpos de e-mail. Depois disso, o envio automático pode ser ligado.</div>
        <div class="ob-note" style="background:var(--purplel)">✅ Vagas · ✅ Perfil · ⏳ Gmail · ⏳ Modelos de e-mail</div>
        <button class="btn btn-primary w100" id="ob-next">Ir para o app</button>
        <button class="ob-skip" id="ob-tour">Ver o tour rápido primeiro</button></div>`
    ];
    b.innerHTML = steps[ob.step]();
    const collect = () => {
      if ($('#ob-name')) { ob.name = $('#ob-name').value.trim(); ob.email = $('#ob-email').value.trim(); ob.phone = $('#ob-phone').value.trim(); }
    };
    b.querySelectorAll('[data-ob]').forEach(x => x.onclick = () => { ob[x.dataset.ob] = !ob[x.dataset.ob]; x.classList.toggle('on'); });
    b.querySelectorAll('[data-eng]').forEach(x => x.onclick = () => { ob.english = x.dataset.eng; b.querySelectorAll('[data-eng]').forEach(y => y.classList.toggle('on', y === x)); });
    b.querySelectorAll('[data-focus]').forEach(x => x.onclick = () => { ob.truck = x.dataset.focus === 'truck'; b.querySelectorAll('[data-focus]').forEach(y => y.classList.toggle('on', y === x)); });
    const back = $('#ob-back'); if (back) back.onclick = () => { collect(); ob.step--; renderOb(); };
    const up = $('#ob-up'); if (up) { up.onclick = () => $('#ob-file').click(); $('#ob-file').onchange = async (ev) => { const f = ev.target.files[0]; if (f) { await upload(f, 'resume'); await loadDocs(); renderOb(); } }; }
    const tour = $('#ob-tour'); if (tour) tour.onclick = async () => { await finishOb(); startTour(); };
    $('#ob-next').onclick = async () => {
      collect();
      if (ob.step === 0 && !ob.name) { toast('Preencha seu nome', 'err'); return; }
      if (ob.step === 0) { try { const r = await env().saveProfile({ full_name: ob.name, email: ob.email, phone: ob.phone }); state.profile = r.profile; H2B.renderIdentity(); } catch (e) { err(e); return; } }
      if (ob.step === 1) { API.seasonal.saveDriverProfile({ h2a_interest: ob.h2a, h2b_interest: ob.h2b, english_level: ob.english }).catch(() => {}); API.seasonal.saveConfig({ h2a_preference: ob.h2a ? 1 : 0, h2b_preference: ob.h2b ? 1 : 0, require_truck_driver_match: ob.truck ? 1 : 0 }).then(() => { state.truckFocus = ob.truck; }).catch(() => {}); }
      if (ob.step === 3) { await finishOb(); return; }
      ob.step++; renderOb();
    };
  }
  async function finishOb() {
    $('#onboarding-overlay').style.opacity = '0';
    setTimeout(() => { $('#onboarding-overlay').style.display = 'none'; $('#onboarding-overlay').style.opacity = ''; }, 300);
    H2B.savePrefs({ onboarding_done: true });
    await H2B.refreshCore();
    H2B.sv('home');
  }

  // ------------------------------------------------------------ TOUR

  const SLIDES = [
    { e: '🏠', t: 'Início', x: 'Resumo do dia: vagas abertas, enviados, cota. O card roxo liga o <b>envio automático</b>; o azul abre as <b>vagas</b> para envio manual.' },
    { e: '📋', t: 'Vagas', x: 'Abas por tipo de visto, busca com sugestões e <b>Filtros</b> (estados, cargos, salário, mês de início). Clique numa vaga para ver detalhes e <b>Enviar candidatura</b>.' },
    { e: '🚀', t: 'Envio automático', x: 'Assistente de 5 passos: visto → cargos → estados/salário → currículo → ritmo e limite. O <b>checklist</b> confere Gmail, currículo, perfil e feed antes de ligar.' },
    { e: '🛡️', t: 'Truth Guard', x: 'Nenhum e-mail afirma o que seu perfil não sustenta. Preencha <b>Perfil › Eu</b> com a verdade: anos de experiência, habilidades, inglês. O bloco de motorista só importa se você quiser vagas de caminhão.' },
    { e: '✉️', t: 'Modelos e contas', x: 'Cadastre <b>3+ assuntos e 3+ corpos</b> em Perfil › Currículos. Conecte <b>mais de uma conta Gmail</b> em Configurações — o sistema alterna entre elas.' },
    { e: '📊', t: 'Histórico e Logs', x: '<b>Histórico</b> mostra cada e-mail enviado (com o texto). <b>Logs</b> mostra fila, falhas e o motivo de cada uma.' }
  ];
  let slide = 0;
  function startTour() {
    slide = 0;
    $('#tour-track').innerHTML = SLIDES.map(s => `<div class="tour-slide"><div class="tour-emoji">${s.e}</div><div class="tour-title">${s.t}</div><div class="tour-text">${s.x}</div></div>`).join('');
    $('#tour-dots').innerHTML = SLIDES.map((_, i) => `<span class="tour-dot ${i === 0 ? 'on' : ''}"></span>`).join('');
    openModal('tour-modal');
    goSlide(0);
    $('#tour-track').onscroll = () => { const i = Math.round($('#tour-track').scrollLeft / $('#tour-track').clientWidth); if (i !== slide) { slide = i; updateDots(); } };
    $('#tour-next').onclick = () => { if (slide >= SLIDES.length - 1) endTour(); else goSlide(slide + 1); };
    $('#tour-skip').onclick = endTour;
  }
  function goSlide(i) { slide = i; const tr = $('#tour-track'); tr.scrollTo({ left: tr.clientWidth * i, behavior: 'smooth' }); updateDots(); }
  function updateDots() { $$('#tour-dots .tour-dot').forEach((d, i) => d.classList.toggle('on', i === slide)); $('#tour-next').textContent = slide >= SLIDES.length - 1 ? 'Começar' : 'Próximo'; }
  function endTour() { closeModal('tour-modal'); H2B.savePrefs({ tour_done: true }); }

  // ------------------------------------------------------------ wiring

  $('#profile-subtabs').onclick = (ev) => { const t = ev.target.closest('.stab'); if (t) showTab(t.dataset.ptab); };
  H2B.onShow.profile = (opts) => { showTab((opts && opts.subtab) || ps.tab || 'me'); };

  return { showTab, openEditor, startOnboarding, startTour, upload, loadDocs, ps };
})();
