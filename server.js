const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const crypto  = require('crypto');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

// CORS
app.use(cors());
app.options('*', cors());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: '2mb' }));

/* ══════════════════════════════════════════════
   SUPABASE HELPER
   Service key sirf yahan server par hai - browser me kabhi nahi.
══════════════════════════════════════════════ */
async function sb(path, opts) {
  opts = opts || {};
  if (!SB_URL || !SB_KEY) throw new Error('Supabase not configured');
  const r = await fetch(SB_URL + '/rest/v1/' + path, {
    method:  opts.method || 'GET',
    body:    opts.body || undefined,
    headers: {
      'apikey':        SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type':  'application/json',
      'Prefer':        opts.prefer || 'return=representation'
    }
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!r.ok) throw new Error((data && (data.message || data.hint)) || ('DB error ' + r.status));
  return data;
}
const q = (v) => encodeURIComponent(v);

/* ══════════════════════════════════════════════
   PASSWORD + TOKEN
══════════════════════════════════════════════ */
function newSalt()  { return crypto.randomBytes(16).toString('hex'); }
function newToken() { return crypto.randomBytes(32).toString('hex'); }
function hashPass(pass, salt) {
  return crypto.pbkdf2Sync(String(pass), salt, 120000, 64, 'sha512').toString('hex');
}
function samePass(plain, salt, expected) {
  const got = Buffer.from(hashPass(plain, salt), 'hex');
  const exp = Buffer.from(String(expected), 'hex');
  if (got.length !== exp.length) return false;
  return crypto.timingSafeEqual(got, exp);   // timing attack se bachne ke liye
}
const TOKEN_DAYS = 30;

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone,
    balance: u.balance, qUsed: u.q_used, adRequired: u.ad_required
  };
}

async function userByToken(token) {
  if (!token) return null;
  const rows = await sb('users?token=eq.' + q(token) + '&select=*');
  const u = rows && rows[0];
  if (!u) return null;
  if (u.blocked) return null;
  if (u.token_exp && Number(u.token_exp) < Date.now()) return null;
  return u;
}
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : ((req.body && req.body.token) || '');
}

