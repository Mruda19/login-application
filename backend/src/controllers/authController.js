const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const { sendLoginEvent } = require('../services/sqsService');

const register = async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({
        message: 'username, email and password are required'
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)',
      [username, email, passwordHash]
    );

    return res.status(201).json({ message: 'User created' });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ message: 'Username or email already registered' });
    }
    console.error(error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

const login = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        message: 'Username and password are required'
      });
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    const user = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    // Auth check itself is synchronous against RDS - the user gets an
    // immediate answer. The audit-log + email-notification path below is
    // fire-and-forget via SQS -> Lambda -> SNS.
    await sendLoginEvent({
      event: 'USER_LOGIN_SUCCESS',
      userId: user.id,
      username: user.username,
      email: user.email,
      status: 'SUCCESS',
      timestamp: new Date().toISOString()
    });

    return res.status(200).json({ message: 'Login successful' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

module.exports = { login, register };
