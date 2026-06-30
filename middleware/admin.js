const db = require('../models/db');
const { checkExpiredSubscription } = require('./auth');

module.exports = function(req, res, next) {
  if (req.session && req.session.userId && req.session.userRole === 'admin') {
    checkExpiredSubscription(req.session.userId);
    const user = db.prepare('SELECT u.*, p.name as plan_name FROM users u JOIN plans p ON u.plan_id = p.id WHERE u.id = ?').get(req.session.userId);
    if (user) {
      res.locals.userName = req.session.userName;
      res.locals.planName = user.plan_name;
      res.locals.userRole = 'admin';
    }
    next();
  } else {
    res.redirect('/dashboard');
  }
};
