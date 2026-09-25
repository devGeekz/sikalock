const express = require('express');
const router = express.Router();
const escrow = require('../services/escrow');
const momo = require('../services/momo');

// In-memory session store (replace with Redis in production)
const sessions = {};

function normalizePhone(phone) {
  let p = phone.replace(/[^0-9]/g, '');
  if (p.startsWith('0')) p = '233' + p.slice(1);
  if (!p.startsWith('233')) p = '233' + p;
  return p;
}

function ussdResponse(message, continueSession = true) {
  const prefix = continueSession ? 'CON ' : 'END ';
  return prefix + message;
}

const MENU_TEXT = '1. Register\n2. New Transaction\n3. Confirm Delivery\n4. Ship Goods\n5. Check Status\n6. Dispute';

router.post('/', async (req, res) => {
  const { sessionId, phoneNumber, text } = req.body;

  if (!sessionId || !phoneNumber) {
    return res.send(ussdResponse('Invalid request.', false));
  }

  const normalizedPhone = normalizePhone(phoneNumber);

  // Initialize session (with TTL)
  if (!sessions[sessionId]) {
    sessions[sessionId] = { step: 'menu', data: {}, createdAt: Date.now() };
  }

  const session = sessions[sessionId];

  // Check session TTL (3 minutes)
  if (Date.now() - session.createdAt > 3 * 60 * 1000) {
    sessions[sessionId] = { step: 'menu', data: {}, createdAt: Date.now() };
  }

  const inputs = text ? text.split('*') : [];
  const lastInput = inputs[inputs.length - 1] || '';

  try {
    let response;

    // Route based on session step
    switch (session.step) {
      case 'menu':
        response = handleMenu(session, lastInput);
        break;
      case 'register_name':
        response = await handleRegister(session, normalizedPhone, lastInput);
        break;
      case 'new_tx_seller':
        response = await handleNewTxSeller(session, lastInput);
        break;
      case 'new_tx_amount':
        response = await handleNewTxAmount(session, lastInput);
        break;
      case 'new_tx_confirm':
        response = await handleNewTxConfirm(session, normalizedPhone, lastInput);
        break;
      case 'ship_goods':
        response = await handleShipGoods(session, normalizedPhone, lastInput);
        break;
      case 'confirm_delivery':
        response = await handleConfirmDelivery(session, normalizedPhone, lastInput);
        break;
      case 'check_status':
        response = await handleCheckStatus(session, lastInput);
        break;
      case 'dispute':
        response = await handleDispute(session, normalizedPhone, lastInput);
        break;
      case 'dispute_reason':
        response = await handleDisputeReason(session, lastInput);
        break;
      default:
        response = ussdResponse('Something went wrong. Please dial again.', false);
    }

    res.send(response);
  } catch (err) {
    console.error('USSD error:', err);
    res.send(ussdResponse('An error occurred. Please try again later.', false));
  }
});

function handleMenu(session, input) {
  switch (input) {
    case '1':
      session.step = 'register_name';
      return ussdResponse('Enter your name:');
    case '2':
      session.step = 'new_tx_seller';
      return ussdResponse('Enter seller phone number:');
    case '3':
      session.step = 'confirm_delivery';
      return ussdResponse('Enter transaction ID to confirm delivery:');
    case '4':
      session.step = 'ship_goods';
      return ussdResponse('Enter transaction ID to confirm shipment:');
    case '5':
      session.step = 'check_status';
      return ussdResponse('Enter transaction ID to check status:');
    case '6':
      session.step = 'dispute';
      return ussdResponse('Enter transaction ID to dispute:');
    default:
      return ussdResponse('Welcome to SikaLock\n' + MENU_TEXT);
  }
}

async function handleRegister(session, phone, name) {
  if (!name || name.length < 2) {
    return ussdResponse('Please enter a valid name:');
  }

  await escrow.getOrCreateUser(phone, name);
  session.step = 'menu';
  session.data = {};
  return ussdResponse(`Registered successfully as ${name}.\n\n${MENU_TEXT}`, false);
}

