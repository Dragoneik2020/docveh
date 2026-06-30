const db = require('../models/db');

function checkExpiredSubscription(userId) {
  const sub = db.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' AND expires_at IS NOT NULL ORDER BY expires_at DESC LIMIT 1").get(userId);
  if (sub) {
    const now = new Date();
    const exp = new Date(sub.expires_at);
    if (exp <= now) {
      db.prepare("UPDATE subscriptions SET status = 'expired' WHERE id = ?").run(sub.id);
      db.prepare('UPDATE users SET plan_id = 1 WHERE id = ?').run(userId);
      return true;
    }
  }
  return false;
}

module.exports = function(req, res, next) {
  if (req.session && req.session.userId) {
    checkExpiredSubscription(req.session.userId);
    const user = db.prepare('SELECT u.*, p.name as plan_name, p.max_vehicles, p.max_documents, p.max_nfc_links, p.has_pin_protection, p.max_file_size, p.has_nfc FROM users u JOIN plans p ON u.plan_id = p.id WHERE u.id = ?').get(req.session.userId);
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
};

module.exports.checkExpiredSubscription = checkExpiredSubscription;
