'use client';

import { useEffect, useRef, useState } from 'react';
import type { TraceEvent } from '@/lib/types';

const STYLES: Record<TraceEvent['type'], { label: string; color: string }> = {
  'task.received': { label: 'TASK', color: 'text-sky-400' },
  'session.created': { label: 'SESSION', color: 'text-sky-400' },
  'sandbox.created': { label: 'SANDBOX', color: 'text-violet-400' },
  'agent.message': { label: 'AGENT', color: 'text-slate-200' },
  'agent.reasoning': { label: 'THINK', color: 'text-slate-500' },
  'tool.call': { label: 'TOOL →', color: 'text-amber-400' },
  'tool.result': { label: 'TOOL ←', color: 'text-emerald-400' },
  'token.usage': { label: 'TOKENS', color: 'text-slate-500' },
  'interceptor.pause': { label: 'PAUSED', color: 'text-rose-400' },
  'interceptor.resume': { label: 'RESUME', color: 'text-emerald-400' },
  'task.complete': { label: 'DONE', color: 'text-emerald-400' },
  'task.failed': { label: 'FAILED', color: 'text-rose-500' },
};

export function TraceConsole({
  events,
  connected,
  taskFilter,
}: {
  events: TraceEvent[];
  connected: boolean;
  taskFilter: string | null;
}) {
  const [showThinking, setShowThinking] = useState(false);
  const [pinned, setPinned] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);

  const visible = events.filter(
    (e) =>
      (!taskFilter || e.taskId === taskFilter) &&
      (showThinking || e.type !== 'agent.reasoning'),
  );

  useEffect(() => {
    if (pinned) bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [visible.length, pinned]);

  const usage = [...events].reverse().find((e) => e.type === 'token.usage')?.payload;

  return (
    <section className="flex h-full flex-col rounded-xl border border-slate-800 bg-slate-900/60">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-sky-400">Live Agent Execution Trace</h2>
          <span
            className={`inline-flex items-center gap-1.5 text-xs ${
              connected ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                connected ? 'bg-emerald-400' : 'bg-rose-400'
              }`}
            />
            {connected ? 'streaming' : 'reconnecting'}
          </span>
        </div>

        <div className="flex items-center gap-4 text-xs text-slate-400">
          {usage && (
            <span className="font-mono">
              {usage.inputTokens?.toLocaleString()} in / {usage.outputTokens?.toLocaleString()} out
            </span>
          )}
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={showThinking}
              onChange={(e) => setShowThinking(e.target.checked)}
              className="accent-sky-500"
            />
            reasoning
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
              className="accent-sky-500"
            />
            follow
          </label>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed">
        {visible.length === 0 ? (
          <p className="p-4 text-slate-600">
            No events yet. Register a repository to dispatch a patching task.
          </p>
        ) : (
          visible.map((e, i) => {
            const style = STYLES[e.type] ?? { label: e.type, color: 'text-slate-400' };
            return (
              <div key={i} className="mb-1.5 flex gap-2">
                <span className="shrink-0 text-slate-600">
                  {new Date(e.timestamp).toLocaleTimeString()}
                </span>
                <span className={`w-16 shrink-0 font-semibold ${style.color}`}>{style.label}</span>
                <span className="whitespace-pre-wrap break-all text-slate-300">{e.message}</span>
              </div>
            );
          })
        )}
        <div ref={bottom} />
      </div>
    </section>
  );
}
