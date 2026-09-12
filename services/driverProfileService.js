/**
 * Perfil de motorista do Seasonal (spec de agentes §27, §18).
 *
 * O Seasonal tem um perfil dedicado, com vocabulário próprio de motorista. Ele
 * NÃO é compartilhado com Gupy nem Indeed — o isolamento por plataforma vale
 * aqui como vale para currículos.
 *
 * A regra que molda este arquivo é a §18:
 *
 *     "Unknown values must remain UNKNOWN. Do not guess."
 *
 * Por isso o valor ausente é `null` no banco e vira literalmente `'UNKNOWN'` na
 * leitura. Não existe default otimista: um perfil recém-criado não afirma ter
 * CDL, não afirma não ter, e não afirma histórico limpo. Ele diz que não sabe —
 * e é isso que faz o Truth Guard bloquear qualquer texto que afirme o contrário.
 */

const { db, logSeasonal } = require('../config/database');

const UNKNOWN = 'UNKNOWN';

/** Campos com conjunto fechado de valores. Fora do conjunto → UNKNOWN. */
const ENUMS = {
  manual_transmission_experience: ['YES', 'NO', UNKNOWN],
  cdl_status: ['HELD', 'NOT_HELD', 'EXPIRED', 'IN_PROGRESS', UNKNOWN],
  cdl_class: ['A', 'B', 'C', UNKNOWN],
  driving_record: ['CLEAN', 'MINOR_VIOLATIONS', 'MAJOR_VIOLATIONS', UNKNOWN],
  english_level: ['NONE', 'BASIC', 'INTERMEDIATE', 'ADVANCED', 'NATIVE', UNKNOWN],
  long_distance_experience: ['YES', 'NO', UNKNOWN],
  agricultural_hauling_experience: ['YES', 'NO', UNKNOWN]
};

const NUMERIC = ['truck_driving_experience', 'tractor_trailer_experience'];
const TEXT = ['cdl_endorsements', 'equipment_experience', 'lifting_capacity',
              'availability_start', 'availability_end', 'accepted_states'];
const BOOL = ['h2a_interest', 'h2b_interest'];
const TRISTATE = ['can_obtain_cdl'];   // 1 | 0 | null(UNKNOWN)

/** Campos que o Truth Guard consulta e que, em UNKNOWN, produzem revisão (§54). */
const CRITICAL_FIELDS = ['cdl_status', 'driving_record', 'truck_driving_experience'];

function row(userId = 1) {
  let r = db.prepare('SELECT * FROM seasonal_driver_profiles WHERE user_id = ?').get(Number(userId));
  if (!r) {
    db.prepare('INSERT INTO seasonal_driver_profiles (user_id) VALUES (?)').run(Number(userId));
    r = db.prepare('SELECT * FROM seasonal_driver_profiles WHERE user_id = ?').get(Number(userId));
  }
  return r;
}

/**
 * Leitura no formato que os agentes consomem.
 * Ausência vira `'UNKNOWN'` — nunca `''`, `0` ou `false`, que seriam afirmações.
 */
function get(userId = 1) {
  const r = row(userId);
  const out = { userId: r.user_id };

  for (const f of NUMERIC) out[f] = r[f] === null || r[f] === undefined ? UNKNOWN : Number(r[f]);
  for (const f of Object.keys(ENUMS)) out[f] = r[f] || UNKNOWN;
  for (const f of TEXT) out[f] = r[f] === null || r[f] === '' ? UNKNOWN : r[f];
  for (const f of TRISTATE) out[f] = r[f] === null || r[f] === undefined ? UNKNOWN : String(r[f]);
  for (const f of BOOL) out[f] = r[f] === null ? UNKNOWN : Boolean(r[f]);

  out.updatedAt = r.updated_at;
  out.unknownFields = allFields().filter(f => out[f] === UNKNOWN);
  out.criticalUnknowns = CRITICAL_FIELDS.filter(f => out[f] === UNKNOWN);
  out.complete = out.criticalUnknowns.length === 0;
  return out;
}

function allFields() {
  return [...NUMERIC, ...Object.keys(ENUMS), ...TEXT, ...TRISTATE, ...BOOL];
}

/**
 * Atualiza o perfil. Um campo enviado como `'UNKNOWN'` ou vazio VOLTA a ser
 * desconhecido — o usuário pode retirar uma afirmação, e isso precisa propagar
 * para o Truth Guard (§17).
 */
