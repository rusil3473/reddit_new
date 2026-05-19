import { useCallback, useEffect, useState } from 'react';
import type { DashboardResponse, QueueItem } from '../../shared/mod';

type DashboardState = {
  loading: boolean;
  queueLength: number;
  highRiskCount: number;
  topViolationTypes: Array<{ name: string; count: number }>;
  items: QueueItem[];
};

const initial: DashboardState = {
  loading: true,
  queueLength: 0,
  highRiskCount: 0,
  topViolationTypes: [],
  items: [],
};

export const useDashboard = () => {
  const [state, setState] = useState<DashboardState>(initial);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/dashboard');
    if (!res.ok) {
      throw new Error(`Dashboard request failed with ${res.status}`);
    }

    const payload: DashboardResponse = await res.json();
    setState({
      loading: false,
      queueLength: payload.queueLength,
      highRiskCount: payload.highRiskCount,
      topViolationTypes: payload.topViolationTypes,
      items: payload.items,
    });
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const claim = useCallback(
    async (itemId: string) => {
      await fetch('/api/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId }),
      });
      await refresh();
    },
    [refresh]
  );

  const takeAction = useCallback(
    async (itemId: string, action: 'approve' | 'remove') => {
      await fetch(`/api/action/${itemId}/${action}`, { method: 'POST' });
      await refresh();
    },
    [refresh]
  );

  const bulkAction = useCallback(
    async (action: 'approve' | 'remove') => {
      await fetch('/api/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          maxItems: 20,
          minConfidence: action === 'remove' ? 0.8 : 0.2,
        }),
      });
      await refresh();
    },
    [refresh]
  );

  return { ...state, refresh, claim, takeAction, bulkAction } as const;
};
