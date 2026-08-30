import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.postgresUrl });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repositories (
  id           SERIAL PRIMARY KEY,
  repo_url     TEXT NOT NULL UNIQUE,
  owner        TEXT NOT NULL,
  name         TEXT NOT NULL,
  branch       TEXT NOT NULL DEFAULT 'main',
  manifest_path TEXT NOT NULL DEFAULT 'requirements.txt',
  ecosystem    TEXT NOT NULL DEFAULT 'PyPI',
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_scanned_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS scans (
  id            SERIAL PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status        TEXT NOT NULL,
  packages_scanned INTEGER NOT NULL DEFAULT 0,
  vulnerable_count INTEGER NOT NULL DEFAULT 0,
  detail        JSONB,
  error         TEXT
);

CREATE TABLE IF NOT EXISTS dispatched_tasks (
  id            SERIAL PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  task_id       TEXT NOT NULL UNIQUE,
  package       TEXT NOT NULL,
  from_version  TEXT NOT NULL,
  to_version    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'QUEUED',
  dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_repo ON dispatched_tasks(repository_id);
`;

export async function migrate() {
  await pool.query(SCHEMA);
}

/**
 * A package is re-dispatched only if we have not already queued the exact same
 * upgrade for it, so a 6-hourly sweep does not open duplicate pull requests.
 */
export async function alreadyDispatched(repositoryId, pkg, toVersion) {
  const { rows } = await pool.query(
    `SELECT 1 FROM dispatched_tasks
      WHERE repository_id = $1 AND package = $2 AND to_version = $3
        AND status NOT IN ('REJECTED', 'FAILED')
      LIMIT 1`,
    [repositoryId, pkg, toVersion],
  );
  return rows.length > 0;
}
