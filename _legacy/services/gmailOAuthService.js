const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { db, logEvent } = require('../config/database');
const { getSetting, updateSettings } = require('./settingsService');

const REDIRECT_URI = 'http://localhost:3000/api/auth/google/callback';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email'
];

function getOAuth2Client() {
  const clientId = getSetting('google_client_id');
  const clientSecret = getSetting('google_client_secret');

  if (!clientId || !clientSecret) {
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(
    clientId.trim(),
    clientSecret.trim(),
    REDIRECT_URI
  );

  const tokensJson = getSetting('google_tokens_json');
  if (tokensJson) {
    try {
      const tokens = JSON.parse(tokensJson);
      oauth2Client.setCredentials(tokens);

      oauth2Client.on('tokens', (newTokens) => {
        const currentTokens = JSON.parse(getSetting('google_tokens_json') || '{}');
        const merged = { ...currentTokens, ...newTokens };
        updateSettings({ google_tokens_json: JSON.stringify(merged) });
        logEvent('info', 'Google OAuth2', 'Tokens de acesso do Google renovados automaticamente');
      });
    } catch (e) {
      console.error('Error parsing stored google tokens:', e);
    }
  }

  return oauth2Client;
}

function generateAuthUrl() {
  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) {
    throw new Error('Client ID e Client Secret do Google Cloud não configurados.');
  }

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });
}

async function handleCallback(code) {
  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) {
    throw new Error('Configuração OAuth2 do Google não encontrada.');
  }

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  // Obtém o e-mail do usuário autenticado
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const userInfo = await oauth2.userinfo.get();
  const userEmail = userInfo.data.email;

  updateSettings({
    google_tokens_json: JSON.stringify(tokens),
    google_connected_email: userEmail,
    gmail_user: userEmail
  });

  logEvent('success', 'Google OAuth2', `Conta Google autenticada com sucesso: ${userEmail}`);

  return {
    success: true,
    email: userEmail,
    message: `Autenticado com sucesso como ${userEmail}`
  };
}

function getAuthStatus() {
  const clientId = getSetting('google_client_id');
  const clientSecret = getSetting('google_client_secret');
  const connectedEmail = getSetting('google_connected_email');
  const tokensJson = getSetting('google_tokens_json');

  const hasCredentials = Boolean(clientId && clientSecret);
  const isConnected = Boolean(hasCredentials && connectedEmail && tokensJson);

  return {
    hasCredentials,
    isConnected,
    connectedEmail: isConnected ? connectedEmail : null,
    clientIdConfigured: hasCredentials ? `${clientId.substring(0, 12)}...` : null
  };
}

async function disconnect() {
  const oauth2Client = getOAuth2Client();
  if (oauth2Client) {
    try {
      const tokensJson = getSetting('google_tokens_json');
      if (tokensJson) {
        const tokens = JSON.parse(tokensJson);
        if (tokens.access_token) {
          await oauth2Client.revokeToken(tokens.access_token);
        }
      }
    } catch (e) {}
  }

  updateSettings({
    google_tokens_json: '',
    google_connected_email: ''
  });

  logEvent('info', 'Google OAuth2', 'Conta Google desconectada.');
  return { success: true, message: 'Conta Google desconectada com sucesso.' };
}

function parseCredentialsJson(jsonContent) {
  try {
    const parsed = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;
    const clientData = parsed.web || parsed.installed;
    if (!clientData || !clientData.client_id || !clientData.client_secret) {
      throw new Error('Arquivo credentials.json inválido. Verifique se é do tipo Aplicativo da Web ou Desktop.');
    }

    updateSettings({
      google_client_id: clientData.client_id,
      google_client_secret: clientData.client_secret
    });

    logEvent('success', 'Google OAuth2', 'Credenciais do Google Cloud importadas com sucesso.');
    return {
      success: true,
      clientId: clientData.client_id,
      message: 'Credenciais importadas com sucesso!'
    };
  } catch (err) {
    throw new Error(`Falha ao ler credentials.json: ${err.message}`);
  }
}

