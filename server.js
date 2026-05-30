// ═══════════════════════════════════════════════
//  Jyotish Darshan — International Backend
//  Handles: Claude AI + Razorpay + Stripe
// ═══════════════════════════════════════════════
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// Stripe (only init if key present)
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

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

// ── Health check ──────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Jyotish Darshan Global API', version: '2.0' });
});

// ── Claude AI Proxy ───────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { system, messages } = req.body;
    if (!system || !messages) return res.status(400).json({ error: 'Missing fields' });

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
        system, messages: messages.slice(-14)
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error || 'API Error' });
    res.json(data);

  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Stripe Checkout Session ───────────────────
app.post('/api/stripe-checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });

  try {
    const { amount, currency, questions, email, name } = req.body;
    const amountInCents = Math.round(amount * 100);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: currency || 'usd',
          unit_amount: amountInCents,
          product_data: {
            name: `Jyotish Darshan — ${questions} Premium Questions`,
            description: 'Vedic AI Astrology — Unlimited deep chart readings',
            images: []
          }
        },
        quantity: 1
      }],
      metadata: { questions, email, name },
      success_url: (process.env.FRONTEND_URL || 'https://jyotishdarshan.netlify.app')
        + '?payment=success&q=' + questions + '&email=' + encodeURIComponent(email),
      cancel_url: (process.env.FRONTEND_URL || 'https://jyotishdarshan.netlify.app')
        + '?payment=cancelled'
    });

    res.json({ sessionId: session.id, url: session.url });

  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe Webhook (payment confirmation) ────
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch (err) {
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { questions, email } = session.metadata;
    console.log(`✦ Payment confirmed: ${questions} questions for ${email}`);
    // In production: update your database here
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`✦ Jyotish Darshan Global Server — Port ${PORT}`);
  console.log(`  Claude AI: ${process.env.ANTHROPIC_API_KEY ? '✅' : '❌ Missing'}`);
  console.log(`  Stripe:    ${process.env.STRIPE_SECRET_KEY ? '✅' : '⚠️  Optional (international payments)'}`);
});
