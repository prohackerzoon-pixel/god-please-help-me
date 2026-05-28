const generateAccountNumber = () => Math.floor(1000000000 + Math.random() * 9000000000).toString();
const generateReferenceId = () => `BPF-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();
const generateCode = () => { const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; return Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join(''); };

const convertCurrency = async (amount, from, to, pool) => {
  if (from === to) return parseFloat(amount);
  const f = await pool.query('SELECT rate FROM exchange_rates WHERE target_currency=$1', [from]);
  const t = await pool.query('SELECT rate FROM exchange_rates WHERE target_currency=$1', [to]);
  if (!f.rows[0] || !t.rows[0]) return parseFloat(amount);
  return (parseFloat(amount) / parseFloat(f.rows[0].rate)) * parseFloat(t.rows[0].rate);
};

module.exports = { generateAccountNumber, generateReferenceId, generateOTP, generateCode, convertCurrency };
