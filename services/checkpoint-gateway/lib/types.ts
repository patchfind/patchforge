export interface TraceEvent {
  type:
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
  taskId: string;
  sessionId?: string;
  threadId?: string | null;
  timestamp: string;
  message?: string;
  payload?: any;
}

export interface FileDiff {
  path: string;
  original: string;
  modified: string;
}

export interface Vulnerability {
  id: string;
  summary: string;
  severity?: string | null;
  cvss_score?: number | null;
}

export interface PendingApproval {
  taskId: string;
  turnId: string;
  threadId: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, any>;
  repo: string;
  targetPackage: string;
  fromVersion: string;
  toVersion: string;
  vulnerabilities: Vulnerability[];
  diffs: FileDiff[];
  testLog: string | null;
  createdAt: string;
}

export interface Repository {
  id: number;
  repo_url: string;
  owner: string;
  name: string;
  branch: string;
  manifest_path: string;
  ecosystem: string;
  enabled: boolean;
  last_scanned_at: string | null;
}
