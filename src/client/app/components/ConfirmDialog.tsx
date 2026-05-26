import { useEffect, type ReactNode } from 'react';

type ConfirmTone = 'danger' | 'primary';

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  // Optional extra children rendered between description and the buttons,
  // useful for embedding a duration / reason form.
  children?: ReactNode;
};

// ConfirmDialog is the reusable themed modal for destructive / important
// actions in the dashboard. Visual style mirrors the rest of Modecule:
// dark surface (#0B0E16), purple accent (#7C5CFC) on primary actions, red
// (#EF4444) on destructive ones, neutral grey on cancel. Typography uses
// the same font-semibold / text-sm hierarchy as the rest of the app.
export const ConfirmDialog = ({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'primary',
  busy = false,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) => {
  // Close on Escape for keyboard users.
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, busy, onCancel]);

  if (!open) return null;

  const confirmClass =
    tone === 'danger'
      ? 'bg-[#EF4444] hover:brightness-110'
      : 'bg-[#7C5CFC] hover:brightness-110';

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/60 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-[#2A2D3E] bg-[#0B0E16] p-5 shadow-2xl">
        <h2 id="confirm-dialog-title" className="text-lg font-semibold text-[#F1F5F9]">
          {title}
        </h2>
        {description && (
          <div className="mt-2 text-sm text-[#94A3B8]">{description}</div>
        )}
        {children && <div className="mt-4 space-y-3">{children}</div>}
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-[#2A2D3E] bg-[#1A1D27] px-3 py-1.5 text-sm text-[#94A3B8] transition hover:text-white disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold text-white transition disabled:opacity-50 ${confirmClass}`}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
