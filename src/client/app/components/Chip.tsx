type ChipProps = { label: string };

export const Chip = ({ label }: ChipProps) => (
  <span className="rounded-full border border-[#2A2D3E] bg-[#252A3A]/45 px-2 py-0.5 text-xs text-[#94A3B8]">
    {label}
  </span>
);
