const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../models/db');
const settings = require('../models/settings');
const adminAuth = require('../middleware/admin');
const activity = require('../models/activity');
const backup = require('../services/backup');
const router = express.Router();

const logoUpload = multer({ dest: path.join(__dirname, '..', 'tmp') }).single('logo_file');

router.get('/admin', adminAuth, (req, res) => {
  const users = db.prepare('SELECT u.id, u.name, u.email, u.role, u.created_at, p.name as plan_name FROM users u LEFT JOIN plans p ON u.plan_id = p.id ORDER BY u.created_at DESC').all();
  const vehicleCount = db.prepare('SELECT COUNT(*) as count FROM vehicles').get().count;
  const docCount = db.prepare('SELECT COUNT(*) as count FROM documents').get().count;
  const nfcCount = db.prepare('SELECT COUNT(*) as count FROM nfc_links').get().count;
  const logCount = db.prepare('SELECT COUNT(*) as count FROM activity_log').get().count;
  const pendingPayments = db.prepare("SELECT COUNT(*) as count FROM payments WHERE status IN (?, ?)").get('pending', 'pending_flow').count;
  res.render('admin', { users, vehicleCount, docCount, nfcCount, logCount, pendingPayments, userName: req.session.userName, currentUserId: req.session.userId });
});

router.post('/admin/user/:id/toggle-role', adminAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.redirect('/admin');
  const newRole = user.role === 'admin' ? 'user' : 'admin';
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(newRole, req.params.id);
  activity.log(req.session.userId, 'ADMIN_TOGGLE_ROLE', `Rol de ${user.name} cambiado a ${newRole}`, { ip: req.ip });
  res.redirect('/admin');
});

router.post('/admin/user/:id/delete', adminAuth, (req, res) => {
  if (parseInt(req.params.id) === req.session.userId) {
    return res.redirect('/admin');
  }
  const docs = db.prepare(`SELECT d.filename, v.user_id FROM documents d JOIN vehicles v ON d.vehicle_id = v.id WHERE v.user_id = ?`).all(req.params.id);
  docs.forEach(d => {
    try { fs.unlinkSync(path.join(__dirname, '..', 'public', 'uploads', String(d.user_id), d.filename)); } catch (e) { }
  });
  const userDir = path.join(__dirname, '..', 'public', 'uploads', String(req.params.id));
  try { fs.rmdirSync(userDir, { recursive: true }); } catch (e) { }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  activity.log(req.session.userId, 'ADMIN_DELETE_USER', `Usuario ID ${req.params.id} eliminado por administrador`, { ip: req.ip });
  res.redirect('/admin');
});

router.get('/admin/payments', adminAuth, (req, res) => {
  const payments = db.prepare(`
    SELECT pay.*, u.name as user_name, p.name as plan_name FROM payments pay
    JOIN users u ON pay.user_id = u.id
    JOIN plans p ON pay.plan_id = p.id
    ORDER BY pay.created_at DESC
  `).all();
  res.render('admin-payments', { payments, userName: req.session.userName, currentUserId: req.session.userId });
});

router.post('/admin/payment/:id/confirm', adminAuth, (req, res) => {
  const payment = db.prepare('SELECT pay.*, p.name as plan_name FROM payments pay JOIN plans p ON pay.plan_id = p.id WHERE pay.id = ?').get(req.params.id);
  if (!payment) return res.redirect('/admin/payments');
  if (payment.status !== 'pending') return res.redirect('/admin/payments');

  const now = new Date().toISOString();
  db.prepare('UPDATE payments SET status = ?, confirmed_at = ? WHERE id = ?').run('confirmed', now, payment.id);
  db.prepare('UPDATE users SET plan_id = ? WHERE id = ?').run(payment.plan_id, payment.user_id);
  activity.log(req.session.userId, 'PAYMENT_CONFIRMED', 'Pago verificado: ' + payment.reference + ' - Plan ' + payment.plan_name + ' para usuario ID ' + payment.user_id, { ip: req.ip });

  const end = new Date();
  end.setFullYear(end.getFullYear() + 1);
  db.prepare('INSERT INTO subscriptions (user_id, plan_id, status, expires_at, source) VALUES (?, ?, ?, ?, ?)')
    .run(payment.user_id, payment.plan_id, 'active', end.toISOString(), 'manual');

  res.redirect('/admin/payments');
});

