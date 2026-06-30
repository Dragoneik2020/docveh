const express = require('express');
const crypto = require('crypto');
const db = require('../models/db');
const auth = require('../middleware/auth');
const activity = require('../models/activity');
const flow = require('../services/flow');
const router = express.Router();

router.get('/subscriptions', auth, (req, res) => {
  const currentPlan = db.prepare('SELECT p.* FROM plans p JOIN users u ON u.plan_id = p.id WHERE u.id = ?').get(req.session.userId);
  const plans = db.prepare('SELECT * FROM plans ORDER BY price ASC').all();
  const vehicleCount = db.prepare('SELECT COUNT(*) as c FROM vehicles WHERE user_id = ?').get(req.session.userId).c;
  const docCount = db.prepare('SELECT COUNT(*) as c FROM documents d JOIN vehicles v ON d.vehicle_id = v.id WHERE v.user_id = ?').get(req.session.userId).c;
  const nfcCount = db.prepare('SELECT COUNT(*) as c FROM nfc_links l JOIN vehicles v ON l.vehicle_id = v.id WHERE v.user_id = ?').get(req.session.userId).c;
  const pendingPayment = db.prepare('SELECT * FROM payments WHERE user_id = ? AND status IN (?, ?) ORDER BY created_at DESC LIMIT 1').get(req.session.userId, 'pending', 'pending_flow');
  const error = req.query.error || null;
  const success = req.query.success || null;

  res.render('subscriptions', {
    currentPlan,
    plans,
    vehicleCount,
    docCount,
    nfcCount,
    pendingPayment,
    error,
    success,
    userName: req.session.userName
  });
});

router.post('/subscriptions/change/:planId', auth, async (req, res) => {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.planId);
  if (!plan) return res.redirect('/subscriptions?error=Plan no encontrado');

  const vehicleCount = db.prepare('SELECT COUNT(*) as c FROM vehicles WHERE user_id = ?').get(req.session.userId).c;
  if (vehicleCount > plan.max_vehicles) {
    return res.redirect('/subscriptions?error=No puedes cambiar a este plan porque tienes ' + vehicleCount + ' vehículos (máximo ' + plan.max_vehicles + ')');
  }

  if (plan.price > 0) {
    const existing = db.prepare('SELECT * FROM payments WHERE user_id = ? AND plan_id = ? AND status IN (?, ?)').get(req.session.userId, plan.id, 'pending', 'pending_flow');
    if (existing) {
      if (existing.flow_url) {
        return res.redirect(existing.flow_url);
      }
      return res.redirect('/payment/' + plan.id + '?msg=Ya tienes un pago pendiente para este plan');
    }
    return res.redirect('/payment/' + plan.id);
  }

  const currentPlan = db.prepare('SELECT p.name FROM plans p JOIN users u ON u.plan_id = p.id WHERE u.id = ?').get(req.session.userId);
  db.prepare('UPDATE users SET plan_id = ? WHERE id = ?').run(plan.id, req.session.userId);
  activity.log(req.session.userId, 'PLAN_CHANGED', 'Plan cambiado de ' + (currentPlan?.name || 'anterior') + ' a ' + plan.name, { ip: req.ip });
  res.redirect('/subscriptions?success=Plan actualizado a ' + plan.name);
});

router.get('/payment/:planId', auth, (req, res) => {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.planId);
  if (!plan || plan.price === 0) return res.redirect('/subscriptions');

  const pendingPayment = db.prepare('SELECT * FROM payments WHERE user_id = ? AND plan_id = ? ORDER BY created_at DESC').get(req.session.userId, plan.id);
  const msg = req.query.msg || null;
  const flowConfigured = flow.isConfigured();

  res.render('payment', { plan, pendingPayment, msg, flowConfigured, userName: req.session.userName });
});

