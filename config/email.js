const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  host: 'smtp-relay.brevo.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.BREVO_LOGIN,
    pass: process.env.BREVO_PASSWORD,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

const FROM = `"BluePeak Finance" <bluepeakfinance02@gmail.com>`;

const css = `<style>body{font-family:Arial,sans-serif;background:#f4f6f9;margin:0;padding:20px}.w{max-width:580px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)}.h{background:linear-gradient(135deg,#0A1628,#1E3A5F);padding:26px 34px;text-align:center}.h h1{color:#F0B429;margin:0;font-size:22px}.h p{color:rgba(255,255,255,.6);margin:4px 0 0;font-size:12px}.b{padding:28px 34px}.g{font-size:16px;color:#0A1628;font-weight:bold;margin-bottom:14px}.t{font-size:13px;color:#444;line-height:1.7;margin-bottom:16px}.code{background:#0A1628;color:#F0B429;font-size:36px;font-weight:bold;text-align:center;padding:20px;border-radius:8px;letter-spacing:10px;margin:18px 0}.amt{font-size:30px;color:#0A1628;font-weight:bold;text-align:center;margin:14px 0}.info{background:#f8f9fc;border-left:4px solid #F0B429;padding:14px;border-radius:0 8px 8px 0;margin:14px 0}.ir{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #e5e7eb;font-size:12px}.ir:last-child{border-bottom:none}.il{color:#6B7280}.iv{color:#0A1628;font-weight:600}.bs{background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:bold}.bp{background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:bold}.br{background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:bold}.f{background:#f8f9fc;padding:18px 34px;text-align:center;border-top:1px solid #e5e7eb}.f p{color:#9CA3AF;font-size:11px;margin:3px 0}.warn{color:#EF4444;font-size:11px;margin-top:7px}</style>`;

const base = (content) => `<!DOCTYPE html><html><head><meta charset="UTF-8">${css}</head><body><div class="w"><div class="h"><h1>🏦 BluePeak Finance</h1><p>Secure & Reliable Banking</p></div><div class="b">${content}</div><div class="f"><p><strong>BluePeak Finance</strong></p><p>bluepeakfinance02@gmail.com</p><p class="warn">⚠️ If you did not perform this action, contact support immediately.</p><p style="margin-top:7px;color:#ccc">© ${new Date().getFullYear()} BluePeak Finance. All rights reserved.</p></div></div></body></html>`;

const send = async (to, subject, html) => {
  try {
    const info = await transporter.sendMail({ from: FROM, to, subject, html });
    console.log(`✅ Email sent → ${to} | id: ${info.messageId}`);
  } catch (e) {
    console.error('❌ Email error:', e.message);
  }
};

