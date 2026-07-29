require('dotenv').config();

const express = require('express');
const cors = require('cors');

const validateEnv = require('./config/validateEnv');
const authRoutes = require('./routes/authRoutes');
const errorHandler = require('./middleware/errorHandler');
const pool = require('./config/database');

validateEnv();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
// ALB Target Group health check path:
// /api/health
app.get('/api/health', async (req, res) => {
  try {
    // Check whether the backend can connect to PostgreSQL RDS
    await pool.query('SELECT 1');

    res.status(200).json({
      status: 'healthy',
      db: 'reachable'
    });
  } catch (err) {
    console.error('Health check DB failure:', err);

    res.status(503).json({
      status: 'unhealthy',
      db: 'unreachable'
    });
  }
});

// Authentication routes
app.use('/api', authRoutes);

// Error handling middleware
app.use(errorHandler);

const PORT = process.env.PORT || 3000;

// Verify that the database and users table are available
// before starting the backend server.
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

    // Listen on all network interfaces.
    // This allows the ECS/ALB to reach the backend container.
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Backend running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error(
      'Failed to connect to the database on startup:',
      err
    );

    process.exit(1);
  });