const nodemailer = require('nodemailer');
const twilio = require('twilio');
const { pool } = require('../models/db');

function getTransporter() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendEmail(to, subject, text) {
  const transporter = getTransporter();
  if (!transporter) return;
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
    });
  } catch (err) {
    console.error('  Email error:', err.message);
  }
}

function getTwilioClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null;
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

async function sendWhatsApp(to, message) {
  const client = getTwilioClient();
  if (!client) return;
  const from = process.env.TWILIO_WHATSAPP_NUMBER;
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
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'notification_email'");
  const notificationEmail = rows.length ? rows[0].value : null;
  const { rows: phoneRows } = await pool.query("SELECT value FROM settings WHERE key = 'admin_phone'");
  const adminPhone = phoneRows.length ? phoneRows[0].value : null;

  const subject = 'Nuevo registro - DocVeh';
  const text = 'Nuevo usuario registrado en DocVeh:\n\nNombre: ' + user.name + '\nEmail: ' + user.email + '\nFecha: ' + new Date().toLocaleString('es-CL');

  if (notificationEmail) {
    await sendEmail(notificationEmail, subject, text);
  }
  if (adminPhone) {
    await sendWhatsApp(adminPhone, text);
  }
}

module.exports = { notifyNewUser };
