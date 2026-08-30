import { config } from './config.js';
import type { FileDiff } from './types.js';

const GITHUB_API = 'https://api.github.com';

/**
 * Read one file from GitHub at a given ref.
 *
 * Straight REST rather than an MCP tool call: this is a read for the diff view,
 * not an agent action, so it needs no tool server and no approval gate. Returns
 * null for 404 so a file that exists only on the head branch renders as a new
 * file with an empty original.
 */
async function fileAtRef(
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.raw+json',
    'User-Agent': 'patchforge-harness',
  };
  if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;

  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    { headers, signal: AbortSignal.timeout(20000) },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${owner}/${repo}/${path}@${ref}`);
  return await res.text();
}

/**
 * Reconstruct before/after contents for the Monaco side-by-side view.
 *
 * The agent's own tool arguments say which branch it pushed, but not which
 * files it touched, so the pair is fetched per path: base branch = original,
 * head branch = modified. A path missing from the base is a new file and its
 * original renders as empty.
 */
export async function collectDiffs(
  owner: string,
  repo: string,
  base: string,
  head: string,
  paths: string[],
): Promise<FileDiff[]> {
  const diffs: FileDiff[] = [];

  for (const path of paths) {
    const [original, modified] = await Promise.all([
      // Missing on base means the agent created it; show an empty original.
      fileAtRef(owner, repo, path, base).then((c) => c ?? '').catch(() => ''),
      fileAtRef(owner, repo, path, head).catch(() => null),
    ]);

    // Absent on head means the agent deleted it — nothing to show side by side.
    if (modified === null) continue;
    if (original === modified) continue;

    diffs.push({ path, original, modified });
  }
  return diffs;
}

/** Best-effort: the set of files the agent pushed, harvested from its tool calls. */
export function pathsFromPushCalls(pushArgs: Array<Record<string, unknown>>): string[] {
  const paths = new Set<string>();
  for (const args of pushArgs) {
    const files = args.files as Array<{ path?: string }> | undefined;
    for (const f of files ?? []) if (f.path) paths.add(f.path);
  }
  return [...paths];
}

export { config };