function update(data = {}, userId = 1) {
  row(userId);
  const sets = [];
  const params = [];

  const push = (col, value) => { sets.push(`${col} = ?`); params.push(value); };

  for (const f of NUMERIC) {
    if (data[f] === undefined) continue;
    const raw = String(data[f]).trim();
    if (raw === '' || raw.toUpperCase() === UNKNOWN) { push(f, null); continue; }
    const n = Number(raw.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || n > 70) {
      const e = new Error(`Valor inválido para ${f}: "${data[f]}". Informe um número de anos ou deixe UNKNOWN.`);
      e.userFacing = true;
      throw e;
    }
    push(f, n);
  }

  for (const [f, allowed] of Object.entries(ENUMS)) {
    if (data[f] === undefined) continue;
    const v = String(data[f]).trim().toUpperCase();
    if (v === '' || v === UNKNOWN) { push(f, null); continue; }
    if (!allowed.includes(v)) {
      const e = new Error(`Valor inválido para ${f}: "${data[f]}". Válidos: ${allowed.join(', ')}.`);
      e.userFacing = true;
      throw e;
    }
    push(f, v);
  }

  for (const f of TEXT) {
    if (data[f] === undefined) continue;
    const v = String(data[f]).trim();
    push(f, v === '' || v.toUpperCase() === UNKNOWN ? null : v.slice(0, 500));
  }

  for (const f of TRISTATE) {
    if (data[f] === undefined) continue;
    const v = String(data[f]).trim().toUpperCase();
    if (v === '' || v === UNKNOWN) { push(f, null); continue; }
    push(f, ['1', 'TRUE', 'YES', 'SIM'].includes(v) ? 1 : 0);
  }

  for (const f of BOOL) {
    if (data[f] === undefined) continue;
    push(f, data[f] ? 1 : 0);
  }

  if (!sets.length) return get(userId);

  params.push(Number(userId));
  db.prepare(`UPDATE seasonal_driver_profiles SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
              WHERE user_id = ?`).run(...params);

  const after = get(userId);
  logSeasonal('driver_profile_updated',
    `Perfil de motorista atualizado. ${after.unknownFields.length} campo(s) seguem UNKNOWN.`,
    { changed: sets.length, criticalUnknowns: after.criticalUnknowns });
  return after;
}

/**
 * O que falta para o robô poder candidatar sozinho (§36, §54).
 * Não é validação de formulário: é a lista de decisões que o sistema se recusa
 * a tomar no lugar do usuário.
 */
/** Foco atual: true = só motorista de caminhão; false = todas as vagas (padrão). */
function truckFocus() {
  try {
    const cfg = db.prepare('SELECT require_truck_driver_match FROM seasonal_config ORDER BY id LIMIT 1').get();
    return Boolean(cfg) && Number(cfg.require_truck_driver_match) === 1;
  } catch (e) { return false; }
}

function readiness(userId = 1) {
  const p = get(userId);
  const blockers = [];
  const truckOnly = truckFocus();

  if (p.cdl_status === UNKNOWN) {
    blockers.push({
      field: 'cdl_status', severity: 'HIGH',
      message: 'O status da CDL está UNKNOWN. Vagas que exigem CDL antes da contratação ficarão em revisão em vez de serem enviadas (§18, §28).'
    });
  }
  if (p.truck_driving_experience === UNKNOWN) {
    blockers.push({
      field: 'truck_driving_experience', severity: 'HIGH',
      message: 'Sem anos de experiência declarados, nenhuma carta pode citar experiência — o Truth Guard bloqueia a afirmação (§17).'
    });
  }
  if (p.driving_record === UNKNOWN) {
    blockers.push({
      field: 'driving_record', severity: 'MEDIUM',
      message: 'Vagas que exigem histórico de direção limpo ficarão em revisão.'
    });
  }
  if (p.english_level === UNKNOWN) {
    blockers.push({
      field: 'english_level', severity: 'LOW',
      message: 'Vagas com exigência explícita de inglês ficarão em revisão.'
    });
  }

  // Foco amplo: campos de motorista só importam nas vagas de caminhão. Eles
  // deixam de ser bloqueio do sistema inteiro e viram aviso localizado — a
  // vaga de caminhão específica ainda para em revisão se o perfil não souber.
  if (!truckOnly) {
    for (const b of blockers) {
      if (b.field === 'cdl_status' || b.field === 'truck_driving_experience' || b.field === 'driving_record') {
        b.severity = 'LOW';
        b.scope = 'TRUCK_JOBS_ONLY';
        b.message += ' (Só afeta vagas de caminhão — o foco atual é todas as vagas.)';
      }
    }
  }

  return {
    truckFocus: truckOnly,
    complete: blockers.filter(b => b.severity === 'HIGH').length === 0,
    blockers,
    unknownFields: p.unknownFields,
    profile: p
  };
}

module.exports = {
  UNKNOWN, ENUMS, NUMERIC, TEXT, BOOL, TRISTATE, CRITICAL_FIELDS,
  allFields, get, update, readiness, truckFocus
};
