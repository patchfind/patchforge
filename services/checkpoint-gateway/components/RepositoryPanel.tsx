'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Repository } from '@/lib/types';

export function RepositoryPanel({ onActivity }: { onActivity: () => void }) {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [manifest, setManifest] = useState('requirements.txt');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setRepos((await api.listRepositories()).repositories);
      setError(null);
    } catch (err: any) {
      setError(`pool-monitor unreachable: ${err?.message ?? err}`);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.addRepository({
        repo_url: repoUrl,
        branch,
        manifest_path: manifest,
        ecosystem: manifest.endsWith('package.json') ? 'npm' : 'PyPI',
      });
      const scan = res.scan;
      setNotice(
        scan?.status === 'QUEUED_FOR_PATCHING'
          ? `${scan.dispatched.length} patching task(s) queued`
          : scan?.status === 'ERROR'
            ? `Registered, but the first scan failed: ${scan.error}`
            : `Registered. ${scan?.status ?? 'No scan run'}`,
      );
      setRepoUrl('');
      await refresh();
      onActivity();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const scan = async (repo: Repository) => {
    setBusy(true);
    setNotice(null);
    try {
      const { results } = await api.scanNow(repo.repo_url);
      const r = results[0];
      setNotice(
        r?.status === 'QUEUED_FOR_PATCHING'
          ? `${repo.name}: ${r.dispatched.length} task(s) queued`
          : `${repo.name}: ${r?.status ?? 'no result'}`,
      );
      await refresh();
      onActivity();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (repo: Repository) => {
    await api.deleteRepository(repo.id);
    await refresh();
  };

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60">
      <header className="border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold text-sky-400">Monitored Repositories</h2>
      </header>

      <form onSubmit={add} className="flex flex-wrap gap-2 border-b border-slate-800 p-3">
        <input
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          required
          placeholder="https://github.com/owner/repo"
          className="min-w-[240px] flex-1 rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs outline-none focus:border-sky-600"
        />
        <input
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="branch"
          className="w-24 rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs outline-none focus:border-sky-600"
        />
        <input
          value={manifest}
          onChange={(e) => setManifest(e.target.value)}
          placeholder="requirements.txt"
          className="w-40 rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs outline-none focus:border-sky-600"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-sky-600 px-4 py-1.5 text-xs font-semibold hover:bg-sky-500 disabled:opacity-50"
        >
          {busy ? 'Scanning…' : 'Add & scan'}
        </button>
      </form>

      {(error || notice) && (
        <p className={`px-4 py-2 text-xs ${error ? 'text-rose-400' : 'text-emerald-400'}`}>
          {error ?? notice}
        </p>
      )}

      <ul className="divide-y divide-slate-800">
        {repos.length === 0 && (
          <li className="px-4 py-3 text-xs text-slate-600">No repositories registered.</li>
        )}
        {repos.map((r) => (
          <li key={r.id} className="flex items-center justify-between px-4 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-xs text-slate-200">
                {r.owner}/{r.name}
                <span className="ml-2 text-slate-500">
                  {r.branch} · {r.manifest_path}
                </span>
              </p>
              <p className="text-[11px] text-slate-600">
                {r.last_scanned_at
                  ? `last scanned ${new Date(r.last_scanned_at).toLocaleString()}`
                  : 'never scanned'}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                onClick={() => scan(r)}
                disabled={busy}
                className="rounded border border-slate-700 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
              >
                Scan now
              </button>
              <button
                onClick={() => remove(r)}
                className="rounded px-2 py-1 text-[11px] text-slate-500 hover:text-rose-400"
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
