const db = require('./db');

async function log(userId, action, description, extras = {}) {
  try {
    await db.run(
      'INSERT INTO activity_log (user_id, action, description, vehicle_id, document_id, nfc_id, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [
        userId || null,
        action,
        description || '',
        extras.vehicleId || null,
        extras.documentId || null,
        extras.nfcId || null,
        extras.ip || null
      ]
    );
  } catch (err) {
    console.error('Error logging activity:', err.message);
  }
}

module.exports = { log };