/* ══════════════════════════════════════════════
   ADMIN TOKEN (stateless - HMAC signed, DB me kuch store nahi)
══════════════════════════════════════════════ */
function adminSecret() {
  return process.env.ADMIN_PASSWORD || '';
}
function makeAdminToken() {
  const exp = Date.now() + 12 * 60 * 60 * 1000;    // 12 ghante
  const sig = crypto.createHmac('sha256', adminSecret()).update(String(exp)).digest('hex');
  return exp + '.' + sig;
}
function checkAdmin(req, res) {
  const t = bearer(req);
  const parts = String(t).split('.');
  if (parts.length !== 2 || !adminSecret()) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  const exp = Number(parts[0]);
  if (!exp || exp < Date.now()) { res.status(401).json({ error: 'Session expired' }); return false; }
  const sig = crypto.createHmac('sha256', adminSecret()).update(String(exp)).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(parts[1]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}

/* ══════════════════════════════════════════════
   HEALTH
══════════════════════════════════════════════ */
app.get('/', (req, res) => {
  res.json({
    status: 'ok', service: 'AuraVeda API', version: '5.0',
    db: (SB_URL && SB_KEY) ? 'connected' : 'not configured'
  });
});

/* ─── TEMP DIAGNOSTIC ───────────────────────────────────
   Sirf variable ke NAAM aur LAMBAI dikhata hai - value kabhi nahi.
   Dikkat theek hone ke baad ye pura block hata dena.
──────────────────────────────────────────────────────── */
app.get('/env-check', (req, res) => {
  const want = ['ANTHROPIC_API_KEY','SUPABASE_URL','SUPABASE_SERVICE_KEY',
                'RAZORPAY_SECRET','RAZORPAY_KEY_ID','STRIPE_SECRET_KEY','ADMIN_PASSWORD'];
  const found = {};
  want.forEach(k => {
    const v = process.env[k];
    found[k] = v ? ('set, ' + v.length + ' chars' + (v !== v.trim() ? '  <-- EXTRA SPACE!' : '')) : 'MISSING';
  });
  // Milte-julte naam jo Render me pade hain (galat spelling pakadne ke liye)
  const similar = Object.keys(process.env).filter(k =>
    /razor|stripe|supabase|admin|anthropic|claude/i.test(k) && want.indexOf(k) === -1);
  res.json({ expected: found, other_matching_names: similar });
});

/* ══════════════════════════════════════════════
   PRICING
   Public read - website startup par yahi load karti hai.
   Likhna sirf admin kar sakta hai.
══════════════════════════════════════════════ */
app.get('/api/pricing', async (req, res) => {
  try {
    const rows = await sb('settings?key=eq.pricing&select=value');
    if (!rows || !rows.length) return res.status(404).json({ error: 'Pricing not set' });
    res.json(rows[0].value);
  } catch (err) {
    res.status(500).json({ error: 'Could not load pricing' });
  }
});

app.post('/api/admin/pricing', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const incoming = req.body && req.body.pricing;

    // Sirf padhna hai
    if (!incoming) {
      const rows = await sb('settings?key=eq.pricing&select=value');
      return res.json({ pricing: (rows && rows[0]) ? rows[0].value : null });
    }

    // Save karne se pehle jaanch - ek galat number website ka
    // pricing page tod sakta hai, isliye yahan rok lagayi hai.
    const clean = {};
    Object.keys(incoming).forEach(cur => {
      const m = incoming[cur] || {};
      const packs = (m.packs || [])
        .map(p => ({
          name: String(p.name || '').slice(0, 24),
          q:    parseInt(p.q, 10),
          base: Math.round(Number(p.base) * 100) / 100,
          pop:  !!p.pop
        }))
        .filter(p => p.name && p.q > 0 && p.q <= 1000 && p.base > 0 && p.base <= 100000);
      if (!packs.length) return;
      clean[String(cur).toUpperCase().slice(0, 3)] = {
        sym:   String(m.sym || '').slice(0, 3),
        gst:   Math.min(Math.max(Number(m.gst) || 0, 0), 1),
        pay:   (m.pay === 'razorpay') ? 'razorpay' : 'stripe',
        packs: packs
      };
    });
    if (!Object.keys(clean).length) return res.status(400).json({ error: 'No valid pricing to save' });

    await sb('settings?key=eq.pricing', {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ value: clean, updated_at: new Date().toISOString() })
    });
    res.json({ ok: true, pricing: clean });
  } catch (err) {
    console.error('Pricing error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════
   AUTH
══════════════════════════════════════════════ */
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body || {};
    const em = email ? String(email).trim().toLowerCase() : null;
    const ph = phone ? String(phone).trim() : null;

    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Naam zaroori hai' });
    if (!em && !ph)                    return res.status(400).json({ error: 'Email ya phone zaroori hai' });
    if (!password || String(password).length < 6)
      return res.status(400).json({ error: 'Password kam se kam 6 characters ka ho' });

    // pehle se hai kya?
    const filter = [];
    if (em) filter.push('email.eq.' + em);
    if (ph) filter.push('phone.eq.' + ph);
    const exists = await sb('users?or=(' + q(filter.join(',')) + ')&select=id');
    if (exists && exists.length) return res.status(409).json({ error: 'Account pehle se hai - Login karein' });

    const salt  = newSalt();
    const token = newToken();
    const rows  = await sb('users', {
      method: 'POST',
      body: JSON.stringify({
        name: String(name).trim(), email: em, phone: ph,
        pass_hash: hashPass(password, salt), pass_salt: salt,
        balance: 0, q_used: 0, ad_required: false,
        token: token, token_exp: Date.now() + TOKEN_DAYS * 86400000
      })
    });
    res.json({ token, user: publicUser(rows[0]) });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Register nahi ho paaya' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, phone, password } = req.body || {};
    const em = email ? String(email).trim().toLowerCase() : null;
    const ph = phone ? String(phone).trim() : null;
    if (!em && !ph)  return res.status(400).json({ error: 'Email ya phone daalein' });
    if (!password)   return res.status(400).json({ error: 'Password daalein' });

    const filter = [];
    if (em) filter.push('email.eq.' + em);
    if (ph) filter.push('phone.eq.' + ph);
    const rows = await sb('users?or=(' + q(filter.join(',')) + ')&select=*');
    const u = rows && rows[0];

    // Galat email aur galat password - dono par same message.
    // Warna hacker ko pata chal jayega ki kaunsa email registered hai.
    if (!u || !samePass(password, u.pass_salt, u.pass_hash))
      return res.status(401).json({ error: 'Email/phone ya password galat hai' });
    if (u.blocked) return res.status(403).json({ error: 'Account blocked hai. Support se contact karein.' });

    const token = newToken();
    await sb('users?id=eq.' + q(u.id), {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ token, token_exp: Date.now() + TOKEN_DAYS * 86400000, last_seen: new Date().toISOString() })
    });
    res.json({ token, user: publicUser(u) });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login nahi ho paaya' });
  }
});

