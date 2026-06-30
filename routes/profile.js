const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../models/db');
const auth = require('../middleware/auth');
const activity = require('../models/activity');
const router = express.Router();

const avatarsDir = path.join(__dirname, '..', 'public', 'uploads', 'avatars');
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, avatarsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${req.session.userId}${ext}`);
  }
});
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('Formato no permitido'));
  }
});

router.get('/profile', auth, async (req, res) => {
  try {
    const user = await db.get('SELECT u.*, p.name as plan_name, p.max_vehicles FROM users u JOIN plans p ON u.plan_id = p.id WHERE u.id = $1', [req.session.userId]);
    const error = req.query.error || null;
    const success = req.query.success || null;
    const recentLogs = await db.all('SELECT * FROM activity_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [req.session.userId]);
    res.render('profile', { user, error, success, recentLogs });
  } catch (err) {
    res.redirect('/dashboard');
  }
});

router.post('/profile', auth, (req, res) => {
  uploadAvatar.single('avatar')(req, res, async (err) => {
    if (err) {
      console.error('Multer error:', err.message);
      return res.redirect('/profile?error=' + encodeURIComponent(err.message || 'Error al subir imagen'));
    }

    try {
      const { name, email, currentPassword, newPassword, confirmPassword } = req.body;
      const user = await db.get('SELECT * FROM users WHERE id = $1', [req.session.userId]);

      const finalName = (name && name.trim()) ? name.trim() : user.name;
      const finalEmail = (email && email.trim()) ? email.trim() : user.email;

      if (newPassword) {
        if (!user.password) {
          return res.redirect('/profile?error=Los usuarios de Google deben establecer una contraseña desde la opción correspondiente');
        }
        if (!bcrypt.compareSync(currentPassword, user.password)) {
          return res.redirect('/profile?error=La contraseña actual no es correcta');
        }
        if (newPassword.length < 6) {
          return res.redirect('/profile?error=La nueva contraseña debe tener al menos 6 caracteres');
        }
        if (newPassword !== confirmPassword) {
          return res.redirect('/profile?error=Las contraseñas no coinciden');
        }
        const hash = bcrypt.hashSync(newPassword, 10);
        await db.run('UPDATE users SET name = $1, email = $2, password = $3 WHERE id = $4', [finalName, finalEmail, hash, req.session.userId]);
      } else {
        await db.run('UPDATE users SET name = $1, email = $2 WHERE id = $3', [finalName, finalEmail, req.session.userId]);
      }

      if (req.file) {
        console.log('Avatar file received:', req.file.filename, req.file.path);
        const oldFiles = fs.readdirSync(avatarsDir).filter(f => f.startsWith(req.session.userId + '.'));
        oldFiles.forEach(f => { try { fs.unlinkSync(path.join(avatarsDir, f)); } catch (e) {} });
        const avatarPath = '/uploads/avatars/' + req.file.filename;
        await db.run('UPDATE users SET avatar = $1 WHERE id = $2', [avatarPath, req.session.userId]);
      } else {
        console.log('No file received, body keys:', Object.keys(req.body));
      }

      req.session.userName = finalName;
      await activity.log(req.session.userId, 'PROFILE_UPDATED', 'Perfil actualizado', { ip: req.ip });
      res.redirect('/profile?success=Perfil actualizado correctamente');
    } catch (err) {
      res.redirect('/profile?error=Error al actualizar perfil');
    }
  });
});

module.exports = router;
