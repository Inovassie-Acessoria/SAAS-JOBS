/**
 * Componentes de interface reutilizáveis.
 *
 * Tudo que vem do servidor passa por `esc()` antes de entrar no DOM — o cartão
 * de vaga da versão anterior injetava título e empresa cru via innerHTML.
 */

const UI = (() => {

  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const el = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };

  // ------------------------------------------------------------- formato

  /** Salário normalizado por mercado (spec §47). Nunca inventa valor ausente. */
  function salary(job) {
    const src = job.salary_source === 'estimated' ? 'estimado' : 'informado pelo empregador';

    if (job.wage_rate) {
      return { text: `$${Number(job.wage_rate).toFixed(2)} / hora`, source: src };
    }
    if (job.salary_month) {
      return { text: `R$ ${Number(job.salary_month).toLocaleString('pt-BR')} / mês`, source: src };
    }
    if (job.salary_min || job.salary_max) {
      const cur = job.salary_currency === 'BRL' ? 'R$' : '$';
      const per = job.salary_period === 'month' ? 'mês' : 'ano';
      const fmt = n => cur === 'R$'
        ? `R$ ${Number(n).toLocaleString('pt-BR')}`
        : `$${Math.round(Number(n) / 1000)}k`;
      const text = job.salary_min && job.salary_max && job.salary_min !== job.salary_max
        ? `${fmt(job.salary_min)}–${fmt(job.salary_max)} / ${per}`
        : `${fmt(job.salary_min || job.salary_max)} / ${per}`;
      return { text, source: src };
    }
    return null;
  }

  function relativeDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    const h = Math.floor((Date.now() - d.getTime()) / 3600000);
    if (h < 1) return 'agora há pouco';
    if (h < 24) return `há ${h}h`;
    const days = Math.floor(h / 24);
    if (days === 1) return 'ontem';
    if (days < 30) return `há ${days} dias`;
    const m = Math.floor(days / 30);
    return m === 1 ? 'há 1 mês' : `há ${m} meses`;
  }

  const CATEGORY_CHIP = {
    TOP_PRIORITY:   ['chip-accent', 'Prioridade máxima'],
    STRONG_MATCH:   ['chip-ok', 'Match forte'],
    POSSIBLE_MATCH: ['chip-info', 'Match possível'],
    LOW_MATCH:      ['chip-plain', 'Match baixo']
  };

  const HEALTH_CHIP = {
    HEALTHY:            ['chip-ok', 'Conectado'],
    DEGRADED:           ['chip-warn', 'Dados de exemplo'],
    REQUIRES_ATTENTION: ['chip-crit', 'Precisa de atenção'],
    DISCONNECTED:       ['chip-warn', 'Desconectado'],
    NOT_CONFIGURED:     ['chip-plain', 'Não configurado'],
    ERROR:              ['chip-crit', 'Erro']
  };

  const ATS_STATUS = {
    EXCELLENT:         ['chip-ok', 'Excelente'],
    GOOD:              ['chip-ok', 'Bom'],
    NEEDS_IMPROVEMENT: ['chip-warn', 'A melhorar'],
    RISKY:             ['chip-crit', 'Arriscado']
  };

  function chip(text, kind = 'chip-plain') {
    return `<span class="chip ${kind}">${esc(text)}</span>`;
  }

  function chipFrom(map, key, fallback) {
    const e = map[key];
    if (!e) return fallback ? chip(fallback) : '';
    return chip(e[1], e[0]);
  }

  // --------------------------------------------------------------- blocos

  function kpi({ label, value, suffix, note, accent }) {
    return `<div class="kpi ${accent ? 'kpi-accent' : ''}">
      <div class="kpi-label">${esc(label)}</div>
      <div class="kpi-value">${value === null || value === undefined ? '—' : esc(value)}${suffix ? `<small> ${esc(suffix)}</small>` : ''}</div>
      ${note ? `<div class="kpi-note">${esc(note)}</div>` : ''}
    </div>`;
  }

  /** Zona de atenção do dashboard (spec §43). */
  function attention(items, onAction) {
    if (!items || !items.length) return '';
    const html = items.map((a, i) => `
      <div class="alert alert-${esc(a.severity)}">
        <div class="alert-body">
          <div class="alert-title">${esc(a.title)}</div>
          ${a.detail ? `<div class="alert-detail">${esc(a.detail)}</div>` : ''}
        </div>
        ${a.action ? `<button class="btn btn-sm" data-attention="${i}">Resolver</button>` : ''}
      </div>`).join('');

    const node = el(`<div class="attention">${html}</div>`);
    if (onAction) {
      node.querySelectorAll('[data-attention]').forEach(b => {
        b.addEventListener('click', () => onAction(items[Number(b.dataset.attention)]));
      });
    }
    return node;
  }

  /**
   * Cartão de vaga (spec §20): resumo escaneável, análise completa só ao abrir.
   * Nada de 20 badges de skill aqui.
   */
  function jobCard(job, ctx) {
    const isSeasonal = ctx.product === 'seasonal';
    const title = isSeasonal ? job.job_title : job.title;
    const company = isSeasonal ? job.employer_name : job.company;
    const location = isSeasonal
      ? [job.employer_city, job.employer_state].filter(Boolean).join(', ')
      : (job.location || [job.location_city, job.location_state].filter(Boolean).join(', '));

    const sal = salary(job);
    const posted = relativeDate(job.published_date || job.collected_at);
    const concerns = job.concerns || [];
    const worst = concerns.find(c => c.severity === 'CRITICAL') || concerns.find(c => c.severity === 'HIGH');

    const chips = [];
    if (job.category) chips.push(chipFrom(CATEGORY_CHIP, job.category));
    if (isSeasonal) {
      if (job.visa_type) chips.push(chip(job.visa_type, 'chip-plain'));
      if (job.timeline_class === 'TARGET_2027') {
        chips.push(chip(job.timeline_label || 'Prioridade 2027', 'chip-accent'));
      } else if (job.timeline_class === 'UNKNOWN_DATE' || !job.timeline_class) {
        chips.push(chip('Período não disponível', 'chip-plain'));
      }
      chips.push(job.isEmailEligible
        ? chip('Candidatura por e-mail', 'chip-ok')
        : chip('Ação manual', 'chip-warn'));
      if (job.is_applied) chips.push(chip('Já enviada', 'chip-info'));
    } else {
      if (job.country) chips.push(chip(job.country === 'BR' ? 'Brasil' : 'Estados Unidos', 'chip-plain'));
      if (job.workplace_type === 'remote' || job.is_remote) chips.push(chip('Remoto', 'chip-plain'));
    }
    if (job.is_saved) chips.push(chip('Salva', 'chip-info'));

    const cls = worst ? (worst.severity === 'CRITICAL' ? 'is-crit' : 'is-alert') : '';

    const node = el(`
      <article class="job-card ${cls}">
        <div class="job-main">
          <button class="job-title" data-open>${esc(title)}</button>
          <div class="job-meta">
            <span>${esc(company)}</span>
            ${location ? `<span class="sep">·</span><span>${esc(location)}</span>` : ''}
            ${posted ? `<span class="sep">·</span><span>${esc(posted)}</span>` : ''}
            ${isSeasonal && job.timeline_period ? `<span class="sep">·</span><span>Trabalho: ${esc(job.timeline_period)}</span>` : ''}
          </div>
          ${sal
            ? `<div class="job-salary">${esc(sal.text)}<span class="src">${esc(sal.source)}</span></div>`
            : `<div class="job-salary none">Salário não informado</div>`}
          ${worst ? `<div class="job-chips" style="margin-bottom:8px">${chip(worst.title, worst.severity === 'CRITICAL' ? 'chip-crit' : 'chip-warn')}</div>` : ''}
          <div class="job-chips">${chips.join('')}</div>
        </div>
        <div class="job-side">
          <div class="score-row">
            <div class="score">
              <div class="score-label">Fit</div>
              <div class="score-value ${job.fit_score == null ? 'dim' : ''}">${job.fit_score == null ? '—' : job.fit_score}</div>
            </div>
            <div class="score">
              <div class="score-label">ATS</div>
              <div class="score-value ${job.ats_score == null ? 'dim' : ''}">${job.ats_score == null ? '—' : job.ats_score}</div>
            </div>
            <div class="score">
              <div class="score-label">Oport.</div>
              <div class="score-value ${job.opportunity_score == null ? 'dim' : ''}">${job.opportunity_score == null ? '—' : job.opportunity_score}</div>
            </div>
          </div>
          <div class="job-actions">
            <button class="btn btn-sm" data-open>Ver análise</button>
            ${job.is_saved
              ? `<button class="btn btn-sm btn-ghost" data-unsave>Salva ✓</button>`
              : `<button class="btn btn-sm btn-ghost" data-save>Salvar</button>`}
            ${!isSeasonal
              ? `<a class="btn btn-sm btn-ghost" href="${esc(job.apply_url || job.job_url || '#')}" target="_blank" rel="noopener noreferrer">Abrir vaga</a>`
              : ''}
          </div>
        </div>
      </article>`);

    node.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => ctx.onOpen(job)));
    const save = node.querySelector('[data-save]');
    if (save) save.addEventListener('click', () => ctx.onSave(job));
    const unsave = node.querySelector('[data-unsave]');
    if (unsave) unsave.addEventListener('click', () => ctx.onDiscard(job));

    return node;
  }

  function emptyState({ title, message, actionLabel, onAction }) {
    const node = el(`<div class="empty">
      <h3>${esc(title)}</h3>
      <p>${esc(message)}</p>
      ${actionLabel ? `<button class="btn btn-primary" data-act>${esc(actionLabel)}</button>` : ''}
    </div>`);
    const b = node.querySelector('[data-act]');
    if (b && onAction) b.addEventListener('click', onAction);
    return node;
  }

  function skeletonList(n = 3) {
    return el(`<div class="job-list">${Array.from({ length: n }, () => '<div class="skeleton"></div>').join('')}</div>`);
  }

  /** Estados reais de progresso, sem barra falsa (spec §59). */
  function progress(steps) {
    return el(`<div class="card"><div class="progress-list">${
      steps.map(s => `<div class="progress-step ${esc(s.state)}">
        ${s.state === 'active' ? '<span class="spinner"></span>' : s.state === 'done' ? '<span aria-hidden="true">✓</span>' : '<span aria-hidden="true">○</span>'}
        <span>${esc(s.label)}</span>
      </div>`).join('')
    }</div></div>`);
  }

  function toast(title, detail, kind = '') {
    const stack = document.getElementById('toasts');
    const t = el(`<div class="toast ${kind}" role="status">
      <div class="t">${esc(title)}</div>
      ${detail ? `<div class="d">${esc(detail)}</div>` : ''}
    </div>`);
    stack.appendChild(t);
    setTimeout(() => t.remove(), kind === 'err' ? 8000 : 4500);
  }

  /** Erro apresentado como o spec §42 pede: o que houve, o que fazer. */
  function errorCard(err, { onRetry, retryLabel = 'Tentar de novo' } = {}) {
    const node = el(`<div class="card">
      <div class="card-head"><h3>Não foi possível concluir</h3></div>
      <p style="color:var(--ink-2);margin-bottom:8px">${esc(err.message)}</p>
      <p class="note">Seus dados já salvos não foram afetados.${err.correlationId ? ` Referência para os logs: ${esc(err.correlationId)}.` : ''}</p>
      ${onRetry ? `<div style="margin-top:14px"><button class="btn btn-primary" data-retry>${esc(retryLabel)}</button></div>` : ''}
    </div>`);
    const b = node.querySelector('[data-retry]');
    if (b && onRetry) b.addEventListener('click', onRetry);
    return node;
  }

  function scoreBreakdown(components, weights, labels) {
    const rows = Object.keys(components || {})
      .filter(k => components[k] !== null && components[k] !== undefined)
      .map(k => {
        const v = components[k];
        const w = weights && weights[k] ? Math.round(weights[k] * 100) : null;
        return `<div class="component-row">
          <div>
            <div>${esc((labels && labels[k]) || k)}</div>
            <div class="bar" style="margin-top:5px"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></div>
          </div>
          <div class="n">${esc(v)}</div>
          <div class="w">${w !== null ? `peso ${w}%` : ''}</div>
        </div>`;
      });
    return rows.length ? rows.join('') : '<p class="note">Nenhum componente pôde ser avaliado com os dados disponíveis.</p>';
  }

  function issueCard(issue) {
    return `<div class="issue sev-${esc(issue.severity)}">
      <h4>${esc(issue.title)} ${chip(issue.severity, issue.severity === 'CRITICAL' || issue.severity === 'HIGH' ? 'chip-crit' : issue.severity === 'MEDIUM' ? 'chip-warn' : 'chip-info')}</h4>
      <p>${esc(issue.why)}</p>
      <div class="fix"><strong>Como corrigir:</strong> ${esc(issue.correction)}</div>
      ${issue.evidence && issue.evidence.length
        ? `<div class="ev">Evidência: ${esc(issue.evidence.slice(0, 3).join(' · '))}</div>` : ''}
      <div class="ev">Regra ${esc(issue.ruleSetVersion || '')} · ${esc(issue.countryRule === 'BR' ? 'Brasil' : 'EUA')}${issue.platformRule && issue.platformRule !== 'geral' ? ` · ${esc(issue.platformRule)}` : ''}</div>
    </div>`;
  }

  function modal(contentNode, { title }) {
    const backdrop = el(`<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"></div></div>`);
    const box = backdrop.querySelector('.modal');
    box.appendChild(contentNode);

    const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };

    backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', onKey);
    document.getElementById('modal-root').appendChild(backdrop);

    const focusable = box.querySelector('button, input, select, textarea, a[href]');
    if (focusable) focusable.focus();

    return { close, box };
  }

  function confirm(message, { title = 'Confirmar', confirmLabel = 'Confirmar', danger = false } = {}) {
    return new Promise(resolve => {
      const node = el(`<div>
        <h2 style="margin-bottom:10px">${esc(title)}</h2>
        <p style="color:var(--ink-2);margin-bottom:18px">${esc(message)}</p>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn" data-no>Cancelar</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-yes>${esc(confirmLabel)}</button>
        </div>
      </div>`);
      const m = modal(node, { title });
      node.querySelector('[data-no]').addEventListener('click', () => { m.close(); resolve(false); });
      node.querySelector('[data-yes]').addEventListener('click', () => { m.close(); resolve(true); });
    });
  }

  return {
    esc, el, salary, relativeDate, chip, chipFrom,
    CATEGORY_CHIP, HEALTH_CHIP, ATS_STATUS,
    kpi, attention, jobCard, emptyState, skeletonList, progress,
    toast, errorCard, scoreBreakdown, issueCard, modal, confirm
  };
})();

window.UI = UI;