// Har page load par - balance server se hi aata hai, browser se nahi
app.post('/api/auth/me', async (req, res) => {
  try {
    const u = await userByToken(bearer(req));
    if (!u) return res.status(401).json({ error: 'Session expired' });
    res.json({ user: publicUser(u) });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const u = await userByToken(bearer(req));
    if (u) await sb('users?id=eq.' + q(u.id), {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ token: null, token_exp: null })
    });
  } catch (e) {}
  res.json({ ok: true });
});

/* ══════════════════════════════════════════════
   CLAUDE AI PROXY
   Balance ab yahan katta hai. Browser me nahi - warna
   koi bhi localStorage edit karke unlimited questions le leta.
══════════════════════════════════════════════ */
app.post('/api/chat', async (req, res) => {
  try {
    const { system, messages } = req.body;
    if (!system || !Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'system aur messages required hain' });
    }

    const token = bearer(req);
    let charged = false;

    if (token) {
      const out = await sb('rpc/consume_question', {
        method: 'POST', body: JSON.stringify({ p_token: token })
      });
      const row = Array.isArray(out) ? out[0] : out;
      if (!row || !row.ok) {
        return res.status(402).json({ error: 'no_balance', message: 'Questions khatam ho gaye. Recharge karein.' });
      }
      charged = true;
    }

    // History trim - pehla message hamesha 'user' hona chahiye
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
        // Prompt caching: kundali ka data har sawaal me same rehta hai.
        // Cache se input ka sirf 10% lagta hai - seedhi bachat.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages:   msgs
      })
    });
    const data = await response.json();

    if (!response.ok) {
      // AI fail hui to credit wapas - customer ka paisa nahi katna chahiye
      if (charged) {
        try {
          const u = await userByToken(token);
          if (u) await sb('rpc/add_credits', {
            method: 'POST',
            body: JSON.stringify({ p_user: u.id, p_delta: 1, p_reason: 'refund: AI error' })
          });
        } catch (e) {}
      }
      return res.status(response.status).json({ error: data.error || 'API Error' });
    }
    res.json(data);
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ══════════════════════════════════════════════
   RAZORPAY
