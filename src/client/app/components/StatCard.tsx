type StatCardProps = {
  value: string;
  label: string;
  accent: string;
  pulse?: boolean;
};

export const StatCard = ({ value, label, accent, pulse = false }: StatCardProps) => (
  <div className={`stat-card hover-glow px-3 py-2.5 ${pulse ? 'queue-pulse' : ''}`}>
    <p className="text-xs text-[#64748B]">{label}</p>
    <p className={`mt-1 text-3xl leading-none font-bold ${accent}`}>{value}</p>
  </div>
);
