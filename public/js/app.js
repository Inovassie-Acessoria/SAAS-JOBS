/**
 * Roteador e navegação.
 *
 * Ao entrar num produto, a barra lateral mostra APENAS a navegação daquele
 * produto (spec §2.3). Um link discreto de volta ao portal é permitido.
 */

(function () {
  const { esc, el, toast, errorCard, chip, chipFrom, emptyState, HEALTH_CHIP, confirm } = UI;
  const COUNTRY_NAME = { BR: 'Brasil', US: 'Estados Unidos' };

  const viewEl = document.getElementById('view');
  const sidebarEl = document.getElementById('sidebar');
  const crumbEl = document.getElementById('crumb');
  const topRightEl = document.getElementById('topbar-right');

  const route = {
    go(hash) { if (location.hash === hash) render(); else location.hash = hash; },
    reload() { render(); }
  };

  // ---------------------------------------------------------------- navegação

  // Perfil e currículos ficam DENTRO do ambiente: cada plataforma e país tem os
  // seus, e não existe item de menu global apontando para dados compartilhados.
  const BOARD_NAV = (product, c) => {
    const b = `#/${product}/${c}`;
    return [
      { label: 'Dashboard', href: `${b}/dashboard` },
      { label: 'Buscar vagas', href: `${b}/jobs` },
      { label: 'Recomendadas', href: `${b}/recommended` },
      { label: 'Salvas', href: `${b}/saved` },
      { label: 'Descartadas', href: `${b}/discarded` },
      { sep: `Candidato — ${product} ${c.toUpperCase()}` },
      { label: 'Perfil', href: `${b}/profile` },
      { label: 'Currículos', href: `${b}/resumes` },
      { label: 'ATS Center', href: `${b}/ats` },
      { sep: 'Sistema' },
      { label: 'Integração', href: `${b}/settings` },
      { label: 'Logs', href: `${b}/logs` }
    ];
  };

  const SEASONAL_NAV = [
    { label: 'Dashboard', href: '#/seasonal/dashboard' },
    { label: 'Ordens de serviço', href: '#/seasonal/jobs' },
    { label: 'Recomendadas', href: '#/seasonal/recommended' },
    { label: 'Salvas', href: '#/seasonal/saved' },
    { label: 'Ação manual', href: '#/seasonal/manual' },
    { sep: 'Candidaturas' },
    { label: 'Fila de envio', href: '#/seasonal/queue' },
    { label: 'Enviadas', href: '#/seasonal/sent' },
    { label: 'Telefone e WhatsApp', href: '#/seasonal/acoes-manuais' },
    { sep: 'Candidato — Seasonal' },
    { label: 'Perfil', href: '#/seasonal/profile' },
    { label: 'Perfil de motorista', href: '#/seasonal/motorista' },
    { label: 'Documentos', href: '#/seasonal/resumes' },
    { label: 'ATS Center', href: '#/seasonal/ats' },
    { sep: 'Sistema' },
    { label: 'Central de Robôs', href: '#/robos' },
    { label: 'Configurações', href: '#/seasonal/settings' },
    { label: 'Logs', href: '#/seasonal/logs' }
  ];

  function renderSidebar(items, current) {
    if (!items) { sidebarEl.hidden = true; sidebarEl.innerHTML = ''; return; }
    sidebarEl.hidden = false;
    sidebarEl.innerHTML = '';

    const back = el('<button class="back-link">← Todos os produtos</button>');
    back.addEventListener('click', () => route.go('#/'));
    sidebarEl.appendChild(back);

    for (const item of items) {
      if (item.sep) {
        sidebarEl.appendChild(el(`<div class="side-label">${esc(item.sep)}</div>`));
        continue;
      }
      const b = el(`<button class="nav-item">${esc(item.label)}</button>`);
      if (item.href === current) b.setAttribute('aria-current', 'page');
      b.addEventListener('click', () => route.go(item.href));
      sidebarEl.appendChild(b);
    }
  }

  function renderCrumb(parts) {
    crumbEl.innerHTML = parts.length
      ? parts.map((p, i) => `${i ? '<span class="crumb-sep">/</span>' : ''}${p.strong ? `<b>${esc(p.label)}</b>` : esc(p.label)}`).join('')
      : '';
  }

  /** Barra superior: saúde do sistema + identidade (spec §30). */
  async function renderHealth() {
    topRightEl.innerHTML = '';

    try {
      const h = await API.core.health();
      const badge = el(chipFrom(HEALTH_CHIP, h.status, h.status));
      badge.title = Object.entries(h.checks).map(([k, v]) => `${k}: ${v}`).join('\n');
      topRightEl.appendChild(badge);
    } catch (e) { /* a saúde é informativa; sua ausência não quebra a barra */ }

    try {
      const s = await API.auth.status();
      const label = s.user ? (s.user.email || s.user.displayName || 'Conta') : 'Entrar';
      const b = el(`<button class="btn btn-sm btn-ghost">${esc(label)}</button>`);
      if (s.localOperatorMode) {
        b.title = s.notice;
        b.appendChild(el('<span class="chip chip-warn" style="margin-left:6px">local</span>'));
      }
      b.addEventListener('click', () => route.go(s.user ? '#/conta' : '#/entrar'));
      topRightEl.appendChild(b);
    } catch (e) { /* sem status de auth, a barra fica só com a saúde */ }
  }

  // ---------------------------------------------------------------- views extras

  async function boardSettings(product, country) {
    const api = API[product];
    const label = product === 'gupy' ? 'Gupy' : 'Indeed';
    const [{ integration }, { config }] = await Promise.all([api.integration(country), api.getConfig(country)]);

    const wrap = el(`<div>
      <div class="page-head">
        <div class="titles"><h1>${esc(label)} ${esc(COUNTRY_NAME[country])} — Configurações</h1>
          <p class="sub">Integração e limiares deste mercado. Alterações aqui não afetam o outro país nem o outro produto.</p></div>
        <div class="page-actions"><button class="btn btn-primary" id="save">Salvar</button></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Integração MCP</h2>${chipFrom(HEALTH_CHIP, integration.health_status, integration.health_status)}</div>
        <div class="field">
          <label for="mcp_url">Endereço do servidor MCP</label>
          <input type="url" id="mcp_url" value="${esc(integration.mcp_url || '')}" placeholder="https://…/mcp">
          <div class="hint">Sem endereço configurado, o produto opera com vagas de exemplo — sempre rotuladas como tal. O token vem da variável de ambiente <span class="mono">${esc(product.toUpperCase())}_MCP_TOKEN</span> e nunca é gravado no banco.</div>
        </div>
        <dl class="kv" style="margin-bottom:14px">
          <dt>Autenticação</dt><dd>${esc(integration.auth_status)}</dd>
          <dt>Último sucesso</dt><dd>${esc(integration.last_success_at || '—')}</dd>
          <dt>Última falha</dt><dd>${esc(integration.last_failure_at || '—')}</dd>
          <dt>Última busca</dt><dd>${esc(integration.last_search_at || '—')}</dd>
          ${integration.last_error ? `<dt>Último erro</dt><dd>${esc(integration.last_error)}</dd>` : ''}
          <dt>Ferramentas</dt><dd class="mono" style="font-size:12px">${esc((JSON.parse(integration.tools_json || '[]') || []).join(', ') || '—')}</dd>
        </dl>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" id="test">Testar conexão</button>
          <button class="btn btn-danger" id="disconnect">Desconectar</button>
        </div>
        <div id="result" style="margin-top:12px"></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Perfil de busca deste mercado</h2></div>
        <div class="field-row">
          <div class="field"><label for="target_role">Cargo alvo</label>
            <input type="text" id="target_role" value="${esc(config.target_role || '')}"></div>
          <div class="field"><label for="career_track">Trilha de carreira</label>
            <input type="text" id="career_track" value="${esc(config.career_track || 'geral')}">
            <div class="hint">Usada para escolher o currículo certo da biblioteca.</div></div>
          <div class="field"><label for="workplace_preference">Modelo de trabalho</label>
            <select id="workplace_preference">
              ${['remote', 'remote_only', 'hybrid', 'onsite'].map(v =>
                `<option value="${v}" ${config.workplace_preference === v ? 'selected' : ''}>${
                  { remote: 'Prefiro remoto', remote_only: 'Somente remoto', hybrid: 'Híbrido', onsite: 'Presencial' }[v]}</option>`).join('')}
            </select></div>
        </div>
        <div class="field-row">
          ${country === 'BR'
            ? `<div class="field"><label for="min_salary_month">Salário mínimo mensal (R$)</label>
                 <input type="number" id="min_salary_month" value="${config.min_salary_month || ''}"></div>`
            : `<div class="field"><label for="min_salary_year">Salário mínimo anual (US$)</label>
                 <input type="number" id="min_salary_year" value="${config.min_salary_year || ''}"></div>`}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Limiares de recomendação</h2></div>
        <div class="field-row">
          <div class="field"><label for="top_priority_threshold">Prioridade máxima a partir de</label>
            <input type="number" id="top_priority_threshold" value="${esc(config.top_priority_threshold)}"></div>
          <div class="field"><label for="strong_match_threshold">Match forte a partir de</label>
            <input type="number" id="strong_match_threshold" value="${esc(config.strong_match_threshold)}"></div>
          <div class="field"><label for="possible_match_threshold">Match possível a partir de</label>
            <input type="number" id="possible_match_threshold" value="${esc(config.possible_match_threshold)}"></div>
        </div>
        <p class="note">Vagas abaixo do limiar de "match possível" ficam fora da lista de recomendadas, mas continuam em "Todas as vagas".</p>
      </div>
    </div>`);

    wrap.querySelector('#test').addEventListener('click', async (e) => {
      e.target.disabled = true;
      const out = wrap.querySelector('#result');
      out.innerHTML = '<div class="progress-step active"><span class="spinner"></span><span>Testando…</span></div>';
      try { out.innerHTML = SeasonalViews.diagnostic(await api.testIntegration(country)); }
      catch (err) { out.innerHTML = ''; out.appendChild(errorCard(err)); }
      finally { e.target.disabled = false; }
    });

    wrap.querySelector('#disconnect').addEventListener('click', async () => {
      if (!await confirm('O endereço configurado será removido e o produto voltará a operar com dados de exemplo.',
                         { title: 'Desconectar integração', confirmLabel: 'Desconectar', danger: true })) return;
      try { await api.disconnect(country); toast('Integração desconectada', null, 'ok'); route.reload(); }
      catch (e) { toast('Não foi possível desconectar', e.message, 'err'); }
    });

    wrap.querySelector('#save').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await api.setIntegration(country, { mcp_url: wrap.querySelector('#mcp_url').value });
        const body = {};
        for (const id of ['target_role', 'career_track', 'workplace_preference', 'min_salary_month',
                          'min_salary_year', 'top_priority_threshold', 'strong_match_threshold', 'possible_match_threshold']) {
          const f = wrap.querySelector('#' + id);
          if (f) body[id] = f.value;
        }
        await api.saveConfig(country, body);
        toast('Configurações salvas', null, 'ok');
        route.reload();
      } catch (err) { toast('Não foi possível salvar', err.message, 'err'); }
      finally { e.target.disabled = false; }
    });

    return wrap;
  }

  async function logsView({ title, sub, fetcher }) {
    const wrap = el(`<div>
      <div class="page-head"><div class="titles"><h1>${esc(title)}</h1><p class="sub">${esc(sub)}</p></div></div>
      <div id="list"></div>
    </div>`);

    const list = wrap.querySelector('#list');
    try {
      const { logs } = await fetcher();
      if (!logs.length) {
        list.appendChild(emptyState({ title: 'Nenhum registro ainda', message: 'As ações executadas neste ambiente aparecem aqui, com data, ação e detalhe técnico.' }));
      } else {
        list.appendChild(el(`<div class="table-wrap"><table>
          <thead><tr><th>Quando</th><th>Nível</th><th>Ação</th><th>Mensagem</th></tr></thead>
          <tbody>${logs.map(l => `<tr>
            <td class="mono" style="font-size:11.5px;white-space:nowrap">${esc(l.timestamp)}</td>
            <td>${chip(l.level || 'info', l.level === 'error' ? 'chip-crit' : l.level === 'warn' ? 'chip-warn' : 'chip-plain')}</td>
            <td class="mono" style="font-size:11.5px">${esc(l.action)}</td>
            <td>${esc(l.message)}</td>
          </tr>`).join('')}</tbody></table></div>`));
      }
    } catch (err) { list.appendChild(errorCard(err)); }
    return wrap;
  }

  // ---------------------------------------------------------------- roteador

  function parse() {
    const h = location.hash.replace(/^#\/?/, '');
    return h ? h.split('/').filter(Boolean) : [];
  }

  async function render() {
    const p = parse();
    viewEl.innerHTML = '';
    viewEl.appendChild(UI.skeletonList(2));
    renderHealth();

    try {
      const node = await resolve(p);
      viewEl.innerHTML = '';
      viewEl.appendChild(node);
      document.getElementById('main').focus({ preventScroll: true });
      window.scrollTo(0, 0);
    } catch (err) {
      viewEl.innerHTML = '';
      viewEl.appendChild(errorCard(err, { onRetry: render }));
    }
  }

  async function resolve(p) {
    // Portal
    if (!p.length) {
      renderSidebar(null); renderCrumb([]);
      return Views.portal(route);
    }

    // Entrada e conta (spec de autenticação §8, §13, §30)
    if (p[0] === 'entrar') {
      renderSidebar(null);
      renderCrumb([{ label: 'Entrar', strong: true }]);
      const erro = new URLSearchParams((location.hash.split('?')[1] || '')).get('erro');
      return AccountViews.signIn(route, { erro });
    }

    if (p[0] === 'conta') {
      renderSidebar(null);
      renderCrumb([{ label: 'Conta', strong: true }]);
      return AccountViews.account(route);
    }

    // Central de Robôs — atravessa os três produtos, por isso vive fora deles
    // (spec de agentes §55: o resumo do que aconteceu enquanto o usuário esteve fora).
    if (p[0] === 'robos') {
      renderSidebar(null);
      renderCrumb([{ label: 'Central de Robôs', strong: true }]);
      return AutonomyViews.control(route);
    }

    // Seasonal — US only
    if (p[0] === 'seasonal') {
      const page = p[1] || 'dashboard';
      const current = `#/seasonal/${page}`;
      renderSidebar(SEASONAL_NAV, page === 'job' ? '#/seasonal/jobs' : current);
      renderCrumb([{ label: 'Seasonal Jobs', strong: true }, { label: 'Estados Unidos' }]);

      switch (page) {
        case 'dashboard':   return SeasonalViews.dashboard(route);
        case 'jobs':        return SeasonalViews.jobs('all', route);
        case 'recommended': return SeasonalViews.jobs('recommended', route);
        case 'saved':       return SeasonalViews.jobs('saved', route);
        case 'manual':      return SeasonalViews.jobs('manual_action', route);
        case 'discarded':   return SeasonalViews.jobs('discarded', route);
        case 'job':         return SeasonalViews.jobDetail(Number(p[2]), route);
        case 'queue':       return SeasonalViews.queue(route);
        case 'sent':        return SeasonalViews.sent(route);
        case 'motorista':      return AutonomyViews.driverProfile(route);
        case 'acoes-manuais':  return AutonomyViews.manualActions(route);
        case 'settings':    return SeasonalViews.settings(route);
        case 'profile':     return Views.environmentProfile('seasonal', 'us', route);
        case 'resumes':     return Views.environmentResumes('seasonal', 'us', route);
        case 'ats':         return Views.atsCenter('seasonal', 'us', route);
        case 'logs':        return logsView({
          title: 'Logs do Seasonal Jobs',
          sub: 'Importações, preparo de pacotes e envios. Nenhum log de outro produto aparece aqui.',
          fetcher: API.seasonal.logs
        });
        default: return notFound();
      }
    }

    // Gupy e Indeed
    if (p[0] === 'gupy' || p[0] === 'indeed') {
      const product = p[0];
      const label = product === 'gupy' ? 'Gupy' : 'Indeed';

      if (!p[1]) {
        renderSidebar(null);
        renderCrumb([{ label, strong: true }]);
        return Views.countryChoice(product, route);
      }

      const cc = String(p[1]).toLowerCase();
      if (cc !== 'br' && cc !== 'us') return notFound();
      const country = cc.toUpperCase();

      const page = p[2] || 'dashboard';
      const current = `#/${product}/${cc}/${page}`;
      renderSidebar(BOARD_NAV(product, cc), page === 'job' ? `#/${product}/${cc}/jobs` : current);
      renderCrumb([{ label, strong: true }, { label: COUNTRY_NAME[country] }]);

      switch (page) {
        case 'dashboard':   return Views.boardDashboard(product, country, route);
        case 'jobs':        return Views.boardJobs(product, country, 'all', route);
        case 'recommended': return Views.boardJobs(product, country, 'recommended', route);
        case 'saved':       return Views.boardJobs(product, country, 'saved', route);
        case 'discarded':   return Views.boardJobs(product, country, 'discarded', route);
        case 'job':         return Views.boardJobDetail(product, country, Number(p[3]), route);
        case 'profile':     return Views.environmentProfile(product, cc, route);
        case 'resumes':     return Views.environmentResumes(product, cc, route);
        case 'ats':         return Views.atsCenter(product, cc, route);
        case 'settings':    return boardSettings(product, country);
        case 'logs':        return logsView({
          title: `Logs — ${label} ${COUNTRY_NAME[country]}`,
          sub: 'Somente eventos deste produto e país.',
          fetcher: () => API[product].logs(country)
        });
        default: return notFound();
      }
    }

    return notFound();
  }

  function notFound() {
    renderSidebar(null); renderCrumb([]);
    return emptyState({
      title: 'Página não encontrada',
      message: 'O endereço acessado não corresponde a nenhuma área do sistema.',
      actionLabel: 'Voltar ao início',
      onAction: () => route.go('#/')
    });
  }

  document.getElementById('brand').addEventListener('click', () => route.go('#/'));
  window.addEventListener('hashchange', render);
  render();
})();
