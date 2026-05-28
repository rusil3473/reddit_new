type SliderFieldProps = {
  label: string;
  value: number;
  onChange: (value: number) => void;
};

export const SliderField = ({ label, value, onChange }: SliderFieldProps) => (
  <label className="block text-sm font-semibold">
    {label}
    <input
      type="range"
      min="0"
      max="1"
      step="0.01"
      value={value}
      onChange={(event) => onChange(Number.parseFloat(event.target.value))}
      className="modecule-slider mt-2 w-full"
    />
    <input
      type="number"
      min="0"
      max="1"
      step="0.01"
      value={value}
      onChange={(event) => onChange(Number.parseFloat(event.target.value) || 0)}
      className="mt-2 w-full rounded-lg border border-[#2A2D3E] bg-[#0F1117] px-3 py-2 text-sm"
    />
  </label>
);
