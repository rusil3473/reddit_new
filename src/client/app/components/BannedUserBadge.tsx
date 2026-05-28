type BannedUserBadgeProps = {
  matchedAuthor: string;
  similarity: number;            // raw 0..1 Jaccard
  onAuthorClick: (author: string) => void;
};

// BannedUserBadge is the compact badge rendered in the top-right of a
// post card when the post matches a moderator-banned user's removed
// content. The matched username is the click target — clicking it opens
// that user's stats panel so the moderator can compare and decide.
//
// Replaces the earlier full-width BannedUserBanner: a top-right badge is
// more proportional to other card elements and keeps the layout tight.
export const BannedUserBadge = ({
  matchedAuthor,
  similarity,
  onAuthorClick,
}: BannedUserBadgeProps) => {
  const pct = Math.round(similarity * 100);
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 rounded-full border border-[#EF4444]/50 bg-[#EF4444]/15 px-2.5 py-1 text-xs text-[#FCA5A5]"
      title="This post's content looks like a specific banned user's removed corpus"
    >
      <span aria-hidden>⛔</span>
      <span className="font-semibold">{pct}% match</span>
      <button
        type="button"
        onClick={() => onAuthorClick(matchedAuthor)}
        className="font-semibold text-[#FCA5A5] underline underline-offset-2 hover:brightness-110"
      >
        u/{matchedAuthor}
      </button>
    </div>
  );
};
