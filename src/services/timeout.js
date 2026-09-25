const pool = require('../db/pool');

const SHIP_TIMEOUT_DAYS = 7;
const DISPUTE_TIMEOUT_DAYS = 14;

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
    console.log(`Auto-dispute: transaction ${tx.id} — buyer did not confirm within ${SHIP_TIMEOUT_DAYS} days`);
  }

  return result.rows.length;
}

async function checkDisputeTimeouts() {
  const result = await pool.query(
    `UPDATE transactions SET status = 'released', updated_at = NOW()
     WHERE status = 'disputed'
     AND updated_at < NOW() - INTERVAL '${DISPUTE_TIMEOUT_DAYS} days'
     RETURNING id, buyer_id, seller_id, amount, momo_reference`
  );

  for (const tx of result.rows) {
    await pool.query(
      'INSERT INTO escrow_ledger (transaction_id, action) VALUES ($1, $2)',
      [tx.id, 'funds_released']
    );
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
  // Run every hour
  setInterval(runTimeoutChecks, 60 * 60 * 1000);
  // Run once on startup
  runTimeoutChecks();
  console.log(`Timeout checker started (ship: ${SHIP_TIMEOUT_DAYS}d, dispute: ${DISPUTE_TIMEOUT_DAYS}d)`);
}

module.exports = { startTimeoutChecker, runTimeoutChecks };
