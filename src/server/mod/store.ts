import { redis } from '@devvit/web/server';
import type { QueueItem, RuleConfig } from '../../shared/mod';

const defaultRules: RuleConfig = {
  autoApproveThreshold: 0.1,
  autoRemoveThreshold: 0.9,
  regexRules: ['free\\s+money', 'guaranteed\\s+profit', 'buy\\s+followers'],
};

const queueKey = (subredditId: string) => `queue:${subredditId}`;
const scoreKey = (subredditId: string, itemId: string) => `score:${subredditId}:${itemId}`;
const claimKey = (subredditId: string, itemId: string) => `claim:${subredditId}:${itemId}`;
const auditKey = (subredditId: string) => `audit:${subredditId}`;
const rulesKey = (subredditId: string) => `rules:${subredditId}`;
const priorFlagsKey = (subredditId: string, authorId: string) => `prior_flags:${subredditId}:${authorId}`;

const readQueueIds = async (subredditId: string): Promise<string[]> => {
  const raw = await redis.get(queueKey(subredditId));
  if (!raw) {
    return [];
  }

  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
};

const writeQueueIds = async (subredditId: string, ids: string[]): Promise<void> => {
  await redis.set(queueKey(subredditId), JSON.stringify(ids));
};

export const getRules = async (subredditId: string): Promise<RuleConfig> => {
  const stored = await redis.get(rulesKey(subredditId));
  if (!stored) {
    await redis.set(rulesKey(subredditId), JSON.stringify(defaultRules));
    return defaultRules;
  }

  try {
    return JSON.parse(stored) as RuleConfig;
  } catch {
    return defaultRules;
  }
};

export const putQueueItem = async (item: QueueItem): Promise<void> => {
  const existingIds = await readQueueIds(item.subredditId);
  const filtered = existingIds.filter((id) => id !== item.itemId);
  const scoreMap = new Map<string, number>();

  for (const id of filtered) {
    const raw = await redis.get(scoreKey(item.subredditId, id));
    if (raw) {
      const parsed = JSON.parse(raw) as QueueItem;
      scoreMap.set(id, parsed.riskScore);
    }
  }

  scoreMap.set(item.itemId, item.riskScore);

  const sortedIds = [...scoreMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  await Promise.all([
    redis.set(scoreKey(item.subredditId, item.itemId), JSON.stringify(item)),
    writeQueueIds(item.subredditId, sortedIds),
  ]);
};

export const getQueueItems = async (
  subredditId: string,
  limit: number
): Promise<QueueItem[]> => {
  const ids = (await readQueueIds(subredditId)).slice(0, limit);
  const rawItems = await Promise.all(ids.map((id) => redis.get(scoreKey(subredditId, id))));

  return rawItems
    .filter((raw): raw is string => Boolean(raw))
    .map((raw) => JSON.parse(raw) as QueueItem);
};

export const getQueueLength = async (subredditId: string): Promise<number> => {
  return (await readQueueIds(subredditId)).length;
};

export const claimItem = async (
  subredditId: string,
  itemId: string,
  modId: string
): Promise<boolean> => {
  const key = claimKey(subredditId, itemId);
  const existing = await redis.get(key);
  if (existing && existing !== modId) {
    return false;
  }

  await redis.set(key, modId, { expiration: new Date(Date.now() + 30 * 60 * 1000) });
  return true;
};

export const logAudit = async (
  subredditId: string,
  event: Record<string, string>
): Promise<void> => {
  const key = auditKey(subredditId);
  const raw = await redis.get(key);
  const events = raw ? ((JSON.parse(raw) as Record<string, string>[]) ?? []) : [];
  events.unshift(event);
  await redis.set(key, JSON.stringify(events.slice(0, 500)));
};

export const readItem = async (
  subredditId: string,
  itemId: string
): Promise<QueueItem | null> => {
  const raw = await redis.get(scoreKey(subredditId, itemId));
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as QueueItem;
};

export const removeFromQueue = async (subredditId: string, itemId: string): Promise<void> => {
  const ids = await readQueueIds(subredditId);
  await writeQueueIds(
    subredditId,
    ids.filter((id) => id !== itemId)
  );
};

export const setItem = async (item: QueueItem): Promise<void> => {
  await redis.set(scoreKey(item.subredditId, item.itemId), JSON.stringify(item));
};

export const incrementPriorFlags = async (
  subredditId: string,
  authorId: string
): Promise<number> => {
  return redis.incrBy(priorFlagsKey(subredditId, authorId), 1);
};

export const getPriorFlags = async (
  subredditId: string,
  authorId: string
): Promise<number> => {
  const value = await redis.get(priorFlagsKey(subredditId, authorId));
  return value ? Number.parseInt(value, 10) : 0;
};