router.post('/admin/payment/:id/delete', adminAuth, (req, res) => {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!payment) return res.redirect('/admin/payments');
  db.prepare('DELETE FROM payments WHERE id = ?').run(req.params.id);
  activity.log(req.session.userId, 'PAYMENT_DELETED', 'Pago eliminado: ' + payment.reference + ' (ID: ' + payment.id + ')', { ip: req.ip });
  res.redirect('/admin/payments');
});

router.post('/admin/payment/:id/reject', adminAuth, (req, res) => {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
  if (!payment || payment.status !== 'pending') return res.redirect('/admin/payments');
  db.prepare('UPDATE payments SET status = ? WHERE id = ?').run('rejected', payment.id);
  activity.log(req.session.userId, 'PAYMENT_REJECTED', 'Pago rechazado: ' + payment.reference, { ip: req.ip });
  res.redirect('/admin/payments');
});

router.get('/admin/backups', adminAuth, (req, res) => {
  const backups = backup.listBackups();
  res.render('admin-backups', { backups, message: req.query.msg || null, userName: req.session.userName, currentUserId: req.session.userId });
});

router.post('/admin/backups/create', adminAuth, (req, res) => {
  const file = backup.createBackup();
  if (file) {
    activity.log(req.session.userId, 'BACKUP_CREATED', 'Backup manual creado: ' + path.basename(file), { ip: req.ip });
    res.redirect('/admin/backups?msg=Backup creado: ' + path.basename(file));
  } else {
    res.redirect('/admin/backups?msg=Error al crear backup');
  }
});

