import { redis } from '@devvit/web/server';
import type { AuditEntry, BannedSignal, BannedUserRecord, BannedUserSignal, ModerationRules, QueueItem, ReportMeta, ScoreRecord, SummaryStats } from '../../shared/mod';

const scoreKey = (subredditId: string, postId: string) => `score:${subredditId}:${postId}`;
const queueKey = (subredditId: string) => `queue:${subredditId}`;
const reportMetaKey = (subredditId: string, postId: string) => `report_meta:${subredditId}:${postId}`;
const reportCountKey = (subredditId: string, postId: string) => `reports:${subredditId}:${postId}`;
const reportedPostsKey = (subredditId: string) => `reported_posts:${subredditId}`;
const auditKey = (subredditId: string) => `audit:${subredditId}`;
const statsKey = (subredditId: string, metric: string) => `stats:${subredditId}:${metric}`;
const rulesKey = (subredditId: string) => `rules:${subredditId}`;
const siqPostsKey = (subredditId: string) => `siq_posts:${subredditId}`;

const parseNumber = (value: string | undefined, fallback = 0): number => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const requiredString = (value: string | undefined, fallback = ''): string => value ?? fallback;

const parseJsonList = <T>(raw: string | null): T[] => {
  if (!raw) {
    return [];
  }
  try {
    return JSON.parse(raw) as T[];
  } catch {
    return [];
  }
};

const writeJsonList = async <T>(key: string, items: T[]): Promise<void> => {
  await redis.set(key, JSON.stringify(items));
};

const defaultRules: ModerationRules = {
  autoApproveThreshold: 0.15,
  autoRemoveThreshold: 0.85,
  banEvasionThreshold: 0.6,
  communityRules: ['Rule 1: No spam', 'Rule 2: No harassment'],
};

const isWrongTypeError = (error: unknown): boolean => {
  return error instanceof Error && error.message.includes('WRONGTYPE');
};

const ensureQueueZSet = async (subredditId: string): Promise<void> => {
  const key = queueKey(subredditId);
  const currentType = await redis.type(key);
  if (currentType === 'none' || currentType === 'zset') {
    return;
  }

  if (currentType === 'string') {
    const raw = await redis.get(key);
    const legacyIds = parseJsonList<string>(raw ?? null);
    await redis.del(key);

    if (legacyIds.length > 0) {
      const scoreHashes = await Promise.all(
        legacyIds.map((postId) => redis.hGetAll(scoreKey(subredditId, postId)))
      );
      const members = legacyIds.map((postId, idx) => ({
        member: postId,
        score: parseNumber(scoreHashes[idx]?.score, 0.5),
      }));
      if (members.length > 0) {
        await redis.zAdd(key, ...members);
      }
    }
    return;
  }

  await redis.del(key);
};

const queueZAdd = async (
  subredditId: string,
  member: { member: string; score: number }
): Promise<void> => {
  const key = queueKey(subredditId);
  try {
    await redis.zAdd(key, member);
  } catch (error) {
    if (!isWrongTypeError(error)) {
      throw error;
    }
    await ensureQueueZSet(subredditId);
    await redis.zAdd(key, member);
  }
};

const queueZRange = async (
  subredditId: string,
  limit: number
): Promise<Array<{ member: string; score: number }>> => {
  const key = queueKey(subredditId);
  try {
    return await redis.zRange(key, 0, Math.max(0, limit - 1), {
      by: 'rank',
      reverse: true,
    });
  } catch (error) {
    if (!isWrongTypeError(error)) {
      throw error;
    }
    await ensureQueueZSet(subredditId);
    return redis.zRange(key, 0, Math.max(0, limit - 1), {
      by: 'rank',
      reverse: true,
    });
  }
};

const queueZCard = async (subredditId: string): Promise<number> => {
  const key = queueKey(subredditId);
  try {
    return await redis.zCard(key);
  } catch (error) {
    if (!isWrongTypeError(error)) {
      throw error;
    }
    await ensureQueueZSet(subredditId);
    return redis.zCard(key);
  }
};

const queueZRem = async (subredditId: string, postId: string): Promise<void> => {
  const key = queueKey(subredditId);
  try {
    await redis.zRem(key, [postId]);
  } catch (error) {
    if (!isWrongTypeError(error)) {
      throw error;
    }
    await ensureQueueZSet(subredditId);
    await redis.zRem(key, [postId]);
  }
};

