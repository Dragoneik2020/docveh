const db = require('../models/db');
const { checkExpiredSubscription } = require('./auth');

module.exports = async function(req, res, next) {
  try {
    if (req.session && req.session.userId && req.session.userRole === 'admin') {
      await checkExpiredSubscription(req.session.userId);
      const user = await db.get(
        'SELECT u.*, p.name as plan_name FROM users u JOIN plans p ON u.plan_id = p.id WHERE u.id = $1',
        [req.session.userId]
      );
      if (user) {
        res.locals.userName = req.session.userName;
        res.locals.planName = user.plan_name;
        res.locals.userRole = 'admin';
      }
      next();
    } else {
      res.redirect('/dashboard');
    }
  } catch (err) {
    next(err);
  }
};
