const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const crypto  = require('crypto');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// CORS
app.use(cors());
app.options('*', cors());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: '2mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'AuraVeda API', version: '4.0' });
});

// ─── Claude AI Proxy ───
app.post('/api/chat', async (req, res) => {
  try {
    const { system, messages } = req.body;
    if (!system || !messages) {
      return res.status(400).json({ error: 'system aur messages required hain' });
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-5',
        max_tokens: 1500,
        system:     system,
        messages:   messages.slice(-14)
      })
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error || 'API Error' });
    }
    res.json(data);
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Razorpay Payment Verification ───
// Frontend sends razorpay_payment_id, razorpay_order_id, razorpay_signature
// We verify the signature using the SECRET key (only server knows it)
app.post('/api/verify-payment', (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ verified: false, error: 'Missing payment details' });
    }
    const secret = process.env.RAZORPAY_SECRET;
    if (!secret) {
      return res.status(500).json({ verified: false, error: 'Server not configured' });
    }
    // Razorpay signature = HMAC_SHA256(order_id + "|" + payment_id, secret)
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');
    const verified = (expectedSignature === razorpay_signature);
    res.json({ verified });
  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).json({ verified: false, error: 'Verification failed' });
  }
});

// ─── Create Razorpay Order ───
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount } = req.body; // amount in paise
    const keyId = 'rzp_live_SvoLkkvbznWI3c';
    const secret = process.env.RAZORPAY_SECRET;
    if (!secret) return res.status(500).json({ error: 'Server not configured' });

    const auth = Buffer.from(keyId + ':' + secret).toString('base64');
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + auth
      },
      body: JSON.stringify({
        amount: amount,
        currency: 'INR',
        receipt: 'rcpt_' + Date.now()
      })
    });
    const order = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: order });
    res.json(order);
  } catch (err) {
    console.error('Order error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('AuraVeda Server running on port ' + PORT);
  console.log('Claude AI: ' + (process.env.ANTHROPIC_API_KEY ? 'OK' : 'MISSING'));
  console.log('Razorpay Secret: ' + (process.env.RAZORPAY_SECRET ? 'OK' : 'MISSING - payments wont verify'));
});