══════════════════════════════════════════════ */
app.post('/api/create-order', async (req, res) => {
  try {
    const { amount, questions } = req.body;   // amount = paise
    const keyId  = process.env.RAZORPAY_KEY_ID || 'rzp_live_SvoLkkvbznWI3c';
    const secret = process.env.RAZORPAY_SECRET;
    if (!secret) return res.status(500).json({ error: 'Server not configured' });

    const qq = parseInt(questions, 10);
    if (!amount || !qq || qq < 1 || qq > 1000) return res.status(400).json({ error: 'Invalid order' });

    const auth = Buffer.from(keyId + ':' + secret).toString('base64');
    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth },
      body: JSON.stringify({
        amount:   amount,
        currency: 'INR',
        receipt:  'rcpt_' + Date.now(),
        // questions yahan store - verify ke waqt yahin se padhenge (client se NAHI)
        notes:    { questions: String(qq) }
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

app.post('/api/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ verified: false, error: 'Missing payment details' });
    }
    const secret = process.env.RAZORPAY_SECRET;
    if (!secret) return res.status(500).json({ verified: false, error: 'Server not configured' });

    const expected = crypto.createHmac('sha256', secret)
      .update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(String(razorpay_signature));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.json({ verified: false, error: 'Signature mismatch' });
    }

    const u = await userByToken(bearer(req));
    if (!u) return res.status(401).json({ verified: false, error: 'Login karein' });

    // Duplicate credit rokna - ref_id unique hai
    const dup = await sb('payments?ref_id=eq.' + q(razorpay_payment_id) + '&select=id');
    if (dup && dup.length) return res.json({ verified: true, duplicate: true, balance: u.balance });

    // Kitne questions? Razorpay ke order notes se - client se NAHI
    const keyId = process.env.RAZORPAY_KEY_ID || 'rzp_live_SvoLkkvbznWI3c';
    const auth  = Buffer.from(keyId + ':' + secret).toString('base64');
    const oR    = await fetch('https://api.razorpay.com/v1/orders/' + encodeURIComponent(razorpay_order_id), {
      headers: { 'Authorization': 'Basic ' + auth }
    });
    const order = await oR.json();
    if (!oR.ok) return res.status(502).json({ verified: false, error: 'Order lookup failed' });

    const qq = parseInt(order.notes && order.notes.questions, 10) || 0;
    if (qq < 1) return res.json({ verified: false, error: 'Questions not found on order' });

    const bal = await sb('rpc/add_credits', {
      method: 'POST',
      body: JSON.stringify({ p_user: u.id, p_delta: qq, p_reason: 'razorpay ' + razorpay_payment_id })
    });
    await sb('payments', {
      method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify({
        user_id: u.id, email: u.email, gateway: 'razorpay',
        ref_id: razorpay_payment_id, amount: (order.amount || 0) / 100,
        currency: order.currency || 'INR', questions: qq, status: 'paid'
      })
    });
    res.json({ verified: true, questions: qq, balance: bal });
  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).json({ verified: false, error: 'Verification failed' });
  }
});

/* ══════════════════════════════════════════════
   STRIPE (international)
══════════════════════════════════════════════ */
app.post('/api/stripe-checkout', async (req, res) => {
  try {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return res.status(500).json({ error: 'Stripe not configured' });

    const { amount, currency, questions } = req.body;
    const amt = Math.round(Number(amount) * 100);
    const qq  = parseInt(questions, 10);
    if (!amt || amt < 50 || !qq || qq < 1 || qq > 1000) {
      return res.status(400).json({ error: 'Invalid amount or questions' });
    }
    const u = await userByToken(bearer(req));
    if (!u) return res.status(401).json({ error: 'Login karein' });

    const cur    = String(currency || 'usd').toLowerCase();
    const origin = req.headers.origin || 'https://auravedai.com';

    const form = new URLSearchParams();
    form.append('mode', 'payment');
    form.append('success_url', origin + '/?payment=success&session_id={CHECKOUT_SESSION_ID}');
    form.append('cancel_url',  origin + '/?payment=cancelled');
    form.append('line_items[0][quantity]', '1');
    form.append('line_items[0][price_data][currency]', cur);
    form.append('line_items[0][price_data][unit_amount]', String(amt));
    form.append('line_items[0][price_data][product_data][name]', qq + ' AuraVeda Questions');
    form.append('line_items[0][price_data][product_data][description]', 'Ad-free premium Vedic readings');
    form.append('metadata[questions]', String(qq));
    form.append('metadata[user_id]',   String(u.id));
    if (u.email) form.append('customer_email', u.email);

    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const s = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: (s.error && s.error.message) || 'Stripe error' });
    res.json({ url: s.url, id: s.id });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

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
    if (s.payment_status !== 'paid') return res.json({ verified: false, error: 'Payment not completed' });

    const dup = await sb('payments?ref_id=eq.' + q(session_id) + '&select=id');
    if (dup && dup.length) return res.json({ verified: true, duplicate: true });

    const qq     = parseInt(s.metadata && s.metadata.questions, 10) || 0;
    const userId = s.metadata && s.metadata.user_id;
    if (!qq || !userId) return res.json({ verified: false, error: 'Order data missing' });

    const bal = await sb('rpc/add_credits', {
      method: 'POST',
      body: JSON.stringify({ p_user: userId, p_delta: qq, p_reason: 'stripe ' + session_id })
    });
    await sb('payments', {
      method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify({
        user_id: userId, email: s.customer_email || null, gateway: 'stripe',
        ref_id: session_id, amount: (s.amount_total || 0) / 100,
        currency: (s.currency || 'usd').toUpperCase(), questions: qq, status: 'paid'
      })
    });
    res.json({ verified: true, questions: qq, balance: bal });
  } catch (err) {
    console.error('Stripe verify error:', err.message);
    res.status(500).json({ verified: false, error: 'Server error' });
  }
});

