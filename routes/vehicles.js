const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../models/db');
const auth = require('../middleware/auth');
const { checkVehicleLimit, checkUploadLimit } = require('../middleware/planLimits');
const activity = require('../models/activity');
const router = express.Router();

const MAX_FILE_SIZE = 20 * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'public', 'uploads', String(req.session.userId));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + '-' + file.originalname);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos PDF, JPEG, PNG o WebP'));
    }
  },
  limits: { fileSize: MAX_FILE_SIZE }
});

function getDocStatus(expirationDate) {
  if (!expirationDate) return { label: 'Sin fecha', class: 'doc-status-unknown' };
  const now = new Date();
  const exp = new Date(expirationDate);
  const diffDays = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return { label: `Vencido (hace ${Math.abs(diffDays)} días)`, class: 'doc-status-expired' };
  if (diffDays <= 30) return { label: `Vence en ${diffDays} días`, class: 'doc-status-warning' };
  return { label: `Vigente (hasta ${exp.toLocaleDateString('es-ES')})`, class: 'doc-status-valid' };
}

router.get('/dashboard', auth, (req, res) => {
  const vehicles = db.prepare('SELECT * FROM vehicles WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId);
  const user = db.prepare('SELECT p.name as plan_name, p.price FROM users u JOIN plans p ON u.plan_id = p.id WHERE u.id = ?').get(req.session.userId);
  const logCount = db.prepare('SELECT COUNT(*) as c FROM activity_log WHERE user_id = ?').get(req.session.userId).c;
  
  // Check subscription status for banner
  const sub = db.prepare("SELECT expires_at, status, plan_id FROM subscriptions WHERE user_id = ? ORDER BY expires_at DESC LIMIT 1").get(req.session.userId);
  let planExpiration = null;
  let planExpiresAt = null;
  let subExpired = false;
  let subPlanName = null;
  if (sub) {
    const subPlan = db.prepare('SELECT name, price FROM plans WHERE id = ?').get(sub.plan_id);
    subPlanName = subPlan ? subPlan.name : null;
    if (sub.expires_at && subPlan && subPlan.price > 0) {
      const now = new Date();
      const exp = new Date(sub.expires_at);
      const diffMs = exp - now;
      if (diffMs > 0 && sub.status === 'active') {
        const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        const months = Math.floor(days / 30);
        const remainingDays = days % 30;
        planExpiration = months > 0 ? `${months}m ${remainingDays}d` : `${days}d`;
        planExpiresAt = sub.expires_at;
      } else if (diffMs <= 0 || sub.status !== 'active') {
        subExpired = true;
      }
    }
  }
  
  const alerts = [];
  vehicles.forEach(v => {
    const docs = db.prepare('SELECT type, expiration_date FROM documents WHERE vehicle_id = ?').all(v.id);
    docs.forEach(d => {
      if (d.expiration_date) {
        const status = getDocStatus(d.expiration_date);
        if (status.class !== 'doc-status-valid') {
          alerts.push({ vehicle: v, docType: d.type, status });
        }
      }
    });
  });

  res.render('dashboard', { vehicles, alerts, userName: req.session.userName, planName: user.plan_name, vehicleCount: vehicles.length, logCount, planExpiration, planExpiresAt, subExpired, subPlanName, planPrice: user.price });
});

router.get('/new-vehicle', auth, (req, res) => {
  res.render('new-vehicle', { error: null });
});

router.post('/new-vehicle', auth, checkVehicleLimit, (req, res) => {
  const { brand, model, year, plate, vin, owner_name, owner_dni, color, fuel_type, engine_capacity } = req.body;
  if (!brand || !model || !year || !plate) {
    return res.render('new-vehicle', { error: 'Marca, modelo, año y matrícula son obligatorios' });
  }
  try {
    const result = db.prepare('INSERT INTO vehicles (user_id, brand, model, year, plate, vin, owner_name, owner_dni, color, fuel_type, engine_capacity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(req.session.userId, brand, model, year, plate, vin || null, owner_name || null, owner_dni || null, color || null, fuel_type || null, engine_capacity || null);
    activity.log(req.session.userId, 'VEHICLE_CREATED', `Vehículo ${brand} ${model} (${plate}) creado`, { vehicleId: result.lastInsertRowid, ip: req.ip });
    res.redirect('/dashboard');
  } catch (err) {
    res.render('new-vehicle', { error: 'Error al crear vehículo' });
  }
});

router.get('/vehicle/:id', auth, (req, res) => {
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!vehicle) return res.redirect('/dashboard');
  
  const documents = db.prepare('SELECT * FROM documents WHERE vehicle_id = ? ORDER BY uploaded_at DESC').all(req.params.id).map(d => ({
    ...d,
    status: getDocStatus(d.expiration_date),
    url: `/uploads/${req.session.userId}/${d.filename}`
  }));
  
  const nfcLinks = db.prepare('SELECT * FROM nfc_links WHERE vehicle_id = ? ORDER BY created_at DESC').all(req.params.id);
  const error = req.query.error || null;
  
  const expired = documents.filter(d => d.status.class === 'doc-status-expired');
  const expiring = documents.filter(d => d.status.class === 'doc-status-warning');
  
  const recentLogs = db.prepare("SELECT * FROM activity_log WHERE vehicle_id = ? OR (user_id = ? AND action LIKE 'DOCUMENT_%') ORDER BY created_at DESC LIMIT 20").all(req.params.id, req.session.userId);
  
  res.render('vehicle', { vehicle, documents, nfcLinks, baseUrl: process.env.BASE_URL || 'http://localhost:3000', plan: req.session.plan, error, expired, expiring, recentLogs, userId: req.session.userId });
});

router.get('/vehicle/:id/edit', auth, (req, res) => {
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!vehicle) return res.redirect('/dashboard');
  res.render('edit-vehicle', { vehicle, error: null });
});