export const writeScoreRecord = async (
  record: ScoreRecord,
  options?: { enqueue?: boolean }
): Promise<void> => {
  const key = scoreKey(record.subredditId, record.postId);
  const existing = await redis.hGet(key, 'postId');
  await redis.hSet(key, {
    postId: record.postId,
    subredditId: record.subredditId,
    title: record.title,
    body: record.body,
    authorName: record.authorName,
    accountAgeDays: String(record.accountAgeDays),
    karma: String(record.karma),
    reportCount: String(record.reportCount),
    priorFlagsInSub: String(record.priorFlagsInSub),
    score: String(record.score),
    label: record.label,
    reasons: JSON.stringify(record.reasons),
    suggested_action: record.suggested_action,
    createdAt: String(record.createdAt),
    signalCountAtScoring: String(record.signalCountAtScoring ?? 0),
    confidence: String(record.confidence ?? 0.4),
    scoreSource: record.scoreSource ?? 'gemini',
    banEvasionMatch: record.banEvasionMatch ? JSON.stringify(record.banEvasionMatch) : '',
    bannedUserMatch: record.bannedUserMatch ? JSON.stringify(record.bannedUserMatch) : '',
  });

  if (options?.enqueue !== false) {
    await queueZAdd(record.subredditId, {
      member: record.postId,
      score: record.score,
    });
  }

  if (!existing) {
    await redis.incrBy(statsKey(record.subredditId, 'total'), 1);
  }
};

export const addSiqPostId = async (
  subredditId: string,
  postId: string
): Promise<void> => {
  const raw = await redis.get(siqPostsKey(subredditId));
  const ids = parseJsonList<string>(raw ?? null);
  if (!ids.includes(postId)) {
    ids.push(postId);
    await redis.set(siqPostsKey(subredditId), JSON.stringify(ids));
  }
};

export const isSiqPostId = async (
  subredditId: string,
  postId: string
): Promise<boolean> => {
  const raw = await redis.get(siqPostsKey(subredditId));
  const ids = parseJsonList<string>(raw ?? null);
  return ids.includes(postId);
};

export const readSiqPostIds = async (subredditId: string): Promise<string[]> => {
  const raw = await redis.get(siqPostsKey(subredditId));
  return parseJsonList<string>(raw ?? null);
};

export const readScoreRecord = async (
  subredditId: string,
  postId: string
): Promise<ScoreRecord | undefined> => {
  const raw = await redis.hGetAll(scoreKey(subredditId, postId));
  if (!raw.postId) {
    return undefined;
  }

  return {
    postId: requiredString(raw.postId),
    subredditId: requiredString(raw.subredditId),
    title: requiredString(raw.title),
    body: requiredString(raw.body),
    authorName: requiredString(raw.authorName),
    accountAgeDays: parseNumber(raw.accountAgeDays),
    karma: parseNumber(raw.karma),
    reportCount: parseNumber(raw.reportCount),
    priorFlagsInSub: parseNumber(raw.priorFlagsInSub),
    score: parseNumber(raw.score, 0.5),
    label: (raw.label as ScoreRecord['label']) ?? 'borderline',
    reasons: parseJsonList<string>(raw.reasons ?? null),
    suggested_action: (raw.suggested_action as ScoreRecord['suggested_action']) ?? 'review',
    createdAt: parseNumber(raw.createdAt, Date.now()),
    signalCountAtScoring: parseNumber(raw.signalCountAtScoring, 0),
    confidence: parseNumber(raw.confidence, 0.4),
    scoreSource: (raw.scoreSource as ScoreRecord['scoreSource']) ?? 'gemini',
    banEvasionMatch: raw.banEvasionMatch ? safeParseBanEvasion(raw.banEvasionMatch) : undefined,
    bannedUserMatch: raw.bannedUserMatch ? safeParseBannedUserMatch(raw.bannedUserMatch) : undefined,
  };
};

