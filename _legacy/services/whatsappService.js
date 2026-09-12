const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { logEvent } = require('../config/database');

const authDir = path.join(__dirname, '..', 'config', 'whatsapp_auth');
if (!fs.existsSync(authDir)) {
  fs.mkdirSync(authDir, { recursive: true });
}

let sock = null;
let currentQrCode = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
let connectedUser = null;
let statusListeners = [];

function registerStatusListener(fn) {
  statusListeners.push(fn);
}

function unregisterStatusListener(fn) {
  statusListeners = statusListeners.filter(l => l !== fn);
}

function notifyListeners(data) {
  for (const listener of statusListeners) {
    try { listener(data); } catch (e) {}
  }
}

async function initWhatsApp(forceNew = false) {
  if (forceNew) {
    try {
      if (sock) {
        sock.end(new Error('Force re-initialization'));
        sock = null;
      }
      fs.rmSync(authDir, { recursive: true, force: true });
      fs.mkdirSync(authDir, { recursive: true });
    } catch (e) {
      console.error('Error clearing whatsapp auth:', e);
    }
  }

  connectionStatus = 'connecting';
  currentQrCode = null;
  notifyListeners({ status: connectionStatus, qrCode: null });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['Antigravity H2A System', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionStatus = 'qr_ready';
        try {
          currentQrCode = await QRCode.toDataURL(qr, {
            errorCorrectionLevel: 'M',
            margin: 2,
            scale: 6
          });
          logEvent('info', 'WhatsApp', 'Novo QR Code gerado para conexão');
          notifyListeners({ status: 'qr_ready', qrCode: currentQrCode });
        } catch (qrErr) {
          console.error('Error generating QR DataURL:', qrErr);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        connectionStatus = 'disconnected';
        currentQrCode = null;
        connectedUser = null;
        logEvent('warn', 'WhatsApp', `Conexão WhatsApp encerrada (Status: ${statusCode}). Reconectando: ${shouldReconnect}`);
        notifyListeners({ status: 'disconnected', qrCode: null });

        if (shouldReconnect) {
          setTimeout(() => initWhatsApp(false), 5000);
        }
      } else if (connection === 'open') {
        connectionStatus = 'connected';
        currentQrCode = null;
        connectedUser = sock.user?.id ? sock.user.id.split(':')[0] : 'Conectado';
        logEvent('success', 'WhatsApp', `WhatsApp conectado com sucesso como +${connectedUser}!`);
        notifyListeners({ status: 'connected', qrCode: null, phone: connectedUser });
      }
    });

    return { success: true, message: 'Inicialização do WhatsApp iniciada.' };
  } catch (err) {
    connectionStatus = 'disconnected';
    logEvent('error', 'WhatsApp', `Erro ao inicializar WhatsApp: ${err.message}`);
    return { success: false, error: err.message };
  }
}

function getStatus() {
  return {
    status: connectionStatus,
    qrCode: currentQrCode,
    userPhone: connectedUser,
    isReady: connectionStatus === 'connected' && sock !== null
  };
}

function formatToWhatsAppJid(phoneNumber) {
  if (!phoneNumber) return null;
  // Remove all non-digits
  let cleaned = String(phoneNumber).replace(/\D/g, '');
  
  // Se for número dos EUA com 10 dígitos (sem código de país), adiciona o 1
  if (cleaned.length === 10) {
    cleaned = '1' + cleaned;
  }
  
  // Se for número do Brasil com DDD de 10 ou 11 dígitos, adiciona o 55
  if (cleaned.length === 10 || cleaned.length === 11) {
    if (!cleaned.startsWith('1') && !cleaned.startsWith('55')) {
      cleaned = '55' + cleaned;
    }
  }

  return `${cleaned}@s.whatsapp.net`;
}

async function sendTextMessage(targetPhone, messageText) {
  if (connectionStatus !== 'connected' || !sock) {
    throw new Error('WhatsApp não está conectado. Escaneie o QR Code na aba de Integrações.');
  }

  const jid = formatToWhatsAppJid(targetPhone);
  if (!jid) {
    throw new Error(`Número de telefone inválido: ${targetPhone}`);
  }

  logEvent('info', 'WhatsApp', `Enviando mensagem WhatsApp para ${jid}...`);

  const response = await sock.sendMessage(jid, {
    text: messageText
  });

  return {
    success: true,
    messageId: response.key.id,
    targetJid: jid
  };
}

async function disconnectWhatsApp() {
  if (sock) {
    try {
      await sock.logout();
    } catch (e) {}
    sock = null;
  }
  connectionStatus = 'disconnected';
  currentQrCode = null;
  connectedUser = null;
  notifyListeners({ status: 'disconnected', qrCode: null });
  logEvent('info', 'WhatsApp', 'WhatsApp desconectado manualmente');
  return { success: true };
}

module.exports = {
  initWhatsApp,
  getStatus,
  sendTextMessage,
  disconnectWhatsApp,
  registerStatusListener,
  unregisterStatusListener,
  isClientReady: () => connectionStatus === 'connected' && sock !== null
};
