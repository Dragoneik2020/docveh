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

router.post('/vehicle/:id/nfc-generate', auth, checkNfcLimit, async (req, res) => {
  try {
    const vehicle = await db.get('SELECT * FROM vehicles WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
    if (!vehicle) return res.redirect('/dashboard');

    const token = uuidv4().replace(/-/g, '').substring(0, 16);
    const pin = req.body.pin || null;

    const result = await db.query('INSERT INTO nfc_links (vehicle_id, token, pin) VALUES ($1, $2, $3) RETURNING id', [req.params.id, token, pin]);
    await activity.log(req.session.userId, 'NFC_GENERATED', `Enlace NFC generado para ${vehicle.plate}${pin ? ' con PIN' : ''}`, { vehicleId: req.params.id, nfcId: result.rows[0].id, ip: req.ip });
    res.redirect(`/vehicle/${req.params.id}`);
  } catch (err) {
    res.redirect(`/vehicle/${req.params.id}`);
  }
});

router.post('/nfc/:id/toggle', auth, async (req, res) => {
  try {
    const link = await db.get(
      `SELECT l.*, v.plate FROM nfc_links l
       JOIN vehicles v ON l.vehicle_id = v.id
       WHERE l.id = $1 AND v.user_id = $2`,
      [req.params.id, req.session.userId]
    );
    if (!link) return res.redirect('/dashboard');

    const newStatus = link.active ? 0 : 1;
    await db.run('UPDATE nfc_links SET active = $1 WHERE id = $2', [newStatus, req.params.id]);
    await activity.log(req.session.userId, newStatus ? 'NFC_ACTIVATED' : 'NFC_DEACTIVATED', `Enlace NFC ${newStatus ? 'activado' : 'desactivado'} para ${link.plate}`, { vehicleId: link.vehicle_id, nfcId: req.params.id, ip: req.ip });
    res.redirect(`/vehicle/${link.vehicle_id}`);
  } catch (err) {
    res.redirect('/dashboard');
  }
});

router.post('/nfc/:id/delete', auth, async (req, res) => {
  try {
    const link = await db.get(
      `SELECT l.*, v.plate FROM nfc_links l
       JOIN vehicles v ON l.vehicle_id = v.id
       WHERE l.id = $1 AND v.user_id = $2`,
      [req.params.id, req.session.userId]
    );
    if (!link) return res.redirect('/dashboard');

    await db.run('DELETE FROM nfc_links WHERE id = $1', [req.params.id]);
    await activity.log(req.session.userId, 'NFC_DELETED', `Enlace NFC eliminado de ${link.plate}`, { vehicleId: link.vehicle_id, nfcId: req.params.id, ip: req.ip });
    res.redirect(`/vehicle/${link.vehicle_id}`);
  } catch (err) {
    res.redirect('/dashboard');
  }
});

router.get('/nfc/:token', async (req, res) => {
  try {
    const link = await db.get('SELECT * FROM nfc_links WHERE token = $1 AND active = 1', [req.params.token]);
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

    const vehicle = await db.get('SELECT * FROM vehicles WHERE id = $1', [link.vehicle_id]);
    const docRows = await db.all('SELECT * FROM documents WHERE vehicle_id = $1 ORDER BY uploaded_at DESC', [link.vehicle_id]);
    const documents = docRows.map(d => ({
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
  } catch (err) {
    res.render('nfc-view', { vehicle: null, documents: null, error: 'Error al cargar información', pinRequired: false, token: null });
  }
});

module.exports = router;
