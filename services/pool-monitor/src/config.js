export const config = {
  port: Number(process.env.PORT || 8080),
  postgresUrl:
    process.env.POSTGRES_URL ||
    'postgresql://patchforge:patchforge@postgres:5432/patchforge',
  rabbitUrl: process.env.RABBITMQ_URL || 'amqp://rabbitmq:5672',
  advisoryUrl: process.env.ADVISORY_SERVICE_URL || 'http://advisory-service:8081',
  // Optional: raises the GitHub rate limit and reaches private repos.
  githubToken: process.env.GITHUB_TOKEN || '',
  queue: 'tasks.patching',
  // Cron for the periodic sweep. Default: every 6 hours on the hour.
  scanCron: process.env.SCAN_CRON || '0 */6 * * *',
  scanOnBoot: process.env.SCAN_ON_BOOT !== 'false',
};
