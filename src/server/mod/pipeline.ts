import { reddit } from '@devvit/web/server';
import type { ActionRequest, ScoreContentRequest, ScoreRecord } from '../../shared/mod';
import { scoreWithGemini } from './llm';
import {
  incrementActionStats,
  markReportedPostProcessed,
  readRules,
  readScoreRecord,
  removeFromQueue,
  writeAuditEntry,
  writeScoreRecord,
} from './store';

const toThingId = (id: string): `t3_${string}` => {
  if (id.startsWith('t3_')) {
    return id as `t3_${string}`;
  }
  return `t3_${id}`;
};

const removePost = async (tid: `t3_${string}`): Promise<void> => {
  try {
    await reddit.remove(tid, false);
    return;
  } catch {
    await reddit.remove(tid, true);
  }
};

export const scoreContent = async (
  subredditId: string,
  payload: ScoreContentRequest
): Promise<ScoreRecord> => {
  const rules = await readRules(subredditId);
  const modelResult = await scoreWithGemini(payload, rules);
  const record: ScoreRecord = {
    ...payload,
    subredditId,
    score: modelResult.score,
    label: modelResult.label,
    reasons: modelResult.reasons,
    suggested_action: modelResult.suggested_action,
    createdAt: Date.now(),
  };

  await writeScoreRecord(record);
  await writeAuditEntry({
    postId: record.postId,
    subredditId,
    action: 'score',
    modId: 'system',
    timestamp: Date.now(),
    score: record.score,
    reasons: record.reasons,
    postTitle: record.title,
  });

  return record;
};

export const applyAction = async (
  input: ActionRequest,
  action: 'approve' | 'remove'
): Promise<{ success: boolean; error?: string }> => {
  try {
    const score = await readScoreRecord(input.subredditId, input.postId);
    const tid = toThingId(input.postId);

    if (action === 'approve') {
      await reddit.approve(tid);
    } else {
      await removePost(tid);
    }

    await Promise.all([
      removeFromQueue(input.subredditId, input.postId),
      markReportedPostProcessed(input.subredditId, input.postId, action),
      incrementActionStats(input.subredditId, action),
      writeAuditEntry({
        postId: input.postId,
        subredditId: input.subredditId,
        action,
        modId: input.modId,
        timestamp: Date.now(),
        score: score?.score ?? 0.5,
        reasons: score?.reasons ?? [input.reason],
        postTitle: score?.title ?? input.postId,
      }),
    ]);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'unknown_error',
    };
  }
};
