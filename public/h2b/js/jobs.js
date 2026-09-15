/**
 * H2 Dream — tela de vagas: abas, busca com sugestões, filtros mestres,
 * lista, detalhe (PC ao lado; celular em tela cheia), salvar/descartar e o
 * botão de envio manual.
 */
H2B.jobs = (function () {
  const { $, $$, esc, fmtUSDate, money, visaTag, toast, err, openModal, closeModal, state } = H2B;

  const PAGE = 60;
  const US_STATES = {
    AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',
    HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',
    MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',
    NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',
    SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'Washington DC',PR:'Puerto Rico',GU:'Guam',VI:'Ilhas Virgens',AS:'Samoa Americana',MP:'Marianas do Norte'
  };
  const MONTHS = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  /** Regiões do Census Bureau dos EUA — é assim que o americano agrupa os estados. */
  const REGIONS = [
    { id: 'northeast', label: 'Nordeste', icon: '🍁', states: ['CT','ME','MA','NH','RI','VT','NJ','NY','PA'] },
    { id: 'southeast', label: 'Sudeste', icon: '🌴', states: ['DE','DC','FL','GA','MD','NC','SC','VA','WV','AL','KY','MS','TN','AR','LA'] },
    { id: 'midwest', label: 'Meio-Oeste', icon: '🌽', states: ['IL','IN','MI','OH','WI','IA','KS','MN','MO','NE','ND','SD'] },
    { id: 'southwest', label: 'Sudoeste', icon: '🌵', states: ['AZ','NM','OK','TX'] },
    { id: 'west', label: 'Oeste', icon: '🏔️', states: ['CO','ID','MT','NV','UT','WY','AK','CA','HI','OR','WA'] },
    { id: 'territories', label: 'Territórios', icon: '🏝️', states: ['PR','GU','VI','AS','MP'] }
  ];

  const js = {
    sheet: 'all',
    q: '',
    quick: { emailOnly: false, excludeApplied: false, housing: false, dolActive: false },
    sort: 'priority',
    // states = estados MARCADOS na Localização (vazio = todos); years = anos de início.
    // origin: 'all' | 'dol' (vagas atuais) | 'disclosure' (base de temporadas passadas)
    filters: { states: [], city: '', titles: [], minWage: '', minOpenings: '', startMonths: [], visa: 'all', years: [], origin: 'all' },
    jobs: [],
    offset: 0,
    done: false,
    selected: null,
    facets: null,
    loading: false
  };

  function restore() {
    const f = state.prefs.filters;
    if (f && typeof f === 'object') {
      Object.assign(js.filters, f.filters || {});
      if (!Array.isArray(js.filters.years)) js.filters.years = [];
      if (!Array.isArray(js.filters.states)) js.filters.states = [];
      if (!['all', 'dol', 'disclosure'].includes(js.filters.origin)) js.filters.origin = 'all';
      Object.assign(js.quick, f.quick || {});
      js.sort = f.sort || js.sort;
    }
    if (state.prefs.jobs_sheet) js.sheet = state.prefs.jobs_sheet;
  }
  function persist() {
    H2B.savePrefs({ filters: { filters: js.filters, quick: js.quick, sort: js.sort }, jobs_sheet: js.sheet });
  }

  function params(offset) {
    const p = { limit: PAGE, offset: offset || 0, sort: js.sort === 'priority' ? undefined : js.sort };
    if (js.sheet === 'H-2A' || js.sheet === 'H-2B') { p.view = 'all'; p.visaType = js.sheet; }
    else if (js.sheet === 'recommended' || js.sheet === 'saved' || js.sheet === 'applied') p.view = js.sheet;
    else if (js.sheet === 'disclosure') { p.view = 'all'; p.origin = 'disclosure'; }
    else p.view = 'all';
    if (!p.origin && js.filters.origin !== 'all') p.origin = js.filters.origin;
    if (js.filters.visa !== 'all' && !p.visaType) p.visaType = js.filters.visa;
    if (js.q) p.q = js.q;
    if (js.quick.emailOnly) p.emailOnly = 1;
    if (js.quick.excludeApplied && js.sheet !== 'applied') p.excludeApplied = 1;
    if (js.quick.housing) p.housing = 1;
    if (js.quick.dolActive) p.dolActive = 1;
    if (js.filters.states.length) p.states = js.filters.states.join(',');
    if (js.filters.city) p.city = js.filters.city;
    if (js.filters.titles.length) p.titles = js.filters.titles.join(',');
    if (js.filters.minWage !== '' && js.filters.minWage !== null) p.minWage = js.filters.minWage;
    if (js.filters.minOpenings !== '' && js.filters.minOpenings !== null) p.minOpenings = js.filters.minOpenings;
    if (js.filters.startMonths.length) p.startMonths = js.filters.startMonths.join(',');
    if (js.filters.years.length) p.years = js.filters.years.join(',');
    return p;
  }

  function activeFilterCount() {
    const f = js.filters;
    return (f.city ? 1 : 0) + (f.titles.length ? 1 : 0) + (f.minWage !== '' ? 1 : 0)
         + (f.minOpenings !== '' ? 1 : 0) + (f.startMonths.length ? 1 : 0) + (f.visa !== 'all' ? 1 : 0) + (f.years.length ? 1 : 0)
         + (f.origin !== 'all' ? 1 : 0);
  }
  function anyFilterActive() {
    return activeFilterCount() > 0 || js.filters.states.length > 0 || Object.values(js.quick).some(Boolean);
  }

  async function load(reset) {
    if (js.loading) return;
    js.loading = true;
    if (reset) { js.offset = 0; js.done = false; js.jobs = []; $('#jlist').innerHTML = '<div style="padding:20px" class="skel"></div><div style="padding:20px;margin-top:6px" class="skel"></div><div style="padding:20px;margin-top:6px" class="skel"></div>'; }
    try {
      const r = await API.seasonal.listJobs(params(js.offset));
      const rows = r.jobs || [];
      js.jobs = js.offset ? js.jobs.concat(rows) : rows;
      js.offset += rows.length;
      js.done = rows.length < PAGE;
      renderList();
    } catch (e) { err(e); $('#jlist').innerHTML = `<div class="empty-state"><i class="ti ti-plug-connected-x"></i><p>Não consegui carregar as vagas</p><small>${esc(e.message)}</small></div>`; }
    js.loading = false;
  }

  async function loadFacets() {
    try {
      js.facets = await API.seasonal.facets();
      const t = js.facets.totals || {};
      $('#cnt-all').textContent = t.total || 0;
      $('#cnt-h2a').textContent = t.h2a || 0;
      $('#cnt-h2b').textContent = t.h2b || 0;
      $('#cnt-rec').textContent = t.recommended || 0;
      $('#cnt-saved').textContent = t.saved || 0;
      $('#cnt-applied').textContent = t.applied || 0;
      $('#cnt-base').textContent = t.disclosure || 0;
      $('.stab-sheet-base').classList.toggle('gone', !Number(t.disclosure));
      $('#jlist-feed').textContent = (t.lastFeed ? `feed ${H2B.fmtUSDate(t.lastFeed)}` : 'sem feed') + (t.dolActive ? ` · ${t.dolActive} ativas no DOL` : '');
      renderYearSelect();
    } catch (e) { /* silencioso */ }
  }
  /** Atalho de ano na barra: um ano por vez aqui; vários pelo painel de filtros. */
  function renderYearSelect() {
    const sel = $('#f-year');
    const years = ((js.facets && js.facets.years) || []).filter(y => y.year && Number(y.total) > 0);
    const cur = js.filters.years;
    let html = '<option value="">Todos os anos</option>';
    html += years.map(y => `<option value="${esc(y.year)}">${esc(y.year)} (${y.total}${y.active ? ` · ${y.active} ativas` : ''})</option>`).join('');
    if (cur.length > 1) html += `<option value="__multi">${esc(cur.join(', '))}</option>`;
    sel.innerHTML = html;
    sel.value = cur.length > 1 ? '__multi' : (cur[0] || '');
  }

  // ------------------------------------------------------------ lista

  function scoreTag(j) {
    const s = j.opportunity_score;
    if (s === null || s === undefined) return '';
    const cls = s >= 70 ? 'tg' : s >= 45 ? 'ta' : 'tr';
    return `<span class="tag ${cls}">★ ${s}</span>`;
  }
  function timelineTag(j) {
    if (!j.timeline || !j.timeline.label) return '';
    const cls = j.timeline.timelineClass === 'TARGET_2027' ? 'tp' : j.timeline.timelineClass === 'CURRENT' ? 'tg' : '';
    return `<span class="tag ${cls}">${esc(j.timeline.label)}</span>`;
  }
  /** Estado do caso no DOL: ativa (recrutamento aberto), inativa, retirada, ou desconhecido. */
  const ORIGIN_LABEL = { dol: '📡 vagas atuais do DOL', disclosure: '📂 base DOL (temporadas passadas)' };
  function baseYear(j) { return String(j.start_date || '').slice(0, 4); }
  function dolTag(j) {
    if (j.origin === 'disclosure') {
      return `<span class="tag tb" title="Vaga certificada pelo DOL na temporada ${esc(baseYear(j))} — já encerrou. O empregador contrata pelo programa todo ano: a candidatura vai como interesse na próxima temporada.">📂 base DOL ${esc(baseYear(j))} · empregador recorrente</span>`;
    }
    if (j.dol_active === 1) {
      const started = j.start_date && j.start_date < new Date().toISOString().slice(0, 10);
      return started ? '<span class="tag ta" title="Ativa no DOL, mas o contrato já começou">🟡 ativa · já começou</span>' : '<span class="tag tg" title="Recrutamento aberto no DOL">🟢 ativa no DOL</span>';
    }
    if (j.dol_active === 0) {
      const st = String(j.dol_status || '');
      if (/Withdrawn|Denied|Rejected/i.test(st)) return '<span class="tag tr" title="' + esc(st) + '">⛔ retirada</span>';
      if (/Certification/i.test(st)) return '<span class="tag" title="' + esc(st) + '">🔒 certificada · recrutamento fechado</span>';
      return '<span class="tag" title="' + esc(st) + '">⚪ inativa · ' + esc(st.split(' - ')[0].slice(0, 28)) + '</span>';
    }
    return '';
  }

  function card(j) {
    const cat = j.categoryLabel || j.career_track || (j.soc_code ? `SOC ${j.soc_code}` : '');
    const applied = j.is_applied ? ' applied' : '';
    const active = js.selected && js.selected.id === j.id ? ' active' : '';
    return `<div class="jcard${applied}${active}" data-id="${j.id}">
      <button class="save-btn${j.is_saved ? ' on' : ''}" data-save="${j.id}" title="Salvar"><i class="ti ${j.is_saved ? 'ti-star-filled' : 'ti-star'}"></i></button>
      <div class="jcard-title" translate="yes">${esc(j.job_title)}</div>
      <div class="jcard-cat-row">${visaTag(j.visa_type)}${cat ? `<span class="jcard-cat-badge">${esc(cat)}</span>` : ''}</div>
      <div class="jcard-co"><i class="ti ti-building"></i> ${esc(j.employer_name)} · ${esc(j.employer_city || '')}${j.employer_city ? ', ' : ''}${esc(j.employer_state || '')}</div>
      <div class="jcard-tags">
        <span class="tag tg">${money(j.wage_rate, j.wage_unit)}${j.hourly_wage && j.wage_unit && String(j.wage_unit).toLowerCase() !== 'hour' ? ` ≈ ${Number(j.hourly_wage).toFixed(2)}/h` : ''}</span>
        ${j.openings ? `<span class="tag">${j.openings} vaga${j.openings > 1 ? 's' : ''}</span>` : ''}
        ${j.start_date ? `<span class="tag">📅 ${fmtUSDate(j.start_date)}</span>` : ''}
        ${j.housing_provided ? '<span class="tag tb">🏠 moradia</span>' : ''}
        ${j.isEmailEligible ? '<span class="tag tp">✉️ e-mail</span>' : '<span class="tag ta">📞 manual</span>'}
        ${dolTag(j)}
        ${(j.mergedCases || []).length ? `<span class="tag" title="Pedidos ao DOL do mesmo empregador para o mesmo cargo, dobrados neste card">+${j.mergedCases.length} pedido${j.mergedCases.length > 1 ? 's' : ''}</span>` : ''}
        ${j.dol_url && j.dol_published ? `<a class="tag" href="${esc(j.dol_url)}" target="_blank" rel="noopener" data-dol title="Abrir no site do DOL">DOL ↗</a>` : ''}
        ${scoreTag(j)}${timelineTag(j)}
      </div>
    </div>`;
  }
  function renderList() {
    const n = js.jobs.length;
    $('#jcount').textContent = `${n}${js.done ? '' : '+'} vaga${n === 1 ? '' : 's'}`;
    $('#jlist-more').classList.toggle('gone', js.done);
    if (!n) {
      $('#jlist').innerHTML = `<div class="empty-state"><i class="ti ti-mood-empty"></i><p>Nenhuma vaga aqui</p><small>${js.q || anyFilterActive() ? 'Tente afrouxar a busca, os filtros ou a localização.' : 'Importe o feed do DOL em Configurações.'}</small></div>`;
      return;
    }
    $('#jlist').innerHTML = js.jobs.map(card).join('');
    renderActiveFilters();
  }
  const SORT_LABEL = { active: '✅ ativas primeiro', wage: '💰 maior salário', start: '🗓️ início mais próximo', openings: '👥 mais vagas', recent: '🆕 mais recentes' };
  const QUICK_LABEL = { dolActive: '✅ ativas no DOL', emailOnly: '✉️ só com e-mail', excludeApplied: '🙈 ocultar enviadas', housing: '🏠 com moradia' };
  function renderActiveFilters() {
    const chips = [];
    const f = js.filters;
    Object.keys(QUICK_LABEL).forEach(k => { if (js.quick[k]) chips.push({ k: 'quick', v: k, l: QUICK_LABEL[k] }); });
    if (f.states.length) chips.push({ k: 'location', l: `📍 ${f.states.length <= 4 ? f.states.join(', ') : f.states.slice(0, 3).join(', ') + ' +' + (f.states.length - 3)}` });
    f.years.forEach(y => chips.push({ k: 'year', v: y, l: `📅 ${y}` }));
    if (f.visa !== 'all') chips.push({ k: 'visa', l: f.visa });
    if (f.origin !== 'all' && js.sheet !== 'disclosure') chips.push({ k: 'origin', l: ORIGIN_LABEL[f.origin] || f.origin });
    if (f.city) chips.push({ k: 'city', l: `🏙️ ${f.city}` });
    f.titles.forEach(t => chips.push({ k: 'title', v: t, l: t }));
    if (f.minWage !== '') chips.push({ k: 'minWage', l: `≥ $${f.minWage}/h` });
    if (f.minOpenings !== '') chips.push({ k: 'minOpenings', l: `≥ ${f.minOpenings} vagas` });
    f.startMonths.forEach(m => chips.push({ k: 'month', v: m, l: `início ${MONTHS[Number(m) - 1]}` }));
    if (js.sort !== 'priority' && SORT_LABEL[js.sort]) chips.push({ k: 'sort', l: `↕️ ${SORT_LABEL[js.sort]}` });
    const n = activeFilterCount();
    const badge = $('#filter-badge'); badge.textContent = n; badge.style.display = n ? 'inline-block' : 'none';
    const lb = $('#location-badge'); lb.textContent = f.states.length; lb.style.display = f.states.length ? 'inline-block' : 'none';
    $('#btn-location').classList.toggle('on', f.states.length > 0);
    $('#active-filters').innerHTML = chips.map(c => `<button class="filter-chip-x" data-fk="${c.k}" data-fv="${esc(c.v || '')}">${esc(c.l)} <b>×</b></button>`).join('')
      + (chips.length > 1 ? `<button class="filter-chip-x" data-fk="all" style="background:var(--sf3);border-color:var(--border2);color:var(--t2)">limpar tudo</button>` : '');
    $$('#f-email, #f-notapplied, #f-housing, #f-dolactive').forEach(b => b.classList.toggle('on', Boolean(js.quick[b.dataset.f])));
    $('#f-sort').value = js.sort;
    renderYearSelect();
  }
  function removeFilter(k, v) {
    const f = js.filters;
    if (k === 'all') {
      Object.assign(f, { states: [], city: '', titles: [], minWage: '', minOpenings: '', startMonths: [], visa: 'all', years: [], origin: 'all' });
      Object.keys(js.quick).forEach(q => { js.quick[q] = false; });
      js.sort = 'priority';
    }
    else if (k === 'quick') js.quick[v] = false;
    else if (k === 'location') f.states = [];
    else if (k === 'year') f.years = f.years.filter(x => x !== v);
    else if (k === 'sort') js.sort = 'priority';
    else if (k === 'visa') f.visa = 'all';
    else if (k === 'origin') f.origin = 'all';
    else if (k === 'state') f.states = f.states.filter(x => x !== v);
    else if (k === 'city') f.city = '';
    else if (k === 'title') f.titles = f.titles.filter(x => x !== v);
    else if (k === 'minWage') f.minWage = '';
    else if (k === 'minOpenings') f.minOpenings = '';
    else if (k === 'month') f.startMonths = f.startMonths.filter(x => x !== v);
    persist(); load(true);
  }

  // ------------------------------------------------------------ detalhe

  function detailHTML(j) {
    const pkg = j.package || null;
    const contact = [];
    if (j.application_email) contact.push(`<div class="info-box"><div class="info-lbl">E-mail de candidatura</div><div class="info-val" style="color:var(--blue)">${esc(j.application_email)}</div></div>`);
    if (j.employer_email && j.employer_email !== j.application_email) contact.push(`<div class="info-box"><div class="info-lbl">E-mail do empregador</div><div class="info-val">${esc(j.employer_email)}</div></div>`);
    if (j.employer_phone) contact.push(`<div class="info-box"><div class="info-lbl">Telefone</div><div class="info-val">${esc(j.employer_phone)}</div></div>`);
    if (j.application_url) contact.push(`<div class="info-box"><div class="info-lbl">Site</div><div class="info-val"><a href="${esc(j.application_url)}" target="_blank" rel="noopener" style="color:var(--blue)">abrir ↗</a></div></div>`);
    if (j.dol_url) contact.push(`<div class="info-box"><div class="info-lbl">Página oficial no DOL</div><div class="info-val"><a href="${esc(j.dol_url)}" target="_blank" rel="noopener" style="color:var(--blue)">seasonaljobs.dol.gov ↗</a>${j.dol_published ? '' : '<div class="hint" style="margin-top:2px">publicação no site do DOL pendente — o link passa a abrir quando o pedido for aceito</div>'}</div></div>`);
    if (j.attorney_email) contact.push(`<div class="info-box"><div class="info-lbl">Advogado / agente</div><div class="info-val">${esc(j.attorney_name || '')}<br>${esc(j.attorney_email)}</div></div>`);

    const txt = (c) => typeof c === 'string' ? c : [c.title || c.label || c.message, c.detail].filter(Boolean).join(' — ') || JSON.stringify(c);
    const warnings = (j.warnings || []).map(txt).concat((j.concerns || []).map(txt));
    const isTruck = j.truck_classification && !/^NOT_/.test(String(j.truck_classification));
    const gate = isTruck ? `<div class="alert al-amber"><i class="ti ti-truck"></i><div><b>Vaga de caminhão</b>${j.cdl_requirement ? ' — CDL: ' + esc(j.cdl_requirement) : ''}. O sistema só envia se o seu perfil de motorista sustentar o que a vaga pede.</div></div>` : '';

    let sendBtn;
    if (j.is_applied) sendBtn = `<button class="btn btn-success" disabled><i class="ti ti-check"></i> Já enviada</button>`;
    else if (j.isEmailEligible || j.employer_email || j.attorney_email) sendBtn = `<button class="btn btn-primary" data-send="${j.id}"><i class="ti ti-send"></i> Enviar candidatura</button>`;
    else sendBtn = `<button class="btn btn-secondary" disabled title="Sem e-mail: candidatura por telefone ou site"><i class="ti ti-phone"></i> Ação manual</button>`;

    const base = j.origin === 'disclosure' ? `<div class="alert al-blue" style="margin-bottom:10px"><i class="ti ti-folder-open"></i><div><b>Base DOL ${esc(baseYear(j))} — empregador recorrente.</b> Este pedido foi certificado para a temporada ${esc(baseYear(j))} e já encerrou; o empregador contrata pelo programa todo ano. A candidatura vai como interesse na <b>próxima temporada</b>, com o modelo de e-mail próprio da base.${(j.mergedCases || []).length ? `<div class="hint" style="margin-top:4px">Outros pedidos do mesmo empregador para este cargo, dobrados aqui: ${j.mergedCases.map(m => esc(m.case) + (m.start ? ' (' + esc(String(m.start).slice(0, 4)) + ')' : '')).join(', ')}</div>` : ''}</div></div>` : '';
    return `
      <div class="jd-title" translate="yes">${esc(j.job_title)}</div>
      <div class="jd-co"><i class="ti ti-building"></i> ${esc(j.employer_name)} · ${esc(j.employer_city || '')}${j.employer_city ? ', ' : ''}${esc(US_STATES[j.employer_state] || j.employer_state || '')}</div>
      <div class="jd-tags">${visaTag(j.visa_type)}${scoreTag(j)}${timelineTag(j)}${j.fit_score !== null && j.fit_score !== undefined ? `<span class="tag">fit ${j.fit_score}</span>` : ''}${j.ats_score !== null && j.ats_score !== undefined ? `<span class="tag">ATS ${j.ats_score}</span>` : ''}<span class="tag">#${esc(j.job_order_id)}</span></div>
      ${base}${gate}
      <div class="jd-acts">${sendBtn}
        <button class="btn btn-secondary" data-save2="${j.id}"><i class="ti ${j.is_saved ? 'ti-star-filled' : 'ti-star'}"></i> ${j.is_saved ? 'Salva' : 'Salvar'}</button>
        <button class="btn btn-secondary" data-discard="${j.id}"><i class="ti ti-trash"></i> Descartar</button>
        ${j.dol_url ? `<a class="btn btn-secondary" href="${esc(j.dol_url)}" target="_blank" rel="noopener" title="${j.dol_published ? 'Abrir a vaga no site do DOL' : 'Ainda não publicada no site do DOL — o link passa a abrir quando o pedido for aceito'}"><i class="ti ti-external-link"></i> Ver no DOL${j.dol_published ? '' : ' <span class="tag ta" style="margin-left:4px">pendente</span>'}</a>` : ''}
      </div>
      <div class="info-grid">
        <div class="info-box"><div class="info-lbl">Salário</div><div class="info-val">${money(j.wage_rate, j.wage_unit)}</div></div>
        <div class="info-box"><div class="info-lbl">Vagas</div><div class="info-val">${j.openings || '—'}</div></div>
        <div class="info-box"><div class="info-lbl">Horas/semana</div><div class="info-val">${j.weekly_hours || '—'}</div></div>
        <div class="info-box"><div class="info-lbl">Início</div><div class="info-val">${fmtUSDate(j.start_date)}</div></div>
        <div class="info-box"><div class="info-lbl">Término</div><div class="info-val">${fmtUSDate(j.end_date)}</div></div>
        <div class="info-box"><div class="info-lbl">Moradia / transporte</div><div class="info-val">${j.housing_provided ? '🏠 sim' : '—'} ${j.transportation_provided ? '🚌 sim' : ''}</div></div>
        <div class="info-box"><div class="info-lbl">Como se candidatar</div><div class="info-val">${esc(j.application_method || 'UNKNOWN')}</div></div>
        <div class="info-box"><div class="info-lbl">Código SOC</div><div class="info-val">${esc(j.soc_code || '—')}</div></div>
        <div class="info-box"><div class="info-lbl">Estado no DOL</div><div class="info-val">${dolTag(j) || '<span class="hint">não verificado</span>'}${j.dol_active_until ? `<div class="hint">ativa até ${fmtUSDate(j.dol_active_until)}</div>` : ''}${j.dol_accepted_at ? `<div class="hint">aceita em ${fmtUSDate(j.dol_accepted_at)}</div>` : ''}</div></div>
        <div class="info-box"><div class="info-lbl">Visto no feed</div><div class="info-val">${j.first_seen_feed ? H2B.fmtUSDate(j.first_seen_feed) : '—'}${j.feed_appearances ? ` · ${j.feed_appearances}×` : ''}</div></div>
      </div>
      ${contact.length ? `<div class="jd-section-title">Contato</div><div class="info-grid">${contact.join('')}</div>` : ''}
      ${warnings.length ? `<div class="jd-section-title">Atenção</div>${warnings.map(w => `<div class="alert al-amber" style="margin-bottom:6px"><i class="ti ti-alert-triangle"></i><div>${esc(w)}</div></div>`).join('')}` : ''}
      ${pkg ? `<div class="jd-section-title">Pacote preparado</div><div class="alert ${pkg.validation_status === 'PASSED' ? 'al-green' : 'al-red'}"><i class="ti ti-package"></i><div><b>${esc(pkg.validation_status)}</b>${pkg.requires_review ? ' · aguarda revisão' : ''}${j.queue_status ? ` · fila: ${esc(j.queue_status)}` : ''}</div></div>` : ''}
      <div class="jd-section-title">Descrição da vaga</div>
      <div class="jd-desc" translate="yes">${esc(j.duties_description || 'Sem descrição no feed.')}</div>
      ${j.special_requirements ? `<div class="jd-section-title">Requisitos</div><div class="jd-desc" translate="yes">${esc(j.special_requirements)}</div>` : ''}
      ${(j.requirements || []).length ? `<div class="jd-section-title">Requisitos detectados</div><div class="jd-tags" translate="yes">${j.requirements.map(r => `<span class="tag ${r.status === 'MET' ? 'tg' : r.status === 'UNMET' ? 'tr' : 'ta'}">${esc(r.label || r.text || r)}</span>`).join('')}</div>` : ''}
      ${(j.emailHistory || []).length ? `<div class="jd-section-title">Eventos de e-mail</div>${j.emailHistory.slice(0, 8).map(e => `<div style="font-size:12px;color:var(--t2);padding:4px 0;border-bottom:1px solid var(--border)"><b>${esc(e.event_type || e.event)}</b> · ${H2B.fmtDateTime(e.created_at)} — ${esc(e.detail || e.message || '')}</div>`).join('')}` : ''}
    `;
  }

  async function select(id) {
    const mobile = window.matchMedia('(max-width:767px)').matches || document.documentElement.classList.contains('force-cel');
    const target = mobile ? $('#mob-jd-content') : $('#jd-content');
    $$('.jcard').forEach(c => c.classList.toggle('active', Number(c.dataset.id) === Number(id)));
    if (mobile) $('#mob-detail').classList.add('show');
    else { $('#jd-empty').classList.add('gone'); $('#jd-content').classList.remove('gone'); }
    target.innerHTML = '<div class="skel" style="height:120px"></div>';
    try {
      const r = await API.seasonal.getJob(id);
      js.selected = Object.assign(r.job, { package: r.package });
      target.innerHTML = detailHTML(js.selected);
      target.scrollTop = 0;
    } catch (e) { target.innerHTML = `<div class="empty-state"><i class="ti ti-alert-circle"></i><p>${esc(e.message)}</p></div>`; }
  }

  async function toggleSave(id) {
    const j = js.jobs.find(x => x.id === Number(id)) || js.selected;
    try {
      // Não existe "des-salvar" no backend: para tirar da lista de salvas, o
      // usuário descarta a vaga. O botão fica como "Salva".
      if (j && j.is_saved) { toast('Já estava salva. Para tirar, descarte a vaga.'); return; }
      await API.seasonal.saveJob(id, '');
      toast('Vaga salva ⭐', 'ok');
      if (j) j.is_saved = 1;
      renderList(); if (js.selected && js.selected.id === Number(id)) select(id);
      loadFacets();
    } catch (e) { err(e); }
  }
  function discard(id) {
    H2B.warn({
      icon: '🗑️', title: 'Descartar esta vaga?', text: 'Ela some da lista e o robô não envia para ela. Dá para reverter na aba Configurações › Descartadas.',
      danger: 'Descartar', okLabel: 'Cancelar',
      onDanger: async () => {
        try { await API.seasonal.discardJob(id, 'descartada pelo usuário'); toast('Vaga descartada'); js.selected = null; $('#mob-detail').classList.remove('show'); $('#jd-content').classList.add('gone'); $('#jd-empty').classList.remove('gone'); load(true); loadFacets(); }
        catch (e) { err(e); }
      }
    });
  }

  // ------------------------------------------------------------ sugestões

  let sugTimer = null;
  async function suggest(q) {
    const box = $('#jobs-sug');
    if (!q || q.length < 2) { box.classList.remove('open'); return; }
    try {
      const r = await API.seasonal.suggest(q);
      const by = {};
      (r.suggestions || []).forEach(s => { (by[s.kind] = by[s.kind] || []).push(s); });
      const LBL = { employer: 'Empresas', title: 'Cargos', city: 'Cidades', order: 'Ordens' };
      const ICO = { employer: 'ti-building', title: 'ti-briefcase', city: 'ti-map-pin', order: 'ti-hash' };
      const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
      let html = '';
      for (const k of ['employer', 'title', 'city', 'order']) {
        if (!by[k]) continue;
        html += `<div class="q-sug-grp">${LBL[k]}</div>` + by[k].slice(0, 5).map(s =>
          `<div class="q-sug-it" data-q="${esc(s.label)}" ${s.id ? `data-job="${s.id}"` : ''}><i class="ti ${ICO[k]}"></i><span>${esc(s.label).replace(re, '<b>$1</b>')}</span><span class="q-sug-meta">${s.total ? s.total + ' vaga' + (s.total > 1 ? 's' : '') : esc(s.meta || '')}</span></div>`).join('');
      }
      box.innerHTML = html;
      box.classList.toggle('open', Boolean(html));
    } catch (e) { box.classList.remove('open'); }
  }

  // ------------------------------------------------------------ filtros (modal)

  function openFilters() {
    const f = js.filters;
    const fac = js.facets || { states: [], titles: [], months: [] };
    const titleOpts = (fac.titles || []).map(t => `<label class="mf-check-row"><input type="checkbox" data-title="${esc(t.title)}" ${f.titles.includes(t.title) ? 'checked' : ''}> <span style="flex:1;font-weight:600">${esc(t.title)}</span><span class="tag">${t.total}</span></label>`).join('');
    const monthCount = Object.fromEntries((fac.months || []).map(m => [m.month, m.total]));
    $('#mf-body').innerHTML = `
      <div class="mf-sec"><div class="mf-sec-title"><i class="ti ti-id-badge"></i> Tipo de visto</div>
        <div class="cat-chips-row">
          <button class="cat-chip-sel ${f.visa === 'all' ? 'sel' : ''}" data-visa="all">Todos</button>
          <button class="cat-chip-sel ${f.visa === 'H-2A' ? 'sel' : ''}" data-visa="H-2A">🌾 H-2A (agro)</button>
          <button class="cat-chip-sel ${f.visa === 'H-2B' ? 'sel' : ''}" data-visa="H-2B">🏨 H-2B (não-agro)</button>
        </div></div>
      ${(js.facets && js.facets.totals && Number(js.facets.totals.disclosure)) ? `<div class="mf-sec" style="margin-top:14px"><div class="mf-sec-title"><i class="ti ti-database"></i> Origem</div>
        <div class="cat-chips-row">
          <button class="cat-chip-sel ${f.origin === 'all' ? 'sel' : ''}" data-origin="all">Todas</button>
          <button class="cat-chip-sel ${f.origin === 'dol' ? 'sel' : ''}" data-origin="dol">📡 Vagas atuais do DOL <span style="opacity:.6">${js.facets.totals.current || 0}</span></button>
          <button class="cat-chip-sel ${f.origin === 'disclosure' ? 'sel' : ''}" data-origin="disclosure">📂 Base DOL · temporadas passadas <span style="opacity:.6">${js.facets.totals.disclosure}</span></button>
        </div><div class="hint" style="margin-top:6px">A base some da lista quando o mesmo empregador já tem o mesmo cargo entre as vagas atuais — a atual é a que vale.</div></div>` : ''}
      <div class="mf-sec" style="margin-top:14px"><div class="mf-sec-title"><i class="ti ti-map-pin"></i> Estados</div>
        <div class="hint">${f.states.length ? `${f.states.length} estado(s) marcado(s): ${esc(f.states.join(', '))}` : 'Todos os estados.'} A localização é um filtro à parte — <button class="filter-chip-x" id="mf-open-location" type="button" style="display:inline-flex">📍 abrir Localização</button></div></div>
      <div class="mf-sec" style="margin-top:14px"><div class="mf-sec-title"><i class="ti ti-building-community"></i> Cidade</div>
        <input class="mf-input" id="mf-city" placeholder="Ex.: Fresno" value="${esc(f.city)}"></div>
      <div class="mf-sec" style="margin-top:14px"><div class="mf-sec-title"><i class="ti ti-briefcase"></i> Cargos <span class="tag" id="mf-title-cnt">${f.titles.length}</span></div>
        <input class="mf-input" id="mf-title-q" placeholder="Filtrar a lista de cargos…" style="margin-bottom:6px">
        <div class="mf-scroll-list" id="mf-titles">${titleOpts || '<div class="hint" style="padding:8px">Importe o feed para ver os cargos.</div>'}</div></div>
      <div class="mf-row2" style="margin-top:14px">
        <div class="mf-sec"><div class="mf-sec-title"><i class="ti ti-cash"></i> Salário mín. ($/h)</div><input class="mf-input" id="mf-wage" type="number" step="0.5" min="0" value="${esc(f.minWage)}" placeholder="Ex.: 16"></div>
        <div class="mf-sec"><div class="mf-sec-title"><i class="ti ti-users"></i> Mín. de vagas</div><input class="mf-input" id="mf-open" type="number" min="1" value="${esc(f.minOpenings)}" placeholder="Ex.: 5"></div>
      </div>
      <div class="mf-sec" style="margin-top:14px"><div class="mf-sec-title"><i class="ti ti-calendar-event"></i> Ano de início <span class="hint" style="font-weight:600;text-transform:none;letter-spacing:0">— pode marcar vários</span></div>
        <div style="display:flex;gap:5px;flex-wrap:wrap">${(fac.years || []).filter(y => y.year).map(y => `<button class="mf-month ${f.years.includes(String(y.year)) ? 'on' : ''}" data-year="${esc(y.year)}">${esc(y.year)} <span style="opacity:.6">${y.total}${y.active ? ' · ' + y.active + ' ativas' : ''}</span></button>`).join('') || '<div class="hint" style="padding:8px">Importe o feed para ver os anos.</div>'}</div></div>
      <div class="mf-sec" style="margin-top:14px"><div class="mf-sec-title"><i class="ti ti-calendar"></i> Mês de início</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap">${MONTHS.map((m, i) => { const k = String(i + 1).padStart(2, '0'); return `<button class="mf-month ${f.startMonths.includes(k) ? 'on' : ''}" data-month="${k}">${m}${monthCount[k] ? ` <span style="opacity:.6">${monthCount[k]}</span>` : ''}</button>`; }).join('')}</div></div>
      <div class="mf-sec" style="margin-top:14px"><div class="mf-sec-title"><i class="ti ti-arrows-sort"></i> Ordenar resultados</div>
        <select class="mf-select" id="mf-sort">
          <option value="priority" ${js.sort === 'priority' ? 'selected' : ''}>Prioridade (ativas no DOL primeiro, depois a nota do sistema)</option>
          <option value="active" ${js.sort === 'active' ? 'selected' : ''}>✅ Ativas primeiro</option>
          <option value="wage" ${js.sort === 'wage' ? 'selected' : ''}>💰 Maior salário primeiro (por hora equivalente)</option>
          <option value="start" ${js.sort === 'start' ? 'selected' : ''}>🗓️ Começa mais cedo primeiro</option>
          <option value="openings" ${js.sort === 'openings' ? 'selected' : ''}>👥 Mais vagas primeiro</option>
          <option value="recent" ${js.sort === 'recent' ? 'selected' : ''}>🆕 Mais recentes primeiro</option>
        </select></div>
    `;
    const body = $('#mf-body');
    body.onclick = (ev) => {
      const v = ev.target.closest('[data-visa]'); if (v) { $$('[data-visa]', body).forEach(b => b.classList.toggle('sel', b === v)); return; }
      const so = ev.target.closest('[data-origin]'); if (so) { $$('[data-origin]', body).forEach(b => b.classList.toggle('sel', b === so)); return; }
      const m = ev.target.closest('[data-month]'); if (m) { m.classList.toggle('on'); return; }
      const y = ev.target.closest('[data-year]'); if (y) { y.classList.toggle('on'); return; }
      if (ev.target.closest('#mf-open-location')) { closeModal('filters-modal'); openLocation(); return; }
    };
    $('#mf-title-q').oninput = (ev) => {
      const q = ev.target.value.toLowerCase();
      $$('#mf-titles label').forEach(l => { l.style.display = l.textContent.toLowerCase().includes(q) ? '' : 'none'; });
    };
    $('#mf-titles').onchange = () => { $('#mf-title-cnt').textContent = $$('#mf-titles input:checked').length; };
    openModal('filters-modal');
  }
  function applyFilters() {
    const f = js.filters;
    f.visa = ($('#mf-body [data-visa].sel') || {}).dataset ? $('#mf-body [data-visa].sel').dataset.visa : 'all';
    const srcSel = $('#mf-body [data-origin].sel'); f.origin = srcSel ? srcSel.dataset.origin : 'all';
    f.city = $('#mf-city').value.trim();
    f.titles = $$('#mf-titles input:checked').map(i => i.dataset.title);
    f.minWage = $('#mf-wage').value.trim();
    f.minOpenings = $('#mf-open').value.trim();
    f.startMonths = $$('#mf-body .mf-month[data-month].on').map(b => b.dataset.month);
    f.years = $$('#mf-body .mf-month[data-year].on').map(b => b.dataset.year);
    const so = $('#mf-sort'); if (so) js.sort = so.value;
    persist(); closeModal('filters-modal'); load(true);
  }

  // ------------------------------------------------------------ localização (estados por região)

  /**
   * Regra: estado marcado aparece, desmarcado some. Lista vazia = todos —
   * assim um estado novo que entre no feed amanhã aparece sem precisar marcar.
   */
  function openLocation() {
    const f = js.filters;
    const byState = Object.fromEntries(((js.facets && js.facets.states) || []).map(s => [s.state, s]));
    const known = new Set(REGIONS.flatMap(r => r.states));
    const extra = Object.keys(byState).filter(s => !known.has(s));
    const regions = REGIONS.concat(extra.length ? [{ id: 'other', label: 'Outros', icon: '📍', states: extra }] : []);
    const isOn = (st) => !f.states.length || f.states.includes(st);
    $('#loc-body').innerHTML = regions.map(r => {
      const states = r.states.filter(st => byState[st]).sort((a, b) => (byState[b].total || 0) - (byState[a].total || 0));
      if (!states.length) return '';
      const total = states.reduce((n, st) => n + (byState[st].total || 0), 0);
      const active = states.reduce((n, st) => n + (byState[st].active || 0), 0);
      const on = states.filter(isOn).length;
      return `<div class="mf-sec loc-region" data-region="${r.id}" style="margin-bottom:12px">
        <label class="mf-check-row" style="border-bottom:1px solid var(--border);margin-bottom:4px">
          <input type="checkbox" class="loc-region-cb" ${on === states.length ? 'checked' : ''} ${on && on < states.length ? 'data-partial="1"' : ''}>
          <span style="flex:1">${r.icon} ${esc(r.label)}</span>
          <span class="tag">${total} vaga${total === 1 ? '' : 's'}${active ? ` · ${active} ativas` : ''}</span>
        </label>
        <div class="loc-grid">${states.map(st => `<label class="mf-check-row loc-state"><input type="checkbox" class="loc-state-cb" data-state="${st}" ${isOn(st) ? 'checked' : ''}> <span style="flex:1"><b>${st}</b> <span class="hint">${esc(US_STATES[st] || st)}</span></span><span class="tag">${byState[st].total}${byState[st].active ? ` · ${byState[st].active} ✅` : ''}</span></label>`).join('')}</div>
      </div>`;
    }).join('') || '<div class="empty-state"><i class="ti ti-map-off"></i><p>Sem estados ainda</p><small>Importe o feed do DOL em Configurações.</small></div>';
    $$('#loc-body .loc-region-cb').forEach(cb => { cb.indeterminate = cb.dataset.partial === '1'; });
    const body = $('#loc-body');
    body.onchange = (ev) => {
      const rc = ev.target.closest('.loc-region-cb');
      if (rc) { $$('.loc-state-cb', rc.closest('.loc-region')).forEach(c => { c.checked = rc.checked; }); rc.indeterminate = false; updateLocSummary(); return; }
      const sc = ev.target.closest('.loc-state-cb');
      if (sc) {
        const reg = sc.closest('.loc-region'); const all = $$('.loc-state-cb', reg); const on = all.filter(c => c.checked).length;
        const rcb = $('.loc-region-cb', reg); rcb.checked = on === all.length; rcb.indeterminate = on > 0 && on < all.length;
        updateLocSummary();
      }
    };
    $('#loc-all').onclick = () => { $$('#loc-body input[type=checkbox]').forEach(c => { c.checked = true; c.indeterminate = false; }); updateLocSummary(); };
    $('#loc-none').onclick = () => { $$('#loc-body input[type=checkbox]').forEach(c => { c.checked = false; c.indeterminate = false; }); updateLocSummary(); };
    $('#loc-apply').onclick = applyLocation;
    updateLocSummary();
    openModal('location-modal');
  }
  function updateLocSummary() {
    const all = $$('#loc-body .loc-state-cb'); const on = all.filter(c => c.checked);
    const btn = $('#loc-apply');
    btn.textContent = !on.length ? 'Marque ao menos um estado' : on.length === all.length ? 'Aplicar · todos os estados' : `Aplicar · ${on.length} de ${all.length} estados`;
    btn.disabled = !on.length;
  }
  function applyLocation() {
    const all = $$('#loc-body .loc-state-cb'); const on = all.filter(c => c.checked).map(c => c.dataset.state);
    if (!on.length) { toast('Marque ao menos um estado — sem nenhum marcado, nenhuma vaga apareceria.'); return; }
    js.filters.states = on.length === all.length ? [] : on;
    persist(); closeModal('location-modal'); load(true);
  }

  // ------------------------------------------------------------ wiring

  function wire() {
    $('#jobs-tabs').onclick = (ev) => {
      const t = ev.target.closest('.stab'); if (!t) return;
      $$('#jobs-tabs .stab').forEach(x => x.classList.toggle('active', x === t));
      js.sheet = t.dataset.sheet; persist(); load(true);
    };
    const q = $('#jobs-q');
    q.oninput = () => { clearTimeout(sugTimer); sugTimer = setTimeout(() => { suggest(q.value.trim()); js.q = q.value.trim(); load(true); }, 280); };
    q.onkeydown = (ev) => { if (ev.key === 'Enter') { $('#jobs-sug').classList.remove('open'); js.q = q.value.trim(); load(true); } if (ev.key === 'Escape') $('#jobs-sug').classList.remove('open'); };
    q.onblur = () => setTimeout(() => $('#jobs-sug').classList.remove('open'), 180);
    $('#jobs-sug').onmousedown = (ev) => {
      const it = ev.target.closest('.q-sug-it'); if (!it) return;
      ev.preventDefault();
      if (it.dataset.job) { select(it.dataset.job); $('#jobs-sug').classList.remove('open'); return; }
      q.value = it.dataset.q; js.q = it.dataset.q; $('#jobs-sug').classList.remove('open'); load(true);
    };
    $$('#f-email, #f-notapplied, #f-housing, #f-dolactive').forEach(b => b.onclick = () => { js.quick[b.dataset.f] = !js.quick[b.dataset.f]; persist(); load(true); });
    $('#f-sort').onchange = (ev) => { js.sort = ev.target.value; persist(); load(true); };
    $('#f-year').onchange = (ev) => { const v = ev.target.value; if (v === '__multi') return; js.filters.years = v ? [v] : []; persist(); load(true); };
    $('#btn-filters').onclick = openFilters;
    $('#btn-location').onclick = openLocation;
    $('#mf-apply').onclick = applyFilters;
    $('#mf-clear').onclick = () => { removeFilter('all'); closeModal('filters-modal'); };
    $('#active-filters').onclick = (ev) => { const c = ev.target.closest('[data-fk]'); if (c) removeFilter(c.dataset.fk, c.dataset.fv); };
    $('#btn-more').onclick = () => load(false);
    $('#jlist').onclick = (ev) => {
      const s = ev.target.closest('[data-save]'); if (s) { ev.stopPropagation(); toggleSave(s.dataset.save); return; }
      const c = ev.target.closest('.jcard'); if (c) select(c.dataset.id);
    };
    const detailClick = (ev) => {
      const send = ev.target.closest('[data-send]'); if (send) { H2B.send.openManual(js.selected); return; }
      const sv2 = ev.target.closest('[data-save2]'); if (sv2) { toggleSave(sv2.dataset.save2); return; }
      const d = ev.target.closest('[data-discard]'); if (d) { discard(d.dataset.discard); return; }
    };
    $('#jd-content').onclick = detailClick;
    $('#mob-jd-content').onclick = detailClick;
  }

  H2B.onShow.jobs = (opts) => {
    if (!js.wired) { restore(); wire(); js.wired = true; $('#f-sort').value = js.sort; $$('#jobs-tabs .stab').forEach(x => x.classList.toggle('active', x.dataset.sheet === js.sheet)); }
    if (opts && opts.sheet) { js.sheet = opts.sheet; $$('#jobs-tabs .stab').forEach(x => x.classList.toggle('active', x.dataset.sheet === js.sheet)); }
    if (opts && opts.q !== undefined) { js.q = opts.q; $('#jobs-q').value = opts.q; }
    loadFacets();
    load(true);
    if (opts && opts.jobId) select(opts.jobId);
  };

  return { js, load, loadFacets, select, US_STATES, MONTHS, REGIONS, detailHTML, openLocation, refreshSelected: () => js.selected && select(js.selected.id) };
})();
