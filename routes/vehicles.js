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

router.get('/dashboard', auth, async (req, res) => {
  try {
    const vehicles = await db.all('SELECT * FROM vehicles WHERE user_id = $1 ORDER BY created_at DESC', [req.session.userId]);
    const user = await db.get('SELECT p.name as plan_name, p.price FROM users u JOIN plans p ON u.plan_id = p.id WHERE u.id = $1', [req.session.userId]);
    const logResult = await db.get('SELECT COUNT(*)::int as c FROM activity_log WHERE user_id = $1', [req.session.userId]);
    const logCount = logResult.c;

    const sub = await db.get("SELECT expires_at, status, plan_id FROM subscriptions WHERE user_id = $1 ORDER BY expires_at DESC LIMIT 1", [req.session.userId]);
    let planExpiration = null;
    let planExpiresAt = null;
    let subExpired = false;
    let subPlanName = null;
    if (sub) {
      const subPlan = await db.get('SELECT name, price FROM plans WHERE id = $1', [sub.plan_id]);
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
    for (const v of vehicles) {
      const docs = await db.all('SELECT type, expiration_date FROM documents WHERE vehicle_id = $1', [v.id]);
      docs.forEach(d => {
        if (d.expiration_date) {
          const status = getDocStatus(d.expiration_date);
          if (status.class !== 'doc-status-valid') {
            alerts.push({ vehicle: v, docType: d.type, status });
          }
        }
      });
    }

    res.render('dashboard', { vehicles, alerts, userName: req.session.userName, planName: user.plan_name, vehicleCount: vehicles.length, logCount, planExpiration, planExpiresAt, subExpired, subPlanName, planPrice: user.price });
  } catch (err) {
    res.redirect('/login');
  }
});

router.get('/new-vehicle', auth, (req, res) => {
  res.render('new-vehicle', { error: null });
});

router.post('/new-vehicle', auth, checkVehicleLimit, async (req, res) => {
  const { brand, model, year, plate, vin, owner_name, owner_dni, color, fuel_type, engine_capacity } = req.body;
  if (!brand || !model || !year || !plate) {
    return res.render('new-vehicle', { error: 'Marca, modelo, año y matrícula son obligatorios' });
  }
  try {
    const result = await db.query(
      'INSERT INTO vehicles (user_id, brand, model, year, plate, vin, owner_name, owner_dni, color, fuel_type, engine_capacity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id',
      [req.session.userId, brand, model, year, plate, vin || null, owner_name || null, owner_dni || null, color || null, fuel_type || null, engine_capacity || null]
    );
    await activity.log(req.session.userId, 'VEHICLE_CREATED', `Vehículo ${brand} ${model} (${plate}) creado`, { vehicleId: result.rows[0].id, ip: req.ip });
    res.redirect('/dashboard');
  } catch (err) {
    res.render('new-vehicle', { error: 'Error al crear vehículo' });
  }
});

router.get('/vehicle/:id', auth, async (req, res) => {
  try {
    const vehicle = await db.get('SELECT * FROM vehicles WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    if (!vehicle) return res.redirect('/dashboard');

    const docRows = await db.all('SELECT * FROM documents WHERE vehicle_id = $1 ORDER BY uploaded_at DESC', [req.params.id]);
    const documents = docRows.map(d => ({
      ...d,
      status: getDocStatus(d.expiration_date),
      url: `/uploads/${req.session.userId}/${d.filename}`
    }));

    const nfcLinks = await db.all('SELECT * FROM nfc_links WHERE vehicle_id = $1 ORDER BY created_at DESC', [req.params.id]);
    const error = req.query.error || null;

    const expired = documents.filter(d => d.status.class === 'doc-status-expired');
    const expiring = documents.filter(d => d.status.class === 'doc-status-warning');

    const recentLogs = await db.all("SELECT * FROM activity_log WHERE vehicle_id = $1 OR (user_id = $2 AND action LIKE 'DOCUMENT_%') ORDER BY created_at DESC LIMIT 20", [req.params.id, req.session.userId]);

    res.render('vehicle', { vehicle, documents, nfcLinks, baseUrl: process.env.BASE_URL || 'http://localhost:3000', plan: req.session.plan, error, expired, expiring, recentLogs, userId: req.session.userId });
  } catch (err) {
    res.redirect('/dashboard');
  }
});

router.get('/vehicle/:id/edit', auth, async (req, res) => {
  try {
    const vehicle = await db.get('SELECT * FROM vehicles WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    if (!vehicle) return res.redirect('/dashboard');
    res.render('edit-vehicle', { vehicle, error: null });
  } catch (err) {
    res.redirect('/dashboard');
  }
});

router.post('/vehicle/:id/edit', auth, async (req, res) => {
  try {
    const vehicle = await db.get('SELECT * FROM vehicles WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    if (!vehicle) return res.redirect('/dashboard');
    const { brand, model, year, plate, vin, owner_name, owner_dni, color, fuel_type, engine_capacity } = req.body;
    if (!brand || !model || !year || !plate) {
      return res.render('edit-vehicle', { vehicle, error: 'Marca, modelo, año y matrícula son obligatorios' });
    }
    await db.run(
      'UPDATE vehicles SET brand = $1, model = $2, year = $3, plate = $4, vin = $5, owner_name = $6, owner_dni = $7, color = $8, fuel_type = $9, engine_capacity = $10 WHERE id = $11',
      [brand, model, year, plate, vin || null, owner_name || null, owner_dni || null, color || null, fuel_type || null, engine_capacity || null, req.params.id]
    );
    await activity.log(req.session.userId, 'VEHICLE_UPDATED', `Vehículo ${brand} ${model} (${plate}) actualizado`, { vehicleId: req.params.id, ip: req.ip });
    res.redirect(`/vehicle/${req.params.id}`);
  } catch (err) {
    res.render('edit-vehicle', { vehicle, error: 'Error al actualizar vehículo' });
  }
});

router.post('/vehicle/:id/upload', auth, checkUploadLimit, upload.single('document'), async (req, res) => {
  try {
    const vehicle = await db.get('SELECT * FROM vehicles WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
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
    const result = await db.query(
      'INSERT INTO documents (vehicle_id, type, filename, original_name, expiration_date) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [req.params.id, docType, req.file.filename, req.file.originalname, expirationDate]
    );
    await activity.log(req.session.userId, 'DOCUMENT_UPLOADED', `Documento ${docType}: ${req.file.originalname} subido a ${vehicle.plate}`, { vehicleId: req.params.id, documentId: result.rows[0].id, ip: req.ip });
    res.redirect(`/vehicle/${req.params.id}`);
  } catch (err) {
    res.redirect(`/vehicle/${req.params.id}`);
  }
});

router.post('/document/:id/delete', auth, async (req, res) => {
  try {
    const doc = await db.get(
      `SELECT d.*, v.plate, v.user_id FROM documents d
       JOIN vehicles v ON d.vehicle_id = v.id
       WHERE d.id = $1 AND v.user_id = $2`,
      [req.params.id, req.session.userId]
    );
    if (!doc) return res.redirect('/dashboard');
    const filePath = path.join(__dirname, '..', 'public', 'uploads', String(doc.user_id), doc.filename);
    try { fs.unlinkSync(filePath); } catch (e) { }
    await db.run('DELETE FROM documents WHERE id = $1', [req.params.id]);
    await activity.log(req.session.userId, 'DOCUMENT_DELETED', `Documento ${doc.type}: ${doc.original_name} eliminado de ${doc.plate}`, { vehicleId: doc.vehicle_id, documentId: req.params.id, ip: req.ip });
    res.redirect(`/vehicle/${doc.vehicle_id}`);
  } catch (err) {
    res.redirect('/dashboard');
  }
});

router.post('/vehicle/:id/delete', auth, async (req, res) => {
  try {
    const vehicle = await db.get('SELECT * FROM vehicles WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    if (!vehicle) return res.redirect('/dashboard');
    const docs = await db.all('SELECT filename FROM documents WHERE vehicle_id = $1', [req.params.id]);
    docs.forEach(doc => {
      const fp = path.join(__dirname, '..', 'public', 'uploads', String(req.session.userId), doc.filename);
      try { fs.unlinkSync(fp); } catch (e) { }
    });
    await db.run('DELETE FROM vehicles WHERE id = $1', [req.params.id]);
    await activity.log(req.session.userId, 'VEHICLE_DELETED', `Vehículo ${vehicle.brand} ${vehicle.model} (${vehicle.plate}) eliminado`, { vehicleId: req.params.id, ip: req.ip });
    res.redirect('/dashboard');
  } catch (err) {
    res.redirect('/dashboard');
  }
});

router.get('/activity-log', auth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const perPage = 30;
    const totalResult = await db.get('SELECT COUNT(*)::int as c FROM activity_log WHERE user_id = $1', [req.session.userId]);
    const logs = await db.all('SELECT * FROM activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3', [req.session.userId, perPage, (page - 1) * perPage]);
    res.render('activity-log', { logs, page, total: totalResult.c, perPage, userName: req.session.userName });
  } catch (err) {
    res.redirect('/dashboard');
  }
});

module.exports = router;
