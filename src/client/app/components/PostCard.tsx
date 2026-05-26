import type { QueuePost } from '../types';
import { ScoreBar } from './ScoreBar';
import { Chip } from './Chip';
import { BanEvasionChip } from './BanEvasionChip';
import { BannedUserBanner } from './BannedUserBanner';

export type PostCardAction =
  | { kind: 'approve' }
  | { kind: 'remove' }
  | { kind: 'escalate' }
  | { kind: 'rescore' };

type PostCardProps = {
  post: QueuePost;
  // Optional checkbox (Priority Queue only). When undefined, no checkbox is rendered.
  checkbox?: {
    checked: boolean;
    onToggle: () => void;
  };
  // Set of action buttons to render in the action column. Order matters.
  actions: Array<PostCardAction['kind']>;
  // Per-post in-flight flags so each button can show a loading state without
  // freezing the rest of the card.
  processing?: boolean;
  rescoring?: boolean;
  onAction: (kind: PostCardAction['kind']) => void;
  // Click target for any author link (post.author or matched-user).
  onAuthorClick: (author: string) => void;
};

const ACTION_LABEL: Record<PostCardAction['kind'], string> = {
  approve: 'Approve',
  remove: 'Remove',
  escalate: 'Escalate',
  rescore: 'Rescore',
};

const ACTION_BUTTON_CLASS: Record<PostCardAction['kind'], string> = {
  approve: 'border-[#22C55E]/40 text-[#86EFAC] hover:bg-[#22C55E]/15',
  remove: 'border-[#EF4444]/40 text-[#FCA5A5] hover:bg-[#EF4444]/15',
  escalate: 'border-[#7C5CFC]/40 text-[#C4B5FD] hover:bg-[#7C5CFC]/15',
  rescore: 'border-[#2A2D3E] text-[#94A3B8] hover:bg-[#1F2330]',
};

// PostCard is the unified queue/escalated/reported/processed list card.
// Layout:
//
//   [optional BannedUserBanner — full width across both columns]
//   ┌─────────────────────────────────────────────┬──────────────┐
//   │ [☐] title                       u/author    │ Approve      │
//   │ ScoreBar                                    │ Remove       │
//   │ [reason chips]                              │ Escalate     │
//   │                                             │ Rescore (sm) │
//   └─────────────────────────────────────────────┴──────────────┘
//
// Action column is fixed-width and top-aligned; buttons are filled pills
// rather than text-only links so affordance is obvious without hover.
export const PostCard = ({
  post,
  checkbox,
  actions,
  processing = false,
  rescoring = false,
  onAction,
  onAuthorClick,
}: PostCardProps) => {
  const checked = checkbox?.checked ?? false;
  const showBannedUserBanner = Boolean(post.bannedUserMatch);
  const showBanEvasionChip = Boolean(post.banEvasion) && !showBannedUserBanner;

  // Filter the auto-injected ban-evasion / banned-user reason strings out of
  // the chip list — they are already rendered as a dedicated chip / banner.
  const visibleReasons = post.reasons.filter((reason) => {
    if (showBannedUserBanner && reason.startsWith('Matches removed posts of banned')) return false;
    if (showBanEvasionChip && reason.startsWith('Possible ban evasion')) return false;
    return true;
  });

  return (
    <article
      className={`case-card hover-glow relative grid gap-4 p-3 sm:p-4 lg:grid-cols-[1fr_8.5rem] ${
        checked ? 'border-l-[3px] border-l-[#7C5CFC] bg-[#22263a]' : ''
      }`}
    >
      {showBannedUserBanner && post.bannedUserMatch && (
        <div className="lg:col-span-2">
          <BannedUserBanner
            matchedAuthor={post.bannedUserMatch.matchedAuthor}
            similarity={post.bannedUserMatch.similarity}
            onAuthorClick={onAuthorClick}
          />
        </div>
      )}

      <div className="min-w-0 space-y-3">
        <div className="flex items-start gap-3">
          {checkbox && (
            <input
              type="checkbox"
              checked={checked}
              onChange={() => checkbox.onToggle()}
              className="mt-1 h-4 w-4 cursor-pointer accent-[#7C5CFC]"
              aria-label="Select post"
            />
          )}
          <div className="min-w-0 flex-1">
            <h3 className="break-words text-lg font-semibold leading-snug">{post.title}</h3>
          </div>
          <button
            type="button"
            className="shrink-0 text-sm text-[#64748B] hover:text-[#7C5CFC] hover:underline"
            onClick={() => onAuthorClick(post.author)}
          >
            u/{post.author}
          </button>
        </div>

        <ScoreBar score={post.score} />

        {(showBanEvasionChip || visibleReasons.length > 0) && (
          <div className="flex flex-wrap gap-2">
            {showBanEvasionChip && post.banEvasion && (
              <BanEvasionChip
                matchedAuthor={post.banEvasion.matchedAuthor}
                similarity={post.banEvasion.similarity}
                onAuthorClick={onAuthorClick}
              />
            )}
            {visibleReasons.map((reason) => (
              <Chip key={`${post.id}-${reason}`} label={reason} />
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-start justify-end gap-2 lg:flex-col lg:flex-nowrap lg:items-stretch">
        {actions.map((kind) => {
          const isRescore = kind === 'rescore';
          const busy = isRescore ? rescoring : processing;
          const label = isRescore && rescoring ? '⟳…' : ACTION_LABEL[kind];
          return (
            <button
              key={kind}
              type="button"
              disabled={busy}
              onClick={() => onAction(kind)}
              className={`rounded-md border bg-transparent px-3 py-1.5 text-sm font-semibold transition disabled:opacity-50 ${ACTION_BUTTON_CLASS[kind]}`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </article>
  );
};
