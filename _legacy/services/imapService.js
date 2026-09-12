const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { db, logEvent } = require('../config/database');
const { getSetting } = require('./settingsService');
const { classifyIncomingEmail } = require('./claudeService');

let isPolling = false;

function getImapClient() {
  const user = getSetting('gmail_user');
  const pass = getSetting('gmail_app_password');
  const host = getSetting('imap_host', 'imap.gmail.com');
  const port = parseInt(getSetting('imap_port', '993'), 10);
  const secure = getSetting('imap_secure', 'true') === 'true' || port === 993;

  if (!user || !pass) {
    throw new Error('Credenciais do Gmail IMAP não configuradas.');
  }

  const cleanPass = pass.replace(/\s+/g, '');

  return new ImapFlow({
    host,
    port,
    secure,
    auth: {
      user: user.trim(),
      pass: cleanPass
    },
    logger: false
  });
}

async function checkIncomingEmails() {
  if (isPolling) {
    return { success: false, message: 'Verificação de e-mails já em andamento.' };
  }

  const { isOAuthConnected, fetchRecentEmailsViaGmailApi } = require('./gmailOAuthService');

  // 1. Se estiver conectado via Google OAuth 2.0, usa a Gmail REST API
  if (isOAuthConnected()) {
    isPolling = true;
    let processedCount = 0;
    try {
      logEvent('info', 'Gmail API Monitor', 'Buscando respostas recentes via Gmail REST API...');
      const result = await fetchRecentEmailsViaGmailApi();
      if (result.success && result.emails) {
        for (const email of result.emails) {
          const uidStr = `gmail_api_${email.id}`;
          const existing = db.prepare('SELECT id FROM received_emails WHERE message_uid = ?').get(uidStr);
          if (existing) continue;

          const fromEmail = (email.from.match(/<([^>]+)>/) ? email.from.match(/<([^>]+)>/)[1] : email.from).trim();
          const fromName = email.from.replace(/<[^>]+>/, '').trim() || fromEmail;
          const subject = email.subject || '(Sem assunto)';
          const bodyText = email.bodyText || '';

          // Tenta encontrar Job Order # no assunto ou corpo
          const jobOrderMatch = (subject + ' ' + bodyText).match(/JO-[\w-]+|\bH-300-[\w-]+\b|\b[0-9]{8,12}\b/i);
          let jobOrderId = jobOrderMatch ? jobOrderMatch[0] : null;
          let matchedJob = null;

          if (jobOrderId) {
            matchedJob = db.prepare('SELECT * FROM jobs WHERE job_order_id LIKE ?').get(`%${jobOrderId}%`);
          }
          if (!matchedJob && fromEmail) {
            matchedJob = db.prepare('SELECT * FROM jobs WHERE employer_email = ? OR attorney_email = ?').get(fromEmail, fromEmail);
            if (matchedJob) jobOrderId = matchedJob.job_order_id;
          }

          let classificationData = {
            classification: 'OTHER',
            summary: 'Resposta recebida de recrutador.',
            suggestedAction: 'Verificar mensagem.'
          };

          try {
            classificationData = await classifyIncomingEmail(subject, bodyText);
          } catch (e) {}

          db.prepare(`
            INSERT INTO received_emails (
              message_uid, from_email, from_name, subject, body_text, body_html,
              job_order_id, matched_job_id, sentiment_classification, sentiment_summary,
              suggested_action, is_read, received_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
          `).run(
            uidStr,
            fromEmail,
            fromName,
            subject,
            bodyText,
            '',
            jobOrderId,
            matchedJob ? matchedJob.id : null,
            classificationData.classification,
            classificationData.summary,
            classificationData.suggestedAction
          );

          processedCount++;
          logEvent('success', 'Gmail API Monitor', `Nova resposta de ${fromEmail}: [${classificationData.classification}] ${classificationData.summary}`);
        }
      }
      return { success: true, processedCount };
    } catch (err) {
      logEvent('error', 'Gmail API Monitor', `Erro ao verificar e-mails via Gmail API: ${err.message}`);
      return { success: false, error: err.message };
    } finally {
      isPolling = false;
    }
  }

  // 2. Fallback para IMAP tradicional
  const user = getSetting('gmail_user');
  const pass = getSetting('gmail_app_password');
  if (!user || !pass) {
    return { success: false, message: 'Google OAuth2 ou credenciais IMAP não configurados.' };
  }

  isPolling = true;
  const client = getImapClient();
  let processedCount = 0;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      // Busca mensagens recentes
      const messages = client.fetch({ seen: false }, { envelope: true, source: true, uid: true });

      for await (const message of messages) {
        const uidStr = String(message.uid);
        
        // Verifica se já foi processado
        const existing = db.prepare('SELECT id FROM received_emails WHERE message_uid = ?').get(uidStr);
        if (existing) continue;

        const parsed = await simpleParser(message.source);
        const fromEmail = parsed.from?.value[0]?.address || '';
        const fromName = parsed.from?.value[0]?.name || fromEmail;
        const subject = parsed.subject || '(Sem assunto)';
        const bodyText = parsed.text || '';
        const bodyHtml = parsed.html || '';

        // Tenta encontrar Job Order # no assunto ou corpo
        const jobOrderMatch = (subject + ' ' + bodyText).match(/JO-[\w-]+|\b[0-9]{8,12}\b/i);
        let jobOrderId = jobOrderMatch ? jobOrderMatch[0] : null;
        let matchedJob = null;

        if (jobOrderId) {
          matchedJob = db.prepare('SELECT * FROM jobs WHERE job_order_id LIKE ?').get(`%${jobOrderId}%`);
        }

        if (!matchedJob && fromEmail) {
          matchedJob = db.prepare('SELECT * FROM jobs WHERE employer_email = ? OR attorney_email = ?').get(fromEmail, fromEmail);
          if (matchedJob) {
            jobOrderId = matchedJob.job_order_id;
          }
        }

        // Análise de sentimento com Claude
        let classificationData = {
          classification: 'OTHER',
          summary: 'Resposta recebida.',
          suggestedAction: 'Verificar mensagem.'
        };

        try {
          classificationData = await classifyIncomingEmail(subject, bodyText);
          if (!jobOrderId && classificationData.jobOrderId) {
            jobOrderId = classificationData.jobOrderId;
          }
        } catch (cErr) {
          console.error('Error classifying email with Claude:', cErr);
        }

        // Salva no banco
        db.prepare(`
          INSERT INTO received_emails (
            message_uid, from_email, from_name, subject, body_text, body_html,
            job_order_id, matched_job_id, sentiment_classification, sentiment_summary,
            suggested_action, is_read, received_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
        `).run(
          uidStr,
          fromEmail,
          fromName,
          subject,
          bodyText,
          bodyHtml,
          jobOrderId,
          matchedJob ? matchedJob.id : null,
          classificationData.classification,
          classificationData.summary,
          classificationData.suggestedAction
        );

        processedCount++;
        logEvent('success', 'IMAP Monitor', `Nova resposta classificada de ${fromEmail}: [${classificationData.classification}] ${classificationData.summary}`);
      }
    } finally {
      lock.release();
    }

    await client.logout();
    return { success: true, processedCount };
  } catch (err) {
    try { await client.logout(); } catch (e) {}
    logEvent('error', 'IMAP Monitor', `Erro ao verificar e-mails IMAP: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    isPolling = false;
  }
}

function getInboxList(options = {}) {
  const { filterClassification = '', unreadOnly = false, limit = 50 } = options;
  let query = 'SELECT * FROM received_emails WHERE 1=1';
  const params = [];

  if (filterClassification) {
    query += ' AND sentiment_classification = ?';
    params.push(filterClassification);
  }

  if (unreadOnly) {
    query += ' AND is_read = 0';
  }

  query += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);

  return db.prepare(query).all(...params);
}

function markEmailAsRead(id) {
  db.prepare('UPDATE received_emails SET is_read = 1 WHERE id = ?').run(id);
  return { success: true };
}

function getJobsNeedingFollowUp(daysThreshold = 5) {
  // Vagas que foram enviadas há mais de X dias e não tiveram respostas registradas
  const cutoffDate = new Date(Date.now() - daysThreshold * 24 * 60 * 60 * 1000).toISOString();
  
  return db.prepare(`
    SELECT DISTINCT j.*, s.sent_at, s.recipient, s.subject
    FROM jobs j
    JOIN sent_history s ON j.id = s.job_id
    LEFT JOIN received_emails r ON j.job_order_id = r.job_order_id OR j.id = r.matched_job_id
    WHERE j.status = 'sent' 
      AND s.channel = 'EMAIL'
      AND s.status = 'SUCCESS'
      AND s.sent_at <= ?
      AND r.id IS NULL
    ORDER BY s.sent_at ASC
  `).all(cutoffDate);
}

module.exports = {
  checkIncomingEmails,
  getInboxList,
  markEmailAsRead,
  getJobsNeedingFollowUp
};
