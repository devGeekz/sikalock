const express = require('express');
const crypto = require('crypto');
const escrow = require('../services/escrow');
const sms = require('../services/sms');
const config = require('../config');
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

function initials(name) {
  return name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

// Shared head: Tailwind CDN + fonts + custom styles
const HEAD = `
<meta charset="utf-8"/>
<meta content="width=device-width, initial-scale=1.0" name="viewport"/>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<script>
tailwind.config = {
  theme: {
    extend: {
      colors: {
        brand: {
          black: '#121214', charcoal: '#1E1E22', cardDark: '#18181B',
          surface: '#F5F6F8', borderLight: '#ECEEF2',
          accentRed: '#F43F5E', accentGreen: '#10B981', muted: '#71717A'
        }
      },
      fontFamily: {
        sans: ['Inter', 'Plus Jakarta Sans', 'system-ui', '-apple-system', 'sans-serif'],
      },
      borderRadius: { '3xl': '1.75rem', '4xl': '2.25rem' },
      boxShadow: {
        'soft': '0 10px 30px -10px rgba(0,0,0,0.04), 0 4px 12px -4px rgba(0,0,0,0.02)',
        'float': '0 20px 40px -15px rgba(0,0,0,0.08)',
        'dark-elevated': '0 20px 35px -10px rgba(0,0,0,0.45)'
      }
    }
  }
}
</script>
<link href="https://fonts.googleapis.com" rel="preconnect"/>
<link crossorigin="" href="https://fonts.gstatic.com" rel="preconnect"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&amp;family=Plus+Jakarta+Sans:wght@500;600;700&amp;display=swap" rel="stylesheet"/>
<style>
  body {
    font-family: 'Inter', sans-serif;
    background-color: #E7E9ED;
    background-image:
      radial-gradient(at 0% 0%, rgba(255,255,255,0.9) 0px, transparent 60%),
      radial-gradient(at 100% 100%, rgba(220,224,230,0.8) 0px, transparent 60%);
    min-height: 100vh;
  }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #D4D4D8; border-radius: 9999px; }
  .circular-chart { transform: rotate(-90deg); }
  .circle-bg { fill: none; stroke: #F0F1F3; stroke-width: 3.2; }
  .circle { fill: none; stroke-width: 3.2; stroke-linecap: round; transition: stroke-dasharray 0.6s ease; }
  .frosted-glass-border { box-shadow: 0 0 0 1px rgba(255,255,255,0.8) inset, 0 12px 36px rgba(0,0,0,0.05); }
  /* Sidebar: hidden on mobile by default */
  #sidebar { display: none; }
  @media (min-width: 1024px) { #sidebar { display: flex; } }
  /* Mobile: open as fixed overlay */
  #sidebar.mobile-open {
    display: flex; position: fixed; top: 0; left: 0; bottom: 0; width: 16rem; z-index: 50;
    border-radius: 0; overflow-y: auto;
  }
  #sb-backdrop { display: none; }
  #sb-backdrop.open { display: block; position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 40; }
  /* Desktop: collapsed icon rail */
  #sidebar .sb-collapsed { display: none; }
  @media (min-width: 1024px) {
    #sidebar.collapsed { width: 4.75rem; }
    #sidebar.collapsed .sb-text, #sidebar.collapsed .sb-section { display: none; }
    #sidebar.collapsed .sb-link { justify-content: center; gap: 0; padding-left: 0; padding-right: 0; }
    #sidebar.collapsed .sb-brand { justify-content: center; }
    #sidebar.collapsed .sb-collapsed { display: flex; }
    #sidebar.collapsed > div:first-child > .sb-brand .sb-text { display: none; }
  }
</style>`;

// Sidebar for authenticated pages
function sidebar(user) {
  const ini = initials(user.name);
  const isAdmin = config.adminPhone && normalizePhone(config.adminPhone) === user.phone;
  return `
<aside id="sidebar" class="w-64 bg-white rounded-3xl p-6 flex-col justify-between shadow-soft border border-black/[0.03]">
  <div class="space-y-8">
    <div class="sb-brand flex items-center gap-3 px-2">
      <div class="w-10 h-10 shrink-0 rounded-2xl bg-zinc-900 flex items-center justify-center text-white shadow-md">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" viewBox="0 0 24 24">
          <rect height="11" rx="3" ry="3" width="18" x="3" y="11"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          <circle cx="12" cy="16" fill="currentColor" r="1.5"></circle>
        </svg>
      </div>
      <div class="sb-text flex flex-col">
        <span class="font-bold text-xl tracking-tight text-zinc-900 leading-none">Sika<span class="text-zinc-500 font-medium">Lock</span></span>
        <span class="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest mt-1">Escrow Protocol</span>
      </div>
      <button onclick="toggleSidebar()" aria-label="Collapse sidebar" class="sb-text ml-auto hidden lg:flex w-7 h-7 rounded-lg items-center justify-center text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 transition-colors">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 17l-5-5 5-5M18 17l-5-5 5-5"></path></svg>
      </button>
      <button onclick="toggleSidebar()" aria-label="Expand sidebar" class="sb-collapsed hidden w-7 h-7 rounded-lg items-center justify-center text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 transition-colors">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M13 17l5-5-5-5M6 17l5-5-5-5"></path></svg>
      </button>
    </div>
    <nav aria-label="Main Navigation" class="space-y-1.5">
      <a class="sb-link flex items-center gap-3.5 px-4 py-3 rounded-2xl bg-zinc-900 text-white font-medium text-sm transition-all shadow-sm" href="/web">
        <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24">
          <rect height="7" rx="1.5" width="7" x="3" y="3"></rect>
          <rect height="7" rx="1.5" width="7" x="14" y="3"></rect>
          <rect height="7" rx="1.5" width="7" x="14" y="14"></rect>
          <rect height="7" rx="1.5" width="7" x="3" y="14"></rect>
        </svg>
        <span class="sb-text">Dashboard</span>
      </a>
      <a class="sb-link flex items-center gap-3.5 px-4 py-3 rounded-2xl text-zinc-600 hover:text-zinc-950 hover:bg-zinc-100 font-medium text-sm transition-all" href="/web#transactions">
        <svg class="w-4 h-4 shrink-0 text-zinc-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M17 3v18M7 21V3M17 7l4 4M7 17l-4-4"></path>
        </svg>
        <span class="sb-text">Transactions</span>
      </a>
      <a class="sb-link flex items-center gap-3.5 px-4 py-3 rounded-2xl text-zinc-600 hover:text-zinc-950 hover:bg-zinc-100 font-medium text-sm transition-all" href="/web#active">
        <svg class="w-4 h-4 shrink-0 text-zinc-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
        </svg>
        <span class="sb-text">Escrows</span>
      </a>
      ${isAdmin ? `
      <a class="sb-link flex items-center justify-between px-4 py-3 rounded-2xl text-zinc-600 hover:text-zinc-950 hover:bg-zinc-100 font-medium text-sm transition-all" href="/web/disputes">
        <div class="flex items-center gap-3.5">
          <svg class="w-4 h-4 shrink-0 text-zinc-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" x2="12" y1="8" y2="12"></line>
            <line x1="12" x2="12.01" y1="16" y2="16"></line>
          </svg>
          <span class="sb-text">Disputes</span>
        </div>
      </a>` : ''}
    </nav>
    <div class="sb-section space-y-2 pt-2">
      <p class="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider px-4">Payment Rails</p>
      <div class="space-y-1">
        <div class="w-full flex items-center justify-between px-4 py-2 text-xs font-medium text-zinc-700 rounded-xl">
          <span class="flex items-center gap-2 text-blue-600 font-medium">Mobile Money (MTN/Vod)</span>
          <span class="text-[10px] text-zinc-400 font-mono">Sandbox</span>
        </div>
        <div class="w-full flex items-center justify-between px-4 py-2 text-xs font-medium text-zinc-700 rounded-xl">
          <span class="flex items-center gap-2 text-zinc-500">Bank Instant Direct</span>
          <span class="text-[10px] text-zinc-400 font-mono">Planned</span>
        </div>
      </div>
    </div>
  </div>
  <div class="pt-6 border-t border-zinc-100 space-y-2">
    <a class="sb-link flex items-center justify-between px-4 py-2.5 text-zinc-500 hover:text-rose-600 font-medium text-sm rounded-xl hover:bg-rose-50/50 transition-colors" href="/web/logout">
      <div class="flex items-center gap-3">
        <svg class="w-4 h-4 shrink-0 text-zinc-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
          <polyline points="16 17 21 12 16 7"></polyline>
          <line x1="21" x2="9" y1="12" y2="12"></line>
        </svg>
        <span class="sb-text">Logout</span>
      </div>
    </a>
  </div>
</aside>`;
}

// Full dashboard layout with sidebar
function layout(title, body, user) {
  const ini = initials(user.name);
  return `<!DOCTYPE html>
<html lang="en">
<head>${HEAD}<title>${esc(title)} | SikaLock</title></head>
<body class="text-zinc-900 antialiased p-3 sm:p-6 lg:p-8 flex items-center justify-center">
<div class="w-full max-w-[1440px] bg-[#EFEFEF]/70 backdrop-blur-2xl p-3 sm:p-5 lg:p-6 rounded-[2.5rem] border border-white/60 shadow-2xl flex flex-col lg:flex-row gap-6">
  <div id="sb-backdrop" onclick="toggleSidebar()"></div>
  ${sidebar(user)}
  <main class="flex-1 flex flex-col gap-6 overflow-hidden">
    <header class="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 pt-1">
      <div class="flex items-center gap-3">
        <button onclick="toggleSidebar()" aria-label="Open menu" class="lg:hidden w-10 h-10 shrink-0 rounded-2xl bg-white border border-black/[0.06] shadow-sm flex items-center justify-center text-zinc-700 active:scale-95 transition-all">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="3" x2="21" y1="6" y2="6"></line><line x1="3" x2="21" y1="12" y2="12"></line><line x1="3" x2="21" y1="18" y2="18"></line></svg>
        </button>
        <div>
          <h1 class="text-3xl font-extrabold tracking-tight text-zinc-950">Hi, ${esc(user.name)}!</h1>
          <p class="text-sm text-zinc-500 font-medium mt-0.5">Here is what is happening with your escrows and reputation today.</p>
        </div>
      </div>
      <div class="flex items-center gap-3 self-stretch md:self-auto justify-end">
        <div class="flex items-center gap-3 pl-1">
          <div class="w-10 h-10 rounded-full bg-zinc-900 border-2 border-white shadow flex items-center justify-center text-white font-semibold text-xs tracking-wider">${esc(ini)}</div>
        </div>
      </div>
    </header>
    ${body}
  </main>
</div>
<script>
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const bd = document.getElementById('sb-backdrop');
  if (window.innerWidth >= 1024) {
    sb.classList.toggle('collapsed');
    localStorage.setItem('sb-collapsed', sb.classList.contains('collapsed'));
  } else {
    sb.classList.toggle('mobile-open');
    bd.classList.toggle('open');
  }
}
if (localStorage.getItem('sb-collapsed') === 'true') document.getElementById('sidebar').classList.add('collapsed');
</script>
</body>
</html>`;
}

// Auth pages (login/verify) — centered card, same aesthetic
function authLayout(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>${HEAD}<title>${esc(title)} | SikaLock</title></head>
<body class="text-zinc-900 antialiased flex items-center justify-center p-4">
<div class="w-full max-w-md">
  <div class="bg-white rounded-[2rem] shadow-float border border-black/[0.03] p-8">
    <div class="flex items-center gap-3 mb-8">
      <div class="w-10 h-10 rounded-2xl bg-zinc-900 flex items-center justify-center text-white shadow-md">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" viewBox="0 0 24 24">
          <rect height="11" rx="3" ry="3" width="18" x="3" y="11"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          <circle cx="12" cy="16" fill="currentColor" r="1.5"></circle>
        </svg>
      </div>
      <div class="flex flex-col">
        <span class="font-bold text-xl tracking-tight text-zinc-900 leading-none">Sika<span class="text-zinc-500 font-medium">Lock</span></span>
        <span class="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest mt-1">Escrow Protocol</span>
      </div>
    </div>
    ${body}
  </div>
</div>
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

function requireAdmin(req, res, next) {
  const admin = normalizePhone(config.adminPhone || '');
  if (!admin || req.userPhone !== admin) return res.status(403).send('Forbidden');
  next();
}

// Login: enter phone
router.get('/login', (req, res) => {
  res.send(authLayout('Login', `
    <h1 class="text-2xl font-extrabold tracking-tight text-zinc-950 mb-1">Welcome back</h1>
    <p class="text-sm text-zinc-500 font-medium mb-6">Enter your phone number. We'll send you a verification code.</p>
    <form method="POST" action="/web/login" class="space-y-4">
      <input name="phone" type="tel" placeholder="e.g. 0501234567" required autofocus
        class="w-full px-4 py-3 rounded-2xl border border-zinc-200 bg-zinc-50 text-sm focus:ring-2 focus:ring-zinc-900 focus:border-transparent outline-none transition-all" />
      <button type="submit" class="w-full bg-zinc-900 hover:bg-zinc-800 text-white font-semibold text-sm py-3 rounded-2xl transition-all active:scale-[0.98]">
        Send Code
      </button>
    </form>
  `));
});

router.post('/login', async (req, res) => {
  const phone = normalizePhone(req.body.phone || '');
  if (phone.length !== 12) {
    return res.send(authLayout('Login', `
      <div class="bg-rose-50 text-rose-600 text-sm font-medium p-3 rounded-2xl mb-4 border border-rose-100">Invalid phone number.</div>
      <form method="POST" action="/web/login" class="space-y-4">
        <input name="phone" type="tel" placeholder="e.g. 0501234567" required autofocus
          class="w-full px-4 py-3 rounded-2xl border border-zinc-200 bg-zinc-50 text-sm focus:ring-2 focus:ring-zinc-900 focus:border-transparent outline-none transition-all" />
        <button type="submit" class="w-full bg-zinc-900 hover:bg-zinc-800 text-white font-semibold text-sm py-3 rounded-2xl transition-all active:scale-[0.98]">Send Code</button>
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
  res.send(authLayout('Verify', `
    <h1 class="text-2xl font-extrabold tracking-tight text-zinc-950 mb-1">Enter code</h1>
    <p class="text-sm text-zinc-500 font-medium mb-6">Code sent to <span class="font-semibold text-zinc-700">${esc(phone)}</span></p>
    <form method="POST" action="/web/verify" class="space-y-4">
      <input type="hidden" name="phone" value="${esc(phone)}">
      <input name="code" type="text" inputmode="numeric" maxlength="6" placeholder="6-digit code" required autofocus
        class="w-full px-4 py-3 rounded-2xl border border-zinc-200 bg-zinc-50 text-sm text-center tracking-[0.5em] font-mono focus:ring-2 focus:ring-zinc-900 focus:border-transparent outline-none transition-all" />
      <button type="submit" class="w-full bg-zinc-900 hover:bg-zinc-800 text-white font-semibold text-sm py-3 rounded-2xl transition-all active:scale-[0.98]">
        Verify &amp; Continue
      </button>
    </form>
  `));
});

router.post('/verify', async (req, res) => {
  const { phone, code } = req.body;
  const otp = otps[phone];
  if (!otp || Date.now() > otp.expires || otp.code !== code) {
    return res.send(authLayout('Verify', `
      <div class="bg-rose-50 text-rose-600 text-sm font-medium p-3 rounded-2xl mb-4 border border-rose-100">Invalid or expired code.</div>
      <form method="POST" action="/web/verify" class="space-y-4">
        <input type="hidden" name="phone" value="${esc(phone)}">
        <input name="code" type="text" inputmode="numeric" maxlength="6" placeholder="6-digit code" required autofocus
          class="w-full px-4 py-3 rounded-2xl border border-zinc-200 bg-zinc-50 text-sm text-center tracking-[0.5em] font-mono focus:ring-2 focus:ring-zinc-900 focus:border-transparent outline-none transition-all" />
        <button type="submit" class="w-full bg-zinc-900 hover:bg-zinc-800 text-white font-semibold text-sm py-3 rounded-2xl transition-all active:scale-[0.98]">Verify &amp; Continue</button>
      </form>
    `));
  }

  delete otps[phone];
  const sid = crypto.randomUUID();
  sessions[sid] = { phone, createdAt: Date.now() };
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; Max-Age=86400`);

  const existing = await escrow.findUserByPhone(phone);
  if (!existing) return res.redirect('/web/setup');
  res.redirect('/web');
});

// First-login name prompt
router.get('/setup', requireAuth, async (req, res) => {
  const user = await escrow.findUserByPhone(req.userPhone);
  if (user && user.name !== user.phone) return res.redirect('/web');
  res.send(authLayout('Your Name', `
    <p class="text-sm text-zinc-500 mb-4">What should we call you?</p>
    <form method="POST" action="/web/setup" class="space-y-4">
      <input name="name" type="text" placeholder="Your name" required autofocus
        class="w-full px-4 py-3 rounded-2xl border border-zinc-200 bg-zinc-50 text-sm focus:ring-2 focus:ring-zinc-900 focus:border-transparent outline-none transition-all" />
      <button type="submit" class="w-full bg-zinc-900 hover:bg-zinc-800 text-white font-semibold text-sm py-3 rounded-2xl transition-all active:scale-[0.98]">Continue</button>
    </form>
  `));
});

router.post('/setup', requireAuth, async (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 60);
  if (!name) return res.redirect('/web/setup');
  await escrow.getOrCreateUser(req.userPhone, name);
  res.redirect('/web');
});

router.get('/logout', (req, res) => {
  const sid = getCookie(req, 'sid');
  if (sid) delete sessions[sid];
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/web/login');
});

// Status pill helper
function statusPill(status) {
  const isRed = ['disputed', 'refunded'].includes(status);
  const cls = isRed ? 'text-rose-600' : 'text-blue-600';
  return `<span class="text-[11px] font-semibold ${cls}">${esc(status)}</span>`;
}

// Dashboard
router.get('/', requireAuth, async (req, res) => {
  try {
    let user = await escrow.findUserByPhone(req.userPhone);
    if (!user) user = await escrow.getOrCreateUser(req.userPhone, req.userPhone);

    const [transactions, rep] = await Promise.all([
      escrow.getUserTransactions(user.id),
      escrow.getUserReputation(user.id),
    ]);

    const active = transactions.filter(t => ['pending', 'locked', 'shipped', 'disputed'].includes(t.status));
    const safeRate = transactions.length > 0
      ? Math.round((transactions.filter(t => t.status === 'released').length / transactions.length) * 100)
      : 100;

    // Active escrow cards
    const activeCards = active.slice(0, 2).map(tx => {
      const isDisputed = tx.status === 'disputed';
      const counterparty = tx.buyer_phone === req.userPhone ? tx.seller_name : tx.buyer_name;
      const icon = isDisputed
        ? `<div class="w-10 h-10 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center"><svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" x2="12" y1="9" y2="13"></line><line x1="12" x2="12.01" y1="17" y2="17"></line></svg></div>`
        : `<div class="w-10 h-10 rounded-2xl bg-zinc-100 text-zinc-800 flex items-center justify-center"><svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg></div>`;
      const label = isDisputed ? 'Disputed' : tx.status === 'shipped' ? 'In Transit' : tx.status === 'locked' ? 'Funds Locked' : 'Pending Payment';
      const desc = isDisputed
        ? 'Dispute opened. Awaiting resolution.'
        : tx.status === 'shipped'
          ? 'Awaiting your confirmation to release payment.'
          : tx.status === 'locked'
            ? 'Funds secured. Waiting for seller to ship.'
            : 'Payment request pending.';
      return `
      <div class="bg-white rounded-3xl p-5 shadow-soft border border-black/[0.03] flex flex-col justify-between hover:shadow-float transition-all relative">
        <div class="flex items-start justify-between">
          ${icon}
          ${statusPill(tx.status)}
        </div>
        <div class="my-4 space-y-1">
          <div class="text-[11px] font-mono text-zinc-400">ID: ${esc(tx.id.slice(0, 8))}...</div>
          <h3 class="text-base font-bold text-zinc-900 leading-snug">Escrow with ${esc(counterparty)}</h3>
          <p class="text-xs text-zinc-500">${desc}</p>
        </div>
        <div class="pt-3 border-t border-zinc-100 flex items-center justify-between">
          <div>
            <span class="text-[10px] text-zinc-400 uppercase font-semibold">${tx.status === 'released' ? 'Released' : 'Locked Amount'}</span>
            <p class="text-sm font-extrabold text-zinc-900">GHS ${Number(tx.amount).toFixed(2)}</p>
          </div>
          <a href="/web/tx/${tx.id}" class="w-9 h-9 rounded-full ${isDisputed ? 'bg-zinc-900 text-white hover:bg-zinc-800' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'} flex items-center justify-center transition-all active:scale-95 shadow-sm" title="View Details">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
          </a>
        </div>
      </div>`;
    }).join('');

    // Transaction table rows
    const rows = transactions.map(tx => {
      const isYou = tx.buyer_phone === req.userPhone;
      const counterparty = isYou ? tx.seller_name : tx.buyer_name;
      const cpIni = initials(counterparty);
      return `
      <tr class="hover:bg-zinc-50/70 transition-colors group">
        <td class="py-3.5 px-3">
          <a class="inline-flex items-center gap-1.5 font-mono text-zinc-900 hover:text-blue-600 font-semibold underline decoration-zinc-300 underline-offset-2" href="/web/tx/${tx.id}">
            <span>${esc(tx.id.slice(0, 8))}...</span>
          </a>
        </td>
        <td class="py-3.5 px-3">
          <div class="flex items-center gap-2">
            <span class="w-6 h-6 rounded-full ${isYou ? 'bg-zinc-900 text-white' : 'bg-zinc-200 text-zinc-700'} flex items-center justify-center text-[10px] font-bold">${esc(initials(tx.buyer_name))}</span>
            <span class="font-semibold text-zinc-900">${esc(tx.buyer_name)}</span>
            ${isYou ? '<span class="text-[10px] text-zinc-400 font-normal">(You)</span>' : ''}
          </div>
        </td>
        <td class="py-3.5 px-3">
          <div class="flex items-center gap-2">
            <span class="w-6 h-6 rounded-full ${!isYou ? 'bg-zinc-900 text-white' : 'bg-zinc-200 text-zinc-700'} flex items-center justify-center text-[10px] font-bold">${esc(initials(tx.seller_name))}</span>
            <span class="font-semibold text-zinc-800">${esc(tx.seller_name)}</span>
            ${!isYou ? '<span class="text-[10px] text-zinc-400 font-normal">(You)</span>' : ''}
          </div>
        </td>
        <td class="py-3.5 px-3"><span class="font-bold text-zinc-950 text-sm">GHS ${Number(tx.amount).toFixed(2)}</span></td>
        <td class="py-3.5 px-3">${statusPill(tx.status)}</td>
        <td class="py-3.5 px-3 text-zinc-500 font-mono text-[11px]">${new Date(tx.created_at).toLocaleDateString()}</td>
        <td class="py-3.5 px-3 text-right">
          <a href="/web/tx/${tx.id}" class="px-2.5 py-1 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 text-[11px] font-semibold transition-colors inline-block">View</a>
        </td>
      </tr>`;
    }).join('');

    const emptyState = `
      <div class="text-center py-8">
        <p class="text-sm text-zinc-400 font-medium">No transactions yet. Dial the USSD code to get started.</p>
      </div>`;

    res.send(layout('Dashboard', `
      <!-- Metrics Grid -->
      <section class="grid grid-cols-1 md:grid-cols-12 gap-5">
        <!-- Reputation Dark Card -->
        <article class="md:col-span-12 lg:col-span-5 bg-zinc-900 text-white rounded-3xl p-6 shadow-dark-elevated flex flex-col justify-between relative overflow-hidden">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold tracking-wider uppercase text-zinc-400">Reputation &amp; Summary</span>
          </div>
          <div class="grid grid-cols-2 gap-4 my-6">
            <div class="border-l border-zinc-700/60 pl-3">
              <div class="flex items-baseline gap-2">
                <span class="text-4xl font-extrabold tracking-tight text-white">${rep.total_bought}</span>
                <span class="text-xs text-emerald-400 font-medium">${rep.total_bought > 0 ? 'Active buyer' : 'New'}</span>
              </div>
              <span class="text-xs text-zinc-400 font-normal">Escrow Bought</span>
            </div>
            <div class="border-l border-zinc-700/60 pl-3">
              <div class="flex items-baseline gap-2">
                <span class="text-4xl font-extrabold tracking-tight text-white">${rep.total_sold}</span>
                <span class="text-xs text-zinc-500 font-medium">${rep.total_sold > 0 ? 'Verified seller' : 'New'}</span>
              </div>
              <span class="text-xs text-zinc-400 font-normal">Escrow Sold</span>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3 pt-2">
            <div class="bg-zinc-800/90 border border-zinc-700/50 rounded-2xl p-3.5">
              <div class="text-zinc-400 mb-1">
                <span class="text-[11px] font-medium tracking-wide">Disputes by you</span>
              </div>
              <div class="flex items-baseline gap-1.5">
                <span class="text-2xl font-bold text-white">${rep.disputes_made}</span>
                <span class="text-[11px] ${rep.disputes_made > 0 ? 'text-rose-400' : 'text-zinc-400'} font-normal">${rep.disputes_made > 0 ? 'in review' : 'clean'}</span>
              </div>
            </div>
            <div class="bg-zinc-800/90 border border-zinc-700/50 rounded-2xl p-3.5">
              <div class="text-zinc-400 mb-1">
                <span class="text-[11px] font-medium tracking-wide">Against you</span>
              </div>
              <div class="flex items-baseline gap-1.5">
                <span class="text-2xl font-bold text-white">${rep.disputes_against}</span>
                <span class="text-[11px] ${rep.disputes_against > 0 ? 'text-rose-400' : 'text-blue-400'} font-normal">${rep.disputes_against > 0 ? 'flagged' : 'clean record'}</span>
              </div>
            </div>
          </div>
        </article>

        <!-- Security Health Card -->
        <article class="md:col-span-6 lg:col-span-4 bg-white rounded-3xl p-6 shadow-soft border border-black/[0.03] flex flex-col justify-between">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-base font-bold text-zinc-900">Security Health</h2>
              <span class="text-xs text-zinc-400 font-medium">${safeRate}% safe checkout</span>
            </div>
          </div>
          <div class="flex items-center justify-center py-4 relative">
            <svg class="w-32 h-32 circular-chart" viewBox="0 0 36 36">
              <path class="circle-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"></path>
              <path class="circle" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" stroke="#18181B" stroke-dasharray="${safeRate}, 100"></path>
              <path class="circle-bg" d="M18 6.5 a 11.5 11.5 0 0 1 0 23 a 11.5 11.5 0 0 1 0 -23" stroke-width="2"></path>
              <path class="circle" d="M18 6.5 a 11.5 11.5 0 0 1 0 23 a 11.5 11.5 0 0 1 0 -23" stroke="#A1A1AA" stroke-dasharray="${Math.min(rep.total_bought + rep.total_sold, 100)}, 100" stroke-width="2"></path>
            </svg>
            <div class="absolute inset-0 flex flex-col items-center justify-center text-center">
              <span class="text-lg font-black text-zinc-900 tracking-tight leading-none">${safeRate}%</span>
              <span class="text-[9px] text-zinc-400 uppercase tracking-wider mt-1">Escrow Score</span>
            </div>
          </div>
        </article>

        <!-- Quick Stats -->
        <article class="md:col-span-6 lg:col-span-3 bg-white rounded-3xl p-6 shadow-soft border border-black/[0.03] flex flex-col justify-between">
          <div>
            <h2 class="text-base font-bold text-zinc-900">Activity</h2>
            <span class="text-xs text-zinc-400 font-medium">All-time summary</span>
          </div>
          <div class="space-y-4 py-4">
            <div class="flex items-center justify-between">
              <span class="text-sm text-zinc-500">Total Transactions</span>
              <span class="text-lg font-extrabold text-zinc-900">${transactions.length}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-sm text-zinc-500">Active Escrows</span>
              <span class="text-lg font-extrabold text-zinc-900">${active.length}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-sm text-zinc-500">Completed</span>
              <span class="text-lg font-extrabold text-emerald-600">${transactions.filter(t => t.status === 'released').length}</span>
            </div>
          </div>
        </article>
      </section>

      <!-- Active Escrows -->
      <section id="active" class="space-y-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <h2 class="text-lg font-bold text-zinc-900">Active Escrow In Process</h2>
            <span class="text-xs text-zinc-500 font-semibold">${active.length}</span>
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-5">
          ${activeCards || `
          <div class="col-span-full rounded-3xl border-2 border-dashed border-zinc-300 bg-white/40 p-8 flex flex-col items-center justify-center gap-3 text-zinc-500 min-h-[150px]">
            <p class="text-sm font-semibold text-zinc-600">No active escrows</p>
            <p class="text-xs text-zinc-400">Dial the USSD code to create your first transaction.</p>
          </div>`}
          <!-- Add New (dotted placeholder) -->
          <button onclick="alert('Create escrows via USSD dial code')" class="rounded-3xl border-2 border-dashed border-zinc-300 hover:border-zinc-500 bg-white/40 hover:bg-white/70 transition-all p-6 flex flex-col items-center justify-center gap-3 text-zinc-500 hover:text-zinc-900 group min-h-[190px]">
            <div class="w-12 h-12 rounded-full bg-white shadow-soft flex items-center justify-center text-zinc-700 group-hover:scale-110 transition-transform">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><line x1="12" x2="12" y1="5" y2="19"></line><line x1="5" x2="19" y1="12" y2="12"></line></svg>
            </div>
            <div class="text-center">
              <span class="text-sm font-bold block text-zinc-800">New Escrow Contract</span>
              <span class="text-xs text-zinc-400 font-normal">Create via USSD dial code</span>
            </div>
          </button>
        </div>
      </section>

      <!-- Transactions Table -->
      <section id="transactions" class="bg-white rounded-3xl p-6 shadow-soft border border-black/[0.03] space-y-4">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-zinc-100">
          <div>
            <h2 class="text-lg font-bold text-zinc-900 tracking-tight">Transactions &amp; Settlement Ledger</h2>
            <p class="text-xs text-zinc-400">Complete audit trail of all peer-to-peer escrow payments</p>
          </div>
        </div>
        <div class="overflow-x-auto">
          ${transactions.length === 0 ? emptyState : `
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-zinc-100 text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                <th class="py-3 px-3" scope="col">Escrow ID</th>
                <th class="py-3 px-3" scope="col">Buyer</th>
                <th class="py-3 px-3" scope="col">Seller</th>
                <th class="py-3 px-3" scope="col">Amount</th>
                <th class="py-3 px-3" scope="col">Status</th>
                <th class="py-3 px-3" scope="col">Date</th>
                <th class="py-3 px-3 text-right" scope="col">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-zinc-50 text-xs font-medium">${rows}</tbody>
          </table>`}
        </div>
        ${transactions.length > 0 ? `
        <div class="flex items-center justify-between pt-3 text-xs text-zinc-500">
          <span>Showing ${transactions.length} transaction${transactions.length !== 1 ? 's' : ''}</span>
        </div>` : ''}
      </section>
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
      <li class="flex items-start gap-3">
        <div class="flex-1 pb-4">
          <div class="flex items-center justify-between">
            <span class="text-sm font-semibold text-zinc-900 capitalize">${esc(entry.action.replace(/_/g, ' '))}</span>
            <span class="text-[11px] text-zinc-400 font-mono">${new Date(entry.timestamp).toLocaleString()}</span>
          </div>
          ${entry.detail ? `<p class="text-xs text-zinc-500 mt-0.5">${esc(entry.detail)}</p>` : ''}
        </div>
      </li>
    `).join('');

    const isBuyer = tx.buyer_phone === req.userPhone;
    const counterparty = isBuyer ? tx.seller_name : tx.buyer_name;
    const role = isBuyer ? 'Buyer' : 'Seller';

    res.send(layout('Transaction', `
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <!-- Transaction Info -->
        <article class="lg:col-span-2 bg-white rounded-3xl p-6 shadow-soft border border-black/[0.03]">
          <div class="flex items-start justify-between mb-6">
            <div>
              <div class="text-[11px] font-mono text-zinc-400 mb-1">ID: ${esc(tx.id)}</div>
              <h2 class="text-xl font-extrabold text-zinc-950 tracking-tight">Escrow with ${esc(counterparty)}</h2>
              <p class="text-xs text-zinc-500 mt-0.5">You are the <span class="font-semibold text-zinc-700">${role}</span></p>
            </div>
            ${statusPill(tx.status)}
          </div>

          <div class="grid grid-cols-2 gap-4 mb-6">
            <div class="bg-zinc-50 rounded-2xl p-4">
              <span class="text-[10px] text-zinc-400 uppercase font-semibold">Amount</span>
              <p class="text-2xl font-extrabold text-zinc-900">GHS ${Number(tx.amount).toFixed(2)}</p>
            </div>
            <div class="bg-zinc-50 rounded-2xl p-4">
              <span class="text-[10px] text-zinc-400 uppercase font-semibold">Created</span>
              <p class="text-sm font-semibold text-zinc-700 mt-1">${new Date(tx.created_at).toLocaleString()}</p>
            </div>
          </div>

          <div class="space-y-3">
            <div class="flex items-center justify-between py-2 border-b border-zinc-50">
              <span class="text-xs text-zinc-400 font-medium">Buyer</span>
              <div class="flex items-center gap-2">
                <span class="w-6 h-6 rounded-full bg-zinc-900 text-white flex items-center justify-center text-[10px] font-bold">${esc(initials(tx.buyer_name))}</span>
                <span class="text-sm font-semibold text-zinc-900">${esc(tx.buyer_name)}</span>
                <span class="text-[11px] text-zinc-400 font-mono">${esc(tx.buyer_phone)}</span>
              </div>
            </div>
            <div class="flex items-center justify-between py-2 border-b border-zinc-50">
              <span class="text-xs text-zinc-400 font-medium">Seller</span>
              <div class="flex items-center gap-2">
                <span class="w-6 h-6 rounded-full bg-zinc-200 text-zinc-700 flex items-center justify-center text-[10px] font-bold">${esc(initials(tx.seller_name))}</span>
                <span class="text-sm font-semibold text-zinc-900">${esc(tx.seller_name)}</span>
                <span class="text-[11px] text-zinc-400 font-mono">${esc(tx.seller_phone)}</span>
              </div>
            </div>
            ${tx.momo_reference ? `
            <div class="flex items-center justify-between py-2">
              <span class="text-xs text-zinc-400 font-medium">MoMo Reference</span>
              <span class="text-[11px] text-zinc-600 font-mono">${esc(tx.momo_reference)}</span>
            </div>` : ''}
          </div>
        </article>

        <!-- Timeline -->
        <article class="bg-white rounded-3xl p-6 shadow-soft border border-black/[0.03]">
          <h3 class="text-base font-bold text-zinc-900 mb-4">Timeline</h3>
          <ul class="relative">
            ${timeline || '<li class="text-xs text-zinc-400">No entries yet.</li>'}
          </ul>
        </article>
      </div>
    `, user));
  } catch (err) {
    console.error('Tx detail error:', err);
    res.status(500).send('Server error');
  }
});

// Disputes list
router.get('/disputes', requireAuth, requireAdmin, async (req, res) => {
  try {
    const user = await escrow.getOrCreateUser(req.userPhone, req.userPhone);
    const disputes = await escrow.getDisputedTransactions();

    const cards = await Promise.all(disputes.map(async tx => {
      const entries = await escrow.getLedgerEntries(tx.id);
      const disputeEntry = entries.find(e => e.action === 'dispute_opened');
      const reason = disputeEntry ? disputeEntry.detail : 'No reason given';
      const age = Math.floor((Date.now() - new Date(tx.updated_at).getTime()) / (1000 * 60 * 60 * 24));
      return `
      <div class="bg-white rounded-3xl p-5 shadow-soft border border-black/[0.03]">
        <div class="flex items-start justify-between mb-3">
          <div class="w-10 h-10 rounded-2xl bg-rose-50 text-rose-600 flex items-center justify-center">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
              <line x1="12" x2="12" y1="9" y2="13"></line>
              <line x1="12" x2="12.01" y1="17" y2="17"></line>
            </svg>
          </div>
          <span class="text-[11px] font-semibold text-rose-600">${age}d old</span>
        </div>
        <div class="text-[11px] font-mono text-zinc-400 mb-1">ID: ${esc(tx.id.slice(0, 8))}...</div>
        <h3 class="text-base font-bold text-zinc-900">${esc(tx.buyer_name)} vs ${esc(tx.seller_name)}</h3>
        <p class="text-xs text-zinc-500 mt-1">Reason: <span class="font-semibold text-zinc-700">${esc(reason)}</span></p>
        <div class="flex items-center justify-between mt-3 pt-3 border-t border-zinc-100">
          <div>
            <span class="text-[10px] text-zinc-400 uppercase font-semibold">Amount</span>
            <p class="text-sm font-extrabold text-zinc-900">GHS ${Number(tx.amount).toFixed(2)}</p>
          </div>
          <div class="flex gap-2">
            <form method="POST" action="/web/disputes/${tx.id}/resolve" class="inline">
              <input type="hidden" name="action" value="refund">
              <button type="submit" class="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-[11px] font-semibold transition-colors">Refund Buyer</button>
            </form>
            <form method="POST" action="/web/disputes/${tx.id}/resolve" class="inline">
              <input type="hidden" name="action" value="release">
              <button type="submit" class="px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white text-[11px] font-semibold transition-colors">Release to Seller</button>
            </form>
          </div>
        </div>
        <a href="/web/tx/${tx.id}" class="block mt-2 text-[11px] text-zinc-400 hover:text-zinc-700 font-medium">View full timeline &rarr;</a>
      </div>`;
    }));

    const cardsHtml = cards.join('');

    res.send(layout('Disputes', `
      <section class="space-y-4">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <h2 class="text-lg font-bold text-zinc-900">Dispute Resolution</h2>
            <span class="text-xs text-rose-600 font-semibold">${disputes.length}</span>
          </div>
        </div>
        ${disputes.length === 0 ? `
        <div class="bg-white rounded-3xl p-8 shadow-soft border border-black/[0.03] text-center">
          <p class="text-sm text-zinc-400 font-medium">No open disputes. All clear.</p>
        </div>` : `
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">${cardsHtml}</div>
        `}
      </section>
    `, user));
  } catch (err) {
    console.error('Disputes error:', err);
    res.status(500).send('Server error');
  }
});

// Resolve dispute
router.post('/disputes/:id/resolve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { action } = req.body;
    const tx = await escrow.getTransaction(req.params.id);
    if (!tx) return res.status(404).send('Not found');
    if (tx.status !== 'disputed') return res.status(400).send('Not a disputed transaction');

    if (action === 'release') {
      await escrow.updateTransactionStatus(tx.id, 'released', null);
      await escrow.addLedgerEntry(tx.id, 'funds_released', 'Dispute resolved: released to seller');
      console.log(`Dispute resolved: ${tx.id} released to seller`);
      sms.sendSMS(tx.seller_phone, `SikaLock: Dispute resolved in your favor. GHS ${tx.amount} released to you. ID: ${tx.id}`).catch(() => {});
      sms.sendSMS(tx.buyer_phone, `SikaLock: Dispute on ${tx.id} resolved. Funds released to seller.`).catch(() => {});
    } else if (action === 'refund') {
      await escrow.updateTransactionStatus(tx.id, 'refunded', null);
      await escrow.addLedgerEntry(tx.id, 'funds_refunded', 'Dispute resolved: refunded to buyer');
      console.log(`Dispute resolved: ${tx.id} refunded to buyer`);
      sms.sendSMS(tx.buyer_phone, `SikaLock: Dispute resolved in your favor. GHS ${tx.amount} refunded to you. ID: ${tx.id}`).catch(() => {});
      sms.sendSMS(tx.seller_phone, `SikaLock: Dispute on ${tx.id} resolved. Funds refunded to buyer.`).catch(() => {});
    } else {
      return res.status(400).send('Invalid action');
    }

    res.redirect('/web/disputes');
  } catch (err) {
    console.error('Resolve error:', err);
    res.status(500).send('Server error');
  }
});

module.exports = router;
