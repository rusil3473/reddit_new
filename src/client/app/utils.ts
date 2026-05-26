// Pure helper functions used across the dashboard UI. No React, no
// network, no state — safe to import from anywhere.

import type { Difficulty } from './types';

export const formatNow = (): string => {
  const now = new Date();
  return now.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export const scoreToDifficulty = (score: number): Difficulty => {
  if (score < 0.3) {
    return 'easy';
  }
  if (score <= 0.6) {
    return 'medium';
  }
  if (score <= 0.85) {
    return 'hard';
  }
  return 'legendary';
};
