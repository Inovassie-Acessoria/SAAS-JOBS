const { db, logEvent } = require('../config/database');

function getAllTemplates() {
  return db.prepare('SELECT * FROM email_templates ORDER BY id ASC').all();
}

function getTemplateByCode(code) {
  return db.prepare('SELECT * FROM email_templates WHERE code = ?').get(code);
}

function updateTemplate(id, data) {
  const { name, subject_template, body_template, whatsapp_template, is_active } = data;
  db.prepare(`
    UPDATE email_templates SET
      name = COALESCE(?, name),
      subject_template = COALESCE(?, subject_template),
      body_template = COALESCE(?, body_template),
      whatsapp_template = COALESCE(?, whatsapp_template),
      is_active = COALESCE(?, is_active),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(name, subject_template, body_template, whatsapp_template, is_active !== undefined ? (is_active ? 1 : 0) : null, id);

  logEvent('info', 'Templates', `Modelo de e-mail #${id} atualizado`);
  return { success: true, message: 'Modelo atualizado com sucesso!' };
}

function renderTemplate(templateStr, placeholders = {}) {
  let result = templateStr;
  for (const [key, val] of Object.entries(placeholders)) {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
    result = result.replace(regex, val || '');
  }
  return result;
}

module.exports = {
  getAllTemplates,
  getTemplateByCode,
  updateTemplate,
  renderTemplate
};
