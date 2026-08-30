import { Redis } from 'ioredis';
import { config } from './config.js';
import type { PendingApproval } from './types.js';

const KEY_PREFIX = 'patchforge:interceptor:';
const INDEX_KEY = 'patchforge:interceptor:index';

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

export async function connectRedis() {
  await redis.connect();
  console.log('[store] redis connected');
}

const key = (taskId: string) => `${KEY_PREFIX}${taskId}`;

/**
 * Pending approvals live in Redis rather than in process memory so a harness
 * restart mid-pause resumes from disk instead of stranding the session.
 */
export async function savePending(pending: PendingApproval) {
  await redis
    .multi()
    .set(key(pending.taskId), JSON.stringify(pending), 'EX', config.approvalTtlSeconds)
    .sadd(INDEX_KEY, pending.taskId)
    .exec();
}

export async function getPending(taskId: string): Promise<PendingApproval | null> {
  const raw = await redis.get(key(taskId));
  return raw ? (JSON.parse(raw) as PendingApproval) : null;
}

export async function clearPending(taskId: string) {
  await redis.multi().del(key(taskId)).srem(INDEX_KEY, taskId).exec();
}

export async function listPending(): Promise<PendingApproval[]> {
  const ids = await redis.smembers(INDEX_KEY);
  if (!ids.length) return [];

  const raws = await redis.mget(ids.map(key));
  const alive: PendingApproval[] = [];
  const expired: string[] = [];

  ids.forEach((id: string, i: number) => {
    const raw = raws[i];
    // The index is a set; TTL expiry on the value leaves a dangling member.
    if (raw) alive.push(JSON.parse(raw));
    else expired.push(id);
  });

  if (expired.length) await redis.srem(INDEX_KEY, ...expired);
  return alive;
}

/**
 * Resolver registry for in-flight pauses. A pause that survives a restart has
 * no waiting promise, so the approval endpoint falls back to replaying the
 * decision straight to the TrueForge session.
 */
const waiters = new Map<string, (decision: Decision) => void>();

export interface Decision {
  action: 'APPROVE' | 'REJECT';
  reason?: string;
  by?: string;
}

export function waitForDecision(taskId: string): Promise<Decision> {
  return new Promise((resolve) => waiters.set(taskId, resolve));
}

export function settle(taskId: string, decision: Decision): boolean {
  const resolve = waiters.get(taskId);
  if (!resolve) return false;
  waiters.delete(taskId);
  resolve(decision);
  return true;
}

export function hasWaiter(taskId: string) {
  return waiters.has(taskId);
}
