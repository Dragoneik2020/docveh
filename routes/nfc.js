const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../models/db');
const auth = require('../middleware/auth');
const { checkNfcLimit } = require('../middleware/planLimits');
const activity = require('../models/activity');
const router = express.Router();

function getDocStatus(expirationDate) {
  if (!expirationDate) return { label: 'Sin fecha', class: 'doc-status-unknown' };
  const now = new Date();
  const exp = new Date(expirationDate);
  const diffDays = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return { label: 'Vencido', class: 'doc-status-expired' };
  if (diffDays <= 30) return { label: `Vence en ${diffDays} días`, class: 'doc-status-warning' };
  return { label: 'Vigente', class: 'doc-status-valid' };
}

router.post('/vehicle/:id/nfc-generate', auth, checkNfcLimit, (req, res) => {
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!vehicle) return res.redirect('/dashboard');

  const token = uuidv4().replace(/-/g, '').substring(0, 16);
  const pin = req.body.pin || null;

  const result = db.prepare('INSERT INTO nfc_links (vehicle_id, token, pin) VALUES (?, ?, ?)').run(req.params.id, token, pin);
  activity.log(req.session.userId, 'NFC_GENERATED', `Enlace NFC generado para ${vehicle.plate}${pin ? ' con PIN' : ''}`, { vehicleId: req.params.id, nfcId: result.lastInsertRowid, ip: req.ip });
  res.redirect(`/vehicle/${req.params.id}`);
});

router.post('/nfc/:id/toggle', auth, (req, res) => {
  const link = db.prepare(`
    SELECT l.*, v.plate FROM nfc_links l
    JOIN vehicles v ON l.vehicle_id = v.id
    WHERE l.id = ? AND v.user_id = ?
  `).get(req.params.id, req.session.userId);
  if (!link) return res.redirect('/dashboard');

  const newStatus = link.active ? 0 : 1;
  db.prepare('UPDATE nfc_links SET active = ? WHERE id = ?').run(newStatus, req.params.id);
  activity.log(req.session.userId, newStatus ? 'NFC_ACTIVATED' : 'NFC_DEACTIVATED', `Enlace NFC ${newStatus ? 'activado' : 'desactivado'} para ${link.plate}`, { vehicleId: link.vehicle_id, nfcId: req.params.id, ip: req.ip });
  res.redirect(`/vehicle/${link.vehicle_id}`);
});

router.post('/nfc/:id/delete', auth, (req, res) => {
  const link = db.prepare(`
    SELECT l.*, v.plate FROM nfc_links l
    JOIN vehicles v ON l.vehicle_id = v.id
    WHERE l.id = ? AND v.user_id = ?
  `).get(req.params.id, req.session.userId);
  if (!link) return res.redirect('/dashboard');

  db.prepare('DELETE FROM nfc_links WHERE id = ?').run(req.params.id);
  activity.log(req.session.userId, 'NFC_DELETED', `Enlace NFC eliminado de ${link.plate}`, { vehicleId: link.vehicle_id, nfcId: req.params.id, ip: req.ip });
  res.redirect(`/vehicle/${link.vehicle_id}`);
});

router.get('/nfc/:token', (req, res) => {
  const link = db.prepare('SELECT * FROM nfc_links WHERE token = ? AND active = 1').get(req.params.token);
  if (!link) {
    return res.render('nfc-view', { vehicle: null, documents: null, error: 'Enlace NFC no válido o desactivado', pinRequired: false, token: null });
  }

  if (link.pin) {
    if (!req.query.pin) {
      return res.render('nfc-pin', { token: req.params.token, error: null });
    }
    if (req.query.pin !== link.pin) {
      return res.render('nfc-pin', { token: req.params.token, error: 'PIN incorrecto' });
    }
  }

  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(link.vehicle_id);
  const documents = db.prepare('SELECT * FROM documents WHERE vehicle_id = ? ORDER BY uploaded_at DESC').all(link.vehicle_id).map(d => ({
    ...d,
    status: getDocStatus(d.expiration_date),
    url: `/uploads/${vehicle.user_id}/${d.filename}`
  }));

  res.render('nfc-view', {
    vehicle,
    documents,
    error: null,
    pinRequired: false,
    token: req.params.token,
    baseUrl: process.env.BASE_URL || 'http://localhost:3000',
    userId: vehicle.user_id
  });
});

module.exports = router;
