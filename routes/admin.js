const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const emailCfg = require('../config/email');
const telegram = require('../config/telegram');
const { adminMiddleware } = require('../middleware/auth');
const { generateCode, generateReferenceId } = require('../utils/helpers');
const { upload, uploadToSupabase } = require('../config/storage');
require('dotenv').config();

// LOGIN
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const r = await pool.query('SELECT * FROM admin_users WHERE username=$1', [username]);
    if (!r.rows[0]) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, r.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: r.rows[0].id }, process.env.JWT_ADMIN_SECRET, { expiresIn: '7d' });
    res.json({ message: 'Login successful', token, admin: { id: r.rows[0].id, username: r.rows[0].username } });
  } catch (e) { res.status(500).json({ error: 'Login failed' }); }
});

// DASHBOARD
router.get('/dashboard', adminMiddleware, async (req, res) => {
  try {
    const [users, deps, wdws, kyc, loans, irs, tickets, inv, pendDep, pendWdw] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query("SELECT COUNT(*),COALESCE(SUM(amount),0) as total FROM deposits WHERE status='approved'"),
      pool.query("SELECT COUNT(*),COALESCE(SUM(amount),0) as total FROM withdrawals WHERE status='approved'"),
      pool.query("SELECT COUNT(*) FROM kyc_verifications WHERE status='pending'"),
      pool.query("SELECT COUNT(*) FROM loans WHERE status='pending'"),
      pool.query("SELECT COUNT(*) FROM irs_requests WHERE status='pending'"),
      pool.query("SELECT COUNT(*) FROM support_tickets WHERE status='open'"),
      pool.query("SELECT COUNT(*) FROM investments WHERE status='active'"),
      pool.query("SELECT COUNT(*) FROM deposits WHERE status='pending'"),
      pool.query("SELECT COUNT(*) FROM withdrawals WHERE status='pending'"),
    ]);
    const recentUsers = await pool.query('SELECT id,first_name,last_name,email,account_number,kyc_status,balance,currency,created_at FROM users ORDER BY created_at DESC LIMIT 10');
    const recentTxns = await pool.query('SELECT t.*,u.first_name,u.last_name FROM transactions t JOIN users u ON t.user_id=u.id ORDER BY t.created_at DESC LIMIT 10');
    res.json({
      stats: { total_users: parseInt(users.rows[0].count), total_deposits: parseFloat(deps.rows[0].total), total_withdrawals: parseFloat(wdws.rows[0].total), pending_kyc: parseInt(kyc.rows[0].count), pending_loans: parseInt(loans.rows[0].count), pending_irs: parseInt(irs.rows[0].count), open_tickets: parseInt(tickets.rows[0].count), active_investments: parseInt(inv.rows[0].count), pending_deposits: parseInt(pendDep.rows[0].count), pending_withdrawals: parseInt(pendWdw.rows[0].count) },
      recent_users: recentUsers.rows,
      recent_transactions: recentTxns.rows,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed' }); }
});

// USERS
router.get('/users', adminMiddleware, async (req, res) => {
  try {
    const { search } = req.query;
    let q = 'SELECT id,first_name,last_name,email,username,account_number,balance,kyc_status,is_active,currency,preferred_currency,created_at FROM users';
    const p = [];
    if (search) { q += ' WHERE first_name ILIKE $1 OR last_name ILIKE $1 OR email ILIKE $1 OR account_number ILIKE $1'; p.push(`%${search}%`); }
    q += ' ORDER BY created_at DESC';
    res.json((await pool.query(q, p)).rows);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.get('/users/:id', adminMiddleware, async (req, res) => {
  try {
    const u = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!u.rows[0]) return res.status(404).json({ error: 'Not found' });
    const t = await pool.query('SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [req.params.id]);
    res.json({ user: u.rows[0], transactions: t.rows });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.post('/users/:id/add-funds', adminMiddleware, async (req, res) => {
  try {
    const { amount, note } = req.body;
    const u = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!u.rows[0]) return res.status(404).json({ error: 'Not found' });
    await pool.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [amount, req.params.id]);
    const refId = generateReferenceId();
    await pool.query("INSERT INTO transactions(user_id,type,amount,currency,status,reference_id,description) VALUES($1,'credit',$2,$3,'completed',$4,$5)", [req.params.id, amount, u.rows[0].preferred_currency || u.rows[0].currency, refId, note || 'Admin credit']);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'success','Account Credited 💰',$2)`, [req.params.id, `Your account has been credited with ${u.rows[0].currency} ${amount}`]);
    await telegram.notifyFundsAdded(u.rows[0], amount);
    await emailCfg.sendFundsAddedEmail(u.rows[0].email, `${u.rows[0].first_name} ${u.rows[0].last_name}`, amount, u.rows[0].currency);
    res.json({ message: 'Funds added successfully' });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.post('/users/:id/remove-funds', adminMiddleware, async (req, res) => {
  try {
    const { amount, note } = req.body;
    const u = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!u.rows[0]) return res.status(404).json({ error: 'Not found' });
    if (parseFloat(amount) > parseFloat(u.rows[0].balance)) return res.status(400).json({ error: 'Amount exceeds balance' });
    await pool.query('UPDATE users SET balance=balance-$1 WHERE id=$2', [amount, req.params.id]);
    const refId = generateReferenceId();
    await pool.query("INSERT INTO transactions(user_id,type,amount,currency,status,reference_id,description) VALUES($1,'debit',$2,$3,'completed',$4,$5)", [req.params.id, amount, u.rows[0].preferred_currency || u.rows[0].currency, refId, note || 'Admin debit']);
    await telegram.notifyFundsRemoved(u.rows[0], amount);
    await emailCfg.sendFundsRemovedEmail(u.rows[0].email, `${u.rows[0].first_name} ${u.rows[0].last_name}`, amount, u.rows[0].currency);
    res.json({ message: 'Funds removed successfully' });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/users/:id/toggle-status', adminMiddleware, async (req, res) => {
  try {
    const u = await pool.query('SELECT * FROM users WHERE id=$1', [req.params.id]);
    if (!u.rows[0]) return res.status(404).json({ error: 'Not found' });
    const newStatus = !u.rows[0].is_active;
    await pool.query('UPDATE users SET is_active=$1 WHERE id=$2', [newStatus, req.params.id]);
    if (newStatus) { await telegram.notifyAccountActivated(u.rows[0]); await emailCfg.sendAccountReactivatedEmail(u.rows[0].email, `${u.rows[0].first_name} ${u.rows[0].last_name}`); }
    else { await telegram.notifyAccountSuspended(u.rows[0]); await emailCfg.sendAccountSuspendedEmail(u.rows[0].email, `${u.rows[0].first_name} ${u.rows[0].last_name}`); }
    res.json({ message: newStatus ? 'Account activated' : 'Account suspended', is_active: newStatus });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// DEPOSITS
router.get('/deposits', adminMiddleware, async (req, res) => {
  try { res.json((await pool.query('SELECT d.*,u.first_name,u.last_name,u.email,u.account_number FROM deposits d JOIN users u ON d.user_id=u.id ORDER BY d.created_at DESC')).rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/deposits/:id/approve', adminMiddleware, async (req, res) => {
  try {
    const d = await pool.query('SELECT d.*,u.* FROM deposits d JOIN users u ON d.user_id=u.id WHERE d.id=$1', [req.params.id]);
    if (!d.rows[0]) return res.status(404).json({ error: 'Not found' });
    if (d.rows[0].status !== 'pending') return res.status(400).json({ error: 'Already processed' });
    const dep = d.rows[0];
    await pool.query("UPDATE deposits SET status='approved' WHERE id=$1", [req.params.id]);
    await pool.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [dep.amount, dep.user_id]);
    const refId = generateReferenceId();
    await pool.query("INSERT INTO transactions(user_id,type,amount,currency,status,reference_id,description) VALUES($1,'credit',$2,$3,'completed',$4,'Deposit approved')", [dep.user_id, dep.amount, dep.currency, refId]);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'success','Deposit Approved ✅',$2)`, [dep.user_id, `Your deposit of ${dep.currency} ${dep.amount} has been credited to your account.`]);
    await emailCfg.sendDepositApprovedEmail(dep.email, `${dep.first_name} ${dep.last_name}`, dep.amount, dep.currency);
    await telegram.notifyDepositApproved(dep, dep.amount, dep.currency);
    res.json({ message: 'Deposit approved' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed' }); }
});
router.put('/deposits/:id/reject', adminMiddleware, async (req, res) => {
  try {
    const { note } = req.body;
    const d = await pool.query('SELECT d.*,u.* FROM deposits d JOIN users u ON d.user_id=u.id WHERE d.id=$1', [req.params.id]);
    if (!d.rows[0]) return res.status(404).json({ error: 'Not found' });
    await pool.query("UPDATE deposits SET status='rejected',admin_note=$1 WHERE id=$2", [note, req.params.id]);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'error','Deposit Rejected',$2)`, [d.rows[0].user_id, `Your deposit was rejected. ${note || ''}`]);
    await emailCfg.sendDepositRejectedEmail(d.rows[0].email, `${d.rows[0].first_name} ${d.rows[0].last_name}`, d.rows[0].amount, note);
    res.json({ message: 'Deposit rejected' });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// WITHDRAWALS
router.get('/withdrawals', adminMiddleware, async (req, res) => {
  try { res.json((await pool.query('SELECT w.*,u.first_name,u.last_name,u.email,u.account_number FROM withdrawals w JOIN users u ON w.user_id=u.id ORDER BY w.created_at DESC')).rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/withdrawals/:id/approve', adminMiddleware, async (req, res) => {
  try {
    const w = await pool.query('SELECT w.*,u.* FROM withdrawals w JOIN users u ON w.user_id=u.id WHERE w.id=$1', [req.params.id]);
    if (!w.rows[0]) return res.status(404).json({ error: 'Not found' });
    const wdw = w.rows[0];
    await pool.query("UPDATE withdrawals SET status='approved' WHERE id=$1", [req.params.id]);
    await pool.query("UPDATE transactions SET status='completed' WHERE reference_id=$1", [wdw.reference_id]);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'success','Withdrawal Approved ✅',$2)`, [wdw.user_id, `Your withdrawal of ${wdw.currency} ${wdw.amount} has been approved.`]);
    await emailCfg.sendWithdrawalApprovedEmail(wdw.email, `${wdw.first_name} ${wdw.last_name}`, wdw.amount, wdw.currency);
    await telegram.notifyWithdrawalApproved(wdw, wdw.amount);
    res.json({ message: 'Withdrawal approved' });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/withdrawals/:id/reject', adminMiddleware, async (req, res) => {
  try {
    const { note } = req.body;
    const w = await pool.query('SELECT w.*,u.* FROM withdrawals w JOIN users u ON w.user_id=u.id WHERE w.id=$1', [req.params.id]);
    if (!w.rows[0]) return res.status(404).json({ error: 'Not found' });
    const wdw = w.rows[0];
    await pool.query("UPDATE withdrawals SET status='rejected',admin_note=$1 WHERE id=$2", [note, req.params.id]);
    await pool.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [wdw.amount, wdw.user_id]);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'error','Withdrawal Rejected',$2)`, [wdw.user_id, `Withdrawal rejected. Balance refunded. ${note || ''}`]);
    await emailCfg.sendWithdrawalRejectedEmail(wdw.email, `${wdw.first_name} ${wdw.last_name}`, wdw.amount, note);
    res.json({ message: 'Withdrawal rejected, balance refunded' });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// KYC
router.get('/kyc', adminMiddleware, async (req, res) => {
  try { res.json((await pool.query('SELECT k.*,u.first_name,u.last_name,u.email,u.account_number FROM kyc_verifications k JOIN users u ON k.user_id=u.id ORDER BY k.created_at DESC')).rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/kyc/:id/approve', adminMiddleware, async (req, res) => {
  try {
    const k = await pool.query('SELECT k.*,u.* FROM kyc_verifications k JOIN users u ON k.user_id=u.id WHERE k.id=$1', [req.params.id]);
    if (!k.rows[0]) return res.status(404).json({ error: 'Not found' });
    const kyc = k.rows[0];
    await pool.query("UPDATE kyc_verifications SET status='verified' WHERE id=$1", [req.params.id]);
    await pool.query("UPDATE users SET kyc_status='verified' WHERE id=$1", [kyc.user_id]);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'success','KYC Approved! 🎉','Your identity has been verified. Full access to all features is now unlocked!')`, [kyc.user_id]);
    await emailCfg.sendKYCApprovedEmail(kyc.email, `${kyc.first_name} ${kyc.last_name}`);
    await telegram.notifyKYCApproved(kyc);
    res.json({ message: 'KYC approved' });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/kyc/:id/reject', adminMiddleware, async (req, res) => {
  try {
    const { note } = req.body;
    const k = await pool.query('SELECT k.*,u.* FROM kyc_verifications k JOIN users u ON k.user_id=u.id WHERE k.id=$1', [req.params.id]);
    if (!k.rows[0]) return res.status(404).json({ error: 'Not found' });
    const kyc = k.rows[0];
    await pool.query("UPDATE kyc_verifications SET status='rejected',admin_note=$1 WHERE id=$2", [note, req.params.id]);
    await pool.query("UPDATE users SET kyc_status='rejected' WHERE id=$1", [kyc.user_id]);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'error','KYC Rejected',$2)`, [kyc.user_id, `KYC not approved. Reason: ${note || 'Please resubmit with clearer documents.'}`]);
    await emailCfg.sendKYCRejectedEmail(kyc.email, `${kyc.first_name} ${kyc.last_name}`, note);
    await telegram.notifyKYCRejected(kyc);
    res.json({ message: 'KYC rejected' });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// LOANS
router.get('/loans', adminMiddleware, async (req, res) => {
  try { res.json((await pool.query('SELECT l.*,u.first_name,u.last_name,u.email,u.account_number FROM loans l JOIN users u ON l.user_id=u.id ORDER BY l.created_at DESC')).rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/loans/:id/approve', adminMiddleware, async (req, res) => {
  try {
    const { interest_rate } = req.body;
    const l = await pool.query('SELECT lo.*,u.* FROM loans lo JOIN users u ON lo.user_id=u.id WHERE lo.id=$1', [req.params.id]);
    if (!l.rows[0]) return res.status(404).json({ error: 'Not found' });
    const loan = l.rows[0];
    await pool.query("UPDATE loans SET status='approved',interest_rate=$1 WHERE id=$2", [interest_rate || 5, req.params.id]);
    await pool.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [loan.amount, loan.user_id]);
    const refId = generateReferenceId();
    await pool.query("INSERT INTO transactions(user_id,type,amount,currency,status,reference_id,description) VALUES($1,'credit',$2,$3,'completed',$4,$5)", [loan.user_id, loan.amount, loan.currency, refId, `Loan approved — ${loan.loan_type}`]);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'success','Loan Approved! ✅',$2)`, [loan.user_id, `Your ${loan.loan_type} loan of ${loan.currency} ${loan.amount} has been credited to your account.`]);
    await emailCfg.sendLoanApprovedEmail(loan.email, `${loan.first_name} ${loan.last_name}`, loan.amount, loan.loan_type);
    await telegram.notifyLoanApproved(loan, loan.amount);
    res.json({ message: 'Loan approved and disbursed' });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/loans/:id/reject', adminMiddleware, async (req, res) => {
  try { await pool.query("UPDATE loans SET status='rejected',admin_note=$1 WHERE id=$2", [req.body.note, req.params.id]); res.json({ message: 'Loan rejected' }); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// INVESTMENTS
router.get('/investments', adminMiddleware, async (req, res) => {
  try { res.json((await pool.query('SELECT i.*,p.name as plan_name,u.first_name,u.last_name,u.email FROM investments i JOIN investment_plans p ON i.plan_id=p.id JOIN users u ON i.user_id=u.id ORDER BY i.created_at DESC')).rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/investment-plans/:id', adminMiddleware, async (req, res) => {
  try { const { minimum_amount, return_amount, duration_days, is_active } = req.body; await pool.query('UPDATE investment_plans SET minimum_amount=$1,return_amount=$2,duration_days=$3,is_active=$4 WHERE id=$5', [minimum_amount, return_amount, duration_days, is_active, req.params.id]); res.json({ message: 'Plan updated' }); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// CARDS
router.get('/cards', adminMiddleware, async (req, res) => {
  try { res.json((await pool.query('SELECT c.*,u.first_name,u.last_name,u.email FROM virtual_cards c JOIN users u ON c.user_id=u.id ORDER BY c.created_at DESC')).rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/cards/:id/approve', adminMiddleware, async (req, res) => {
  try {
    const c = await pool.query('SELECT c.*,u.* FROM virtual_cards c JOIN users u ON c.user_id=u.id WHERE c.id=$1', [req.params.id]);
    if (!c.rows[0]) return res.status(404).json({ error: 'Not found' });
    const card = c.rows[0];
    const cardNum = '4' + Array.from({ length: 15 }, () => Math.floor(Math.random() * 10)).join('');
    const cvv = Math.floor(100 + Math.random() * 900).toString();
    const exp = `${String(new Date().getMonth() + 1).padStart(2, '0')}/${new Date().getFullYear() + 3}`;
    await pool.query("UPDATE virtual_cards SET status='active',card_number=$1,cvv=$2,expiry_date=$3 WHERE id=$4", [cardNum, cvv, exp, req.params.id]);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'success','Virtual Card Approved! 💳','Your card is now active. View it in the Cards section.')`, [card.user_id]);
    await emailCfg.sendCardApprovedEmail(card.email, `${card.first_name} ${card.last_name}`);
    res.json({ message: 'Card approved and issued' });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/cards/:id/reject', adminMiddleware, async (req, res) => {
  try { await pool.query("UPDATE virtual_cards SET status='rejected',admin_note=$1 WHERE id=$2", [req.body.note, req.params.id]); res.json({ message: 'Card rejected' }); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// IRS
router.get('/irs', adminMiddleware, async (req, res) => {
  try { res.json((await pool.query('SELECT i.*,u.first_name,u.last_name,u.email FROM irs_requests i JOIN users u ON i.user_id=u.id ORDER BY i.created_at DESC')).rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/irs/:id/approve', adminMiddleware, async (req, res) => {
  try { await pool.query("UPDATE irs_requests SET status='approved' WHERE id=$1", [req.params.id]); res.json({ message: 'IRS approved' }); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/irs/:id/reject', adminMiddleware, async (req, res) => {
  try { await pool.query("UPDATE irs_requests SET status='rejected',admin_note=$1 WHERE id=$2", [req.body.note, req.params.id]); res.json({ message: 'IRS rejected' }); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// CUSTOMER SERVICE CHAT
router.get('/chat/users', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`SELECT DISTINCT u.id,u.first_name,u.last_name,u.email,u.account_number,(SELECT COUNT(*) FROM customer_service_messages WHERE user_id=u.id AND sender='user' AND is_read=false) as unread_count,(SELECT message FROM customer_service_messages WHERE user_id=u.id ORDER BY created_at DESC LIMIT 1) as last_message,(SELECT created_at FROM customer_service_messages WHERE user_id=u.id ORDER BY created_at DESC LIMIT 1) as last_message_time FROM users u WHERE EXISTS(SELECT 1 FROM customer_service_messages WHERE user_id=u.id) ORDER BY last_message_time DESC`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.get('/chat/:userId', adminMiddleware, async (req, res) => {
  try {
    const { lastId } = req.query;
    let q = 'SELECT * FROM customer_service_messages WHERE user_id=$1';
    const p = [req.params.userId];
    if (lastId) { q += ' AND id>$2'; p.push(lastId); }
    q += ' ORDER BY created_at ASC';
    const r = await pool.query(q, p);
    await pool.query("UPDATE customer_service_messages SET is_read=true WHERE user_id=$1 AND sender='user'", [req.params.userId]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.post('/chat/:userId/send', adminMiddleware, upload.single('image'), async (req, res) => {
  try {
    const { message, isCode } = req.body;
    const imageUrl = req.file ? await uploadToSupabase(req.file, 'chat') : null;
    const r = await pool.query("INSERT INTO customer_service_messages(user_id,sender,message,image_url,is_code) VALUES($1,'admin',$2,$3,$4) RETURNING *", [req.params.userId, message || '', imageUrl, isCode === 'true']);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'info','New Message from Support',$2)`, [req.params.userId, (message || '').substring(0, 100)]);
    res.json({ message: 'Sent', chat: r.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// CODE GENERATORS
const genCodeRoute = (field, label) => async (req, res) => {
  try {
    const code = generateCode();
    const check = await pool.query('SELECT id FROM withdrawal_sessions WHERE user_id=$1', [req.params.userId]);
    if (!check.rows[0]) return res.status(404).json({ error: 'No active withdrawal session for this user' });
    await pool.query(`UPDATE withdrawal_sessions SET ${field}=$1 WHERE user_id=$2`, [code, req.params.userId]);
    await pool.query("INSERT INTO customer_service_messages(user_id,sender,message,is_code) VALUES($1,'admin',$2,true)", [req.params.userId, `Your ${label} Code: ${code}`]);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'info','${label} Code Ready',$2)`, [req.params.userId, `Your ${label} code has been sent to Customer Service chat.`]);
    res.json({ message: `${label} code generated`, code });
  } catch (e) { res.status(500).json({ error: 'Failed to generate code' }); }
};
router.post('/chat/:userId/gen-exchange-fee', adminMiddleware, genCodeRoute('exchange_fee_code', 'Exchange Fee'));
router.post('/chat/:userId/gen-withdrawal-fee', adminMiddleware, genCodeRoute('withdrawal_fee_code', 'Withdrawal Fee'));
router.post('/chat/:userId/gen-vat', adminMiddleware, genCodeRoute('vat_code', 'VAT'));
router.post('/chat/:userId/gen-imf', adminMiddleware, genCodeRoute('imf_code', 'IMF'));

// SUPPORT CHAT
router.get('/support/users', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`SELECT DISTINCT u.id,u.first_name,u.last_name,u.email,(SELECT COUNT(*) FROM support_messages WHERE user_id=u.id AND sender='user' AND is_read=false) as unread_count,(SELECT message FROM support_messages WHERE user_id=u.id ORDER BY created_at DESC LIMIT 1) as last_message FROM users u WHERE EXISTS(SELECT 1 FROM support_messages WHERE user_id=u.id) ORDER BY last_message DESC`);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.get('/support/:userId', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM support_messages WHERE user_id=$1 ORDER BY created_at ASC', [req.params.userId]);
    await pool.query("UPDATE support_messages SET is_read=true WHERE user_id=$1 AND sender='user'", [req.params.userId]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.post('/support/:userId/send', adminMiddleware, upload.single('image'), async (req, res) => {
  try {
    const imageUrl = req.file ? await uploadToSupabase(req.file, 'chat') : null;
    const r = await pool.query("INSERT INTO support_messages(user_id,sender,message,image_url) VALUES($1,'admin',$2,$3) RETURNING *", [req.params.userId, req.body.message || '', imageUrl]);
    res.json({ message: 'Sent', chat: r.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// TICKETS
router.get('/tickets', adminMiddleware, async (req, res) => {
  try { res.json((await pool.query('SELECT t.*,u.first_name,u.last_name,u.email FROM support_tickets t JOIN users u ON t.user_id=u.id ORDER BY t.created_at DESC')).rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/tickets/:id/resolve', adminMiddleware, async (req, res) => {
  try {
    const { reply } = req.body;
    const t = await pool.query('SELECT t.*,u.* FROM support_tickets t JOIN users u ON t.user_id=u.id WHERE t.id=$1', [req.params.id]);
    if (!t.rows[0]) return res.status(404).json({ error: 'Not found' });
    await pool.query("UPDATE support_tickets SET status='resolved',admin_reply=$1 WHERE id=$2", [reply, req.params.id]);
    await emailCfg.sendTicketReplyEmail(t.rows[0].email, `${t.rows[0].first_name} ${t.rows[0].last_name}`, t.rows[0].title, reply);
    res.json({ message: 'Ticket resolved' });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// BROADCAST
router.post('/broadcast', adminMiddleware, async (req, res) => {
  try {
    const { title, message } = req.body;
    const users = await pool.query('SELECT id FROM users WHERE is_active=true');
    for (const u of users.rows) await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'info',$2,$3)`, [u.id, title, message]);
    res.json({ message: `Broadcast sent to ${users.rows.length} users` });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ALL TRANSACTIONS
router.get('/transactions', adminMiddleware, async (req, res) => {
  try { res.json((await pool.query('SELECT t.*,u.first_name,u.last_name,u.email,u.account_number FROM transactions t JOIN users u ON t.user_id=u.id ORDER BY t.created_at DESC LIMIT 200')).rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// SYSTEM MONITOR
router.get('/system-monitor', adminMiddleware, async (req, res) => {
  try {
    const [users, txns, deps, wdws, inv, pendDep, pendWdw, tables] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM transactions'),
      pool.query("SELECT COUNT(*),COALESCE(SUM(amount),0) as total FROM deposits WHERE status='approved'"),
      pool.query("SELECT COUNT(*),COALESCE(SUM(amount),0) as total FROM withdrawals WHERE status='approved'"),
      pool.query("SELECT COUNT(*) FROM investments WHERE status='active'"),
      pool.query("SELECT COUNT(*) FROM deposits WHERE status='pending'"),
      pool.query("SELECT COUNT(*) FROM withdrawals WHERE status='pending'"),
      pool.query("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'"),
    ]);
    res.json({
      database: { size: 'Supabase Free', size_bytes: 0, max_bytes: 500 * 1024 * 1024, usage_percent: '0', tables: parseInt(tables.rows[0].count) },
      users: { total: parseInt(users.rows[0].count) },
      transactions: { total: parseInt(txns.rows[0].count) },
      deposits: { total: parseInt(deps.rows[0].count), amount: parseFloat(deps.rows[0].total), pending: parseInt(pendDep.rows[0].count) },
      withdrawals: { total: parseInt(wdws.rows[0].count), amount: parseFloat(wdws.rows[0].total), pending: parseInt(pendWdw.rows[0].count) },
      investments: { active: parseInt(inv.rows[0].count) },
      server: { uptime: process.uptime(), memory: process.memoryUsage(), node_version: process.version, environment: process.env.NODE_ENV },
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed' }); }
});

// SETTINGS
router.get('/settings', adminMiddleware, async (req, res) => {
  try { res.json((await pool.query("SELECT * FROM system_settings WHERE key NOT LIKE 'user_theme_%'")).rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/settings', adminMiddleware, async (req, res) => {
  try {
    for (const [key, value] of Object.entries(req.body)) await pool.query("INSERT INTO system_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2,updated_at=NOW()", [key, value]);
    res.json({ message: 'Settings updated' });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/exchange-rates', adminMiddleware, async (req, res) => {
  try {
    for (const rate of req.body.rates) await pool.query('UPDATE exchange_rates SET rate=$1,updated_at=NOW() WHERE target_currency=$2', [rate.rate, rate.currency]);
    res.json({ message: 'Rates updated' });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

module.exports = router;
