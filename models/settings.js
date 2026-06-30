const db = require('./db');

async function getAll() {
  const rows = await db.all('SELECT key, value FROM settings');
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
}

async function get(key) {
  const r = await db.get('SELECT value FROM settings WHERE key = $1', [key]);
  return r ? r.value : null;
}

async function set(key, value) {
  await db.run(
    'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at',
    [key, value, new Date().toISOString()]
  );
}

module.exports = { getAll, get, set };