async function handleNewTxSeller(session, phone) {
  if (!phone || phone.length < 10) {
    return ussdResponse('Please enter a valid phone number (e.g., 233XXXXXXXXX):');
  }

  const normalized = normalizePhone(phone);
  const seller = await escrow.findUserByPhone(normalized);
  if (!seller) {
    return ussdResponse(`No user found with that number.\n\n${MENU_TEXT}`, false);
  }

  session.data.sellerId = seller.id;
  session.data.sellerPhone = normalized;
  session.step = 'new_tx_amount';
  return ussdResponse(`Seller: ${seller.name} (${normalized})\nEnter amount in GHS:`);
}

async function handleNewTxAmount(session, amountStr) {
  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    return ussdResponse('Please enter a valid amount:');
  }

  session.data.amount = amount;
  session.step = 'new_tx_confirm';
  return ussdResponse(
    `Confirm transaction:\nSeller: ${session.data.sellerPhone}\nAmount: GHS ${amount}\n\n1. Confirm\n2. Cancel`
  );
}

async function handleNewTxConfirm(session, phone, input) {
  if (input === '1') {
    const buyer = await escrow.findUserByPhone(phone);
    if (!buyer) {
      return ussdResponse(`Buyer not found. Please register first.\n\n${MENU_TEXT}`, false);
    }

    // Create transaction in DB
    const tx = await escrow.createTransaction(buyer.id, session.data.sellerId, session.data.amount);

    const amount = session.data.amount;

    // Call MoMo to collect funds from buyer
    try {
      const momoResult = await momo.requestToPay({
        amount: amount,
        phone: phone,
        externalId: tx.id,
        payerMessage: `SikaLock escrow - Transaction ${tx.id}`,
      });

      // MoMo accepted the request — update status to locked
      await escrow.updateTransactionStatus(tx.id, 'locked', momoResult.financialTransactionId || null);
      await escrow.addLedgerEntry(tx.id, 'fund_locked');

      session.step = 'menu';
      session.data = {};
      return ussdResponse(
        `Transaction created!\nID: ${tx.id}\nAmount: GHS ${amount}\nStatus: Locked\n\nPayment initiated. You will receive an MoMo prompt.\n\n${MENU_TEXT}`,
        false
      );
    } catch (momoErr) {
      console.error('MoMo requestToPay failed:', momoErr);

      session.step = 'menu';
      session.data = {};
      return ussdResponse(
        `Transaction created!\nID: ${tx.id}\nAmount: GHS ${amount}\nStatus: Pending\n\nPayment request failed. Try again later.\n\n${MENU_TEXT}`,
        false
      );
    }
  }

  session.step = 'menu';
  session.data = {};
  return ussdResponse(`Transaction cancelled.\n\n${MENU_TEXT}`, false);
}

async function handleShipGoods(session, phone, txId) {
  if (!txId) {
    return ussdResponse('Enter transaction ID to confirm shipment:');
  }

  const tx = await escrow.getTransaction(txId);
  if (!tx) {
    return ussdResponse(`Transaction not found.\n\n${MENU_TEXT}`, false);
  }

  // Only the seller can ship
  if (tx.seller_phone !== phone) {
    return ussdResponse(`This is not your transaction.\n\n${MENU_TEXT}`, false);
  }

  if (tx.status !== 'locked') {
    return ussdResponse(`Transaction status: ${tx.status}. Can only ship locked transactions.\n\n${MENU_TEXT}`, false);
  }

  await escrow.updateTransactionStatus(tx.id, 'shipped', null);
  await escrow.addLedgerEntry(tx.id, 'goods_shipped');

  session.step = 'menu';
  session.data = {};
  return ussdResponse(
    `Shipment confirmed!\nTransaction ${tx.id} status: Shipped\nBuyer will be notified to confirm delivery.\n\n${MENU_TEXT}`,
    false
  );
}

