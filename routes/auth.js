const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const emailCfg = require('../config/email');
const telegram = require('../config/telegram');
const { generateAccountNumber, generateOTP } = require('../utils/helpers');
const { authMiddleware } = require('../middleware/auth');
require('dotenv').config();

// Send OTP
router.post('/send-otp', async (req, res) => {
  try {
    const { emailAddress, name } = req.body;
    if (!emailAddress) return res.status(400).json({ error: 'Email required' });
    const existing = await pool.query('SELECT id FROM users WHERE email=$1', [emailAddress]);
    if (existing.rows[0]) return res.status(400).json({ error: 'Email already registered' });
    await pool.query('UPDATE email_verifications SET is_used=true WHERE email=$1', [emailAddress]);
    const otp = generateOTP();
    await pool.query('INSERT INTO email_verifications(email,code,expires_at) VALUES($1,$2,$3)', [emailAddress, otp, new Date(Date.now() + 15 * 60 * 1000)]);
    await emailCfg.sendOTPEmail(emailAddress, name || 'User', otp);
    res.json({ message: 'OTP sent successfully' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to send OTP' }); }
});

// Verify OTP
router.post('/verify-otp', async (req, res) => {
  try {
    const { emailAddress, otp } = req.body;
    const r = await pool.query('SELECT * FROM email_verifications WHERE email=$1 AND code=$2 AND is_used=false ORDER BY created_at DESC LIMIT 1', [emailAddress, otp]);
    if (!r.rows[0]) return res.status(400).json({ error: 'Invalid code' });
    if (new Date() > new Date(r.rows[0].expires_at)) return res.status(400).json({ error: 'Code expired. Please request a new one.' });
    await pool.query('UPDATE email_verifications SET is_used=true WHERE id=$1', [r.rows[0].id]);
    res.json({ message: 'Email verified successfully', verified: true });
  } catch (e) { res.status(500).json({ error: 'Verification failed' }); }
});

// Register
router.post('/register', async (req, res) => {
  try {
    const { first_name, middle_name, last_name, username, email, phone, country, account_type, currency, transaction_pin, password, referral_code, date_of_birth } = req.body;
    if (!first_name || !last_name || !username || !email || !password || !transaction_pin) return res.status(400).json({ error: 'All required fields must be filled' });
    const uCheck = await pool.query('SELECT id FROM users WHERE username=$1', [username]);
    if (uCheck.rows[0]) return res.status(400).json({ error: 'Username already taken' });
    const eCheck = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (eCheck.rows[0]) return res.status(400).json({ error: 'Email already registered' });
    const passwordHash = await bcrypt.hash(password, 12);
    const pinHash = await bcrypt.hash(transaction_pin, 12);
    let accountNumber, unique = false;
    while (!unique) { accountNumber = generateAccountNumber(); const c = await pool.query('SELECT id FROM users WHERE account_number=$1', [accountNumber]); if (!c.rows[0]) unique = true; }
    const r = await pool.query(`INSERT INTO users(first_name,middle_name,last_name,username,email,phone,country,account_type,currency,preferred_currency,transaction_pin,password_hash,account_number,referral_code,date_of_birth,is_email_verified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,$12,$13,$14,true) RETURNING *`,
      [first_name, middle_name || null, last_name, username, email, phone, country, account_type || 'checking', currency || 'USD', pinHash, passwordHash, accountNumber, referral_code || null, date_of_birth || null]);
    const u = r.rows[0];
    await emailCfg.sendWelcomeEmail(email, `${first_name} ${last_name}`, accountNumber);
    await telegram.notifyRegister(u);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'success','Welcome to BluePeak Finance!',$2)`, [u.id, `Hello ${first_name}! Your account is ready. Complete KYC verification to unlock all features.`]);
    const token = jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });
    res.status(201).json({ message: 'Account created successfully!', token, user: { id: u.id, first_name: u.first_name, last_name: u.last_name, email: u.email, account_number: u.account_number, kyc_status: u.kyc_status, currency: u.currency, balance: u.balance } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Registration failed' }); }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) return res.status(400).json({ error: 'Email/username and password required' });
    const r = await pool.query('SELECT * FROM users WHERE email=$1 OR username=$1', [identifier]);
    if (!r.rows[0]) { await telegram.notifyFailedLogin(identifier); return res.status(401).json({ error: 'Invalid credentials' }); }
    const u = r.rows[0];
    if (!u.is_active) return res.status(403).json({ error: 'Account suspended. Please contact support.' });
    const valid = await bcrypt.compare(password, u.password_hash);
    if (!valid) { await telegram.notifyFailedLogin(identifier); return res.status(401).json({ error: 'Invalid credentials' }); }
    await telegram.notifyLogin(u);
    await emailCfg.sendLoginAlert(u.email, `${u.first_name} ${u.last_name}`);
    const token = jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN });
    res.json({ message: 'Login successful', token, user: { id: u.id, first_name: u.first_name, last_name: u.last_name, email: u.email, account_number: u.account_number, kyc_status: u.kyc_status, currency: u.preferred_currency || u.currency, balance: u.balance, profile_photo: u.profile_photo } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Login failed' }); }
});

// Verify PIN
router.post('/verify-pin', authMiddleware, async (req, res) => {
  try {
    const valid = await bcrypt.compare(req.body.pin, req.user.transaction_pin);
    if (!valid) return res.status(401).json({ error: 'Invalid PIN' });
    res.json({ message: 'PIN verified', valid: true });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// Forgot password
router.post('/forgot-password', async (req, res) => {
  try {
    const { emailAddress } = req.body;
    const u = await pool.query('SELECT * FROM users WHERE email=$1', [emailAddress]);
    if (!u.rows[0]) return res.status(404).json({ error: 'Email not found' });
    const otp = generateOTP();
    await pool.query('UPDATE password_resets SET is_used=true WHERE email=$1', [emailAddress]);
    await pool.query('INSERT INTO password_resets(email,code,expires_at) VALUES($1,$2,$3)', [emailAddress, otp, new Date(Date.now() + 15 * 60 * 1000)]);
    await emailCfg.sendPasswordResetEmail(emailAddress, u.rows[0].first_name, otp);
    res.json({ message: 'Reset code sent to your email' });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// Reset password
router.post('/reset-password', async (req, res) => {
  try {
    const { emailAddress, otp, newPassword } = req.body;
    const r = await pool.query('SELECT * FROM password_resets WHERE email=$1 AND code=$2 AND is_used=false ORDER BY created_at DESC LIMIT 1', [emailAddress, otp]);
    if (!r.rows[0] || new Date() > new Date(r.rows[0].expires_at)) return res.status(400).json({ error: 'Invalid or expired code' });
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash=$1 WHERE email=$2', [hash, emailAddress]);
    await pool.query('UPDATE password_resets SET is_used=true WHERE id=$1', [r.rows[0].id]);
    await emailCfg.sendPasswordChangedEmail(emailAddress, r.rows[0].email);
    res.json({ message: 'Password reset successfully' });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// Get me
router.get('/me', authMiddleware, async (req, res) => {
  const u = req.user;
  res.json({ id: u.id, first_name: u.first_name, middle_name: u.middle_name, last_name: u.last_name, username: u.username, email: u.email, phone: u.phone, country: u.country, address: u.address, account_number: u.account_number, account_type: u.account_type, currency: u.preferred_currency || u.currency, balance: u.balance, kyc_status: u.kyc_status, is_active: u.is_active, profile_photo: u.profile_photo, created_at: u.created_at });
});

module.exports = router;
