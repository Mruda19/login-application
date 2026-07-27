const { Pool } = require('pg');

// Assumes the schema (users, and whatever else your Lambda needs, e.g.
// login_audit) already exists — created once by connecting to RDS and
// running your own CREATE TABLE statements. The backend does NOT create
// tables on startup; see README.md / MANUAL_SETUP.md.
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 5
});

module.exports = pool;
