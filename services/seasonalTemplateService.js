/**
 * Modelos de assunto e corpo do e-mail (F1.1).
 *
 * O usuário cadastra 3+ assuntos e 3+ corpos; cada envio usa o modelo MENOS
 * usado até então, de modo que os e-mails não saiam todos iguais — provedores
 * tratam repetição idêntica em massa como spam. As variáveis entre chaves são
 * substituídas pelos dados da vaga e do perfil no momento do preparo.
 *
 * O texto final passa pelo Truth Guard como qualquer outro (§17): modelo escrito
 * pelo usuário não é licença para afirmar o que o perfil não sustenta.
 */

const { db } = require('../config/database');

const KINDS = ['subject', 'body'];
const VISA_TYPES = ['ANY', 'H-2A', 'H-2B'];

/** Variáveis aceitas — a lista é mostrada no editor do front. */
const VARIABLES = [
  { key: 'nome',      label: 'Seu nome completo' },
  { key: 'vaga',      label: 'Título da vaga' },
  { key: 'empresa',   label: 'Nome do empregador' },
  { key: 'job_order', label: 'Número da ordem (DOL)' },
  { key: 'estado',    label: 'Estado (UF americana)' },
  { key: 'cidade',    label: 'Cidade' },
  { key: 'visto',     label: 'H-2A ou H-2B' },
  { key: 'salario',   label: 'Salário por hora' },
  { key: 'inicio',    label: 'Data de início' },
  { key: 'fim',       label: 'Data de término' },
  { key: 'email',     label: 'Seu e-mail' },
  { key: 'telefone',  label: 'Seu telefone' }
];

function normKind(kind) {
  const k = String(kind || '').toLowerCase();
  if (!KINDS.includes(k)) { const e = new Error('Tipo de modelo inválido.'); e.userFacing = true; e.status = 400; throw e; }
  return k;
}

function normVisa(v) {
  const s = String(v || 'ANY').toUpperCase().replace(/^H2/, 'H-2');
  return VISA_TYPES.includes(s) ? s : 'ANY';
}

function list(kind = null) {
  const rows = kind
    ? db.prepare('SELECT * FROM seasonal_email_templates WHERE kind = ? ORDER BY sort_order, id').all(normKind(kind))
    : db.prepare('SELECT * FROM seasonal_email_templates ORDER BY kind, sort_order, id').all();
  return rows.map(r => Object.assign({}, r, { active: Boolean(r.active) }));
}

function grouped() {
  const all = list();
  return {
    subjects: all.filter(r => r.kind === 'subject'),
    bodies: all.filter(r => r.kind === 'body'),
    variables: VARIABLES,
    minimum: 3
  };
}

/**
 * Substitui a lista inteira de um tipo. Modelos que já existiam (mesmo id)
 * mantêm o contador de uso — a rotação não recomeça do zero a cada edição.
 */
function replaceKind(kind, items) {
  const k = normKind(kind);
  const clean = (Array.isArray(items) ? items : [])
    .map((it, i) => ({
      id: it && it.id ? Number(it.id) : null,
      content: String((it && it.content) !== undefined ? it.content : it || '').trim(),
      visa_type: normVisa(it && it.visa_type),
      active: it && it.active === false ? 0 : 1,
      sort_order: i
    }))
    .filter(it => it.content.length > 0);

  db.exec('BEGIN');
  try {
    const keep = new Set();
    for (const it of clean) {
      if (it.id && db.prepare('SELECT id FROM seasonal_email_templates WHERE id = ? AND kind = ?').get(it.id, k)) {
        db.prepare(`UPDATE seasonal_email_templates
                    SET content = ?, visa_type = ?, active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?`).run(it.content, it.visa_type, it.active, it.sort_order, it.id);
        keep.add(it.id);
      } else {
        const r = db.prepare(`INSERT INTO seasonal_email_templates (kind, visa_type, content, active, sort_order)
                              VALUES (?,?,?,?,?)`).run(k, it.visa_type, it.content, it.active, it.sort_order);
        keep.add(Number(r.lastInsertRowid));
      }
    }
    const ids = [...keep];
    if (ids.length) {
      db.prepare(`DELETE FROM seasonal_email_templates WHERE kind = ? AND id NOT IN (${ids.map(() => '?').join(',')})`)
        .run(k, ...ids);
    } else {
      db.prepare('DELETE FROM seasonal_email_templates WHERE kind = ?').run(k);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return list(k);
}

function save({ subjects, bodies } = {}) {
  if (subjects !== undefined) replaceKind('subject', subjects);
  if (bodies !== undefined) replaceKind('body', bodies);
  return grouped();
}

/** Escolhe o modelo menos usado que sirva ao tipo de visto; empata pelo id. */
function pick(kind, visaType = null) {
  const k = normKind(kind);
  const v = visaType ? normVisa(visaType) : null;
  const row = db.prepare(`
    SELECT * FROM seasonal_email_templates
    WHERE kind = ? AND active = 1 AND (visa_type = 'ANY' ${v ? 'OR visa_type = ?' : ''})
    ORDER BY use_count ASC, sort_order ASC, id ASC
    LIMIT 1`).get(...(v ? [k, v] : [k]));
  return row || null;
}

function markUsed(id) {
  if (!id) return;
  db.prepare(`UPDATE seasonal_email_templates
              SET use_count = use_count + 1, last_used_at = CURRENT_TIMESTAMP WHERE id = ?`).run(Number(id));
}

function context({ job = {}, profile = {} } = {}) {
  const wage = job.wage_rate ? `$${Number(job.wage_rate).toFixed(2)}/${job.wage_unit || 'hour'}` : '';
  return {
    nome: profile.fullName || '',
    vaga: job.job_title || '',
    empresa: job.employer_name || '',
    job_order: job.job_order_id || '',
    estado: job.employer_state || '',
    cidade: job.employer_city || '',
    visto: job.visa_type || '',
    salario: wage,
    inicio: job.start_date || '',
    fim: job.end_date || '',
    email: profile.email || '',
    telefone: profile.phone || ''
  };
}

/** `{variavel}` → valor. Chaves desconhecidas ficam como estão, visíveis. */
function render(text, ctx) {
  return String(text || '').replace(/\{([a-z_]+)\}/gi, (m, key) => {
    const k = key.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ctx, k) ? String(ctx[k]) : m;
  });
}

/**
 * Compõe assunto e corpo para uma vaga. Sem modelo cadastrado devolve null
 * no campo — o chamador cai no texto gerado pelo sistema.
 */
function compose({ job, profile, consume = true }) {
  const ctx = context({ job, profile });
  const s = pick('subject', job && job.visa_type);
  const b = pick('body', job && job.visa_type);
  if (consume) { markUsed(s && s.id); markUsed(b && b.id); }
  return {
    subject: s ? render(s.content, ctx) : null,
    body: b ? render(b.content, ctx) : null,
    subjectTemplateId: s ? s.id : null,
    bodyTemplateId: b ? b.id : null
  };
}

function preview({ kind, content, job = {}, profile = {} }) {
  return render(content, context({ job, profile }));
}

function status() {
  const g = grouped();
  const activeS = g.subjects.filter(t => t.active).length;
  const activeB = g.bodies.filter(t => t.active).length;
  return {
    subjects: activeS, bodies: activeB, minimum: g.minimum,
    ready: activeS >= 1 && activeB >= 1,
    recommended: activeS >= g.minimum && activeB >= g.minimum
  };
}

module.exports = { KINDS, VISA_TYPES, VARIABLES, list, grouped, save, replaceKind, pick, markUsed, render, compose, preview, status, context };
