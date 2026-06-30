const db = require('../models/db');

async function getUsage(userId) {
  const vehicleResult = await db.get('SELECT COUNT(*)::int as c FROM vehicles WHERE user_id = $1', [userId]);
  const docResult = await db.get('SELECT COUNT(*)::int as c FROM documents d JOIN vehicles v ON d.vehicle_id = v.id WHERE v.user_id = $1', [userId]);
  const nfcResult = await db.get('SELECT COUNT(*)::int as c FROM nfc_links l JOIN vehicles v ON l.vehicle_id = v.id WHERE v.user_id = $1', [userId]);
  return { vehicleCount: vehicleResult.c, docCount: docResult.c, nfcCount: nfcResult.c };
}

async function checkVehicleLimit(req, res, next) {
  try {
    const usage = await getUsage(req.session.userId);
    if (usage.vehicleCount >= req.session.plan.max_vehicles) {
      return res.render('new-vehicle', { error: `Has alcanzado el límite de ${req.session.plan.max_vehicles} vehículos de tu plan ${req.session.plan.name}. <a href='/subscriptions'>Mejora tu plan</a>.` });
    }
    next();
  } catch (err) {
    next(err);
  }
}

async function checkUploadLimit(req, res, next) {
  try {
    const usage = await getUsage(req.session.userId);
    if (usage.docCount >= req.session.plan.max_documents) {
      const vehicleId = req.params.id;
      return res.redirect(`/vehicle/${vehicleId}?error=Límite de ${req.session.plan.max_documents} documentos alcanzado. <a href='/subscriptions'>Mejora tu plan</a>.`);
    }
    next();
  } catch (err) {
    next(err);
  }
}

async function checkNfcLimit(req, res, next) {
  try {
    if (!req.session.plan.has_nfc) {
      const vehicleId = req.params.id;
      return res.redirect(`/vehicle/${vehicleId}?error=Tu plan no incluye enlaces NFC. <a href='/subscriptions'>Mejora tu plan</a>.`);
    }
    const usage = await getUsage(req.session.userId);
    if (usage.nfcCount >= req.session.plan.max_nfc_links) {
      const vehicleId = req.params.id;
      return res.redirect(`/vehicle/${vehicleId}?error=Límite de ${req.session.plan.max_nfc_links} enlaces NFC alcanzado.`);
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { checkVehicleLimit, checkUploadLimit, checkNfcLimit };