router.post('/vehicle/:id/edit', auth, (req, res) => {
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!vehicle) return res.redirect('/dashboard');
  const { brand, model, year, plate, vin, owner_name, owner_dni, color, fuel_type, engine_capacity } = req.body;
  if (!brand || !model || !year || !plate) {
    return res.render('edit-vehicle', { vehicle, error: 'Marca, modelo, año y matrícula son obligatorios' });
  }
  try {
    db.prepare('UPDATE vehicles SET brand = ?, model = ?, year = ?, plate = ?, vin = ?, owner_name = ?, owner_dni = ?, color = ?, fuel_type = ?, engine_capacity = ? WHERE id = ?').run(brand, model, year, plate, vin || null, owner_name || null, owner_dni || null, color || null, fuel_type || null, engine_capacity || null, req.params.id);
    activity.log(req.session.userId, 'VEHICLE_UPDATED', `Vehículo ${brand} ${model} (${plate}) actualizado`, { vehicleId: req.params.id, ip: req.ip });
    res.redirect(`/vehicle/${req.params.id}`);
  } catch (err) {
    res.render('edit-vehicle', { vehicle, error: 'Error al actualizar vehículo' });
  }
});

router.post('/vehicle/:id/upload', auth, checkUploadLimit, upload.single('document'), (req, res) => {
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!vehicle) return res.redirect('/dashboard');
  if (!req.file) {
    return res.redirect(`/vehicle/${req.params.id}`);
  }
  const planLimit = req.session.plan?.max_file_size || 5;
  if (req.file.size > planLimit * 1024 * 1024) {
    try { fs.unlinkSync(req.file.path); } catch (e) { }
    return res.redirect(`/vehicle/${req.params.id}?error=El archivo excede el límite de ${planLimit}MB de tu plan`);
  }
  const docType = req.body.type || 'general';
  const expirationDate = req.body.expiration_date || null;
  const result = db.prepare('INSERT INTO documents (vehicle_id, type, filename, original_name, expiration_date) VALUES (?, ?, ?, ?, ?)').run(req.params.id, docType, req.file.filename, req.file.originalname, expirationDate);
  activity.log(req.session.userId, 'DOCUMENT_UPLOADED', `Documento ${docType}: ${req.file.originalname} subido a ${vehicle.plate}`, { vehicleId: req.params.id, documentId: result.lastInsertRowid, ip: req.ip });
  res.redirect(`/vehicle/${req.params.id}`);
});

