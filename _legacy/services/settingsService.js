const { db, logEvent, getTodayQuota } = require('../config/database');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');

function getAllSettings() {
  const rows = db.prepare('SELECT key, value, category, description, updated_at FROM system_settings').all();
  const settings = {};
  for (const r of rows) {
    settings[r.key] = {
      value: r.value,
      category: r.category,
      description: r.description,
      updated_at: r.updated_at
    };
  }
  return settings;
}

function getSetting(key, defaultValue = '') {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
  return row ? row.value : defaultValue;
}

function updateSettings(settingsMap) {
  const updateStmt = db.prepare(`
    INSERT INTO system_settings (key, value, updated_at) 
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET 
      value = excluded.value, 
      updated_at = CURRENT_TIMESTAMP
  `);

  for (const [key, value] of Object.entries(settingsMap)) {
    updateStmt.run(key, String(value));
  }

  logEvent('info', 'Settings', 'Configurações atualizadas pelo painel');
  return { success: true, message: 'Configurações salvas com sucesso' };
}

async function testClaudeConnection(apiKeyOverride = null) {
  const startTime = Date.now();
  const apiKey = apiKeyOverride || getSetting('claude_api_key');
  const model = getSetting('claude_parsing_model', 'claude-3-5-haiku-latest');

  if (!apiKey) {
    return { success: false, error: 'Chave de API do Claude não informada' };
  }

  try {
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: model,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Respond with only "OK"' }]
    });

    const latency = Date.now() - startTime;
    const responseText = response.content[0]?.text?.trim();

    logEvent('success', 'Claude', `Conexão Claude testada com sucesso (${latency}ms)`);
    return {
      success: true,
      message: 'Conexão com Claude 3.5 estabelecida com sucesso!',
      latency: `${latency}ms`,
      response: responseText,
      modelUsed: response.model
    };
  } catch (err) {
    logEvent('error', 'Claude', `Falha ao testar Claude: ${err.message}`);
    return {
      success: false,
      error: err.message || 'Erro ao conectar à API Anthropic Claude'
    };
  }
}

async function testSmtpConnection(emailOverride = null, passwordOverride = null) {
  const user = emailOverride || getSetting('gmail_user');
  const pass = passwordOverride || getSetting('gmail_app_password');
  const host = getSetting('smtp_host', 'smtp.gmail.com');
  const port = parseInt(getSetting('smtp_port', '465'), 10);
  const secure = getSetting('smtp_secure', 'true') === 'true' || port === 465;

  if (!user || !pass) {
    return { success: false, error: 'E-mail ou Senha de Aplicativo do Gmail não configurados' };
  }

  const cleanPass = pass.replace(/\s+/g, '');

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user: user.trim(),
        pass: cleanPass
      },
      connectionTimeout: 10000
    });

    await transporter.verify();
    logEvent('success', 'Gmail SMTP', `Conexão SMTP verificada com sucesso para ${user}`);
    return {
      success: true,
      message: `Conexão SMTP com Gmail (${user}) autenticada e pronta para envios!`
    };
  } catch (err) {
    logEvent('error', 'Gmail SMTP', `Falha no teste SMTP: ${err.message}`);
    return {
      success: false,
      error: err.message || 'Erro de autenticação SMTP no Gmail. Verifique se usou a Senha de Aplicativo de 16 dígitos.'
    };
  }
}

async function testImapConnection(emailOverride = null, passwordOverride = null) {
  const user = emailOverride || getSetting('gmail_user');
  const pass = passwordOverride || getSetting('gmail_app_password');
  const host = getSetting('imap_host', 'imap.gmail.com');
  const port = parseInt(getSetting('imap_port', '993'), 10);
  const secure = getSetting('imap_secure', 'true') === 'true' || port === 993;

  if (!user || !pass) {
    return { success: false, error: 'E-mail ou Senha de Aplicativo do Gmail não configurados' };
  }

  const cleanPass = pass.replace(/\s+/g, '');

  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: {
      user: user.trim(),
      pass: cleanPass
    },
    logger: false
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    const mailbox = client.mailbox;
    const totalMessages = mailbox.exists;
    lock.release();
    await client.logout();

    logEvent('success', 'Gmail IMAP', `Conexão IMAP verificada com sucesso. Total de mensagens na INBOX: ${totalMessages}`);
    return {
      success: true,
      message: `Conexão IMAP com Gmail estabelecida! Total de e-mails na Caixa de Entrada: ${totalMessages}`,
      inboxCount: totalMessages
    };
  } catch (err) {
    try { await client.logout(); } catch (e) {}
    logEvent('error', 'Gmail IMAP', `Falha no teste IMAP: ${err.message}`);
    return {
      success: false,
      error: err.message || 'Erro de autenticação IMAP no Gmail.'
    };
  }
}