const safeParseBanEvasion = (raw: string): ScoreRecord['banEvasionMatch'] => {
  try {
    const parsed = JSON.parse(raw) as ScoreRecord['banEvasionMatch'];
    if (
      parsed &&
      typeof parsed.matchedAuthor === 'string' &&
      typeof parsed.matchedPostId === 'string' &&
      typeof parsed.similarity === 'number' &&
      typeof parsed.threshold === 'number' &&
      typeof parsed.timestamp === 'number'
    ) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return undefined;
};

const safeParseBannedUserMatch = (raw: string): ScoreRecord['bannedUserMatch'] => {
  try {
    const parsed = JSON.parse(raw) as ScoreRecord['bannedUserMatch'];
    if (
      parsed &&
      typeof parsed.matchedAuthor === 'string' &&
      typeof parsed.matchedPostId === 'string' &&
      typeof parsed.similarity === 'number' &&
      typeof parsed.threshold === 'number' &&
      typeof parsed.timestamp === 'number'
    ) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return undefined;
};

const readReportedPostIds = async (subredditId: string): Promise<string[]> => {
  return parseJsonList<string>((await redis.get(reportedPostsKey(subredditId))) ?? null);
};

const writeReportedPostIds = async (subredditId: string, postIds: string[]): Promise<void> => {
  await writeJsonList(reportedPostsKey(subredditId), postIds);
};

export const addReportedPost = async (subredditId: string, postId: string): Promise<void> => {
  const items = await readReportedPostIds(subredditId);
  if (!items.includes(postId)) {
    items.push(postId);
    await writeReportedPostIds(subredditId, items);
  }
};

export const incrementReportAndMeta = async (input: {
  subredditId: string;
  postId: string;
  title: string;
  authorName: string;
}): Promise<ReportMeta> => {
  const reportCount = await redis.incrBy(reportCountKey(input.subredditId, input.postId), 1);
  const key = reportMetaKey(input.subredditId, input.postId);
  const existing = await redis.hGetAll(key);
  const now = Date.now();
  const firstReportedAt = existing.firstReportedAt
    ? parseNumber(existing.firstReportedAt)
    : now;

  await redis.hSet(key, {
    postId: input.postId,
    subredditId: input.subredditId,
    title: input.title,
    authorName: input.authorName,
    firstReportedAt: String(firstReportedAt),
    lastReportedAt: String(now),
    reportCount: String(reportCount),
    status: 'active',
  });

  await addReportedPost(input.subredditId, input.postId);

  return {
    postId: input.postId,
    subredditId: input.subredditId,
    title: input.title,
    authorName: input.authorName,
    firstReportedAt,
    lastReportedAt: now,
    reportCount,
    status: 'active',
  };
};

export const readReportMeta = async (
  subredditId: string,
  postId: string
): Promise<ReportMeta | undefined> => {
  const raw = await redis.hGetAll(reportMetaKey(subredditId, postId));
  if (!raw.postId) {
    return undefined;
  }
  return {
    postId: requiredString(raw.postId),
    subredditId: requiredString(raw.subredditId),
    title: requiredString(raw.title),
    authorName: requiredString(raw.authorName),
    firstReportedAt: parseNumber(raw.firstReportedAt),
    lastReportedAt: parseNumber(raw.lastReportedAt),
    reportCount: parseNumber(raw.reportCount),
    status: raw.status === 'processed' ? 'processed' : 'active',
    processedAt: raw.processedAt ? parseNumber(raw.processedAt) : undefined,
    processedAction:
      raw.processedAction === 'approve' || raw.processedAction === 'remove'
        ? raw.processedAction
        : undefined,
  };
};

export const readReportedPosts = async (
  subredditId: string,
  status: 'active' | 'processed' | 'all' = 'active'
): Promise<ReportMeta[]> => {
  const ids = await readReportedPostIds(subredditId);
  if (ids.length === 0) {
    return [];
  }

  const metas = await Promise.all(ids.map((postId) => readReportMeta(subredditId, postId)));
  const all = metas.filter((meta): meta is ReportMeta => Boolean(meta));
  if (status === 'all') {
    return all;
  }
  return all.filter((meta) => meta.status === status);
};

export const markReportedPostProcessed = async (
  subredditId: string,
  postId: string,
  action: 'approve' | 'remove'
): Promise<void> => {
  const key = reportMetaKey(subredditId, postId);
  const existing = await redis.hGetAll(key);
  if (!existing.postId) {
    return;
  }
  await redis.hSet(key, {
    ...existing,
    status: 'processed',
    processedAt: String(Date.now()),
    processedAction: action,
  });
};

export const readQueueItems = async (
  subredditId: string,
  limit: number,
  offset = 0
): Promise<QueueItem[]> => {
  const ranked = await queueZRange(subredditId, limit + offset);

  const postIds = ranked.slice(offset, offset + limit).map((entry) => entry.member);
  if (postIds.length === 0) {
    return [];
  }

  const scoreHashes = await Promise.all(postIds.map((postId) => redis.hGetAll(scoreKey(subredditId, postId))));

  return scoreHashes
    .filter((raw) => raw.postId)
    .map((raw) => ({
      postId: requiredString(raw.postId),
      subredditId: requiredString(raw.subredditId),
      title: requiredString(raw.title),
      authorName: requiredString(raw.authorName),
      reportCount: parseNumber(raw.reportCount),
      score: parseNumber(raw.score),
      label: (raw.label as QueueItem['label']) ?? 'borderline',
      reasons: parseJsonList<string>(raw.reasons ?? null),
      suggested_action: (raw.suggested_action as QueueItem['suggested_action']) ?? 'review',
      claimedBy: raw.claimedBy,
    }));
};

export const writeAuditEntry = async (entry: AuditEntry): Promise<void> => {
  const existing = parseJsonList<AuditEntry>((await redis.get(auditKey(entry.subredditId))) ?? null);
  existing.unshift(entry);
  await redis.set(auditKey(entry.subredditId), JSON.stringify(existing.slice(0, 1000)));
};

export const readAuditEntries = async (subredditId: string, limit: number): Promise<AuditEntry[]> => {
  const entries = parseJsonList<AuditEntry>((await redis.get(auditKey(subredditId))) ?? null);
  return entries.slice(0, limit).map((entry) => ({
    ...entry,
    reasons: Array.isArray(entry.reasons) ? entry.reasons : [],
    postTitle: entry.postTitle ?? entry.postId,
    modId: entry.modId ?? 'unknown_mod',
    score: Number.isFinite(entry.score) ? entry.score : 0.5,
  }));
};

export const readAuditEntriesPaged = async (
  subredditId: string,
  limit: number,
  offset: number
): Promise<AuditEntry[]> => {
  const entries = parseJsonList<AuditEntry>((await redis.get(auditKey(subredditId))) ?? null);
  return entries.slice(offset, offset + limit).map((entry) => ({
    ...entry,
    reasons: Array.isArray(entry.reasons) ? entry.reasons : [],
    postTitle: entry.postTitle ?? entry.postId,
    modId: entry.modId ?? 'unknown_mod',
    score: Number.isFinite(entry.score) ? entry.score : 0.5,
  }));
};

export const removeFromQueue = async (subredditId: string, postId: string): Promise<void> => {
  await queueZRem(subredditId, postId);
};

export const incrementActionStats = async (
  subredditId: string,
  action: 'approve' | 'remove'
): Promise<void> => {
  const suffix = action === 'approve' ? 'approved_today' : 'removed_today';
  const globalKey = action === 'approve' ? 'stats:approved' : 'stats:removed';
  await Promise.all([
    redis.incrBy(statsKey(subredditId, suffix), 1),
    redis.incrBy('stats:processed', 1),
    redis.incrBy(globalKey, 1),
  ]);
};

export const readSummaryStats = async (subredditId: string): Promise<SummaryStats> => {
  const [total, removedToday, approvedToday, reportedRaw] = await redis.mGet([
    statsKey(subredditId, 'total'),
    statsKey(subredditId, 'removed_today'),
    statsKey(subredditId, 'approved_today'),
    reportedPostsKey(subredditId),
  ]);

  const queueCount = await queueZCard(subredditId);
  const reportedCount = parseJsonList<string>(reportedRaw ?? null).length;

  return {
    totalProcessed: parseNumber(total ?? undefined),
    removedToday: parseNumber(removedToday ?? undefined),
    approvedToday: parseNumber(approvedToday ?? undefined),
    queueCount,
    reportedCount,
  };
};

export const readRules = async (subredditId: string): Promise<ModerationRules> => {
  const raw = await redis.get(rulesKey(subredditId));
  if (!raw) {
    await redis.set(rulesKey(subredditId), JSON.stringify(defaultRules));
    return defaultRules;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ModerationRules>;
    return {
      autoApproveThreshold: typeof parsed.autoApproveThreshold === 'number' ? parsed.autoApproveThreshold : defaultRules.autoApproveThreshold,
      autoRemoveThreshold: typeof parsed.autoRemoveThreshold === 'number' ? parsed.autoRemoveThreshold : defaultRules.autoRemoveThreshold,
      banEvasionThreshold: typeof parsed.banEvasionThreshold === 'number' ? parsed.banEvasionThreshold : defaultRules.banEvasionThreshold,
      communityRules: Array.isArray(parsed.communityRules) ? parsed.communityRules.filter((x): x is string => typeof x === 'string') : defaultRules.communityRules,
    };
  } catch {
    return defaultRules;
  }
};

export const writeRules = async (subredditId: string, rules: ModerationRules): Promise<void> => {
  await redis.set(rulesKey(subredditId), JSON.stringify(rules));
};

const escalatedKey = (subredditId: string) => `escalated:${subredditId}`;

export const addEscalatedPost = async (subredditId: string, postId: string): Promise<void> => {
  const ids = parseJsonList<string>((await redis.get(escalatedKey(subredditId))) ?? null);
  if (!ids.includes(postId)) {
    ids.push(postId);
    await redis.set(escalatedKey(subredditId), JSON.stringify(ids));
  }
};

export const removeEscalatedPost = async (subredditId: string, postId: string): Promise<void> => {
  const ids = parseJsonList<string>((await redis.get(escalatedKey(subredditId))) ?? null);
  const filtered = ids.filter((id) => id !== postId);
  await redis.set(escalatedKey(subredditId), JSON.stringify(filtered));
};

export const readEscalatedPosts = async (subredditId: string): Promise<QueueItem[]> => {
  const ids = parseJsonList<string>((await redis.get(escalatedKey(subredditId))) ?? null);
  if (ids.length === 0) return [];
  const scoreHashes = await Promise.all(ids.map((postId) => redis.hGetAll(scoreKey(subredditId, postId))));
  return scoreHashes
    .filter((raw) => raw.postId)
    .map((raw) => ({
      postId: requiredString(raw.postId),
      subredditId: requiredString(raw.subredditId),
      title: requiredString(raw.title),
      authorName: requiredString(raw.authorName),
      reportCount: parseNumber(raw.reportCount),
      score: parseNumber(raw.score),
      label: (raw.label as QueueItem['label']) ?? 'borderline',
      reasons: parseJsonList<string>(raw.reasons ?? null),
      suggested_action: (raw.suggested_action as QueueItem['suggested_action']) ?? 'review',
      claimedBy: raw.claimedBy,
    }));
};

// ----- Ban-evasion banned-signals corpus ------------------------------------
//
// banned_signals:{subredditId} is a Redis ZSET (score = timestamp) of
// JSON-serialized BannedSignal entries. We append to it whenever a
// moderator removes a post in this subreddit, treating mod removal as the
// proxy for "banned-author content." We do not call any Reddit ban API.
// Used by pipeline.ts to detect ban-evasion via Jaccard similarity.

const BANNED_SIGNALS_CAP = 1000;
const bannedSignalsKey = (subredditId: string) => `banned_signals:${subredditId}`;

export const addBannedSignal = async (
  subredditId: string,
  signal: BannedSignal
): Promise<void> => {
  const key = bannedSignalsKey(subredditId);
  await redis.zAdd(key, { score: signal.timestamp, member: JSON.stringify(signal) });
  // Trim oldest beyond the cap (zRemRangeByRank removes entries by index range).
  await redis.zRemRangeByRank(key, 0, -BANNED_SIGNALS_CAP - 1);
};

export const readBannedSignals = async (
  subredditId: string
): Promise<BannedSignal[]> => {
  const raw = await redis.zRange(bannedSignalsKey(subredditId), 0, -1);
  const out: BannedSignal[] = [];
  for (const entry of raw) {
    try {
      const parsed = JSON.parse(typeof entry === 'string' ? entry : entry.member) as BannedSignal;
      if (
        parsed &&
        typeof parsed.authorName === 'string' &&
        typeof parsed.postId === 'string' &&
        Array.isArray(parsed.fingerprint)
      ) {
        out.push(parsed);
      }
    } catch {
      // ignore malformed entries
    }
  }
  return out;
};

// backfillBannedSignalsFromAudit walks the audit log for the subreddit,
// finds remove-actions, looks up the corresponding score records (which
// carry author + title + body + reasons), and seeds the banned-signals
// corpus. Idempotent: existing (authorName, postId) pairs are skipped.
//
// This is the natural starting point because the audit log is the
// canonical record of past mod removals. The author-history-based variant
// (backfillBannedSignalsFromAuthors) remains available for callers that
// already have a known set of usernames.
export const backfillBannedSignalsFromAudit = async (
  subredditId: string,
  limit = 1000
): Promise<{ added: number; skipped: number; scanned: number }> => {
  const entries = parseJsonList<AuditEntry>((await redis.get(auditKey(subredditId))) ?? null);
  const removes = entries.filter((e) => e.action === 'remove').slice(0, limit);

  const existing = await readBannedSignals(subredditId);
  const seen = new Set(existing.map((s) => `${s.authorName}:${s.postId}`));

  let added = 0;
  let skipped = 0;

  for (const entry of removes) {
    const score = await readScoreRecord(subredditId, entry.postId);
    if (!score) {
      skipped += 1;
      continue;
    }
    const dedupeKey = `${score.authorName}:${score.postId}`;
    if (seen.has(dedupeKey)) {
      skipped += 1;
      continue;
    }
    seen.add(dedupeKey);

    // Late-bind extractFingerprint to avoid a circular import at module load.
    const { extractFingerprint } = await import('./llm');
    const signal: BannedSignal = {
      authorName: score.authorName,
      postId: score.postId,
      title: score.title,
      fingerprint: extractFingerprint(score.title, score.body),
      timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
    };
    await addBannedSignal(subredditId, signal);
    added += 1;
  }

  return { added, skipped, scanned: removes.length };
};
// (author:actions:{subredditId}:{username}) and seeds the banned-signals
// corpus with all `remove` actions that aren't already present.
//
// Idempotent: existing (authorName, postId) pairs are skipped. Safe to call
// repeatedly. The redis client used here only exposes per-key reads, so we
// rely on a caller-supplied list of known authors. In practice the caller
// is the /api/admin/backfill-banned-signals endpoint, which gathers
// candidate usernames from the audit log.
export const backfillBannedSignalsFromAuthors = async (
  subredditId: string,
  authorNames: string[]
): Promise<{ added: number; skipped: number }> => {
  const existing = await readBannedSignals(subredditId);
  const seen = new Set(existing.map((s) => `${s.authorName}:${s.postId}`));

  let added = 0;
  let skipped = 0;

  for (const authorName of authorNames) {
    const authorKey = `author:actions:${subredditId}:${authorName}`;
    const raw = await redis.get(authorKey);
    if (!raw) continue;
    let history: Array<{
      postId?: unknown;
      action?: unknown;
      fingerprint?: unknown;
      timestamp?: unknown;
    }>;
    try {
      history = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(history)) continue;
    for (const entry of history) {
      if (entry.action !== 'remove') continue;
      if (typeof entry.postId !== 'string') continue;
      if (!Array.isArray(entry.fingerprint)) continue;

      const dedupeKey = `${authorName}:${entry.postId}`;
      if (seen.has(dedupeKey)) {
        skipped += 1;
        continue;
      }
      seen.add(dedupeKey);

      const scoreRecord = await readScoreRecord(subredditId, entry.postId);
      const signal: BannedSignal = {
        authorName,
        postId: entry.postId,
        title: scoreRecord?.title ?? entry.postId,
        fingerprint: (entry.fingerprint as unknown[]).filter(
          (t): t is string => typeof t === 'string'
        ),
        timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
      };
      await addBannedSignal(subredditId, signal);
      added += 1;
    }
  }

  return { added, skipped };
};

// ----- Banned-user corpus & registry ----------------------------------------
//
// Two per-subreddit Redis keys back the explicit-ban feature:
//
//   banned_users:{subredditId}        JSON list of BannedUserRecord
//   banned_user_signals:{subredditId} ZSET of JSON-encoded BannedUserSignal,
//                                     score = signal.timestamp
//
// Seeded only from action='remove' entries in author:actions:* at ban time
// (per spec). Cleared selectively on unban.

const BANNED_USER_SIGNALS_CAP = 2000;
const bannedUsersKey = (subredditId: string) => `banned_users:${subredditId}`;
const bannedUserSignalsKey = (subredditId: string) => `banned_user_signals:${subredditId}`;

export const readBannedUsers = async (subredditId: string): Promise<BannedUserRecord[]> => {
  const raw = await redis.get(bannedUsersKey(subredditId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e: unknown): e is BannedUserRecord =>
        !!e && typeof (e as BannedUserRecord).authorName === 'string'
    );
  } catch {
    return [];
  }
};

export const isUserBanned = async (
  subredditId: string,
  authorName: string
): Promise<boolean> => {
  const list = await readBannedUsers(subredditId);
  return list.some((e) => e.authorName === authorName);
};

export const addBannedUser = async (
  subredditId: string,
  record: BannedUserRecord
): Promise<void> => {
  const list = await readBannedUsers(subredditId);
  const filtered = list.filter((e) => e.authorName !== record.authorName);
  filtered.unshift(record);
  await redis.set(bannedUsersKey(subredditId), JSON.stringify(filtered));
};

export const removeBannedUser = async (
  subredditId: string,
  authorName: string
): Promise<void> => {
  const list = await readBannedUsers(subredditId);
  const filtered = list.filter((e) => e.authorName !== authorName);
  await redis.set(bannedUsersKey(subredditId), JSON.stringify(filtered));
};

const addBannedUserSignal = async (
  subredditId: string,
  signal: BannedUserSignal
): Promise<void> => {
  const key = bannedUserSignalsKey(subredditId);
  await redis.zAdd(key, { score: signal.timestamp, member: JSON.stringify(signal) });
  await redis.zRemRangeByRank(key, 0, -BANNED_USER_SIGNALS_CAP - 1);
};

export const readBannedUserSignals = async (
  subredditId: string
): Promise<BannedUserSignal[]> => {
  const raw = await redis.zRange(bannedUserSignalsKey(subredditId), 0, -1);
  const out: BannedUserSignal[] = [];
  for (const entry of raw) {
    try {
      const parsed = JSON.parse(typeof entry === 'string' ? entry : entry.member) as BannedUserSignal;
      if (
        parsed &&
        typeof parsed.bannedUserName === 'string' &&
        typeof parsed.postId === 'string' &&
        Array.isArray(parsed.fingerprint)
      ) {
        out.push(parsed);
      }
    } catch {
      // skip malformed
    }
  }
  return out;
};

// seedBannedUserCorpus reads the per-author action history for the given
// banned user and seeds banned_user_signals with all entries where
// action === 'remove'. Idempotent within a single ban call (we always
// clear+rebuild the user's signals via removeBannedUserSignals before
// seeding, ensuring no duplicates).
export const seedBannedUserCorpus = async (
  subredditId: string,
  authorName: string
): Promise<{ added: number }> => {
  const authorKey = `author:actions:${subredditId}:${authorName}`;
  const raw = await redis.get(authorKey);
  if (!raw) return { added: 0 };
  let history: Array<{
    postId?: unknown;
    action?: unknown;
    fingerprint?: unknown;
    timestamp?: unknown;
  }>;
  try {
    history = JSON.parse(raw);
  } catch {
    return { added: 0 };
  }
  if (!Array.isArray(history)) return { added: 0 };

  let added = 0;
  for (const entry of history) {
    if (entry.action !== 'remove') continue;
    if (typeof entry.postId !== 'string') continue;
    if (!Array.isArray(entry.fingerprint)) continue;

    const score = await readScoreRecord(subredditId, entry.postId);
    const signal: BannedUserSignal = {
      bannedUserName: authorName,
      postId: entry.postId,
      title: score?.title ?? entry.postId,
      fingerprint: (entry.fingerprint as unknown[]).filter(
        (t): t is string => typeof t === 'string'
      ),
      timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
    };
    await addBannedUserSignal(subredditId, signal);
    added += 1;
  }
  return { added };
};

// removeBannedUserSignals purges all banned-user signals belonging to the
// given user from the ZSET. Called on unban so future scoring stops
// matching against this user's content.
export const removeBannedUserSignals = async (
  subredditId: string,
  authorName: string
): Promise<{ removed: number }> => {
  const key = bannedUserSignalsKey(subredditId);
  const raw = await redis.zRange(key, 0, -1);
  let removed = 0;
  for (const entry of raw) {
    const member = typeof entry === 'string' ? entry : entry.member;
    try {
      const parsed = JSON.parse(member) as BannedUserSignal;
      if (parsed.bannedUserName === authorName) {
        await redis.zRem(key, [member]);
        removed += 1;
      }
    } catch {
      // skip malformed
    }
  }
  return { removed };
};
