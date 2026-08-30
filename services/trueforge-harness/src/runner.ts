import { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { config } from './config.js';
import { trueforge, createSession } from './agent.js';
import { trace } from './trace.js';
import {
  savePending,
  clearPending,
  waitForDecision,
  type Decision,
} from './store.js';
import { collectDiffs, pathsFromPushCalls } from './diff.js';
import { buildKickoff } from './prompts.js';
import type { PatchTask, PendingApproval } from './types.js';

export type RunOutcome =
  | { status: 'COMPLETE'; sessionId: string; prUrl?: string }
  | { status: 'REJECTED'; sessionId: string; reason?: string }
  | { status: 'FAILED'; sessionId?: string; error: string };

interface RunState {
  pushArgs: Array<Record<string, unknown>>;
  lastTestOutput: string | null;
  prUrl?: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Tool call id -> {name, args}, spanning the whole run rather than one turn.
   * An approved call is issued in one turn and answered in the NEXT one (the
   * resume turn), so a per-turn map would fail to resolve exactly the response
   * that matters most: the pull request.
   */
  calls: Map<string, { name: string; args: Record<string, unknown> }>;
}

export async function runTask(task: PatchTask): Promise<RunOutcome> {
  trace.emit('task.received', task.task_id, {
    message: `${task.target_package} ${task.current_version} -> ${task.recommended_version} in ${task.owner}/${task.name}`,
    payload: task,
  });

  let sessionId: string | undefined;
  try {
    const session = await createSession(task, task.skill_name);
    sessionId = session.id;
    trace.emit('session.created', task.task_id, {
      sessionId,
      message: `session ${sessionId} created (skill: ${task.skill_name ?? 'none'})`,
    });

    const state: RunState = {
      pushArgs: [],
      lastTestOutput: null,
      inputTokens: 0,
      outputTokens: 0,
      calls: new Map(),
    };

    // First turn: the kickoff message.
    let input: TrueForgeApi.TurnInputItem[] = [
      { type: 'user.message', content: buildKickoff(task) },
    ];
    let previousTurnId: string | undefined;

    // Each approval decision starts a fresh turn that resumes the paused tool
    // call, so the run is a loop over turns rather than a single stream.
    for (let turnIndex = 0; turnIndex < 20; turnIndex++) {
      const pause = await streamTurn(task, sessionId, input, previousTurnId, state);

      if (!pause) {
        trace.emit('task.complete', task.task_id, {
          sessionId,
          message: state.prUrl ? `pull request opened: ${state.prUrl}` : 'run finished',
          payload: { prUrl: state.prUrl, usage: usageOf(state) },
        });
        return { status: 'COMPLETE', sessionId, prUrl: state.prUrl };
      }

      const decision = await handlePause(task, pause, state);

      if (decision.action === 'REJECT') {
        await clearPending(task.task_id);
        trace.emit('interceptor.resume', task.task_id, {
          sessionId,
          message: `rejected${decision.reason ? `: ${decision.reason}` : ''}`,
        });
        // Hand the denial back to the agent so it records the outcome and stops.
        await streamTurn(
          task,
          sessionId,
          [
            {
              type: 'user.tool_approval',
              threadId: pause.threadId,
              toolCallId: pause.toolCallId,
              approval: { status: 'deny', reason: decision.reason ?? 'Rejected by reviewer' },
            },
          ],
          pause.turnId,
          state,
        );
        return { status: 'REJECTED', sessionId, reason: decision.reason };
      }

      await clearPending(task.task_id);
      trace.emit('interceptor.resume', task.task_id, {
        sessionId,
        message: `approved by ${decision.by ?? 'reviewer'} — creating pull request`,
      });

      input = [
        {
          type: 'user.tool_approval',
          threadId: pause.threadId,
          toolCallId: pause.toolCallId,
          approval: { status: 'allow' },
        },
      ];
      previousTurnId = pause.turnId;
    }

    return { status: 'FAILED', sessionId, error: 'exceeded maximum approval rounds' };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    trace.emit('task.failed', task.task_id, { sessionId, message });
    return { status: 'FAILED', sessionId, error: message };
  }
}

interface Pause {
  turnId: string;
  threadId: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}

/**
 * Stream one turn, forwarding every event to the UI. Resolves with a Pause when
 * the run stops at the approval gate, or null when the turn completes.
 */
async function streamTurn(
  task: PatchTask,
  sessionId: string,
  input: TrueForgeApi.TurnInputItem[],
  previousTurnId: string | undefined,
  state: RunState,
): Promise<Pause | null> {
  const stream = await trueforge.sessions.createTurnStream(sessionId, {
    input,
    ...(previousTurnId ? { previousTurnId } : {}),
  });

  let turnId = previousTurnId ?? '';
  // Resolves approval and response events (which carry only ids) back to the
  // call that triggered them. Run-scoped — see RunState.calls.
  const pendingCalls = state.calls;

  for await (const event of stream) {
    switch (event.type) {
      case 'turn.created':
        // `id` is the event's own ULID; `turnId` is the turn being created, and
        // it is `turnId` that a later approval resume must chain from.
        turnId = event.turnId;
        break;

      case 'sandbox.created':
        trace.emit('sandbox.created', task.task_id, {
          sessionId,
          message: `sandbox ${event.sandboxId} provisioned`,
        });
        break;

      case 'model.message': {
        if (event.reasoningContent) {
          trace.emit('agent.reasoning', task.task_id, {
            sessionId,
            threadId: event.threadId,
            message: event.reasoningContent,
          });
        }
        const text = textOf(event.content);
        if (text) {
          trace.emit('agent.message', task.task_id, {
            sessionId,
            threadId: event.threadId,
            message: text,
          });
        }
        for (const call of event.toolCalls ?? []) {
          const args = safeParse(call.function.arguments);
          const name = call.toolInfo?.name ?? call.function.name;
          pendingCalls.set(call.id, { name, args });
          if (name === 'push_files') state.pushArgs.push(args);
          trace.emit('tool.call', task.task_id, {
            sessionId,
            threadId: event.threadId,
            message: `${name}(${summarizeArgs(args)})`,
            payload: { toolCallId: call.id, name, args },
          });
        }
        if (event.usage) {
          state.inputTokens += event.usage.inputTokens;
          state.outputTokens += event.usage.outputTokens;
          trace.emit('token.usage', task.task_id, {
            sessionId,
            threadId: event.threadId,
            message: `${state.inputTokens} in / ${state.outputTokens} out (compaction at ${config.compactionThresholdTokens})`,
            payload: usageOf(state),
          });
        }
        break;
      }

      case 'tool.response': {
        const call = pendingCalls.get(event.toolCallId);
        // Terminal output from the sandbox is what the reviewer wants to see.
        if (call && /bash|exec|shell|run/i.test(call.name)) {
          state.lastTestOutput = event.content;
        }
        if (call?.name === 'create_pull_request') {
          const parsed = safeParse(event.content);
          if (typeof parsed.url === 'string') state.prUrl = parsed.url;
        }
        trace.emit('tool.result', task.task_id, {
          sessionId,
          threadId: event.threadId,
          message: truncate(event.content, 4000),
          payload: { toolCallId: event.toolCallId, name: call?.name },
        });
        break;
      }

      case 'tool.approval_required': {
        const ref = event.toolCalls[0];
        if (!ref) break;
        const call = pendingCalls.get(ref.id);
        return {
          turnId,
          threadId: event.threadId,
          toolCallId: ref.id,
          toolName: call?.name ?? config.approvalGateTool,
          toolArgs: call?.args ?? {},
        };
      }

      case 'mcp.auth_required':
        trace.emit('task.failed', task.task_id, {
          sessionId,
          message: 'MCP server requires authorization — authorize it in the TrueForge UI',
          payload: event,
        });
        throw new Error('MCP authorization required');

      case 'turn.done': {
        if (event.state.status === 'error') {
          throw new Error(`turn ended in error: ${event.state.message}`);
        }
        if (event.state.status === 'cancelled') {
          throw new Error('turn was cancelled');
        }
        // A turn can terminate WITH work still pending: the approval request
        // then arrives inside `state.requiredActions` rather than as a
        // standalone tool.approval_required event. Missing this would let the
        // run report success while the pull request was never opened and no
        // human was ever asked — treat it as a pause, not a completion.
        const pendingApproval = (event.state.requiredActions ?? []).find(
          (a): a is TrueForgeApi.ToolApprovalRequiredEvent =>
            a.type === 'tool.approval_required',
        );
        if (pendingApproval) {
          const ref = pendingApproval.toolCalls[0];
          if (ref) {
            const call = pendingCalls.get(ref.id);
            return {
              turnId,
              threadId: pendingApproval.threadId,
              toolCallId: ref.id,
              toolName: call?.name ?? config.approvalGateTool,
              toolArgs: call?.args ?? {},
            };
          }
        }
        return null;
      }

      default:
        break;
    }
  }
  return null;
}

/** Persist the pause, publish it to the UI, and block until a human decides. */
async function handlePause(
  task: PatchTask,
  pause: Pause,
  state: RunState,
): Promise<Decision> {
  const args = pause.toolArgs;
  const head = String(args.head ?? `patchforge/${task.target_package}-${task.recommended_version}`);

  let diffs = [] as PendingApproval['diffs'];
  try {
    diffs = await collectDiffs(
      task.owner,
      task.name,
      task.branch,
      head,
      pathsFromPushCalls(state.pushArgs),
    );
  } catch (err: any) {
    // A diff we cannot render must not block the approval — the reviewer still
    // gets the PR body, the advisories, and the test log.
    console.warn(`[runner] diff collection failed: ${err?.message ?? err}`);
  }

  const pending: PendingApproval = {
    taskId: task.task_id,
    sessionId: '',
    turnId: pause.turnId,
    threadId: pause.threadId,
    toolCallId: pause.toolCallId,
    toolName: pause.toolName,
    toolArgs: args,
    repo: `${task.owner}/${task.name}`,
    targetPackage: task.target_package,
    fromVersion: task.current_version,
    toVersion: task.recommended_version,
    vulnerabilities: task.vulnerabilities,
    diffs,
    testLog: state.lastTestOutput,
    createdAt: new Date().toISOString(),
  };

  await savePending(pending);
  trace.emit('interceptor.pause', task.task_id, {
    threadId: pause.threadId,
    message: `paused at ${pause.toolName} — awaiting human approval`,
    payload: pending,
  });

  await reportStatus(task.task_id, 'AWAITING_APPROVAL');
  return waitForDecision(task.task_id);
}

export async function reportStatus(taskId: string, status: string) {
  try {
    await fetch(`${config.poolMonitorUrl}/api/v1/tasks/${taskId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err: any) {
    console.warn(`[runner] status report failed for ${taskId}: ${err?.message ?? err}`);
  }
}

function usageOf(state: RunState) {
  return { inputTokens: state.inputTokens, outputTokens: state.outputTokens };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p === 'string' ? p : p?.text ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function safeParse(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return (raw as Record<string, unknown>) ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${truncate(typeof v === 'string' ? v : JSON.stringify(v), 60)}`)
    .join(', ');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}… [${s.length - n} more chars]` : s;
}
