import { ChatOpenAI } from '@langchain/openai';

const env = (key: string, fallback = ''): string => process.env[key] ?? fallback;

export type LlmModerationResult = {
  llmRisk: number;
  reasons: string[];
};

export const analyzeTextWithModel = async (input: string): Promise<LlmModerationResult> => {
  if (!env('LLM_API_KEY')) {
    return { llmRisk: 0, reasons: [] };
  }

  const model = new ChatOpenAI({
    apiKey: env('LLM_API_KEY'),
    model: env('LLM_MODEL', 'gpt-4.1-mini'),
    configuration: {
      baseURL: env('LLM_BASE_URL', 'https://api.openai.com/v1'),
      defaultHeaders: env('LLM_API_VERSION')
        ? { 'x-api-version': env('LLM_API_VERSION') }
        : undefined,
    },
    temperature: 0,
  });

  const prompt = [
    'You are a strict moderation classifier for Reddit content.',
    'Respond as JSON with keys risk (0..1 number) and reasons (string[] max 3).',
    'Focus on spam, ban-evasion style writing, harassment, and malicious behavior.',
    `Text: ${input}`,
  ].join('\n');

  try {
    const response = await model.invoke(prompt);
    const output = typeof response.content === 'string' ? response.content : '';
    const parsed = JSON.parse(output) as { risk?: number; reasons?: string[] };
    return {
      llmRisk: Math.max(0, Math.min(1, parsed.risk ?? 0)),
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 3) : [],
    };
  } catch {
    return { llmRisk: 0, reasons: [] };
  }
};
