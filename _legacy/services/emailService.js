const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const { db, logEvent, getTodayQuota, incrementEmailQuota, incrementWhatsappQuota } = require('../config/database');
const { getSetting } = require('./settingsService');
let whatsappService = null;
try {
  whatsappService = require('./whatsappService');
} catch (e) {}

let isQueueProcessing = false;

function getTransporter() {
  const user = getSetting('gmail_user');
  const pass = getSetting('gmail_app_password');
  const host = getSetting('smtp_host', 'smtp.gmail.com');
  const port = parseInt(getSetting('smtp_port', '465'), 10);
  const secure = getSetting('smtp_secure', 'true') === 'true' || port === 465;

  if (!user || !pass) {
    throw new Error('Credenciais do Gmail (usuário ou senha de aplicativo) não configuradas no painel.');
  }

  const cleanPass = pass.replace(/\s+/g, '');

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: user.trim(),
      pass: cleanPass
    }
  });
}

function getRandomJitterDelay(minSec = 60, maxSec = 180) {
  const min = parseInt(getSetting('delay_min_seconds', String(minSec)), 10);
  const max = parseInt(getSetting('delay_max_seconds', String(maxSec)), 10);
  const randomSec = Math.floor(Math.random() * (max - min + 1)) + min;
  return randomSec * 1000;
}

async function sendSingleApplication(queueId) {
  const queueItem = db.prepare(`
    SELECT q.*, j.job_order_id, j.job_title, j.employer_name, j.employer_city, j.employer_state,
           r.file_path as resume_file_path, r.original_name as resume_original_name
    FROM applications_queue q
    JOIN jobs j ON q.job_id = j.id
    LEFT JOIN resumes r ON q.resume_id = r.id
    WHERE q.id = ?
  `).get(queueId);

  if (!queueItem) {
    throw new Error(`Candidatura #${queueId} não encontrada na fila.`);
  }

  // 1. Verificação rígida de cota diária
  const quota = getTodayQuota();
  if (quota.emails_sent >= quota.max_email_limit) {
    logEvent('warn', 'Anti-Spam', `Envio bloqueado: Cota máxima diária atingida (${quota.emails_sent}/${quota.max_email_limit}). Próximos envios serão retomados amanhã.`);
    throw new Error(`Limite diário de segurança de ${quota.max_email_limit} e-mails atingido. Operação pausada para proteção da sua conta.`);
  }

  if (!queueItem.recipient_email) {
    throw new Error(`Candidatura #${queueId} não possui e-mail de destinatário válido.`);
  }

  const { isOAuthConnected, sendEmailViaGmailApi } = require('./gmailOAuthService');
  const gmailUser = getSetting('google_connected_email') || getSetting('gmail_user');
  const candidate = db.prepare('SELECT * FROM candidate_profile ORDER BY id DESC LIMIT 1').get() || {};

  let attachedResumeName = null;
  if (queueItem.resume_file_path && fs.existsSync(queueItem.resume_file_path)) {
    attachedResumeName = queueItem.resume_original_name || 'Resume_US_Format.pdf';
  }

  logEvent('info', 'Email Engine', `Enviando e-mail para ${queueItem.recipient_email} (Job Order #${queueItem.job_order_id})...`);

  try {
    let messageId = null;

    if (isOAuthConnected()) {
      // 1. Envio seguro via Google OAuth 2.0 / Gmail REST API
      const apiResult = await sendEmailViaGmailApi({
        to: queueItem.recipient_email,
        subject: queueItem.email_subject,
        text: queueItem.email_body,
        attachmentPath: queueItem.resume_file_path,
        attachmentName: attachedResumeName,
        jobOrderId: queueItem.job_order_id
      });
      messageId = apiResult.messageId;
      logEvent('success', 'Google OAuth2 API', `E-mail enviado via Gmail REST API [ID: ${messageId}]`);
    } else {
      // 2. Fallback via SMTP tradicional se configurado
      const transporter = getTransporter();
      const attachments = [];
      if (queueItem.resume_file_path && fs.existsSync(queueItem.resume_file_path)) {
        attachments.push({
          filename: attachedResumeName,
          path: queueItem.resume_file_path,
          contentType: 'application/pdf'
        });
      }

      const mailOptions = {
        from: `"${candidate.full_name || 'Candidate'}" <${gmailUser}>`,
        to: queueItem.recipient_email,
        subject: queueItem.email_subject,
        text: queueItem.email_body,
        attachments: attachments,
        headers: {
          'X-DOL-Job-Order': queueItem.job_order_id,
          'X-Application-Channel': 'H2A-SeasonalJobs-Direct'
        }
      };

      const info = await transporter.sendMail(mailOptions);
      messageId = info.messageId;
      logEvent('success', 'Email Engine', `E-mail enviado via SMTP para ${queueItem.recipient_email} [MessageID: ${messageId}]`);
    }
    
    // Atualiza cota
    incrementEmailQuota();

    // Registra no histórico
    db.prepare(`
      INSERT INTO sent_history (
        application_id, job_id, job_order_id, employer_name, channel, recipient,
        subject, content_sent, attached_resume_name, status, sent_at
      ) VALUES (?, ?, ?, ?, 'EMAIL', ?, ?, ?, ?, 'SUCCESS', CURRENT_TIMESTAMP)
    `).run(
      queueItem.id,
      queueItem.job_id,
      queueItem.job_order_id,
      queueItem.employer_name,
      queueItem.recipient_email,
      queueItem.email_subject,
      queueItem.email_body,
      attachedResumeName
    );

    // Atualiza fila
    db.prepare("UPDATE applications_queue SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?").run(queueItem.id);
    db.prepare("UPDATE jobs SET status = 'sent' WHERE id = ?").run(queueItem.job_id);

    logEvent('success', 'Email Engine', `E-mail enviado com sucesso para ${queueItem.recipient_email} [MessageID: ${info.messageId}]`);

    // 2. Disparo duplo de WhatsApp se habilitado e houver telefone
    let whatsappResult = null;
    const whatsappEnabled = getSetting('whatsapp_enabled', 'true') === 'true';

    if (whatsappEnabled && queueItem.recipient_phone && queueItem.whatsapp_message) {
      try {
        if (!whatsappService) whatsappService = require('./whatsappService');
        if (whatsappService && whatsappService.isClientReady()) {
          logEvent('info', 'WhatsApp', `Disparando mensagem de apresentação para o empregador no WhatsApp (${queueItem.recipient_phone})...`);
          whatsappResult = await whatsappService.sendTextMessage(queueItem.recipient_phone, queueItem.whatsapp_message);
          
          incrementWhatsappQuota();

          db.prepare(`
            INSERT INTO sent_history (
              application_id, job_id, job_order_id, employer_name, channel, recipient,
              subject, content_sent, status, sent_at
            ) VALUES (?, ?, ?, ?, 'WHATSAPP', ?, 'WhatsApp Outreach Message', ?, 'SUCCESS', CURRENT_TIMESTAMP)
          `).run(
            queueItem.id,
            queueItem.job_id,
            queueItem.job_order_id,
            queueItem.employer_name,
            queueItem.recipient_phone,
            queueItem.whatsapp_message
          );
          logEvent('success', 'WhatsApp', `Mensagem WhatsApp entregue ao empregador (${queueItem.recipient_phone})`);
        }
      } catch (wppErr) {
        logEvent('warn', 'WhatsApp', `Não foi possível enviar WhatsApp para ${queueItem.recipient_phone}: ${wppErr.message}`);
      }
    }

    return {
      success: true,
      messageId: info.messageId,
      emailSentTo: queueItem.recipient_email,
      whatsappSent: Boolean(whatsappResult)
    };
  } catch (err) {
    db.prepare(`
      INSERT INTO sent_history (
        application_id, job_id, job_order_id, employer_name, channel, recipient,
        subject, content_sent, status, error_message, sent_at
      ) VALUES (?, ?, ?, ?, 'EMAIL', ?, ?, ?, 'FAILED', ?, CURRENT_TIMESTAMP)
    `).run(
      queueItem.id,
      queueItem.job_id,
      queueItem.job_order_id,
      queueItem.employer_name,
      queueItem.recipient_email,
      queueItem.email_subject,
      queueItem.email_body,
      err.message
    );

    db.prepare("UPDATE applications_queue SET status = 'failed', error_message = ? WHERE id = ?").run(err.message, queueItem.id);
    logEvent('error', 'Email Engine', `Falha no envio para ${queueItem.recipient_email}: ${err.message}`);
    throw err;
  }
}

