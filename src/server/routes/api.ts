import { Hono } from 'hono';
import { context, reddit, redis } from '@devvit/web/server';
import { z } from 'zod';
import type {
  ActionRequest,
  ActionResponse,
  AuditResponse,
  BulkApplyResponse,
  BulkPreviewResponse,
  DashboardResponse,
  ReportedPostsResponse,
  RulesResponse,
  ScoreContentRequest,
  ScoreContentResponse,
} from '../../shared/mod';
import { applyAction, scoreContent } from '../mod/pipeline';
import { extractFingerprint, extractTrigrams, buildSnippet, type LearningSignal } from '../mod/llm';
import {
  addBannedUser,
  backfillBannedSignalsFromAudit,
  isUserBanned,
  readAuditEntriesPaged,
  readBannedUsers,
  readQueueItems,
  readReportedPosts,
  readScoreRecord,
  readSummaryStats,
  readRules,
  readSiqPostIds,
  removeBannedUser,
  removeBannedUserSignals,
  seedBannedUserCorpus,
  writeRules,
  writeAuditEntry,
  addEscalatedPost,
  removeEscalatedPost,
  readEscalatedPosts,
} from '../mod/store';

type ErrorResponse = { success: false; error: string };

export const api = new Hono();

const DEFAULT_SUBREDDIT_NAME = 'modecule_dev';
const ACCESS_FORBIDDEN = 'moderator_access_required';

