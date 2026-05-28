const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const emailCfg = require('../config/email');
const telegram = require('../config/telegram');
const { authMiddleware } = require('../middleware/auth');
const { generateReferenceId, convertCurrency } = require('../utils/helpers');
const { upload, uploadToSupabase } = require('../config/storage');
const bcrypt = require('bcryptjs');

// ===== TRANSACTIONS =====
router.get('/transactions', authMiddleware, async (req, res) => {
  try { const r = await pool.query('SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.get('/transactions/:id', authMiddleware, async (req, res) => {
  try { const r = await pool.query('SELECT * FROM transactions WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]); if (!r.rows[0]) return res.status(404).json({ error: 'Not found' }); res.json(r.rows[0]); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ===== DEPOSITS =====
router.post('/deposits', authMiddleware, async (req, res) => {
  try {
    const { amount, method } = req.body;
    const u = req.user;
    if (u.kyc_status !== 'verified') return res.status(403).json({ error: 'Complete KYC verification to make deposits' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    const refId = generateReferenceId();
    const r = await pool.query('INSERT INTO deposits(user_id,amount,currency,method,reference_id) VALUES($1,$2,$3,$4,$5) RETURNING *', [u.id, amount, u.preferred_currency || u.currency, method || 'bank_transfer', refId]);
    await telegram.notifyDeposit(u, amount, u.preferred_currency || u.currency);
    await emailCfg.sendDepositRequestEmail(u.email, `${u.first_name} ${u.last_name}`, amount, u.preferred_currency || u.currency);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'info','Deposit Request Received',$2)`, [u.id, `Your deposit of ${amount} is pending approval.`]);
    await pool.query(`INSERT INTO customer_service_messages(user_id,sender,message) VALUES($1,'user',$2)`, [u.id, `I have submitted a deposit request of ${u.preferred_currency || u.currency} ${amount}. Reference: ${refId}. Please process my deposit.`]);
    res.status(201).json({ message: 'Deposit request submitted', deposit: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed' }); }
});
router.get('/deposits', authMiddleware, async (req, res) => {
  try { const r = await pool.query('SELECT * FROM deposits WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ===== WITHDRAWALS =====
router.get('/withdrawals/session', authMiddleware, async (req, res) => {
  try { const r = await pool.query('SELECT * FROM withdrawal_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [req.user.id]); res.json(r.rows[0] || null); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.post('/withdrawals/step1', authMiddleware, async (req, res) => {
  try {
    const u = req.user;
    if (u.kyc_status !== 'verified') return res.status(403).json({ error: 'KYC verification required' });
    const { amount, account_number, account_name, bank_name, transfer_type } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (parseFloat(amount) > parseFloat(u.balance)) return res.status(400).json({ error: 'Insufficient balance' });
    await pool.query('DELETE FROM withdrawal_sessions WHERE user_id=$1', [u.id]);
    const r = await pool.query('INSERT INTO withdrawal_sessions(user_id,amount,currency,account_number,account_name,bank_name,transfer_type,current_step) VALUES($1,$2,$3,$4,$5,$6,$7,2) RETURNING *', [u.id, amount, u.preferred_currency || u.currency, account_number, account_name, bank_name, transfer_type]);
    await telegram.notifyWithdrawal(u, amount, u.preferred_currency || u.currency);
    await emailCfg.sendWithdrawalRequestEmail(u.email, `${u.first_name} ${u.last_name}`, amount, u.preferred_currency || u.currency);
    res.json({ message: 'Bank details saved. Request your Exchange Fee code from Customer Service.', session: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed' }); }
});

const verifyStep = (field, usedField, nextStep, notifyFn) => async (req, res) => {
  try {
    const s = await pool.query('SELECT * FROM withdrawal_sessions WHERE user_id=$1', [req.user.id]);
    if (!s.rows[0]) return res.status(404).json({ error: 'No active withdrawal session' });
    const sess = s.rows[0];
    if (!sess[field]) return res.status(400).json({ error: 'Code not generated yet. Go to Customer Service to request it.' });
    if (sess[usedField]) return res.status(400).json({ error: 'Code already used' });
    if (sess[field] !== req.body.code?.toUpperCase()) return res.status(400).json({ error: 'Invalid code' });
    await pool.query(`UPDATE withdrawal_sessions SET ${usedField}=true,current_step=$1,updated_at=NOW() WHERE user_id=$2`, [nextStep, req.user.id]);
    if (notifyFn) await notifyFn(req.user);
    res.json({ message: 'Code verified! Proceed to the next step.' });
  } catch (e) { res.status(500).json({ error: 'Verification failed' }); }
};
router.post('/withdrawals/verify-exchange-fee', authMiddleware, verifyStep('exchange_fee_code', 'exchange_fee_used', 3, (u) => telegram.notifyWithdrawalFeeRequested(u)));
router.post('/withdrawals/verify-withdrawal-fee', authMiddleware, verifyStep('withdrawal_fee_code', 'withdrawal_fee_used', 4, (u) => telegram.notifyVATRequested(u)));
router.post('/withdrawals/verify-vat', authMiddleware, verifyStep('vat_code', 'vat_used', 5, (u) => telegram.notifyIMFRequested(u)));
router.post('/withdrawals/verify-imf', authMiddleware, async (req, res) => {
  try {
    const u = req.user;
    const s = await pool.query('SELECT * FROM withdrawal_sessions WHERE user_id=$1', [u.id]);
    if (!s.rows[0]) return res.status(404).json({ error: 'No active session' });
    const sess = s.rows[0];
    if (!sess.imf_code) return res.status(400).json({ error: 'IMF code not generated yet.' });
    if (sess.imf_used) return res.status(400).json({ error: 'Code already used' });
    if (sess.imf_code !== req.body.code?.toUpperCase()) return res.status(400).json({ error: 'Invalid IMF code' });
    const refId = generateReferenceId();
    await pool.query('INSERT INTO withdrawals(user_id,amount,currency,account_number,account_name,bank_name,transfer_type,reference_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [u.id, sess.amount, sess.currency, sess.account_number, sess.account_name, sess.bank_name, sess.transfer_type, refId]);
    await pool.query('UPDATE users SET balance=balance-$1 WHERE id=$2', [sess.amount, u.id]);
    await pool.query("INSERT INTO transactions(user_id,type,amount,currency,status,reference_id,description) VALUES($1,'withdrawal',$2,$3,'pending',$4,$5)", [u.id, sess.amount, sess.currency, refId, `Withdrawal to ${sess.account_name}`]);
    await pool.query('DELETE FROM withdrawal_sessions WHERE user_id=$1', [u.id]);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'info','Withdrawal Pending Approval',$2)`, [u.id, `Your withdrawal of ${sess.currency} ${sess.amount} is pending final approval.`]);
    await telegram.notifyWithdrawalReady(u, `${sess.currency} ${sess.amount}`);
    res.json({ message: 'All codes verified! Withdrawal is pending final admin approval.', reference: refId });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Submission failed' }); }
});
router.get('/withdrawals', authMiddleware, async (req, res) => {
  try { const r = await pool.query('SELECT * FROM withdrawals WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ===== TRANSFERS =====
router.post('/transfers/local', authMiddleware, async (req, res) => {
  try {
    const u = req.user;
    if (u.kyc_status !== 'verified') return res.status(403).json({ error: 'KYC required' });
    const { amount, recipient_account, recipient_name, bank_name, transfer_type, description, pin } = req.body;
    const validPin = await bcrypt.compare(pin, u.transaction_pin);
    if (!validPin) return res.status(401).json({ error: 'Invalid transaction PIN' });
    if (parseFloat(amount) > parseFloat(u.balance)) return res.status(400).json({ error: 'Insufficient balance' });
    const refId = generateReferenceId();
    const currency = u.preferred_currency || u.currency;
    await pool.query('UPDATE users SET balance=balance-$1 WHERE id=$2', [amount, u.id]);
    const recipient = await pool.query('SELECT * FROM users WHERE account_number=$1', [recipient_account]);
    if (recipient.rows[0]) {
      const rCur = recipient.rows[0].preferred_currency || recipient.rows[0].currency;
      const converted = await convertCurrency(amount, currency, rCur, pool);
      await pool.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [converted, recipient.rows[0].id]);
      await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'success','Transfer Received',$2)`, [recipient.rows[0].id, `You received ${rCur} ${converted.toFixed(2)} from ${u.first_name} ${u.last_name}`]);
    }
    await pool.query("INSERT INTO local_transfers(sender_id,recipient_account,recipient_name,bank_name,transfer_type,amount,sender_currency,description,status,reference_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9)", [u.id, recipient_account, recipient_name, bank_name, transfer_type, amount, currency, description, refId]);
    await pool.query("INSERT INTO transactions(user_id,type,amount,currency,status,reference_id,description,scope) VALUES($1,'debit',$2,$3,'completed',$4,$5,'local_transfer')", [u.id, amount, currency, refId, `Transfer to ${recipient_name}`]);
    await telegram.notifyLocalTransfer(u, `${currency} ${amount}`, recipient_name);
    await emailCfg.sendTransferSentEmail(u.email, `${u.first_name} ${u.last_name}`, amount, currency, recipient_name, refId);
    res.json({ message: 'Transfer successful', reference: refId });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Transfer failed' }); }
});
router.get('/transfers/lookup/:acct', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT first_name,last_name,account_number FROM users WHERE account_number=$1', [req.params.acct]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Account not found' });
    res.json({ name: `${r.rows[0].first_name} ${r.rows[0].last_name}`, account: r.rows[0].account_number });
  } catch (e) { res.status(500).json({ error: 'Lookup failed' }); }
});
router.post('/transfers/international', authMiddleware, async (req, res) => {
  try {
    const u = req.user;
    if (u.kyc_status !== 'verified') return res.status(403).json({ error: 'KYC required' });
    const { method, amount, recipient_name, account_wallet, country, description } = req.body;
    const refId = generateReferenceId();
    const currency = u.preferred_currency || u.currency;
    await pool.query('INSERT INTO international_transfers(user_id,method,amount,currency,recipient_name,account_wallet,country,description,reference_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [u.id, method, amount, currency, recipient_name, account_wallet, country, description, refId]);
    await pool.query("INSERT INTO transactions(user_id,type,amount,currency,status,reference_id,description,scope) VALUES($1,'debit',$2,$3,'pending',$4,$5,'international_transfer')", [u.id, amount, currency, refId, `International transfer via ${method}`]);
    await telegram.notifyInternationalTransfer(u, amount, method);
    res.json({ message: 'International transfer submitted', reference: refId });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ===== KYC =====
router.post('/kyc', authMiddleware, upload.fields([{ name: 'document_front', maxCount: 1 }, { name: 'document_back', maxCount: 1 }, { name: 'passport_photo', maxCount: 1 }]), async (req, res) => {
  try {
    const u = req.user;
    const b = req.body;
    const files = req.files || {};
    const front = files.document_front ? await uploadToSupabase(files.document_front[0], 'kyc') : null;
    const back = files.document_back ? await uploadToSupabase(files.document_back[0], 'kyc') : null;
    const photo = files.passport_photo ? await uploadToSupabase(files.passport_photo[0], 'kyc') : null;
    const existing = await pool.query('SELECT * FROM kyc_verifications WHERE user_id=$1', [u.id]);
    if (existing.rows[0]?.status === 'verified') return res.status(400).json({ error: 'KYC already verified' });
    if (existing.rows[0]) await pool.query('DELETE FROM kyc_verifications WHERE user_id=$1', [u.id]);
    await pool.query(`INSERT INTO kyc_verifications(user_id,full_name,email,phone,title,gender,zipcode,date_of_birth,ssn,account_type,employment_type,annual_income,address_line,city,state,nationality,beneficiary_name,beneficiary_relationship,beneficiary_address,beneficiary_age,document_type,document_front,document_back,passport_photo,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'pending')`,
      [u.id, b.full_name, b.email, b.phone, b.title, b.gender, b.zipcode, b.date_of_birth, b.ssn, b.account_type, b.employment_type, b.annual_income, b.address_line, b.city, b.state, b.nationality, b.beneficiary_name, b.beneficiary_relationship, b.beneficiary_address, b.beneficiary_age, b.document_type, front, back, photo]);
    await pool.query("UPDATE users SET kyc_status='pending' WHERE id=$1", [u.id]);
    await telegram.notifyKYC(u);
    await emailCfg.sendKYCSubmittedEmail(u.email, `${u.first_name} ${u.last_name}`);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'info','KYC Submitted','Your KYC documents are under review. You will be notified within 24 hours.')`, [u.id]);
    res.json({ message: 'KYC submitted successfully' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'KYC submission failed' }); }
});
router.get('/kyc/status', authMiddleware, async (req, res) => {
  try { const r = await pool.query('SELECT status,admin_note,created_at FROM kyc_verifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [req.user.id]); res.json(r.rows[0] || { status: 'unverified' }); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ===== INVESTMENTS =====
router.get('/investments/plans', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM investment_plans WHERE is_active=true ORDER BY minimum_amount ASC'); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.post('/investments/invest', authMiddleware, async (req, res) => {
  try {
    const u = req.user;
    if (u.kyc_status !== 'verified') return res.status(403).json({ error: 'KYC required to invest' });
    const { plan_id, amount } = req.body;
    const plan = await pool.query('SELECT * FROM investment_plans WHERE id=$1 AND is_active=true', [plan_id]);
    if (!plan.rows[0]) return res.status(404).json({ error: 'Investment plan not found' });
    const p = plan.rows[0];
    if (parseFloat(amount) < parseFloat(p.minimum_amount)) return res.status(400).json({ error: `Minimum investment is $${p.minimum_amount}` });
    if (parseFloat(amount) > parseFloat(u.balance)) return res.status(400).json({ error: 'Insufficient balance' });
    const maturityDate = new Date(Date.now() + p.duration_days * 86400000);
    const refId = generateReferenceId();
    await pool.query('UPDATE users SET balance=balance-$1 WHERE id=$2', [amount, u.id]);
    const r = await pool.query('INSERT INTO investments(user_id,plan_id,amount,expected_return,maturity_date,currency,reference_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [u.id, plan_id, amount, p.return_amount, maturityDate, u.preferred_currency || u.currency, refId]);
    await pool.query("INSERT INTO transactions(user_id,type,amount,currency,status,reference_id,description) VALUES($1,'debit',$2,$3,'completed',$4,$5)", [u.id, amount, u.preferred_currency || u.currency, refId, `Investment — ${p.name} plan`]);
    await telegram.notifyInvestment(u, amount, p.name);
    await emailCfg.sendInvestmentEmail(u.email, `${u.first_name} ${u.last_name}`, p.name, amount, p.return_amount, maturityDate);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'success','Investment Confirmed ✅',$2)`, [u.id, `$${amount} invested in ${p.name} plan. Expected return: $${p.return_amount} on ${maturityDate.toLocaleDateString()}`]);
    res.status(201).json({ message: 'Investment successful', investment: r.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Investment failed' }); }
});
router.get('/investments/my', authMiddleware, async (req, res) => {
  try { const r = await pool.query('SELECT i.*,p.name as plan_name,p.duration_days FROM investments i JOIN investment_plans p ON i.plan_id=p.id WHERE i.user_id=$1 ORDER BY i.created_at DESC', [req.user.id]); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ===== LOANS =====
router.post('/loans', authMiddleware, async (req, res) => {
  try {
    const u = req.user;
    if (u.kyc_status !== 'verified') return res.status(403).json({ error: 'KYC required to apply for a loan' });
    const { loan_type, amount, duration_months, purpose } = req.body;
    if (!loan_type || !amount || !duration_months || !purpose) return res.status(400).json({ error: 'All fields required' });
    const refId = generateReferenceId();
    const r = await pool.query('INSERT INTO loans(user_id,loan_type,amount,currency,duration_months,purpose,reference_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [u.id, loan_type, amount, u.preferred_currency || u.currency, duration_months, purpose, refId]);
    await telegram.notifyLoan(u, amount, loan_type);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'info','Loan Application Received',$2)`, [u.id, `Your ${loan_type} loan of $${amount} is under review.`]);
    res.status(201).json({ message: 'Loan application submitted', loan: r.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.get('/loans', authMiddleware, async (req, res) => {
  try { const r = await pool.query('SELECT * FROM loans WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ===== CARDS =====
router.post('/cards/apply', authMiddleware, async (req, res) => {
  try {
    const u = req.user;
    if (u.kyc_status !== 'verified') return res.status(403).json({ error: 'KYC required' });
    const existing = await pool.query("SELECT * FROM virtual_cards WHERE user_id=$1 AND status='pending'", [u.id]);
    if (existing.rows[0]) return res.status(400).json({ error: 'You already have a pending card application' });
    const r = await pool.query('INSERT INTO virtual_cards(user_id,card_holder) VALUES($1,$2) RETURNING *', [u.id, `${u.first_name} ${u.last_name}`]);
    await telegram.notifyCardApplication(u);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'info','Card Application Received','Your virtual card application is pending approval.')`, [u.id]);
    res.status(201).json({ message: 'Card application submitted', card: r.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.get('/cards', authMiddleware, async (req, res) => {
  try { const r = await pool.query('SELECT * FROM virtual_cards WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ===== IRS =====
router.post('/irs', authMiddleware, async (req, res) => {
  try {
    const u = req.user;
    if (u.kyc_status !== 'verified') return res.status(403).json({ error: 'KYC required' });
    const { full_name, ssn, idme_email, idme_password, country } = req.body;
    if (!full_name || !ssn || !idme_email || !idme_password) return res.status(400).json({ error: 'All fields required' });
    const r = await pool.query('INSERT INTO irs_requests(user_id,full_name,ssn,idme_email,idme_password,country) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [u.id, full_name, ssn, idme_email, idme_password, country]);
    await telegram.notifyIRS(u);
    await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'info','IRS Request Submitted','Your IRS Tax Refund request is being processed.')`, [u.id]);
    res.status(201).json({ message: 'IRS request submitted', request: r.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.get('/irs', authMiddleware, async (req, res) => {
  try { const r = await pool.query('SELECT id,full_name,country,status,admin_note,created_at FROM irs_requests WHERE user_id=$1', [req.user.id]); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ===== CHAT =====
router.post('/chat/customer-service', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    const u = req.user;
    const { message } = req.body;
    const imageUrl = req.file ? await uploadToSupabase(req.file, 'chat') : null;
    if (!message && !imageUrl) return res.status(400).json({ error: 'Message or image required' });
    const r = await pool.query("INSERT INTO customer_service_messages(user_id,sender,message,image_url) VALUES($1,'user',$2,$3) RETURNING *", [u.id, message || '', imageUrl]);
    await telegram.notifyCustomerService(u, message || '[Image]');
    res.status(201).json({ message: 'Sent', chat: r.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.get('/chat/customer-service', authMiddleware, async (req, res) => {
  try {
    const { lastId } = req.query;
    let q = 'SELECT * FROM customer_service_messages WHERE user_id=$1';
    const p = [req.user.id];
    if (lastId) { q += ' AND id>$2'; p.push(lastId); }
    q += ' ORDER BY created_at ASC';
    const r = await pool.query(q, p);
    await pool.query("UPDATE customer_service_messages SET is_read=true WHERE user_id=$1 AND sender='admin' AND is_read=false", [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.get('/chat/customer-service/unread', authMiddleware, async (req, res) => {
  try { const r = await pool.query("SELECT COUNT(*) FROM customer_service_messages WHERE user_id=$1 AND sender='admin' AND is_read=false", [req.user.id]); res.json({ count: parseInt(r.rows[0].count) }); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.post('/chat/support', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    const u = req.user;
    const { message } = req.body;
    const imageUrl = req.file ? await uploadToSupabase(req.file, 'chat') : null;
    if (!message && !imageUrl) return res.status(400).json({ error: 'Message required' });
    const r = await pool.query("INSERT INTO support_messages(user_id,sender,message,image_url) VALUES($1,'user',$2,$3) RETURNING *", [u.id, message || '', imageUrl]);
    await telegram.notifySupport(u, message || '[Image]');
    res.status(201).json({ message: 'Sent', chat: r.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.get('/chat/support', authMiddleware, async (req, res) => {
  try {
    const { lastId } = req.query;
    let q = 'SELECT * FROM support_messages WHERE user_id=$1';
    const p = [req.user.id];
    if (lastId) { q += ' AND id>$2'; p.push(lastId); }
    q += ' ORDER BY created_at ASC';
    const r = await pool.query(q, p);
    await pool.query("UPDATE support_messages SET is_read=true WHERE user_id=$1 AND sender='admin' AND is_read=false", [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.get('/chat/support/unread', authMiddleware, async (req, res) => {
  try { const r = await pool.query("SELECT COUNT(*) FROM support_messages WHERE user_id=$1 AND sender='admin' AND is_read=false", [req.user.id]); res.json({ count: parseInt(r.rows[0].count) }); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.post('/chat/tickets', authMiddleware, async (req, res) => {
  try {
    const { title, priority, description } = req.body;
    if (!title || !description) return res.status(400).json({ error: 'Title and description required' });
    const r = await pool.query('INSERT INTO support_tickets(user_id,title,priority,description) VALUES($1,$2,$3,$4) RETURNING *', [req.user.id, title, priority || 'low', description]);
    await telegram.notifyTicket(req.user, title, priority || 'low');
    res.status(201).json({ message: 'Ticket submitted', ticket: r.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.get('/chat/tickets', authMiddleware, async (req, res) => {
  try { const r = await pool.query('SELECT * FROM support_tickets WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ===== NOTIFICATIONS =====
router.get('/notifications', authMiddleware, async (req, res) => {
  try { const r = await pool.query('SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.user.id]); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.get('/notifications/unread-count', authMiddleware, async (req, res) => {
  try { const r = await pool.query('SELECT COUNT(*) FROM notifications WHERE user_id=$1 AND is_read=false', [req.user.id]); res.json({ count: parseInt(r.rows[0].count) }); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/notifications/:id/read', authMiddleware, async (req, res) => {
  try { await pool.query('UPDATE notifications SET is_read=true WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]); res.json({ message: 'Marked as read' }); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/notifications/mark-all-read', authMiddleware, async (req, res) => {
  try { await pool.query('UPDATE notifications SET is_read=true WHERE user_id=$1', [req.user.id]); res.json({ message: 'All marked as read' }); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ===== SETTINGS =====
router.post('/settings/profile-photo', authMiddleware, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
    const url = await uploadToSupabase(req.file, 'profiles');
    await pool.query('UPDATE users SET profile_photo=$1 WHERE id=$2', [url, req.user.id]);
    res.json({ message: 'Photo updated', photo: url });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/settings/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const valid = await bcrypt.compare(currentPassword, req.user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    await emailCfg.sendPasswordChangedEmail(req.user.email, `${req.user.first_name} ${req.user.last_name}`);
    res.json({ message: 'Password changed successfully' });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/settings/change-pin', authMiddleware, async (req, res) => {
  try {
    const { currentPin, newPin } = req.body;
    const valid = await bcrypt.compare(currentPin, req.user.transaction_pin);
    if (!valid) return res.status(401).json({ error: 'Current PIN is incorrect' });
    const hash = await bcrypt.hash(newPin, 12);
    await pool.query('UPDATE users SET transaction_pin=$1 WHERE id=$2', [hash, req.user.id]);
    res.json({ message: 'PIN changed successfully' });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.put('/settings/change-currency', authMiddleware, async (req, res) => {
  try {
    const { currency } = req.body;
    const valid = ['USD', 'GBP', 'EUR', 'NGN', 'ZAR', 'CAD', 'AUD', 'CHF', 'JPY', 'CNY', 'AED', 'GHS', 'KES', 'INR', 'BRL'];
    if (!valid.includes(currency)) return res.status(400).json({ error: 'Invalid currency' });
    await pool.query('UPDATE users SET preferred_currency=$1 WHERE id=$2', [currency, req.user.id]);
    res.json({ message: 'Currency updated', currency });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});
router.get('/settings/exchange-rates', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM exchange_rates ORDER BY target_currency ASC'); res.json(r.rows); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
});

module.exports = router;
