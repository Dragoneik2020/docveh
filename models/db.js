const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function query(text, params) {
  return pool.query(text, params);
}

async function get(text, params) {
  const result = await pool.query(text, params);
  return result.rows[0] || null;
}

async function all(text, params) {
  const result = await pool.query(text, params);
  return result.rows;
}

async function run(text, params) {
  return pool.query(text, params);
}

async function columnExists(table, column) {
  const result = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return result.rows.length > 0;
}

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plans (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price INTEGER NOT NULL,
      max_vehicles INTEGER NOT NULL,
      max_documents INTEGER NOT NULL,
      max_nfc_links INTEGER NOT NULL,
      has_pin_protection INTEGER DEFAULT 0,
      has_nfc INTEGER DEFAULT 1,
      max_file_size INTEGER DEFAULT 10,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT,
      google_id TEXT UNIQUE,
      avatar TEXT,
      role TEXT DEFAULT 'user',
      plan_id INTEGER DEFAULT 1,
      subscription_end TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (plan_id) REFERENCES plans(id)
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      brand TEXT NOT NULL,
      model TEXT NOT NULL,
      year TEXT NOT NULL,
      plate TEXT NOT NULL,
      vin TEXT,
      owner_name TEXT,
      owner_dni TEXT,
      color TEXT,
      fuel_type TEXT,
      engine_capacity TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      vehicle_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      expiration_date TEXT,
      uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      plan_id INTEGER NOT NULL,
      status TEXT DEFAULT 'active',
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP,
      source TEXT DEFAULT 'purchased',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (plan_id) REFERENCES plans(id)
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      action TEXT NOT NULL,
      description TEXT,
      vehicle_id INTEGER,
      document_id INTEGER,
      nfc_id INTEGER,
      ip_address TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      plan_id INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      reference TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'pending',
      flow_order TEXT,
      flow_url TEXT,
      flow_token TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      confirmed_at TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (plan_id) REFERENCES plans(id)
    );

    CREATE TABLE IF NOT EXISTS nfc_links (
      id SERIAL PRIMARY KEY,
      vehicle_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      pin TEXT,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const { rows: planRows } = await pool.query('SELECT COUNT(*)::int as c FROM plans');
  if (planRows[0].c === 0) {
    await pool.query(
      'INSERT INTO plans (name, description, price, max_vehicles, max_documents, max_nfc_links, has_pin_protection, max_file_size, has_nfc) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      ['Gratuito', 'Para empezar con lo esencial', 0, 1, 10, 2, 0, 5, 1]
    );
    await pool.query(
      'INSERT INTO plans (name, description, price, max_vehicles, max_documents, max_nfc_links, has_pin_protection, max_file_size, has_nfc) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      ['Básico', 'Para conductores particulares', 4990, 3, 50, 10, 1, 10, 1]
    );
    await pool.query(
      'INSERT INTO plans (name, description, price, max_vehicles, max_documents, max_nfc_links, has_pin_protection, max_file_size, has_nfc) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      ['Premium', 'Para familias y profesionales', 9990, 10, 200, 50, 1, 20, 1]
    );
    console.log('  ✓ Planes creados: Gratuito, Básico ($4990), Premium ($9990)');
  }

  await migrate();

  const { rows: settingsRows } = await pool.query('SELECT COUNT(*)::int as c FROM settings');
  if (settingsRows[0].c === 0) {
    const defaultSettings = [
      ['site_name', 'DocVeh'],
      ['site_description', 'Documentación Vehicular NFC - Sube, almacena y comparte la documentación de tus vehículos'],
      ['hero_title', 'Tu documentación vehicular <span>siempre a mano</span>'],
      ['hero_subtitle', 'Sube, almacena y comparte la documentación de tus vehículos de forma segura. Accede con un simple toque NFC.'],
      ['hero_cta', 'Comenzar Gratis'],
      ['feature1_title', 'Documentos Digitales'],
      ['feature1_desc', 'Sube tus documentos (seguro, ITV, matriculación) en formato PDF y mantenlos siempre accesibles.'],
      ['feature1_icon', '📄'],
      ['feature2_title', 'Acceso NFC'],
      ['feature2_desc', 'Genera enlaces únicos para cada vehículo. Escríbelos en una etiqueta NFC y accede con tu móvil.'],
      ['feature2_icon', '📱'],
      ['feature3_title', 'Seguro y Privado'],
      ['feature3_desc', 'Protege tus enlaces NFC con PIN. Controla qué documentos compartes y con quién.'],
      ['feature3_icon', '🔒'],
      ['plans_title', 'Planes para cada necesidad'],
      ['footer_text', 'DocVeh - Documentación Vehicular NFC. Todos los derechos reservados.'],
      ['primary_color', '#0085CA'],
      ['navy_color', '#002B6E'],
      ['text_color', '#333333'],
      ['heading_color', '#002B6E'],
      ['secondary_heading_color', '#002B6E'],
      ['page_header_color', '#002B6E'],
      ['detail_bg', '#f8f9fa'],
      ['detail_color', '#555555'],
      ['link_color', '#0085CA'],
      ['navbar_text_color', '#ffffff'],
      ['button_text_color', '#ffffff'],
      ['admin_primary_color', '#6c5ce7'],
      ['admin_navbar_bg', '#2d2d2d'],
      ['admin_badge_bg', '#6c5ce7'],
      ['admin_badge_text', '#ffffff'],
      ['admin_card_accent', '#6c5ce7'],
      ['body_bg', '#f0f2f5'],
      ['card_bg', '#ffffff'],
      ['card_border', '#e0e0e0'],
      ['success_color', '#2ecc71'],
      ['warning_color', '#f39c12'],
      ['danger_color', '#e74c3c'],
    ];
    for (const [k, v] of defaultSettings) {
      await pool.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
        [k, v]
      );
    }
    console.log('  ✓ Configuración inicial creada');
  }
}

