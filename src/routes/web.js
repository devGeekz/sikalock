const express = require('express');
const crypto = require('crypto');
const escrow = require('../services/escrow');
const sms = require('../services/sms');
const { normalizePhone } = require('./ussd');

const router = express.Router();

// ponytail: in-memory stores like USSD sessions, lost on restart. Swap for Redis when multi-instance.
const otps = {}; // phone -> { code, expires }
const sessions = {}; // sid -> phone

const OTP_TTL = 5 * 60 * 1000;
const SESSION_TTL = 24 * 60 * 60 * 1000;

function esc(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function layout(title, body, user) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} | SikaLock</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #333; }
    nav { background: #1a1a2e; color: #fff; padding: 1rem; display: flex; justify-content: space-between; align-items: center; }
    nav a { color: #fff; text-decoration: none; margin-left: 1rem; }
    main { max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
    .card { background: #fff; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    h1 { font-size: 1.5rem; margin-bottom: 1rem; }
    h2 { font-size: 1.1rem; margin-bottom: 0.5rem; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 0.75rem; border-bottom: 1px solid #eee; }
    th { font-weight: 600; color: #666; }
    .status { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 12px; font-size: 0.8rem; font-weight: 600; }
    .status-pending { background: #fff3cd; color: #856404; }
    .status-locked { background: #cce5ff; color: #004085; }
    .status-shipped { background: #d4edda; color: #155724; }
    .status-released { background: #e2e3e5; color: #383d41; }
    .status-disputed { background: #f8d7da; color: #721c24; }
    form { display: flex; flex-direction: column; gap: 1rem; max-width: 400px; }
    input { padding: 0.75rem; border: 1px solid #ccc; border-radius: 6px; font-size: 1rem; }
    button { padding: 0.75rem; background: #1a1a2e; color: #fff; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer; }
    button:hover { background: #16213e; }
    .error { background: #f8d7da; color: #721c24; padding: 0.75rem; border-radius: 6px; margin-bottom: 1rem; }
    .muted { color: #666; font-size: 0.9rem; }
    .stats { display: flex; gap: 1rem; flex-wrap: wrap; }
    .stat { flex: 1; min-width: 120px; text-align: center; padding: 1rem; background: #f8f9fa; border-radius: 6px; }
    .stat .num { font-size: 1.5rem; font-weight: 700; }
    .timeline { list-style: none; }
    .timeline li { padding: 0.5rem 0 0.5rem 1.5rem; border-left: 2px solid #1a1a2e; position: relative; }
    .timeline li::before { content: ''; width: 8px; height: 8px; background: #1a1a2e; border-radius: 50%; position: absolute; left: -5px; top: 0.8rem; }
  </style>
</head>
<body>
  <nav>
    <strong>SikaLock</strong>
    <span>${user ? `${esc(user.name)} <a href="/web">Dashboard</a> <a href="/web/logout">Logout</a>` : '<a href="/web/login">Login</a>'}</span>
  </nav>
  <main>${body}</main>
</body>
</html>`;
}

function getCookie(req, name) {
  const m = req.headers.cookie && req.headers.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : null;
}

function getSessionPhone(req) {
  const sid = getCookie(req, 'sid');
  if (!sid || !sessions[sid]) return null;
  const entry = sessions[sid];
  if (Date.now() - entry.createdAt > SESSION_TTL) {
    delete sessions[sid];
    return null;
  }
  return entry.phone;
}

function requireAuth(req, res, next) {
  const phone = getSessionPhone(req);
  if (!phone) return res.redirect('/web/login');
  req.userPhone = phone;
  next();
}

// Login: enter phone
router.get('/login', (req, res) => {
  res.send(layout('Login', `
    <div class="card">
      <h1>Login</h1>
      <p class="muted">Enter your phone number. We'll send you a verification code.</p>
      <form method="POST" action="/web/login">
        <input name="phone" type="tel" placeholder="e.g. 0501234567" required autofocus>
        <button type="submit">Send Code</button>
      </form>
    </div>
  `));
});

router.post('/login', async (req, res) => {
  const phone = normalizePhone(req.body.phone || '');
  if (phone.length !== 12) {
    return res.send(layout('Login', `
      <div class="error">Invalid phone number.</div>
      <form method="POST" action="/web/login">
        <input name="phone" type="tel" placeholder="e.g. 0501234567" required autofocus>
        <button type="submit">Send Code</button>
      </form>
    `));
  }

  const code = crypto.randomInt(100000, 999999).toString();
  otps[phone] = { code, expires: Date.now() + OTP_TTL };
  await sms.sendSMS(phone, `Your SikaLock code is: ${code}. Valid for 5 minutes.`);

  res.redirect('/web/verify?phone=' + encodeURIComponent(phone));
});

// Verify OTP
router.get('/verify', (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.redirect('/web/login');
  res.send(layout('Verify', `
    <div class="card">
      <h1>Enter Code</h1>
      <p class="muted">Code sent to ${esc(phone)}</p>
      <form method="POST" action="/web/verify">
        <input type="hidden" name="phone" value="${esc(phone)}">
        <input name="code" type="text" inputmode="numeric" maxlength="6" placeholder="6-digit code" required autofocus>
        <button type="submit">Verify</button>
      </form>
    </div>
  `));
});

router.post('/verify', async (req, res) => {
  const { phone, code } = req.body;
  const otp = otps[phone];
  if (!otp || Date.now() > otp.expires || otp.code !== code) {
    return res.send(layout('Verify', `
      <div class="error">Invalid or expired code.</div>
      <form method="POST" action="/web/verify">
        <input type="hidden" name="phone" value="${esc(phone)}">
        <input name="code" type="text" inputmode="numeric" maxlength="6" placeholder="6-digit code" required autofocus>
        <button type="submit">Verify</button>
      </form>
    `));
  }

  delete otps[phone];
  const sid = crypto.randomUUID();
  sessions[sid] = { phone, createdAt: Date.now() };
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; Max-Age=86400`);
  res.redirect('/web');
});

router.get('/logout', (req, res) => {
  const sid = getCookie(req, 'sid');
  if (sid) delete sessions[sid];
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/web/login');
});

// Dashboard
router.get('/', requireAuth, async (req, res) => {
  try {
    // Auto-create user on first web login (ponytail: name defaults to phone, update via USSD register)
    let user = await escrow.findUserByPhone(req.userPhone);
    if (!user) user = await escrow.getOrCreateUser(req.userPhone, req.userPhone);

    const [transactions, rep] = await Promise.all([
      escrow.getUserTransactions(user.id),
      escrow.getUserReputation(user.id),
    ]);

    const rows = transactions.map(tx => `
      <tr>
        <td><a href="/web/tx/${tx.id}">${tx.id.slice(0, 8)}...</a></td>
        <td>${esc(tx.buyer_name)}</td>
        <td>${esc(tx.seller_name)}</td>
        <td>GHS ${tx.amount}</td>
        <td><span class="status status-${tx.status}">${tx.status}</span></td>
        <td>${new Date(tx.created_at).toLocaleDateString()}</td>
      </tr>
    `).join('');

    res.send(layout('Dashboard', `
      <h1>Welcome, ${esc(user.name)}</h1>
      <div class="card">
        <h2>Reputation</h2>
        <div class="stats">
          <div class="stat"><div class="num">${rep.total_bought}</div><div>Bought</div></div>
          <div class="stat"><div class="num">${rep.total_sold}</div><div>Sold</div></div>
          <div class="stat"><div class="num">${rep.disputes_made}</div><div>Disputes by you</div></div>
          <div class="stat"><div class="num">${rep.disputes_against}</div><div>Disputes against you</div></div>
        </div>
      </div>
      <div class="card">
        <h2>Transactions</h2>
        ${transactions.length === 0
          ? '<p class="muted">No transactions yet. Dial the USSD code to get started.</p>'
          : `<table>
              <tr><th>ID</th><th>Buyer</th><th>Seller</th><th>Amount</th><th>Status</th><th>Date</th></tr>
              ${rows}
            </table>`}
      </div>
    `, user));
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Server error');
  }
});

// Transaction detail
router.get('/tx/:id', requireAuth, async (req, res) => {
  try {
    const user = await escrow.getOrCreateUser(req.userPhone, req.userPhone);
    const tx = await escrow.getTransaction(req.params.id);
    if (!tx) return res.status(404).send('Not found');
    if (tx.buyer_phone !== req.userPhone && tx.seller_phone !== req.userPhone) {
      return res.status(403).send('Forbidden');
    }

    const ledger = await escrow.getLedgerEntries(tx.id);
    const timeline = ledger.map(entry => `
      <li><strong>${esc(entry.action)}</strong>${entry.detail ? ` — ${esc(entry.detail)}` : ''}<br>
      <span class="muted">${new Date(entry.timestamp).toLocaleString()}</span></li>
    `).join('');

    res.send(layout('Transaction', `
      <h1>Transaction</h1>
      <div class="card">
        <table>
          <tr><th>ID</th><td>${esc(tx.id)}</td></tr>
          <tr><th>Amount</th><td>GHS ${tx.amount}</td></tr>
          <tr><th>Status</th><td><span class="status status-${tx.status}">${tx.status}</span></td></tr>
          <tr><th>Buyer</th><td>${esc(tx.buyer_name)} (${esc(tx.buyer_phone)})</td></tr>
          <tr><th>Seller</th><td>${esc(tx.seller_name)} (${esc(tx.seller_phone)})</td></tr>
          <tr><th>Created</th><td>${new Date(tx.created_at).toLocaleString()}</td></tr>
        </table>
      </div>
      <div class="card">
        <h2>Timeline</h2>
        <ul class="timeline">${timeline || '<li class="muted">No entries</li>'}</ul>
      </div>
    `, user));
  } catch (err) {
    console.error('Tx detail error:', err);
    res.status(500).send('Server error');
  }
});

module.exports = router;
