const momo = require('mtn-momo');
const config = require('../config');

let collections = null;
let disbursements = null;

function getCollections() {
  if (!collections) {
    const { Collections } = momo.create({
      callbackHost: config.momo.callbackHost || 'https://localhost:3000',
    });
    collections = Collections({
      userSecret: config.momo.collections.userSecret,
      userId: config.momo.collections.userId,
      primaryKey: config.momo.collections.primaryKey,
    });
  }
  return collections;
}

function getDisbursements() {
  if (!disbursements) {
    const { Disbursements } = momo.create({
      callbackHost: config.momo.callbackHost || 'https://localhost:3000',
    });
    disbursements = Disbursements({
      userSecret: config.momo.disbursements.userSecret,
      userId: config.momo.disbursements.userId,
      primaryKey: config.momo.disbursements.primaryKey,
    });
  }
  return disbursements;
}

async function requestToPay({ amount, phone, externalId, payerMessage }) {
  return getCollections().requestToPay({
    amount: String(amount),
    currency: 'GHS',
    externalId,
    payer: { partyIdType: 'MSISDN', partyId: phone },
    payerMessage: payerMessage || 'SikaLock escrow payment',
    payeeNote: 'Escrow lock',
  });
}

async function getPaymentStatus(referenceId) {
  return getCollections().getTransaction(referenceId);
}

async function transfer({ amount, phone, externalId, payeeNote }) {
  return getDisbursements().transfer({
    amount: String(amount),
    currency: 'GHS',
    externalId,
    payee: { partyIdType: 'MSISDN', partyId: phone },
    payeeNote: payeeNote || 'SikaLock escrow release',
    payerMessage: 'Funds released',
  });
}

async function getTransferStatus(referenceId) {
  return getDisbursements().getTransaction(referenceId);
}

module.exports = {
  requestToPay,
  getPaymentStatus,
  transfer,
  getTransferStatus,
};
