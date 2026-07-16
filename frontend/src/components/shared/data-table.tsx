'use client';

import * as React from 'react';
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  SortingState,
  useReactTable,
} from '@tanstack/react-table';
import { ArrowUpDown, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from './empty-state';
import { cn } from '@/lib/utils';

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  pageSize?: number;
  /** "Rows per page" options. Defaults to a sensible set so every list paginates. */
  pageSizeOptions?: number[];
  /** Show a search input above the table. Filters via a global, case-insensitive
   *  substring match across every cell's rendered string content. Pass `false`
   *  to hide the bar; pass a string to customise the placeholder. */
  searchable?: boolean | string;
  /** Mobile-friendly card render. When supplied, on screens <lg the visible
   *  page rows render as a vertical card stack using this function instead of
   *  the table. The receives the same row data + its display index. Sort +
   *  pagination + search still drive the row set; this is purely a per-row
   *  display swap on small viewports. Pass undefined to keep table-only
   *  behaviour (legacy callers). */
  mobileCard?: (row: TData, index: number) => React.ReactNode;
}

// Render any cell value to a searchable string — pulls primitives, walks
// objects shallowly, and falls back to JSON for complex shapes so values
// surface in the global filter without each page wiring it up manually.
function toSearchString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(toSearchString).join(' ');
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).map(toSearchString).join(' ');
  return String(value);
}

export function DataTable<TData, TValue>({
  columns,
  data,
  loading,
  emptyTitle,
  emptyDescription,
  // Defaults bumped 5→10 — five rows leaves too much empty space below
  // the table on most desktop screens and forces unnecessary pagination
  // for typical use.
  pageSize = 10,
  pageSizeOptions = [5, 10, 25, 50, 100],
  // Default OFF — every consumer page (Items, Vendors, Materials,
  // Inventory, Batches, …) renders its own page-level search input with
  // backend-side filtering, so the built-in client-side search bar was
  // showing up as a duplicate second search bar. Pages that genuinely
  // want a client-side global filter (no external search) can opt in
  // explicitly with `searchable={true}` or `searchable="placeholder…"`.
  searchable = false,
  mobileCard,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = React.useState('');

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    // Walk the entire row object so search matches against every field,
    // not just the rendered cell text. Cheap and works for any shape.
    globalFilterFn: (row, _columnId, filterValue) => {
      const q = String(filterValue ?? '').trim().toLowerCase();
      if (!q) return true;
      return toSearchString(row.original).toLowerCase().includes(q);
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-text-faint">
        <Spinner /> <span className="text-sm">Loading…</span>
      </div>
    );
  }

  if (!data.length) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  const searchPlaceholder = typeof searchable === 'string'
    ? searchable
    : 'Search this table…';

  return (
    <div>
      {/* Built-in search bar — global filter across every cell. Hides when
          `searchable={false}` is passed, or when the dataset has fewer rows
          than a single page (no point searching 3 rows). */}
      {searchable && data.length > pageSize && (
        <div className="relative mb-3 max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-gold/70" />
          <Input
            placeholder={searchPlaceholder}
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="pl-8"
          />
        </div>
      )}
      {/* Mobile card stack — only when caller supplies mobileCard. Sort +
          pagination + search still drive the row set; this just swaps the
          per-row presentation on phones. */}
      {mobileCard && (
        <div className="space-y-2 lg:hidden">
          {table.getRowModel().rows.length === 0 ? (
            <div className="rounded-lg border border-border bg-card px-3 py-6 text-center text-sm text-text-faint">
              No matches for &ldquo;{globalFilter}&rdquo;.
            </div>
          ) : (
            table.getRowModel().rows.map((row, idx) => (
              <div key={row.id} className="rounded-lg border border-border bg-card p-3">
                {mobileCard(row.original, idx)}
              </div>
            ))
          )}
        </div>
      )}
      <div className={cn(
        'overflow-x-auto rounded-xl border border-border bg-card lg:overflow-x-hidden',
        mobileCard && 'hidden lg:block',
      )}>
        <table className="w-full text-sm">
          <thead className="bg-secondary/40">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-border">
                {hg.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  return (
                    <th
                      key={header.id}
                      className="px-3 py-2.5 text-left text-[11px] font-bold uppercase tracking-[0.06em] text-text-faint"
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          className="inline-flex items-center gap-1 transition-colors hover:text-gold"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          <ArrowUpDown className="size-3 opacity-50" />
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-10 text-center text-sm text-text-faint">
                  No matches for &ldquo;{globalFilter}&rdquo;.
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row, idx) => (
                <tr
                  key={row.id}
                  className={cn(
                    'group border-b border-border/60 last:border-0 transition-colors',
                    idx % 2 === 1 ? 'bg-secondary/15' : 'bg-card',
                    'hover:bg-gold/[0.04]',
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2.5 align-middle">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-text-faint">
        <div className="flex flex-wrap items-center gap-3">
          {!!pageSizeOptions?.length && (
            <label className="flex items-center gap-1.5">
              <span>Show</span>
              <select
                className="h-8 rounded-md border border-border bg-secondary/40 px-2 text-xs text-foreground"
                value={table.getState().pagination.pageSize}
                onChange={(e) => table.setPageSize(Number(e.target.value))}
              >
                {pageSizeOptions.map((n) => (<option key={n} value={n}>{n}</option>))}
              </select>
              <span>per page</span>
            </label>
          )}
          <span className="font-mono">
            {table.getRowModel().rows.length} / {table.getFilteredRowModel().rows.length}
            {globalFilter && table.getFilteredRowModel().rows.length !== data.length && (
              <> (of {data.length})</>
            )}
            {' · '}Page {table.getState().pagination.pageIndex + 1}/{table.getPageCount() || 1}
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
            <ChevronLeft className="size-4" /> Prev
          </Button>
          <Button variant="outline" size="sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
            Next <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
