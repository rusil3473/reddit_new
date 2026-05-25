import type { ModerationRules, ScoreContentRequest } from '../../../shared/mod';
import type { LLMScore } from '../llm-router';
import { LLM_CONFIG } from '../config';
import { buildPrompt, normalize, scoreWithGemini } from './gemini';

export const scoreWithHuggingFace = async (
  request: ScoreContentRequest,
  rules: ModerationRules
): Promise<LLMScore> => {
  const { apiToken, model, baseUrl } = LLM_CONFIG.huggingface;

  if (!apiToken) {
    console.warn('[HF] No apiToken set, falling back to Gemini');
    return scoreWithGemini(request, rules);
  }

  const prompt = buildPrompt(request, rules);

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
      }),
    });

    if (!response.ok) {
      console.warn(`[HF] HTTP ${response.status}, falling back to Gemini`);
      return scoreWithGemini(request, rules);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawText = data.choices?.[0]?.message?.content ?? '';

    const jsonMatch = rawText.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      console.warn('[HF] No JSON in response, falling back to Gemini');
      return scoreWithGemini(request, rules);
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<LLMScore>;
    return normalize(parsed);
  } catch (error) {
    console.warn(`[HF] Exception: ${error instanceof Error ? error.message : 'unknown'}, falling back to Gemini`);
    return scoreWithGemini(request, rules);
  }
};
