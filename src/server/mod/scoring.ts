import { reddit } from '@devvit/web/server';
import type { EnqueuePayload, QueueItem, SignalBreakdown } from '../../shared/mod';
import { analyzeTextWithModel } from './llm';
import { getPriorFlags } from './store';

const riskCap = (value: number): number => Math.max(0, Math.min(1, value));

const regexRiskFromRules = (text: string, rules: string[]): { matches: string[]; score: number } => {
  const matches = rules.filter((rule) => new RegExp(rule, 'i').test(text));
  return {
    matches,
    score: Math.min(0.35, matches.length * 0.2),
  };
};

const safeGetAuthorMetrics = async (authorName: string): Promise<{ accountAgeDays: number; karma: number }> => {
  try {
    const user = await reddit.getUserByUsername(authorName);
    if (!user) {
      return { accountAgeDays: 365, karma: 1000 };
    }

    const createdAt = user.createdAt.getTime();
    const ageDays = Math.floor((Date.now() - createdAt) / (1000 * 60 * 60 * 24));
    const karma = (user.linkKarma ?? 0) + (user.commentKarma ?? 0);
    return { accountAgeDays: Math.max(ageDays, 0), karma };
  } catch {
    return { accountAgeDays: 365, karma: 1000 };
  }
};

export const scoreItem = async (
  payload: EnqueuePayload,
  regexRules: string[]
): Promise<QueueItem> => {
  const [{ accountAgeDays, karma }, llm, priorFlags] = await Promise.all([
    safeGetAuthorMetrics(payload.authorName),
    analyzeTextWithModel(payload.contentText),
    getPriorFlags(payload.subredditId, payload.authorId),
  ]);

  const regex = regexRiskFromRules(payload.contentText, regexRules);
  const accountAgeRisk = accountAgeDays < 30 ? 0.25 : 0;
  const karmaRisk = karma < 100 ? 0.15 : 0;
  const priorFlagsRisk = Math.min(0.2, priorFlags * 0.1);
  const reportVolumeRisk = payload.reportCount > 2 ? 0.2 : payload.reportCount * 0.05;
  const crossPostAnomalyRisk = payload.contentText.length < 25 ? 0.05 : 0;
  const reputation = Math.max(0, 100 - priorFlags * 10);
  const reputationRisk = reputation < 60 ? 0.1 : 0;

  const totalScore = riskCap(
    accountAgeRisk +
      karmaRisk +
      regex.score +
      priorFlagsRisk +
      reportVolumeRisk +
      llm.llmRisk * 0.35 +
      crossPostAnomalyRisk +
      reputationRisk
  );

  const signals: SignalBreakdown = {
    accountAgeDays,
    accountAgeRisk,
    karma,
    karmaRisk,
    regexMatches: regex.matches,
    regexRisk: regex.score,
    reputation,
    reputationRisk,
    priorFlags,
    priorFlagsRisk,
    reportVolumeRisk,
    llmRisk: llm.llmRisk,
    llmReasons: llm.reasons,
    crossPostAnomalyRisk,
    totalScore,
  };

  const explanationSignals = [
    accountAgeRisk ? 'new account' : '',
    karmaRisk ? 'low karma' : '',
    regex.matches.length ? `regex match: ${regex.matches.join(', ')}` : '',
    priorFlagsRisk ? 'prior flags in subreddit' : '',
    llm.reasons[0] ?? '',
  ].filter(Boolean);

  return {
    itemId: payload.itemId,
    subredditId: payload.subredditId,
    subredditName: payload.subredditName,
    authorId: payload.authorId,
    authorName: payload.authorName,
    contentKind: payload.contentKind,
    contentText: payload.contentText,
    permalink: payload.permalink,
    createdAt: payload.createdAt,
    reportCount: payload.reportCount,
    riskScore: totalScore,
    explanation:
      explanationSignals.length > 0
        ? `Flagged because: ${explanationSignals.join('; ')}`
        : 'No strong risk indicators detected.',
    status: 'queued',
    signals,
  };
};