async function migrate() {
  const vehicleCols = ['vin', 'owner_name', 'owner_dni', 'color', 'fuel_type', 'engine_capacity'];
  for (const col of vehicleCols) {
    const exists = await columnExists('vehicles', col);
    if (!exists) {
      await pool.query(`ALTER TABLE vehicles ADD COLUMN ${col} TEXT`);
    }
  }

  const docCol = await columnExists('documents', 'expiration_date');
  if (!docCol) {
    await pool.query('ALTER TABLE documents ADD COLUMN expiration_date TEXT');
  }

  const payCols = ['flow_order', 'flow_url', 'flow_token'];
  for (const col of payCols) {
    const exists = await columnExists('payments', col);
    if (!exists) {
      await pool.query(`ALTER TABLE payments ADD COLUMN ${col} TEXT`);
    }
  }

  const planCol = await columnExists('plans', 'has_nfc');
  if (!planCol) {
    await pool.query('ALTER TABLE plans ADD COLUMN has_nfc INTEGER DEFAULT 1');
    await pool.query('UPDATE plans SET has_nfc = 1');
  }

  const subCol = await columnExists('subscriptions', 'source');
  if (!subCol) {
    await pool.query("ALTER TABLE subscriptions ADD COLUMN source TEXT DEFAULT 'purchased'");
    await pool.query("UPDATE subscriptions SET source = 'manual'");
  }

  const userCol = await columnExists('users', 'avatar');
  if (!userCol) {
    await pool.query('ALTER TABLE users ADD COLUMN avatar TEXT');
  }

  const { rows: priceRows } = await pool.query("SELECT id, price FROM plans WHERE price < 100");
  for (const p of priceRows) {
    await pool.query('UPDATE plans SET price = $1 WHERE id = $2', [Math.round(p.price * 1000), p.id]);
  }
}

module.exports = { pool, query, get, all, run, init };
