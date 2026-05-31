const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

// CORS — sabhi origins allow
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
  res.json({ status: 'ok', service: 'AuraVeda API', version: '3.0' });
});

// Claude AI Proxy
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

app.listen(PORT, () => {
  console.log(`AuraVeda Server running on port ${PORT}`);
  console.log(`Claude AI: ${process.env.ANTHROPIC_API_KEY ? 'OK' : 'MISSING - add ANTHROPIC_API_KEY'}`);
});
