import { reddit } from '@devvit/web/server';
import type { EnqueuePayload, QueueItem } from '../../shared/mod';
import { scoreItem } from './scoring';
import {
  getRules,
  incrementPriorFlags,
  logAudit,
  putQueueItem,
  readItem,
  removeFromQueue,
  setItem,
} from './store';

const toThingId = (id: string, kind: 'post' | 'comment'): `t1_${string}` | `t3_${string}` => {
  if (id.startsWith('t1_') || id.startsWith('t3_')) {
    return id as `t1_${string}` | `t3_${string}`;
  }
  return (kind === 'comment' ? `t1_${id}` : `t3_${id}`) as `t1_${string}` | `t3_${string}`;
};

const maybeApprove = async (itemId: string, kind: 'post' | 'comment'): Promise<void> => {
  try {
    await reddit.approve(toThingId(itemId, kind));
  } catch {
    // no-op when unavailable in local mocks
  }
};

const maybeRemove = async (itemId: string, kind: 'post' | 'comment'): Promise<void> => {
  try {
    await reddit.remove(toThingId(itemId, kind), true);
  } catch {
    // no-op when unavailable in local mocks
  }
};

export const ingestAndScore = async (payload: EnqueuePayload): Promise<QueueItem> => {
  const rules = await getRules(payload.subredditId);
  const item = await scoreItem(payload, rules.regexRules);

  if (item.riskScore >= rules.autoRemoveThreshold) {
    await maybeRemove(item.itemId, item.contentKind);
    item.status = 'auto_removed';
    item.modAction = 'remove';
    await incrementPriorFlags(item.subredditId, item.authorId);
  } else if (item.riskScore <= rules.autoApproveThreshold) {
    await maybeApprove(item.itemId, item.contentKind);
    item.status = 'auto_approved';
    item.modAction = 'approve';
  }

  await putQueueItem(item);
  await logAudit(item.subredditId, {
    type: 'ingest',
    itemId: item.itemId,
    riskScore: String(item.riskScore),
    status: item.status,
    ts: String(Date.now()),
  });

  return item;
};

export const applyManualAction = async (
  subredditId: string,
  itemId: string,
  action: 'approve' | 'remove',
  modId: string
): Promise<boolean> => {
  const item = await readItem(subredditId, itemId);
  if (!item) {
    return false;
  }

  if (action === 'approve') {
    await maybeApprove(itemId, item.contentKind);
  } else {
    await maybeRemove(itemId, item.contentKind);
    await incrementPriorFlags(item.subredditId, item.authorId);
  }

  item.status = 'reviewed';
  item.modAction = action;
  item.claimedBy = modId;
  item.claimedAt = Date.now();

  await Promise.all([
    setItem(item),
    removeFromQueue(subredditId, itemId),
    logAudit(subredditId, {
      type: 'manual_action',
      itemId,
      action,
      modId,
      ts: String(Date.now()),
    }),
  ]);

  return true;
};
