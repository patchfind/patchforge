import express from 'express';
import { config } from './config.js';
import { trace } from './trace.js';
import {
  connectRedis,
  listPending,
  getPending,
  settle,
  hasWaiter,
  clearPending,
  redis,
} from './store.js';
import { listConfiguredSkillNames, preflight, registerSavedAgent } from './agent.js';
import { startWorker, stopWorker } from './worker.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// Browser calls this directly from the checkpoint UI.
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  next();
});
app.options('*', (_req, res) => res.sendStatus(204));

app.get('/healthz', async (_req, res) => {
  let store = 'down';
  try {
    await redis.ping();
    store = 'ok';
  } catch { /* reported as down */ }
  res.status(store === 'ok' ? 200 : 503).json({ status: store === 'ok' ? 'ok' : 'degraded', redis: store });
});

/** Everything currently parked at the approval gate. */
app.get('/api/v1/approvals', async (_req, res) => {
  res.json({ approvals: await listPending() });
});

app.get('/api/v1/approvals/:taskId', async (req, res) => {
  const pending = await getPending(req.params.taskId);
  if (!pending) return res.status(404).json({ error: 'no pending approval for that task' });
  res.json(pending);
});

app.get('/api/v1/trace/:taskId', (req, res) => {
  res.json({ events: trace.history(req.params.taskId) });
});

/**
 * Approve or reject a paused session. `sessionId` is accepted as an alias for
 * `taskId` for compatibility with the contract in steps.md.
 */
app.post('/api/v1/resume', async (req, res) => {
  const { taskId, sessionId, action, reason, by } = req.body ?? {};
  const id = taskId ?? sessionId;

  if (!id) return res.status(400).json({ error: 'taskId is required' });
  if (action !== 'APPROVE' && action !== 'REJECT') {
    return res.status(400).json({ error: "action must be 'APPROVE' or 'REJECT'" });
  }

  const pending = await getPending(id);
  if (!pending) return res.status(404).json({ error: 'no pending approval for that task' });

  if (!hasWaiter(id)) {
    // The pause outlived the process that created it. The turn is still parked
    // server-side in TrueForge, but this instance has no promise to resolve —
    // surface that rather than silently dropping the decision.
    return res.status(409).json({
      error:
        'this approval was created by a previous harness instance and cannot be resumed in-process',
      taskId: id,
      hint: 'restart the task, or resume the session directly against the TrueForge API',
    });
  }

  settle(id, { action, reason, by });
  res.json({ taskId: id, action, accepted: true });
});

/** Abandon a pause without resuming the agent. */
app.delete('/api/v1/approvals/:taskId', async (req, res) => {
  settle(req.params.taskId, { action: 'REJECT', reason: 'discarded by operator' });
  await clearPending(req.params.taskId);
  res.status(204).end();
});

async function main() {
  await connectRedis();
  trace.start();

  const check = await preflight();
  if (!check.ok) {
    console.warn('[preflight] control-plane problems detected:');
    for (const p of check.problems) console.warn(`  - ${p}`);
    if (process.env.STRICT_PREFLIGHT === 'true') {
      throw new Error('preflight failed and STRICT_PREFLIGHT is set');
    }
    console.warn('[preflight] continuing anyway; agent runs will likely fail');
  } else {
    console.log('[preflight] control-plane assets verified');
  }

  // Publish the reusable agent (guide step 7 / "Save Agent" in the UI) so the
  // same orchestrator is startable from TrueForge chat, not only from this
  // worker. Best-effort: a failure here must not stop patching, which does not
  // depend on the saved agent unless TRUEFORGE_AGENT_NAME is set.
  if (config.registerAgentOnBoot) {
    try {
      const skills = await listConfiguredSkillNames();
      const { created, id } = await registerSavedAgent(config.savedAgentDefinitionName, skills);
      console.log(
        `[agent] ${created ? 'created' : 'updated'} reusable agent ` +
          `"${config.savedAgentDefinitionName}" (${id}) with ${skills.length} skill(s)`,
      );
    } catch (err) {
      console.warn(
        '[agent] could not register the reusable agent:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  const orphans = await listPending();
  if (orphans.length) {
    console.warn(
      `[boot] ${orphans.length} approval(s) survived a restart and need re-dispatch: ${orphans
        .map((o) => o.taskId)
        .join(', ')}`,
    );
  }

  await startWorker();

  const server = app.listen(config.httpPort, () =>
    console.log(`[harness] http on :${config.httpPort}, trace ws on :${config.wsPort}`),
  );

  const shutdown = async () => {
    server.close();
    trace.close();
    await stopWorker();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[harness] fatal', err);
  process.exit(1);
});
