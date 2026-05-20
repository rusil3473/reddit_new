import type {
  ModerationRules,
  RiskLabel,
  ScoreContentRequest,
  SuggestedAction,
} from '../../shared/mod';

// TODO: Move these back to environment variables before production release.
const HARDCODED_GEMINI_API_KEY = 'AIzaSyCuwWVpL1XNTObTXhoaozF-a3rdpvYTog8';
const HARDCODED_GEMINI_MODEL = 'gemini-2.5-flash';
const HARDCODED_GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta';

type GeminiScore = {
  score: number;
  label: RiskLabel;
  reasons: string[];
  suggested_action: SuggestedAction;
};

const fallbackScore: GeminiScore = {
  score: 0.5,
  label: 'borderline',
  reasons: ['model_response_parse_failed'],
  suggested_action: 'review',
};

const sanitizeJsonText = (value: string): string => {
  return value
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
};

const clamp = (n: number): number => Math.max(0, Math.min(1, n));

const normalize = (input: Partial<GeminiScore>): GeminiScore => {
  const label: RiskLabel =
    input.label === 'low_risk' ||
    input.label === 'high_risk' ||
    input.label === 'borderline'
      ? input.label
      : 'borderline';

  const suggested_action: SuggestedAction =
    input.suggested_action === 'approve' ||
    input.suggested_action === 'remove' ||
    input.suggested_action === 'review'
      ? input.suggested_action
      : 'review';

  return {
    score: clamp(typeof input.score === 'number' ? input.score : 0.5),
    label,
    reasons: Array.isArray(input.reasons)
      ? input.reasons.slice(0, 6)
      : ['insufficient_reasons'],
    suggested_action,
  };
};

export const scoreWithGemini = async (
  request: ScoreContentRequest,
  rules: ModerationRules
): Promise<GeminiScore> => {
  const apiKey = HARDCODED_GEMINI_API_KEY;
  const model = HARDCODED_GEMINI_MODEL;
  const baseUrl = HARDCODED_GEMINI_BASE_URL;

  if (!apiKey) {
    return { ...fallbackScore, reasons: ['gemini_api_key_missing'] };
  }

  const prompt = [
    'You are a Reddit moderation risk scoring engine.',
    'Return ONLY JSON. No markdown. No code fences. No explanation text.',
    'JSON shape must be exactly: {"score":0.82,"label":"high_risk","reasons":["..."],"suggested_action":"remove"}',
    'label must be one of: low_risk, borderline, high_risk.',
    'suggested_action must be one of: approve, review, remove.',
    'Score must be a decimal between 0.0 and 1.0.',
    `postId: ${request.postId}`,
    `title: ${request.title}`,
    `body: ${request.body}`,
    `authorName: ${request.authorName}`,
    `accountAgeDays: ${request.accountAgeDays}`,
    `karma: ${request.karma}`,
    `reportCount: ${request.reportCount}`,
    `priorFlagsInSub: ${request.priorFlagsInSub}`,
    `autoApproveThreshold: ${rules.autoApproveThreshold}`,
    `autoRemoveThreshold: ${rules.autoRemoveThreshold}`,
    `communityRules: ${rules.communityRules.join(' | ')}`,
  ].join('\n');

  try {
    const normalizedModel = model.startsWith('models/')
      ? model
      : `models/${model}`;
    const response = await fetch(
      `${baseUrl}/${normalizedModel}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      return {
        ...fallbackScore,
        reasons: [`gemini_http_${response.status}`, errText.slice(0, 120)],
      };
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleanText = sanitizeJsonText(rawText);
    const parsed = JSON.parse(cleanText) as Partial<GeminiScore>;

    return normalize(parsed);
  } catch (error) {
    return {
      ...fallbackScore,
      reasons: [
        error instanceof Error
          ? `gemini_exception:${error.message.slice(0, 120)}`
          : 'gemini_exception_unknown',
      ],
    };
  }
};
