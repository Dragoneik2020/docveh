const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'database.sqlite');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    max_vehicles INTEGER NOT NULL,
    max_documents INTEGER NOT NULL,
    max_nfc_links INTEGER NOT NULL,
    has_pin_protection INTEGER DEFAULT 0,
    has_nfc INTEGER DEFAULT 1,
    max_file_size INTEGER DEFAULT 10,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT,
    google_id TEXT UNIQUE,
    avatar TEXT,
    role TEXT DEFAULT 'user',
    plan_id INTEGER DEFAULT 1,
    subscription_end DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (plan_id) REFERENCES plans(id)
  );

  CREATE TABLE IF NOT EXISTS vehicles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    expiration_date TEXT,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan_id INTEGER NOT NULL,
    status TEXT DEFAULT 'active',
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    source TEXT DEFAULT 'purchased',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES plans(id)
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    description TEXT,
    vehicle_id INTEGER,
    document_id INTEGER,
    nfc_id INTEGER,
    ip_address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plan_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    reference TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'pending',
    flow_order TEXT,
    flow_url TEXT,
    flow_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    confirmed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES plans(id)
  );

  CREATE TABLE IF NOT EXISTS nfc_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    pin TEXT,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
  );
`);

// Seed plans
const planCount = db.prepare('SELECT COUNT(*) as c FROM plans').get().c;
if (planCount === 0) {
  db.prepare('INSERT INTO plans (name, description, price, max_vehicles, max_documents, max_nfc_links, has_pin_protection, max_file_size, has_nfc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('Gratuito', 'Para empezar con lo esencial', 0, 1, 10, 2, 0, 5, 1);
  db.prepare('INSERT INTO plans (name, description, price, max_vehicles, max_documents, max_nfc_links, has_pin_protection, max_file_size, has_nfc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('Básico', 'Para conductores particulares', 4990, 3, 50, 10, 1, 10, 1);
  db.prepare('INSERT INTO plans (name, description, price, max_vehicles, max_documents, max_nfc_links, has_pin_protection, max_file_size, has_nfc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('Premium', 'Para familias y profesionales', 9990, 10, 200, 50, 1, 20, 1);
  console.log('  ✓ Planes creados: Gratuito, Básico ($4990), Premium ($9990)');
  console.log('  ✓ Planes creados: Gratuito, Básico (4.99€), Premium (9.99€)');
}

// Migrations for existing databases
function migrate() {
  const cols = db.prepare("PRAGMA table_info('vehicles')").all().map(c => c.name);
  if (!cols.includes('vin')) db.exec("ALTER TABLE vehicles ADD COLUMN vin TEXT");
  if (!cols.includes('owner_name')) db.exec("ALTER TABLE vehicles ADD COLUMN owner_name TEXT");
  if (!cols.includes('owner_dni')) db.exec("ALTER TABLE vehicles ADD COLUMN owner_dni TEXT");
  if (!cols.includes('color')) db.exec("ALTER TABLE vehicles ADD COLUMN color TEXT");
  if (!cols.includes('fuel_type')) db.exec("ALTER TABLE vehicles ADD COLUMN fuel_type TEXT");
  if (!cols.includes('engine_capacity')) db.exec("ALTER TABLE vehicles ADD COLUMN engine_capacity TEXT");

  const docCols = db.prepare("PRAGMA table_info('documents')").all().map(c => c.name);
  if (!docCols.includes('expiration_date')) db.exec("ALTER TABLE documents ADD COLUMN expiration_date TEXT");

  const payCols = db.prepare("PRAGMA table_info('payments')").all().map(c => c.name);
  if (payCols.length === 0) {
    db.exec(`CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      plan_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      reference TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'pending',
      flow_order TEXT,
      flow_url TEXT,
      flow_token TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      confirmed_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (plan_id) REFERENCES plans(id)
    )`);
  } else {
    if (!payCols.includes('flow_order')) db.exec("ALTER TABLE payments ADD COLUMN flow_order TEXT");
    if (!payCols.includes('flow_url')) db.exec("ALTER TABLE payments ADD COLUMN flow_url TEXT");
    if (!payCols.includes('flow_token')) db.exec("ALTER TABLE payments ADD COLUMN flow_token TEXT");
  }

  const logCols = db.prepare("PRAGMA table_info('activity_log')").all().map(c => c.name);
  if (logCols.length === 0) {
    db.exec(`CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      description TEXT,
      vehicle_id INTEGER,
      document_id INTEGER,
      nfc_id INTEGER,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }

  const planCols = db.prepare("PRAGMA table_info('plans')").all().map(c => c.name);
  if (!planCols.includes('has_nfc')) {
    db.exec("ALTER TABLE plans ADD COLUMN has_nfc INTEGER DEFAULT 1");
    db.prepare("UPDATE plans SET has_nfc = 1").run();
  }

  const subCols = db.prepare("PRAGMA table_info('subscriptions')").all().map(c => c.name);
  if (!subCols.includes('source')) {
    db.exec("ALTER TABLE subscriptions ADD COLUMN source TEXT DEFAULT 'purchased'");
    db.prepare("UPDATE subscriptions SET source = 'manual'").run();
  }

  // Convert decimal prices to integers
  const priceCheck = db.prepare("SELECT id, price FROM plans WHERE price < 100").all();
  for (const p of priceCheck) {
    db.prepare("UPDATE plans SET price = ? WHERE id = ?").run(Math.round(p.price * 1000), p.id);
  }

  const userCols = db.prepare("PRAGMA table_info('users')").all().map(c => c.name);
  if (!userCols.includes('avatar')) {
    db.exec("ALTER TABLE users ADD COLUMN avatar TEXT");
  }
}
migrate();

// Settings table
const settingsCols = db.prepare("PRAGMA table_info('settings')").all().map(c => c.name);
if (settingsCols.length === 0) {
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
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
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of defaultSettings) insert.run(k, v);
  console.log('  ✓ Configuración inicial creada');
}

module.exports = db;
