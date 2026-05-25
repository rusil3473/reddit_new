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

export const scoreLLM = async (
  request: ScoreContentRequest,
  rules: ModerationRules
): Promise<LLMScore> => {
  let base;
  switch (LLM_CONFIG.provider) {
    case 'huggingface':
      base = await scoreWithHuggingFace(request, rules);
      break;
    case 'local':
      base = await scoreWithGemini(request, rules);
      break;
    case 'gemini':
    default:
      base = await scoreWithGemini(request, rules);
  }
  return { ...base, confidence: base.confidence ?? 0.4 };
};
