'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Self-contained modal dialog (no external deps).
 * Layout: fixed overlay + flex column panel with a scrollable body and a
 * sticky header/footer so long forms always scroll and the actions stay visible.
 */
interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
}

// Dialog widths only kick in at the `sm` breakpoint (640px+). Below that,
// every dialog uses the full available width so phone screens get the most
// usable surface area. The container itself is full-viewport-height on
// mobile (no rounded corners, no surrounding padding) — a familiar
// bottom-sheet/full-page modal pattern on iOS / Android.
const sizes = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-3xl',
  xl: 'sm:max-w-5xl',
  '2xl': 'sm:max-w-7xl',
  full: 'sm:max-w-[95vw]',
};

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'lg',
}: DialogProps) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    // Backdrop — darker tint with subtle blur on top of the dark page so
    // the dialog reads as elevated rather than floating in a void.
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-dark-1/70 p-0 backdrop-blur-sm sm:p-6">
      <div
        className="fixed inset-0"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          // Mobile: full-viewport sheet. Desktop: floating card with a
          // 1px gold-tinged top edge for a quiet accent.
          'relative z-10 flex w-full flex-col bg-card shadow-2xl ring-1 ring-gold/10',
          'min-h-[100dvh] sm:min-h-0 sm:my-4 sm:max-h-[calc(100vh-2rem)] sm:rounded-xl sm:border sm:border-border',
          sizes[size],
        )}
      >
        {/* Header (sticky). Thin gold accent rule under the title. */}
        <div className="flex items-start justify-between gap-3 border-b border-border bg-card/80 px-4 py-3 sm:px-5 sm:py-4">
          <div className="min-w-0">
            {title && (
              <h2 className="text-base font-semibold text-foreground">
                {title}
              </h2>
            )}
            {description && (
              <p className="mt-1 text-xs text-text-faint sm:text-sm">{description}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-md p-1 text-text-faint transition-colors hover:bg-secondary hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-5 sm:py-5">{children}</div>

        {/* Footer (sticky). */}
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-card/80 px-4 py-3 sm:px-5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
