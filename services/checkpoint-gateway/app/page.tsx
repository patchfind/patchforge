'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { PendingApproval } from '@/lib/types';
import { useTrace } from '@/components/useTrace';
import { TraceConsole } from '@/components/TraceConsole';
import { ApprovalGate } from '@/components/ApprovalGate';
import { RepositoryPanel } from '@/components/RepositoryPanel';

export default function Dashboard() {
  const { events, connected } = useTrace();
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<string | null>(null);

  const refreshApprovals = useCallback(async () => {
    try {
      const { approvals } = await api.listApprovals();
      setApprovals(approvals);
      // Auto-select the only pause, or keep the current one if it is still open.
      setSelected((prev) =>
        prev && approvals.some((a: PendingApproval) => a.taskId === prev)
          ? prev
          : (approvals[0]?.taskId ?? null),
      );
    } catch {
      /* harness may still be booting */
    }
  }, []);

  useEffect(() => {
    refreshApprovals();
    const t = setInterval(refreshApprovals, 5000);
    return () => clearInterval(t);
  }, [refreshApprovals]);

  // A pause or resume changes the gate immediately — do not wait for the poll.
  useEffect(() => {
    const last = events[events.length - 1];
    if (last?.type === 'interceptor.pause' || last?.type === 'interceptor.resume') {
      refreshApprovals();
    }
  }, [events, refreshApprovals]);

  const decide = async (taskId: string, action: 'APPROVE' | 'REJECT', reason?: string) => {
    await api.decide(taskId, action, reason);
    await refreshApprovals();
  };

  const tasks = [...new Set(events.map((e) => e.taskId))];
  const active = approvals.find((a) => a.taskId === selected) ?? null;

  return (
    <div className="mx-auto flex h-screen max-w-[1800px] flex-col gap-4 p-6">
      <header className="flex items-end justify-between border-b border-slate-800 pb-4">
        <div>
          <h1 className="text-xl font-bold text-amber-400">PatchForge Enterprise</h1>
          <p className="text-xs text-slate-500">
            Automated CVE remediation · TrueForge agent harness · human approval gate
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          {approvals.length > 0 && (
            <span className="rounded-full border border-amber-700 bg-amber-950/50 px-3 py-1 text-amber-300">
              {approvals.length} awaiting approval
            </span>
          )}
          <select
            value={taskFilter ?? ''}
            onChange={(e) => setTaskFilter(e.target.value || null)}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs outline-none"
          >
            <option value="">All tasks</option>
            {tasks.map((t) => (
              <option key={t} value={t}>
                {t.slice(0, 8)}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="flex min-h-0 flex-col gap-4">
          <RepositoryPanel onActivity={refreshApprovals} />
          <div className="min-h-0 flex-1">
            <TraceConsole events={events} connected={connected} taskFilter={taskFilter} />
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-2">
          {approvals.length > 1 && (
            <div className="flex gap-1 overflow-x-auto">
              {approvals.map((a) => (
                <button
                  key={a.taskId}
                  onClick={() => setSelected(a.taskId)}
                  className={`whitespace-nowrap rounded px-3 py-1.5 text-[11px] ${
                    a.taskId === selected
                      ? 'bg-amber-900/40 text-amber-300'
                      : 'text-slate-500 hover:bg-slate-800/50'
                  }`}
                >
                  {a.repo} · {a.targetPackage}
                </button>
              ))}
            </div>
          )}
          <div className="min-h-0 flex-1">
            <ApprovalGate approval={active} onDecide={decide} />
          </div>
        </div>
      </div>
    </div>
  );
}
