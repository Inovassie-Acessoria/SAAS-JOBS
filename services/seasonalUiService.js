/**
 * Apoio ao front H2B: preferências de interface, notificações internas e os
 * números da aba "Números" (F3.5, F4.2).
 *
 * Nada aqui decide envio. É leitura agregada e estado de tela — o que o
 * sistema de referência guardava no localStorage, guardado no servidor para
 * que celular e computador vejam a mesma coisa.
 */

const { db } = require('../config/database');

// ---------------------------------------------------------------- prefs

const PREF_KEYS = new Set([
  'theme', 'screen_mode', 'onboarding_done', 'tour_done', 'avatar', 'display_name',
  'last_view', 'jobs_sheet', 'filters', 'auto_wizard', 'news_seen_at', 'hist_reset_at', 'driver_card_open'
]);

function getPrefs() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM seasonal_ui_prefs').all()) {
    try { out[r.key] = JSON.parse(r.value); } catch (e) { out[r.key] = r.value; }
  }
  return out;
}

function setPrefs(obj = {}) {
  db.exec('BEGIN');
  try {
    for (const [k, v] of Object.entries(obj)) {
      if (!PREF_KEYS.has(k)) continue;
      db.prepare(`INSERT INTO seasonal_ui_prefs (key, value, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
        .run(k, JSON.stringify(v === undefined ? null : v));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return getPrefs();
}

// -------------------------------------------------------- notifications

function notify(kind, title, body = null, link = null) {
  db.prepare('INSERT INTO seasonal_notifications (kind, title, body, link) VALUES (?,?,?,?)')
    .run(String(kind), String(title), body ? String(body) : null, link ? String(link) : null);
  // Mantém a lista enxuta: as 300 mais recentes.
  db.prepare(`DELETE FROM seasonal_notifications WHERE id NOT IN
              (SELECT id FROM seasonal_notifications ORDER BY id DESC LIMIT 300)`).run();
}

function listNotifications(limit = 60) {
  const rows = db.prepare('SELECT * FROM seasonal_notifications ORDER BY id DESC LIMIT ?').all(Number(limit));
  const unread = db.prepare('SELECT COUNT(*) AS n FROM seasonal_notifications WHERE read = 0').get().n;
  return { notifications: rows.map(r => Object.assign(r, { read: Boolean(r.read) })), unread };
}

function markRead(id = null) {
  if (id) db.prepare('UPDATE seasonal_notifications SET read = 1 WHERE id = ?').run(Number(id));
  else db.prepare('UPDATE seasonal_notifications SET read = 1 WHERE read = 0').run();
  return listNotifications();
}

function clearNotifications() {
  db.prepare('DELETE FROM seasonal_notifications').run();
  return listNotifications();
}

// ---------------------------------------------------------------- stats

function dayKey(offsetDays, tz) {
  const d = new Date(Date.now() - offsetDays * 86400000);
  // YYYY-MM-DD no fuso do sistema (mesma chave que a cota usa).
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return parts;
}

/**
 * Números do envio: hoje, 7 dias, 30 dias, total, série diária dos últimos
 * 14 dias, distribuição por estado e por visto. Tudo a partir da tabela de
 * candidaturas enviadas — a única fonte que reflete o que saiu de fato.
 */
function stats() {
  const emailService = require('./seasonalEmailService');
  const tz = emailService.getTimezone();
  const quota = emailService.getQuotaStatus();

  const total = db.prepare('SELECT COUNT(*) AS n FROM seasonal_applications').get().n;
  const byDay = db.prepare(`SELECT substr(sent_at, 1, 10) AS day, COUNT(*) AS n
                            FROM seasonal_applications
                            WHERE sent_at >= date('now', '-30 days')
                            GROUP BY day`).all();
  const map = Object.fromEntries(byDay.map(r => [r.day, r.n]));
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const k = dayKey(i, tz);
    series.push({ day: k, n: map[k] || 0 });
  }
  const sum = (days) => { let t = 0; for (let i = 0; i < days; i++) t += map[dayKey(i, tz)] || 0; return t; };

  const byState = db.prepare(`SELECT j.employer_state AS state, COUNT(*) AS n
                              FROM seasonal_applications a JOIN seasonal_jobs j ON j.id = a.seasonal_job_id
                              GROUP BY j.employer_state ORDER BY n DESC LIMIT 12`).all();
  const byVisa = db.prepare(`SELECT j.visa_type AS visa, COUNT(*) AS n
                             FROM seasonal_applications a JOIN seasonal_jobs j ON j.id = a.seasonal_job_id
                             GROUP BY j.visa_type`).all();
  const failures = db.prepare(`SELECT COUNT(*) AS n FROM seasonal_email_queue WHERE status = 'FAILED'`).get().n;
  const queued = db.prepare(`SELECT COUNT(*) AS n FROM seasonal_email_queue WHERE status IN ('QUEUED','AWAITING_REVIEW')`).get().n;
  const employers = db.prepare('SELECT COUNT(DISTINCT employer_name) AS n FROM seasonal_applications').get().n;
  const firstSent = db.prepare('SELECT MIN(sent_at) AS d FROM seasonal_applications').get().d;

  return {
    today: quota.countSent, dailyLimit: quota.maxLimit, remaining: quota.remaining,
    last7: sum(7), last30: sum(30), total, employers, failures, queued, firstSent,
    series, byState, byVisa, timezone: tz
  };
}

module.exports = { PREF_KEYS, getPrefs, setPrefs, notify, listNotifications, markRead, clearNotifications, stats };