const getTargetSubredditName = (requestedName?: string | null): string => {
  const raw = (requestedName ?? DEFAULT_SUBREDDIT_NAME).trim();
  const name = raw.replace(/^r\//i, '');
  return name.length > 0 ? name : DEFAULT_SUBREDDIT_NAME;
};

const getSubredditId = async (requestedName?: string | null): Promise<string | null> => {
  const name = getTargetSubredditName(requestedName);
  if (name.length > 0) {
    try {
      const info = await reddit.getSubredditInfoByName(name);
      return info.id ?? null;
    } catch {
      return null;
    }
  }
  return context.subredditId ?? null;
};

const isCurrentUserModerator = async (subredditName: string): Promise<boolean> => {
  try {
    const currentUser = await reddit.getCurrentUser();
    if (!currentUser) {
      return false;
    }
    const permissions = await currentUser.getModPermissionsForSubreddit(subredditName);
    return Array.isArray(permissions) && permissions.length > 0;
  } catch {
    return false;
  }
};

api.get('/access', async (c) => {
  const subredditName = getTargetSubredditName(c.req.query('subreddit'));
  const isModerator = await isCurrentUserModerator(subredditName);
  return c.json({ success: true, isModerator });
});

api.use('*', async (c, next) => {
  if (c.req.path.endsWith('/access')) {
    return next();
  }
  const subredditName = getTargetSubredditName(c.req.query('subreddit'));
  const isModerator = await isCurrentUserModerator(subredditName);
  if (!isModerator) {
    return c.json<ErrorResponse>({ success: false, error: ACCESS_FORBIDDEN }, 403);
  }
  return next();
});
const rulesSchema = z.object({
  autoApproveThreshold: z.number().min(0).max(1),
  autoRemoveThreshold: z.number().min(0).max(1),
  banEvasionThreshold: z.number().min(0).max(1),
  communityRules: z.array(z.string().min(1)).max(200),
});

// Ban request: durationDays omitted/null/0 means permanent (per Reddit API).
// Reason is bounded so we don't accidentally ship multi-paragraph text into
// the modlog. Username is the bare handle without 'u/' prefix.
const banUserSchema = z.object({
  username: z.string().trim().min(1).max(50),
  durationDays: z.number().int().min(0).max(999).optional(),
  reason: z.string().trim().max(300).optional(),
});

const unbanUserSchema = z.object({
  username: z.string().trim().min(1).max(50),
});

const keyProcessed = 'stats:processed';
const keyRemoved = 'stats:removed';
const keyApproved = 'stats:approved';
const keyReported = 'stats:reported';
const keyQueueLength = 'queue:length';

type QueueApiPost = {
  id: string;
  title: string;
  author: string;
  score: number;
  reasons: string[];
  reportCount: number;
  createdAt: string;
  type: 'post' | 'comment';
  confidence: number;
  banEvasion?: { matchedAuthor: string; similarity: number };
  bannedUserMatch?: { matchedAuthor: string; similarity: number };
};

api.get('/queue', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }

  const queue = await readQueueItems(subredditId, 200, 0);

  // Phase 3: lazy re-score. If the global signal count has moved more than
  // RESCORE_THRESHOLD beyond an item's signalCountAtScoring, re-score it now.
  // Cap at RESCORE_BUDGET per request to bound LLM cost.
  const RESCORE_THRESHOLD = 5;
  const RESCORE_BUDGET = 5;
  const currentSignalCount = await redis.zCard(`learning:signals:${subredditId}`);

  type StalePick = { postId: string; drift: number };
  const stale: StalePick[] = [];
  for (const item of queue) {
    const rec = await readScoreRecord(subredditId, item.postId);
    if (!rec) continue;
    const drift = currentSignalCount - (rec.signalCountAtScoring ?? 0);
    if (drift > RESCORE_THRESHOLD) {
      stale.push({ postId: item.postId, drift });
    }
  }
  // Re-score the staleest first
  stale.sort((a, b) => b.drift - a.drift);
  const rescoreTargets = stale.slice(0, RESCORE_BUDGET);
  await Promise.all(
    rescoreTargets.map(async ({ postId }) => {
      const rec = await readScoreRecord(subredditId, postId);
      if (!rec) return;
      try {
        await scoreContent(
          subredditId,
          {
            postId: rec.postId,
            title: rec.title,
            body: rec.body,
            authorName: rec.authorName,
            accountAgeDays: rec.accountAgeDays,
            karma: rec.karma,
            reportCount: rec.reportCount,
            priorFlagsInSub: rec.priorFlagsInSub,
          },
          { forceRescore: true }
        );
      } catch {
        // Best-effort. Keep the old score on failure.
      }
    })
  );

  // Re-read the queue items so we pick up any updated scores from the
  // ZSET that scoreContent rewrote during the lazy re-score.
  const refreshedQueue = rescoreTargets.length > 0
    ? await readQueueItems(subredditId, 200, 0)
    : queue;

  const posts = await Promise.all(
    refreshedQueue.map(async (item) => {
      const scoreRecord = await readScoreRecord(subredditId, item.postId);
      return {
        id: item.postId,
        title: item.title,
        author: item.authorName,
        score: item.score,
        reasons: item.reasons,
        reportCount: item.reportCount,
        createdAt: new Date(scoreRecord?.createdAt ?? Date.now()).toISOString(),
        type: 'post' as const,
        confidence: scoreRecord?.confidence ?? 0.4,
        banEvasion: scoreRecord?.banEvasionMatch
          ? {
              matchedAuthor: scoreRecord.banEvasionMatch.matchedAuthor,
              similarity: scoreRecord.banEvasionMatch.similarity,
            }
          : undefined,
        bannedUserMatch: scoreRecord?.bannedUserMatch
          ? {
              matchedAuthor: scoreRecord.bannedUserMatch.matchedAuthor,
              similarity: scoreRecord.bannedUserMatch.similarity,
            }
          : undefined,
      };
    })
  );
  const siqIds = new Set(await readSiqPostIds(subredditId));
  const filtered = posts.filter((p) => !siqIds.has(p.id));
  filtered.sort((a, b) => b.score - a.score);
  await redis.set(keyQueueLength, String(filtered.length));
  return c.json({ type: 'QUEUE_POSTS_RESPONSE', posts: filtered });
});

