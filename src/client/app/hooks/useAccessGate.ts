import { useState } from 'react';
import { apiClient } from '../../lib/apiClient';
import type { AccessResponse } from '../types';

export type AccessState = 'checking' | 'allowed' | 'denied';

// useAccessGate exposes moderator-access state for the dashboard.
// Call checkAccess() during initial mount; it returns true if the
// current user is a moderator and updates accessState accordingly.
export const useAccessGate = () => {
  const [accessState, setAccessState] = useState<AccessState>('checking');

  const checkAccess = async (): Promise<boolean> => {
    try {
      const response = await apiClient.request<AccessResponse>('/api/access');
      if (!response.isModerator) {
        setAccessState('denied');
        return false;
      }
      setAccessState('allowed');
      return true;
    } catch {
      setAccessState('denied');
      return false;
    }
  };

  return { accessState, checkAccess };
};
