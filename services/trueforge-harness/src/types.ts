export interface Vulnerability {
  id: string;
  aliases?: string[];
  summary: string;
  severity?: string | null;
  cvss_score?: number | null;
  fixed_versions?: string[];
}

/** Message shape published by pool-monitor on `tasks.patching`. */
export interface PatchTask {
  task_id: string;
  repository_id: number;
  repo_url: string;
  owner: string;
  name: string;
  branch: string;
  manifest_path: string;
  ecosystem: string;
  target_package: string;
  current_version: string;
  recommended_version: string;
  breaking_upgrade: boolean;
  vulnerabilities: Vulnerability[];
  skill_name: string | null;
  dispatched_at: string;
}

export type TraceEventType =
  | 'task.received'
  | 'session.created'
  | 'sandbox.created'
  | 'agent.message'
  | 'agent.reasoning'
  | 'tool.call'
  | 'tool.result'
  | 'token.usage'
  | 'interceptor.pause'
  | 'interceptor.resume'
  | 'task.complete'
  | 'task.failed';

/** Envelope streamed to checkpoint-gateway over the WebSocket. */
export interface TraceEvent {
  type: TraceEventType;
  taskId: string;
  sessionId?: string;
  threadId?: string | null;
  timestamp: string;
  message?: string;
  payload?: unknown;
}

/** State persisted in Redis while a session waits at the approval gate. */
export interface PendingApproval {
  taskId: string;
  sessionId: string;
  turnId: string;
  threadId: string;
  toolCallId: string;
  toolName: string;
  /** Arguments the agent wants to pass to create_pull_request. */
  toolArgs: Record<string, unknown>;
  repo: string;
  targetPackage: string;
  fromVersion: string;
  toVersion: string;
  vulnerabilities: Vulnerability[];
  /** Populated from the branch diff so the UI can render Monaco side-by-side. */
  diffs: FileDiff[];
  testLog: string | null;
  createdAt: string;
}

export interface FileDiff {
  path: string;
  original: string;
  modified: string;
}
