type BanEvasionChipProps = {
  matchedAuthor: string;
  similarity: number;            // raw 0..1 Jaccard
  onAuthorClick: (author: string) => void;
};

// BanEvasionChip is the styled red-tinted chip rendered on Priority Queue
// and Escalated Queue cards when the post's score record carries a
// banEvasionMatch. Clicking the linked username opens the matched user's
// stats panel via openUserStats.
export const BanEvasionChip = ({ matchedAuthor, similarity, onAuthorClick }: BanEvasionChipProps) => {
  const pct = Math.round(similarity * 100);
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[#EF4444]/40 bg-[#EF4444]/15 px-2 py-0.5 text-xs text-[#FCA5A5]">
      <span aria-hidden>⚠</span>
      <span>Possible ban evasion — {pct}% match with</span>
      <button
        type="button"
        className="font-semibold underline-offset-2 hover:underline"
        onClick={() => onAuthorClick(matchedAuthor)}
      >
        u/{matchedAuthor}
      </button>
    </span>
  );
};
