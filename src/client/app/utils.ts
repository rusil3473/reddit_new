// Pure helper functions used across the dashboard UI. No React, no
// network, no state — safe to import from anywhere.

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