router.get('/admin/users', adminAuth, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.created_at, p.name as plan_name, p.price as plan_price,
           s.source as sub_source, s.expires_at as sub_expires_at, s.status as sub_status,
           s.plan_id as sub_plan_id
    FROM users u 
    LEFT JOIN plans p ON u.plan_id = p.id
    LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active' AND s.plan_id = u.plan_id
ORDER BY u.id ASC
  `).all();
  res.render('admin-users', { users, userName: req.session.userName, currentUserId: req.session.userId });
});

router.get('/admin/user/new', adminAuth, (req, res) => {
  const plans = db.prepare('SELECT * FROM plans ORDER BY price ASC').all();
  res.render('admin-user-new', { plans, error: req.query.error || null, userName: req.session.userName, currentUserId: req.session.userId });
});

router.post('/admin/user/new', adminAuth, (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';
  const planId = parseInt(req.body.plan_id) || 1;
  const role = req.body.role || 'user';

  if (!name) return res.redirect('/admin/user/new?error=El nombre es obligatorio');
  if (!email) return res.redirect('/admin/user/new?error=El email es obligatorio');
  if (!password || password.length < 6) return res.redirect('/admin/user/new?error=La contraseña debe tener al menos 6 caracteres');

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.redirect('/admin/user/new?error=El email ya está en uso');

  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!plan) return res.redirect('/admin/user/new?error=Plan no válido');

  const bcrypt = require('bcryptjs');
  const hashed = bcrypt.hashSync(password, 10);

  const result = db.prepare('INSERT INTO users (name, email, password, plan_id, role) VALUES (?, ?, ?, ?, ?)').run(name, email, hashed, planId, role);

  require('fs').mkdirSync(path.join(__dirname, '..', 'public', 'uploads', String(result.lastInsertRowid)), { recursive: true });

  activity.log(req.session.userId, 'ADMIN_CREATE_USER', `Usuario ${name} (${email}) creado por administrador`, { ip: req.ip });

  // Create subscription for paid plans
  if (plan.price > 0) {
    const end = new Date();
    const months = parseInt(req.body.duration_months) || 12;
    end.setMonth(end.getMonth() + months);
    db.prepare('INSERT INTO subscriptions (user_id, plan_id, status, expires_at, source) VALUES (?, ?, ?, ?, ?)')
      .run(result.lastInsertRowid, planId, 'active', end.toISOString(), 'manual');
    activity.log(req.session.userId, 'ADMIN_ASSIGN_PLAN', `Plan ${plan.name} asignado manualmente a ${name} (${months} meses)`, { ip: req.ip });
  }

  res.redirect('/admin/user/' + result.lastInsertRowid + '/edit?msg=Usuario creado correctamente');
});

router.get('/admin/user/:id/edit', adminAuth, (req, res) => {
  const user = db.prepare('SELECT u.*, p.name as plan_name FROM users u LEFT JOIN plans p ON u.plan_id = p.id WHERE u.id = ?').get(req.params.id);
  if (!user) return res.redirect('/admin');
  const plans = db.prepare('SELECT * FROM plans ORDER BY price ASC').all();
  res.render('admin-user-edit', { user, plans, message: req.query.msg || null, error: req.query.error || null, userName: req.session.userName, currentUserId: req.session.userId });
});

router.post('/admin/user/:id/edit', adminAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.redirect('/admin');

  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim();
  const planId = parseInt(req.body.plan_id) || 1;

  if (!name) return res.redirect('/admin/user/' + req.params.id + '/edit?error=El nombre es obligatorio');
  if (!email) return res.redirect('/admin/user/' + req.params.id + '/edit?error=El email es obligatorio');

  const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, req.params.id);
  if (existing) return res.redirect('/admin/user/' + req.params.id + '/edit?error=El email ya está en uso');

  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
  if (!plan) return res.redirect('/admin/user/' + req.params.id + '/edit?error=Plan no válido');

  db.prepare('UPDATE users SET name = ?, email = ?, plan_id = ? WHERE id = ?').run(name, email, planId, req.params.id);

  activity.log(req.session.userId, 'ADMIN_EDIT_USER', 'Datos de ' + user.name + ' actualizados por administrador', { ip: req.ip });

  // Create subscription for paid plans if doesn't exist
  if (plan.price > 0) {
    const existingSub = db.prepare(`SELECT * FROM subscriptions WHERE user_id = ? AND plan_id = ? AND status = 'active'`).get(req.params.id, planId);
    if (!existingSub) {
      const end = new Date();
      const months = parseInt(req.body.duration_months) || 12;
      end.setMonth(end.getMonth() + months);
      db.prepare('INSERT INTO subscriptions (user_id, plan_id, status, expires_at, source) VALUES (?, ?, ?, ?, ?)')
        .run(req.params.id, planId, 'active', end.toISOString(), 'manual');
      activity.log(req.session.userId, 'ADMIN_ASSIGN_PLAN', 'Plan ' + plan.name + ' asignado manualmente a ' + user.name + ' (' + months + ' meses)', { ip: req.ip });
    }
  }

  const vehicleCount = db.prepare('SELECT COUNT(*) as c FROM vehicles WHERE user_id = ?').get(req.params.id).c;
  if (vehicleCount > plan.max_vehicles) {
    return res.redirect('/admin/user/' + req.params.id + '/edit?msg=Usuario actualizado. ATENCIÓN: Tiene ' + vehicleCount + ' vehículos pero el plan permite máximo ' + plan.max_vehicles);
  }
  res.redirect('/admin/user/' + req.params.id + '/edit?msg=Usuario actualizado correctamente');
});

router.get('/admin/logs', adminAuth, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = 50;
  const total = db.prepare('SELECT COUNT(*) as count FROM activity_log').get().count;
  const logs = db.prepare(`
    SELECT al.*, u.name as user_name FROM activity_log al
    LEFT JOIN users u ON al.user_id = u.id
    ORDER BY al.created_at DESC LIMIT ? OFFSET ?
  `).all(perPage, (page - 1) * perPage);
  res.render('admin-logs', { logs, page, total, perPage, userName: req.session.userName, currentUserId: req.session.userId });
});

router.get('/admin/settings', adminAuth, (req, res) => {
  const s = settings.getAll();
  const msg = req.query.msg || null;
  res.render('admin-settings', { settings: s, msg, userName: req.session.userName });
});

router.get('/admin/plans', adminAuth, (req, res) => {
  const s = settings.getAll();
  const plans = db.prepare('SELECT * FROM plans ORDER BY price ASC').all();
  const msg = req.query.msg || null;
  res.render('admin-plans', { settings: s, availablePlans: plans, msg, userName: req.session.userName, planName: req.session.planName });
});

router.post('/admin/plans', adminAuth, (req, res) => {
  settings.set('plans_title', req.body.plans_title || 'Planes para cada necesidad');
  const planIds = db.prepare('SELECT id FROM plans').all().map(p => p.id);
  for (const pid of planIds) {
    const name = (req.body['plan_' + pid + '_name'] || '').trim();
    if (!name) continue;
    const description = req.body['plan_' + pid + '_description'] || '';
    const priceStr = (req.body['plan_' + pid + '_price'] || '').replace(/\./g, '').replace(',', '.');
    const price = parseFloat(priceStr) || 0;
    const max_vehicles = parseInt(req.body['plan_' + pid + '_max_vehicles']) || 1;
    const max_documents = parseInt(req.body['plan_' + pid + '_max_documents']) || 10;
    const max_nfc_links = parseInt(req.body['plan_' + pid + '_max_nfc_links']) || 0;
    const max_file_size = parseInt(req.body['plan_' + pid + '_max_file_size']) || 5;
    const has_pin_protection = req.body['plan_' + pid + '_has_pin_protection'] ? 1 : 0;
    const has_nfc = req.body['plan_' + pid + '_has_nfc'] ? 1 : 0;
    db.prepare('UPDATE plans SET name = ?, description = ?, price = ?, max_vehicles = ?, max_documents = ?, max_nfc_links = ?, max_file_size = ?, has_pin_protection = ?, has_nfc = ? WHERE id = ?')
      .run(name, description, price, max_vehicles, max_documents, max_nfc_links, max_file_size, has_pin_protection, has_nfc, pid);
  }
  activity.log(req.session.userId, 'ADMIN_PLANS', 'Planes actualizados', { ip: req.ip });
  res.redirect('/admin/plans?msg=Planes guardados correctamente');
});

router.post('/admin/settings', adminAuth, logoUpload, (req, res) => {
  const keys = Object.keys(req.body);
  for (const key of keys) {
    settings.set(key, req.body[key]);
  }

  // Handle logo upload
  if (req.file) {
    const target = path.join(__dirname, '..', 'public', 'logo.png');
    fs.copyFileSync(req.file.path, target);
    try { fs.unlinkSync(req.file.path); } catch (e) { }
  }

  activity.log(req.session.userId, 'ADMIN_SETTINGS', 'Configuración del sitio actualizada', { ip: req.ip });
  res.redirect('/admin/settings?msg=Configuración guardada correctamente');
});

router.get('/admin/colors', adminAuth, (req, res) => {
  const s = settings.getAll();
  const msg = req.query.msg || null;
  res.render('admin-colors', { settings: s, msg, userName: req.session.userName, planName: req.session.planName });
});

router.post('/admin/colors', adminAuth, (req, res) => {
  const keys = Object.keys(req.body);
  for (const key of keys) {
    settings.set(key, req.body[key]);
  }
  activity.log(req.session.userId, 'ADMIN_COLORS', 'Colores del sitio actualizados', { ip: req.ip });
  res.redirect('/admin/colors?msg=Colores guardados correctamente');
});

module.exports = router;
