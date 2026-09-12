/**
 * Views da aplicação.
 *
 * Cada produto renderiza APENAS os próprios dados. Nenhuma view consulta a API
 * de outro produto — a única exceção é o portal inicial, que mostra a contagem
 * de cada produto lado a lado sem misturar as listas (spec §1.1).
 */

const Views = (() => {
  const { esc, el, kpi, attention, jobCard, emptyState, skeletonList, progress,
          toast, errorCard, scoreBreakdown, issueCard, chip, chipFrom,
          HEALTH_CHIP, ATS_STATUS, modal, confirm } = UI;

  const FIT_LABELS = {
    core_skills: 'Habilidades centrais',
    mandatory_requirement_coverage: 'Cobertura de requisitos obrigatórios',
    experience: 'Experiência',
    role_similarity: 'Similaridade de cargo',
    seniority: 'Senioridade',
    tools: 'Ferramentas',
    industry: 'Setor',
    languages: 'Idiomas',
    education: 'Formação',
    location_work_model: 'Local / modelo de trabalho'
  };

  const ATS_LABELS = {
    resume_parsing_quality: 'Leitura automática do arquivo',
    keyword_coverage: 'Cobertura dos termos da vaga',
    experience_alignment: 'Aderência da experiência',
    skills_alignment: 'Aderência das habilidades',
    section_structure: 'Estrutura de seções',
    country_convention: 'Convenção do país',
    platform_readability: 'Leitura pela plataforma',
    content_completeness: 'Completude do conteúdo'
  };

  const OPP_LABELS = {
    fit: 'Fit Score', ats: 'ATS Compatibility',
    mandatory_coverage: 'Requisitos obrigatórios',
    salary_compatibility: 'Compatibilidade salarial',
    freshness: 'Frescor da publicação', location: 'Localização',
    preferences: 'Preferências do candidato', timing: 'Janela de contratação'
  };

  const COUNTRY_NAME = { BR: 'Brasil', US: 'Estados Unidos' };

  // =========================================================================
  // PORTAL
  // =========================================================================

  async function portal(route) {
    const wrap = el(`<div class="portal">
      <div class="portal-head">
        <h1>Job Intelligence</h1>
        <p>Três sistemas independentes de descoberta e análise de vagas. Escolha por onde começar — cada ambiente tem seu próprio perfil de busca, histórico e integrações.</p>
      </div>
      <div class="product-grid" id="pg"></div>
      <div id="portal-robots" style="margin-top:22px"></div>
      <div style="margin-top:26px" id="portal-foot"></div>
    </div>`);

    const grid = wrap.querySelector('#pg');

    // Faixa dos robôs (spec de agentes §55). Fica acima dos avisos de perfil
    // porque, para quem volta depois de um tempo, é a informação mais nova.
    const robots = wrap.querySelector('#portal-robots');
    Promise.allSettled([API.core.scheduler(), API.core.awayReport(24)]).then(([s, r]) => {
      if (s.status !== 'fulfilled') return;
      const sched = s.value;
      const rep = r.status === 'fulfilled' ? r.value : null;
      const pendentes = rep ? rep.actions.reduce((a, x) => a + (x.count || 0), 0) : 0;

      const faixa = el(`<div class="card">
        <div class="card-head">
          <h2>Central de Robôs</h2>
          ${chip(sched.enabled ? 'trabalhando' : 'desligados', sched.enabled ? 'chip-ok' : 'chip-warn')}
        </div>
        <p class="note" style="margin-bottom:12px">${esc(
          rep ? rep.headline
              : 'Descoberta, análise e preparo podem acontecer no servidor, com seu computador desligado.')}</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <button class="btn btn-primary" id="abrir-robos">
            ${sched.enabled ? 'Ver o que os robôs fizeram' : 'Ligar os robôs'}
          </button>
          ${pendentes ? `<span class="kpi-note">${pendentes} item(ns) esperando por você</span>` : ''}
        </div>
      </div>`);

      faixa.querySelector('#abrir-robos').addEventListener('click', () => route.go('#/robos'));
      robots.appendChild(faixa);
    });
    const products = [
      { id: 'gupy', name: 'Gupy', desc: 'Vagas de empresas que usam a Gupy, com áreas separadas para Brasil e Estados Unidos. Candidatura sempre manual, feita por você no site oficial.' },
      { id: 'indeed', name: 'Indeed', desc: 'Busca no Indeed com áreas separadas para Brasil e Estados Unidos. Candidatura manual, no site do anunciante.' },
      { id: 'seasonal', name: 'Seasonal Jobs', desc: 'Ordens de serviço H-2A e H-2B do Departamento do Trabalho dos EUA, com priorização para 2027 e candidatura por e-mail automatizada dentro de limites que você define.' }
    ];

    for (const p of products) {
      const card = el(`<button class="product-card">
        <h2>${esc(p.name)}</h2>
        <div class="desc">${esc(p.desc)}</div>
        <div class="product-stats" data-stats><span class="kpi-note">Carregando…</span></div>
      </button>`);
      card.addEventListener('click', () => route.go(p.id === 'seasonal' ? '#/seasonal/dashboard' : `#/${p.id}`));
      grid.appendChild(card);
    }

    // Estatísticas por produto, buscadas em paralelo e sem cruzar dados.
    Promise.allSettled([
      Promise.all([API.gupy.dashboard('BR'), API.gupy.dashboard('US')]),
      Promise.all([API.indeed.dashboard('BR'), API.indeed.dashboard('US')]),
      API.seasonal.dashboard()
    ]).then(([g, i, s]) => {
      const slots = grid.querySelectorAll('[data-stats]');

      const boardStats = (r) => {
        if (r.status !== 'fulfilled') return '<span class="kpi-note">Indisponível</span>';
        const [br, us] = r.value;
        return statPair([
          ['Brasil', br.kpis.total], ['EUA', us.kpis.total],
          ['Match forte', br.kpis.strongMatches + us.kpis.strongMatches]
        ]);
      };

      slots[0].innerHTML = boardStats(g);
      slots[1].innerHTML = boardStats(i);
      slots[2].innerHTML = s.status === 'fulfilled'
        ? statPair([
            ['Prioridade 2027', s.value.kpis.target2027],
            ['Na fila', s.value.kpis.queued],
            ['Hoje', `${s.value.kpis.sentToday}/${s.value.kpis.dailyLimit}`]
          ])
        : '<span class="kpi-note">Indisponível</span>';
    });

    // Cada ambiente tem o próprio perfil (§1A): os cinco são checados separadamente.
    const ENVS = [['gupy', 'br'], ['gupy', 'us'], ['indeed', 'br'], ['indeed', 'us'], ['seasonal', 'us']];
    Promise.allSettled(ENVS.map(([p, c]) => API.env(p, c).profile()))
      .then(results => {
        const vazios = results
          .map((r, i) => (r.status === 'fulfilled' && r.value.profile.isEmpty) ? ENVS[i] : null)
          .filter(Boolean);
        if (!vazios.length) return;

        const [p0, c0] = vazios[0];
        wrap.querySelector('#portal-foot').appendChild(emptyState({
          title: vazios.length === ENVS.length
            ? 'Comece preenchendo um perfil'
            : `${vazios.length} ambiente(s) ainda sem perfil`,
          message: 'Cada plataforma e país tem perfil e currículos próprios — nada é reaproveitado entre eles. Escolha um produto e preencha o perfil daquele ambiente.',
          actionLabel: `Preencher ${p0}${p0 === 'seasonal' ? '' : ' ' + c0.toUpperCase()}`,
          onAction: () => route.go(p0 === 'seasonal' ? '#/seasonal/profile' : `#/${p0}/${c0}/profile`)
        }));
      }).catch(() => {});

    // Documentos herdados da biblioteca compartilhada da v2 (spec §1J).
    API.core.unassignedDocuments().then(({ documents, note }) => {
      if (!documents.length) return;
      const card = el('<div class="card" style="margin-top:14px"></div>');
      card.innerHTML = `<div class="card-head"><h3>${documents.length} documento(s) da versão anterior</h3></div>
        <p style="color:var(--ink-2);margin-bottom:12px">${esc(note)}</p>
        <button class="btn btn-primary" data-assign>Atribuir documentos</button>`;
      card.querySelector('[data-assign]').addEventListener('click', () => unassignedModal(route));
      wrap.querySelector('#portal-foot').appendChild(card);
    }).catch(() => {});

    return wrap;

    function statPair(pairs) {
      return pairs.map(([l, v]) =>
        `<div class="product-stat"><div class="v">${esc(v ?? '—')}</div><div class="l">${esc(l)}</div></div>`
      ).join('');
    }
  }

  function countryChoice(product, route) {
    const name = product === 'gupy' ? 'Gupy' : 'Indeed';
    const wrap = el(`<div class="portal">
      <div class="portal-head">
        <h1>${esc(name)}</h1>
        <p>Escolha o mercado. Brasil e Estados Unidos são áreas separadas: cada uma tem configuração de busca, currículo, regras de ATS e histórico próprios.</p>
      </div>
      <div class="country-choice" id="cc"></div>
    </div>`);

    const cc = wrap.querySelector('#cc');
    const opts = [
      { c: 'BR', flag: '🇧🇷', title: `${name} Brasil`, desc: 'Vagas em português, salário mensal em reais, regras de ATS brasileiras.' },
      { c: 'US', flag: '🇺🇸', title: `${name} USA`, desc: 'Vagas em inglês, salário anual em dólar, convenções de currículo americanas.' }
    ];

    for (const o of opts) {
      const card = el(`<button class="country-card">
        <span class="flag" aria-hidden="true">${o.flag}</span>
        <span><h3>${esc(o.title)}</h3><p>${esc(o.desc)}</p></span>
      </button>`);
      card.addEventListener('click', () => route.go(`#/${product}/${o.c.toLowerCase()}/dashboard`));
      cc.appendChild(card);
    }
    return wrap;
  }

  // =========================================================================
  // BOARD (Gupy / Indeed)
  // =========================================================================

  async function boardDashboard(product, country, route) {
    const api = API[product];
    const label = product === 'gupy' ? 'Gupy' : 'Indeed';
    const d = await api.dashboard(country);

    const wrap = el(`<div>
      <div class="page-head">
        <div class="titles">
          <h1>${esc(label)} ${esc(COUNTRY_NAME[country])}</h1>
          <p class="sub">Visão geral deste mercado. Nenhum dado de outro produto ou país aparece aqui.</p>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary" id="search">Buscar vagas</button>
          <button class="btn" id="cfg">Configurações</button>
        </div>
      </div>
      <div id="attn"></div>
      <div class="grid grid-kpi" id="kpis"></div>
      <div style="margin-top:18px"><h2 style="margin-bottom:12px">Melhores oportunidades agora</h2><div id="recent"></div></div>
      <div style="margin-top:22px" id="activity"></div>
    </div>`);

    const attnNode = attention(d.attention, (a) => {
      if (a.action === 'configure' || a.action === 'reconnect') route.go(`#/${product}/${country.toLowerCase()}/settings`);
      else if (a.action === 'profile') route.go(`#/${product}/${country.toLowerCase()}/profile`);
      else if (a.action === 'ats') route.go(`#/${product}/${country.toLowerCase()}/ats`);
    });
    if (attnNode) wrap.querySelector('#attn').appendChild(attnNode);

    wrap.querySelector('#kpis').innerHTML = [
      kpi({ label: 'Vagas novas (7 dias)', value: d.kpis.newJobs }),
      kpi({ label: 'Match forte', value: d.kpis.strongMatches, accent: true }),
      kpi({ label: 'Prioridade máxima', value: d.kpis.topPriority }),
      kpi({ label: 'Salvas', value: d.kpis.saved }),
      kpi({ label: 'Fit médio', value: d.kpis.avgFit, suffix: d.kpis.avgFit ? '/100' : '' }),
      kpi({
        label: 'ATS do currículo', value: d.ats.score, suffix: d.ats.score ? '/100' : '',
        note: d.ats.resume ? d.ats.resume.name : 'Nenhum currículo analisado'
      })
    ].join('');

    const recent = wrap.querySelector('#recent');
    if (!d.recent.length) {
      recent.appendChild(emptyState({
        title: 'Nenhuma vaga recomendada ainda',
        message: `Rode a primeira busca para o ${label} ${COUNTRY_NAME[country]}. O sistema vai filtrar, analisar e ranquear as oportunidades contra o seu perfil.`,
        actionLabel: 'Buscar vagas',
        onAction: () => runSearch(product, country, route)
      }));
    } else {
      const list = el('<div class="job-list"></div>');
      for (const j of d.recent) list.appendChild(jobCardFor(product, country, j, route));
      recent.appendChild(list);
    }

    // Atividade recente — detalhe secundário, recolhido (spec §2.2, §43)
    if (d.searches.length) {
      wrap.querySelector('#activity').appendChild(el(`
        <details class="disclose">
          <summary>Buscas recentes (${d.searches.length})</summary>
          <div class="body"><div class="table-wrap"><table>
            <thead><tr><th>Quando</th><th class="num">Recebidas</th><th class="num">Novas</th><th class="num">Filtradas</th><th class="num">Analisadas</th><th class="num">Recomendadas</th><th class="num">Duração</th></tr></thead>
            <tbody>${d.searches.map(s => `<tr>
              <td>${esc(s.executed_at)}</td>
              <td class="num">${esc(s.results_found)}</td>
              <td class="num">${esc(s.new_results)}</td>
              <td class="num">${esc(s.filtered_out)}</td>
              <td class="num">${esc(s.analyzed)}</td>
              <td class="num">${esc(s.recommended)}</td>
              <td class="num">${s.duration_ms ? Math.round(s.duration_ms) + 'ms' : '—'}</td>
            </tr>`).join('')}</tbody>
          </table></div></div>
        </details>`));
    }

    wrap.querySelector('#search').addEventListener('click', () => runSearch(product, country, route));
    wrap.querySelector('#cfg').addEventListener('click', () => route.go(`#/${product}/${country.toLowerCase()}/settings`));
    return wrap;
  }

  async function runSearch(product, country, route) {
    const api = API[product];
    const steps = [
      { label: 'Consultando a integração', state: 'active' },
      { label: 'Normalizando e removendo duplicatas', state: '' },
      { label: 'Aplicando filtros', state: '' },
      { label: 'Analisando e pontuando', state: '' }
    ];
    const node = progress(steps);
    const view = document.getElementById('view');
    view.prepend(node);

    try {
      const { metrics } = await api.search(country, {});
      node.remove();

      const parts = [`${metrics.received} recebida(s)`, `${metrics.newJobs} nova(s)`];
      if (metrics.filteredOut + metrics.prefiltered) parts.push(`${metrics.filteredOut + metrics.prefiltered} filtrada(s)`);
      if (metrics.cached) parts.push(`${metrics.cached} sem mudança`);
      parts.push(`${metrics.analyzed} analisada(s)`);

      toast('Busca concluída', parts.join(' · '), 'ok');
      if (metrics.fixtureMode) {
        toast('Dados de exemplo', 'A integração não está configurada, então estas vagas são fixtures locais. Configure o MCP em Integração para buscar vagas reais.');
      }
      route.reload();
    } catch (err) {
      node.remove();
      view.prepend(errorCard(err, { onRetry: () => runSearch(product, country, route) }));
      toast('A busca não foi concluída', err.message, 'err');
    }
  }

  function jobCardFor(product, country, job, route) {
    return jobCard(job, {
      product,
      onOpen: () => route.go(product === 'seasonal'
        ? `#/seasonal/job/${job.id}`
        : `#/${product}/${country.toLowerCase()}/job/${job.id}`),
      onSave: async () => {
        try {
          if (product === 'seasonal') await API.seasonal.saveJob(job.id);
          else await API[product].saveJob(country, job.id);
          toast('Vaga salva', null, 'ok');
          route.reload();
        } catch (e) { toast('Não foi possível salvar', e.message, 'err'); }
      },
      onDiscard: async () => {
        try {
          if (product === 'seasonal') await API.seasonal.discardJob(job.id, 'Removida da lista de salvas');
          else await API[product].discardJob(country, job.id, 'Removida da lista de salvas');
          route.reload();
        } catch (e) { toast('Não foi possível atualizar', e.message, 'err'); }
      }
    });
  }

  async function boardJobs(product, country, view, route) {
    const api = API[product];
    const titles = {
      all: ['Todas as vagas', 'Tudo que foi coletado neste mercado, exceto o que você descartou.'],
      recommended: ['Recomendadas', 'Oportunidades acima do limiar configurado, ordenadas por prioridade.'],
      saved: ['Salvas', 'As vagas que você marcou para revisitar.'],
      discarded: ['Descartadas', 'O que você removeu. Nada é apagado — dá para reconsiderar.']
    };
    const [title, sub] = titles[view] || titles.all;

    const wrap = el(`<div>
      <div class="page-head">
        <div class="titles"><h1>${esc(title)}</h1><p class="sub">${esc(sub)}</p></div>
        <div class="page-actions"><button class="btn btn-primary" id="search">Buscar vagas</button></div>
      </div>
      <div class="toolbar">
        <label class="sr-only" for="minfit">Fit mínimo</label>
        <select id="minfit">
          <option value="">Qualquer Fit</option>
          <option value="70">Fit ≥ 70</option>
          <option value="80">Fit ≥ 80</option>
          <option value="90">Fit ≥ 90</option>
        </select>
        <span class="kpi-note" id="count"></span>
      </div>
      <div id="list"></div>
    </div>`);

    const list = wrap.querySelector('#list');
    list.appendChild(skeletonList());

    const load = async () => {
      list.innerHTML = '';
      list.appendChild(skeletonList());
      try {
        const minFit = wrap.querySelector('#minfit').value;
        const { jobs } = await api.listJobs(country, { view, minFit, limit: 100 });
        list.innerHTML = '';
        wrap.querySelector('#count').textContent = `${jobs.length} vaga(s)`;

        if (!jobs.length) {
          list.appendChild(emptyState({
            title: view === 'saved' ? 'Você ainda não salvou nenhuma vaga'
                 : view === 'discarded' ? 'Nenhuma vaga descartada'
                 : 'Nenhuma vaga por aqui ainda',
            message: view === 'saved'
              ? 'Ao encontrar algo que valha a pena, use Salvar no cartão da vaga para reunir tudo aqui.'
              : `Rode uma busca para o ${product === 'gupy' ? 'Gupy' : 'Indeed'} ${COUNTRY_NAME[country]} e o sistema vai analisar as oportunidades contra o seu perfil.`,
            actionLabel: view === 'saved' || view === 'discarded' ? null : 'Buscar vagas',
            onAction: () => runSearch(product, country, route)
          }));
          return;
        }

        const l = el('<div class="job-list"></div>');
        for (const j of jobs) l.appendChild(jobCardFor(product, country, j, route));
        list.appendChild(l);
      } catch (err) {
        list.innerHTML = '';
        list.appendChild(errorCard(err, { onRetry: load }));
      }
    };

    wrap.querySelector('#minfit').addEventListener('change', load);
    wrap.querySelector('#search').addEventListener('click', () => runSearch(product, country, route));
    load();
    return wrap;
  }

  // ------------------------------------------------------------- detalhe

  async function boardJobDetail(product, country, id, route) {
    const { job } = await API[product].getJob(country, id);
    return jobDetailShell({
      product, country, route,
      title: job.title, company: job.company,
      location: job.location || [job.location_city, job.location_state].filter(Boolean).join(', '),
      job,
      externalUrl: job.apply_url || job.job_url,
      description: job.description,
      requirementsText: job.requirements
    });
  }

  function jobDetailShell(ctx) {
    const { job, route, product, country } = ctx;
    const sal = UI.salary(job);
    const concerns = job.concerns || [];

    const wrap = el(`<div>
      <div class="page-head">
        <div class="titles">
          <h1>${esc(ctx.title)}</h1>
          <p class="sub">${esc(ctx.company)}${ctx.location ? ' · ' + esc(ctx.location) : ''}</p>
        </div>
        <div class="page-actions">
          ${ctx.externalUrl ? `<a class="btn btn-primary" href="${esc(ctx.externalUrl)}" target="_blank" rel="noopener noreferrer">Abrir vaga original</a>` : ''}
          <button class="btn" id="save">${job.is_saved ? 'Salva ✓' : 'Salvar'}</button>
          <button class="btn btn-ghost" id="back">Voltar</button>
        </div>
      </div>

      <div class="detail-grid">
        <div>
          <div class="card">
            <div class="card-head"><h2>Visão geral</h2></div>
            <dl class="kv">
              ${sal ? `<dt>Salário</dt><dd><strong>${esc(sal.text)}</strong> <span class="kpi-note">(${esc(sal.source)})</span></dd>` : '<dt>Salário</dt><dd class="kpi-note">Não informado pela vaga</dd>'}
              ${job.published_date ? `<dt>Publicada</dt><dd>${esc(job.published_date)}</dd>` : ''}
              ${job.timeline_period ? `<dt>Período de trabalho</dt><dd>${esc(job.timeline_period)}</dd>` : ''}
              ${job.visa_type ? `<dt>Visto</dt><dd>${esc(job.visa_type)}</dd>` : ''}
              ${job.application_method ? `<dt>Como se candidatar</dt><dd>${esc(methodLabel(job.application_method))}</dd>` : ''}
              ${job.job_order_id ? `<dt>Ordem de serviço</dt><dd class="mono">${esc(job.job_order_id)}</dd>` : ''}
            </dl>
          </div>

          <div class="card" id="concerns-card" hidden>
            <div class="card-head"><h2>Pontos de atenção</h2></div>
            <div id="concerns"></div>
          </div>

          <div class="card">
            <div class="card-head"><h2>Requisitos avaliados</h2></div>
            <div id="reqs"></div>
          </div>

          ${ctx.description ? `<details class="disclose" style="margin-top:14px">
            <summary>Descrição completa da vaga</summary>
            <div class="body"><p style="white-space:pre-wrap;color:var(--ink-2)">${esc(ctx.description)}</p></div>
          </details>` : ''}
          ${ctx.requirementsText ? `<details class="disclose">
            <summary>Requisitos como publicados</summary>
            <div class="body"><p style="white-space:pre-wrap;color:var(--ink-2)">${esc(ctx.requirementsText)}</p></div>
          </details>` : ''}
          <div id="extra"></div>
        </div>

        <aside>
          <div class="card">
            <div class="card-head"><h3>Pontuações</h3></div>
            <div class="grid" style="grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px">
              ${miniScore('Fit', job.fit_score)}
              ${miniScore('ATS', job.ats_score)}
              ${miniScore('Oport.', job.opportunity_score)}
            </div>
            ${job.category ? `<div style="margin-bottom:12px">${chipFrom(UI.CATEGORY_CHIP, job.category)}</div>` : ''}
            <p class="note">Fit mede aderência do seu perfil à vaga. ATS mede a leitura automática do currículo. Opportunity é uma heurística de priorização de esforço — não é probabilidade de contratação.</p>
          </div>

          <details class="disclose" style="margin-top:14px" open>
            <summary>Como o Fit foi calculado</summary>
            <div class="body">${scoreBreakdown(job.fitComponents, job.fitWeights, FIT_LABELS)}</div>
          </details>

          ${job.opportunityComponents ? `<details class="disclose">
            <summary>Como a prioridade foi calculada</summary>
            <div class="body">${scoreBreakdown(job.opportunityComponents, null, OPP_LABELS)}</div>
          </details>` : ''}

          <div class="card" style="margin-top:14px">
            <div class="card-head"><h3>Comparar currículo</h3></div>
            <p style="color:var(--ink-2);font-size:13px;margin-bottom:10px">
              Veja como o currículo selecionado se sai contra os termos desta vaga
              e o que dá para ajustar sem afirmar nada que não esteja no seu perfil.
            </p>
            <button class="btn" id="compare">Comparar com esta vaga</button>
          </div>

          <div id="side-extra"></div>
        </aside>
      </div>
    </div>`);

    // Preocupações — só aparecem quando são materialmente relevantes (spec §24)
    if (concerns.length) {
      wrap.querySelector('#concerns-card').hidden = false;
      wrap.querySelector('#concerns').innerHTML = concerns.map(c => `
        <div class="issue sev-${esc(c.severity)}">
          <h4>${esc(c.title)}</h4>
          <p>${esc(c.detail || '')}</p>
          ${c.evidence ? `<div class="ev">${esc(Array.isArray(c.evidence) ? c.evidence.join(' · ') : c.evidence)}</div>` : ''}
        </div>`).join('');
    }

    // Requisitos classificados (spec §15, §23)
    const reqs = job.requirements || [];
    const reqsEl = wrap.querySelector('#reqs');
    if (!Array.isArray(reqs) || !reqs.length) {
      reqsEl.innerHTML = '<p class="note">A vaga não trouxe requisitos em formato reconhecível. Leia a descrição completa acima.</p>';
    } else {
      const group = (kind, label) => {
        const items = reqs.filter(r => r.kind === kind);
        if (!items.length) return '';
        return `<h4 style="font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-muted);margin:14px 0 7px">${esc(label)}</h4>
          ${items.map(r => `<div style="display:flex;gap:9px;align-items:flex-start;padding:6px 0;border-bottom:1px solid var(--border)">
            <span style="flex:0 0 auto;margin-top:2px">${statusIcon(r.status)}</span>
            <div style="min-width:0">
              <div style="font-size:13.5px">${esc(r.requirement)}</div>
              <div class="kpi-note">${esc(r.explanation || '')}${r.confidence && r.status === 'SEMANTIC_MET' ? ` · confiança ${esc(r.confidence)}` : ''}</div>
            </div>
          </div>`).join('')}`;
      };
      reqsEl.innerHTML = [
        group('MANDATORY', 'Obrigatórios'),
        group('CONTEXTUAL', 'Contextuais'),
        group('PREFERRED', 'Preferenciais'),
        group('AMBIGUOUS', 'Ambíguos')
      ].filter(Boolean).join('') || '<p class="note">Nenhum requisito classificado.</p>';
    }

    // ATS Compare (spec §67) — currículo × vaga, com sugestões ancoradas no perfil.
    wrap.querySelector('#compare').addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'Comparando…';
      try {
        const scope = product === 'seasonal' ? 'US' : ctx.country;
        const api = API.env(product, scope);
        const { resumes, environment } = await api.resumes({ docType: 'resume' });
        if (!resumes.length) {
          toast('Nenhum currículo neste ambiente',
                `Adicione um currículo em ${environment}. Currículos de outras plataformas não são usados aqui.`, 'err');
          return;
        }
        const chosen = resumes.find(r => r.is_default) || resumes[0];
        const out = await api.atsCompare({ resumeId: chosen.id, jobId: job.id });
        UI.modal(compareResult(out), { title: 'Comparação de currículo' });
      } catch (err) {
        toast('Não foi possível comparar', err.message, 'err');
      } finally {
        e.target.disabled = false; e.target.textContent = 'Comparar com esta vaga';
      }
    });

    wrap.querySelector('#back').addEventListener('click', () => history.back());
    wrap.querySelector('#save').addEventListener('click', async () => {
      try {
        if (product === 'seasonal') await API.seasonal.saveJob(job.id);
        else await API[product].saveJob(country, job.id);
        toast('Vaga salva', null, 'ok');
        route.reload();
      } catch (e) { toast('Não foi possível salvar', e.message, 'err'); }
    });

    return wrap;

    function miniScore(label, v) {
      return `<div style="text-align:center;padding:8px;background:var(--surface-2);border-radius:var(--radius-sm)">
        <div class="score-label">${esc(label)}</div>
        <div style="font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;${v == null ? 'color:var(--ink-muted)' : ''}">${v == null ? '—' : esc(v)}</div>
      </div>`;
    }
  }

  /** Resultado do ATS Compare (spec §67). */
  function compareResult(out) {
    const a = out.analysis;
    const sug = out.suggestions || [];
    const gaps = sug.filter(s => s.type === 'GAP');
    const rewrites = sug.filter(s => s.type === 'REWRITE');
    const structure = sug.filter(s => s.type === 'STRUCTURE');

    return el(`<div>
      <h2 style="margin-bottom:4px">${esc(out.resume.name)}</h2>
      <p class="kpi-note" style="margin-bottom:16px">contra ${esc(out.job.title)} — ${esc(out.job.company)}</p>

      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:16px">
        ${kpi({ label: 'ATS', value: a.score, suffix: '/100', accent: true })}
        ${kpi({ label: 'Termos cobertos', value: a.keywordDetail ? `${a.keywordDetail.covered.length}/${a.keywordDetail.total}` : '—' })}
        ${kpi({ label: 'Problemas de formato', value: a.issues.length })}
      </div>

      <div class="note note-info" style="margin-bottom:16px">${esc(a.disclaimer)}</div>

      ${a.keywordDetail && a.keywordDetail.missing.length ? `
        <h3 style="margin:0 0 8px">Termos da vaga ausentes no currículo</h3>
        <div class="job-chips" style="margin-bottom:16px">
          ${a.keywordDetail.missing.map(m => chip(m.label, 'chip-warn')).join('')}
        </div>` : ''}

      ${rewrites.length ? `
        <h3 style="margin:0 0 8px">Ajustes que seu perfil sustenta</h3>
        ${rewrites.map(s => `<div class="issue sev-MEDIUM">
          <h4>${esc(s.concept)} ${chip('confiança ' + esc(s.confidence || 'HIGH'), 'chip-ok')}</h4>
          <p>${esc(s.reason)}</p>
          <div class="fix">${esc(s.recommendation)}</div>
        </div>`).join('')}` : ''}

      ${gaps.length ? `
        <h3 style="margin:18px 0 8px">Lacunas reais — não inclua no currículo</h3>
        ${gaps.map(s => `<div class="issue sev-HIGH">
          <h4>${esc(s.concept)}</h4>
          <p>${esc(s.reason)}</p>
          <div class="fix">${esc(s.recommendation)}</div>
        </div>`).join('')}` : ''}

      ${structure.length ? `
        <details class="disclose" style="margin-top:18px">
          <summary>Ajustes de formato (${structure.length})</summary>
          <div class="body">${a.issues.map(issueCard).join('')}</div>
        </details>` : ''}
    </div>`);
  }

  function statusIcon(status) {
    const map = {
      MET: ['✓', 'var(--ok)'], SEMANTIC_MET: ['≈', 'var(--ok)'],
      NEAR: ['△', 'var(--warn)'], UNRESOLVED: ['?', 'var(--warn)'], NOT_MET: ['✕', 'var(--crit)']
    };
    const [icon, color] = map[status] || ['·', 'var(--ink-muted)'];
    return `<span style="color:${color};font-weight:700" title="${esc(status)}">${icon}</span>`;
  }

  function methodLabel(m) {
    return { EMAIL: 'E-mail', PHONE: 'Telefone', WEBSITE: 'Site', OTHER: 'Outro', UNKNOWN: 'Não informado' }[m] || m;
  }

  // =========================================================================
  // ATS CENTER
  // =========================================================================

  // =========================================================================
  // ATS CENTER — escopado por ambiente (spec §1E)
  // =========================================================================

  async function atsCenter(platform, country, route) {
    const api = API.env(platform, country);
    const data = await api.atsCenter();

    const wrap = el(`<div>
      <div class="page-head">
        <div class="titles">
          <h1>ATS Center</h1>
          <p class="sub">Compatibilidade dos currículos de <strong>${esc(data.environment)}</strong> com a leitura automática. Regra em uso: <span class="mono">${esc(data.ruleSet.version)}</span>.</p>
        </div>
        <div class="page-actions"><button class="btn" id="add">Gerenciar currículos</button></div>
      </div>
      <div class="note note-info" style="margin-bottom:16px">${esc(data.disclaimer)}</div>
      <div class="grid grid-kpi" id="kpis"></div>
      <div style="margin-top:18px" id="list"></div>
      <div style="margin-top:18px" id="detail"></div>
    </div>`);

    wrap.querySelector('#kpis').innerHTML = [
      kpi({ label: 'Saúde média', value: data.averageHealth, suffix: data.averageHealth ? '/100' : '', accent: true }),
      kpi({ label: 'Problemas críticos', value: data.totalCriticalIssues }),
      kpi({ label: 'Currículos', value: data.resumes.length }),
      kpi({ label: 'Sem análise', value: data.pendingAnalysis })
    ].join('');

    const list = wrap.querySelector('#list');
    if (!data.resumes.length) {
      list.appendChild(emptyState({
        title: `Nenhum currículo em ${data.environment}`,
        message: data.emptyMessage,
        actionLabel: 'Adicionar currículo aqui',
        onAction: () => route.go(resumesRoute(platform, country))
      }));
    } else {
      const table = el(`<div class="table-wrap"><table>
        <thead><tr><th>Currículo</th><th>Trilha</th><th class="num">ATS</th><th>Status</th><th class="num">Críticos</th><th></th></tr></thead>
        <tbody>${data.resumes.map(r => `<tr>
          <td><strong>${esc(r.name)}</strong>${r.isDefault ? ' ' + chip('padrão', 'chip-plain') : ''}</td>
          <td>${esc(r.careerTrack)}</td>
          <td class="num">${r.score == null ? '—' : esc(r.score)}</td>
          <td>${r.status ? chipFrom(ATS_STATUS, r.status) : '<span class="kpi-note">não analisado</span>'}</td>
          <td class="num">${r.criticalIssues == null ? '—' : esc(r.criticalIssues)}</td>
          <td><button class="btn btn-sm" data-analyze="${r.id}">${r.score == null ? 'Analisar' : 'Ver detalhes'}</button></td>
        </tr>`).join('')}</tbody>
      </table></div>`);
      list.appendChild(table);

      table.querySelectorAll('[data-analyze]').forEach(b => {
        b.addEventListener('click', async () => {
          const detail = wrap.querySelector('#detail');
          detail.innerHTML = '';
          b.disabled = true; b.textContent = 'Analisando…';
          try {
            const out = await api.analyzeResume(Number(b.dataset.analyze));
            detail.appendChild(atsDetail(out));
            detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } catch (e) {
            detail.appendChild(errorCard(e));
          } finally {
            b.disabled = false; b.textContent = 'Ver detalhes';
          }
        });
      });
    }

    wrap.querySelector('#add').addEventListener('click', () => route.go(resumesRoute(platform, country)));
    return wrap;
  }

  function resumesRoute(platform, country) {
    return platform === 'seasonal' ? '#/seasonal/resumes' : `#/${platform}/${String(country).toLowerCase()}/resumes`;
  }

  // =========================================================================
  // PERFIL DO AMBIENTE (spec §1A, §1B)
  // =========================================================================

  async function environmentProfile(platform, country, route) {
    const api = API.env(platform, country);
    const { profile } = await api.profile();
    const envLabel = profile.environment;

    const wrap = el(`<div>
      <div class="page-head">
        <div class="titles">
          <h1>Perfil — ${esc(envLabel)}</h1>
          <p class="sub">Este perfil pertence exclusivamente a este ambiente. Ele não é compartilhado com as outras plataformas nem com o outro país, e nada é copiado automaticamente entre eles.</p>
        </div>
        <div class="page-actions"><button class="btn btn-primary" id="save">Salvar</button></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Dados básicos</h2></div>
        <div class="field-row">
          ${input('full_name', 'Nome completo', profile.fullName)}
          ${input('email', 'E-mail', profile.email, 'email')}
          ${input('phone', 'Telefone', profile.phone)}
          ${input('city', 'Cidade', profile.city)}
          ${input('state', 'Estado', profile.state)}
        </div>
        <div class="field">
          <label for="headline">Título profissional</label>
          <input type="text" id="headline" value="${esc(profile.headline)}">
        </div>
        <div class="field">
          <label for="summary">Resumo</label>
          <textarea id="summary">${esc(profile.summary)}</textarea>
        </div>
        <div class="field-row">
          ${input('years_of_experience', 'Anos de experiência', profile.yearsOfExperience, 'number')}
          ${input('availability_from', 'Disponível a partir de', profile.availabilityFrom, 'date')}
          ${input('availability_to', 'Disponível até', profile.availabilityTo, 'date')}
        </div>
        <div class="field-row">
          <div class="field">
            <label for="workplace_preference">Preferência de trabalho</label>
            <select id="workplace_preference">
              ${['remote', 'remote_only', 'hybrid', 'onsite'].map(v =>
                `<option value="${v}" ${profile.workplacePreference === v ? 'selected' : ''}>${
                  { remote: 'Prefiro remoto', remote_only: 'Somente remoto', hybrid: 'Híbrido', onsite: 'Presencial' }[v]}</option>`).join('')}
            </select>
          </div>
          ${input('drivers_license', 'Habilitação (categoria e situação)', profile.driversLicense)}
          ${input('work_authorization', 'Autorização de trabalho', profile.workAuthorization)}
        </div>
        <p class="note">Habilitação e autorização de trabalho são tratadas como requisitos críticos. Deixe em branco se não se aplica — o sistema marca como "em aberto" em vez de presumir.</p>
      </div>

      <div class="card">
        <div class="card-head"><h2>Habilidades e qualificações</h2></div>
        ${listField('skills', 'Habilidades', profile.skills, 'Separe por vírgula. Só liste o que você realmente domina.')}
        ${listField('tools', 'Ferramentas', profile.tools, 'Softwares e equipamentos que você opera.')}
        ${listField('languages', 'Idiomas', profile.languages, 'Ex.: Português nativo, Inglês avançado.')}
        ${listField('certifications', 'Certificações', profile.certifications, 'Apenas certificações que você possui de fato.')}
        ${listField('industries', 'Setores', profile.industries, 'Setores em que já atuou.')}
      </div>
    </div>`);

    wrap.querySelector('#save').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const body = {};
        for (const f of ['full_name', 'email', 'phone', 'city', 'state', 'headline', 'summary',
                         'years_of_experience', 'availability_from', 'availability_to',
                         'workplace_preference', 'drivers_license', 'work_authorization']) {
          const inp = wrap.querySelector('#' + f);
          if (inp) body[f] = inp.value;
        }
        for (const k of ['skills', 'tools', 'languages', 'certifications', 'industries']) {
          body[k] = wrap.querySelector('#list-' + k).value;
        }
        await api.saveProfile(body);
        toast('Perfil salvo', `As análises de ${envLabel} já usam estes dados.`, 'ok');
      } catch (err) {
        toast('Não foi possível salvar', err.message, 'err');
      } finally {
        e.target.disabled = false;
      }
    });

    return wrap;

    function input(id, label, value, type = 'text') {
      return `<div class="field"><label for="${id}">${esc(label)}</label>
        <input type="${type}" id="${id}" value="${esc(value ?? '')}"></div>`;
    }
    function listField(id, label, values, hint) {
      return `<div class="field"><label for="list-${id}">${esc(label)}</label>
        <input type="text" id="list-${id}" value="${esc((values || []).join(', '))}">
        <div class="hint">${esc(hint)}</div></div>`;
    }
  }

  // =========================================================================
  // CURRÍCULOS DO AMBIENTE (spec §1B, §1H, §1I)
  // =========================================================================

  async function environmentResumes(platform, country, route) {
    const api = API.env(platform, country);
    const isSeasonal = platform === 'seasonal';

    const wrap = el(`<div>
      <div class="page-head">
        <div class="titles">
          <h1>${isSeasonal ? 'Documentos' : 'Currículos'} — ${esc(platform)}${isSeasonal ? '' : ' ' + String(country).toUpperCase()}</h1>
          <p class="sub">Documentos deste ambiente. Currículos de outras plataformas ou do outro país não aparecem aqui e nunca são usados como alternativa.</p>
        </div>
        <div class="page-actions"><button class="btn btn-primary" id="add">Adicionar documento</button></div>
      </div>
      <div class="toolbar">
        <select id="f-type">
          <option value="">Todos os tipos</option>
          <option value="resume">Currículos</option>
          <option value="recommendation_letter">Cartas de recomendação</option>
        </select>
      </div>
      <div id="list"></div>
    </div>`);

    const list = wrap.querySelector('#list');

    const load = async () => {
      list.innerHTML = '';
      try {
        const { resumes, environment } = await api.resumes({ docType: wrap.querySelector('#f-type').value });

        if (!resumes.length) {
          list.appendChild(emptyState({
            title: 'Nenhum documento neste ambiente',
            message: `Adicione um currículo em PDF ou DOCX para ${environment}. O sistema extrai o texto, analisa a compatibilidade com leitura automática e compara com as vagas deste ambiente.`,
            actionLabel: 'Adicionar documento',
            onAction: openUpload
          }));
          return;
        }

        const table = el(`<div class="table-wrap"><table>
          <thead><tr><th>Nome</th><th>Trilha</th><th>Tipo</th>${isSeasonal ? '<th>Visto</th>' : ''}<th class="num">ATS</th><th>Extração</th><th></th></tr></thead>
          <tbody>${resumes.map(r => `<tr>
            <td><strong>${esc(r.name)}</strong>${r.is_default ? ' ' + chip('padrão', 'chip-plain') : ''}
              <div class="kpi-note">${esc(r.original_name)}</div></td>
            <td>${esc(r.career_track)}</td>
            <td>${r.doc_type === 'recommendation_letter' ? 'Carta de recomendação' : 'Currículo'}</td>
            ${isSeasonal ? `<td>
              <select class="visa-sel" data-visa="${r.id}" style="font-size:.85em;padding:3px 6px">
                <option value="ANY" ${(r.visa_type || 'ANY') === 'ANY' ? 'selected' : ''}>Qualquer</option>
                <option value="H-2A" ${r.visa_type === 'H-2A' ? 'selected' : ''}>H-2A</option>
                <option value="H-2B" ${r.visa_type === 'H-2B' ? 'selected' : ''}>H-2B</option>
              </select></td>` : ''}
            <td class="num">${r.ats_health == null ? '—' : esc(r.ats_health)}</td>
            <td>${r.extraction_confidence === 'LOW' ? chip('baixa', 'chip-warn')
                : r.extraction_confidence === 'MEDIUM' ? chip('média', 'chip-info') : chip('boa', 'chip-ok')}</td>
            <td style="white-space:nowrap">
              <a class="btn btn-sm btn-ghost" href="${esc(api.resumeFileUrl(r.id))}">Baixar</a>
              ${r.is_default ? '' : `<button class="btn btn-sm btn-ghost" data-def="${r.id}">Tornar padrão</button>`}
              <button class="btn btn-sm btn-ghost" data-arch="${r.id}">Arquivar</button>
            </td>
          </tr>`).join('')}</tbody>
        </table></div>`);
        list.appendChild(table);

        table.querySelectorAll('[data-def]').forEach(b => b.addEventListener('click', async () => {
          try { await api.updateResume(Number(b.dataset.def), { is_default: true }); load(); }
          catch (e) { toast('Não foi possível atualizar', e.message, 'err'); }
        }));

        table.querySelectorAll('[data-arch]').forEach(b => b.addEventListener('click', async () => {
          if (!await confirm('O documento sai das listas deste ambiente, mas o arquivo e as análises anteriores são preservados.',
                             { title: 'Arquivar documento', confirmLabel: 'Arquivar' })) return;
          try { await api.archiveResume(Number(b.dataset.arch)); toast('Documento arquivado', null, 'ok'); load(); }
          catch (e) { toast('Não foi possível arquivar', e.message, 'err'); }
        }));

        // Tipo de visto — só existe no Seasonal (F1.2).
        table.querySelectorAll('.visa-sel').forEach(sel => sel.addEventListener('change', async () => {
          const before = sel.dataset.prev || sel.value;
          try {
            await api.updateResume(Number(sel.dataset.visa), { visa_type: sel.value });
            sel.dataset.prev = sel.value;
            toast('Tipo de visto atualizado', `Este documento agora serve a: ${sel.options[sel.selectedIndex].text}.`, 'ok');
          } catch (e) {
            sel.value = before;
            toast('Não foi possível alterar', e.message, 'err');
          }
        }));
      } catch (err) {
        list.appendChild(errorCard(err, { onRetry: load }));
      }
    };

    function openUpload() {
      const form = el(`<div>
        <h2 style="margin-bottom:4px">Adicionar documento</h2>
        <p class="kpi-note" style="margin-bottom:16px">Ele pertencerá apenas a ${esc(platform)}${isSeasonal ? '' : ' ' + String(country).toUpperCase()}.</p>
        <div class="field"><label for="u-file">Arquivo (PDF, DOCX ou TXT, até 15 MB)</label>
          <input type="file" id="u-file" accept=".pdf,.docx,.doc,.txt"></div>
        <div class="field"><label for="u-name">Nome</label><input type="text" id="u-name" placeholder="Ex.: Currículo — Mídia Paga"></div>
        <div class="field-row">
          <div class="field"><label for="u-track">Trilha de carreira</label>
            <input type="text" id="u-track" placeholder="ex.: paid_media, hospitality, driving" value="geral"></div>
          <div class="field"><label for="u-type">Tipo</label>
            <select id="u-type"><option value="resume">Currículo</option><option value="recommendation_letter">Carta de recomendação</option></select></div>
        </div>
        ${isSeasonal ? `
        <div class="field">
          <label for="u-visa">Tipo de visto</label>
          <select id="u-visa">
            <option value="ANY">Qualquer — serve a H-2A e H-2B</option>
            <option value="H-2A">H-2A — agricultura</option>
            <option value="H-2B">H-2B — não agrícola</option>
          </select>
          <div class="hint">Vaga H-2A usa só documento H-2A ou Qualquer; vaga H-2B, só H-2B ou Qualquer. O documento de um tipo nunca sai em vaga do outro.</div>
        </div>` : ''}
        <label class="check"><input type="checkbox" id="u-default"> Definir como padrão para esta trilha</label>
        <p class="note">Cartas de recomendação só entram por upload. O sistema nunca gera uma carta em nome de outra pessoa.</p>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
          <button class="btn" data-cancel>Cancelar</button>
          <button class="btn btn-primary" data-send>Enviar</button>
        </div>
      </div>`);

      const m = modal(form, { title: 'Adicionar documento' });
      form.querySelector('[data-cancel]').addEventListener('click', m.close);
      form.querySelector('[data-send]').addEventListener('click', async (e) => {
        const file = form.querySelector('#u-file').files[0];
        if (!file) { toast('Escolha um arquivo', null, 'err'); return; }
        e.target.disabled = true; e.target.textContent = 'Enviando…';

        const fd = new FormData();
        fd.append('file', file);
        fd.append('name', form.querySelector('#u-name').value || file.name);
        fd.append('career_track', form.querySelector('#u-track').value || 'geral');
        fd.append('doc_type', form.querySelector('#u-type').value);
        if (isSeasonal) fd.append('visa_type', form.querySelector('#u-visa').value);
        if (form.querySelector('#u-default').checked) fd.append('is_default', '1');

        try {
          const out = await api.uploadResume(fd);
          m.close();
          toast('Documento adicionado',
            out.extraction.confidence === 'LOW'
              ? 'O texto não pôde ser lido com confiança — a análise ATS ficará limitada.'
              : `${out.extraction.characters} caracteres extraídos.`,
            out.extraction.confidence === 'LOW' ? '' : 'ok');
          load();
        } catch (err) {
          toast('Não foi possível enviar', err.message, 'err');
          e.target.disabled = false; e.target.textContent = 'Enviar';
        }
      });
    }

    wrap.querySelector('#add').addEventListener('click', openUpload);
    wrap.querySelector('#f-type').addEventListener('change', load);
    load();
    return wrap;
  }

  // =========================================================================
  // Documentos herdados da v2 — atribuição explícita (spec §1J)
  // =========================================================================

  async function unassignedModal(route) {
    let documents = [];
    try {
      documents = (await API.core.unassignedDocuments()).documents;
    } catch (e) {
      toast('Não foi possível carregar', e.message, 'err');
      return;
    }

    const body = el(`<div>
      <h2 style="margin-bottom:4px">Documentos da versão anterior</h2>
      <p class="kpi-note" style="margin-bottom:16px">
        Na versão anterior os currículos ficavam numa biblioteca única. Agora cada plataforma
        e país tem os próprios. Escolha o destino de cada documento — ele vira uma cópia
        independente naquele ambiente, e o original continua guardado aqui.
      </p>
      <div id="docs"></div>
    </div>`);

    const docs = body.querySelector('#docs');

    const render = () => {
      docs.innerHTML = '';
      if (!documents.length) {
        docs.appendChild(emptyState({ title: 'Nada pendente', message: 'Todos os documentos herdados já foram atribuídos.' }));
        return;
      }
      for (const d of documents) {
        const row = el(`<div style="padding:12px 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
            <strong style="flex:1">${esc(d.name)}</strong>
            <span class="kpi-note">${esc(d.original_name)}</span>
          </div>
          <div class="kpi-note" style="margin-bottom:8px">
            país original: ${esc(d.original_country || '—')} · trilha: ${esc(d.career_track || 'geral')}
            ${d.assigned_to ? ` · já copiado para: ${esc(d.assigned_to)}` : ''}
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${[['gupy', 'br', 'Gupy BR'], ['gupy', 'us', 'Gupy US'],
               ['indeed', 'br', 'Indeed BR'], ['indeed', 'us', 'Indeed US'],
               ['seasonal', 'us', 'Seasonal']]
              .map(([p, c, l]) => `<button class="btn btn-sm" data-p="${p}" data-c="${c}">${l}</button>`).join('')}
          </div>
        </div>`);

        row.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            const out = await API.core.assignDocument(d.id, b.dataset.p, b.dataset.c);
            toast('Documento copiado', `Agora pertence a ${out.environment}. A cópia é independente do original.`, 'ok');
            documents = (await API.core.unassignedDocuments()).documents;
            render();
          } catch (e) {
            toast('Não foi possível atribuir', e.message, 'err');
            b.disabled = false;
          }
        }));

        docs.appendChild(row);
      }
    };

    render();
    modal(body, { title: 'Documentos da versão anterior' });
  }

  function atsDetail(out) {
    const a = out.analysis;
    const node = el(`<div class="card">
      <div class="card-head">
        <h2>${esc(out.resume.name)}</h2>
        ${chipFrom(ATS_STATUS, a.status)}
        <span class="mono" style="font-size:11px;color:var(--ink-muted)">${esc(a.version)}</span>
      </div>
      <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:14px">
        <span style="font-size:34px;font-weight:700;letter-spacing:-.03em">${esc(a.score)}</span>
        <span style="color:var(--ink-3)">de 100 em compatibilidade</span>
      </div>
      ${(a.warnings || []).length ? `<div class="note" style="margin-bottom:14px">${a.warnings.map(esc).join('<br>')}</div>` : ''}
      <details class="disclose" open>
        <summary>Componentes da pontuação</summary>
        <div class="body">${scoreBreakdown(a.components, a.weights, ATS_LABELS)}</div>
      </details>
      <h3 style="margin:18px 0 10px">Problemas encontrados (${(a.issues || []).length})</h3>
      <div id="issues"></div>
    </div>`);

    const issues = node.querySelector('#issues');
    issues.innerHTML = (a.issues || []).length
      ? a.issues.map(issueCard).join('')
      : '<p class="note">Nenhum problema de formato detectado com as regras deste mercado.</p>';

    return node;
  }

  // =========================================================================
  // CORE — perfil e biblioteca
  // =========================================================================

  return {
    portal, countryChoice,
    boardDashboard, boardJobs, boardJobDetail, jobDetailShell, jobCardFor, runSearch,
    atsCenter, atsDetail,
    environmentProfile, environmentResumes, unassignedModal, resumesRoute,
    FIT_LABELS, ATS_LABELS, OPP_LABELS, COUNTRY_NAME, methodLabel, statusIcon
  };
})();

window.Views = Views;
