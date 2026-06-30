const express = require('express');
const crypto = require('crypto');
const db = require('../models/db');
const auth = require('../middleware/auth');
const activity = require('../models/activity');
const flow = require('../services/flow');
const router = express.Router();

router.get('/subscriptions', auth, async (req, res) => {
  try {
    const currentPlan = await db.get('SELECT p.* FROM plans p JOIN users u ON u.plan_id = p.id WHERE u.id = $1', [req.session.userId]);
    const plans = await db.all('SELECT * FROM plans ORDER BY price ASC');
    const vehicleResult = await db.get('SELECT COUNT(*)::int as c FROM vehicles WHERE user_id = $1', [req.session.userId]);
    const docResult = await db.get('SELECT COUNT(*)::int as c FROM documents d JOIN vehicles v ON d.vehicle_id = v.id WHERE v.user_id = $1', [req.session.userId]);
    const nfcResult = await db.get('SELECT COUNT(*)::int as c FROM nfc_links l JOIN vehicles v ON l.vehicle_id = v.id WHERE v.user_id = $1', [req.session.userId]);
    const pendingPayment = await db.get('SELECT * FROM payments WHERE user_id = $1 AND (status = $2 OR status = $3) ORDER BY created_at DESC LIMIT 1', [req.session.userId, 'pending', 'pending_flow']);
    const error = req.query.error || null;
    const success = req.query.success || null;

    res.render('subscriptions', {
      currentPlan,
      plans,
      vehicleCount: vehicleResult.c,
      docCount: docResult.c,
      nfcCount: nfcResult.c,
      pendingPayment,
      error,
      success,
      userName: req.session.userName
    });
  } catch (err) {
    res.redirect('/dashboard');
  }
});

router.post('/subscriptions/change/:planId', auth, async (req, res) => {
  try {
    const plan = await db.get('SELECT * FROM plans WHERE id = $1', [req.params.planId]);
    if (!plan) return res.redirect('/subscriptions?error=Plan no encontrado');

    const vehicleResult = await db.get('SELECT COUNT(*)::int as c FROM vehicles WHERE user_id = $1', [req.session.userId]);
    if (vehicleResult.c > plan.max_vehicles) {
      return res.redirect('/subscriptions?error=No puedes cambiar a este plan porque tienes ' + vehicleResult.c + ' vehículos (máximo ' + plan.max_vehicles + ')');
    }

    if (plan.price > 0) {
      const existing = await db.get('SELECT * FROM payments WHERE user_id = $1 AND plan_id = $2 AND (status = $3 OR status = $4)', [req.session.userId, plan.id, 'pending', 'pending_flow']);
      if (existing) {
        if (existing.flow_url) {
          return res.redirect(existing.flow_url);
        }
        return res.redirect('/payment/' + plan.id + '?msg=Ya tienes un pago pendiente para este plan');
      }
      return res.redirect('/payment/' + plan.id);
    }

    const currentPlan = await db.get('SELECT p.name FROM plans p JOIN users u ON u.plan_id = p.id WHERE u.id = $1', [req.session.userId]);
    await db.run('UPDATE users SET plan_id = $1 WHERE id = $2', [plan.id, req.session.userId]);
    await activity.log(req.session.userId, 'PLAN_CHANGED', 'Plan cambiado de ' + (currentPlan?.name || 'anterior') + ' a ' + plan.name, { ip: req.ip });
    res.redirect('/subscriptions?success=Plan actualizado a ' + plan.name);
  } catch (err) {
    res.redirect('/subscriptions?error=Error al cambiar de plan');
  }
});

router.get('/payment/:planId', auth, async (req, res) => {
  try {
    const plan = await db.get('SELECT * FROM plans WHERE id = $1', [req.params.planId]);
    if (!plan || plan.price === 0) return res.redirect('/subscriptions');

    const pendingPayment = await db.get('SELECT * FROM payments WHERE user_id = $1 AND plan_id = $2 ORDER BY created_at DESC', [req.session.userId, plan.id]);
    const msg = req.query.msg || null;
    const flowConfigured = flow.isConfigured();

    res.render('payment', { plan, pendingPayment, msg, flowConfigured, userName: req.session.userName });
  } catch (err) {
    res.redirect('/subscriptions');
  }
});

