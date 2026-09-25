const pool = require('../db/pool');
const sms = require('./sms');

const SHIP_TIMEOUT_DAYS = 7;
const DISPUTE_TIMEOUT_DAYS = 14;

function notify(phone, message) {
  sms.sendSMS(phone, message).catch(err => console.error('SMS notify failed:', err));
}

async function getPartyPhones(txId) {
  const result = await pool.query(
    `SELECT b.phone as buyer_phone, s.phone as seller_phone
     FROM transactions t
     JOIN users b ON t.buyer_id = b.id
     JOIN users s ON t.seller_id = s.id
     WHERE t.id = $1`,
    [txId]
  );
  return result.rows[0] || {};
}

async function checkShipTimeouts() {
  const result = await pool.query(
    `UPDATE transactions SET status = 'disputed', updated_at = NOW()
     WHERE status = 'shipped'
     AND updated_at < NOW() - INTERVAL '${SHIP_TIMEOUT_DAYS} days'
     RETURNING id, buyer_id, seller_id, amount`
  );

  for (const tx of result.rows) {
    await pool.query(
      'INSERT INTO escrow_ledger (transaction_id, action) VALUES ($1, $2)',
      [tx.id, 'dispute_opened']
    );
    const phones = await getPartyPhones(tx.id);
    if (phones.buyer_phone) notify(phones.buyer_phone, `SikaLock: No confirmation within ${SHIP_TIMEOUT_DAYS} days. Auto-dispute opened on ${tx.id}. Resolves in 14 days.`);
    if (phones.seller_phone) notify(phones.seller_phone, `SikaLock: Buyer did not confirm delivery. Auto-dispute opened on ${tx.id}. Resolves in 14 days.`);
    console.log(`Auto-dispute: transaction ${tx.id} — buyer did not confirm within ${SHIP_TIMEOUT_DAYS} days`);
  }

  return result.rows.length;
}

async function checkDisputeTimeouts() {
  const result = await pool.query(
    `UPDATE transactions SET status = 'refunded', updated_at = NOW()
     WHERE status = 'disputed'
     AND updated_at < NOW() - INTERVAL '${DISPUTE_TIMEOUT_DAYS} days'
     RETURNING id, buyer_id, seller_id, amount, momo_reference`
  );

  for (const tx of result.rows) {
    await pool.query(
      'INSERT INTO escrow_ledger (transaction_id, action) VALUES ($1, $2)',
      [tx.id, 'funds_refunded']
    );
    const phones = await getPartyPhones(tx.id);
    if (phones.buyer_phone) notify(phones.buyer_phone, `SikaLock: Dispute not resolved in ${DISPUTE_TIMEOUT_DAYS} days. GHS ${tx.amount} refunded to you. ID: ${tx.id}`);
    if (phones.seller_phone) notify(phones.seller_phone, `SikaLock: Dispute on ${tx.id} expired. Funds refunded to buyer.`);
    console.log(`Auto-refund: transaction ${tx.id} — dispute not resolved within ${DISPUTE_TIMEOUT_DAYS} days`);
  }

  return result.rows.length;
}

async function runTimeoutChecks() {
  try {
    const disputes = await checkShipTimeouts();
    const refunds = await checkDisputeTimeouts();
    if (disputes > 0 || refunds > 0) {
      console.log(`Timeout check: ${disputes} auto-disputes, ${refunds} auto-refunds`);
    }
  } catch (err) {
    console.error('Timeout check error:', err);
  }
}

function startTimeoutChecker() {
  setInterval(runTimeoutChecks, 60 * 60 * 1000);
  runTimeoutChecks();
  console.log(`Timeout checker started (ship: ${SHIP_TIMEOUT_DAYS}d, dispute: ${DISPUTE_TIMEOUT_DAYS}d)`);
}

module.exports = { startTimeoutChecker, runTimeoutChecks };