/* ══════════════════════════════════════════════
   ADMIN API
══════════════════════════════════════════════ */
app.post('/api/admin/login', (req, res) => {
  const pw = (req.body && req.body.password) || '';
  if (!adminSecret()) return res.status(500).json({ error: 'ADMIN_PASSWORD set nahi hai' });
  const a = Buffer.from(String(pw)), b = Buffer.from(adminSecret());
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Galat password' });
  }
  res.json({ token: makeAdminToken() });
});

app.post('/api/admin/stats', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    res.json(await sb('rpc/admin_stats', { method: 'POST', body: '{}' }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const search = (req.body && req.body.search) ? String(req.body.search).trim() : '';
    const limit  = Math.min(parseInt((req.body && req.body.limit) || 50, 10) || 50, 200);
    let path = 'users?select=id,name,email,phone,balance,q_used,ad_required,blocked,created_at,last_seen'
             + '&order=created_at.desc&limit=' + limit;
    if (search) {
      const s = '*' + search + '*';
      path += '&or=(' + q('name.ilike.' + s + ',email.ilike.' + s + ',phone.ilike.' + s) + ')';
    }
    res.json({ users: await sb(path) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/payments', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const limit = Math.min(parseInt((req.body && req.body.limit) || 50, 10) || 50, 200);
    res.json({ payments: await sb('payments?select=*&order=created_at.desc&limit=' + limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manual credits add / remove (delta negative bhi ho sakta hai)
app.post('/api/admin/credits', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const { user_id, delta, reason } = req.body || {};
    const d = parseInt(delta, 10);
    if (!user_id || !d || Math.abs(d) > 10000) return res.status(400).json({ error: 'Invalid request' });
    const bal = await sb('rpc/add_credits', {
      method: 'POST',
      body: JSON.stringify({ p_user: user_id, p_delta: d, p_reason: reason ? String(reason).slice(0, 200) : 'admin manual' })
    });
    if (bal === null) return res.status(404).json({ error: 'User nahi mila' });
    res.json({ ok: true, balance: bal });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/block', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const { user_id, blocked } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    await sb('users?id=eq.' + q(user_id), {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ blocked: !!blocked, token: null, token_exp: null })
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/user-logs', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    res.json({
      logs:     await sb('credit_logs?user_id=eq.' + q(user_id) + '&select=*&order=created_at.desc&limit=50'),
      payments: await sb('payments?user_id=eq.'    + q(user_id) + '&select=*&order=created_at.desc&limit=50')
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => {
  console.log('AuraVeda Server running on port ' + PORT);
  console.log('Claude AI:       ' + (process.env.ANTHROPIC_API_KEY ? 'OK' : 'MISSING'));
  console.log('Supabase:        ' + (SB_URL && SB_KEY              ? 'OK' : 'MISSING - app kaam nahi karega'));
  console.log('Razorpay Secret: ' + (process.env.RAZORPAY_SECRET   ? 'OK' : 'MISSING - payments wont verify'));
  console.log('Stripe Secret:   ' + (process.env.STRIPE_SECRET_KEY ? 'OK' : 'MISSING - international payments off'));
  console.log('Admin Password:  ' + (process.env.ADMIN_PASSWORD    ? 'OK' : 'MISSING - admin panel band'));
});