api.get('/escalated', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }
  const items = await readEscalatedPosts(subredditId);
  const posts: QueueApiPost[] = await Promise.all(
    items.map(async (item) => {
      const scoreRecord = await readScoreRecord(subredditId, item.postId);
      return {
        id: item.postId,
        title: item.title,
        author: item.authorName,
        score: item.score,
        reasons: item.reasons,
        reportCount: item.reportCount,
        createdAt: new Date().toISOString(),
        type: 'post' as const,
        confidence: 0.4,
        banEvasion: scoreRecord?.banEvasionMatch
          ? {
              matchedAuthor: scoreRecord.banEvasionMatch.matchedAuthor,
              similarity: scoreRecord.banEvasionMatch.similarity,
            }
          : undefined,
        bannedUserMatch: scoreRecord?.bannedUserMatch
          ? {
              matchedAuthor: scoreRecord.bannedUserMatch.matchedAuthor,
              similarity: scoreRecord.bannedUserMatch.similarity,
            }
          : undefined,
      };
    })
  );
  return c.json({ type: 'ESCALATED_POSTS_RESPONSE', posts });
});

api.post('/escalated-action', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }
  const body = await c.req.json<{ action: 'approve' | 'remove'; postId: string }>();
  const modId = (await reddit.getCurrentUsername()) || 'unknown_mod';
  await removeEscalatedPost(subredditId, body.postId);
  const result = await applyAction(
    { postId: body.postId, subredditId, modId, reason: 'escalated_review' },
    body.action
  );
  if (!result.success) {
    return c.json(result, 500);
  }
  return c.json({ success: true });
});

api.get('/stats', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }

  const summary = await readSummaryStats(subredditId);
  const [processedRaw, removedRaw, approvedRaw, reportedRaw] =
    await redis.mGet([
      keyProcessed,
      keyRemoved,
      keyApproved,
      keyReported,
    ]);

  const queue = await readQueueItems(subredditId, 200, 0);
  const siqIds = new Set(await readSiqPostIds(subredditId));
  const filteredCount = queue.filter((item) => !siqIds.has(item.postId)).length;

  const parsed = (value: string | null, fallback: number): number => {
    const n = Number.parseInt(value ?? '', 10);
    return Number.isFinite(n) ? n : fallback;
  };

  return c.json({
    type: 'STATS_RESPONSE',
    processed: parsed(processedRaw ?? null, summary.totalProcessed),
    removed: parsed(removedRaw ?? null, summary.removedToday),
    approved: parsed(approvedRaw ?? null, summary.approvedToday),
    inQueue: filteredCount,
    reported: parsed(reportedRaw ?? null, summary.reportedCount),
  });
});

api.post('/mod-action', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }

  const body = await c.req.json<{ action: 'approve' | 'remove' | 'escalate'; postId: string }>();
  const modId = (await reddit.getCurrentUsername()) || 'unknown_mod';

  if (body.action === 'escalate') {
    const score = await readScoreRecord(subredditId, body.postId);
    await addEscalatedPost(subredditId, body.postId);
    await writeAuditEntry({
      postId: body.postId,
      subredditId,
      action: 'escalate',
      modId,
      timestamp: Date.now(),
      score: score?.score ?? 0.5,
      reasons: score?.reasons ?? ['manual_escalation'],
      postTitle: score?.title ?? body.postId,
      scoreSource: score?.scoreSource,
    });
    return c.json({ success: true });
  }

  const result = await applyAction(
    { postId: body.postId, subredditId, modId, reason: 'manual_action' },
    body.action
  );

  if (!result.success) {
    return c.json(result, 500);
  }

  const scoreRecord = await readScoreRecord(subredditId, body.postId);
  const originalScore = scoreRecord?.score ?? 0.5;

  // Store learning signal for borderline posts
  //originalScore >= 0.30 && originalScore <= 0.75 && 
  if (scoreRecord) {
    const fingerprint = extractFingerprint(scoreRecord.title, scoreRecord.body);
    const trigrams = extractTrigrams(scoreRecord.title, scoreRecord.body);
    const signal: LearningSignal = {
      fingerprint,
      trigrams,
      titleSnippet: buildSnippet(scoreRecord.title, 120),
      bodySnippet: buildSnippet(scoreRecord.body, 200),
      reasons: scoreRecord.reasons,
      action: body.action,
      originalScore,
      postId: body.postId,
      authorId: scoreRecord.authorName,
      timestamp: Date.now(),
    };
    await redis.zAdd(`learning:signals:${subredditId}`, { score: Date.now(), member: JSON.stringify(signal) });
    await redis.zRemRangeByRank(`learning:signals:${subredditId}`, 0, -501);

    // Per-author action history for future ban evasion
    const authorKey = `author:actions:${subredditId}:${scoreRecord.authorName}`;
    const existingRaw = await redis.get(authorKey);
    const history: unknown[] = existingRaw ? JSON.parse(existingRaw) : [];
    history.unshift({
      postId: body.postId,
      action: body.action,
      score: originalScore,
      fingerprint,
      timestamp: Date.now(),
    });
    await redis.set(authorKey, JSON.stringify(history.slice(0, 50)));
  }

  return c.json({ success: true });
});