router.post('/payment/submit/:planId', auth, async (req, res) => {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.planId);
  if (!plan || plan.price === 0) return res.redirect('/subscriptions');

  const existing = db.prepare('SELECT * FROM payments WHERE user_id = ? AND plan_id = ? AND status IN (?, ?)').get(req.session.userId, plan.id, 'pending', 'pending_flow');
  if (existing) {
    if (existing.flow_url) return res.redirect(existing.flow_url);
    return res.redirect('/payment/' + plan.id + '?msg=Ya tienes un pago pendiente para este plan');
  }

  if (flow.isConfigured()) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    const reference = 'PAG-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const result = db.prepare('INSERT INTO payments (user_id, plan_id, amount, reference, status) VALUES (?, ?, ?, ?, ?)').run(req.session.userId, plan.id, plan.price, reference, 'pending_flow');

    const rate = parseFloat(process.env.FLOW_EXCHANGE_RATE) || 1000;
    const amountCLP = parseInt(plan.price);
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

    try {
      const flowRes = await flow.createPayment({
        commerceOrder: result.lastInsertRowid,
        email: user.email,
        amount: amountCLP,
        urlConfirmation: baseUrl + '/flow/confirmation',
        urlReturn: baseUrl + '/flow/return?payment_id=' + result.lastInsertRowid
      });

      const checkoutUrl = flowRes.url + '?token=' + flowRes.token;
      db.prepare('UPDATE payments SET flow_order = ?, flow_url = ?, flow_token = ? WHERE id = ?').run(String(flowRes.flowOrder), checkoutUrl, flowRes.token, result.lastInsertRowid);

      activity.log(req.session.userId, 'PAYMENT_FLOW_REDIRECT', 'Redirigido a Flow para pago de ' + plan.name + ' - Orden Flow: ' + flowRes.flowOrder, { ip: req.ip });
      res.redirect(checkoutUrl);
    } catch (err) {
      console.error('Flow error:', err.response?.data || err.message);
      db.prepare('UPDATE payments SET status = ? WHERE id = ?').run('failed', result.lastInsertRowid);
      res.redirect('/payment/' + plan.id + '?msg=Error al conectar con Flow. Intenta nuevamente.');
    }
  } else {
    const reference = 'PAG-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    db.prepare('INSERT INTO payments (user_id, plan_id, amount, reference) VALUES (?, ?, ?, ?)').run(req.session.userId, plan.id, plan.price, reference);
    activity.log(req.session.userId, 'PAYMENT_SUBMITTED', 'Pago de $' + plan.price + ' para plan ' + plan.name + ' (Ref: ' + reference + ')', { ip: req.ip });
    res.redirect('/payment/' + plan.id + '?msg=Pago registrado. Referencia: ' + reference + '. Pendiente de verificación por administrador.');
  }
});

router.post('/payment/:id/cancel', auth, (req, res) => {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ? AND user_id = ? AND status IN (?, ?)').get(req.params.id, req.session.userId, 'pending', 'pending_flow');
  if (!payment) {
    return res.redirect('/subscriptions?error=Pago no encontrado o no se puede cancelar');
  }
  db.prepare('DELETE FROM payments WHERE id = ?').run(payment.id);
  activity.log(req.session.userId, 'PAYMENT_CANCELLED', 'Pago cancelado por el usuario: ' + payment.reference + ' - ' + '$' + payment.amount, { ip: req.ip });
  res.redirect('/subscriptions?success=Pago pendiente cancelado correctamente.');
});

router.post('/flow/confirmation', async (req, res) => {
  try {
    const token = req.body.token;
    if (!token) return res.status(400).send('Token requerido');

    const status = await flow.getPaymentStatus(token);
    const paymentId = parseInt(status.commerceOrder);
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!payment) return res.status(404).send('Pago no encontrado');

    if (status.status === 'approved' || status.status === 1 || status.status === '1') {
      if (payment.status === 'confirmed') return res.send('OK');

      const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(payment.plan_id);
      db.prepare('UPDATE payments SET status = ?, confirmed_at = ? WHERE id = ?').run('confirmed', new Date().toISOString(), payment.id);
      db.prepare('UPDATE users SET plan_id = ? WHERE id = ?').run(payment.plan_id, payment.user_id);

      activity.log(payment.user_id, 'PAYMENT_FLOW_CONFIRMED', 'Pago Flow confirmado - ' + plan.name + ' (Flow Order: ' + status.flowOrder + ')', { ip: req.ip });

      const end = new Date();
      end.setFullYear(end.getFullYear() + 1);
      db.prepare('INSERT INTO subscriptions (user_id, plan_id, status, expires_at, source) VALUES (?, ?, ?, ?, ?)').run(payment.user_id, payment.plan_id, 'active', end.toISOString(), 'purchased');
    }

    res.send('OK');
  } catch (err) {
    console.error('Flow confirmation error:', err.response?.data || err.message);
    res.status(500).send('Error');
  }
});

router.get('/flow/return', auth, (req, res) => {
  const paymentId = req.query.payment_id;
  const token = req.query.token;

  if (!paymentId) return res.redirect('/subscriptions?error=No se encontró el pago');

  const payment = db.prepare('SELECT pay.*, p.name as plan_name FROM payments pay JOIN plans p ON pay.plan_id = p.id WHERE pay.id = ? AND pay.user_id = ?').get(paymentId, req.session.userId);
  if (!payment) return res.redirect('/subscriptions?error=Pago no encontrado');

  if (payment.status === 'confirmed') {
    res.render('flow-return', { success: true, message: 'Pago confirmado. Tu plan ' + payment.plan_name + ' está activo.', userName: req.session.userName });
  } else if (payment.status === 'pending_flow') {
    res.render('flow-return', { success: false, message: 'Pago pendiente de confirmación. Te notificaremos cuando se verifique.', userName: req.session.userName });
  } else if (payment.status === 'rejected' || payment.status === 'failed') {
    res.render('flow-return', { success: false, message: 'El pago no pudo ser procesado. Intenta nuevamente.', userName: req.session.userName });
  } else {
    res.redirect('/subscriptions');
  }
});

module.exports = router;
