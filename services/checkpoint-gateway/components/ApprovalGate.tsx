'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import type { PendingApproval } from '@/lib/types';

// Monaco touches `window` at import time, so it must never render on the server.
const DiffEditor = dynamic(
  () => import('@monaco-editor/react').then((m) => m.DiffEditor),
  {
    ssr: false,
    loading: () => <div className="p-4 text-xs text-slate-500">Loading diff editor…</div>,
  },
);

function languageFor(path: string): string {
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  if (path.endsWith('.js') || path.endsWith('.jsx')) return 'javascript';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.yml') || path.endsWith('.yaml')) return 'yaml';
  if (path.endsWith('.md')) return 'markdown';
  return 'plaintext';
}

export function ApprovalGate({
  approval,
  onDecide,
}: {
  approval: PendingApproval | null;
  onDecide: (taskId: string, action: 'APPROVE' | 'REJECT', reason?: string) => Promise<void>;
}) {
  const [activeFile, setActiveFile] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  // A new pause is a different change set — reset the per-approval view state.
  useEffect(() => {
    setActiveFile(0);
    setRejecting(false);
    setReason('');
    setError(null);
  }, [approval?.taskId]);

  if (!approval) {
    return (
      <section className="flex h-full items-center justify-center rounded-xl border border-slate-800 bg-slate-900/60">
        <div className="text-center">
          <h2 className="text-sm font-semibold text-amber-400">Human Checkpoint Gate</h2>
          <p className="mt-2 text-xs text-slate-500">
            No session is awaiting approval. The agent pauses here before opening a pull request.
          </p>
        </div>
      </section>
    );
  }

  const decide = async (action: 'APPROVE' | 'REJECT') => {
    setBusy(true);
    setError(null);
    try {
      await onDecide(approval.taskId, action, action === 'REJECT' ? reason : undefined);
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const diff = approval.diffs[activeFile];
  const prTitle = String(approval.toolArgs?.title ?? '(no title)');
  const prBody = String(approval.toolArgs?.body ?? '');

  return (
    <section className="flex h-full flex-col rounded-xl border border-amber-700/50 bg-slate-900/60">
      <header className="border-b border-slate-800 px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-amber-400">Human Checkpoint Gate</h2>
          <code className="rounded bg-slate-950 px-2 py-0.5 text-[11px] text-rose-400">
            paused at github-mcp:{approval.toolName}
          </code>
        </div>
        <p className="mt-1.5 text-xs text-slate-400">
          <strong className="text-slate-200">{approval.repo}</strong> · {approval.targetPackage}{' '}
          <span className="text-rose-400">{approval.fromVersion}</span> →{' '}
          <span className="text-emerald-400">{approval.toVersion}</span>
        </p>
        {approval.vulnerabilities.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {approval.vulnerabilities.map((v) => (
              <span
                key={v.id}
                title={v.summary}
                className="rounded border border-rose-900/60 bg-rose-950/40 px-1.5 py-0.5 font-mono text-[10px] text-rose-300"
              >
                {v.id}
              </span>
            ))}
          </div>
        )}
      </header>

      <div className="border-b border-slate-800 px-4 py-2">
        <p className="text-xs font-semibold text-slate-300">{prTitle}</p>
        {prBody && (
          <details className="mt-1">
            <summary className="cursor-pointer text-[11px] text-slate-500">PR description</summary>
            <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-slate-950 p-2 text-[11px] text-slate-400">
              {prBody}
            </pre>
          </details>
        )}
      </div>

      {approval.diffs.length > 0 ? (
        <>
          <div className="flex gap-1 overflow-x-auto border-b border-slate-800 px-3 py-2">
            {approval.diffs.map((d, i) => (
              <button
                key={d.path}
                onClick={() => setActiveFile(i)}
                className={`whitespace-nowrap rounded px-2.5 py-1 font-mono text-[11px] ${
                  i === activeFile
                    ? 'bg-slate-800 text-amber-300'
                    : 'text-slate-500 hover:bg-slate-800/50'
                }`}
              >
                {d.path}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            {diff && (
              <DiffEditor
                key={diff.path}
                original={diff.original}
                modified={diff.modified}
                language={languageFor(diff.path)}
                theme="vs-dark"
                height="100%"
                options={{
                  renderSideBySide: true,
                  readOnly: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  scrollBeyondLastLine: false,
                }}
              />
            )}
          </div>
        </>
      ) : (
        <div className="flex-1 p-4 text-xs text-slate-500">
          No file diff could be reconstructed for this change. Review the PR description and the
          test log before approving.
        </div>
      )}

      {approval.testLog && (
        <details className="border-t border-slate-800 px-4 py-2">
          <summary className="cursor-pointer text-[11px] text-emerald-400">
            Sandbox test output
          </summary>
          <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-slate-950 p-2 font-mono text-[10px] text-slate-400">
            {approval.testLog}
          </pre>
        </details>
      )}

      <footer className="border-t border-slate-800 px-4 py-3">
        {error && <p className="mb-2 text-xs text-rose-400">{error}</p>}
        {rejecting && (
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason shown to the agent (optional)"
            className="mb-2 w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs outline-none focus:border-slate-500"
          />
        )}
        <div className="flex justify-end gap-2">
          {rejecting ? (
            <>
              <button
                onClick={() => setRejecting(false)}
                disabled={busy}
                className="rounded-lg px-4 py-2 text-xs text-slate-400 hover:text-slate-200"
              >
                Cancel
              </button>
              <button
                onClick={() => decide('REJECT')}
                disabled={busy}
                className="rounded-lg bg-rose-700 px-4 py-2 text-xs font-semibold hover:bg-rose-600 disabled:opacity-50"
              >
                {busy ? 'Rejecting…' : 'Confirm rejection'}
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setRejecting(true)}
                disabled={busy}
                className="rounded-lg border border-slate-700 px-4 py-2 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              >
                Reject
              </button>
              <button
                onClick={() => decide('APPROVE')}
                disabled={busy}
                className="rounded-lg bg-emerald-600 px-5 py-2 text-xs font-semibold hover:bg-emerald-500 disabled:bg-slate-800"
              >
                {busy ? 'Approving…' : 'Approve & Create Pull Request'}
              </button>
            </>
          )}
        </div>
      </footer>
    </section>
  );
}
