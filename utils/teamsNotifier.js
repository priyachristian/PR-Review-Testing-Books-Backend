const axios = require('axios');
const config = require('../config/config');

const buildTeamsAlert = ({ title, errorLogId = '-', service, controller, method = '-', url = '-', message, status = 500 }) => ({
  title,
  errorLogId: errorLogId || '-',
  environment: process.env.NODE_ENV || '-',
  service: service || '-',
  controller: controller || '-',
  method: method || '-',
  url: url || '-',
  message: String(message || '-')
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, "'"),
  status,
  time: new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
  }),
});

const sendTeamsAlert = async message => {
  // if (!process.env.TEAMS_WEBHOOK_URL) return;
  // if (process.env.NODE_ENV !== 'production') return;

  try {
    await axios.post(config.teams_webhook_url, message);
  } catch (err) {
    console.error('Teams notification failed');
  }
};

module.exports = { buildTeamsAlert, sendTeamsAlert };
