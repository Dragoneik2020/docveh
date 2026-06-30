require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const path = require('path');

const bcrypt = require('bcryptjs');
const db = require('./models/db');
const settings = require('./models/settings');
const authRoutes = require('./routes/auth');
const vehicleRoutes = require('./routes/vehicles');
const nfcRoutes = require('./routes/nfc');
const adminRoutes = require('./routes/admin');
const profileRoutes = require('./routes/profile');
const subscriptionRoutes = require('./routes/subscriptions');

const app = express();
const PORT = process.env.PORT || 3000;

// Passport
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL
}, (token, tokenSecret, profile, done) => {
  let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(profile.id);
  if (!user) {
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(profile.emails?.[0]?.value);
    if (user) {
      db.prepare('UPDATE users SET google_id = ?, avatar = ? WHERE id = ?').run(profile.id, profile.photos?.[0]?.value || null, user.id);
    } else {
      const info = {
        name: profile.displayName,
        email: profile.emails?.[0]?.value || `google_${profile.id}@placeholder.com`,
        google_id: profile.id,
        avatar: profile.photos?.[0]?.value || null,
        password: null
      };
      db.prepare('INSERT INTO users (name, email, google_id, avatar, password) VALUES (?, ?, ?, ?, ?)').run(info.name, info.email, info.google_id, info.avatar, info.password);
      user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(profile.id);
    }
  }
  return done(null, user);
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  done(null, user);
});

function seedAccounts() {
  const existingAdmin = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (!existingAdmin) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT OR IGNORE INTO users (name, email, password, role, plan_id) VALUES (?, ?, ?, ?, ?)').run('Administrador', 'admin@docveh.com', hash, 'admin', 3);
    console.log('  ✓ Admin creado: admin@docveh.com / admin123');
  } else {
    db.prepare('UPDATE users SET plan_id = ? WHERE role = ? AND plan_id IS NULL').run(3, 'admin');
  }
  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get('demo.user@correo.com');
  if (!existingUser) {
    const hash = bcrypt.hashSync('user123', 10);
    db.prepare('INSERT OR IGNORE INTO users (name, email, password, role, plan_id) VALUES (?, ?, ?, ?, ?)').run('Usuario Demo', 'demo.user@correo.com', hash, 'user', 1);
    console.log('  ✓ Usuario creado: demo.user@correo.com / user123');
  } else {
    db.prepare('UPDATE users SET plan_id = ? WHERE email = ? AND plan_id IS NULL').run(1, 'demo.user@correo.com');
  }
  // Set default plan for any users without one
  db.prepare('UPDATE users SET plan_id = ? WHERE plan_id IS NULL').run(1);

  // Create subscription records for users with paid plans who lack one
  const paidUsers = db.prepare("SELECT u.id, u.plan_id FROM users u WHERE u.plan_id > 1 AND u.id NOT IN (SELECT user_id FROM subscriptions)").all();
  for (const pu of paidUsers) {
    const end = new Date();
    end.setFullYear(end.getFullYear() + 1);
    db.prepare("INSERT INTO subscriptions (user_id, plan_id, status, expires_at, source) VALUES (?, ?, 'active', ?, 'manual')").run(pu.id, pu.plan_id, end.toISOString());
  }
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const backup = require('./services/backup');
const { checkExpiredSubscription } = require('./middleware/auth');
app.use((req, res, next) => {

// Check expired subscriptions every hour
function expireSubscriptions() {
  const db = require('./models/db');
  const subs = db.prepare("SELECT user_id FROM subscriptions WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?").all(new Date().toISOString());
  for (const s of subs) {
    try { checkExpiredSubscription(s.user_id); } catch (e) { }
  }
}
expireSubscriptions();
setInterval(expireSubscriptions, 60 * 60 * 1000);
  if (req.method === 'POST' && !req.path.startsWith('/login') && !req.path.startsWith('/register') && !req.path.startsWith('/auth')) {
    backup.backupIfNeeded(5);
  }
  next();
});
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

// Make settings available in all templates
app.use((req, res, next) => {
  const s = settings.getAll();
  res.locals.siteSettings = s;
  res.locals.customCSS = '<style>:root{--cyan:' + (s.primary_color || '#0085CA') + ';--navy:' + (s.navy_color || '#002B6E') + ';--text-color:' + (s.text_color || '#333333') + ';--heading-color:' + (s.heading_color || '#002B6E') + ';--link-color:' + (s.link_color || '#0085CA') + ';--navbar-text:' + (s.navbar_text_color || '#ffffff') + ';--btn-text:' + (s.button_text_color || '#ffffff') + ';--admin-primary:' + (s.admin_primary_color || '#6c5ce7') + ';--admin-navbar-bg:' + (s.admin_navbar_bg || '#2d2d2d') + ';--admin-badge-bg:' + (s.admin_badge_bg || '#6c5ce7') + ';--admin-badge-text:' + (s.admin_badge_text || '#ffffff') + ';--admin-card-accent:' + (s.admin_card_accent || '#6c5ce7') + ';--body-bg:' + (s.body_bg || '#f0f2f5') + ';--card-bg:' + (s.card_bg || '#ffffff') + ';--card-border:' + (s.card_border || '#e0e0e0') + ';--success:' + (s.success_color || '#2ecc71') + ';--warning:' + (s.warning_color || '#f39c12') + ';--danger:' + (s.danger_color || '#e74c3c') + ';}</style>';
  next();
});

app.use('/', authRoutes);
app.use('/', vehicleRoutes);
app.use('/', nfcRoutes);
app.use('/', adminRoutes);
app.use('/', profileRoutes);
app.use('/', subscriptionRoutes);

app.get('/', (req, res) => {
  if (req.session.userId) {
    if (req.session.userRole === 'admin') return res.redirect('/admin');
    return res.redirect('/dashboard');
  }
  const plans = db.prepare('SELECT * FROM plans ORDER BY price ASC').all();
  res.render('index', { siteSettings: res.locals.siteSettings, plans });
});

seedAccounts();

backup.startAutoBackup(30);

app.listen(PORT, () => {
  console.log(`\n  DocVeh SaaS corriendo en http://localhost:${PORT}`);
  console.log(`  ─────────────────────────────`);
  console.log(`  Admin: admin@docveh.com / admin123`);
  console.log(`  User:  demo.user@correo.com  / user123\n`);
});
