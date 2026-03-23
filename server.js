require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = 10000;
const DATA_FILE = path.join(__dirname, 'data', 'hikes.json');

// Middleware
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limit auth endpoint: 5 attempts per minute per IP
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many attempts, try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

// Auth check helper
function checkPassword(req) {
  return req.headers['x-password'] === process.env.HIKE_PASSWORD;
}

// GET /api/hikes — public, no auth
app.get('/api/hikes', async (req, res) => {
  try {
    const data = await fs.promises.readFile(DATA_FILE, 'utf-8');
    res.json(JSON.parse(data));
  } catch (err) {
    if (err.code === 'ENOENT') return res.json([]);
    res.status(500).json({ error: 'Failed to read hikes' });
  }
});

// POST /api/auth — validate password
app.post('/api/auth', authLimiter, (req, res) => {
  if (checkPassword(req)) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// POST /api/hikes — save full hikes array (auth required)
app.post('/api/hikes', (req, res) => {
  if (!checkPassword(req)) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Body must be a JSON array' });
  }

  try {
    const json = JSON.stringify(req.body, null, 2);
    const tmpFile = DATA_FILE + '.tmp';
    fs.writeFileSync(tmpFile, json, 'utf-8');
    fs.renameSync(tmpFile, DATA_FILE);
    res.json(req.body);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save hikes' });
  }
});

app.listen(PORT, () => {
  console.log(`Hiker server running on port ${PORT}`);
});