api.post('/bulk-action', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }
  const body = await c.req.json<{
    action: 'approve' | 'remove' | 'escalate';
    postIds: string[];
  }>();
  const modId = (await reddit.getCurrentUsername()) || 'unknown_mod';
  const postIds = Array.isArray(body.postIds) ? body.postIds : [];
  let updated = 0;

  if (body.action === 'escalate') {
    for (const postId of postIds) {
      const score = await readScoreRecord(subredditId, postId);
      await addEscalatedPost(subredditId, postId);
      await writeAuditEntry({
        postId,
        subredditId,
        action: 'escalate',
        modId,
        timestamp: Date.now(),
        score: score?.score ?? 0.5,
        reasons: score?.reasons ?? ['manual_escalation'],
        postTitle: score?.title ?? postId,
        scoreSource: score?.scoreSource,
      });
      updated += 1;
    }
    return c.json({ success: true, updated });
  }

  for (const postId of postIds) {
    const result = await applyAction(
      { postId, subredditId, modId, reason: 'bulk_action' },
      body.action
    );
    if (result.success) {
      updated += 1;
    }
  }

  return c.json({ success: true, updated });
});

api.get('/dashboard', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }

  const page = Number.parseInt(c.req.query('page') ?? '1', 10);
  const pageSize = Number.parseInt(c.req.query('pageSize') ?? '20', 10);
  const offset = Math.max(0, (Number.isFinite(page) ? page : 1) - 1) * Math.max(1, pageSize);

  const [summary, queue] = await Promise.all([
    readSummaryStats(subredditId),
    readQueueItems(subredditId, Math.max(1, pageSize), offset),
  ]);

  return c.json<DashboardResponse>({ success: true, summary, queue });
});

api.get('/reported-posts', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }

  const page = Number.parseInt(c.req.query('page') ?? '1', 10);
  const pageSize = Number.parseInt(c.req.query('pageSize') ?? '20', 10);
  const sort = c.req.query('sort') === 'recent' ? 'recent' : 'count';
  const statusQuery = c.req.query('status');
  const status = statusQuery === 'processed' ? 'processed' : 'active';
  const offset = Math.max(0, (Number.isFinite(page) ? page : 1) - 1) * Math.max(1, pageSize);

  const metas = await readReportedPosts(subredditId, status);
  const withScores = await Promise.all(
    metas.map(async (meta) => {
      const score = await readScoreRecord(subredditId, meta.postId);
      if (meta.authorName === 'unknown' && score?.authorName) {
        meta = { ...meta, authorName: score.authorName };
      }
      return { meta, score };
    })
  );

  withScores.sort((a, b) =>
    sort === 'recent'
      ? b.meta.lastReportedAt - a.meta.lastReportedAt
      : b.meta.reportCount - a.meta.reportCount
  );

  return c.json<ReportedPostsResponse>({
    success: true,
    posts: withScores.slice(offset, offset + Math.max(1, pageSize)),
  });
});