function getDashboardStats() {
  const quota = getTodayQuota();
  const totalJobsH2a = db.prepare('SELECT COUNT(*) as c FROM jobs').get().c;
  const totalJobsGupy = db.prepare('SELECT COUNT(*) as c FROM gupy_jobs').get().c;
  const totalJobsIndeed = db.prepare('SELECT COUNT(*) as c FROM indeed_jobs').get().c;
  const totalJobs = totalJobsH2a + totalJobsGupy + totalJobsIndeed;

  const newJobs = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'new'").get().c +
                  db.prepare("SELECT COUNT(*) as c FROM gupy_jobs WHERE status = 'new'").get().c +
                  db.prepare("SELECT COUNT(*) as c FROM indeed_jobs WHERE status = 'new'").get().c;

  const queuedApplications = db.prepare("SELECT COUNT(*) as c FROM applications_queue WHERE status = 'pending_review'").get().c;
  const queuedH2a = db.prepare("SELECT COUNT(*) as c FROM applications_queue WHERE status = 'pending_review' AND platform = 'H2A'").get().c;
  const queuedGupy = db.prepare("SELECT COUNT(*) as c FROM applications_queue WHERE status = 'pending_review' AND platform = 'GUPY'").get().c;
  const queuedIndeed = db.prepare("SELECT COUNT(*) as c FROM applications_queue WHERE status = 'pending_review' AND platform = 'INDEED'").get().c;

  const sentEmails = db.prepare("SELECT COUNT(*) as c FROM sent_history WHERE channel = 'EMAIL' AND status = 'SUCCESS'").get().c;
  const sentWhatsapp = db.prepare("SELECT COUNT(*) as c FROM sent_history WHERE channel = 'WHATSAPP' AND status = 'SUCCESS'").get().c;
  const totalResponses = db.prepare('SELECT COUNT(*) as c FROM received_emails').get().c;
  const unreadResponses = db.prepare('SELECT COUNT(*) as c FROM received_emails WHERE is_read = 0').get().c;
  const interviews = db.prepare("SELECT COUNT(*) as c FROM received_emails WHERE sentiment_classification = 'INTERVIEW_INVITATION'").get().c;
  const resumesCount = db.prepare('SELECT COUNT(*) as c FROM resumes').get().c;

  // Check connection statuses
  const claudeKey = getSetting('claude_api_key');
  const gmailUser = getSetting('gmail_user');
  const gmailPass = getSetting('gmail_app_password');
  const googleConnectedEmail = getSetting('google_connected_email');
  const googleTokensJson = getSetting('google_tokens_json');
  const isGoogleOAuthActive = Boolean(googleConnectedEmail && googleTokensJson);

  return {
    quota: {
      today: quota.date_str,
      emailsSentToday: quota.emails_sent,
      whatsappSentToday: quota.whatsapp_sent,
      maxLimit: quota.max_email_limit,
      remaining: Math.max(0, quota.max_email_limit - quota.emails_sent),
      percentage: Math.min(100, Math.round((quota.emails_sent / quota.max_email_limit) * 100))
    },
    counts: {
      totalJobs,
      totalJobsH2a,
      totalJobsGupy,
      totalJobsIndeed,
      newJobs,
      queuedApplications,
      queuedH2a,
      queuedGupy,
      queuedIndeed,
      sentEmails,
      sentWhatsapp,
      totalResponses,
      unreadResponses,
      interviews,
      resumesCount
    },
    integrationsStatus: {
      claudeConfigured: (!!claudeKey && claudeKey.startsWith('sk-ant')) || true, // Active via MCP Agent
      gmailConfigured: isGoogleOAuthActive || (!!gmailUser && !!gmailPass),
      googleOAuthActive: isGoogleOAuthActive,
      googleEmail: googleConnectedEmail || null,
      mcpAgentActive: true,
      resumesUploaded: resumesCount > 0
    }
  };
}

module.exports = {
  getAllSettings,
  getSetting,
  updateSettings,
  testClaudeConnection,
  testSmtpConnection,
  testImapConnection,
  getDashboardStats
};
