const express = require('express');
const bcrypt = require('bcryptjs');
const passport = require('passport');
const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const activity = require('../models/activity');
const { notifyNewUser } = require('../services/notifications');
const router = express.Router();

router.get('/register', (req, res) => {
  res.render('register', { error: null });
});

router.post('/register', async (req, res) => {
  const { name, email, password, confirmPassword } = req.body;
  if (!name || !email || !password || !confirmPassword) {
    return res.render('register', { error: 'Todos los campos son obligatorios' });
  }
  if (password !== confirmPassword) {
    return res.render('register', { error: 'Las contraseñas no coinciden' });
  }
  if (password.length < 6) {
    return res.render('register', { error: 'La contraseña debe tener al menos 6 caracteres' });
  }
  try {
    const existing = await db.get('SELECT id FROM users WHERE email = $1', [email]);
    if (existing) {
      return res.render('register', { error: 'El email ya está registrado' });
    }
    const hashed = bcrypt.hashSync(password, 10);
    const result = await db.query('INSERT INTO users (name, email, password, plan_id) VALUES ($1, $2, $3, $4) RETURNING id', [name, email, hashed, 1]);
    const newId = result.rows[0].id;
    fs.mkdirSync(path.join(__dirname, '..', 'public', 'uploads', String(newId)), { recursive: true });
    await activity.log(newId, 'ACCOUNT_CREATED', `Cuenta creada con email ${email}`, { ip: req.ip });
    notifyNewUser({ name, email });
    res.redirect('/login');
  } catch (err) {
    res.render('register', { error: 'Error al registrar usuario' });
  }
});

router.get('/login', (req, res) => {
  res.render('login', { error: null, googleClientId: process.env.GOOGLE_CLIENT_ID });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.render('login', { error: 'Todos los campos son obligatorios', googleClientId: process.env.GOOGLE_CLIENT_ID });
  }
  try {
    const user = await db.get('SELECT * FROM users WHERE email = $1', [email]);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.render('login', { error: 'Email o contraseña incorrectos', googleClientId: process.env.GOOGLE_CLIENT_ID });
    }
    req.session.userId = user.id;
    req.session.userName = user.name;
    req.session.userRole = user.role;
    await activity.log(user.id, 'LOGIN', 'Inicio de sesión', { ip: req.ip });
    if (user.role === 'admin') return res.redirect('/admin');
    res.redirect('/dashboard');
  } catch (err) {
    res.render('login', { error: 'Error al iniciar sesión', googleClientId: process.env.GOOGLE_CLIENT_ID });
  }
});

router.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

router.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  async (req, res) => {
    req.session.userId = req.user.id;
    req.session.userName = req.user.name;
    req.session.userRole = req.user.role;
    fs.mkdirSync(path.join(__dirname, '..', 'public', 'uploads', String(req.user.id)), { recursive: true });
    await activity.log(req.user.id, 'LOGIN_GOOGLE', 'Inicio de sesión con Google', { ip: req.ip });
    if (req.user.role === 'admin') return res.redirect('/admin');
    res.redirect('/dashboard');
  }
);

router.get('/logout', async (req, res) => {
  if (req.session.userId) {
    await activity.log(req.session.userId, 'LOGOUT', 'Cierre de sesión', { ip: req.ip });
  }
  req.session.destroy();
  res.redirect('/login');
});

module.exports = router;
