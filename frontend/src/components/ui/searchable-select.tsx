'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { ChevronsUpDown, Check, Search, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SSOption {
  value: number | string;
  label: string;
  /** Optional muted second line (code / specs / stock) — for richer pickers. */
  subtitle?: string;
  /** Optional right-aligned chip (e.g., "320 pcs" stock). */
  meta?: string;
  /** Extra text to match the search against (codes etc.). */
  keywords?: string;
}

/**
 * Type-to-filter combobox with a clean two-line item layout. Renders the panel
 * via a portal so it never gets clipped by a parent dialog's overflow.
 */
export function SearchableSelect({
  value, onChange, options, placeholder = '— Select —', disabled, className, id,
  onCreate, createLabel = 'Add',
}: {
  value: number | string | '' | null | undefined;
  onChange: (v: string) => void;
  options: SSOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  /**
   * Optional. When provided, an "+ Add 'X'" row appears as a footer once the
   * user's typed query is non-empty AND matches no existing option. Clicking
   * (or Enter on it) fires onCreate(trimmedQuery). The parent decides what
   * to do with it — set a free-text value, POST to the API and refetch,
   * etc. The component just closes the panel after firing.
   */
  onCreate?: (value: string) => void;
  /** Verb on the "+ Add 'X'" row. Defaults to "Add". */
  createLabel?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [coords, setCoords] = React.useState<{ top: number; left: number; width: number; openUp: boolean; maxHeight: number } | null>(null);
  const [mounted, setMounted] = React.useState(false);

  const selected = options.find((o) => String(o.value) === String(value ?? ''));
  // When value was set inline (via onCreate) the new value isn't yet in
  // options — lookupsQ hasn't refetched, the parent hasn't propagated it,
  // etc. Without this fallback the trigger would show the placeholder
  // even though the field IS set, making the user think the "+ Add" did
  // nothing. Fall back to displaying the raw value string so what they
  // typed sticks visibly until the next refetch fills it into options.
  const triggerLabel = selected
    ? selected.label
    : value != null && value !== ''
      ? String(value)
      : placeholder;

  React.useEffect(() => { setMounted(true); }, []);

  const positionPanel = React.useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const margin = 12;
    const idealH = 360;
    const spaceBelow = window.innerHeight - r.bottom - margin;
    const spaceAbove = r.top - margin;
    // Open in whichever direction has more room; cap maxHeight to fit that space.
    const openUp = spaceAbove > spaceBelow && spaceBelow < idealH;
    const maxHeight = Math.max(160, Math.min(idealH, openUp ? spaceAbove : spaceBelow));
    setCoords({
      top: openUp ? r.top - 6 : r.bottom + 6,
      left: r.left,
      width: r.width,
      openUp,
      maxHeight,
    });
  }, []);

  React.useEffect(() => {
    if (!open) return;
    positionPanel();
    const onScroll = () => positionPanel();
    const onResize = () => positionPanel();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, positionPanel]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter((o) => `${o.label} ${o.subtitle ?? ''} ${o.meta ?? ''} ${o.keywords ?? ''}`.toLowerCase().includes(q))
    : options;

  // Highlighted row for arrow-key navigation. Resets to the currently-selected
  // option whenever the panel opens or the filter changes, so ↓/↑ start from a
  // sensible spot. Enter picks the highlighted row.
  const [highlightedIdx, setHighlightedIdx] = React.useState(0);
  React.useEffect(() => {
    if (!open) return;
    const sel = filtered.findIndex((o) => String(o.value) === String(value ?? ''));
    setHighlightedIdx(sel >= 0 ? sel : 0);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    if (highlightedIdx >= filtered.length) setHighlightedIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, highlightedIdx]);

  const listRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlightedIdx}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIdx, open]);

  // "+ Add 'X'" footer eligibility — only when:
  //   • caller wired onCreate
  //   • query has non-whitespace content
  //   • no existing option's label exactly matches (case-insensitive) so
  //     we don't bait the user into creating a duplicate
  const trimmedQuery = query.trim();
  const showCreateRow =
    !!onCreate &&
    trimmedQuery.length > 0 &&
    !options.some((o) => o.label.toLowerCase() === trimmedQuery.toLowerCase());
  const fireCreate = () => {
    if (!onCreate || !trimmedQuery) return;
    onCreate(trimmedQuery);
    setOpen(false);
    setQuery('');
  };

  const handleSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setHighlightedIdx(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setHighlightedIdx(Math.max(0, filtered.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const choice = filtered[highlightedIdx];
      if (choice) { onChange(String(choice.value)); setOpen(false); }
      // No match + a typed query + caller wired onCreate → create the new one.
      else if (showCreateRow) fireCreate();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  const handleTriggerKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!open) { setOpen(true); setQuery(''); }
    }
  };

  return (
    <div className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button" id={id} disabled={disabled}
        onClick={() => { if (!disabled) { setOpen((o) => !o); setQuery(''); } }}
        onKeyDown={handleTriggerKey}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-secondary/40 px-3 text-sm text-foreground transition-colors',
          'hover:border-gold/40 focus:border-gold/60 focus:outline-none focus:ring-2 focus:ring-gold/30',
          disabled && 'cursor-not-allowed opacity-50',
          !selected && (value == null || value === '') && 'text-text-faint',
        )}
      >
        <span className="truncate text-left">{triggerLabel}</span>
        <ChevronsUpDown className={cn('size-4 shrink-0 text-gold/70 transition-transform', open && 'rotate-180')} />
      </button>

      {mounted && open && coords && createPortal(
        <div
          ref={panelRef}
          className="z-[100] flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl ring-1 ring-gold/10"
          style={{
            position: 'fixed',
            top: coords.openUp ? undefined : coords.top,
            bottom: coords.openUp ? window.innerHeight - coords.top : undefined,
            left: coords.left,
            minWidth: coords.width,
            width: Math.max(coords.width, 360),
            maxWidth: Math.min(window.innerWidth - coords.left - 16, 520),
            maxHeight: coords.maxHeight,
          }}
        >
          <div className="flex items-center gap-2 border-b border-border bg-secondary/40 px-3 py-2">
            <Search className="size-3.5 text-gold/70" />
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input
              autoFocus value={query}
              onChange={(e) => { setQuery(e.target.value); setHighlightedIdx(0); }}
              onKeyDown={handleSearchKey}
              placeholder="Type to search · ↑↓ to navigate · Enter to select"
              className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-text-faint"
            />
            <span className="font-mono text-[10px] text-text-faint">{filtered.length}/{options.length}</span>
          </div>
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
            {filtered.length === 0 && !showCreateRow && (
              <div className="px-3 py-6 text-center text-sm text-text-faint">No matches.</div>
            )}
            {filtered.map((o, idx) => {
              const isSel = String(o.value) === String(value ?? '');
              const isHi = idx === highlightedIdx;
              return (
                <button
                  type="button" key={String(o.value)} data-idx={idx}
                  onMouseEnter={() => setHighlightedIdx(idx)}
                  onClick={() => { onChange(String(o.value)); setOpen(false); }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                    isHi && !isSel && 'bg-secondary',
                    isSel && 'bg-gold/10 font-medium text-foreground',
                    isHi && isSel && 'ring-1 ring-gold/40',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{o.label}</div>
                    {o.subtitle && (
                      <div className="truncate text-xs text-text-faint">{o.subtitle}</div>
                    )}
                  </div>
                  {o.meta && (
                    <span className="shrink-0 rounded-full bg-secondary/60 px-2 py-0.5 text-[10px] font-mono text-text-muted">{o.meta}</span>
                  )}
                  {isSel && <Check className="size-4 shrink-0 text-gold" />}
                </button>
              );
            })}
          </div>
          {showCreateRow && (
            <button
              type="button"
              onClick={fireCreate}
              className="flex w-full items-center gap-2 border-t border-gold/20 bg-gold/[0.06] px-3 py-2 text-left text-sm font-medium text-gold transition-colors hover:bg-gold/10"
            >
              <Plus className="size-4" />
              <span>{createLabel}</span>
              <span className="rounded bg-gold/15 px-1.5 py-0.5 font-mono text-xs">{trimmedQuery}</span>
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
