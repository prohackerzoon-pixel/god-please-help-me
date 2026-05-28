const jwt = require('jsonwebtoken');
const pool = require('../config/db');
require('dotenv').config();

const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.id]);
    if (!result.rows[0]) return res.status(401).json({ error: 'User not found' });
    if (!result.rows[0].is_active) return res.status(403).json({ error: 'Account suspended. Contact support.' });
    req.user = result.rows[0];
    next();
  } catch (e) { return res.status(401).json({ error: 'Invalid or expired token' }); }
};

const adminMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    const decoded = jwt.verify(token, process.env.JWT_ADMIN_SECRET);
    const result = await pool.query('SELECT * FROM admin_users WHERE id = $1', [decoded.id]);
    if (!result.rows[0]) return res.status(401).json({ error: 'Admin not found' });
    req.admin = result.rows[0];
    next();
  } catch (e) { return res.status(401).json({ error: 'Invalid or expired admin token' }); }
};

module.exports = { authMiddleware, adminMiddleware };