api.get('/audit', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }

  const page = Number.parseInt(c.req.query('page') ?? '1', 10);
  const pageSize = Number.parseInt(c.req.query('pageSize') ?? '20', 10);
  const offset = Math.max(0, (Number.isFinite(page) ? page : 1) - 1) * Math.max(1, pageSize);
  const entries = await readAuditEntriesPaged(subredditId, Math.max(1, pageSize), offset);
  return c.json<AuditResponse>({ success: true, entries });
});

api.get('/rules', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }
  const rules = await readRules(subredditId);
  return c.json<RulesResponse>({ success: true, rules });
});

api.post('/rules', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }
  const bodyRaw = await c.req.json();
  const parsed = rulesSchema.safeParse(bodyRaw);
  if (!parsed.success) {
    return c.json<ErrorResponse>({ success: false, error: 'invalid_rules_payload' }, 400);
  }
  const body = parsed.data;
  await writeRules(subredditId, {
    autoApproveThreshold: body.autoApproveThreshold,
    autoRemoveThreshold: body.autoRemoveThreshold,
    banEvasionThreshold: body.banEvasionThreshold,
    communityRules: body.communityRules,
  });
  return c.json<RulesResponse>({ success: true, rules: await readRules(subredditId) });
});

// One-shot backfill of the ban-evasion corpus from existing audit entries.
// Idempotent: existing (authorName, postId) pairs are skipped. Mod-gated
// via the existing /api/* moderator-access middleware.
api.post('/admin/backfill-banned-signals', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }
  try {
    const result = await backfillBannedSignalsFromAudit(subredditId);
    return c.json({ success: true, ...result });
  } catch (error) {
    console.error('backfill banned signals failed', error);
    return c.json<ErrorResponse>({ success: false, error: 'backfill_failed' }, 500);
  }
});

// Ban a user on Reddit and seed the per-user signal corpus from their
// removed-post history. Atomic-ish: if the Reddit ban call fails we do
// NOT mutate any local state, so the dashboard stays consistent with the
// real ban status. If the local seeding fails after a successful Reddit
// ban, we still record the registry entry — better to have a stale corpus
// than to lose the audit trail.
api.post('/ban-user', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  const subredditName = getTargetSubredditName(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }

  const bodyRaw = await c.req.json().catch(() => ({}));
  const parsed = banUserSchema.safeParse(bodyRaw);
  if (!parsed.success) {
    return c.json<ErrorResponse>({ success: false, error: 'invalid_ban_payload' }, 400);
  }
  const { username, durationDays, reason } = parsed.data;

  const modId = (await reddit.getCurrentUsername()) || 'unknown_mod';
  const today = new Date().toISOString().slice(0, 10);
  const finalReason =
    reason && reason.length > 0
      ? reason
      : `Banned via Modecule on ${today} by u/${modId}`;

  // 1. Reddit ban (the source of truth). duration omitted = permanent.
  try {
    await reddit.banUser({
      username,
      subredditName,
      reason: finalReason,
      ...(typeof durationDays === 'number' && durationDays > 0 ? { duration: durationDays } : {}),
    });
  } catch (error) {
    console.error('reddit.banUser failed', error);
    return c.json<ErrorResponse>(
      { success: false, error: 'reddit_ban_failed' },
      500
    );
  }

  // 2. Local registry + corpus seed. Clear any stale signals for this user
  // before seeding so re-bans are clean.
  await removeBannedUserSignals(subredditId, username);
  await addBannedUser(subredditId, {
    authorName: username,
    bannedAt: Date.now(),
    bannedBy: modId,
    durationDays: typeof durationDays === 'number' && durationDays > 0 ? durationDays : undefined,
    reason: finalReason,
  });
  const seed = await seedBannedUserCorpus(subredditId, username);

  return c.json({ success: true, seeded: seed.added });
});

