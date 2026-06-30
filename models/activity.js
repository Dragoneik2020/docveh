const db = require('./db');

function log(userId, action, description, extras = {}) {
  try {
    db.prepare('INSERT INTO activity_log (user_id, action, description, vehicle_id, document_id, nfc_id, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      userId || null,
      action,
      description || '',
      extras.vehicleId || null,
      extras.documentId || null,
      extras.nfcId || null,
      extras.ip || null
    );
  } catch (err) {
    console.error('Error logging activity:', err.message);
  }
}

module.exports = { log };
