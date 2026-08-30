import amqp from 'amqplib';
import { config } from './config.js';

let connection = null;
let channel = null;

/** Reconnecting AMQP producer. Publishes are durable + persistent. */
export async function initQueue({ retries = 30, delayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      connection = await amqp.connect(config.rabbitUrl);
      connection.on('error', (err) => console.error('[amqp] error', err.message));
      connection.on('close', () => {
        console.warn('[amqp] connection closed; reconnecting');
        channel = null;
        setTimeout(() => initQueue().catch(() => {}), delayMs);
      });
      channel = await connection.createChannel();
      await channel.assertQueue(config.queue, { durable: true });
      console.log(`[amqp] connected, queue "${config.queue}" ready`);
      return;
    } catch (err) {
      console.warn(
        `[amqp] connect attempt ${attempt}/${retries} failed: ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('RabbitMQ unreachable after retries');
}

export function publishTask(payload) {
  if (!channel) throw new Error('AMQP channel not ready');
  return channel.sendToQueue(
    config.queue,
    Buffer.from(JSON.stringify(payload)),
    { persistent: true, contentType: 'application/json' },
  );
}

export function queueReady() {
  return channel !== null;
}

export async function closeQueue() {
  try {
    await channel?.close();
    await connection?.close();
  } catch {
    /* shutting down anyway */
  }
}
