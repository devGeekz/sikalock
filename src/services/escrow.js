const pool = require('../db/pool');

async function getOrCreateUser(phone, name) {
  const existing = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
  if (existing.rows.length > 0) return existing.rows[0];

  const result = await pool.query(
    'INSERT INTO users (phone, name) VALUES ($1, $2) RETURNING *',
    [phone, name]
  );
  return result.rows[0];
}

async function findUserByPhone(phone) {
  const result = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
  return result.rows[0] || null;
}

async function createTransaction(buyerId, sellerId, amount) {
  const result = await pool.query(
    'INSERT INTO transactions (buyer_id, seller_id, amount, status) VALUES ($1, $2, $3, $4) RETURNING *',
    [buyerId, sellerId, amount, 'pending']
  );
  return result.rows[0];
}

async function getTransaction(txId) {
  const result = await pool.query(
    `SELECT t.*,
            b.phone as buyer_phone, b.name as buyer_name,
            s.phone as seller_phone, s.name as seller_name
     FROM transactions t
     JOIN users b ON t.buyer_id = b.id
     JOIN users s ON t.seller_id = s.id
     WHERE t.id = $1`,
    [txId]
  );
  return result.rows[0] || null;
}

async function updateTransactionStatus(txId, status, momoReference) {
  const result = await pool.query(
    'UPDATE transactions SET status = $1, momo_reference = COALESCE($2, momo_reference), updated_at = NOW() WHERE id = $3 RETURNING *',
    [status, momoReference, txId]
  );
  return result.rows[0];
}

async function addLedgerEntry(txId, action) {
  await pool.query(
    'INSERT INTO escrow_ledger (transaction_id, action) VALUES ($1, $2)',
    [txId, action]
  );
}

async function getLedgerEntries(txId) {
  const result = await pool.query(
    'SELECT * FROM escrow_ledger WHERE transaction_id = $1 ORDER BY timestamp ASC',
    [txId]
  );
  return result.rows;
}

module.exports = {
  getOrCreateUser,
  findUserByPhone,
  createTransaction,
  getTransaction,
  updateTransactionStatus,
  addLedgerEntry,
  getLedgerEntries,
};
