import express from 'express';
import cron from 'node-cron';
import { config } from './config.js';
import { pool, migrate } from './db.js';
import { initQueue, queueReady, closeQueue } from './queue.js';
import { parseRepoUrl } from './manifest.js';
import { scanRepository, scanAllEnabled } from './scanner.js';

const app = express();
app.use(express.json());

// The checkpoint UI runs on a different origin (:3002) and calls this service
// directly, so without these headers the browser blocks every request.
// Mirrors the harness; override the origin with CORS_ORIGIN in production.
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  next();
});
app.options('*', (_req, res) => res.sendStatus(204));

// Opening the service in a browser should say what it is, not 404.
app.get('/', (_req, res) => {
  res.json({
    service: 'pool-monitor',
    role: 'Repository registry and scan scheduler. Publishes patch tasks to RabbitMQ.',
    endpoints: {
      'GET  /healthz': 'liveness plus Postgres and AMQP status',
      'GET  /api/v1/repositories': 'list watched repositories',
      'POST /api/v1/repositories': 'watch a repository: {repo_url}',
      'POST /api/v1/watch/scan-now': 'scan immediately: {repo_url?}',
    },
  });
});

app.get('/healthz', async (_req, res) => {
  let db = 'down';
  try {
    await pool.query('SELECT 1');
    db = 'ok';
  } catch { /* reported as down */ }
  const ok = db === 'ok' && queueReady();
  res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', db, amqp: queueReady() ? 'ok' : 'down' });
});

app.get('/api/v1/repositories', async (_req, res) => {
  const { rows } = await pool.query(`SELECT * FROM repositories ORDER BY created_at DESC`);
  res.json({ repositories: rows });
});

app.post('/api/v1/repositories', async (req, res) => {
  const {
    repo_url,
    branch = 'main',
    manifest_path = 'requirements.txt',
    ecosystem = 'PyPI',
    scan_now = true,
  } = req.body || {};

  if (!repo_url) return res.status(400).json({ error: 'repo_url is required' });

  let owner, name;
  try {
    ({ owner, name } = parseRepoUrl(repo_url));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const { rows } = await pool.query(
    `INSERT INTO repositories (repo_url, owner, name, branch, manifest_path, ecosystem)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (repo_url) DO UPDATE
       SET branch = EXCLUDED.branch,
           manifest_path = EXCLUDED.manifest_path,
           ecosystem = EXCLUDED.ecosystem,
           enabled = TRUE
     RETURNING *`,
    [repo_url, owner, name, branch, manifest_path, ecosystem],
  );
  const repo = rows[0];

  if (!scan_now) return res.status(201).json({ repository: repo });

  try {
    const result = await scanRepository(repo);
    res.status(201).json({ repository: repo, scan: result });
  } catch (err) {
    // Registration succeeded even though the first scan did not.
    res.status(201).json({ repository: repo, scan: { status: 'ERROR', error: err.message } });
  }
});

app.delete('/api/v1/repositories/:id', async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM repositories WHERE id = $1`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

app.post('/api/v1/watch/scan-now', async (req, res) => {
  const { repo } = req.body || {};

  if (!repo) {
    // Sweep everything.
    return res.json({ results: await scanAllEnabled() });
  }

  const { rows } = await pool.query(
    `SELECT * FROM repositories WHERE repo_url = $1 OR (owner || '/' || name) = $1`,
    [repo],
  );
  if (!rows.length) return res.status(404).json({ error: `repository ${repo} is not registered` });

  try {
    res.json({ results: [await scanRepository(rows[0])] });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/v1/tasks', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT t.*, r.repo_url FROM dispatched_tasks t
       JOIN repositories r ON r.id = t.repository_id
      ORDER BY t.dispatched_at DESC LIMIT 200`,
  );
  res.json({ tasks: rows });
});

/** Terminal status callback from trueforge-harness. */
app.post('/api/v1/tasks/:taskId/status', async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'COMPLETE', 'REJECTED', 'FAILED'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
  }
  const { rowCount } = await pool.query(
    `UPDATE dispatched_tasks SET status = $2 WHERE task_id = $1`,
    [req.params.taskId, status],
  );
  if (!rowCount) return res.status(404).json({ error: 'unknown task' });
  res.json({ task_id: req.params.taskId, status });
});

async function main() {
  await migrate();
  await initQueue();

  cron.schedule(config.scanCron, () => {
    console.log('[cron] starting scheduled sweep');
    scanAllEnabled().catch((err) => console.error('[cron] sweep failed', err));
  });

  const server = app.listen(config.port, () =>
    console.log(`[pool-monitor] listening on :${config.port}, cron "${config.scanCron}"`),
  );

  if (config.scanOnBoot) {
    scanAllEnabled().catch((err) => console.error('[boot] sweep failed', err.message));
  }

  const shutdown = async () => {
    server.close();
    await closeQueue();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[pool-monitor] fatal', err);
  process.exit(1);
});
