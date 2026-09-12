/**
 * Views do Seasonal Jobs (spec §28, §29, §30, §31, §45, §65).
 * Produto exclusivamente US: nenhuma noção de país aqui.
 */

const SeasonalViews = (() => {
  const { esc, el, kpi, attention, emptyState, skeletonList, progress, toast,
          errorCard, chip, chipFrom, modal, confirm, HEALTH_CHIP, ATS_STATUS } = UI;

  const STATUS_CHIP = {
    QUEUED:          ['chip-info', 'Na fila'],
    AWAITING_REVIEW: ['chip-warn', 'Aguardando revisão'],
    SENDING:         ['chip-info', 'Enviando'],
    SENT:            ['chip-ok', 'Enviada'],
    DEFERRED:        ['chip-warn', 'Reagendada'],
    FAILED:          ['chip-crit', 'Falhou'],
    SKIPPED:         ['chip-plain', 'Ignorada']
  };

  /**
   * Painel de configuração do cliente OAuth do Google.
   *
   * Existe porque a versão anterior dizia "configure GOOGLE_CLIENT_ID no .env"
   * e parava aí — quem não tem acesso ao arquivo do servidor ficava sem saída.
   * Aqui as duas URIs de redirecionamento aparecem prontas para copiar, que é
   * exatamente onde a configuração costuma falhar.
   */
  function googleCredentialsPanel(gc) {
    if (gc.managedByEnv) {
      return `<div class="note" style="margin-top:12px">
        As credenciais deste servidor vêm de variáveis de ambiente
        (<span class="mono">${esc(gc.clientIdMasked)}</span>) e não são editáveis por aqui.
      </div>`;
    }

    if (gc.configured) {
      return `<details style="margin-top:12px">
        <summary class="link">Cliente OAuth configurado — ver ou trocar</summary>
        <div style="margin-top:12px">
          <dl class="kv">
            <dt>Client ID</dt><dd class="mono">${esc(gc.clientIdMasked)}</dd>
            <dt>Client Secret</dt><dd>guardado, cifrado em repouso</dd>
            <dt>Origem</dt><dd>configurado por esta tela</dd>
          </dl>
          ${redirectBlock(gc)}
          <button class="btn btn-danger" id="gc-clear" style="margin-top:12px">Remover credenciais</button>
        </div>
      </details>`;
    }

    return `<div class="card" style="margin-top:14px;background:var(--surface-2, #f7f7f8)">
      <div class="card-head"><h3 style="margin:0">Criar o cliente OAuth do Google</h3></div>

      ${!gc.encryptionConfigured ? `<div class="note chip-crit" style="margin-bottom:12px">
        <strong>APP_ENCRYPTION_KEY não está definida neste servidor.</strong>
        Sem ela o Client Secret não pode ser guardado com segurança. Defina a chave
        no arquivo <span class="mono">.env</span> e reinicie a aplicação antes de continuar.
      </div>` : ''}

      <ol style="margin:0 0 14px 18px;padding:0;line-height:1.9">
        <li>Abra o <a href="${esc(gc.consoleUrl)}" target="_blank" rel="noopener">Google Cloud Console → Credenciais</a>.</li>
        <li>Clique em <strong>Criar credenciais → ID do cliente OAuth</strong>.</li>
        <li>Em tipo de aplicativo, escolha <strong>Aplicativo da Web</strong>.</li>
        <li>Em <strong>URIs de redirecionamento autorizados</strong>, cole as duas linhas abaixo.</li>
        <li>Ative a <strong>Gmail API</strong> no projeto (Biblioteca → Gmail API → Ativar).</li>
        <li>Copie o <strong>ID do cliente</strong> e a <strong>Chave secreta</strong> para os campos abaixo.</li>
      </ol>

      ${redirectBlock(gc)}

      <div class="field" style="margin-top:14px">
        <label for="gc-id">ID do cliente</label>
        <input type="text" id="gc-id" placeholder="000000000000-xxxxxxxx.apps.googleusercontent.com" autocomplete="off">
      </div>
      <div class="field">
        <label for="gc-secret">Chave secreta do cliente</label>
        <input type="password" id="gc-secret" placeholder="GOCSPX-…" autocomplete="off">
        <div class="hint">Guardada cifrada com AES-256-GCM. Nunca é devolvida por nenhuma tela nem gravada em log.</div>
      </div>
      <button class="btn btn-primary" id="gc-save" ${gc.encryptionConfigured ? '' : 'disabled'}>
        Salvar e habilitar o login do Google</button>
      <div id="gc-result" style="margin-top:10px"></div>
    </div>`;
  }

  function redirectBlock(gc) {
    const row = (label, value) => `
      <div style="margin-bottom:8px">
        <div class="hint" style="margin-bottom:2px">${esc(label)}</div>
        <div style="display:flex;gap:6px;align-items:center">
          <code class="mono" style="flex:1;word-break:break-all;padding:6px 8px;background:var(--surface,#fff);border-radius:4px">${esc(value)}</code>
          <button class="btn btn-sm copy-uri" data-uri="${esc(value)}" type="button">Copiar</button>
        </div>
      </div>`;
    return `<div style="margin-top:10px">
      ${row('URI de redirecionamento — envio pelo Gmail', gc.gmailRedirectUri)}
      ${row('URI de redirecionamento — login na aplicação', gc.signinRedirectUri)}
      <p class="note">As duas precisam estar cadastradas no mesmo cliente OAuth. Um endereço diferente
      do cadastrado produz o erro <span class="mono">redirect_uri_mismatch</span> na tela do Google.</p>
    </div>`;
  }

  /**
   * Contas de envio em rodízio (F1.3).
   *
   * Uma conta só, disparando volume constante, é o que o Google estrangula
   * primeiro. Aqui você vê cada conta com a cota do dia, desliga a que foi
   * bloqueada sem parar as outras, e acrescenta novas — que é o equivalente ao
   * "/oauth/add-sender" do sistema de referência.
   */
  function sendersPanel(st, oauthReady) {
    const senders = st.senders || [];
    const rows = senders.map(s => `
      <tr class="${s.isActive ? '' : 'row-muted'}">
        <td>
          <strong>${esc(s.email)}</strong>${s.isPrimary ? ' ' + chip('primária', 'chip-plain') : ''}
          ${s.lastError ? `<div class="kpi-note" style="color:var(--stop,#b3261e)">${esc(String(s.lastError).slice(0, 90))}</div>` : ''}
        </td>
        <td class="num" style="white-space:nowrap">
          <span class="mono">${s.todaySent}</span> / <span class="mono">${s.todayLimit}</span>
          <div class="kpi-note">${esc(s.limitSource)}</div>
        </td>
        <td>
          <input type="number" min="0" max="${st.providerHardLimit || 500}" class="sender-limit" data-id="${s.id}"
                 value="${s.dailyLimit == null ? '' : s.dailyLimit}" placeholder="auto" style="width:80px;font-size:.9em;padding:4px 6px">
        </td>
        <td>${s.isActive ? chip('no rodízio', 'chip-ok') : chip('desligada', 'chip-warn')}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm btn-ghost sender-toggle" data-id="${s.id}" data-active="${s.isActive ? 1 : 0}">
            ${s.isActive ? 'Desligar' : 'Religar'}</button>
          <button class="btn btn-sm btn-ghost sender-remove" data-id="${s.id}" data-email="${esc(s.email)}">Remover</button>
        </td>
      </tr>`).join('');

    return `<div class="card" id="senders-card">
      <div class="card-head"><h2>Contas de envio</h2>
        ${chip(`${st.active || 0} ativa(s) de ${st.total || 0}`, (st.active || 0) >= 2 ? 'chip-ok' : 'chip-warn')}</div>

      <dl class="kv" style="margin-bottom:12px">
        <dt>Teto do dia</dt><dd><span class="mono">${st.globalCap || 0}</span> e-mails</dd>
        <dt>Capacidade com as contas ativas</dt><dd><span class="mono">${st.dailyCapacity || 0}</span> e-mails</dd>
        <dt>Rodízio</dt><dd>um envio por conta, em ordem — quem enviou menos hoje vai primeiro</dd>
      </dl>

      ${st.singleAccountWarning ? `<div class="note" style="border-left:3px solid var(--warn,#a15c07);margin-bottom:12px">
        <strong>${(st.active || 0) === 0 ? 'Nenhuma conta ativa.' : 'Só uma conta ativa.'}</strong>
        Volume constante saindo de uma conta só é o que o Google bloqueia primeiro.
        Com ${st.globalCap || 300} e-mails por dia, o recomendado são <strong>três contas</strong>.
      </div>` : ''}

      ${senders.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Conta</th><th class="num">Hoje</th><th>Limite/dia</th><th>Estado</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>` : `<p class="note">Nenhuma conta conectada ainda.</p>`}

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;align-items:center">
        <button class="btn btn-primary" id="sender-add" ${oauthReady ? '' : 'disabled'}>Acrescentar conta do Gmail</button>
        ${oauthReady ? '' : '<span class="hint">Configure o cliente OAuth do Google acima para habilitar.</span>'}
      </div>
      <p class="note" style="margin-top:10px">
        Ao acrescentar, o Google vai mostrar o <strong>seletor de contas</strong> — escolha a conta que ainda não está na lista.
        Se ele entrar direto sem perguntar, saia da conta atual no Google antes de tentar de novo.
        Limite em branco = fatia igual do teto do dia. O Gmail corta em ${st.providerHardLimit || 500}/dia por conta.
      </p>
    </div>`;
  }

  function wireSenders(wrap, route) {
    const add = wrap.querySelector('#sender-add');
    if (add && !add.disabled) add.addEventListener('click', async () => {
      try {
        const { url } = await API.gmailSenders.addUrl();
        window.open(url, '_blank', 'noopener');
        toast('Escolha a conta na nova aba', 'Depois de autorizar, volte aqui e recarregue para ver a conta na lista.');
      } catch (e) { toast('Não foi possível iniciar', e.message, 'err'); }
    });

    wrap.querySelectorAll('.sender-toggle').forEach(b => b.addEventListener('click', async () => {
      const id = Number(b.dataset.id);
      const active = b.dataset.active !== '1';
      try {
        await API.gmailSenders.setActive(id, active);
        toast(active ? 'Conta religada' : 'Conta desligada',
          active ? 'Ela volta ao rodízio no próximo envio.' : 'As outras contas continuam enviando.', 'ok');
        route.reload();
      } catch (e) { toast('Não foi possível alterar', e.message, 'err'); }
    }));

    wrap.querySelectorAll('.sender-limit').forEach(inp => inp.addEventListener('change', async () => {
      const id = Number(inp.dataset.id);
      const v = inp.value.trim() === '' ? null : Number(inp.value);
      try {
        await API.gmailSenders.setLimit(id, v);
        toast('Limite atualizado', v === null ? 'Voltou ao automático (fatia do teto do dia).' : `${v} por dia para esta conta.`, 'ok');
        route.reload();
      } catch (e) { toast('Não foi possível alterar', e.message, 'err'); route.reload(); }
    }));

    wrap.querySelectorAll('.sender-remove').forEach(b => b.addEventListener('click', async () => {
      if (!await confirm(`A conta ${b.dataset.email} sai do rodízio e a autorização dela é apagada. Para usá-la de novo, será preciso autorizar outra vez.`,
                         { title: 'Remover conta de envio', confirmLabel: 'Remover', danger: true })) return;
      try { await API.gmailSenders.remove(Number(b.dataset.id)); toast('Conta removida', null, 'ok'); route.reload(); }
      catch (e) { toast('Não foi possível remover', e.message, 'err'); }
    }));
  }

  /** Liga os controles do painel de credenciais dentro de um container. */
  function wireGoogleCredentials(wrap, route) {
    wrap.querySelectorAll('.copy-uri').forEach(b => {
      b.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.uri);
          const before = b.textContent;
          b.textContent = 'Copiado';
          setTimeout(() => { b.textContent = before; }, 1500);
        } catch (e) { toast('Não foi possível copiar', 'Selecione o texto e copie manualmente.', 'warn'); }
      });
    });

    const save = wrap.querySelector('#gc-save');
    if (save) save.addEventListener('click', async (e) => {
      const id = wrap.querySelector('#gc-id').value.trim();
      const secret = wrap.querySelector('#gc-secret').value.trim();
      const out = wrap.querySelector('#gc-result');
      e.target.disabled = true;
      out.innerHTML = '';
      try {
        await API.googleCredentials.save(id, secret);
        toast('Credenciais salvas', 'O botão de entrar com o Google já está ativo.', 'ok');
        route.reload();
      } catch (err) {
        out.appendChild(errorCard(err));
        e.target.disabled = false;
      }
    });

    const clear = wrap.querySelector('#gc-clear');
    if (clear) clear.addEventListener('click', async () => {
      if (!await confirm('O cliente OAuth será removido e o envio pelo Gmail deixará de funcionar até você configurar outro.',
                         { title: 'Remover credenciais', confirmLabel: 'Remover', danger: true })) return;
      try { await API.googleCredentials.clear(); toast('Credenciais removidas', null, 'ok'); route.reload(); }
      catch (e) { toast('Não foi possível remover', e.message, 'err'); }
    });
  }

  // =========================================================================

  async function dashboard(route) {
    const d = await API.seasonal.dashboard();

    const wrap = el(`<div>
      <div class="page-head">
        <div class="titles">
          <h1>Seasonal Jobs</h1>
          <p class="sub">Ordens de serviço H-2A e H-2B nos Estados Unidos, priorizadas pela janela de contratação de ${esc(d.automation.targetYear)}.</p>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary" id="import">Importar do DOL</button>
          <button class="btn ${d.automation.paused ? 'btn-primary' : 'btn-danger'}" id="pause">
            ${d.automation.paused ? 'Retomar envios' : 'Pausar envios'}
          </button>
        </div>
      </div>
      <div id="attn"></div>
      <div class="grid grid-kpi" id="kpis"></div>
      <div class="card" style="margin-top:16px" id="quota"></div>
      <div style="margin-top:20px"><h2 style="margin-bottom:12px">Prioridade ${esc(d.automation.targetYear)}</h2><div id="top"></div></div>
      <div style="margin-top:20px" id="secondary"></div>
    </div>`);

    const attnNode = attention(d.attention, (a) => {
      const map = { gmail: '#/seasonal/settings', configure: '#/seasonal/settings', pause: '#/seasonal/settings',
                    review: '#/seasonal/queue', queue: '#/seasonal/queue', documents: '#/seasonal/resumes', profile: '#/seasonal/profile' };
      route.go(map[a.action] || '#/seasonal/settings');
    });
    if (attnNode) wrap.querySelector('#attn').appendChild(attnNode);

    wrap.querySelector('#kpis').innerHTML = [
      kpi({ label: `Prioridade ${d.automation.targetYear}`, value: d.kpis.target2027, accent: true }),
      kpi({ label: 'Recomendadas', value: d.kpis.recommended }),
      kpi({ label: 'Na fila', value: d.kpis.queued }),
      kpi({ label: 'Enviadas hoje', value: `${d.kpis.sentToday}/${d.kpis.dailyLimit}` }),
      kpi({ label: 'Restam hoje', value: d.kpis.remaining }),
      kpi({ label: 'Falhas', value: d.kpis.failures })
    ].join('');

    // Painel de cota (spec §36 do build prompt)
    const q = d.quota;
    const pct = q.maxLimit ? Math.round((q.countSent / q.maxLimit) * 100) : 0;
    wrap.querySelector('#quota').innerHTML = `
      <div class="card-head"><h3>Cota diária de candidaturas</h3>
        ${d.automation.paused ? chip('Envio pausado', 'chip-crit') : chip('Envio ativo', 'chip-ok')}</div>
      <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:10px">
        <span style="font-size:30px;font-weight:700;font-variant-numeric:tabular-nums">${esc(q.countSent)}</span>
        <span style="color:var(--ink-3)">de ${esc(q.maxLimit)} enviadas hoje · ${esc(q.remaining)} restantes</span>
      </div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <p class="note" style="margin-top:10px">
        O limite é aplicado no servidor com reserva atômica: mesmo com vários processos, o envio 51 não acontece.
        Virada do dia no fuso ${esc(q.timezone)}${q.reset.hoursLeft != null ? ` — faltam ${esc(q.reset.hoursLeft)}h${esc(q.reset.minutesLeft)}min` : ''}.
        O excedente permanece na fila; nada é descartado.
      </p>`;

    const top = wrap.querySelector('#top');
    if (!d.top2027.length) {
      top.appendChild(emptyState({
        title: `Nenhuma oportunidade de ${d.automation.targetYear} ainda`,
        message: 'Importe as ordens de serviço do DOL. O sistema classifica a janela de contratação de cada vaga e coloca as de 2027 na frente, mesmo quando outra tem pontuação maior.',
        actionLabel: 'Importar do DOL',
        onAction: () => runImport(route)
      }));
    } else {
      const list = el('<div class="job-list"></div>');
      for (const j of d.top2027) list.appendChild(Views.jobCardFor('seasonal', 'US', j, route));
      top.appendChild(list);
    }

    wrap.querySelector('#secondary').appendChild(el(`
      <details class="disclose">
        <summary>Números secundários</summary>
        <div class="body"><div class="grid grid-kpi">
          ${kpi({ label: 'Total de ordens', value: d.secondary.total })}
          ${kpi({ label: 'H-2A', value: d.secondary.h2a })}
          ${kpi({ label: 'H-2B', value: d.secondary.h2b })}
          ${kpi({ label: 'Exigem ação manual', value: d.secondary.manualAction })}
          ${kpi({ label: 'Sem data de contratação', value: d.secondary.unknownDate })}
          ${kpi({ label: 'Aguardando revisão', value: d.secondary.pendingReview })}
        </div></div>
      </details>`));

    wrap.querySelector('#import').addEventListener('click', () => runImport(route));
    wrap.querySelector('#pause').addEventListener('click', async () => {
      const next = !d.automation.paused;
      if (next && !await confirm(
        'Nenhuma candidatura sairá do sistema enquanto a pausa estiver ativa. A importação, a análise e o preparo dos pacotes continuam normalmente.',
        { title: 'Pausar envios', confirmLabel: 'Pausar', danger: true })) return;
      try {
        await API.seasonal.pause(next);
        toast(next ? 'Envios pausados' : 'Envios retomados', null, 'ok');
        route.reload();
      } catch (e) { toast('Não foi possível alterar', e.message, 'err'); }
    });

    return wrap;
  }

  async function runImport(route) {
    const node = progress([
      { label: 'Consultando a fonte do DOL', state: 'active' },
      { label: 'Normalizando ordens de serviço', state: '' },
      { label: 'Classificando janela de contratação', state: '' },
      { label: 'Pontuando e priorizando', state: '' }
    ]);
    const view = document.getElementById('view');
    view.prepend(node);

    try {
      const { metrics } = await API.seasonal.import({});
      node.remove();
      const parts = [`${metrics.received} recebida(s)`, `${metrics.newJobs} nova(s)`, `${metrics.analyzed} analisada(s)`];
      if (metrics.filteredOut + metrics.prefiltered) parts.push(`${metrics.filteredOut + metrics.prefiltered} filtrada(s)`);
      if (metrics.autoQueued && metrics.autoQueued.queued) parts.push(`${metrics.autoQueued.queued} preparada(s) automaticamente`);
      toast('Importação concluída', parts.join(' · '), 'ok');
      if (metrics.fixtureMode) {
        toast('Dados de exemplo', 'A URL do feed do DOL não está configurada. Estas ordens são exemplos locais.');
      }
      route.reload();
    } catch (err) {
      node.remove();
      view.prepend(errorCard(err, { onRetry: () => runImport(route) }));
      toast('A importação não foi concluída', err.message, 'err');
    }
  }

  // =========================================================================

  async function jobs(view, route) {
    const titles = {
      all: ['Ordens de serviço', 'Tudo que foi importado do DOL, exceto o que você descartou.'],
      recommended: ['Recomendadas', 'Acima do limiar de prioridade, com as janelas de 2027 na frente.'],
      saved: ['Salvas', 'As ordens que você marcou para revisitar.'],
      manual_action: ['Ação manual', 'Vagas sem e-mail de candidatura. Elas exigem telefone ou site — o sistema não automatiza esses casos.'],
      discarded: ['Descartadas', 'O que você removeu.']
    };
    const [title, sub] = titles[view] || titles.all;

    const wrap = el(`<div>
      <div class="page-head">
        <div class="titles"><h1>${esc(title)}</h1><p class="sub">${esc(sub)}</p></div>
        <div class="page-actions"><button class="btn btn-primary" id="import">Importar do DOL</button></div>
      </div>
      <div class="toolbar">
        <select id="visa"><option value="all">H-2A e H-2B</option><option value="H-2A">Somente H-2A</option><option value="H-2B">Somente H-2B</option></select>
        <select id="method"><option value="all">Qualquer forma de candidatura</option><option value="EMAIL">Por e-mail</option><option value="PHONE">Por telefone</option><option value="WEBSITE">Por site</option><option value="UNKNOWN">Não informada</option></select>
        <label class="check" style="margin:0"><input type="checkbox" id="only2027"> Somente prioridade 2027</label>
        <span class="kpi-note" id="count"></span>
      </div>
      <div id="list"></div>
    </div>`);

    const list = wrap.querySelector('#list');

    const load = async () => {
      list.innerHTML = ''; list.appendChild(skeletonList());
      try {
        const { jobs } = await API.seasonal.listJobs({
          view,
          visaType: wrap.querySelector('#visa').value,
          applicationMethod: wrap.querySelector('#method').value,
          only2027: wrap.querySelector('#only2027').checked,
          limit: 100
        });
        list.innerHTML = '';
        wrap.querySelector('#count').textContent = `${jobs.length} ordem(ns)`;

        if (!jobs.length) {
          list.appendChild(emptyState({
            title: 'Nada por aqui ainda',
            message: view === 'manual_action'
              ? 'Nenhuma ordem exige ação manual no momento — ou nada foi importado ainda.'
              : 'Importe as ordens de serviço do DOL para o sistema analisar contra o seu perfil.',
            actionLabel: 'Importar do DOL',
            onAction: () => runImport(route)
          }));
          return;
        }
        const l = el('<div class="job-list"></div>');
        for (const j of jobs) l.appendChild(Views.jobCardFor('seasonal', 'US', j, route));
        list.appendChild(l);
      } catch (err) {
        list.innerHTML = ''; list.appendChild(errorCard(err, { onRetry: load }));
      }
    };

    ['visa', 'method', 'only2027'].forEach(id =>
      wrap.querySelector('#' + id).addEventListener('change', load));
    wrap.querySelector('#import').addEventListener('click', () => runImport(route));
    load();
    return wrap;
  }

  async function jobDetail(id, route) {
    const { job, package: pkg } = await API.seasonal.getJob(id);

    const node = Views.jobDetailShell({
      product: 'seasonal', country: 'US', route,
      title: job.job_title, company: job.employer_name,
      location: [job.employer_city, job.employer_state].filter(Boolean).join(', '),
      job,
      externalUrl: job.application_url,
      description: job.duties_description,
      requirementsText: job.special_requirements
    });

    // Bloco da linha do tempo (spec §65)
    if (job.timeline) {
      node.querySelector('#extra').appendChild(el(`<div class="card">
        <div class="card-head"><h2>Janela de contratação</h2>
          ${job.timeline.timelineClass === 'TARGET_2027' ? chip(job.timeline.label, 'chip-accent') : chip(job.timeline.label, 'chip-plain')}</div>
        <dl class="kv">
          <dt>Período de trabalho</dt><dd>${esc(job.timeline.periodLabel || 'Não disponível')}</dd>
          <dt>Prioridade</dt><dd>${esc(job.timeline.priority)}</dd>
        </dl>
        <p class="note" style="margin-top:10px">${esc(job.timeline.explanation)}</p>
      </div>`));
    }

    // Pacote de candidatura (spec §35)
    const side = node.querySelector('#side-extra');
    const pkgCard = el(`<div class="card" style="margin-top:14px"><div class="card-head"><h3>Candidatura</h3></div><div id="pkg"></div></div>`);
    side.appendChild(pkgCard);
    const pkgBody = pkgCard.querySelector('#pkg');

    if (job.application_method !== 'EMAIL' || !job.application_email) {
      pkgBody.innerHTML = `
        <p style="color:var(--ink-2);margin-bottom:10px">Esta ordem não informa e-mail de candidatura.</p>
        <dl class="kv">
          <dt>Forma</dt><dd>${esc(Views.methodLabel(job.application_method))}</dd>
          ${job.employer_phone ? `<dt>Telefone</dt><dd>${esc(job.employer_phone)}</dd>` : ''}
          ${job.application_url ? `<dt>Site</dt><dd><a href="${esc(job.application_url)}" target="_blank" rel="noopener noreferrer">abrir</a></dd>` : ''}
        </dl>
        <p class="note" style="margin-top:10px">O envio automático só acontece quando a própria vaga fornece um e-mail de candidatura. Aqui a ação é sua.</p>`;
    } else if (job.is_applied) {
      pkgBody.innerHTML = `<p>${chip('Candidatura já enviada', 'chip-ok')}</p>
        <p class="note" style="margin-top:10px">O sistema não envia uma segunda candidatura para o mesmo destinatário nesta vaga.</p>`;
    } else if (pkg) {
      pkgBody.innerHTML = `
        <dl class="kv">
          <dt>Destinatário</dt><dd class="mono" style="font-size:12px">${esc(pkg.recipient_email)}</dd>
          <dt>Validação</dt><dd>${pkg.validation_status === 'PASSED' ? chip('aprovada', 'chip-ok') : chip('reprovada', 'chip-crit')}</dd>
          <dt>Status</dt><dd>${job.queue_status ? chipFrom(STATUS_CHIP, job.queue_status) : '—'}</dd>
          ${pkg.selected_resume_reason ? `<dt>Currículo</dt><dd>${esc(pkg.selected_resume_reason)}</dd>` : ''}
        </dl>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-sm" id="preview">Ver e-mail</button>
          ${pkg.requires_review ? `<button class="btn btn-sm btn-primary" id="approve">Aprovar envio</button>` : ''}
        </div>`;

      const prev = pkgBody.querySelector('#preview');
      if (prev) prev.addEventListener('click', () => previewPackage(pkg, job));
      const appr = pkgBody.querySelector('#approve');
      if (appr) appr.addEventListener('click', async () => {
        try { await API.seasonal.approvePackage(pkg.id); toast('Candidatura aprovada', 'Ela entra na fila de envio.', 'ok'); route.reload(); }
        catch (e) { toast('Não foi possível aprovar', e.message, 'err'); }
      });
    } else {
      pkgBody.innerHTML = `<p style="color:var(--ink-2);margin-bottom:12px">Ainda não há pacote preparado para esta vaga.</p>
        <button class="btn btn-primary" id="prep">Preparar candidatura</button>
        <p class="note" style="margin-top:10px">O sistema seleciona um currículo existente, redige a carta com base apenas no seu Perfil Mestre e valida tudo antes de enfileirar.</p>`;
      pkgBody.querySelector('#prep').addEventListener('click', async (e) => {
        e.target.disabled = true; e.target.textContent = 'Preparando…';
        try {
          const out = await API.seasonal.preparePackage(id, {});
          if (out.validation.status !== 'PASSED') {
            toast('A candidatura não passou na validação', out.validation.blockingFailures.join(' · '), 'err');
          } else {
            toast('Pacote preparado', out.review.requiresReview ? 'Aguardando sua revisão antes do envio.' : 'Entrou na fila de envio.', 'ok');
          }
          route.reload();
        } catch (err) {
          toast('Não foi possível preparar', err.message, 'err');
          e.target.disabled = false; e.target.textContent = 'Preparar candidatura';
        }
      });
    }

    return node;
  }

  function previewPackage(pkg, job) {
    const body = el(`<div>
      <h2 style="margin-bottom:4px">Prévia da candidatura</h2>
      <p class="kpi-note" style="margin-bottom:16px">${esc(job.employer_name)} · ordem ${esc(job.job_order_id)}</p>
      <dl class="kv" style="margin-bottom:16px">
        <dt>Para</dt><dd class="mono" style="font-size:12px">${esc(pkg.recipient_email)}</dd>
        <dt>Assunto</dt><dd>${esc(pkg.email_subject)}</dd>
        <dt>Anexos</dt><dd>${(pkg.attachments || []).map(a => esc(a.filename)).join(', ') || '<span class="kpi-note">nenhum</span>'}</dd>
      </dl>
      <div class="note" style="white-space:pre-wrap;max-height:340px;overflow:auto">${esc(pkg.email_body)}</div>
      ${(pkg.reviewReasons || []).length ? `<div style="margin-top:14px">
        <h3 style="margin-bottom:6px">Por que precisa de revisão</h3>
        <ul style="margin:0;padding-left:18px;color:var(--ink-2);font-size:13px">
          ${pkg.reviewReasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
      ${pkg.validation && pkg.validation.checks ? `<details class="disclose" style="margin-top:14px">
        <summary>Checklist de validação</summary>
        <div class="body">${pkg.validation.checks.map(c => `
          <div style="display:flex;gap:8px;padding:5px 0;font-size:13px">
            <span style="color:${c.ok ? 'var(--ok)' : (c.blocking ? 'var(--crit)' : 'var(--warn)')};font-weight:700">${c.ok ? '✓' : '✕'}</span>
            <span>${esc(c.label)}${c.detail ? ` <span class="kpi-note">— ${esc(c.detail)}</span>` : ''}</span>
          </div>`).join('')}</div>
      </details>` : ''}
    </div>`);
    modal(body, { title: 'Prévia da candidatura' });
  }

  // =========================================================================

  async function queue(route) {
    const wrap = el(`<div>
      <div class="page-head">
        <div class="titles">
          <h1>Fila de candidaturas</h1>
          <p class="sub">Ordenada pela janela de contratação primeiro, depois por pontuação. Cada posição explica por que está ali.</p>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary" id="dispatch">Enviar agora</button>
          <button class="btn" id="ranked">Ver ordem de prioridade</button>
        </div>
      </div>
      <div id="quota"></div>
      <div class="toolbar">
        <select id="status">
          <option value="all">Todos os status</option>
          <option value="QUEUED">Na fila</option>
          <option value="AWAITING_REVIEW">Aguardando revisão</option>
          <option value="DEFERRED">Reagendadas</option>
          <option value="SENT">Enviadas</option>
          <option value="FAILED">Falhas</option>
        </select>
      </div>
      <div id="list"></div>
    </div>`);

    const load = async () => {
      const list = wrap.querySelector('#list');
      list.innerHTML = ''; list.appendChild(skeletonList(2));
      try {
        const { queue: items, quota } = await API.seasonal.queue({ status: wrap.querySelector('#status').value });

        wrap.querySelector('#quota').innerHTML = `<div class="note note-info" style="margin-bottom:14px">
          <strong>${esc(quota.countSent)} de ${esc(quota.maxLimit)}</strong> candidaturas enviadas hoje · ${esc(quota.remaining)} restantes ·
          virada às 00:00 no fuso ${esc(quota.timezone)}. O que exceder o limite permanece na fila.</div>`;

        list.innerHTML = '';
        if (!items.length) {
          list.appendChild(emptyState({
            title: 'A fila está vazia',
            message: 'Prepare uma candidatura a partir de uma ordem com e-mail, ou configure o modo assistido para que as melhores oportunidades entrem sozinhas.',
            actionLabel: 'Ver ordens recomendadas',
            onAction: () => route.go('#/seasonal/recommended')
          }));
          return;
        }

        const table = el(`<div class="table-wrap"><table>
          <thead><tr><th>Ordem</th><th>Empregador</th><th>Janela</th><th class="num">Prioridade</th><th>Status</th><th>Detalhe</th><th></th></tr></thead>
          <tbody>${items.map(i => `<tr>
            <td class="mono" style="font-size:11.5px">${esc(i.job_order_id)}<div class="kpi-note">${esc(i.job_title)}</div></td>
            <td>${esc(i.employer_name)}<div class="kpi-note">${esc(i.employer_state || '')}</div></td>
            <td>${i.timeline_class === 'TARGET_2027' ? chip(i.timeline_label || '2027', 'chip-accent') : esc(i.timeline_period || '—')}</td>
            <td class="num">${i.queue_priority ? Number(i.queue_priority).toFixed(1) : '—'}</td>
            <td>${chipFrom(STATUS_CHIP, i.status, i.status)}</td>
            <td style="max-width:240px">${esc(i.last_error || (i.reviewReasons && i.reviewReasons[0]) || '')}
              ${i.next_attempt_at ? `<div class="kpi-note">nova tentativa: ${esc(i.next_attempt_at)}</div>` : ''}</td>
            <td>${i.requires_review && i.status === 'AWAITING_REVIEW'
                  ? `<button class="btn btn-sm btn-primary" data-approve="${i.package_id}">Aprovar</button>` : ''}</td>
          </tr>`).join('')}</tbody>
        </table></div>`);
        list.appendChild(table);

        table.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', async () => {
          try { await API.seasonal.approvePackage(Number(b.dataset.approve)); toast('Aprovada', null, 'ok'); load(); }
          catch (e) { toast('Não foi possível aprovar', e.message, 'err'); }
        }));
      } catch (err) {
        list.innerHTML = ''; list.appendChild(errorCard(err, { onRetry: load }));
      }
    };

    wrap.querySelector('#status').addEventListener('change', load);

    wrap.querySelector('#dispatch').addEventListener('click', async (e) => {
      if (!await confirm('As candidaturas prontas serão enviadas por e-mail agora, respeitando o limite diário.',
                         { title: 'Enviar candidaturas', confirmLabel: 'Enviar' })) return;
      e.target.disabled = true; e.target.textContent = 'Enviando…';
      try {
        const r = await API.seasonal.dispatch({ max: 10 });
        toast(r.sent ? 'Envio concluído' : 'Nenhuma candidatura enviada', r.userMessage, r.sent ? 'ok' : '');
        load();
      } catch (err) {
        toast('O envio não foi concluído', err.message, 'err');
      } finally {
        e.target.disabled = false; e.target.textContent = 'Enviar agora';
      }
    });

    wrap.querySelector('#ranked').addEventListener('click', async () => {
      try {
        const { ranked } = await API.seasonal.ranked(30);
        const body = el(`<div>
          <h2 style="margin-bottom:4px">Ordem de prioridade</h2>
          <p class="kpi-note" style="margin-bottom:16px">A janela de contratação é o critério primário. Dentro da mesma faixa, a pontuação decide.</p>
          ${ranked.length ? ranked.map(r => `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;gap:10px;align-items:baseline">
              <span class="mono" style="color:var(--ink-muted)">#${esc(r.queuePosition)}</span>
              <strong style="flex:1">${esc(r.title)}</strong>
              <span class="mono">${esc(Number(r.queuePriority).toFixed(1))}</span>
            </div>
            <div class="kpi-note">${esc(r.queueExplanation)}</div>
          </div>`).join('') : '<p class="note">Nenhuma candidatura elegível por e-mail no momento.</p>'}
        </div>`);
        modal(body, { title: 'Ordem de prioridade' });
      } catch (e) { toast('Não foi possível carregar', e.message, 'err'); }
    });

    load();
    return wrap;
  }

  async function sent(route) {
    const { applications } = await API.seasonal.sent();
    const wrap = el(`<div>
      <div class="page-head"><div class="titles">
        <h1>Candidaturas enviadas</h1>
        <p class="sub">Registro permanente. É ele que impede um segundo envio para a mesma vaga e destinatário.</p>
      </div></div>
      <div id="list"></div>
    </div>`);

    const list = wrap.querySelector('#list');
    if (!applications.length) {
      list.appendChild(emptyState({
        title: 'Nenhuma candidatura enviada ainda',
        message: 'Quando uma candidatura for enviada com sucesso, ela aparece aqui com data, destinatário e conteúdo.',
        actionLabel: 'Ver a fila', onAction: () => route.go('#/seasonal/queue')
      }));
    } else {
      list.appendChild(el(`<div class="table-wrap"><table>
        <thead><tr><th>Enviada em</th><th>Ordem</th><th>Empregador</th><th>Destinatário</th><th>Status</th></tr></thead>
        <tbody>${applications.map(a => `<tr>
          <td>${esc(a.sent_at)}</td>
          <td class="mono" style="font-size:11.5px">${esc(a.job_order_id)}</td>
          <td>${esc(a.employer_name)}</td>
          <td class="mono" style="font-size:11.5px">${esc(a.recipient_email)}</td>
          <td>${chip(a.status, 'chip-ok')}</td>
        </tr>`).join('')}</tbody></table></div>`));
    }
    return wrap;
  }

  // =========================================================================

  async function settings(route) {
    const [{ config }, gmailStatus, googleCreds, sendersStatus] = await Promise.all([
      API.seasonal.getConfig(), API.seasonal.gmailStatus(), API.googleCredentials.status(),
      API.gmailSenders.list().catch(() => ({ senders: [], total: 0, active: 0, globalCap: 0, dailyCapacity: 0 }))
    ]);

    const wrap = el(`<div>
      <div class="page-head">
        <div class="titles"><h1>Configurações do Seasonal Jobs</h1>
          <p class="sub">Perfil sazonal, automação e integrações. Este produto opera somente nos Estados Unidos.</p></div>
        <div class="page-actions"><button class="btn btn-primary" id="save">Salvar</button></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Preferências da vaga</h2></div>
        <label class="check"><input type="checkbox" id="h2a_preference" ${config.h2a_preference ? 'checked' : ''}> Aceito vagas H-2A (agrícolas)</label>
        <label class="check"><input type="checkbox" id="h2b_preference" ${config.h2b_preference ? 'checked' : ''}> Aceito vagas H-2B (não agrícolas)</label>
        <div class="field-row">
          ${txt('preferred_states', 'Estados desejados', config.preferred_states, 'Siglas separadas por vírgula. Vazio = todos.')}
          ${txt('preferred_occupations', 'Ocupações desejadas', config.preferred_occupations, 'Separadas por vírgula.')}
          ${txt('excluded_occupations', 'Ocupações excluídas', config.excluded_occupations, 'Estas são descartadas antes de qualquer análise.')}
        </div>
        <div class="field-row">
          ${num('min_hourly_wage', 'Salário mínimo por hora (US$)', config.min_hourly_wage)}
          ${num('desired_weekly_hours', 'Horas semanais desejadas', config.desired_weekly_hours)}
          ${txt('english_level', 'Nível de inglês', config.english_level)}
        </div>
        <div class="field-row">
          ${date('available_from', 'Disponível a partir de', config.available_from)}
          ${date('available_to', 'Disponível até', config.available_to)}
        </div>
        <div class="field-row" style="margin-top:6px">
          <div><label class="check"><input type="checkbox" id="housing_required" ${config.housing_required ? 'checked' : ''}> Preciso de alojamento</label>
               <label class="check"><input type="checkbox" id="transportation_required" ${config.transportation_required ? 'checked' : ''}> Preciso de transporte</label>
               <label class="check"><input type="checkbox" id="physical_labor_ready" ${config.physical_labor_ready ? 'checked' : ''}> Disponível para trabalho físico</label></div>
          <div>${['pref_driving:Direção', 'pref_agriculture:Agricultura', 'pref_hospitality:Hotelaria', 'pref_construction:Construção', 'pref_maintenance:Manutenção']
            .map(p => { const [k, l] = p.split(':');
              return `<label class="check"><input type="checkbox" id="${k}" ${config[k] ? 'checked' : ''}> ${l}</label>`; }).join('')}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Automação</h2></div>
        <div class="field">
          <label for="automation_mode">Modo de operação</label>
          <select id="automation_mode">
            <option value="MANUAL" ${config.automation_mode === 'MANUAL' ? 'selected' : ''}>Manual — nada é preparado sem sua ação</option>
            <option value="ASSISTED" ${config.automation_mode === 'ASSISTED' ? 'selected' : ''}>Assistido — prepara as melhores e você revisa</option>
            <option value="AUTOMATIC" ${config.automation_mode === 'AUTOMATIC' ? 'selected' : ''}>Automático — prepara e enfileira dentro das regras</option>
          </select>
        </div>
        <div class="field">
          <label for="email_review_mode">Revisão antes do envio</label>
          <select id="email_review_mode">
            <option value="ALWAYS_REVIEW" ${config.email_review_mode === 'ALWAYS_REVIEW' ? 'selected' : ''}>Revisar sempre</option>
            <option value="REVIEW_FLAGGED" ${config.email_review_mode === 'REVIEW_FLAGGED' ? 'selected' : ''}>Revisar apenas o que for sinalizado</option>
            <option value="FULLY_AUTOMATIC" ${config.email_review_mode === 'FULLY_AUTOMATIC' ? 'selected' : ''}>Sem revisão</option>
          </select>
          <div class="hint">Em "apenas sinalizado", a revisão é exigida quando há requisito crítico em aberto, destinatário incomum, pontuação na fronteira do limiar ou período de trabalho indeterminado.</div>
        </div>
        <div class="field-row">
          ${num('auto_queue_fit_threshold', 'Fit mínimo para enfileirar', config.auto_queue_fit_threshold)}
          ${num('auto_queue_ats_threshold', 'ATS mínimo para enfileirar', config.auto_queue_ats_threshold)}
          ${num('auto_queue_opportunity_threshold', 'Opportunity mínimo', config.auto_queue_opportunity_threshold)}
        </div>
        <div class="field-row">
          ${num('target_hiring_year', 'Ano de contratação priorizado', config.target_hiring_year)}
          ${num('daily_email_limit', 'Limite diário de e-mails', config.daily_email_limit)}
        </div>
        <p class="note">O limite diário nunca ultrapassa 50, independentemente do que for configurado aqui. Valores menores são respeitados.</p>
      </div>

      <div class="card">
        <div class="card-head"><h2>Fonte de dados do DOL</h2>${chipFrom(HEALTH_CHIP, config.health_status)}</div>
        <div class="field">
          <label for="dol_feed_url">URL do feed</label>
          <input type="url" id="dol_feed_url" value="${esc(config.dol_feed_url || '')}" placeholder="https://…">
          <div class="hint">Sem URL, o sistema opera com ordens de exemplo — sempre rotuladas como tal.</div>
        </div>
        <dl class="kv" style="margin-bottom:12px">
          <dt>Último sucesso</dt><dd>${esc(config.last_success_at || '—')}</dd>
          <dt>Última falha</dt><dd>${esc(config.last_failure_at || '—')}</dd>
          ${config.last_error ? `<dt>Último erro</dt><dd>${esc(config.last_error)}</dd>` : ''}
        </dl>
        <button class="btn" id="test-dol">Testar conexão</button>
        <div id="dol-result" style="margin-top:12px"></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Conta de e-mail</h2>
          ${gmailStatus.connected ? chip('Conectado', 'chip-ok') : chip(gmailStatus.configured ? 'Não conectado' : 'Credenciais ausentes', 'chip-warn')}</div>
        <dl class="kv" style="margin-bottom:14px">
          <dt>Conta</dt><dd>${esc(gmailStatus.user || '—')}</dd>
          <dt>Autorização</dt><dd>${esc(gmailStatus.authStatus)}</dd>
        </dl>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" id="gmail-connect" ${gmailStatus.configured ? '' : 'disabled'}>
            ${gmailStatus.connected ? 'Reconectar com o Google' : 'Entrar com o Google'}</button>
          <button class="btn" id="gmail-test" ${gmailStatus.configured ? '' : 'disabled'}>Testar</button>
          ${gmailStatus.connected ? `<button class="btn btn-danger" id="gmail-disconnect">Desconectar</button>` : ''}
        </div>
        ${gmailStatus.configured ? '' : `
          <p class="note" style="margin-top:10px">
            O botão está desativado porque este servidor ainda não tem um cliente OAuth do Google.
            Ele é criado uma única vez, na sua conta do Google, e leva cerca de dois minutos.
          </p>`}
        ${googleCredentialsPanel(googleCreds)}
        <p class="note" style="margin-top:12px">A autorização usa OAuth 2.0. Sua senha do Gmail nunca é solicitada nem armazenada.</p>
        <div id="gmail-result" style="margin-top:12px"></div>
      </div>

      ${sendersPanel(sendersStatus, gmailStatus.configured)}
    </div>`);

    wrap.querySelector('#save').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const body = {};
        wrap.querySelectorAll('input[type="checkbox"]').forEach(i => { body[i.id] = i.checked; });
        wrap.querySelectorAll('input[type="text"], input[type="number"], input[type="date"], input[type="url"], select')
          .forEach(i => { body[i.id] = i.value; });
        await API.seasonal.saveConfig(body);
        toast('Configurações salvas', null, 'ok');
        route.reload();
      } catch (err) { toast('Não foi possível salvar', err.message, 'err'); }
      finally { e.target.disabled = false; }
    });

    wrap.querySelector('#test-dol').addEventListener('click', async (e) => {
      e.target.disabled = true;
      const out = wrap.querySelector('#dol-result');
      out.innerHTML = '<div class="progress-step active"><span class="spinner"></span><span>Testando…</span></div>';
      try {
        const r = await API.seasonal.testIntegration();
        out.innerHTML = diagnostic(r);
      } catch (err) { out.innerHTML = ''; out.appendChild(errorCard(err)); }
      finally { e.target.disabled = false; }
    });

    wireGoogleCredentials(wrap, route);
    wireSenders(wrap, route);

    const gc = wrap.querySelector('#gmail-connect');
    if (gc && !gc.disabled) gc.addEventListener('click', async () => {
      try {
        const { url } = await API.seasonal.gmailAuthUrl();
        window.open(url, '_blank', 'noopener');
        toast('Autorize na nova aba', 'Depois de concluir, volte aqui e clique em Testar.');
      } catch (e) { toast('Não foi possível iniciar', e.message, 'err'); }
    });

    const gt = wrap.querySelector('#gmail-test');
    if (gt) gt.addEventListener('click', async (e) => {
      e.target.disabled = true;
      const out = wrap.querySelector('#gmail-result');
      out.innerHTML = '<div class="progress-step active"><span class="spinner"></span><span>Testando…</span></div>';
      try { out.innerHTML = diagnostic(await API.seasonal.gmailTest()); }
      catch (err) { out.innerHTML = ''; out.appendChild(errorCard(err)); }
      finally { e.target.disabled = false; }
    });

    const gd = wrap.querySelector('#gmail-disconnect');
    if (gd) gd.addEventListener('click', async () => {
      if (!await confirm('A conta será desconectada e nenhuma candidatura poderá ser enviada até você reconectar.',
                         { title: 'Desconectar Gmail', confirmLabel: 'Desconectar', danger: true })) return;
      try { await API.seasonal.gmailDisconnect(); toast('Gmail desconectado', null, 'ok'); route.reload(); }
      catch (e) { toast('Não foi possível desconectar', e.message, 'err'); }
    });

    return wrap;

    function txt(id, label, v, hint) {
      return `<div class="field"><label for="${id}">${esc(label)}</label>
        <input type="text" id="${id}" value="${esc(v || '')}">${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
    }
    function num(id, label, v) {
      return `<div class="field"><label for="${id}">${esc(label)}</label>
        <input type="number" id="${id}" value="${v == null ? '' : esc(v)}"></div>`;
    }
    function date(id, label, v) {
      return `<div class="field"><label for="${id}">${esc(label)}</label>
        <input type="date" id="${id}" value="${esc(v || '')}"></div>`;
    }
  }

  /** Diagnóstico passo a passo (spec §40). */
  function diagnostic(r) {
    return `<div class="card" style="box-shadow:none">
      <div style="margin-bottom:10px">${chipFrom(HEALTH_CHIP, r.health, r.health)}</div>
      <p style="color:var(--ink-2);margin-bottom:12px">${esc(r.userMessage)}</p>
      ${(r.steps || []).map(s => `<div class="progress-step ${s.ok ? 'done' : ''}">
        <span style="color:${s.ok ? 'var(--ok)' : 'var(--crit)'};font-weight:700">${s.ok ? '✓' : '✕'}</span>
        <span>${esc(s.step)}${s.detail ? ` — <span class="kpi-note">${esc(s.detail)}</span>` : ''}</span>
      </div>`).join('')}
    </div>`;
  }

  return { dashboard, jobs, jobDetail, queue, sent, settings, runImport, diagnostic, STATUS_CHIP };
})();

window.SeasonalViews = SeasonalViews;
