const cron = require('node-cron');
const { logEvent, getTodayQuota } = require('../config/database');
const { getSetting } = require('./settingsService');
const { fetchSeasonalJobsDol } = require('./dolService');
const { checkIncomingEmails } = require('./imapService');

let dolCronJob = null;
let imapCronJob = null;
let midnightCronJob = null;

function initScheduler() {
  logEvent('info', 'Scheduler', 'Inicializando agendador de tarefas em segundo plano...');

  // 1. Reset diário de cota à meia-noite (00:00)
  midnightCronJob = cron.schedule('0 0 * * *', () => {
    try {
      const quota = getTodayQuota();
      logEvent('info', 'Anti-Spam', `Novo dia iniciado (${quota.date_str}). Cota diária renovada para ${quota.max_email_limit} envios.`);
    } catch (e) {
      console.error('Error resetting midnight quota:', e);
    }
  });

  // 2. Monitoramento de E-mails IMAP a cada 5 minutos
  imapCronJob = cron.schedule('*/5 * * * *', async () => {
    try {
      const user = getSetting('gmail_user');
      const pass = getSetting('gmail_app_password');
      if (user && pass) {
        await checkIncomingEmails();
      }
    } catch (e) {
      console.error('Error in IMAP cron task:', e);
    }
  });

  // 3. Varredura Periódica de Vagas DOL
  setupDolCron();

  logEvent('success', 'Scheduler', 'Tarefas agendadas ativadas: IMAP (5m), Cota Diária (00:00), DOL Periódico.');
}

function setupDolCron() {
  if (dolCronJob) {
    dolCronJob.stop();
  }

  const autoScrape = getSetting('dol_auto_scrape', 'true') === 'true';
  const intervalMinutes = parseInt(getSetting('dol_scrape_interval_minutes', '60'), 10) || 60;

  if (autoScrape) {
    // Agenda com base no intervalo
    const cronExp = intervalMinutes >= 60 ? `0 */${Math.floor(intervalMinutes / 60)} * * *` : `*/${intervalMinutes} * * * *`;
    
    dolCronJob = cron.schedule(cronExp, async () => {
      try {
        logEvent('info', 'Scheduler', 'Iniciando varredura automática periódica do SeasonalJobs DOL...');
        await fetchSeasonalJobsDol();
      } catch (e) {
        console.error('Error in DOL cron task:', e);
      }
    });
  }
}

module.exports = {
  initScheduler,
  setupDolCron
};
