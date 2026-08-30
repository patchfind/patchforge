'use client';

import { useEffect, useRef, useState } from 'react';
import { harnessWsUrl } from '@/lib/api';
import type { TraceEvent } from '@/lib/types';

const MAX_EVENTS = 1000;

/**
 * Live trace subscription with automatic reconnect.
 *
 * The harness replays each task's buffered history on connect, so a reconnect
 * would duplicate events — they are deduplicated on (taskId, timestamp, type,
 * message) rather than trusting arrival order.
 */
export function useTrace() {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const seen = useRef(new Set<string>());
  const retry = useRef(0);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let closed = false;

    const connect = () => {
      socket = new WebSocket(harnessWsUrl());

      socket.onopen = () => {
        setConnected(true);
        retry.current = 0;
      };

      socket.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data) as TraceEvent;
          const key = `${event.taskId}|${event.timestamp}|${event.type}|${event.message ?? ''}`;
          if (seen.current.has(key)) return;
          seen.current.add(key);
          setEvents((prev) => [...prev, event].slice(-MAX_EVENTS));
        } catch {
          /* ignore malformed frames */
        }
      };

      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        // Exponential backoff, capped, so a harness restart does not hammer it.
        const delay = Math.min(1000 * 2 ** retry.current++, 15000);
        timer = setTimeout(connect, delay);
      };

      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, []);

  return { events, connected };
}
