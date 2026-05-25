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
  readAuditEntriesPaged,
  readQueueItems,
  readReportedPosts,
  readScoreRecord,
  readSummaryStats,
  readRules,
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
  communityRules: z.array(z.string().min(1)).max(200),
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
  difficulty: 'easy' | 'medium' | 'hard' | 'legendary';
  reasons: string[];
  reportCount: number;
  createdAt: string;
  type: 'post' | 'comment';
  confidence: number;
};

const difficultyFromScore = (
  score: number
): 'easy' | 'medium' | 'hard' | 'legendary' => {
  if (score < 0.3) {
    return 'easy';
  }
  if (score <= 0.6) {
    return 'medium';
  }
  if (score <= 0.85) {
    return 'hard';
  }
  return 'legendary';
};

api.get('/queue', async (c) => {
  const subredditId = await getSubredditId(c.req.query('subreddit'));
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }

  const queue = await readQueueItems(subredditId, 200, 0);
  const posts = await Promise.all(
    queue.map(async (item) => {
      const scoreRecord = await readScoreRecord(subredditId, item.postId);
      return {
        id: item.postId,
        title: item.title,
        author: item.authorName,
        score: item.score,
        difficulty: difficultyFromScore(item.score),
        reasons: item.reasons,
        reportCount: item.reportCount,
        createdAt: new Date(scoreRecord?.createdAt ?? Date.now()).toISOString(),
        type: 'post' as const,
        confidence: scoreRecord?.confidence ?? 0.4,
      };
    })
  );
  const filtered = posts.filter((p) => !p.title.includes('Smart Intelligent Queue Dashboard'));
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
  const posts: QueueApiPost[] = items.map((item) => ({
    id: item.postId,
    title: item.title,
    author: item.authorName,
    score: item.score,
    difficulty: difficultyFromScore(item.score),
    reasons: item.reasons,
    reportCount: item.reportCount,
    createdAt: new Date().toISOString(),
    type: 'post',
    confidence: 0.4,
  }));
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
  await Promise.all([
    redis.incrBy(keyProcessed, 1),
    redis.incrBy(body.action === 'remove' ? keyRemoved : keyApproved, 1),
  ]);
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
  const filteredCount = queue.filter((item) => !item.title.includes('Smart Intelligent Queue Dashboard')).length;

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

  await Promise.all([
    redis.incrBy(keyProcessed, 1),
    redis.incrBy(body.action === 'remove' ? keyRemoved : keyApproved, 1),
  ]);

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

  if (updated > 0) {
    await Promise.all([
      redis.incrBy(keyProcessed, updated),
      redis.incrBy(body.action === 'remove' ? keyRemoved : keyApproved, updated),
    ]);
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
    metas.map(async (meta) => ({
      meta,
      score: await readScoreRecord(subredditId, meta.postId),
    }))
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
    communityRules: body.communityRules,
  });
  return c.json<RulesResponse>({ success: true, rules: await readRules(subredditId) });
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