async function handleConfirmDelivery(session, phone, txId) {
  if (!txId) {
    return ussdResponse('Enter transaction ID to confirm delivery:');
  }

  const tx = await escrow.getTransaction(txId);
  if (!tx) {
    return ussdResponse(`Transaction not found.\n\n${MENU_TEXT}`, false);
  }

  // Only the buyer can confirm delivery
  if (tx.buyer_phone !== phone) {
    return ussdResponse(`This is not your transaction.\n\n${MENU_TEXT}`, false);
  }

  if (tx.status !== 'shipped') {
    return ussdResponse(`Transaction status: ${tx.status}. Can only confirm shipped transactions.\n\n${MENU_TEXT}`, false);
  }

  // Call MoMo to release funds to seller
  try {
    const momoResult = await momo.transfer({
      amount: tx.amount,
      phone: tx.seller_phone,
      externalId: tx.id,
      payeeNote: `SikaLock escrow release - Transaction ${tx.id}`,
    });

    await escrow.updateTransactionStatus(tx.id, 'released', momoResult.financialTransactionId || null);
    await escrow.addLedgerEntry(tx.id, 'buyer_confirmed');
    await escrow.addLedgerEntry(tx.id, 'funds_released');

    session.step = 'menu';
    session.data = {};
    return ussdResponse(
      `Delivery confirmed!\nTransaction ${tx.id} completed.\nFunds released to ${tx.seller_name}.\n\n${MENU_TEXT}`,
      false
    );
  } catch (momoErr) {
    console.error('MoMo transfer failed:', momoErr);

    session.step = 'menu';
    session.data = {};
    return ussdResponse(
      `Could not release funds. Try again later by selecting Confirm Delivery.\n\n${MENU_TEXT}`,
      false
    );
  }
}

async function handleCheckStatus(session, txId) {
  if (!txId) {
    return ussdResponse('Enter transaction ID to check status:');
  }

  const tx = await escrow.getTransaction(txId);
  if (!tx) {
    return ussdResponse(`Transaction not found.\n\n${MENU_TEXT}`, false);
  }

  session.step = 'menu';
  session.data = {};
  return ussdResponse(
    `Transaction ${tx.id}\nAmount: GHS ${tx.amount}\nStatus: ${tx.status}\nCreated: ${tx.created_at}\n\n${MENU_TEXT}`,
    false
  );
}

async function handleDispute(session, phone, txId) {
  if (!txId) {
    return ussdResponse('Enter transaction ID to dispute:');
  }

  const tx = await escrow.getTransaction(txId);
  if (!tx) {
    return ussdResponse(`Transaction not found.\n\n${MENU_TEXT}`, false);
  }

  if (tx.buyer_phone !== phone && tx.seller_phone !== phone) {
    return ussdResponse(`This is not your transaction.\n\n${MENU_TEXT}`, false);
  }

  if (tx.status !== 'locked' && tx.status !== 'shipped') {
    return ussdResponse(`Cannot dispute transaction with status: ${tx.status}.\n\n${MENU_TEXT}`, false);
  }

  session.data.txId = tx.id;
  session.step = 'dispute_reason';
  return ussdResponse("Why are you disputing?\n1. Haven't received goods\n2. Wrong/damaged goods\n3. Other");
}

const DISPUTE_REASONS = {
  '1': "Haven't received goods",
  '2': 'Wrong/damaged goods',
  '3': 'Other',
};

async function handleDisputeReason(session, input) {
  const reason = DISPUTE_REASONS[input];
  if (!reason) {
    return ussdResponse("Why are you disputing?\n1. Haven't received goods\n2. Wrong/damaged goods\n3. Other");
  }

  const txId = session.data.txId;
  await escrow.updateTransactionStatus(txId, 'disputed', null);
  await escrow.addLedgerEntry(txId, 'dispute_opened', reason);

  session.step = 'menu';
  session.data = {};
  return ussdResponse(
    `Dispute opened for transaction ${txId}.\nReason: ${reason}\nOur team will review this.\n\n${MENU_TEXT}`,
    false
  );
}

module.exports = router;
module.exports.normalizePhone = normalizePhone;