router.post('/payment/submit/:planId', auth, async (req, res) => {
  try {
    const plan = await db.get('SELECT * FROM plans WHERE id = $1', [req.params.planId]);
    if (!plan || plan.price === 0) return res.redirect('/subscriptions');

    const existing = await db.get('SELECT * FROM payments WHERE user_id = $1 AND plan_id = $2 AND (status = $3 OR status = $4)', [req.session.userId, plan.id, 'pending', 'pending_flow']);
    if (existing) {
      if (existing.flow_url) return res.redirect(existing.flow_url);
      return res.redirect('/payment/' + plan.id + '?msg=Ya tienes un pago pendiente para este plan');
    }

    if (flow.isConfigured()) {
      const user = await db.get('SELECT * FROM users WHERE id = $1', [req.session.userId]);
      const reference = 'PAG-' + crypto.randomBytes(6).toString('hex').toUpperCase();
      const result = await db.query('INSERT INTO payments (user_id, plan_id, amount, reference, status) VALUES ($1, $2, $3, $4, $5) RETURNING id', [req.session.userId, plan.id, plan.price, reference, 'pending_flow']);

      const rate = parseFloat(process.env.FLOW_EXCHANGE_RATE) || 1000;
      const amountCLP = parseInt(plan.price);
      const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

      try {
        const flowRes = await flow.createPayment({
          commerceOrder: result.rows[0].id,
          email: user.email,
          amount: amountCLP,
          urlConfirmation: baseUrl + '/flow/confirmation',
          urlReturn: baseUrl + '/flow/return?payment_id=' + result.rows[0].id
        });

        const checkoutUrl = flowRes.url + '?token=' + flowRes.token;
        await db.run('UPDATE payments SET flow_order = $1, flow_url = $2, flow_token = $3 WHERE id = $4', [String(flowRes.flowOrder), checkoutUrl, flowRes.token, result.rows[0].id]);

        await activity.log(req.session.userId, 'PAYMENT_FLOW_REDIRECT', 'Redirigido a Flow para pago de ' + plan.name + ' - Orden Flow: ' + flowRes.flowOrder, { ip: req.ip });
        res.redirect(checkoutUrl);
      } catch (err) {
        console.error('Flow error:', err.response?.data || err.message);
        await db.run('UPDATE payments SET status = $1 WHERE id = $2', ['failed', result.rows[0].id]);
        res.redirect('/payment/' + plan.id + '?msg=Error al conectar con Flow. Intenta nuevamente.');
      }
    } else {
      const reference = 'PAG-' + crypto.randomBytes(6).toString('hex').toUpperCase();
      await db.query('INSERT INTO payments (user_id, plan_id, amount, reference) VALUES ($1, $2, $3, $4)', [req.session.userId, plan.id, plan.price, reference]);
      await activity.log(req.session.userId, 'PAYMENT_SUBMITTED', 'Pago de $' + plan.price + ' para plan ' + plan.name + ' (Ref: ' + reference + ')', { ip: req.ip });
      res.redirect('/payment/' + plan.id + '?msg=Pago registrado. Referencia: ' + reference + '. Pendiente de verificación por administrador.');
    }
  } catch (err) {
    res.redirect('/subscriptions?error=Error al procesar pago');
  }
});

router.post('/payment/:id/cancel', auth, async (req, res) => {
  try {
    const payment = await db.get('SELECT * FROM payments WHERE id = $1 AND user_id = $2 AND (status = $3 OR status = $4)', [req.params.id, req.session.userId, 'pending', 'pending_flow']);
    if (!payment) {
      return res.redirect('/subscriptions?error=Pago no encontrado o no se puede cancelar');
    }
    await db.run('DELETE FROM payments WHERE id = $1', [payment.id]);
    await activity.log(req.session.userId, 'PAYMENT_CANCELLED', 'Pago cancelado por el usuario: ' + payment.reference + ' - ' + '$' + payment.amount, { ip: req.ip });
    res.redirect('/subscriptions?success=Pago pendiente cancelado correctamente.');
  } catch (err) {
    res.redirect('/subscriptions?error=Error al cancelar pago');
  }
});

router.post('/flow/confirmation', async (req, res) => {
  try {
    const token = req.body.token;
    if (!token) return res.status(400).send('Token requerido');

    const status = await flow.getPaymentStatus(token);
    const paymentId = parseInt(status.commerceOrder);
    const payment = await db.get('SELECT * FROM payments WHERE id = $1', [paymentId]);
    if (!payment) return res.status(404).send('Pago no encontrado');

    if (status.status === 'approved' || status.status === 1 || status.status === '1') {
      if (payment.status === 'confirmed') return res.send('OK');

      const plan = await db.get('SELECT * FROM plans WHERE id = $1', [payment.plan_id]);
      await db.run('UPDATE payments SET status = $1, confirmed_at = $2 WHERE id = $3', ['confirmed', new Date().toISOString(), payment.id]);
      await db.run('UPDATE users SET plan_id = $1 WHERE id = $2', [payment.plan_id, payment.user_id]);

      await activity.log(payment.user_id, 'PAYMENT_FLOW_CONFIRMED', 'Pago Flow confirmado - ' + plan.name + ' (Flow Order: ' + status.flowOrder + ')', { ip: req.ip });

      const end = new Date();
      end.setFullYear(end.getFullYear() + 1);
      await db.run('INSERT INTO subscriptions (user_id, plan_id, status, expires_at, source) VALUES ($1, $2, $3, $4, $5)', [payment.user_id, payment.plan_id, 'active', end.toISOString(), 'purchased']);
    }

    res.send('OK');
  } catch (err) {
    console.error('Flow confirmation error:', err.response?.data || err.message);
    res.status(500).send('Error');
  }
});

router.get('/flow/return', auth, async (req, res) => {
  try {
    const paymentId = req.query.payment_id;
    const token = req.query.token;

    if (!paymentId) return res.redirect('/subscriptions?error=No se encontró el pago');

    const payment = await db.get('SELECT pay.*, p.name as plan_name FROM payments pay JOIN plans p ON pay.plan_id = p.id WHERE pay.id = $1 AND pay.user_id = $2', [paymentId, req.session.userId]);
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
  } catch (err) {
    res.redirect('/subscriptions');
  }
});

module.exports = router;
