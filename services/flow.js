const crypto = require('crypto');
const axios = require('axios');
const querystring = require('querystring');

class FlowService {
  constructor() {
    this.apiKey = (process.env.FLOW_API_KEY || '').trim();
    this.secretKey = (process.env.FLOW_SECRET_KEY || '').trim();
    this.baseUrl = (process.env.FLOW_BASE_URL || 'https://sandbox.flow.cl/api').trim();
  }

  isConfigured() {
    return !!(this.apiKey && this.secretKey && this.apiKey !== 'your-flow-api-key');
  }

  sign(params) {
    const keys = Object.keys(params).sort();
    let toSign = '';
    for (const key of keys) {
      toSign += key + params[key];
    }
    return crypto.createHmac('sha256', this.secretKey).update(toSign).digest('hex');
  }

  async createPayment({ commerceOrder, email, amount, urlConfirmation, urlReturn }) {
    const params = {
      apiKey: this.apiKey,
      commerceOrder: String(commerceOrder),
      email,
      amount: Math.round(amount),
      urlConfirmation,
      urlReturn,
      subject: 'Suscripción DocVeh',
      currency: 'CLP',
      timeout: 3600
    };
    const s = this.sign(params);
    const body = { ...params, s };
    const encoded = querystring.stringify(body);
    const response = await axios.post(this.baseUrl + '/payment/create', encoded, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return response.data;
  }

  async getPaymentStatus(token) {
    const params = { apiKey: this.apiKey, token };
    const s = this.sign(params);
    const body = { ...params, s };
    const encoded = querystring.stringify(body);
    const response = await axios.post(this.baseUrl + '/payment/getStatus', encoded, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    return response.data;
  }
}

module.exports = new FlowService();
