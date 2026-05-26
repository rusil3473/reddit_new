type ScoreBarProps = { score: number };

export const ScoreBar = ({ score }: ScoreBarProps) => {
  const tone = score < 0.3 ? 'bg-[#22C55E]' : score <= 0.7 ? 'bg-[#F59E0B]' : 'bg-[#EF4444]';
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.16em]">
        <span className="text-[#22C55E]">0.00 Approveable</span>
        <span className="text-[#EF4444]">1.00 Reject</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-[#2A2D3E]">
        <div
          className={`h-full rounded-full transition-all duration-300 ${tone}`}
          style={{ width: `${Math.max(0, Math.min(100, score * 100))}%` }}
        />
      </div>
      <p className="mt-1 text-right text-xs text-[#64748B]">Reject chance: {score.toFixed(2)}</p>
    </div>
  );
};
