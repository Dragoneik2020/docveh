const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../models/db');
const settings = require('../models/settings');
const adminAuth = require('../middleware/admin');
const activity = require('../models/activity');
const backup = require('../services/backup');
const { notifyNewUser } = require('../services/notifications');
const router = express.Router();

const logoUpload = multer({ dest: path.join(__dirname, '..', 'tmp') }).single('logo_file');

router.get('/admin', adminAuth, async (req, res) => {
  try {
    const users = await db.all('SELECT u.id, u.name, u.email, u.role, u.created_at, p.name as plan_name FROM users u LEFT JOIN plans p ON u.plan_id = p.id ORDER BY u.created_at DESC');
    const vehicleResult = await db.get('SELECT COUNT(*)::int as count FROM vehicles');
    const docResult = await db.get('SELECT COUNT(*)::int as count FROM documents');
    const nfcResult = await db.get('SELECT COUNT(*)::int as count FROM nfc_links');
    const logResult = await db.get('SELECT COUNT(*)::int as count FROM activity_log');
    const pendingResult = await db.get("SELECT COUNT(*)::int as count FROM payments WHERE status = $1 OR status = $2", ['pending', 'pending_flow']);
    res.render('admin', { users, vehicleCount: vehicleResult.count, docCount: docResult.count, nfcCount: nfcResult.count, logCount: logResult.count, pendingPayments: pendingResult.count, userName: req.session.userName, currentUserId: req.session.userId });
  } catch (err) {
    res.redirect('/dashboard');
  }
});

router.post('/admin/user/:id/toggle-role', adminAuth, async (req, res) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.redirect('/admin');
    const newRole = user.role === 'admin' ? 'user' : 'admin';
    await db.run('UPDATE users SET role = $1 WHERE id = $2', [newRole, req.params.id]);
    await activity.log(req.session.userId, 'ADMIN_TOGGLE_ROLE', `Rol de ${user.name} cambiado a ${newRole}`, { ip: req.ip });
    res.redirect('/admin');
  } catch (err) {
    res.redirect('/admin');
  }
});

router.post('/admin/user/:id/delete', adminAuth, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.session.userId) {
      return res.redirect('/admin');
    }
    const docs = await db.all('SELECT d.filename, v.user_id FROM documents d JOIN vehicles v ON d.vehicle_id = v.id WHERE v.user_id = $1', [req.params.id]);
    docs.forEach(d => {
      try { fs.unlinkSync(path.join(__dirname, '..', 'public', 'uploads', String(d.user_id), d.filename)); } catch (e) { }
    });
    const userDir = path.join(__dirname, '..', 'public', 'uploads', String(req.params.id));
    try { fs.rmdirSync(userDir, { recursive: true }); } catch (e) { }
    await db.run('DELETE FROM users WHERE id = $1', [req.params.id]);
    await activity.log(req.session.userId, 'ADMIN_DELETE_USER', `Usuario ID ${req.params.id} eliminado por administrador`, { ip: req.ip });
    res.redirect('/admin');
  } catch (err) {
    res.redirect('/admin');
  }
});

router.get('/admin/payments', adminAuth, async (req, res) => {
  try {
    const payments = await db.all(
      `SELECT pay.*, u.name as user_name, p.name as plan_name FROM payments pay
       JOIN users u ON pay.user_id = u.id
       JOIN plans p ON pay.plan_id = p.id
       ORDER BY pay.created_at DESC`
    );
    res.render('admin-payments', { payments, userName: req.session.userName, currentUserId: req.session.userId });
  } catch (err) {
    res.redirect('/admin');
  }
});

router.post('/admin/payment/:id/confirm', adminAuth, async (req, res) => {
  try {
    const payment = await db.get('SELECT pay.*, p.name as plan_name FROM payments pay JOIN plans p ON pay.plan_id = p.id WHERE pay.id = $1', [req.params.id]);
    if (!payment) return res.redirect('/admin/payments');
    if (payment.status !== 'pending') return res.redirect('/admin/payments');

    const now = new Date().toISOString();
    await db.run('UPDATE payments SET status = $1, confirmed_at = $2 WHERE id = $3', ['confirmed', now, payment.id]);
    await db.run('UPDATE users SET plan_id = $1 WHERE id = $2', [payment.plan_id, payment.user_id]);
    await activity.log(req.session.userId, 'PAYMENT_CONFIRMED', 'Pago verificado: ' + payment.reference + ' - Plan ' + payment.plan_name + ' para usuario ID ' + payment.user_id, { ip: req.ip });

    const end = new Date();
    end.setFullYear(end.getFullYear() + 1);
    await db.run('INSERT INTO subscriptions (user_id, plan_id, status, expires_at, source) VALUES ($1, $2, $3, $4, $5)',
      [payment.user_id, payment.plan_id, 'active', end.toISOString(), 'manual']);

    res.redirect('/admin/payments');
  } catch (err) {
    res.redirect('/admin/payments');
  }
});

