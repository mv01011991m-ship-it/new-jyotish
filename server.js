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
    if (!system || !Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'system aur messages required hain' });
    }
    // History trim karo, par pehla message hamesha 'user' hona chahiye
    // warna Anthropic API 400 deti hai
    let msgs = messages.slice(-14);
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    if (!msgs.length) msgs = [messages[messages.length - 1]];
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-5',
        max_tokens: 4096,
        system:     system,
        messages:   msgs
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
    const keyId = process.env.RAZORPAY_KEY_ID || 'rzp_live_SvoLkkvbznWI3c';
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

// ─── Stripe Checkout (international payments) ───
// Frontend se amount MAJOR units mein aata hai (e.g. 4.99), Stripe ko MINOR chahiye (499)
app.post('/api/stripe-checkout', async (req, res) => {
  try {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return res.status(500).json({ error: 'Stripe not configured' });

    const { amount, currency, questions, email, name } = req.body;
    const amt = Math.round(Number(amount) * 100);
    const q   = parseInt(questions, 10);
    if (!amt || amt < 50 || !q || q < 1 || q > 1000) {
      return res.status(400).json({ error: 'Invalid amount or questions' });
    }
    const cur    = String(currency || 'usd').toLowerCase();
    const origin = req.headers.origin || 'https://auravedai.com';

    const form = new URLSearchParams();
    form.append('mode', 'payment');
    form.append('success_url', origin + '/?payment=success&session_id={CHECKOUT_SESSION_ID}');
    form.append('cancel_url',  origin + '/?payment=cancelled');
    form.append('line_items[0][quantity]', '1');
    form.append('line_items[0][price_data][currency]', cur);
    form.append('line_items[0][price_data][unit_amount]', String(amt));
    form.append('line_items[0][price_data][product_data][name]', q + ' AuraVeda Questions');
    form.append('line_items[0][price_data][product_data][description]', 'Ad-free premium Vedic readings');
    // questions metadata mein rakhte hain - verify ke waqt yahi se credit denge
    form.append('metadata[questions]', String(q));
    if (email) form.append('customer_email', String(email));
    if (name)  form.append('metadata[name]', String(name).slice(0, 100));

    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + secret,
        'Content-Type':  'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });
    const s = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: (s.error && s.error.message) || 'Stripe error' });
    }
    res.json({ url: s.url, id: s.id });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Stripe Payment Verification ───
// Frontend sirf session_id bhejta hai. Kitne questions dene hain wo
// Stripe ki metadata se aata hai, URL se NAHI - warna koi bhi
// ?payment=success&q=999 likh kar muft credits le lega.
app.post('/api/stripe-verify', async (req, res) => {
  try {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return res.status(500).json({ verified: false, error: 'Stripe not configured' });

    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ verified: false, error: 'session_id required' });

    const r = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(session_id), {
      headers: { 'Authorization': 'Bearer ' + secret }
    });
    const s = await r.json();
    if (!r.ok) return res.status(r.status).json({ verified: false, error: 'Session lookup failed' });

    const paid = (s.payment_status === 'paid');
    res.json({
      verified:  paid,
      questions: paid ? (parseInt(s.metadata && s.metadata.questions, 10) || 0) : 0,
      amount:    s.amount_total,
      currency:  s.currency
    });
  } catch (err) {
    console.error('Stripe verify error:', err.message);
    res.status(500).json({ verified: false, error: 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log('AuraVeda Server running on port ' + PORT);
  console.log('Claude AI: ' + (process.env.ANTHROPIC_API_KEY ? 'OK' : 'MISSING'));
  console.log('Razorpay Secret: ' + (process.env.RAZORPAY_SECRET ? 'OK' : 'MISSING - payments wont verify'));
  console.log('Stripe Secret: '   + (process.env.STRIPE_SECRET_KEY ? 'OK' : 'MISSING - international payments off'));
});