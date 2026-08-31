/**
 * Same-origin API client.
 *
 * Every path here is relative, so the browser only ever calls the origin the
 * page was served from and Next's rewrites (next.config.mjs) forward to
 * pool-monitor and the harness server-side. That removes CORS from the picture
 * entirely, and means the UI works unchanged on localhost, a WSL address, or
 * any other host.
 */
const POOL = '/api/pool';
const HARNESS_API = '/api/harness';

/**
 * The trace socket cannot go through a rewrite, so it is derived from the page
 * origin at call time rather than baked in at build time. Override with
 * NEXT_PUBLIC_HARNESS_WS when the harness is not on the page host.
 */
export function harnessWsUrl(): string {
  const configured = process.env.NEXT_PUBLIC_HARNESS_WS;
  if (configured) return configured;
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const port = process.env.NEXT_PUBLIC_HARNESS_WS_PORT || '3001';
  return `${proto}//${window.location.hostname}:${port}`;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${body ? `: ${body}` : ''}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  listRepositories: () => req<{ repositories: any[] }>(`${POOL}/repositories`),

  addRepository: (body: Record<string, unknown>) =>
    req<{ repository: any; scan?: any }>(`${POOL}/repositories`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteRepository: (id: number) =>
    req<void>(`${POOL}/repositories/${id}`, { method: 'DELETE' }),

  scanNow: (repo?: string) =>
    req<{ results: any[] }>(`${POOL}/watch/scan-now`, {
      method: 'POST',
      body: JSON.stringify(repo ? { repo } : {}),
    }),

  listTasks: () => req<{ tasks: any[] }>(`${POOL}/tasks`),

  listApprovals: () => req<{ approvals: any[] }>(`${HARNESS_API}/approvals`),

  decide: (taskId: string, action: 'APPROVE' | 'REJECT', reason?: string) =>
    req<{ accepted: boolean }>(`${HARNESS_API}/resume`, {
      method: 'POST',
      body: JSON.stringify({ taskId, action, reason, by: 'checkpoint-gateway' }),
    }),
};
