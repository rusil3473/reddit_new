export type LLMProvider = 'gemini' | 'huggingface' | 'local';

export const LLM_CONFIG = {
  provider: 'huggingface' as LLMProvider,

  gemini: {
    apiKey:"AIzaSyDC6Q34iw9juiI8NPIWxwC4eEQtykO9JvU",//'AIzaSyCd_MZXYxb0-02Uredamt9hgUofJPVxDMs',
    model: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },

  huggingface: {
    apiToken: 'hf_ZIwkfpZrdqEgHuBWVgYTBRgTenMvRkcjNFs',
    model: 'mistralai/Mistral-7B-Instruct-v0.3',
    baseUrl: 'https://router.huggingface.co',
  },
};