router.post('/admin/payment/:id/delete', adminAuth, async (req, res) => {
  try {
    const payment = await db.get('SELECT * FROM payments WHERE id = $1', [req.params.id]);
    if (!payment) return res.redirect('/admin/payments');
    await db.run('DELETE FROM payments WHERE id = $1', [req.params.id]);
    await activity.log(req.session.userId, 'PAYMENT_DELETED', 'Pago eliminado: ' + payment.reference + ' (ID: ' + payment.id + ')', { ip: req.ip });
    res.redirect('/admin/payments');
  } catch (err) {
    res.redirect('/admin/payments');
  }
});

router.post('/admin/payment/:id/reject', adminAuth, async (req, res) => {
  try {
    const payment = await db.get('SELECT * FROM payments WHERE id = $1', [req.params.id]);
    if (!payment || payment.status !== 'pending') return res.redirect('/admin/payments');
    await db.run('UPDATE payments SET status = $1 WHERE id = $2', ['rejected', payment.id]);
    await activity.log(req.session.userId, 'PAYMENT_REJECTED', 'Pago rechazado: ' + payment.reference, { ip: req.ip });
    res.redirect('/admin/payments');
  } catch (err) {
    res.redirect('/admin/payments');
  }
});

router.get('/admin/backups', adminAuth, (req, res) => {
  const backups = backup.listBackups();
  res.render('admin-backups', { backups, message: req.query.msg || null, userName: req.session.userName, currentUserId: req.session.userId });
});

router.post('/admin/backups/create', adminAuth, async (req, res) => {
  const file = await backup.createBackup();
  if (file) {
    await activity.log(req.session.userId, 'BACKUP_CREATED', 'Backup manual creado: ' + path.basename(file), { ip: req.ip });
    res.redirect('/admin/backups?msg=Backup creado: ' + path.basename(file));
  } else {
    res.redirect('/admin/backups?msg=Error al crear backup');
  }
});

router.get('/admin/users', adminAuth, async (req, res) => {
  try {
    const users = await db.all(
      `SELECT u.id, u.name, u.email, u.role, u.created_at, p.name as plan_name, p.price as plan_price,
              s.source as sub_source, s.expires_at as sub_expires_at, s.status as sub_status,
              s.plan_id as sub_plan_id
       FROM users u 
       LEFT JOIN plans p ON u.plan_id = p.id
       LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active' AND s.plan_id = u.plan_id
       ORDER BY u.id ASC`
    );
    res.render('admin-users', { users, userName: req.session.userName, currentUserId: req.session.userId });
  } catch (err) {
    res.redirect('/admin');
  }
});

router.get('/admin/user/new', adminAuth, async (req, res) => {
  try {
    const plans = await db.all('SELECT * FROM plans ORDER BY price ASC');
    res.render('admin-user-new', { plans, error: req.query.error || null, userName: req.session.userName, currentUserId: req.session.userId });
  } catch (err) {
    res.redirect('/admin');
  }
});

router.post('/admin/user/new', adminAuth, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim();
    const password = req.body.password || '';
    const planId = parseInt(req.body.plan_id) || 1;
    const role = req.body.role || 'user';

    if (!name) return res.redirect('/admin/user/new?error=El nombre es obligatorio');
    if (!email) return res.redirect('/admin/user/new?error=El email es obligatorio');
    if (!password || password.length < 6) return res.redirect('/admin/user/new?error=La contraseña debe tener al menos 6 caracteres');

    const existing = await db.get('SELECT id FROM users WHERE email = $1', [email]);
    if (existing) return res.redirect('/admin/user/new?error=El email ya está en uso');

    const plan = await db.get('SELECT * FROM plans WHERE id = $1', [planId]);
    if (!plan) return res.redirect('/admin/user/new?error=Plan no válido');

    const bcrypt = require('bcryptjs');
    const hashed = bcrypt.hashSync(password, 10);

    const result = await db.query('INSERT INTO users (name, email, password, plan_id, role) VALUES ($1, $2, $3, $4, $5) RETURNING id', [name, email, hashed, planId, role]);

    require('fs').mkdirSync(path.join(__dirname, '..', 'public', 'uploads', String(result.rows[0].id)), { recursive: true });

    await activity.log(req.session.userId, 'ADMIN_CREATE_USER', `Usuario ${name} (${email}) creado por administrador`, { ip: req.ip });
    notifyNewUser({ name, email });

    if (plan.price > 0) {
      const end = new Date();
      const months = parseInt(req.body.duration_months) || 12;
      end.setMonth(end.getMonth() + months);
      await db.run('INSERT INTO subscriptions (user_id, plan_id, status, expires_at, source) VALUES ($1, $2, $3, $4, $5)',
        [result.rows[0].id, planId, 'active', end.toISOString(), 'manual']);
      await activity.log(req.session.userId, 'ADMIN_ASSIGN_PLAN', `Plan ${plan.name} asignado manualmente a ${name} (${months} meses)`, { ip: req.ip });
    }

    res.redirect('/admin/user/' + result.rows[0].id + '/edit?msg=Usuario creado correctamente');
  } catch (err) {
    res.redirect('/admin');
  }
});

