import { config } from './config.js';

const GITHUB_API = 'https://api.github.com';

/**
 * Read a manifest from GitHub.
 *
 * Uses the REST contents API rather than an MCP tool: fetching a file is a
 * plain HTTP GET, and routing it through an agent tool server bought nothing
 * but another service to run and debug. Anonymous works for public repos;
 * GITHUB_TOKEN (when set) lifts the rate limit and reaches private ones.
 *
 * Writes are different — branches and pull requests go through the GitHub MCP
 * connector configured in TrueForge, so the agent's actions stay governed by
 * the approval gate.
 */
export async function fetchManifest({ owner, name, branch, manifestPath }) {
  const url = `${GITHUB_API}/repos/${owner}/${name}/contents/${manifestPath}?ref=${encodeURIComponent(branch)}`;
  const headers = {
    Accept: 'application/vnd.github.raw+json',
    'User-Agent': 'patchforge-pool-monitor',
  };
  if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });

  if (res.status === 404) {
    throw new Error(
      `${manifestPath} not found on ${owner}/${name}@${branch} — check manifest_path and branch`,
    );
  }
  if (res.status === 403 || res.status === 429) {
    throw new Error(
      config.githubToken
        ? `GitHub rate limit or insufficient scope for ${owner}/${name}`
        : `GitHub rate limit hit; set GITHUB_TOKEN in .env to raise it`,
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub returned ${res.status} for ${owner}/${name}/${manifestPath}`);
  }
  return await res.text();
}

export async function scanDependencies(deps, ecosystem) {
  const res = await fetch(`${config.advisoryUrl}/api/v1/scan-dependencies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dependencies: deps, ecosystem }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    throw new Error(`advisory-service returned ${res.status}: ${await res.text()}`);
  }
  return await res.json();
}
