// Fail fast on missing configuration instead of silently running with
// gaps (e.g. logins "succeeding" but never reaching SQS/Lambda/SNS).
const REQUIRED_VARS = [
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'AWS_REGION',
  'SQS_QUEUE_URL'
];

function validateEnv() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    if (process.env.NODE_ENV === 'production') {
      console.error(`Missing required environment variables: ${missing.join(', ')}`);
      process.exit(1);
    } else {
      console.warn(
        `[dev only] Missing environment variables: ${missing.join(', ')}. ` +
        'This is tolerated outside production but will hard-fail once NODE_ENV=production.'
      );
    }
  }
}

module.exports = validateEnv;