router.get('/admin/user/:id/edit', adminAuth, async (req, res) => {
  try {
    const user = await db.get('SELECT u.*, p.name as plan_name FROM users u LEFT JOIN plans p ON u.plan_id = p.id WHERE u.id = $1', [req.params.id]);
    if (!user) return res.redirect('/admin');
    const plans = await db.all('SELECT * FROM plans ORDER BY price ASC');
    res.render('admin-user-edit', { user, plans, message: req.query.msg || null, error: req.query.error || null, userName: req.session.userName, currentUserId: req.session.userId });
  } catch (err) {
    res.redirect('/admin');
  }
});

router.post('/admin/user/:id/edit', adminAuth, async (req, res) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.redirect('/admin');

    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim();
    const planId = parseInt(req.body.plan_id) || 1;

    if (!name) return res.redirect('/admin/user/' + req.params.id + '/edit?error=El nombre es obligatorio');
    if (!email) return res.redirect('/admin/user/' + req.params.id + '/edit?error=El email es obligatorio');

    const existing = await db.get('SELECT id FROM users WHERE email = $1 AND id != $2', [email, req.params.id]);
    if (existing) return res.redirect('/admin/user/' + req.params.id + '/edit?error=El email ya está en uso');

    const plan = await db.get('SELECT * FROM plans WHERE id = $1', [planId]);
    if (!plan) return res.redirect('/admin/user/' + req.params.id + '/edit?error=Plan no válido');

    await db.run('UPDATE users SET name = $1, email = $2, plan_id = $3 WHERE id = $4', [name, email, planId, req.params.id]);

    await activity.log(req.session.userId, 'ADMIN_EDIT_USER', 'Datos de ' + user.name + ' actualizados por administrador', { ip: req.ip });

    if (plan.price > 0) {
      const existingSub = await db.get("SELECT * FROM subscriptions WHERE user_id = $1 AND plan_id = $2 AND status = 'active'", [req.params.id, planId]);
      if (!existingSub) {
        const end = new Date();
        const months = parseInt(req.body.duration_months) || 12;
        end.setMonth(end.getMonth() + months);
        await db.run('INSERT INTO subscriptions (user_id, plan_id, status, expires_at, source) VALUES ($1, $2, $3, $4, $5)',
          [req.params.id, planId, 'active', end.toISOString(), 'manual']);
        await activity.log(req.session.userId, 'ADMIN_ASSIGN_PLAN', 'Plan ' + plan.name + ' asignado manualmente a ' + user.name + ' (' + months + ' meses)', { ip: req.ip });
      }
    }

    const vehicleResult = await db.get('SELECT COUNT(*)::int as c FROM vehicles WHERE user_id = $1', [req.params.id]);
    if (vehicleResult.c > plan.max_vehicles) {
      return res.redirect('/admin/user/' + req.params.id + '/edit?msg=Usuario actualizado. ATENCIÓN: Tiene ' + vehicleResult.c + ' vehículos pero el plan permite máximo ' + plan.max_vehicles);
    }
    res.redirect('/admin/user/' + req.params.id + '/edit?msg=Usuario actualizado correctamente');
  } catch (err) {
    res.redirect('/admin');
  }
});

router.get('/admin/logs', adminAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = 50;
    const totalResult = await db.get('SELECT COUNT(*)::int as count FROM activity_log');
    const logs = await db.all(
      `SELECT al.*, u.name as user_name FROM activity_log al
       LEFT JOIN users u ON al.user_id = u.id
       ORDER BY al.created_at DESC LIMIT $1 OFFSET $2`,
      [perPage, (page - 1) * perPage]
    );
    res.render('admin-logs', { logs, page, total: totalResult.count, perPage, userName: req.session.userName, currentUserId: req.session.userId });
  } catch (err) {
    res.redirect('/admin');
  }
});

router.get('/admin/settings', adminAuth, async (req, res) => {
  try {
    const s = await settings.getAll();
    const msg = req.query.msg || null;
    res.render('admin-settings', { settings: s, msg, userName: req.session.userName });
  } catch (err) {
    res.redirect('/admin');
  }
});

