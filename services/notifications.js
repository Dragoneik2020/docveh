const nodemailer = require('nodemailer');
const twilio = require('twilio');
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

async function getTwilioClient() {
  const sid = await getSetting('twilio_account_sid') || process.env.TWILIO_ACCOUNT_SID;
  const token = await getSetting('twilio_auth_token') || process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return twilio(sid, token);
}

async function sendWhatsApp(to, message) {
  const client = await getTwilioClient();
  if (!client) return;
  const from = await getSetting('twilio_whatsapp_number') || process.env.TWILIO_WHATSAPP_NUMBER;
  if (!from) return;
  try {
    await client.messages.create({
      from: 'whatsapp:' + from,
      body: message,
      to: 'whatsapp:' + to,
    });
  } catch (err) {
    console.error('  WhatsApp error:', err.message);
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
