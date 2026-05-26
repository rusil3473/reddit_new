// Shared client-side types for the Modecule dashboard.
//
// These types describe the shape of data exchanged with the server API
// and the local UI state of the dashboard. They are intentionally
// lightweight and contain no behavior.

export type TabKey = 'priority' | 'escalated' | 'reported' | 'processed' | 'audit' | 'rules';

export type FeedSort = 'risk_desc' | 'risk_asc' | 'newest';

export type ModAction = 'approve' | 'remove' | 'escalate';

export type QueuePost = {
  id: string;
  title: string;
  author: string;
  score: number;
  reasons: string[];
  reportCount: number;
  createdAt: string;
  type: 'post' | 'comment';
  banEvasion?: {
    matchedAuthor: string;
    similarity: number;
  };
};

export type QueueResponse = { type: 'QUEUE_POSTS_RESPONSE'; posts: QueuePost[] };

export type StatsResponse = {
  type: 'STATS_RESPONSE';
  processed: number;
  removed: number;
  approved: number;
  inQueue: number;
  reported: number;
};

export type AuditItem = {
  postId: string;
  ts: string;
  mod: string;
  title: string;
  action: 'approved' | 'removed' | 'escalated';
  score: string;
  reasons: string[];
};

export type ToastTone = 'success' | 'error' | 'info';

export type Toast = { id: number; text: string; tone: ToastTone };

export type AccessResponse = { success: boolean; isModerator: boolean };
