const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('./config/db');
require('dotenv').config();

const app = express();

// ============ CORS ============
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============ ROUTES ============
app.use('/api', require('./routes/routes'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/auth', require('./routes/auth'));

// ============ VISIT TRACKER ============
app.post('/api/track-visit', async (req, res) => {
  try { await require('./config/telegram').notifyVisit(); } catch (e) {}
  res.json({ ok: true });
});

// ============ KEEP ALIVE ============

// ============ EMAIL TEST ============
app.get("/test-email", async (req, res) => {
  const { Resend } = require("resend");
  const r = new Resend(process.env.RESEND_API_KEY);
  const to = req.query.to || "bluepeakfinance02@gmail.com";
  try {
    const { data, error } = await r.emails.send({ from: "BluePeak Finance <onboarding@resend.dev>", to, subject: "✅ BluePeak Finance — Email Test", html: "<h2>✅ Email is working!</h2><p>Resend is configured. BluePeak Finance emails are live!</p>" });
    if (error) return res.json({ success: false, error: error.message, keySet: !!process.env.RESEND_API_KEY });
    res.json({ success: true, message: "Test email sent to " + to, id: data.id });
  } catch (e) { res.json({ success: false, error: e.message }); }
});


app.get('/ping', (req, res) => res.json({ status: 'alive', bank: 'BluePeak Finance', time: new Date().toISOString() }));

// ============ HOME ============
app.get('/', (req, res) => res.json({ message: '🏦 BluePeak Finance API is running!', version: '1.0.0', status: 'healthy' }));

// ============ 404 ============
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// ============ ERROR HANDLER ============
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ============ AUTO CREATE ADMIN ============
async function createDefaultAdmin() {
  try {
    const existing = await pool.query('SELECT id FROM admin_users LIMIT 1');
    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash('bluepeak123', 12);
      await pool.query(
        'INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)',
        ['admin', hash]
      );
      console.log('');
      console.log('╔══════════════════════════════════╗');
      console.log('║     ✅ ADMIN ACCOUNT CREATED     ║');
      console.log('║  Username : admin                ║');
      console.log('║  Password : bluepeak123          ║');
      console.log('╚══════════════════════════════════╝');
      console.log('');
    } else {
      console.log('✅ Admin account exists');
    }
  } catch (e) {
    console.error('❌ Admin error:', e.message);
  }
}

// ============ START ============
const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log('');
  console.log('🏦 ════════════════════════════════════');
  console.log(`🚀 BluePeak Finance — Port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV}`);
  console.log(`🗄️  Database: Supabase Direct`);
  console.log('🏦 ════════════════════════════════════');
  console.log('');
  await createDefaultAdmin();
});

require('./utils/cron')();

module.exports = app;
// injected below — no op
