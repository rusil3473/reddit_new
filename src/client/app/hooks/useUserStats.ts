import { useState } from 'react';
import { apiClient } from '../../lib/apiClient';

// Response payload from GET /api/user-stats. Mirrors the server's
// projection in src/server/routes/api.ts. Kept inline here so the
// hook is self-contained.
type UserStatsResponse = {
  success: boolean;
  counts: {
    approved: number;
    removed: number;
    reportsReceived: number;
  };
  posts: {
    approved: Array<{ postId: string; title: string; score: number; timestamp: number; reasons: string[] }>;
    removed: Array<{ postId: string; title: string; score: number; timestamp: number; reasons: string[] }>;
  };
  reportedPosts: Array<{
    postId: string;
    title: string;
    reportCount: number;
    lastReportedAt: number;
    status: string;
    score: number;
    reasons: string[];
  }>;
};

export type UserStats = Pick<UserStatsResponse, 'counts' | 'posts' | 'reportedPosts'>;

export type UserStatsTab = 'approved' | 'removed' | 'reportsReceived';

type UseUserStatsArgs = {
  // Called when the underlying fetch fails so the host can show a toast.
  onError: (message: string) => void;
};

// useUserStats encapsulates the per-user stats panel: which user is
// being viewed, the data we have for them, and the active sub-tab.
//
// openUserStats(username) is used when the user is first selected
// (e.g. clicking u/foo) — it switches the active sub-tab back to
// 'approved'. reloadUserStats() re-fetches without touching the
// active sub-tab, preserving the user's place when they hit Refresh.
export const useUserStats = ({ onError }: UseUserStatsArgs) => {
  const [viewingUser, setViewingUser] = useState<string | null>(null);
  const [userStats, setUserStats] = useState<UserStats | null>(null);
  const [loadingUserStats, setLoadingUserStats] = useState(false);
  const [userTab, setUserTab] = useState<UserStatsTab>('approved');

  const fetchUserStats = async (username: string): Promise<void> => {
    setLoadingUserStats(true);
    try {
      const res = await apiClient.request<UserStatsResponse>(
        `/api/user-stats?username=${encodeURIComponent(username)}`
      );
      setUserStats({ counts: res.counts, posts: res.posts, reportedPosts: res.reportedPosts });
    } catch {
      onError('Failed to load user stats');
      setViewingUser(null);
    } finally {
      setLoadingUserStats(false);
    }
  };

  const openUserStats = async (username: string): Promise<void> => {
    setViewingUser(username);
    setUserTab('approved');
    await fetchUserStats(username);
  };

  const reloadUserStats = async (): Promise<void> => {
    if (!viewingUser) return;
    await fetchUserStats(viewingUser);
  };

  const closeUserStats = (): void => {
    setViewingUser(null);
    setUserStats(null);
  };

  return {
    viewingUser,
    userStats,
    loadingUserStats,
    userTab,
    setUserTab,
    openUserStats,
    reloadUserStats,
    closeUserStats,
  };
};
