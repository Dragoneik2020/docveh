const nodemailer = require('nodemailer');
const { pool } = require('../models/db');

async function getSetting(key) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : null;
}

async function getTransporter() {
  const host = await getSetting('smtp_host') || process.env.SMTP_HOST;
  if (!host) return null;
  const port = parseInt(await getSetting('smtp_port') || process.env.SMTP_PORT || '587');
  const secure = (await getSetting('smtp_secure') || process.env.SMTP_SECURE || 'false') === 'true';
  const user = await getSetting('smtp_user') || process.env.SMTP_USER;
  const pass = await getSetting('smtp_pass') || process.env.SMTP_PASS;
  if (!user || !pass) return null;
  return nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
}

async function sendEmail(to, subject, text) {
  const transporter = await getTransporter();
  if (!transporter) return;
  try {
    const from = await getSetting('smtp_from') || process.env.SMTP_FROM || (await getSetting('smtp_user')) || process.env.SMTP_USER;
    await transporter.sendMail({ from, to, subject, text });
  } catch (err) {
    console.error('  Email error:', err.message);
  }
}

async function sendWhatsApp(to, message) {
  const url = await getSetting('openwa_url') || process.env.OPENWA_URL;
  if (!url) return;
  const token = await getSetting('openwa_token') || process.env.OPENWA_TOKEN;
  try {
    const body = { to, message };
    if (token) body.token = token;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('  OpenWA error:', err.message);
  }
}

async function notifyNewUser(user) {
  const notificationEmail = await getSetting('notification_email');
  const adminPhone = await getSetting('admin_phone');
  const subject = 'Nuevo registro - DocVeh';
  const text = 'Nuevo usuario registrado en DocVeh:\n\nNombre: ' + user.name + '\nEmail: ' + user.email + '\nFecha: ' + new Date().toLocaleString('es-CL');
  if (notificationEmail) await sendEmail(notificationEmail, subject, text);
  if (adminPhone) await sendWhatsApp(adminPhone, text);
}

module.exports = { notifyNewUser };
