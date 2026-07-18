'use client';

import * as React from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Reusable column-sort primitive for any hand-rolled table that isn't using
 * the TanStack-powered DataTable. Two pieces:
 *
 *   - `useTableSort(rows, defaultKey, defaultDir)` — returns `sorted`, plus
 *     current sort state and a `toggle(key)` handler. First click on a
 *     column sorts asc, second flips to desc, third clears (falls back to
 *     the original order). Cells are compared naturally — numbers, dates
 *     (Date instances or ISO strings that Date can parse), then strings
 *     with locale-aware collation. `null`/`undefined` sort last regardless
 *     of direction so blank rows never crowd the top.
 *
 *   - `<SortableTh>` — a clickable `<th>` that shows the appropriate arrow
 *     for its column's state. Pass the same `sortKey` string you gave
 *     `toggle` and the current `sortKey`/`sortDir` from the hook.
 *
 * `sortKey` is a string, not `keyof T`, so callers can sort by nested paths
 * (`'customer.name'`) or synthetic derivations (`'daysOverdue'`) — pass a
 * `getValue` map for anything that isn't a direct property.
 */

export type SortDir = 'asc' | 'desc';

// One entry per non-standard column: how to pull the sortable value out of
// a row. Direct property access is the default, no entry needed.
export type SortAccessors<T> = Record<string, (row: T) => unknown>;

export function useTableSort<T>(
  rows: T[] | undefined,
  defaultKey: string | null = null,
  defaultDir: SortDir = 'asc',
  accessors: SortAccessors<T> = {},
) {
  const [sortKey, setSortKey] = React.useState<string | null>(defaultKey);
  const [sortDir, setSortDir] = React.useState<SortDir>(defaultDir);

  const toggle = React.useCallback((key: string) => {
    setSortKey((cur) => {
      if (cur !== key) { setSortDir('asc'); return key; }
      // Same column: asc → desc → clear
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      return key;
    });
  }, []);

  const sorted = React.useMemo(() => {
    const list = rows ?? [];
    if (!sortKey) return list;
    const get = accessors[sortKey] ?? ((r: T) => (r as any)?.[sortKey]);
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      // Nulls always last so blank rows never crowd the top of the list.
      const na = va == null || va === '';
      const nb = vb == null || vb === '';
      if (na && nb) return 0;
      if (na) return 1;
      if (nb) return -1;
      return compareCells(va, vb) * dir;
    });
  }, [rows, sortKey, sortDir, accessors]);

  return { sorted, sortKey, sortDir, toggle };
}

// Natural comparison: numeric first, then date-parseable, then string.
function compareCells(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  const sa = String(a);
  const sb = String(b);
  // Numeric-looking strings — sort as numbers so "10" > "2" (not "2" > "10").
  const na = Number(sa);
  const nb = Number(sb);
  if (!Number.isNaN(na) && !Number.isNaN(nb) && sa.trim() !== '' && sb.trim() !== '') {
    return na - nb;
  }
  // ISO-date-ish strings — try Date first; fall back to string compare.
  if (/^\d{4}-\d{2}-\d{2}/.test(sa) && /^\d{4}-\d{2}-\d{2}/.test(sb)) {
    const da = Date.parse(sa);
    const db = Date.parse(sb);
    if (!Number.isNaN(da) && !Number.isNaN(db)) return da - db;
  }
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
}

export function SortableTh({
  label,
  sortKey,
  currentKey,
  currentDir,
  onToggle,
  align = 'left',
  className,
  children,
}: {
  label?: React.ReactNode;
  sortKey: string;
  currentKey: string | null;
  currentDir: SortDir;
  onToggle: (key: string) => void;
  align?: 'left' | 'right' | 'center';
  className?: string;
  children?: React.ReactNode;
}) {
  const active = currentKey === sortKey;
  const Arrow = active ? (currentDir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  const justify =
    align === 'right' ? 'justify-end'
    : align === 'center' ? 'justify-center'
    : 'justify-start';
  return (
    <th
      className={cn(
        'px-4 py-2 text-xs font-medium text-muted-foreground',
        align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        className={cn(
          'inline-flex w-full items-center gap-1 transition-colors',
          justify,
          active ? 'text-gold' : 'hover:text-foreground',
        )}
        title={active ? `Sorted ${currentDir === 'asc' ? 'ascending' : 'descending'}` : 'Click to sort'}
      >
        <span>{children ?? label}</span>
        <Arrow className={cn('size-3 shrink-0', active ? 'opacity-100' : 'opacity-50')} />
      </button>
    </th>
  );
}
