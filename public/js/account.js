/**
 * Login e página de Conta (spec de autenticação §8, §13, §18, §30, §31, §34).
 *
 * A interface deixa visível a diferença entre três coisas que costumam ser
 * confundidas: login na aplicação, fonte de dados do produto e conta do
 * provedor. Nada aqui exibe "conectado" onde não há conexão.
 */

const AccountViews = (() => {
  const { esc, el, kpi, emptyState, toast, errorCard, chip, modal, confirm } = UI;

  const STATUS_CHIP = {
    HEALTHY: ['chip-ok', 'Saudável'],
    CONNECTED: ['chip-ok', 'Conectado'],
    AVAILABLE: ['chip-info', 'Disponível'],
    DEGRADED: ['chip-warn', 'Dados de exemplo'],
    NOT_CONFIGURED: ['chip-plain', 'Não configurado'],
    NOT_SUPPORTED: ['chip-plain', 'Não disponível'],
    REQUIRES_REAUTH: ['chip-warn', 'Reconectar'],
    REQUIRES_ATTENTION: ['chip-crit', 'Precisa de atenção'],
    DISCONNECTED: ['chip-warn', 'Desconectado'],
    REVOKED: ['chip-warn', 'Revogado'],
    ERROR: ['chip-crit', 'Erro'],
    CUSTOM_CLIENT_ACCESS_UNAVAILABLE: ['chip-warn', 'Sem acesso para cliente próprio'],
    SCHEMA_CHANGED: ['chip-crit', 'Formato mudou'],
    PROVIDER_UNAVAILABLE: ['chip-warn', 'Provedor indisponível']
  };

  function statusChip(status) {
    const e = STATUS_CHIP[status];
    return e ? chip(e[1], e[0]) : chip(status || '—', 'chip-plain');
  }

  // =========================================================================
  // Tela de entrada
  // =========================================================================

  async function signIn(route, { erro = null } = {}) {
    const status = await API.auth.status();

    const wrap = el(`<div class="portal">
      <div class="portal-head">
        <h1>Entrar no Job Intelligence</h1>
        <p>${esc(status.disclaimer)}</p>
      </div>
      <div id="body"></div>
    </div>`);

    const body = wrap.querySelector('#body');

    if (erro) {
      body.appendChild(el(`<div class="alert alert-HIGH" style="margin-bottom:16px">
        <div class="alert-body">
          <div class="alert-title">${erro === 'cancelado' ? 'Você cancelou a autorização' : 'O login não foi concluído'}</div>
          <div class="alert-detail">${erro === 'cancelado'
            ? 'Nenhuma conta foi conectada. Tente novamente quando quiser.'
            : 'A verificação da identidade falhou. Tente entrar de novo — se persistir, confira os Logs.'}</div>
        </div>
      </div>`));
    }

    if (status.googleConfigured) {
      const card = el(`<div class="card">
        <div class="card-head"><h2>Continuar com o Google</h2></div>
        <p style="color:var(--ink-2);margin-bottom:16px">
          Pedimos apenas <span class="mono">${esc(status.loginScopes.join(', '))}</span> — o suficiente
          para identificar você. Permissão de envio pelo Gmail é pedida depois, só no Seasonal Jobs,
          e apenas se você quiser automatizar candidaturas.
        </p>
        <button class="btn btn-primary" id="go">Continuar com o Google</button>
      </div>`);

      card.querySelector('#go').addEventListener('click', async (e) => {
        e.target.disabled = true; e.target.textContent = 'Redirecionando…';
        try {
          const { url } = await API.auth.googleStart();
          window.location.href = url;
        } catch (err) {
          toast('Não foi possível iniciar o login', err.message, 'err');
          e.target.disabled = false; e.target.textContent = 'Continuar com o Google';
        }
      });

      body.appendChild(card);
    } else {
      body.appendChild(el(`<div class="card">
        <div class="card-head"><h2>Modo operador local</h2>${chip('sem autenticação', 'chip-warn')}</div>
        <p style="color:var(--ink-2);margin-bottom:14px">${esc(status.notice)}</p>
        <div class="note">
          Para habilitar o login, defina <span class="mono">GOOGLE_AUTH_ENABLED</span>,
          <span class="mono">GOOGLE_AUTH_CLIENT_ID</span> e
          <span class="mono">GOOGLE_AUTH_CLIENT_SECRET</span> no arquivo <span class="mono">.env</span>,
          usando um cliente do tipo "Aplicativo da Web" no Google Cloud Console.
          Ao entrar pela primeira vez, os dados já cadastrados aqui passam a pertencer à sua conta.
        </div>
        <div style="margin-top:16px"><button class="btn btn-primary" id="continue">Continuar sem login</button></div>
      </div>`));
      body.querySelector('#continue').addEventListener('click', () => route.go('#/'));
    }

    return wrap;
  }

  // =========================================================================
  // Página de Conta
  // =========================================================================

  async function account(route) {
    const data = await API.account.get();
    const u = data.auth.user;

    const wrap = el(`<div>
      <div class="page-head">
        <div class="titles">
          <h1>Conta</h1>
          <p class="sub">Sua identidade aqui, suas sessões, e o estado real de cada serviço externo.</p>
        </div>
        <div class="page-actions">
          ${data.auth.localOperatorMode ? '' : '<button class="btn" id="logout">Sair</button>'}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>Identidade</h2>
          ${data.auth.localOperatorMode ? chip('modo local', 'chip-warn') : chip('Google', 'chip-ok')}
        </div>
        <dl class="kv">
          <dt>Nome</dt><dd>${esc(u ? u.displayName : '—')}</dd>
          <dt>E-mail</dt><dd>${esc(u && u.email ? u.email : '—')}</dd>
          <dt>Forma de acesso</dt><dd>${data.auth.localOperatorMode
            ? 'Operador local, sem autenticação'
            : 'Conta Google verificada'}</dd>
          <dt>Último acesso</dt><dd>${esc(u && u.lastLoginAt ? u.lastLoginAt : '—')}</dd>
        </dl>
        ${data.auth.notice ? `<p class="note" style="margin-top:14px">${esc(data.auth.notice)}</p>` : ''}
        <p class="note note-info" style="margin-top:12px">${esc(data.auth.disclaimer)}</p>
      </div>

      <div class="card">
        <div class="card-head"><h2>Serviços conectados</h2></div>
        <div id="conns"></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Estado dos serviços</h2></div>
        <p style="color:var(--ink-2);font-size:13.5px;margin-bottom:12px">
          Fonte de dados e conta de candidato são coisas diferentes. Um MCP saudável significa
          que conseguimos buscar vagas — não que a sua conta naquela plataforma esteja vinculada.
        </p>
        <div id="health"></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Segurança</h2>
          ${data.sessions.filter(s => s.active).length ? chip(`${data.sessions.filter(s => s.active).length} sessão(ões) ativa(s)`, 'chip-plain') : ''}
        </div>
        <div id="sessions"></div>
      </div>
    </div>`);

    // --- conexões de provedor ---
    const conns = wrap.querySelector('#conns');
    for (const c of data.connections) {
      const item = el(`<div style="padding:14px 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px">
          <strong style="font-family:Archivo,sans-serif;font-size:15px">${esc(c.label)}</strong>
          ${statusChip(c.status)}
          ${c.externalAccountEmail ? `<span class="mono" style="font-size:12px;color:var(--ink-3)">${esc(c.externalAccountEmail)}</span>` : ''}
          <span style="flex:1"></span>
          <span data-actions></span>
        </div>
        <div style="color:var(--ink-2);font-size:13.5px">${esc(c.explanation)}</div>
        ${c.personalization ? `<div class="kpi-note" style="margin-top:6px">${esc(c.personalization)}</div>` : ''}
        ${c.grantedScopes.length ? `<div class="kpi-note mono" style="margin-top:6px">escopos: ${esc(c.grantedScopes.join(', '))}</div>` : ''}
      </div>`);

      const actions = item.querySelector('[data-actions]');
      if (c.status === 'CONNECTED') {
        const b = el('<button class="btn btn-sm btn-danger">Desconectar</button>');
        b.addEventListener('click', async () => {
          if (!await confirm(
            `A autorização de ${c.label} será revogada. Sua sessão no Job Intelligence continua ativa.`,
            { title: `Desconectar ${c.label}`, confirmLabel: 'Desconectar', danger: true })) return;
          try { await API.account.disconnect(c.provider); toast('Desconectado', null, 'ok'); route.reload(); }
          catch (e) { toast('Não foi possível desconectar', e.message, 'err'); }
        });
        actions.appendChild(b);
      } else if (c.provider === 'GMAIL') {
        const b = el('<button class="btn btn-sm">Conectar no Seasonal</button>');
        b.addEventListener('click', () => route.go('#/seasonal/settings'));
        actions.appendChild(b);
      }

      conns.appendChild(item);
    }

    // --- matriz de saúde ---
    wrap.querySelector('#health').innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Serviço</th><th>Tipo</th><th>Estado</th><th>Observação</th></tr></thead>
      <tbody>${data.health.map(h => `<tr>
        <td><strong>${esc(h.label)}</strong></td>
        <td class="kpi-note">${esc({
          auth: 'login', data_source: 'fonte de dados', provider_account: 'conta do provedor'
        }[h.kind] || h.kind)}</td>
        <td>${statusChip(h.status)}</td>
        <td class="kpi-note">${esc(h.note)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;

    // --- sessões ---
    const sessions = wrap.querySelector('#sessions');
    if (data.auth.localOperatorMode) {
      sessions.innerHTML = '<p class="note">Não há sessões: esta instalação opera sem login.</p>';
    } else {
      sessions.innerHTML = `<div class="table-wrap"><table>
        <thead><tr><th>Sessão</th><th>Contexto</th><th>Navegador</th><th>Último uso</th><th>Estado</th></tr></thead>
        <tbody>${data.sessions.map(s => `<tr>
          <td class="mono" style="font-size:11.5px">${esc(s.id)}</td>
          <td>${esc([s.product, s.country].filter(Boolean).join(' / ') || '—')}</td>
          <td class="kpi-note">${esc((s.user_agent || '').slice(0, 44) || '—')}</td>
          <td class="kpi-note">${esc(s.last_seen_at)}</td>
          <td>${s.active ? chip('ativa', 'chip-ok') : chip('encerrada', 'chip-plain')}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div style="margin-top:12px"><button class="btn btn-sm" id="revoke-others">Encerrar outras sessões</button></div>`;

      const rb = sessions.querySelector('#revoke-others');
      if (rb) rb.addEventListener('click', async () => {
        try {
          const r = await API.auth.revokeOthers();
          toast('Sessões encerradas', `${r.revoked} sessão(ões) encerrada(s). A atual continua ativa.`, 'ok');
          route.reload();
        } catch (e) { toast('Não foi possível encerrar', e.message, 'err'); }
      });
    }

    const lb = wrap.querySelector('#logout');
    if (lb) lb.addEventListener('click', async () => {
      if (!await confirm(
        'Você sairá do Job Intelligence. Sua conta do Google continua conectada no navegador, e a autorização do Gmail não é revogada.',
        { title: 'Sair', confirmLabel: 'Sair' })) return;
      try {
        const r = await API.auth.logout();
        toast('Você saiu', r.note, 'ok');
        route.go('#/entrar');
      } catch (e) { toast('Não foi possível sair', e.message, 'err'); }
    });

    return wrap;
  }

  return { signIn, account, statusChip, STATUS_CHIP };
})();

window.AccountViews = AccountViews;
