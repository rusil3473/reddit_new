export type ToastHandler = (message: string) => void;

export const apiClient = {
  async request<T>(
    path: string,
    options: RequestInit = {},
    onError?: ToastHandler,
    retryCount = 1
  ): Promise<T> {
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= retryCount) {
      try {
        const response = await fetch(path, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            ...(options.headers ?? {}),
          },
        });

        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || `HTTP ${response.status}`);
        }

        return (await response.json()) as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('unknown_error');
        const isNetworkError = !/HTTP/.test(lastError.message);
        if (!isNetworkError || attempt >= retryCount) {
          onError?.(`Request failed: ${lastError.message}`);
          throw lastError;
        }
      }

      attempt += 1;
    }

    onError?.('Request failed');
    throw lastError ?? new Error('request_failed');
  },
};
