import { WebSocketServer, WebSocket } from 'ws';
import type { TraceEvent, TraceEventType } from './types.js';
import { config } from './config.js';

/**
 * Fan-out hub for live execution traces.
 *
 * A bounded replay buffer is kept per task so a browser that connects mid-run
 * (or reloads during a long pytest cycle) still renders the history instead of
 * an empty console.
 */
const REPLAY_LIMIT = 500;

class TraceBus {
  private wss: WebSocketServer | null = null;
  private replay = new Map<string, TraceEvent[]>();

  start() {
    this.wss = new WebSocketServer({ port: config.wsPort });
    this.wss.on('connection', (socket, req) => {
      const taskId = new URL(req.url ?? '/', 'http://x').searchParams.get('taskId');
      console.log(`[trace] client connected${taskId ? ` for task ${taskId}` : ''}`);

      const history = taskId
        ? (this.replay.get(taskId) ?? [])
        : [...this.replay.values()].flat().slice(-REPLAY_LIMIT);

      for (const event of history) {
        socket.send(JSON.stringify(event));
      }
      socket.on('error', (err) => console.warn('[trace] socket error', err.message));
    });
    console.log(`[trace] websocket listening on :${config.wsPort}`);
  }

  emit(
    type: TraceEventType,
    taskId: string,
    fields: Partial<Omit<TraceEvent, 'type' | 'taskId'>> = {},
  ) {
    const event: TraceEvent = {
      type,
      taskId,
      timestamp: new Date().toISOString(),
      ...fields,
    };

    const buf = this.replay.get(taskId) ?? [];
    buf.push(event);
    if (buf.length > REPLAY_LIMIT) buf.shift();
    this.replay.set(taskId, buf);

    const frame = JSON.stringify(event);
    for (const client of this.wss?.clients ?? []) {
      if (client.readyState === WebSocket.OPEN) client.send(frame);
    }
  }

  history(taskId: string): TraceEvent[] {
    return this.replay.get(taskId) ?? [];
  }

  close() {
    this.wss?.close();
  }
}

export const trace = new TraceBus();
