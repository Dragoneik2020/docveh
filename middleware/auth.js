const db = require('../models/db');

async function checkExpiredSubscription(userId) {
  const sub = await db.get(
    "SELECT * FROM subscriptions WHERE user_id = $1 AND status = 'active' AND expires_at IS NOT NULL ORDER BY expires_at DESC LIMIT 1",
    [userId]
  );
  if (sub) {
    const now = new Date();
    const exp = new Date(sub.expires_at);
    if (exp <= now) {
      await db.run("UPDATE subscriptions SET status = 'expired' WHERE id = $1", [sub.id]);
      await db.run('UPDATE users SET plan_id = 1 WHERE id = $1', [userId]);
      return true;
    }
  }
  return false;
}

module.exports = async function(req, res, next) {
  try {
    if (req.session && req.session.userId) {
      await checkExpiredSubscription(req.session.userId);
      const user = await db.get(
        'SELECT u.*, p.name as plan_name, p.max_vehicles, p.max_documents, p.max_nfc_links, p.has_pin_protection, p.max_file_size, p.has_nfc FROM users u JOIN plans p ON u.plan_id = p.id WHERE u.id = $1',
        [req.session.userId]
      );
      if (user) {
        req.session.plan = {
          name: user.plan_name,
          max_vehicles: user.max_vehicles,
          max_documents: user.max_documents,
          max_nfc_links: user.max_nfc_links,
          has_pin_protection: !!user.has_pin_protection,
          max_file_size: user.max_file_size,
          has_nfc: !!user.has_nfc
        };
        res.locals.userName = req.session.userName;
        res.locals.planName = user.plan_name;
        res.locals.userRole = user.role;
      }
      next();
    } else {
      res.redirect('/login');
    }
  } catch (err) {
    next(err);
  }
};

module.exports.checkExpiredSubscription = checkExpiredSubscription;
