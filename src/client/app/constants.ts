// Static lookup tables and dropdown option lists used throughout the
// dashboard UI. Kept separate from types and components so they can be
// imported without pulling in React.

import type { FeedSort, ModAction, TabKey } from './types';

export const tabs: Array<{ key: TabKey; label: string }> = [
  { key: 'priority', label: 'Priority Queue' },
  { key: 'escalated', label: 'Escalated Queue' },
  { key: 'reported', label: 'Reported Posts' },
  { key: 'processed', label: 'Processed Reports' },
  { key: 'audit', label: 'Audit Log' },
  { key: 'rules', label: 'Rules' },
];

export const sortOptions: Array<{ value: FeedSort; label: string }> = [
  { value: 'risk_desc', label: 'Sort by: Risk score' },
  { value: 'risk_asc', label: 'Sort by: Lowest risk' },
  { value: 'newest', label: 'Sort by: Newest' },
];

export const actionLabels: Record<ModAction, string> = {
  approve: 'Approve',
  remove: 'Remove',
  escalate: 'Escalate',
};
