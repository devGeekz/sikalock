const { Collections, Disbursements } = require('mtn-momo');
const config = require('../config');

const collections = Collections({
  userSecret: config.momo.collections.userSecret,
  userId: config.momo.collections.userId,
  primaryKey: config.momo.collections.primaryKey,
});

const disbursements = Disbursements({
  userSecret: config.momo.disbursements.userSecret,
  userId: config.momo.disbursements.userId,
  primaryKey: config.momo.disbursements.primaryKey,
});

async function requestToPay({ amount, phone, externalId, payerMessage }) {
  return collections.requestToPay({
    amount: String(amount),
    currency: 'GHS',
    externalId,
    payer: { partyIdType: 'MSISDN', partyId: phone },
    payerMessage: payerMessage || 'SikaLock escrow payment',
    payeeNote: 'Escrow lock',
  });
}

async function getPaymentStatus(referenceId) {
  return collections.getTransaction(referenceId);
}

async function transfer({ amount, phone, externalId, payeeNote }) {
  return disbursements.transfer({
    amount: String(amount),
    currency: 'GHS',
    externalId,
    payee: { partyIdType: 'MSISDN', partyId: phone },
    payeeNote: payeeNote || 'SikaLock escrow release',
    payerMessage: 'Funds released',
  });
}

async function getTransferStatus(referenceId) {
  return disbursements.getTransaction(referenceId);
}

module.exports = {
  requestToPay,
  getPaymentStatus,
  transfer,
  getTransferStatus,
};
