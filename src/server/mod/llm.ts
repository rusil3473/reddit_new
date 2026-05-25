import type {
  ModerationRules,
  RiskLabel,
  ScoreContentRequest,
  SuggestedAction,
} from '../../shared/mod';
import { scoreLLM, type LLMScore } from './llm-router';

export type LearningSignal = {
  fingerprint: string[];
  action: 'approve' | 'remove';
  originalScore: number;
  postId: string;
  authorId: string;
  timestamp: number;
};

export const extractFingerprint = (title: string, body: string): string[] => {
  const stopwords = new Set(['the','and','for','with','that','this','from','your',
    'you','are','not','no','be','to','of','on','is','was','it','in','a','an',
    'how','do','what','why','when','who','where','can','my','me','i','we']);
  const text = `${title} ${body}`.toLowerCase();
  const tokens = text.split(/[^a-z0-9]+/).filter(t => t.length >= 4 && !stopwords.has(t));
  return [...new Set(tokens)].slice(0, 12);
};

const computeSimilarity = (fingerprint: string[], signal: LearningSignal): number => {
  const overlap = fingerprint.filter(token => signal.fingerprint.includes(token)).length;
  const union = new Set([...fingerprint, ...signal.fingerprint]).size;
  return union === 0 ? 0 : overlap / union;
};

const clampScore = (n: number): number => Math.max(0, Math.min(1, n));

export const applyLearningAdjustment = (
  baseScore: number,
  title: string,
  body: string,
  pastSignals: LearningSignal[]
): number => {
  const fingerprint = extractFingerprint(title, body);
  let adjustment = 0;
  let totalWeight = 0;
  for (const signal of pastSignals) {
    const similarity = computeSimilarity(fingerprint, signal);
    if (similarity >= 0.25) {
      const ageInDays = (Date.now() - signal.timestamp) / (1000 * 60 * 60 * 24);
      const decayFactor = Math.exp(-0.05 * ageInDays);
      const weight = similarity * decayFactor * 0.15;
      const direction = signal.action === 'remove' ? 1 : -1;
      adjustment += direction * weight;
      totalWeight += similarity * decayFactor;
    }
  }
  const normalizedAdjustment = totalWeight > 0 ? adjustment / Math.max(totalWeight, 1) : 0;
  return clampScore(baseScore + normalizedAdjustment);
};

export const scoreWithLearning = async (
  request: ScoreContentRequest,
  rules: ModerationRules,
  pastSignals: LearningSignal[]
): Promise<LLMScore> => {
  const baseResult = await scoreLLM(request, rules);
  const fingerprint = extractFingerprint(request.title, request.body);

  let adjustment = 0;
  let totalWeight = 0;

  for (const signal of pastSignals) {
    const similarity = computeSimilarity(fingerprint, signal);
    if (similarity >= 0.25) {
      const ageInDays = (Date.now() - signal.timestamp) / (1000 * 60 * 60 * 24);
      const decayFactor = Math.exp(-0.05 * ageInDays);
      const weight = similarity * decayFactor * 0.15;
      const direction = signal.action === 'remove' ? 1 : -1;
      adjustment += direction * weight;
      totalWeight += similarity * decayFactor;
    }
  }

  const normalizedAdjustment = totalWeight > 0 ? adjustment / Math.max(totalWeight, 1) : 0;
  const adjustedScore = clampScore(baseResult.score + normalizedAdjustment);

  const reasons = [...baseResult.reasons];
  if (Math.abs(normalizedAdjustment) > 0.05) {
    reasons.push(normalizedAdjustment > 0 ? 'Similar to past moderated content' : 'Similar to past approved content');
  }

  const matchingSignalCount = pastSignals.filter(s => computeSimilarity(fingerprint, s) >= 0.25).length;
  const confidence = matchingSignalCount === 0
    ? 0.4
    : Math.min(0.4 + matchingSignalCount * 0.06, 0.95);

  const label: RiskLabel = adjustedScore < 0.3 ? 'low_risk' : adjustedScore <= 0.6 ? 'borderline' : 'high_risk';
  const suggested_action: SuggestedAction = adjustedScore < rules.autoApproveThreshold ? 'approve' : adjustedScore >= rules.autoRemoveThreshold ? 'remove' : 'review';

  return {
    score: adjustedScore,
    label,
    reasons: reasons.slice(0, 4),
    suggested_action,
    confidence,
  };
};

// TODO: Move these back to environment variables before production release.
const HARDCODED_GEMINI_API_KEY = "AIzaSyCd_MZXYxb0-02Uredamt9hgUofJPVxDMs";//'AIzaSyCuwWVpL1XNTObTXhoaozF-a3rdpvYTog8';
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

const extractFirstJsonObject = (value: string): string => {
  const start = value.indexOf('{');
  if (start < 0) {
    return value;
  }
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === '\\\\') {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, i + 1);
      }
    }
  }
  return value.slice(start);
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
      ? input.reasons.slice(0, 4)
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
    'Score must be a decimal between 0.0 and 1.0 where 0.0 means clearly approveable and 1.0 means clearly reject/remove.',
    'You must reason SEMANTICALLY, not by exact phrase matching. Detect paraphrases, obfuscations, and intent.',
    'Primary objective: detect scams, social engineering, fraud, account takeover attempts, financial exploitation, and community rule violations even when wording is novel.',
    'Critical scam/social-engineering patterns (high severity): requests for codes/OTP/seed phrase/recovery keys, promises of guaranteed returns, impersonation of trusted entities, moving users to DM for money/credentials, urgency pressure, giveaway fraud, account recovery bait, payment rerouting.',
    'For any high-severity scam/social-engineering intent, score must be high risk (typically >=0.85) and suggested_action should be remove.',
    'Use this weighted model exactly:',
    'Signal 1 Content analysis (45%): threat/hate/scam/spam/harassment/deception intent, coercion, phishing style, manipulation language, suspicious CTA patterns. Include prior heuristics but generalize beyond literal words. cap 0..1.',
    'Signal 2 Report count (25%): 0->0.0, 1->0.3, 2->0.55, 3->0.75, 4+->0.90.',
    'Signal 3 Account signals (20%): age<7 +0.40, age7-30 +0.20, age>30 +0.0, karma<0 +0.40, karma=0 and age>180 days +0.15, karma1-10 +0.10, karma>10 +0.0. cap 0..1.',
    'Signal 4 Community rule match (10%): compare against communityRules and infer likely violations by meaning, not only keyword overlap. cap 1.0.',
    'finalScore=(content*0.45)+(report*0.25)+(account*0.20)+(rule*0.10). Lower score means approveable. Higher score means rejectable.',
    'Difficulty mapping: <0.30 EASY, 0.30-0.59 MEDIUM, 0.60-0.84 HARD, >=0.85 LEGENDARY',
    'Reasons generation constraints:',
    'Only mention signals that fired, always add content reasons when content score>0.2, always add report reason when reports>0, add account reason only when account signal meaningfully contributed, max 4 reasons.',
    'Before finalizing output, run a self-check: if the post asks users for sensitive credentials/codes/money transfer under promise/pressure, do not output low_risk.',
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
    const firstJsonObject = extractFirstJsonObject(cleanText);
    const parsed = JSON.parse(firstJsonObject) as Partial<GeminiScore>;

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
