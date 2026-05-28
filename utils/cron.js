const cron = require('node-cron');
const pool = require('../config/db');
const email = require('../config/email');
const telegram = require('../config/telegram');

const startCronJobs = () => {
  cron.schedule('0 * * * *', async () => {
    try {
      const matured = await pool.query(`SELECT i.*,p.name as plan_name,u.email,u.first_name,u.last_name,u.preferred_currency,u.currency FROM investments i JOIN investment_plans p ON i.plan_id=p.id JOIN users u ON i.user_id=u.id WHERE i.status='active' AND i.maturity_date<=NOW()`);
      for (const inv of matured.rows) {
        await pool.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [inv.expected_return, inv.user_id]);
        await pool.query("UPDATE investments SET status='matured' WHERE id=$1", [inv.id]);
        const ref = `BPF-INV-${Date.now()}-${inv.id}`;
        await pool.query(`INSERT INTO transactions(user_id,type,amount,currency,status,reference_id,description) VALUES($1,'credit',$2,$3,'completed',$4,$5)`, [inv.user_id, inv.expected_return, inv.preferred_currency || inv.currency, ref, `Investment matured — ${inv.plan_name}`]);
        await pool.query(`INSERT INTO notifications(user_id,type,title,message) VALUES($1,'success','💹 Investment Matured!',$2)`, [inv.user_id, `Your ${inv.plan_name} plan matured! $${inv.expected_return} has been credited to your account.`]);
        await email.sendInvestmentMaturedEmail(inv.email, `${inv.first_name} ${inv.last_name}`, inv.plan_name, inv.expected_return);
        await telegram.notifyInvestmentMatured(inv, inv.expected_return, inv.plan_name);
        console.log(`✅ Investment ${inv.id} matured — $${inv.expected_return} credited to user ${inv.user_id}`);
      }
    } catch (e) { console.error('Cron error:', e.message); }
  });
  console.log('✅ Cron jobs started');
};

module.exports = startCronJobs;
