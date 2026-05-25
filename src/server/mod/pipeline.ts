import { reddit, redis } from '@devvit/web/server';
import type { ActionRequest, ScoreContentRequest, ScoreRecord, ScoreSource } from '../../shared/mod';
import { scoreWithLearning, type LearningSignal } from './llm';
import {
  isSiqPostId,
  incrementActionStats,
  markReportedPostProcessed,
  readRules,
  readScoreRecord,
  removeFromQueue,
  writeAuditEntry,
  writeScoreRecord,
} from './store';

const detectCriticalScam = (title: string, body: string): { hit: boolean; reasons: string[] } => {
  const text = `${title} ${body}`.toLowerCase();
  const reasons: string[] = [];

  const hasDoubleCrypto = /double\s+.*crypto|crypto\s+.*double/.test(text);
  const hasCodeRequest =
    /12\s*codes|verification\s*code|otp|seed\s*phrase|recovery\s*phrase|wallet\s*key/.test(text);
  const hasDmHarvest = /dm\s+me|message\s+me\s+for/.test(text);
  const hasAccountTakeover = /give\s+me\s+your\s+account|i\s+can\s+access|hacking\s+account/.test(text);

  if (hasDoubleCrypto) {
    reasons.push('Crypto doubling scam language');
  }
  if (hasCodeRequest) {
    reasons.push('Credential/code harvesting language');
  }
  if (hasDmHarvest) {
    reasons.push('DM solicitation pattern');
  }
  if (hasAccountTakeover) {
    reasons.push('Account takeover intent');
  }

  return { hit: reasons.length > 0, reasons };
};
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
  const existing = await readScoreRecord(subredditId, payload.postId);
  if (existing && payload.reportCount <= existing.reportCount) {
    const currentSignalCount = await redis.zCard(`learning:signals:${subredditId}`);
    if (currentSignalCount - (existing.signalCountAtScoring ?? 0) <= 10) {
      return existing;
    }
  }

  const siqPost = await isSiqPostId(subredditId, payload.postId);
  const rules = await readRules(subredditId);

  const rawSignals = await redis.zRange(`learning:signals:${subredditId}`, 0, -1);
  const pastSignals: LearningSignal[] = rawSignals
    .map(s => { try { return JSON.parse(typeof s === 'string' ? s : s.member); } catch { return null; } })
    .filter((s): s is LearningSignal => s !== null);

  const modelResult = await scoreWithLearning(payload, rules, pastSignals);
  const scamOverride = detectCriticalScam(payload.title, payload.body);

  const forcedScore = scamOverride.hit ? Math.max(modelResult.score, 0.92) : modelResult.score;
  const forcedLabel = forcedScore >= 0.6 ? 'high_risk' : modelResult.label;
  const mergedReasons = scamOverride.hit
    ? ['Safety override: critical scam pattern detected', ...scamOverride.reasons, ...modelResult.reasons].slice(0, 4)
    : modelResult.reasons;
  const forcedSuggestedAction = scamOverride.hit ? 'remove' : modelResult.suggested_action;

  const finalSuggestedAction = siqPost ? 'approve' : forcedSuggestedAction;
  const finalReasons = siqPost
    ? ['siq_dashboard_post_auto_approved']
    : mergedReasons;

  const scoreSource: ScoreSource = siqPost
    ? 'siq_auto_approve'
    : scamOverride.hit
      ? 'safety_override'
      : pastSignals.length > 0
        ? 'gemini+learning'
        : 'gemini';

  const record: ScoreRecord = {
    ...payload,
    subredditId,
    score: forcedScore,
    label: forcedLabel,
    reasons: finalReasons,
    suggested_action: finalSuggestedAction,
    createdAt: Date.now(),
    signalCountAtScoring: pastSignals.length,
    confidence: modelResult.confidence,
    scoreSource,
  };

  await writeScoreRecord(record, { enqueue: !siqPost });
  if (siqPost) {
    await reddit.approve(toThingId(payload.postId));
  }

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
        scoreSource: score?.scoreSource,
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
