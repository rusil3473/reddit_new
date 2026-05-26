import { reddit, redis } from '@devvit/web/server';
import type { ActionRequest, BanEvasionMatch, BannedUserMatch, ScoreContentRequest, ScoreRecord, ScoreSource } from '../../shared/mod';
import { extractFingerprint, jaccardSimilarity, scoreWithLearning, type LearningSignal } from './llm';
import {
  addBannedSignal,
  isSiqPostId,
  incrementActionStats,
  markReportedPostProcessed,
  readBannedSignals,
  readBannedUserSignals,
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

// detectBannedUserMatch is parallel to detectBanEvasion but scans the
// per-banned-user signal corpus rather than the aggregate removal corpus.
// A hit means the candidate post's content resembles a removed post of a
// user a moderator has explicitly banned via the dashboard. Stronger
// signal — the banned-user banner takes visual precedence in the UI when
// both this and detectBanEvasion fire on the same post.
const detectBannedUserMatch = async (
  subredditId: string,
  payload: ScoreContentRequest,
  threshold: number
): Promise<BannedUserMatch | undefined> => {
  const fingerprint = extractFingerprint(payload.title, payload.body);
  if (fingerprint.length === 0) return undefined;

  const signals = await readBannedUserSignals(subredditId);
  if (signals.length === 0) return undefined;

  let best: { sim: number; signal: typeof signals[number] } | undefined;
  for (const signal of signals) {
    // Defensive self-match guard: if a banned user re-registers under the
    // same name, do not flag their own signals.
    if (signal.bannedUserName === payload.authorName) continue;
    const sim = jaccardSimilarity(fingerprint, signal.fingerprint);
    if (!best || sim > best.sim) {
      best = { sim, signal };
    }
  }

  if (!best || best.sim < threshold) return undefined;

  return {
    matchedAuthor: best.signal.bannedUserName,
    matchedPostId: best.signal.postId,
    similarity: best.sim,
    threshold,
    timestamp: Date.now(),
  };
};

// detectBanEvasion compares a candidate post's fingerprint against the
// per-subreddit banned-signals corpus and returns the best match if its
// Jaccard similarity meets or exceeds the rules threshold.
//
// Self-match guard: signals authored by the same user as the candidate
// are excluded — repeat behavior by the same author is already handled
// by the learning loop, and we do not want a user matching themselves.
const detectBanEvasion = async (
  subredditId: string,
  payload: ScoreContentRequest,
  threshold: number
): Promise<BanEvasionMatch | undefined> => {
  const fingerprint = extractFingerprint(payload.title, payload.body);
  if (fingerprint.length === 0) return undefined;

  const signals = await readBannedSignals(subredditId);
  if (signals.length === 0) return undefined;

  let best: { sim: number; signal: typeof signals[number] } | undefined;
  for (const signal of signals) {
    if (signal.authorName === payload.authorName) continue;
    const sim = jaccardSimilarity(fingerprint, signal.fingerprint);
    if (!best || sim > best.sim) {
      best = { sim, signal };
    }
  }

  if (!best || best.sim < threshold) return undefined;

  return {
    matchedAuthor: best.signal.authorName,
    matchedPostId: best.signal.postId,
    similarity: best.sim,
    threshold,
    timestamp: Date.now(),
  };
};

export const scoreContent = async (
  subredditId: string,
  payload: ScoreContentRequest,
  options?: { forceRescore?: boolean }
): Promise<ScoreRecord> => {
  const existing = await readScoreRecord(subredditId, payload.postId);
  if (!options?.forceRescore && existing && payload.reportCount <= existing.reportCount) {
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

  // Ban-evasion match is informational only: it appends a reason and
  // attaches metadata for the queue UI. It does NOT force suggested_action
  // and does NOT alter the score. Skip the work entirely for SIQ posts.
  const banEvasion = siqPost
    ? undefined
    : await detectBanEvasion(subredditId, payload, rules.banEvasionThreshold);

  // Banned-user match: a stronger, explicitly-mod-curated signal. When
  // present, the generic ban-evasion reason is suppressed to avoid
  // duplicating a similar message; the banned-user reason is more useful
  // because it identifies the specific banned user.
  const bannedUserMatch = siqPost
    ? undefined
    : await detectBannedUserMatch(subredditId, payload, rules.banEvasionThreshold);

  const forcedScore = scamOverride.hit ? Math.max(modelResult.score, 0.92) : modelResult.score;
  const forcedLabel = forcedScore >= 0.6 ? 'high_risk' : modelResult.label;
  const baseReasons = scamOverride.hit
    ? ['Safety override: critical scam pattern detected', ...scamOverride.reasons, ...modelResult.reasons]
    : [...modelResult.reasons];
  if (bannedUserMatch) {
    const pct = Math.round(bannedUserMatch.similarity * 100);
    baseReasons.push(
      `Matches removed posts of banned u/${bannedUserMatch.matchedAuthor} (${pct}%)`
    );
  } else if (banEvasion) {
    const pct = Math.round(banEvasion.similarity * 100);
    baseReasons.push(`Possible ban evasion: ${pct}% match with u/${banEvasion.matchedAuthor}`);
  }
  const mergedReasons = baseReasons.slice(0, 4);
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
    banEvasionMatch: siqPost ? undefined : banEvasion,
    bannedUserMatch: siqPost ? undefined : bannedUserMatch,
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

    // On remove, add this post to the per-subreddit banned-signals corpus
    // so future scoring can detect ban-evasion attempts. Treats removal-by-mod
    // as the proxy for "banned-author content" — see store.ts comment.
    if (action === 'remove' && score) {
      await addBannedSignal(input.subredditId, {
        authorName: score.authorName,
        postId: score.postId,
        title: score.title,
        fingerprint: extractFingerprint(score.title, score.body),
        timestamp: Date.now(),
      });
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
