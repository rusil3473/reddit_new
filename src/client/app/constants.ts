// Static lookup tables and dropdown option lists used throughout the
// dashboard UI. Kept separate from types and components so they can be
// imported without pulling in React.

import type { Difficulty, FeedSort, ModAction, TabKey } from './types';

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

export const difficultyClass: Record<Difficulty, string> = {
  easy: 'bg-[#22C55E]/20 text-[#86EFAC] border border-[#22C55E]/30',
  medium: 'bg-[#F59E0B]/20 text-[#FCD34D] border border-[#F59E0B]/30',
  hard: 'bg-[#EF4444]/20 text-[#FCA5A5] border border-[#EF4444]/30',
  legendary: 'legend-pill bg-[#7C5CFC]/20 text-[#C4B5FD] border border-[#7C5CFC]/35',
};

export const difficultyText: Record<Difficulty, string> = {
  easy: 'EASY',
  medium: 'MEDIUM',
  hard: 'HARD',
  legendary: 'LEGENDARY',
};
