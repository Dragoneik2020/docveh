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

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL
}, async (token, tokenSecret, profile, done) => {
  try {
    let user = await db.get('SELECT * FROM users WHERE google_id = $1', [profile.id]);
    if (!user) {
      user = await db.get('SELECT * FROM users WHERE email = $1', [profile.emails?.[0]?.value]);
      if (user) {
        await db.run('UPDATE users SET google_id = $1, avatar = $2 WHERE id = $3', [profile.id, profile.photos?.[0]?.value || null, user.id]);
      } else {
        const info = {
          name: profile.displayName,
          email: profile.emails?.[0]?.value || `google_${profile.id}@placeholder.com`,
          google_id: profile.id,
          avatar: profile.photos?.[0]?.value || null,
          password: null
        };
        await db.query('INSERT INTO users (name, email, google_id, avatar, password) VALUES ($1, $2, $3, $4, $5)', [info.name, info.email, info.google_id, info.avatar, info.password]);
        user = await db.get('SELECT * FROM users WHERE google_id = $1', [profile.id]);
      }
    }
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = $1', [id]);
    done(null, user);
  } catch (err) {
    done(err);
  }
});

async function seedAccounts() {
  let existingAdmin = await db.get('SELECT id FROM users WHERE role = $1', ['admin']);
  if (!existingAdmin) {
    const hash = bcrypt.hashSync('admin123', 10);
    await db.query('INSERT INTO users (name, email, password, role, plan_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (email) DO NOTHING', ['Administrador', 'admin@docveh.com', hash, 'admin', 3]);
    console.log('  ✓ Admin creado: admin@docveh.com / admin123');
  } else {
    await db.run('UPDATE users SET plan_id = $1 WHERE role = $2 AND plan_id IS NULL', [3, 'admin']);
  }
  let existingUser = await db.get('SELECT id FROM users WHERE email = $1', ['demo.user@correo.com']);
  if (!existingUser) {
    const hash = bcrypt.hashSync('user123', 10);
    await db.query('INSERT INTO users (name, email, password, role, plan_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (email) DO NOTHING', ['Usuario Demo', 'demo.user@correo.com', hash, 'user', 1]);
    console.log('  ✓ Usuario creado: demo.user@correo.com / user123');
  } else {
    await db.run('UPDATE users SET plan_id = $1 WHERE email = $2 AND plan_id IS NULL', [1, 'demo.user@correo.com']);
  }
  await db.run('UPDATE users SET plan_id = $1 WHERE plan_id IS NULL', [1]);

  const { rows: paidUsers } = await db.query("SELECT u.id, u.plan_id FROM users u WHERE u.plan_id > 1 AND u.id NOT IN (SELECT user_id FROM subscriptions)");
  for (const pu of paidUsers) {
    const end = new Date();
    end.setFullYear(end.getFullYear() + 1);
    await db.query("INSERT INTO subscriptions (user_id, plan_id, status, expires_at, source) VALUES ($1, $2, 'active', $3, 'manual')", [pu.id, pu.plan_id, end.toISOString()]);
  }
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const backup = require('./services/backup');
const auth = require('./middleware/auth');

async function expireSubscriptions() {
  try {
    const subs = await db.all("SELECT user_id FROM subscriptions WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= $1", [new Date().toISOString()]);
    for (const s of subs) {
      try { await auth.checkExpiredSubscription(s.user_id); } catch (e) { }
    }
  } catch (e) { }
}

app.use((req, res, next) => {
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

app.use((req, res, next) => {
  settings.getAll()
    .then(s => {
      res.locals.siteSettings = s;
      res.locals.customCSS = '<style>:root{--cyan:' + (s.primary_color || '#0085CA') + ';--navy:' + (s.navy_color || '#002B6E') + ';--text-color:' + (s.text_color || '#333333') + ';--heading-color:' + (s.heading_color || '#002B6E') + ';--secondary-heading-color:' + (s.secondary_heading_color || '#002B6E') + ';--page-header-color:' + (s.page_header_color || '#002B6E') + ';--detail-bg:' + (s.detail_bg || '#f8f9fa') + ';--detail-color:' + (s.detail_color || '#555555') + ';--link-color:' + (s.link_color || '#0085CA') + ';--navbar-text:' + (s.navbar_text_color || '#ffffff') + ';--btn-text:' + (s.button_text_color || '#ffffff') + ';--admin-primary:' + (s.admin_primary_color || '#6c5ce7') + ';--admin-navbar-bg:' + (s.admin_navbar_bg || '#2d2d2d') + ';--admin-badge-bg:' + (s.admin_badge_bg || '#6c5ce7') + ';--admin-badge-text:' + (s.admin_badge_text || '#ffffff') + ';--admin-card-accent:' + (s.admin_card_accent || '#6c5ce7') + ';--body-bg:' + (s.body_bg || '#f0f2f5') + ';--card-bg:' + (s.card_bg || '#ffffff') + ';--card-border:' + (s.card_border || '#e0e0e0') + ';--success:' + (s.success_color || '#2ecc71') + ';--warning:' + (s.warning_color || '#f39c12') + ';--danger:' + (s.danger_color || '#e74c3c') + ';}</style>';
      next();
    })
    .catch(next);
});

app.use('/', authRoutes);
app.use('/', vehicleRoutes);
app.use('/', nfcRoutes);
app.use('/', adminRoutes);
app.use('/', profileRoutes);
app.use('/', subscriptionRoutes);

app.get('/', async (req, res) => {
  try {
    if (req.session.userId) {
      if (req.session.userRole === 'admin') return res.redirect('/admin');
      return res.redirect('/dashboard');
    }
    const plans = await db.all('SELECT * FROM plans ORDER BY price ASC');
    res.render('index', { siteSettings: res.locals.siteSettings, plans });
  } catch (err) {
    res.redirect('/login');
  }
});

async function main() {
  try {
    await db.init();
    expireSubscriptions();
    setInterval(expireSubscriptions, 60 * 60 * 1000);
    backup.startAutoBackup(30);

    await seedAccounts();

    app.listen(PORT, () => {
      console.log(`\n  DocVeh SaaS corriendo en http://localhost:${PORT}`);
      console.log(`  ─────────────────────────────`);
      console.log(`  Admin: admin@docveh.com / admin123`);
      console.log(`  User:  demo.user@correo.com  / user123\n`);
    });
  } catch (err) {
    console.error('Error during startup:', err);
    process.exit(1);
  }
}

main();