async function processApprovedQueueBatch(limit = null) {
  if (isQueueProcessing) {
    return { success: false, message: 'Processamento de fila já está em execução.' };
  }

  isQueueProcessing = true;
  const quota = getTodayQuota();
  const remainingQuota = Math.max(0, quota.max_email_limit - quota.emails_sent);

  if (remainingQuota <= 0) {
    isQueueProcessing = false;
    return {
      success: false,
      message: `Cota diária esgotada (${quota.emails_sent}/${quota.max_email_limit}). Não é possível enviar mais e-mails hoje.`
    };
  }

  const batchSize = limit ? Math.min(limit, remainingQuota) : remainingQuota;
  const approvedItems = db.prepare(`
    SELECT id FROM applications_queue 
    WHERE status = 'approved' OR status = 'pending_review'
    ORDER BY id ASC 
    LIMIT ?
  `).all(batchSize);

  if (approvedItems.length === 0) {
    isQueueProcessing = false;
    return { success: true, message: 'Nenhuma candidatura pendente na fila.', processed: 0 };
  }

  logEvent('info', 'Batch Sender', `Iniciando envio em lote de ${approvedItems.length} candidaturas com intervalos anti-spam...`);

  let successCount = 0;
  let errorCount = 0;

  // Processa itens com atraso entre eles
  (async () => {
    try {
      for (let i = 0; i < approvedItems.length; i++) {
        const item = approvedItems[i];
        try {
          await sendSingleApplication(item.id);
          successCount++;
        } catch (e) {
          errorCount++;
        }

        // Se não for o último, aguarda jitter delay anti-spam
        if (i < approvedItems.length - 1) {
          const delayMs = getRandomJitterDelay();
          logEvent('info', 'Anti-Spam Jitter', `Aguardando ${(delayMs / 1000).toFixed(0)} segundos antes do próximo envio...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    } finally {
      isQueueProcessing = false;
      logEvent('success', 'Batch Sender', `Lote finalizado: ${successCount} enviados com sucesso, ${errorCount} erros.`);
    }
  })();

  return {
    success: true,
    message: `Envio em lote iniciado para ${approvedItems.length} candidaturas em segundo plano com delay anti-spam.`,
    count: approvedItems.length
  };
}

module.exports = {
  sendSingleApplication,
  processApprovedQueueBatch,
  getTransporter,
  isQueueProcessing: () => isQueueProcessing
};
