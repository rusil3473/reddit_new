export const SkeletonCard = () => (
  <div className="case-card p-4">
    <div className="skeleton-pulse h-5 w-32 rounded" />
    <div className="mt-3 skeleton-pulse h-6 w-3/4 rounded" />
    <div className="mt-2 skeleton-pulse h-4 w-1/3 rounded" />
    <div className="mt-4 skeleton-pulse h-2 w-full rounded" />
    <div className="mt-3 flex gap-2">
      <div className="skeleton-pulse h-5 w-20 rounded-full" />
      <div className="skeleton-pulse h-5 w-24 rounded-full" />
      <div className="skeleton-pulse h-5 w-16 rounded-full" />
    </div>
  </div>
);