/**
 * Cria e envia mensagem MIME RFC 2822 via Gmail API oficial com anexo PDF
 */
async function sendEmailViaGmailApi(options) {
  const { to, subject, text, attachmentPath, attachmentName, jobOrderId } = options;
  const oauth2Client = getOAuth2Client();

  if (!oauth2Client) {
    throw new Error('Google OAuth2 não configurado.');
  }

  const senderEmail = getSetting('google_connected_email') || getSetting('gmail_user');
  const candidate = db.prepare('SELECT full_name FROM candidate_profile ORDER BY id DESC LIMIT 1').get() || {};
  const senderName = candidate.full_name || 'Candidato H-2A / H-2B';

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const boundary = `__boundary_${Date.now()}__`;

  let mimeLines = [
    `From: "${senderName}" <${senderEmail}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    `X-DOL-Job-Order: ${jobOrderId || ''}`,
    `X-Application-Channel: H2A-SeasonalJobs-Direct`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 8bit`,
    '',
    text,
    ''
  ];

  // Adiciona anexo PDF se existir
  if (attachmentPath && fs.existsSync(attachmentPath)) {
    const fileBuffer = fs.readFileSync(attachmentPath);
    const base64File = fileBuffer.toString('base64');
    const safeFilename = attachmentName || path.basename(attachmentPath);

    mimeLines.push(
      `--${boundary}`,
      `Content-Type: application/pdf; name="${safeFilename}"`,
      `Content-Disposition: attachment; filename="${safeFilename}"`,
      `Content-Transfer-Encoding: base64`,
      '',
      base64File,
      ''
    );
  }

  mimeLines.push(`--${boundary}--`);

  const rawMime = mimeLines.join('\r\n');
  const encodedMessage = Buffer.from(rawMime)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedMessage
    }
  });

  return {
    success: true,
    messageId: response.data.id,
    threadId: response.data.threadId
  };
}

/**
 * Consulta mensagens recentes e respostas de recrutadores via Gmail REST API
 */
async function fetchRecentEmailsViaGmailApi() {
  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) {
    return { success: false, error: 'Google OAuth2 não conectado.' };
  }

  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  try {
    // Busca mensagens não lidas
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 20
    });

    const messages = listRes.data.messages || [];
    const parsedEmails = [];

    for (const msg of messages) {
      const msgRes = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full'
      });

      const payload = msgRes.data.payload;
      const headers = payload.headers || [];

      const getHeader = (name) => {
        const h = headers.find(header => header.name.toLowerCase() === name.toLowerCase());
        return h ? h.value : '';
      };

      const from = getHeader('From');
      const subject = getHeader('Subject');
      const date = getHeader('Date');

      // Extrai corpo do e-mail
      let bodyText = '';
      if (payload.body && payload.body.data) {
        bodyText = Buffer.from(payload.body.data, 'base64').toString('utf-8');
      } else if (payload.parts) {
        for (const part of payload.parts) {
          if (part.mimeType === 'text/plain' && part.body && part.body.data) {
            bodyText += Buffer.from(part.body.data, 'base64').toString('utf-8');
          }
        }
      }

      parsedEmails.push({
        id: msg.id,
        from,
        subject,
        date,
        bodyText
      });
    }

    return {
      success: true,
      emails: parsedEmails
    };
  } catch (err) {
    console.error('Error fetching emails via Gmail API:', err);
    return { success: false, error: err.message };
  }
}

module.exports = {
  getOAuth2Client,
  generateAuthUrl,
  handleCallback,
  getAuthStatus,
  disconnect,
  parseCredentialsJson,
  sendEmailViaGmailApi,
  fetchRecentEmailsViaGmailApi,
  isOAuthConnected: () => getAuthStatus().isConnected
};
