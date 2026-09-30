const config = require('../config');

async function sendSMS(to, message) {
  if (!config.at.apiKey || config.at.apiKey.includes('your_')) {
    // ponytail: dev mode logs OTP to console instead of sending SMS
    console.log(`[SMS dev mode] To: ${to} | ${message}`);
    return true;
  }
  const host = config.at.username === 'sandbox'
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging';
  try {
    const res = await fetch(host, {
      method: 'POST',
      headers: {
        apiKey: config.at.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        username: config.at.username,
        to: `+${to}`,
        message,
      }),
    });
    const body = await res.text();
    if (!res.ok) console.error(`SMS API ${res.status}: ${body}`);
    return res.ok;
  } catch (err) {
    console.error('SMS error:', err);
    return false;
  }
}

module.exports = { sendSMS };