// Unban a user on Reddit and clear their signals from the per-user corpus.
// Symmetric atomicity rules to /ban-user: Reddit call first, local mutation
// only if the Reddit call succeeded.
api.post('/unban-user', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  const subredditName = getTargetSubredditName(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }

  const bodyRaw = await c.req.json().catch(() => ({}));
  const parsed = unbanUserSchema.safeParse(bodyRaw);
  if (!parsed.success) {
    return c.json<ErrorResponse>({ success: false, error: 'invalid_unban_payload' }, 400);
  }
  const { username } = parsed.data;

  try {
    await reddit.unbanUser(username, subredditName);
  } catch (error) {
    console.error('reddit.unbanUser failed', error);
    return c.json<ErrorResponse>(
      { success: false, error: 'reddit_unban_failed' },
      500
    );
  }

  await removeBannedUser(subredditId, username);
  const cleared = await removeBannedUserSignals(subredditId, username);

  return c.json({ success: true, cleared: cleared.removed });
});

api.get('/banned-users', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }
  const list = await readBannedUsers(subredditId);
  return c.json({ success: true, bannedUsers: list });
});

api.get('/debug/last-report-event', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  const raw = await redis.get(`debug:last_report_event:${subredditId}`);
  return c.json({ success: true, event: raw ? JSON.parse(raw) : null });
});

api.get('/user-stats', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }
  const username = c.req.query('username');
  if (!username) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_username' }, 400);
  }

  // Read author action history
  const authorKey = `author:actions:${subredditId}:${username}`;
  const raw = await redis.get(authorKey);
  const actions: Array<{ postId: string; action: string; score: number; timestamp: number }> = raw ? JSON.parse(raw) : [];

  // Enrich with titles from score records
  const posts = await Promise.all(
    actions.map(async (a) => {
      const rec = await readScoreRecord(subredditId, a.postId);
      return { postId: a.postId, title: rec?.title ?? a.postId, action: a.action, score: a.score, timestamp: a.timestamp, reasons: rec?.reasons ?? [] };
    })
  );

  const approved = posts.filter((p) => p.action === 'approve');
  const removed = posts.filter((p) => p.action === 'remove');

  // Get reported posts by this author (check both report meta and score records)
  const allReported = await readReportedPosts(subredditId, 'all');
  const userReported: typeof allReported = [];
  for (const r of allReported) {
    if (r.authorName === username) {
      userReported.push(r);
    } else if (r.authorName === 'unknown') {
      const rec = await readScoreRecord(subredditId, r.postId);
      if (rec?.authorName === username) userReported.push(r);
    }
  }

  // Get reports filed by this user is intentionally not supported.
  // Reddit anonymizes the identity of regular user reports at the platform
  // level, so this metric cannot be reliably attributed and was removed
  // to avoid misleading data.

  const banned = await isUserBanned(subredditId, username);

  return c.json({
    success: true,
    username,
    isBanned: banned,
    counts: { approved: approved.length, removed: removed.length, reportsReceived: userReported.length },
    posts: { approved, removed },
    reportedPosts: await Promise.all(userReported.map(async (r) => {
      const rec = await readScoreRecord(subredditId, r.postId);
      return { postId: r.postId, title: r.title, reportCount: r.reportCount, lastReportedAt: r.lastReportedAt, status: r.status, score: rec?.score ?? 0.5, reasons: rec?.reasons ?? [] };
    })),
  });
});

api.post('/rescore', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }

  const { postId } = await c.req.json<{ postId: string }>();
  if (!postId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_post_id' }, 400);
  }

  const rec = await readScoreRecord(subredditId, postId);
  if (!rec) {
    return c.json<ErrorResponse>({ success: false, error: 'score_record_not_found' }, 404);
  }

  try {
    const updated = await scoreContent(subredditId, {
      postId: rec.postId, title: rec.title, body: rec.body,
      authorName: rec.authorName, accountAgeDays: rec.accountAgeDays,
      karma: rec.karma, reportCount: rec.reportCount, priorFlagsInSub: rec.priorFlagsInSub,
    }, { forceRescore: true });
    return c.json({ success: true, post: { id: updated.postId, score: updated.score, reasons: updated.reasons, label: updated.label } });
  } catch {
    return c.json<ErrorResponse>({ success: false, error: 'rescore_failed' }, 500);
  }
});