router.post('/document/:id/delete', auth, (req, res) => {
  const doc = db.prepare(`
    SELECT d.*, v.plate, v.user_id FROM documents d
    JOIN vehicles v ON d.vehicle_id = v.id
    WHERE d.id = ? AND v.user_id = ?
  `).get(req.params.id, req.session.userId);
  if (!doc) return res.redirect('/dashboard');
  const filePath = path.join(__dirname, '..', 'public', 'uploads', String(doc.user_id), doc.filename);
  try { fs.unlinkSync(filePath); } catch (e) { }
  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  activity.log(req.session.userId, 'DOCUMENT_DELETED', `Documento ${doc.type}: ${doc.original_name} eliminado de ${doc.plate}`, { vehicleId: doc.vehicle_id, documentId: req.params.id, ip: req.ip });
  res.redirect(`/vehicle/${doc.vehicle_id}`);
});

router.post('/vehicle/:id/delete', auth, (req, res) => {
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!vehicle) return res.redirect('/dashboard');
  const docs = db.prepare('SELECT filename FROM documents WHERE vehicle_id = ?').all(req.params.id);
  docs.forEach(doc => {
    const fp = path.join(__dirname, '..', 'public', 'uploads', String(req.session.userId), doc.filename);
    try { fs.unlinkSync(fp); } catch (e) { }
  });
  db.prepare('DELETE FROM vehicles WHERE id = ?').run(req.params.id);
  activity.log(req.session.userId, 'VEHICLE_DELETED', `Vehículo ${vehicle.brand} ${vehicle.model} (${vehicle.plate}) eliminado`, { vehicleId: req.params.id, ip: req.ip });
  res.redirect('/dashboard');
});

router.get('/vehicle/:id/edit', auth, (req, res) => {
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!vehicle) return res.redirect('/dashboard');
  res.render('edit-vehicle', { vehicle, error: null });
});

router.post('/vehicle/:id/edit', auth, (req, res) => {
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!vehicle) return res.redirect('/dashboard');

  const { brand, model, year, plate, vin, owner_name, owner_dni, color, fuel_type, engine_capacity } = req.body;
  if (!brand || !model || !year || !plate) {
    return res.render('edit-vehicle', { vehicle: { ...vehicle, ...req.body }, error: 'Marca, modelo, año y matrícula son obligatorios' });
  }

  try {
    db.prepare('UPDATE vehicles SET brand = ?, model = ?, year = ?, plate = ?, vin = ?, owner_name = ?, owner_dni = ?, color = ?, fuel_type = ?, engine_capacity = ? WHERE id = ?')
      .run(brand, model, year, plate, vin || null, owner_name || null, owner_dni || null, color || null, fuel_type || null, engine_capacity || null, req.params.id);
    activity.log(req.session.userId, 'VEHICLE_UPDATED', `Vehículo ${brand} ${model} (${plate}) actualizado`, { vehicleId: req.params.id, ip: req.ip });
    res.redirect(`/vehicle/${req.params.id}`);
  } catch (err) {
    res.render('edit-vehicle', { vehicle: { ...vehicle, ...req.body }, error: 'Error al actualizar vehículo' });
  }
});

router.get('/activity-log', auth, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = 30;
  const total = db.prepare('SELECT COUNT(*) as c FROM activity_log WHERE user_id = ?').get(req.session.userId).c;
  const logs = db.prepare('SELECT * FROM activity_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(req.session.userId, perPage, (page - 1) * perPage);
  res.render('activity-log', { logs, page, total, perPage, userName: req.session.userName });
});

module.exports = router;
