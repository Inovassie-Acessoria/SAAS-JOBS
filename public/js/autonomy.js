/**
 * Telas dos robôs autônomos (spec de agentes §55, §56, §57, §27, §41, §49).
 *
 * Três telas, cada uma respondendo a uma pergunta:
 *
 *   Central de Robôs   o que está rodando, e o que falta para rodar sozinho
 *   Perfil de Motorista o que o sistema sabe e o que permanece UNKNOWN
 *   Ações Manuais      o que ficou pronto esperando VOCÊ enviar
 *
 * A tela de robôs abre com o resumo "enquanto você esteve fora" (§55) porque é
 * essa a primeira coisa que interessa a quem volta: o que aconteceu sem mim.
 */

const AutonomyViews = (function () {
  const { esc, el, kpi, chip, emptyState, errorCard, toast, confirm } = UI;

  const STATUS_CHIP = {
    OK: 'chip-ok', MISSING: 'chip-crit', DEGRADED: 'chip-warn', UNKNOWN: 'chip-plain',
    FAILED: 'chip-crit', SKIPPED: 'chip-plain', RUNNING: 'chip-info'
  };

  function statusChip(s) {
    const label = { OK: 'pronto', MISSING: 'falta', DEGRADED: 'parcial', UNKNOWN: 'indefinido' }[s] || s;
    return chip(label, STATUS_CHIP[s] || 'chip-plain');
  }

  function when(iso) {
    if (!iso) return '—';
    const t = Date.parse(String(iso).replace(' ', 'T') + (/[Zz]|[+-]\d{2}:\d{2}$/.test(iso) ? '' : 'Z'));
    if (!Number.isFinite(t)) return String(iso);
    const diff = Math.round((t - Date.now()) / 60000);
    const abs = Math.abs(diff);
    const unidade = abs < 60 ? `${abs} min` : abs < 1440 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`;
    return diff >= 0 ? `em ${unidade}` : `há ${unidade}`;
  }

  // -------------------------------------------------------------------------
  // Central de Robôs (§55, §49)
  // -------------------------------------------------------------------------

  async function control(route) {
    const wrap = el(`<div>
      <div class="page-head">
        <div class="titles">
          <h1>Central de Robôs</h1>
          <p class="sub">O que os robôs fizeram sem você, o que está agendado e o que ainda falta para a operação rodar sozinha.</p>
        </div>
        <div class="page-actions">
          <button class="btn" id="refresh">Atualizar</button>
        </div>
      </div>
      <div id="body"></div>
    </div>`);

    const body = wrap.querySelector('#body');
    wrap.querySelector('#refresh').addEventListener('click', () => route.reload());

    let report, ready;
    try {
      [report, ready] = await Promise.all([API.core.awayReport(24), API.core.readiness()]);
    } catch (err) {
      body.appendChild(errorCard(err, { onRetry: () => route.reload() }));
      return wrap;
    }

    // --- Manchete e interruptor geral ---------------------------------------
    const s = report.scheduler;
    const head = el(`<div class="card">
      <div class="card-head">
        <h2>${esc(report.headline)}</h2>
        ${chip(s.enabled ? 'robôs ligados' : 'robôs desligados', s.enabled ? 'chip-ok' : 'chip-warn')}
      </div>
      <p class="note" style="margin-bottom:14px">
        ${s.enabled
          ? 'A descoberta, a análise e o preparo acontecem no servidor, no horário agendado. Seu computador pode estar desligado.'
          : 'Enquanto estiverem desligados, nada acontece sozinho: descoberta e envio dependem de você abrir esta tela e pedir.'}
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn ${s.enabled ? 'btn-danger' : 'btn-primary'}" id="toggle">
          ${s.enabled ? 'Desligar automação' : 'Ligar automação'}
        </button>
      </div>
    </div>`);

    head.querySelector('#toggle').addEventListener('click', async (e) => {
      const ligando = !s.enabled;
      if (!ligando && !await confirm(
        'Os robôs param de trabalhar. Nada é apagado, e o que já está na fila permanece lá — mas nenhuma nova descoberta ou envio acontece até você religar.',
        { title: 'Desligar automação', confirmLabel: 'Desligar', danger: true })) return;

      e.target.disabled = true;
      try {
        await API.core.schedulerEnable(ligando);
        toast(ligando ? 'Automação ligada' : 'Automação desligada',
              ligando ? 'Os robôs passam a trabalhar sozinhos no servidor.' : null, 'ok');
        route.reload();
      } catch (err) { toast('Não foi possível alterar', err.message, 'err'); e.target.disabled = false; }
    });

    body.appendChild(head);

    // --- Enquanto você esteve fora (§55) ------------------------------------
    body.appendChild(el(`<div class="kpi-grid">
      ${kpi({ label: 'Vagas descobertas', value: report.gupy.found + report.indeed.found + report.seasonal.imported, note: 'últimas 24 h' })}
      ${kpi({ label: 'De motorista', value: report.seasonal.truckJobs, note: `${report.seasonal.truckConfirmed} confirmadas` })}
      ${kpi({ label: 'Alvo 2027', value: report.seasonal.target2027, note: 'dentro do universo de motorista', accent: true })}
      ${kpi({ label: 'Candidaturas enviadas', value: report.seasonal.emailsSent, note: `${report.quota.remaining} de ${report.quota.limit} restantes hoje` })}
    </div>`));

    // --- O que espera por você ----------------------------------------------
    if (report.actions.length) {
      const rota = {
        gupy: '#/gupy', indeed: '#/indeed', seasonal: '#/seasonal/queue', core: '#/robos'
      };
      const acoes = el(`<div class="card">
        <div class="card-head"><h2>Esperando por você</h2></div>
        ${report.actions.map((a, i) => `
          <div class="alert alert-${a.kind === 'FAILURE' ? 'HIGH' : 'MEDIUM'}">
            <div class="alert-body">
              <div class="alert-title">${esc(a.label)}</div>
              <div class="alert-detail">${esc(a.detail)}</div>
            </div>
            <button class="btn btn-sm" data-go="${i}">Abrir</button>
          </div>`).join('')}
      </div>`);

      acoes.querySelectorAll('[data-go]').forEach(b => {
        b.addEventListener('click', () => {
          const a = report.actions[Number(b.dataset.go)];
          route.go(a.kind === 'MANUAL' ? '#/seasonal/acoes-manuais' : (rota[a.product] || '#/'));
        });
      });
      body.appendChild(acoes);
    }

    // --- Prontidão: o que falta para rodar sozinho --------------------------
    const blocos = el(`<div class="card">
      <div class="card-head">
        <h2>Prontidão operacional</h2>
        ${chip(ready.ready ? 'pronto para operar sozinho' : `${ready.blockers.length} pendência(s)`,
               ready.ready ? 'chip-ok' : 'chip-crit')}
      </div>
      <p class="note" style="margin-bottom:14px">${esc(ready.summary)}</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Capacidade</th><th>Item</th><th>Estado</th><th>O que fazer</th></tr></thead>
        <tbody>${ready.items.map(i => `
          <tr>
            <td style="white-space:nowrap;font-size:12px;color:var(--ink-2)">${esc(i.capability)}</td>
            <td><b>${esc(i.title)}</b><div style="font-size:12px;color:var(--ink-2)">${esc(i.observed || '')}</div></td>
            <td>${statusChip(i.status)}</td>
            <td style="font-size:12.5px">${i.fix ? esc(i.fix) : '<span style="color:var(--ink-3)">—</span>'}
              ${i.env && i.status !== 'OK' ? `<div class="mono" style="font-size:11px;margin-top:4px">${esc(i.env)}</div>` : ''}</td>
          </tr>`).join('')}</tbody>
      </table></div>
    </div>`);
    body.appendChild(blocos);

    // --- Tarefas agendadas (§49) --------------------------------------------
    const tarefas = el(`<div class="card">
      <div class="card-head"><h2>Tarefas agendadas</h2></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Tarefa</th><th>Intervalo</th><th>Última execução</th><th>Próxima</th><th></th></tr></thead>
        <tbody>${s.tasks.map(t => `
          <tr>
            <td><b>${esc(t.label)}</b>
              <div style="font-size:12px;color:var(--ink-2)">${esc(t.lastMessage || '')}</div></td>
            <td>${t.enabled ? chip('ativa', 'chip-ok') : chip('inativa', 'chip-plain')}</td>
            <td style="font-size:12.5px">${esc(when(t.lastRunAt))}
              ${t.lastStatus ? ' ' + chip(t.lastStatus, STATUS_CHIP[t.lastStatus] || 'chip-plain') : ''}
              ${t.consecutiveFailures ? ` ${chip(`${t.consecutiveFailures} falha(s) seguidas`, 'chip-crit')}` : ''}</td>
            <td style="font-size:12.5px">${esc(when(t.nextRunAt))}</td>
            <td><button class="btn btn-sm" data-run="${esc(t.id)}">Rodar agora</button></td>
          </tr>`).join('')}</tbody>
      </table></div>
      <p class="note" style="margin-top:12px">
        "Rodar agora" executa a tarefa imediatamente, mesmo fora do horário. A pausa geral do sistema continua valendo — ela é trava de segurança, não preferência.
      </p>
    </div>`);

    tarefas.querySelectorAll('[data-run]').forEach(b => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        b.textContent = 'Rodando…';
        try {
          const r = await API.core.runTask(b.dataset.run);
          toast(r.label || 'Tarefa executada', r.message, r.status === 'FAILED' ? 'err' : 'ok');
          route.reload();
        } catch (err) {
          toast('A tarefa falhou', err.message, 'err');
          b.disabled = false; b.textContent = 'Rodar agora';
        }
      });
    });
    body.appendChild(tarefas);

    // --- Provedor de IA (§5, §59) -------------------------------------------
    let ai = null;
    try { ai = await API.core.ai(); } catch (e) { /* opcional */ }
    if (ai) {
      body.appendChild(el(`<div class="card">
        <div class="card-head">
          <h2>Camada de IA</h2>
          ${chip(ai.llmAvailable ? `${ai.provider} / ${ai.model}` : 'modo determinístico',
                 ai.llmAvailable ? 'chip-ok' : 'chip-plain')}
        </div>
        <p class="note">${esc(ai.requirement || 'O provedor está configurado e respondendo.')}</p>
        ${ai.apiKeyRef ? `<dl class="kv" style="margin-top:12px">
          <dt>Variável da chave</dt><dd class="mono">${esc(ai.apiKeyRef)}</dd>
          <dt>Chave presente no servidor</dt><dd>${ai.apiKeyPresent ? 'sim' : 'não'}</dd>
          <dt>Chamadas (30 dias)</dt><dd>${esc(ai.usage.calls)}</dd>
        </dl>` : ''}
      </div>`));
    }

    return wrap;
  }

  // -------------------------------------------------------------------------
  // Perfil de motorista (§27)
  // -------------------------------------------------------------------------

  const CAMPOS = [
    { id: 'truck_driving_experience', label: 'Anos dirigindo caminhão', tipo: 'num' },
    { id: 'tractor_trailer_experience', label: 'Anos com carreta / tractor-trailer', tipo: 'num' },
    { id: 'cdl_status', label: 'Situação da CDL', tipo: 'sel',
      ops: ['UNKNOWN', 'HELD', 'NOT_HELD', 'EXPIRED', 'IN_PROGRESS'],
      rotulos: { UNKNOWN: 'Não informado', HELD: 'Possuo', NOT_HELD: 'Não possuo', EXPIRED: 'Vencida', IN_PROGRESS: 'Em processo' } },
    { id: 'cdl_class', label: 'Classe da CDL', tipo: 'sel', ops: ['UNKNOWN', 'A', 'B', 'C'] },
    { id: 'cdl_endorsements', label: 'Endossos (ex.: H, N, T)', tipo: 'txt' },
    { id: 'can_obtain_cdl', label: 'Posso obter CDL após contratação', tipo: 'sel',
      ops: ['UNKNOWN', '1', '0'], rotulos: { UNKNOWN: 'Não informado', 1: 'Sim', 0: 'Não' } },
    { id: 'driving_record', label: 'Histórico de direção', tipo: 'sel',
      ops: ['UNKNOWN', 'CLEAN', 'MINOR_VIOLATIONS', 'MAJOR_VIOLATIONS'],
      rotulos: { UNKNOWN: 'Não informado', CLEAN: 'Limpo', MINOR_VIOLATIONS: 'Infrações leves', MAJOR_VIOLATIONS: 'Infrações graves' } },
    { id: 'manual_transmission_experience', label: 'Experiência com câmbio manual', tipo: 'sel',
      ops: ['UNKNOWN', 'YES', 'NO'], rotulos: { UNKNOWN: 'Não informado', YES: 'Sim', NO: 'Não' } },
    { id: 'english_level', label: 'Nível de inglês', tipo: 'sel',
      ops: ['UNKNOWN', 'NONE', 'BASIC', 'INTERMEDIATE', 'ADVANCED', 'NATIVE'],
      rotulos: { UNKNOWN: 'Não informado', NONE: 'Nenhum', BASIC: 'Básico', INTERMEDIATE: 'Intermediário', ADVANCED: 'Avançado', NATIVE: 'Nativo' } },
    { id: 'long_distance_experience', label: 'Experiência em longa distância', tipo: 'sel',
      ops: ['UNKNOWN', 'YES', 'NO'], rotulos: { UNKNOWN: 'Não informado', YES: 'Sim', NO: 'Não' } },
    { id: 'agricultural_hauling_experience', label: 'Transporte agrícola', tipo: 'sel',
      ops: ['UNKNOWN', 'YES', 'NO'], rotulos: { UNKNOWN: 'Não informado', YES: 'Sim', NO: 'Não' } },
    { id: 'equipment_experience', label: 'Equipamentos que já operou', tipo: 'txt' },
    { id: 'lifting_capacity', label: 'Capacidade de levantamento (lbs)', tipo: 'txt' },
    { id: 'availability_start', label: 'Disponível a partir de', tipo: 'data' },
    { id: 'availability_end', label: 'Disponível até', tipo: 'data' },
    { id: 'accepted_states', label: 'Estados aceitos (siglas separadas por vírgula)', tipo: 'txt' }
  ];

  async function driverProfile(route) {
    const { profile, blockers } = await API.seasonal.driverProfile();

    const campo = (c) => {
      const v = profile[c.id];
      const val = v === 'UNKNOWN' || v === null || v === undefined ? '' : v;

      if (c.tipo === 'sel') {
        const atual = v === 'UNKNOWN' || v === null ? 'UNKNOWN' : String(v);
        return `<div class="field"><label for="${c.id}">${esc(c.label)}</label>
          <select id="${c.id}">${c.ops.map(o =>
            `<option value="${esc(o)}" ${String(o) === atual ? 'selected' : ''}>${
              esc((c.rotulos && c.rotulos[o]) || o)}</option>`).join('')}</select></div>`;
      }
      const tipo = c.tipo === 'num' ? 'number' : c.tipo === 'data' ? 'date' : 'text';
      return `<div class="field"><label for="${c.id}">${esc(c.label)}</label>
        <input type="${tipo}" id="${c.id}" value="${esc(val)}" placeholder="deixe vazio se não souber"></div>`;
    };

    const wrap = el(`<div>
      <div class="page-head">
        <div class="titles">
          <h1>Perfil de motorista</h1>
          <p class="sub">Os fatos que sustentam cada carta e cada e-mail. É deste perfil — e só dele — que o Truth Guard tira a permissão para afirmar qualquer coisa a um empregador.</p>
        </div>
        <div class="page-actions"><button class="btn btn-primary" id="save">Salvar</button></div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>O que fica em aberto</h2>
          ${chip(`${profile.unknownFields.length} campo(s) sem resposta`,
                 blockers.some(b => b.severity === 'HIGH') ? 'chip-warn' : 'chip-plain')}
        </div>
        <p class="note" style="margin-bottom:12px">
          Campo vazio significa <b>não sei</b>, e o sistema trata assim: não afirma, não estima e não candidata por você em vaga que dependa daquele dado.
          Isso é proteção, não limitação — uma carta que afirma CDL que você não registrou é o tipo de erro que custa a vaga e a credibilidade.
        </p>
        ${blockers.length ? blockers.map(b => `
          <div class="alert alert-${b.severity === 'HIGH' ? 'HIGH' : 'MEDIUM'}">
            <div class="alert-body">
              <div class="alert-title">${esc(b.field)}</div>
              <div class="alert-detail">${esc(b.message)}</div>
            </div>
          </div>`).join('')
        : '<p class="note">Nenhum campo crítico em aberto. As candidaturas automáticas não ficam presas por falta de informação.</p>'}
      </div>

      <div class="card">
        <div class="card-head"><h2>Experiência e habilitação</h2></div>
        <div class="field-row">${CAMPOS.slice(0, 3).map(campo).join('')}</div>
        <div class="field-row">${CAMPOS.slice(3, 6).map(campo).join('')}</div>
        <div class="field-row">${CAMPOS.slice(6, 9).map(campo).join('')}</div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Experiência específica e disponibilidade</h2></div>
        <div class="field-row">${CAMPOS.slice(9, 12).map(campo).join('')}</div>
        <div class="field-row">${CAMPOS.slice(12, 16).map(campo).join('')}</div>
      </div>
    </div>`);

    wrap.querySelector('#save').addEventListener('click', async (e) => {
      e.target.disabled = true;
      const body = {};
      for (const c of CAMPOS) {
        const f = wrap.querySelector('#' + c.id);
        if (!f) continue;
        body[c.id] = f.value === '' ? 'UNKNOWN' : f.value;
      }
      try {
        await API.seasonal.saveDriverProfile(body);
        toast('Perfil de motorista salvo', 'Campos vazios continuam registrados como desconhecidos.', 'ok');
        route.reload();
      } catch (err) {
        toast('Não foi possível salvar', err.message, 'err');
        e.target.disabled = false;
      }
    });

    return wrap;
  }

  // -------------------------------------------------------------------------
  // Ações manuais (§41, §42, §57)
  // -------------------------------------------------------------------------

  async function manualActions(route) {
    const { actions } = await API.seasonal.manualActions();

    const wrap = el(`<div>
      <div class="page-head">
        <div class="titles">
          <h1>Ações manuais</h1>
          <p class="sub">Vagas sem e-mail de candidatura. O sistema preparou a mensagem em inglês; o envio é seu.</p>
        </div>
      </div>
      <div class="card">
        <p class="note">
          Um número de telefone listado para recrutamento <b>não</b> estabelece consentimento para WhatsApp.
          Por isso o sistema nunca envia essas mensagens sozinho, mesmo com a automação ligada.
        </p>
      </div>
      <div id="list"></div>
    </div>`);

    const list = wrap.querySelector('#list');

    if (!actions.length) {
      list.appendChild(emptyState({
        title: 'Nenhuma ação manual pendente',
        message: 'Quando uma vaga de motorista aparecer só com telefone, a mensagem é preparada aqui automaticamente.'
      }));
      return wrap;
    }

    for (const a of actions) {
      const card = el(`<div class="card">
        <div class="card-head">
          <h2>${esc(a.job_title || 'Vaga')} — ${esc(a.employer_name || '')}</h2>
          ${a.truck_classification ? chip(a.truck_classification.replace(/_/g, ' ').toLowerCase(),
            a.truck_classification === 'TRUCK_DRIVER_CONFIRMED' ? 'chip-ok' : 'chip-warn') : ''}
        </div>
        <dl class="kv">
          <dt>Ordem</dt><dd class="mono">${esc(a.job_order_id || '—')}</dd>
          <dt>Estado</dt><dd>${esc(a.employer_state || '—')}</dd>
          <dt>Telefone</dt><dd class="mono">${esc(a.channel_value || '—')}</dd>
        </dl>
        <div class="field">
          <label for="msg-${a.id}">Mensagem preparada (revise antes de enviar)</label>
          <textarea id="msg-${a.id}" rows="10" class="mono" style="font-size:12.5px">${esc(a.message || '')}</textarea>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${a.deep_link ? `<a class="btn btn-primary" href="${esc(a.deep_link)}" target="_blank" rel="noopener">Abrir WhatsApp</a>` : ''}
          <button class="btn" data-copy="${a.id}">Copiar mensagem</button>
          <button class="btn" data-done="${a.id}">Marcar como enviada</button>
          <button class="btn btn-ghost" data-skip="${a.id}">Descartar</button>
        </div>
      </div>`);

      card.querySelector(`[data-copy="${a.id}"]`).addEventListener('click', async () => {
        const texto = card.querySelector(`#msg-${a.id}`).value;
        try {
          await navigator.clipboard.writeText(texto);
          toast('Mensagem copiada', null, 'ok');
        } catch (e) {
          toast('Não foi possível copiar', 'Selecione o texto e copie manualmente.', 'warn');
        }
      });

      for (const [attr, status, rotulo] of [['data-done', 'DONE', 'enviada'], ['data-skip', 'DISMISSED', 'descartada']]) {
        card.querySelector(`[${attr}="${a.id}"]`).addEventListener('click', async () => {
          try {
            await API.seasonal.resolveManualAction(a.id, status);
            toast(`Ação marcada como ${rotulo}`, null, 'ok');
            route.reload();
          } catch (err) { toast('Não foi possível atualizar', err.message, 'err'); }
        });
      }

      list.appendChild(card);
    }

    return wrap;
  }

  return { control, driverProfile, manualActions };
})();

window.AutonomyViews = AutonomyViews;
