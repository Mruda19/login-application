require('dotenv').config();

const express = require('express');
const cors = require('cors');

const validateEnv = require('./config/validateEnv');
const authRoutes = require('./routes/authRoutes');
const errorHandler = require('./middleware/errorHandler');
const pool = require('./config/database');

validateEnv();

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'healthy', db: 'reachable' });
  } catch (err) {
    console.error('Health check DB failure', err);
    res.status(503).json({ status: 'unhealthy', db: 'unreachable' });
  }
});

app.use('/api', authRoutes);

app.use(errorHandler);

const PORT = process.env.PORT || 3000;

// Verify the DB (and its schema) are actually reachable before accepting
// traffic. This assumes you already connected to RDS and created the
// `users` table yourself with your own CREATE TABLE statement - the
// backend no longer creates tables itself.
pool
  .query('SELECT to_regclass($1)', ['public.users'])
  .then((result) => {
    if (!result.rows[0].to_regclass) {
      console.error(
        "Table 'users' does not exist. Connect to RDS and create it " +
        'yourself (see README.md) before starting the backend.'
      );
      process.exit(1);
    }
    app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to connect to the database on startup', err);
    process.exit(1);
  });
