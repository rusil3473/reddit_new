import type { ModerationRules, ScoreContentRequest } from '../../../shared/mod';
import type { LLMScore } from '../llm-router';
import { LLM_CONFIG } from '../config';

const fallbackScore: LLMScore = {
  score: 0.5,
  label: 'borderline',
  reasons: ['model_response_parse_failed'],
  suggested_action: 'review',
  confidence: 0.4,
};

const sanitizeJsonText = (value: string): string =>
  value.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();

const extractFirstJsonObject = (value: string): string => {
  const start = value.indexOf('{');
  if (start < 0) return value;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escapeNext) { escapeNext = false; }
      else if (ch === '\\') { escapeNext = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { depth += 1; continue; }
    if (ch === '}') { depth -= 1; if (depth === 0) return value.slice(start, i + 1); }
  }
  return value.slice(start);
};

const clamp = (n: number): number => Math.max(0, Math.min(1, n));

export const normalize = (input: Partial<LLMScore>): LLMScore => {
  const label = input.label === 'low_risk' || input.label === 'high_risk' || input.label === 'borderline'
    ? input.label : 'borderline';
  const suggested_action = input.suggested_action === 'approve' || input.suggested_action === 'remove' || input.suggested_action === 'review'
    ? input.suggested_action : 'review';
  return {
    score: clamp(typeof input.score === 'number' ? input.score : 0.5),
    label,
    reasons: Array.isArray(input.reasons) ? input.reasons.slice(0, 4) : ['insufficient_reasons'],
    suggested_action,
    confidence: 0.4,
  };
};

export const buildPrompt = (request: ScoreContentRequest, rules: ModerationRules): string => [
  'You are a Reddit moderation risk scoring engine.',
  'Return ONLY JSON. No markdown. No code fences. No explanation text.',
  'JSON shape must be exactly: {"score":0.82,"label":"high_risk","reasons":["..."],"suggested_action":"remove"}',
  'label must be one of: low_risk, borderline, high_risk.',
  'suggested_action must be one of: approve, review, remove.',
  'Score must be a decimal between 0.0 and 1.0 where 0.0 means clearly approveable and 1.0 means clearly reject/remove.',
  'You must reason SEMANTICALLY, not by exact phrase matching. Detect paraphrases, obfuscations, and intent.',
  'Primary objective: detect scams, social engineering, fraud, account takeover attempts, financial exploitation, and community rule violations even when wording is novel.',
  'Critical scam/social-engineering patterns (high severity): requests for codes/OTP/seed phrase/recovery keys, promises of guaranteed returns, impersonation of trusted entities, moving users to DM for money/credentials, urgency pressure, giveaway fraud, account recovery bait, payment rerouting.',
  'For any high-severity scam/social-engineering intent, score must be high risk (typically >=0.85) and suggested_action should be remove.',
  'Use this weighted model exactly:',
  'Signal 1 Content analysis (45%): threat/hate/scam/spam/harassment/deception intent, coercion, phishing style, manipulation language, suspicious CTA patterns. cap 0..1.',
  'Signal 2 Report count (25%): 0->0.0, 1->0.3, 2->0.55, 3->0.75, 4+->0.90.',
  'Signal 3 Account signals (20%): age<7 +0.40, age7-30 +0.20, age>30 +0.0, karma<0 +0.40, karma=0 and age>180 days +0.15, karma1-10 +0.10, karma>10 +0.0. cap 0..1.',
  'Signal 4 Community rule match (10%): compare against communityRules and infer likely violations by meaning. cap 1.0.',
  'finalScore=(content*0.45)+(report*0.25)+(account*0.20)+(rule*0.10).',
  'Reasons: max 4, only mention signals that fired.',
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

export const scoreWithGemini = async (
  request: ScoreContentRequest,
  rules: ModerationRules
): Promise<LLMScore> => {
  const geminiConfig = (LLM_CONFIG as Record<string, unknown>).gemini as { apiKey: string; model: string; baseUrl: string } | undefined;
  if (!geminiConfig?.apiKey) return { ...fallbackScore, reasons: ['gemini_not_configured'] };
  const { apiKey, model, baseUrl } = geminiConfig;

  const prompt = buildPrompt(request, rules);
  const normalizedModel = model.startsWith('models/') ? model : `models/${model}`;

  try {
    const response = await fetch(
      `${baseUrl}/${normalizedModel}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, topP: 1, topK: 1, responseMimeType: 'application/json' },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      return { ...fallbackScore, reasons: [`gemini_http_${response.status}`, errText.slice(0, 120)] };
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const parsed = JSON.parse(extractFirstJsonObject(sanitizeJsonText(rawText))) as Partial<LLMScore>;
    return normalize(parsed);
  } catch (error) {
    return {
      ...fallbackScore,
      reasons: [error instanceof Error ? `gemini_exception:${error.message.slice(0, 120)}` : 'gemini_exception_unknown'],
    };
  }
};
