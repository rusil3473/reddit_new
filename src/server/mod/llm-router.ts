import type { ModerationRules, ScoreContentRequest } from '../../shared/mod';
import { LLM_CONFIG } from './config';
import type { LLMProvider } from './config';
import { scoreWithGemini } from './providers/gemini';
import { scoreWithHuggingFace } from './providers/huggingface';

export type { LLMProvider };

export type LLMScore = {
  score: number;
  label: 'low_risk' | 'borderline' | 'high_risk';
  reasons: string[];
  suggested_action: 'approve' | 'review' | 'remove';
  confidence: number;
};

/**
 * A retrieved example of a past moderator decision in the same community.
 * Passed into the prompt as RAG context so the LLM can pattern-match
 * against community-specific moderation history.
 */
export type LLMExample = {
  action: 'approve' | 'remove';
  titleSnippet: string;
  bodySnippet: string;
  reasons: string[];
  similarity: number; // 0..1 how textually similar this past post is to the current one
  ageDays: number;
};

export const scoreLLM = async (
  request: ScoreContentRequest,
  rules: ModerationRules,
  examples?: LLMExample[]
): Promise<LLMScore> => {
  let base;
  switch (LLM_CONFIG.provider) {
    case 'huggingface':
      base = await scoreWithHuggingFace(request, rules, examples);
      break;
    case 'local':
      base = await scoreWithGemini(request, rules, examples);
      break;
    case 'gemini':
    default:
      base = await scoreWithGemini(request, rules, examples);
  }
  return { ...base, confidence: base.confidence ?? 0.4 };
};
