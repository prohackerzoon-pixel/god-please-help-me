const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 60000,
  connectionTimeoutMillis: 10000,
  keepAlive: true,
});

pool.on('connect', () => console.log('✅ Supabase PostgreSQL connected'));
pool.on('error', (err) => console.error('❌ DB error:', err.message));

module.exports = pool;
