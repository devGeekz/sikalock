const express = require('express');
const router = express.Router();
const escrow = require('../services/escrow');

// MoMo payment notification webhook
router.post('/momo', async (req, res) => {
  const { externalId, status, financialTransactionId } = req.body;

  console.log('MoMo webhook received:', req.body);

  if (!externalId) {
    return res.status(400).json({ error: 'Missing externalId' });
  }

  try {
    const tx = await escrow.getTransaction(externalId);
    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // Dedup: skip if already locked
    if (tx.status === 'locked') {
      return res.status(200).json({ message: 'Already processed' });
    }

    if (status === 'SUCCESSFUL') {
      await escrow.updateTransactionStatus(tx.id, 'locked', financialTransactionId);
      await escrow.addLedgerEntry(tx.id, 'fund_locked');
      console.log(`Transaction ${tx.id} funds locked`);
    } else {
      await escrow.updateTransactionStatus(tx.id, 'pending', null);
      console.log(`Transaction ${tx.id} payment failed`);
    }

    res.status(200).json({ message: 'Webhook processed' });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Transaction status endpoint
router.get('/transaction/:txId', async (req, res) => {
  const { txId } = req.params;

  try {
    const tx = await escrow.getTransaction(txId);
    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const ledger = await escrow.getLedgerEntries(txId);
    res.json({ transaction: tx, ledger });
  } catch (err) {
    console.error('Status error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Manual timeout check (for testing)
const { runTimeoutChecks } = require('../services/timeout');
router.post('/timeout-check', async (req, res) => {
  await runTimeoutChecks();
  res.json({ message: 'Timeout checks completed' });
});

module.exports = router;
