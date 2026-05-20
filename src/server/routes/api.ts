import { Hono } from 'hono';
import { context, reddit } from '@devvit/web/server';
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
import {
  readAuditEntriesPaged,
  readQueueItems,
  readReportedPosts,
  readScoreRecord,
  readSummaryStats,
  readRules,
  writeRules,
  writeAuditEntry,
} from '../mod/store';

type ErrorResponse = { success: false; error: string };

export const api = new Hono();

const getSubredditId = (): string | null => context.subredditId ?? null;
const rulesSchema = z.object({
  autoApproveThreshold: z.number().min(0).max(1),
  autoRemoveThreshold: z.number().min(0).max(1),
  communityRules: z.array(z.string().min(1)).max(200),
});

api.get('/dashboard', async (c) => {
  const subredditId = getSubredditId();
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
  const subredditId = getSubredditId();
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
  const subredditId = getSubredditId();
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
  const subredditId = getSubredditId();
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }
  const rules = await readRules(subredditId);
  return c.json<RulesResponse>({ success: true, rules });
});

api.post('/rules', async (c) => {
  const subredditId = getSubredditId();
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
  const subredditId = getSubredditId();
  if (!subredditId) {
    return c.json<ErrorResponse>({ success: false, error: 'missing_subreddit_id' }, 400);
  }

  const body = await c.req.json<ScoreContentRequest>();
  const record = await scoreContent(subredditId, body);
  return c.json<ScoreContentResponse>({ success: true, record });
});

api.post('/action/approve', async (c) => {
  const body = await c.req.json<ActionRequest>();
  const subredditId = getSubredditId();
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
  const subredditId = getSubredditId();
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
  const subredditId = getSubredditId();
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
  });

  return c.json<ActionResponse>({ success: true });
});

api.post('/action/escalate', async (c) => {
  const subredditId = getSubredditId();
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
  });

  return c.json<ActionResponse>({ success: true });
});

api.get('/bulk/preview', async (c) => {
  const subredditId = getSubredditId();
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
  const subredditId = getSubredditId();
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
