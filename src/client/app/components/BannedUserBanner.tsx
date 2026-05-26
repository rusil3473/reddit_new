type BannedUserBannerProps = {
  matchedAuthor: string;
  similarity: number;            // raw 0..1 Jaccard
  onAuthorClick: (author: string) => void;
};

// BannedUserBanner is the prominent full-width banner rendered at the top
// of a post card when the post matches the removed-content corpus of a
// user explicitly banned by a moderator. Stronger visual weight than the
// generic BanEvasionChip because it represents a moderator-verified ban.
export const BannedUserBanner = ({
  matchedAuthor,
  similarity,
  onAuthorClick,
}: BannedUserBannerProps) => {
  const pct = Math.round(similarity * 100);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[#EF4444]/50 bg-[#EF4444]/10 px-3 py-2 text-sm text-[#FCA5A5]">
      <span aria-hidden className="text-base">⛔</span>
      <span>
        This post's content looks like a specific banned user's removed corpus —{' '}
        <span className="font-semibold text-[#FCA5A5]">{pct}%</span> match with
      </span>
      <button
        type="button"
        onClick={() => onAuthorClick(matchedAuthor)}
        className="font-semibold text-[#FCA5A5] underline-offset-2 hover:underline"
      >
        u/{matchedAuthor}
      </button>
    </div>
  );
};
