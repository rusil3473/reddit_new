import type { Difficulty } from '../types';
import { difficultyClass, difficultyText } from '../constants';

type DifficultyBadgeProps = { difficulty: Difficulty };

export const DifficultyBadge = ({ difficulty }: DifficultyBadgeProps) => (
  <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${difficultyClass[difficulty]}`}>
    {difficultyText[difficulty]}
  </span>
);
