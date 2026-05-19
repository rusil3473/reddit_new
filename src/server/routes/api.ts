import { Hono } from 'hono';
import { context, reddit } from '@devvit/web/server';
import type {
  ActionResponse,
  BulkActionRequest,
  ClaimRequest,
  DashboardResponse,
} from '../../shared/mod';
import { applyManualAction } from '../mod/pipeline';
import { claimItem, getQueueItems, getQueueLength } from '../mod/store';

type ErrorResponse = {
  status: 'error';
  message: string;
};

export const api = new Hono();

const highRisk = (score: number): boolean => score >= 0.8;

api.get('/dashboard', async (c) => {
  const subredditId = context.subredditId;
  if (!subredditId) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Missing subredditId' }, 400);
  }

  const [items, queueLength] = await Promise.all([
    getQueueItems(subredditId, 100),
    getQueueLength(subredditId),
  ]);

  const highRiskCount = items.filter((item) => highRisk(item.riskScore)).length;
  const violationMap = new Map<string, number>();

  for (const item of items) {
    for (const regex of item.signals.regexMatches) {
      violationMap.set(regex, (violationMap.get(regex) ?? 0) + 1);
    }
  }

  const topViolationTypes = [...violationMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  return c.json<DashboardResponse>({
    type: 'dashboard',
    queueLength,
    highRiskCount,
    topViolationTypes,
    items,
  });
});

api.post('/claim', async (c) => {
  const subredditId = context.subredditId;
  const modId = (await reddit.getCurrentUsername()) ?? 'unknown_mod';
  if (!subredditId) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Missing subredditId' }, 400);
  }

  const body = await c.req.json<ClaimRequest>();
  const ok = await claimItem(subredditId, body.itemId, modId);
  if (!ok) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Already claimed by another mod' }, 409);
  }

  return c.json<ActionResponse>({ status: 'ok', updated: 1 });
});

api.post('/action/:itemId/:action', async (c) => {
  const subredditId = context.subredditId;
  const modId = (await reddit.getCurrentUsername()) ?? 'unknown_mod';
  if (!subredditId) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Missing subredditId' }, 400);
  }

  const itemId = c.req.param('itemId');
  const action = c.req.param('action');

  if (action !== 'approve' && action !== 'remove') {
    return c.json<ErrorResponse>({ status: 'error', message: 'Invalid action' }, 400);
  }

  const ok = await applyManualAction(subredditId, itemId, action, modId);
  if (!ok) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Item not found' }, 404);
  }

  return c.json<ActionResponse>({ status: 'ok', updated: 1 });
});

api.post('/bulk', async (c) => {
  const subredditId = context.subredditId;
  const modId = (await reddit.getCurrentUsername()) ?? 'unknown_mod';
  if (!subredditId) {
    return c.json<ErrorResponse>({ status: 'error', message: 'Missing subredditId' }, 400);
  }

  const body = await c.req.json<BulkActionRequest>();
  const items = await getQueueItems(subredditId, body.maxItems);
  const candidates = items.filter((item) => {
    return body.action === 'remove'
      ? item.riskScore >= body.minConfidence
      : item.riskScore <= body.minConfidence;
  });

  let updated = 0;
  for (const item of candidates) {
    const ok = await applyManualAction(subredditId, item.itemId, body.action, modId);
    if (ok) {
      updated += 1;
    }
  }

  return c.json<ActionResponse>({ status: 'ok', updated });
});
