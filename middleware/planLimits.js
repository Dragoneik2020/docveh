const db = require('../models/db');

function getUsage(userId) {
  const vehicleCount = db.prepare('SELECT COUNT(*) as c FROM vehicles WHERE user_id = ?').get(userId).c;
  const docCount = db.prepare('SELECT COUNT(*) as c FROM documents d JOIN vehicles v ON d.vehicle_id = v.id WHERE v.user_id = ?').get(userId).c;
  const nfcCount = db.prepare('SELECT COUNT(*) as c FROM nfc_links l JOIN vehicles v ON l.vehicle_id = v.id WHERE v.user_id = ?').get(userId).c;
  return { vehicleCount, docCount, nfcCount };
}

function checkVehicleLimit(req, res, next) {
  const usage = getUsage(req.session.userId);
  if (usage.vehicleCount >= req.session.plan.max_vehicles) {
    return res.render('new-vehicle', { error: `Has alcanzado el límite de ${req.session.plan.max_vehicles} vehículos de tu plan ${req.session.plan.name}. <a href='/subscriptions'>Mejora tu plan</a>.` });
  }
  next();
}

function checkUploadLimit(req, res, next) {
  const usage = getUsage(req.session.userId);
  if (usage.docCount >= req.session.plan.max_documents) {
    const vehicleId = req.params.id;
    return res.redirect(`/vehicle/${vehicleId}?error=Límite de ${req.session.plan.max_documents} documentos alcanzado. <a href='/subscriptions'>Mejora tu plan</a>.`);
  }
  next();
}

function checkNfcLimit(req, res, next) {
  if (!req.session.plan.has_nfc) {
    const vehicleId = req.params.id;
    return res.redirect(`/vehicle/${vehicleId}?error=Tu plan no incluye enlaces NFC. <a href='/subscriptions'>Mejora tu plan</a>.`);
  }
  const usage = getUsage(req.session.userId);
  if (usage.nfcCount >= req.session.plan.max_nfc_links) {
    const vehicleId = req.params.id;
    return res.redirect(`/vehicle/${vehicleId}?error=Límite de ${req.session.plan.max_nfc_links} enlaces NFC alcanzado.`);
  }
  next();
}

module.exports = { checkVehicleLimit, checkUploadLimit, checkNfcLimit };