module.exports = {
  sendOTPEmail: (to, name, otp) => send(to, '🔐 Verify Your BluePeak Finance Account', base(`<p class="g">Hello ${name}!</p><p class="t">Enter this code to verify your email address:</p><div class="code">${otp}</div><p class="t" style="text-align:center;color:#6B7280;font-size:12px">⏰ Expires in <strong>15 minutes</strong>. Never share this code.</p>`)),
  sendWelcomeEmail: (to, name, acct) => send(to, '🎉 Welcome to BluePeak Finance!', base(`<p class="g">Welcome ${name}! 🎉</p><p class="t">Your account has been created successfully.</p><div class="info"><div class="ir"><span class="il">Account Name</span><span class="iv">${name}</span></div><div class="ir"><span class="il">Account Number</span><span class="iv">${acct}</span></div><div class="ir"><span class="il">Status</span><span class="iv"><span class="bs">✅ Active</span></span></div></div><p class="t">Complete your <strong>KYC verification</strong> to unlock all features.</p>`)),
  sendLoginAlert: (to, name) => send(to, '🔐 New Login Detected — BluePeak Finance', base(`<p class="g">Security Alert</p><p class="t">Hello ${name}, a new login was detected at ${new Date().toLocaleString()}. If this was not you, change your password immediately.</p>`)),
  sendPasswordResetEmail: (to, name, otp) => send(to, '🔑 Password Reset Code', base(`<p class="g">Password Reset</p><p class="t">Hello ${name}, use this code to reset your password:</p><div class="code">${otp}</div><p class="t" style="text-align:center;color:#6B7280;font-size:12px">⏰ Expires in <strong>15 minutes</strong></p>`)),
  sendPasswordChangedEmail: (to, name) => send(to, '✅ Password Changed', base(`<p class="g">Password Changed</p><p class="t">Hello ${name}, your password was changed at ${new Date().toLocaleString()}. If this was not you, contact support immediately.</p>`)),
  sendDepositRequestEmail: (to, name, amount, currency) => send(to, '💰 Deposit Request Received', base(`<p class="g">Deposit Received</p><div class="amt">${currency} ${parseFloat(amount).toLocaleString()}</div><div class="info"><div class="ir"><span class="il">Status</span><span class="iv"><span class="bp">⏳ Pending</span></span></div><div class="ir"><span class="il">Date</span><span class="iv">${new Date().toLocaleString()}</span></div></div>`)),
  sendDepositApprovedEmail: (to, name, amount, currency) => send(to, '✅ Deposit Approved!', base(`<p class="g">Deposit Approved! ✅</p><div class="amt">${currency} ${parseFloat(amount).toLocaleString()}</div><p class="t">Your deposit has been credited to your account balance.</p>`)),
  sendDepositRejectedEmail: (to, name, amount, reason) => send(to, '❌ Deposit Declined', base(`<p class="g">Deposit Declined</p><div class="info"><div class="ir"><span class="il">Amount</span><span class="iv">${amount}</span></div><div class="ir"><span class="il">Reason</span><span class="iv">${reason || 'Contact support for details'}</span></div></div>`)),
  sendWithdrawalRequestEmail: (to, name, amount, currency) => send(to, '🏧 Withdrawal Request Received', base(`<p class="g">Withdrawal Received</p><div class="amt">${currency} ${parseFloat(amount).toLocaleString()}</div><p class="t">Go to <strong>Customer Service</strong> in your dashboard to request your verification codes to complete the withdrawal.</p>`)),
  sendWithdrawalApprovedEmail: (to, name, amount, currency) => send(to, '✅ Withdrawal Approved!', base(`<p class="g">Withdrawal Approved! ✅</p><div class="amt">${currency} ${parseFloat(amount).toLocaleString()}</div><p class="t">Your withdrawal is being processed and will be sent to your account.</p>`)),
  sendWithdrawalRejectedEmail: (to, name, amount, reason) => send(to, '❌ Withdrawal Declined', base(`<p class="g">Withdrawal Declined</p><div class="info"><div class="ir"><span class="il">Amount</span><span class="iv">${amount}</span></div><div class="ir"><span class="il">Reason</span><span class="iv">${reason || 'Contact support'}</span></div></div>`)),
  sendTransferSentEmail: (to, name, amount, currency, recipient, refId) => send(to, '✅ Transfer Successful', base(`<p class="g">Transfer Successful ✅</p><div class="amt">${currency} ${parseFloat(amount).toLocaleString()}</div><div class="info"><div class="ir"><span class="il">Recipient</span><span class="iv">${recipient}</span></div><div class="ir"><span class="il">Reference</span><span class="iv">${refId}</span></div><div class="ir"><span class="il">Status</span><span class="iv"><span class="bs">✅ Completed</span></span></div></div>`)),
  sendKYCSubmittedEmail: (to, name) => send(to, '🪪 KYC Documents Received', base(`<p class="g">KYC Submitted</p><p class="t">Hello ${name}, we received your KYC documents. Our team will review within 24 hours and notify you of the outcome.</p>`)),
  sendKYCApprovedEmail: (to, name) => send(to, '✅ KYC Approved — Full Access Unlocked!', base(`<p class="g">KYC Approved! 🎉</p><p class="t">Hello ${name}, your identity has been verified. You now have <strong>full access</strong> to all BluePeak Finance features!</p>`)),
  sendKYCRejectedEmail: (to, name, reason) => send(to, '❌ KYC Not Approved', base(`<p class="g">KYC Rejected</p><div class="info"><div class="ir"><span class="il">Reason</span><span class="iv">${reason || 'Documents unclear or invalid'}</span></div></div><p class="t">Please resubmit with clearer, valid documents.</p>`)),
  sendInvestmentEmail: (to, name, plan, amount, ret, maturity) => send(to, '📈 Investment Confirmed!', base(`<p class="g">Investment Confirmed! 📈</p><div class="amt">$${parseFloat(amount).toLocaleString()}</div><div class="info"><div class="ir"><span class="il">Plan</span><span class="iv">${plan}</span></div><div class="ir"><span class="il">Expected Return</span><span class="iv">$${parseFloat(ret).toLocaleString()}</span></div><div class="ir"><span class="il">Maturity Date</span><span class="iv">${new Date(maturity).toLocaleDateString()}</span></div></div>`)),
  sendInvestmentMaturedEmail: (to, name, plan, ret) => send(to, '💹 Investment Matured — Returns Credited!', base(`<p class="g">Investment Matured! 💹</p><p class="t">Hello ${name}, your <strong>${plan}</strong> investment has matured!</p><div class="amt">$${parseFloat(ret).toLocaleString()}</div><p class="t">Returns have been credited to your account. Start a new investment to keep growing!</p>`)),
  sendLoanApprovedEmail: (to, name, amount, type) => send(to, '✅ Loan Approved!', base(`<p class="g">Loan Approved! ✅</p><div class="amt">$${parseFloat(amount).toLocaleString()}</div><div class="info"><div class="ir"><span class="il">Loan Type</span><span class="iv">${type}</span></div><div class="ir"><span class="il">Status</span><span class="iv"><span class="bs">Disbursed to Account</span></span></div></div>`)),
  sendCardApprovedEmail: (to, name) => send(to, '💳 Virtual Card Approved!', base(`<p class="g">Virtual Card Ready! 💳</p><p class="t">Hello ${name}, your virtual card is now active. Log in to your dashboard to view card details.</p>`)),
  sendFundsAddedEmail: (to, name, amount, currency) => send(to, '💰 Account Credited — BluePeak Finance', base(`<p class="g">Account Credited 💰</p><div class="amt">${currency} ${parseFloat(amount).toLocaleString()}</div><p class="t">Your BluePeak Finance account has been credited successfully.</p>`)),
  sendFundsRemovedEmail: (to, name, amount, currency) => send(to, 'ℹ️ Account Debited', base(`<p class="g">Account Debited</p><div class="amt">${currency} ${parseFloat(amount).toLocaleString()}</div>`)),
  sendAccountSuspendedEmail: (to, name) => send(to, '🚫 Account Suspended', base(`<p class="g">Account Suspended 🚫</p><p class="t">Hello ${name}, your account has been temporarily suspended. Please contact our support team for assistance.</p>`)),
  sendAccountReactivatedEmail: (to, name) => send(to, '✅ Account Reactivated', base(`<p class="g">Account Reactivated ✅</p><p class="t">Hello ${name}, your BluePeak Finance account is now active again.</p>`)),
  sendTicketReplyEmail: (to, name, title, reply) => send(to, '🎫 Support Ticket Reply', base(`<p class="g">Ticket Reply</p><div class="info"><div class="ir"><span class="il">Ticket</span><span class="iv">${title}</span></div><div class="ir"><span class="il">Reply</span><span class="iv">${reply}</span></div></div>`)),
};