api.post('/score-content', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }

  const body = await c.req.json<ScoreContentRequest>();
  const record = await scoreContent(subredditId, body);
  return c.json<ScoreContentResponse>({ success: true, record });
});

api.post('/action/approve', async (c) => {
  const body = await c.req.json<ActionRequest>();
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  const result = await applyAction(
    {
      ...body,
      subredditId: body.subredditId || subredditId || '',
      modId: body.modId || (await reddit.getCurrentUsername()) || 'unknown_mod',
    },
    'approve'
  );
  return c.json<ActionResponse>(result);
});

api.post('/action/remove', async (c) => {
  const body = await c.req.json<ActionRequest>();
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  const result = await applyAction(
    {
      ...body,
      subredditId: body.subredditId || subredditId || '',
      modId: body.modId || (await reddit.getCurrentUsername()) || 'unknown_mod',
    },
    'remove'
  );
  return c.json<ActionResponse>(result);
});

api.post('/action/claim', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }

  const body = await c.req.json<{ postId: string }>();
  const modId = (await reddit.getCurrentUsername()) ?? 'unknown_mod';
  const score = await readScoreRecord(subredditId, body.postId);

  await writeAuditEntry({
    postId: body.postId,
    subredditId,
    action: 'claim',
    modId,
    timestamp: Date.now(),
    score: score?.score ?? 0.5,
    reasons: ['claimed_for_review'],
    postTitle: score?.title ?? body.postId,
    scoreSource: score?.scoreSource,
  });

  return c.json<ActionResponse>({ success: true });
});

api.post('/action/escalate', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }

  const body = await c.req.json<{ postId: string; reason: string }>();
  const modId = (await reddit.getCurrentUsername()) ?? 'unknown_mod';
  const score = await readScoreRecord(subredditId, body.postId);

  await writeAuditEntry({
    postId: body.postId,
    subredditId,
    action: 'escalate',
    modId,
    timestamp: Date.now(),
    score: score?.score ?? 0.5,
    reasons: [body.reason || 'manual_escalation'],
    postTitle: score?.title ?? body.postId,
    scoreSource: score?.scoreSource,
  });

  return c.json<ActionResponse>({ success: true });
});

api.get('/bulk/preview', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }

  const rules = await readRules(subredditId);
  const queue = await readQueueItems(subredditId, 500);
  let candidates = queue.filter(
    (item) => item.score >= rules.autoRemoveThreshold || item.score <= rules.autoApproveThreshold
  );
  if (candidates.length === 0) {
    candidates = queue.filter(
      (item) => item.suggested_action === 'approve' || item.suggested_action === 'remove'
    );
  }
  return c.json<BulkPreviewResponse>({ success: true, candidates });
});

api.post('/bulk/apply', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }
  const payload = await c.req.json<{ modId: string }>();
  const rules = await readRules(subredditId);
  const queue = await readQueueItems(subredditId, 500);
  const candidates = queue.filter(
    (item) => item.score >= rules.autoRemoveThreshold || item.score <= rules.autoApproveThreshold
  );

  let updated = 0;
  for (const candidate of candidates) {
    if (candidate.suggested_action !== 'approve' && candidate.suggested_action !== 'remove') {
      continue;
    }

    const result = await applyAction(
      {
        postId: candidate.postId,
        subredditId,
        modId: payload.modId,
        reason: 'bulk_smart_action',
      },
      candidate.suggested_action
    );

    if (result.success) {
      updated += 1;
    }
  }

  return c.json<BulkApplyResponse>({ success: true, updated });
});
