import amqp, { type Channel, type ChannelModel } from 'amqplib';
import { config } from './config.js';
import { runTask, reportStatus } from './runner.js';
import type { PatchTask } from './types.js';

let connection: ChannelModel | null = null;
let channel: Channel | null = null;

export async function startWorker({ retries = 30, delayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      connection = await amqp.connect(config.rabbitUrl);
      channel = await connection.createChannel();
      await channel.assertQueue(config.queue, { durable: true });
      // Bound in-flight sessions: each one holds a sandbox and may sit for
      // hours at the approval gate.
      await channel.prefetch(config.prefetch);

      connection.on('close', () => {
        console.warn('[worker] amqp closed; reconnecting');
        channel = null;
        setTimeout(() => startWorker().catch(() => {}), delayMs);
      });
      connection.on('error', (err) => console.error('[worker] amqp error', err.message));

      await channel.consume(config.queue, onMessage, { noAck: false });
      console.log(`[worker] consuming "${config.queue}" (prefetch ${config.prefetch})`);
      return;
    } catch (err: any) {
      console.warn(`[worker] connect attempt ${attempt}/${retries}: ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('RabbitMQ unreachable after retries');
}

async function onMessage(msg: amqp.ConsumeMessage | null) {
  if (!msg || !channel) return;

  let task: PatchTask;
  try {
    task = JSON.parse(msg.content.toString());
  } catch (err) {
    console.error('[worker] unparseable message, dropping', err);
    channel.nack(msg, false, false);
    return;
  }

  console.log(`[worker] task ${task.task_id}: ${task.target_package} in ${task.repo_url}`);
  await reportStatus(task.task_id, 'RUNNING');

  try {
    const outcome = await runTask(task);
    await reportStatus(task.task_id, outcome.status);
    // Ack on every terminal outcome — a failed patch is not a poison message,
    // and redelivering it would restart a whole agent run.
    channel.ack(msg);
    console.log(`[worker] task ${task.task_id} -> ${outcome.status}`);
  } catch (err: any) {
    console.error(`[worker] task ${task.task_id} threw`, err);
    await reportStatus(task.task_id, 'FAILED');
    channel.nack(msg, false, false);
  }
}

export async function stopWorker() {
  try {
    await channel?.close();
    await connection?.close();
  } catch {
    /* shutting down */
  }
}