router.get('/admin/plans', adminAuth, async (req, res) => {
  try {
    const s = await settings.getAll();
    const plans = await db.all('SELECT * FROM plans ORDER BY price ASC');
    const msg = req.query.msg || null;
    res.render('admin-plans', { settings: s, availablePlans: plans, msg, userName: req.session.userName, planName: req.session.planName });
  } catch (err) {
    res.redirect('/admin');
  }
});

router.post('/admin/plans', adminAuth, async (req, res) => {
  try {
    await settings.set('plans_title', req.body.plans_title || 'Planes para cada necesidad');
    const planList = await db.all('SELECT id FROM plans');
    for (const p of planList) {
      const name = (req.body['plan_' + p.id + '_name'] || '').trim();
      if (!name) continue;
      const description = req.body['plan_' + p.id + '_description'] || '';
      const priceStr = (req.body['plan_' + p.id + '_price'] || '').replace(/\./g, '').replace(',', '.');
      const price = parseFloat(priceStr) || 0;
      const max_vehicles = parseInt(req.body['plan_' + p.id + '_max_vehicles']) || 1;
      const max_documents = parseInt(req.body['plan_' + p.id + '_max_documents']) || 10;
      const max_nfc_links = parseInt(req.body['plan_' + p.id + '_max_nfc_links']) || 0;
      const max_file_size = parseInt(req.body['plan_' + p.id + '_max_file_size']) || 5;
      const has_pin_protection = req.body['plan_' + p.id + '_has_pin_protection'] ? 1 : 0;
      const has_nfc = req.body['plan_' + p.id + '_has_nfc'] ? 1 : 0;
      await db.run('UPDATE plans SET name = $1, description = $2, price = $3, max_vehicles = $4, max_documents = $5, max_nfc_links = $6, max_file_size = $7, has_pin_protection = $8, has_nfc = $9 WHERE id = $10',
        [name, description, price, max_vehicles, max_documents, max_nfc_links, max_file_size, has_pin_protection, has_nfc, p.id]);
    }
    await activity.log(req.session.userId, 'ADMIN_PLANS', 'Planes actualizados', { ip: req.ip });
    res.redirect('/admin/plans?msg=Planes guardados correctamente');
  } catch (err) {
    res.redirect('/admin');
  }
});

router.post('/admin/settings', adminAuth, logoUpload, async (req, res) => {
  try {
    const keys = Object.keys(req.body);
    for (const key of keys) {
      await settings.set(key, req.body[key]);
    }

    if (req.file) {
      const target = path.join(__dirname, '..', 'public', 'logo.png');
      fs.copyFileSync(req.file.path, target);
      try { fs.unlinkSync(req.file.path); } catch (e) { }
    }

    await activity.log(req.session.userId, 'ADMIN_SETTINGS', 'Configuración del sitio actualizada', { ip: req.ip });
    res.redirect('/admin/settings?msg=Configuración guardada correctamente');
  } catch (err) {
    res.redirect('/admin');
  }
});

router.get('/admin/notifications', adminAuth, async (req, res) => {
  try {
    const s = await settings.getAll();
    const msg = req.query.msg || null;
    res.render('admin-notifications', { settings: s, msg, userName: req.session.userName, planName: req.session.planName });
  } catch (err) {
    res.redirect('/admin');
  }
});

router.post('/admin/notifications', adminAuth, async (req, res) => {
  try {
    const keys = Object.keys(req.body);
    for (const key of keys) {
      await settings.set(key, req.body[key]);
    }
    await activity.log(req.session.userId, 'ADMIN_SETTINGS', 'Configuración de notificaciones actualizada', { ip: req.ip });
    res.redirect('/admin/notifications?msg=Configuración guardada correctamente');
  } catch (err) {
    res.redirect('/admin');
  }
});

router.get('/admin/colors', adminAuth, async (req, res) => {
  try {
    const s = await settings.getAll();
    const msg = req.query.msg || null;
    res.render('admin-colors', { settings: s, msg, userName: req.session.userName, planName: req.session.planName });
  } catch (err) {
    res.redirect('/admin');
  }
});

router.post('/admin/colors', adminAuth, async (req, res) => {
  try {
    const keys = Object.keys(req.body);
    for (const key of keys) {
      await settings.set(key, req.body[key]);
    }
    await activity.log(req.session.userId, 'ADMIN_COLORS', 'Colores del sitio actualizados', { ip: req.ip });
    res.redirect('/admin/colors?msg=Colores guardados correctamente');
  } catch (err) {
    res.redirect('/admin');
  }
});

module.exports = router;
