require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  adminPhone: process.env.ADMIN_PHONE || '',
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'sikalock',
    user: process.env.DB_USER || 'sikalock',
    password: process.env.DB_PASSWORD || 'sikalock',
  },
  at: {
    username: process.env.AT_USERNAME || 'sandbox',
    apiKey: process.env.AT_API_KEY,
    ussdCode: process.env.AT_USSD_CODE,
  },
  momo: {
    environment: process.env.MOMO_ENVIRONMENT || 'sandbox',
    callbackHost: process.env.MOMO_CALLBACK_HOST,
    collections: {
      userId: process.env.MOMO_COLLECTIONS_USER_ID,
      userSecret: process.env.MOMO_COLLECTIONS_USER_SECRET,
      primaryKey: process.env.MOMO_COLLECTIONS_PRIMARY_KEY,
    },
    disbursements: {
      userId: process.env.MOMO_DISBURSEMENTS_USER_ID,
      userSecret: process.env.MOMO_DISBURSEMENTS_USER_SECRET,
      primaryKey: process.env.MOMO_DISBURSEMENTS_PRIMARY_KEY,
    },
  },
};
