const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

const sqs = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });

const sendLoginEvent = async (event) => {
  if (!process.env.SQS_QUEUE_URL) {
    if (process.env.NODE_ENV === 'production') {
      // Don't fail the login response itself, but make the gap loud and
      // visible instead of silently dropping the audit/notification path.
      console.error(
        'SQS_QUEUE_URL is not set in production - login event NOT published. ' +
        'Audit log and email notification will not fire for this login.'
      );
    } else {
      console.warn('[dev only] SQS_QUEUE_URL not set, skipping login event publish');
    }
    return;
  }

  const command = new SendMessageCommand({
    QueueUrl: process.env.SQS_QUEUE_URL,
    MessageBody: JSON.stringify(event)
  });

  await sqs.send(command);
};

module.exports = { sendLoginEvent };
