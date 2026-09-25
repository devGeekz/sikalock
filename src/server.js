const express = require('express');
const cors = require('cors');
const pool = require('./db/pool');
const config = require('./config');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/ussd', require('./routes/ussd'));
app.use('/webhook', require('./routes/webhook'));

// Health check
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'disconnected' });
  }
});

// Initialize database on startup
async function initDb() {
  const fs = require('fs');
  const path = require('path');

  // Migrations: drop old role column and enum if they exist
  try {
    await pool.query('ALTER TABLE users DROP COLUMN IF EXISTS role');
    await pool.query('DROP TYPE IF EXISTS user_role CASCADE');
    console.log('Migration: dropped user_role');
  } catch (err) {
    // Ignore — column/type may not exist
  }

  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('Database schema initialized');
}

// Start server
async function start() {
  try {
    await initDb();
    const { startTimeoutChecker } = require('./services/timeout');
    startTimeoutChecker();
    app.listen(config.port, () => {
      console.log(`SikaLock server running on port ${config.port}`);
      console.log(`Environment: ${config.nodeEnv}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
