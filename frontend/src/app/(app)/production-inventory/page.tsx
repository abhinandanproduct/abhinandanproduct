'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Boxes, ChevronDown, ChevronRight, PackageCheck, Factory, Search, Image as ImageIcon, SlidersHorizontal,
} from 'lucide-react';
import { Api } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { cn, fileUrl, formatCurrency, formatDate } from '@/lib/utils';
import Link from 'next/link';

/**
 * Production Inventory — STOCK at each process step.
 *
 * Cards = processes in the manufacturing flow. Each card totals the pieces
 * physically in-house at that step right now (received from a vendor at that
 * process, not yet forwarded onward). This is mid-pipeline inventory that
 * can be pulled into a new batch without re-doing the upstream steps.
 *
 * Special "Packing — finished & ready" card surfaces packed inventory ready
 * to ship.
 *
 * Short-closed-batch lots are highlighted with a red ring + label so they
 * don't get confused with active in-process stock.
 *
 * Click any card to expand → table of designs/colours/vendors with qty.
 */

const PROCESS_ORDER = ['CAM', 'CASTING', 'DIE_NUMBER', 'FILING', 'POLISH', 'KACHA_FITTING', 'MAGNET', 'SAND_BLAST', 'PLATING', 'MEENA', 'FITTING_MALA', 'STICKING', 'PACKING'];
const PROCESS_LABEL: Record<string, string> = {
  CAM:           'CAM',
  CASTING:       'Casting',
  DIE_NUMBER:    'Die Number',
  FILING:        'Filing',
  POLISH:        'Polish',
  KACHA_FITTING: 'Kacha Fitting',
  MAGNET:        'Magnet',
  SAND_BLAST:    'Sand Blast',
  PLATING:       'Plating',
  MEENA:         'Meena',
  FITTING_MALA:  'Fitting + Mala',
  STICKING:      'Sticking',
  PACKING:       'Packing',
};

// Visual tones per process — keyed off the semantic accents defined in
// globals.css. Cards inherit the dark theme; the bg/ring/pill values are
// thin HSL-alpha tints layered on top, so the dark surface still shows
// through and the chain reads at a glance without screaming.
const TONE = {
  gold:    { ring: 'ring-gold/30',    bg: 'bg-gold/[0.06]',    pill: 'bg-gold/15 text-gold-light',   icon: 'text-gold' },
  success: { ring: 'ring-success/30', bg: 'bg-success/[0.06]', pill: 'bg-success/15 text-success',   icon: 'text-success' },
  info:    { ring: 'ring-info/30',    bg: 'bg-info/[0.06]',    pill: 'bg-info/15 text-info',         icon: 'text-info' },
  warning: { ring: 'ring-warning/30', bg: 'bg-warning/[0.06]', pill: 'bg-warning/15 text-warning',   icon: 'text-warning' },
  neutral: { ring: 'ring-border',     bg: 'bg-secondary/40',   pill: 'bg-secondary text-text-muted', icon: 'text-text-muted' },
} as const;
const PROCESS_TONE: Record<string, typeof TONE[keyof typeof TONE]> = {
  CAM:           TONE.neutral,
  CASTING:       TONE.warning,   // hot metal
  DIE_NUMBER:    TONE.neutral,
  FILING:        TONE.neutral,
  POLISH:        TONE.info,
  KACHA_FITTING: TONE.info,
  MAGNET:        TONE.info,
  SAND_BLAST:    TONE.warning,
  PLATING:       TONE.gold,      // bifurcation point
  MEENA:         TONE.warning,   // colour-rich
  FITTING_MALA:  TONE.info,
  STICKING:      TONE.gold,
  PACKING:       TONE.success,   // finish line
};

// Module-level cache — survives client-side nav, resets on hard reload.
let cachedProdInvFilter = { search: '' };

export default function ProductionInventoryPage() {
  const [search, setSearch] = React.useState(() => cachedProdInvFilter.search);
  React.useEffect(() => { cachedProdInvFilter = { search }; }, [search]);
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  const { data, isLoading } = useQuery({
    queryKey: ['produced'],
    queryFn: () => Api.casting.produced(),
    refetchOnWindowFocus: true,
  });

  const rows = (data?.rows ?? []) as any[];
  // shortByProcess is INFO ONLY (not inventory). It's a per-process tally of
  // pcs that were short-closed at a vendor — they're written-off losses on
  // the vendor ledger, never stock in our house. Used for the contextual
  // sub-line on each process card. See backend producedGoods() for details.
  const shortByProcess = (data?.shortByProcess ?? {}) as Record<string, number>;
  const q = search.trim().toLowerCase();

  // Bucket stock by process — INVENTORY ONLY. We drop AT_VENDOR rows up
  // front because at-vendor pcs are not ours (vendor holds them) and the
  // user wants this page to read as pure "what's with us, ready for the
  // next step". At-vendor visibility lives on Production Tracking.
  const byProcess = React.useMemo(() => {
    const map = new Map<string, any[]>();
    for (const r of rows) {
      if (r.state === 'AT_VENDOR') continue;
      const code = r.processCode || 'OTHER';
      const arr = map.get(code) ?? [];
      arr.push(r);
      map.set(code, arr);
    }
    return map;
  }, [rows]);

  // Filter by search (matches design / vendor / colour / batch number).
  const matches = (r: any) =>
    !q || [r.designCode, r.itemName, String(r.itemNumber ?? ''), r.vendorName, r.vendorCode, r.color, ...(r.batches || [])]
      .some((x: any) => (x ?? '').toString().toLowerCase().includes(q));

  // Process cards. INVENTORY = pcs we PHYSICALLY HOLD at this step (received
  // from vendor, idle, ready for the next step). Packing FINISHED also
  // counts as in-house since we hold packed pcs.
  // Short-closed pcs are LOST (vendor owes them on the ledger) — surfaced
  // as a small contextual line via shortByProcess from the backend, never
  // as inventory rows.
  const cards = PROCESS_ORDER.map((code) => {
    const stock        = (byProcess.get(code) ?? []).filter(matches);
    const inHouseQty   = stock.filter((r) => r.state === 'IN_HOUSE' || r.state === 'FINISHED').reduce((s, r) => s + r.qty, 0);
    const designCount  = new Set(stock.map((r) => r.itemId)).size;
    const shortClosedQty = shortByProcess[code] ?? 0;
    return { code, name: PROCESS_LABEL[code] ?? code, stock, inHouseQty, shortClosedQty, designCount };
  });

  // Grand totals strip at the top — STOCK is in-house only.
  const grandStocked     = cards.reduce((s, c) => s + c.inHouseQty, 0);
  const grandPacked      = (byProcess.get('PACKING') ?? []).filter(matches).filter((r) => r.state === 'FINISHED').reduce((s, r) => s + r.qty, 0);
  const grandShortClosed = cards.reduce((s, c) => s + c.shortClosedQty, 0);

  return (
    <div>
      <PageHeader
        title="Production Inventory"
        subtitle="What we physically hold today — pcs received and sitting idle at each process step, ready for the next operation. Pcs currently with a karigar (at-vendor) live on Production Tracking, not here. Short-closed losses are noted as a small line for context."
      />

      {/* Search + grand totals */}
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="relative min-w-[260px] flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search design / item no. / vendor / colour / batch…"
              className="pl-8"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill icon={Boxes}        tone="sky"     label="Total Stocked"   value={grandStocked} />
            <Pill icon={PackageCheck} tone="emerald" label="Packed & Ready"  value={grandPacked} />
            <Pill icon={Factory}      tone="red"     label="From Short-Closed Batches" value={grandShortClosed} />
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground"><Spinner /> Loading…</div>
      ) : (
        // 2 cards per row when collapsed; expanded cards span FULL WIDTH so
        // the drill-down table has room to breathe. Default `items-stretch`
        // (no items-start) makes the two collapsed cards in a row the same
        // height — Plating's 3-chip header no longer leaves Casting looking
        // shorter. Expanded cards land alone in their row (col-span-2) so
        // they don't drag neighbours along.
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {cards.map((c) => {
            const isOpen = !!open[c.code];
            const tone = PROCESS_TONE[c.code] ?? PROCESS_TONE.CASTING;
            // "Empty" = no in-house stock AND no short-close residue. A
            // card with ONLY short-close residue still renders so the loss
            // line is visible. (At-vendor pcs are NOT inventory and are
            // already excluded upstream in byProcess.)
            const empty = c.inHouseQty === 0 && c.shortClosedQty === 0;
            return (
              <Card
                key={c.code}
                className={cn(
                  // h-full + grid items-stretch (default) makes BOTH cards
                  // in a row match the tallest one — uniform height across
                  // any row, regardless of how many chip badges each card
                  // has (Plating w/ short-closed vs Casting without).
                  'flex h-full flex-col overflow-hidden ring-1 transition-all',
                  tone.ring,
                  empty && 'opacity-60',
                  // Expanded card spans BOTH columns of the 2-col grid so its
                  // drill-down table has full width — no truncated vendor names
                  // or cropped source badges. Collapsed cards stay 1-up.
                  isOpen && 'md:col-span-2',
                )}
              >
                <CardContent className="flex flex-1 flex-col p-0">
                  <button
                    type="button"
                    onClick={() => !empty && setOpen((m) => ({ ...m, [c.code]: !isOpen }))}
                    disabled={empty}
                    className={cn(
                      // min-h baseline + flex-1 = even a single-chip card
                      // (or empty card) fills the same vertical space as a
                      // 3-chip card → the whole row reads as uniform tiles.
                      // grow only when collapsed; when expanded the table
                      // below takes care of the extra height.
                      'flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors',
                      !isOpen && 'min-h-[7rem] flex-1',
                      tone.bg,
                      !empty && 'hover:brightness-95 cursor-pointer',
                      empty && 'cursor-default',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {!empty && (isOpen
                          ? <ChevronDown className={cn('size-4', tone.icon)} />
                          : <ChevronRight className={cn('size-4', tone.icon)} />)}
                        <span className={cn('text-base font-semibold', tone.icon)}>
                          {c.code === 'PACKING' ? '📦 Packing — Finished & Ready' : `🛠 ${c.name}`}
                        </span>
                      </div>
                      {/* BIG number = stock in our hand at this step (in-house
                          + Packing-finished). At-vendor pcs and short-closed
                          pcs are NOT included — at-vendor pcs are still with
                          the karigar; short-closed pcs are written-off losses
                          owed by the vendor on the ledger. Both still surface
                          as their own chips/lines below for full visibility. */}
                      <Badge variant="outline" className="text-base font-bold">
                        {c.inHouseQty.toLocaleString()} pcs stock
                      </Badge>
                    </div>
                    <div className="ml-6 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {empty ? (
                        <span>No stock at this step.</span>
                      ) : c.designCount > 0 ? (
                        <span>{c.designCount} design{c.designCount === 1 ? '' : 's'}</span>
                      ) : null}
                    </div>
                    {/* Small short-closed LINE (under the chips). Always own
                        line so the loss reads as a separate fact, not as a
                        stock chip. Catches both batch-level closed batches
                        and stage-level short-closes from active batches. */}
                    {c.shortClosedQty > 0 && (
                      <div className="ml-6 mt-1 text-xs font-medium text-destructive"
                        title="Pcs that were ordered at this step but never returned — vendor owes them on the ledger. Not counted as stock.">
                        ⛔ {c.shortClosedQty.toLocaleString()} pcs short-closed at this step
                      </div>
                    )}
                  </button>
                  {isOpen && !empty && (
                    <ProcessStockTable rows={c.stock} processCode={c.code} />
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Our Items catalog — every design we have in the system, with photo
          + key details + current stock total (rolled up across all states).
          A scrollable showcase / picker for "what do we make". */}
      <div className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">📚 Our Items — Design Catalog</h2>
        <ItemsCatalog rows={rows} byDesign={data?.byDesign ?? []} search={q} />
      </div>
    </div>
  );
}

function Pill({ icon: Icon, tone, label, value }: { icon: any; tone: 'sky'|'emerald'|'red'; label: string; value: number }) {
  const map = {
    sky:     'bg-info/10 text-info border-info/30',
    emerald: 'bg-success/10 text-success border-success/30',
    red:     'bg-destructive/10 text-destructive border-destructive/30',
  } as const;
  return (
    <div className={cn('flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium', map[tone])}>
      <Icon className="size-4" />
      <span>{label}</span>
      <span className="font-bold">{value.toLocaleString()}</span>
      <span className="text-xs opacity-70">pcs</span>
    </div>
  );
}

// At-vendor rows are dropped upstream — this page is inventory-only.
type SourceFilter = 'all' | 'inHouse' | 'packed' | 'shortClosed';
type RowSortKey = 'default' | 'qtyDesc' | 'qtyAsc' | 'designAsc' | 'vendorAsc' | 'batchAsc';

function ProcessStockTable({ rows, processCode }: { rows: any[]; processCode: string }) {
  // Per-table toolbar state — source / vendor filters + sort key. Each
  // process card keeps its own filters since opening Casting vs Plating
  // expects independent views (one might want only "at vendor", the
  // other "in-house only").
  const [sourceFilter, setSourceFilter] = React.useState<SourceFilter>('all');
  const [vendorFilter, setVendorFilter] = React.useState<string>('');
  const [sortBy, setSortBy] = React.useState<RowSortKey>('default');

  // Vendor list (unique) — used to populate the vendor filter dropdown.
  const vendorOptions = React.useMemo(() => {
    const m = new Map<string, { code: string; name: string }>();
    for (const r of rows) {
      if (!r.vendorCode) continue;
      if (!m.has(r.vendorCode)) m.set(r.vendorCode, { code: r.vendorCode, name: r.vendorName ?? '' });
    }
    return Array.from(m.values()).sort((a, b) => a.code.localeCompare(b.code));
  }, [rows]);

  // Apply filters first, then sort. AT_VENDOR rows were already excluded
  // upstream in byProcess — this table only ever sees inventory rows.
  const visible = React.useMemo(() => {
    return rows.filter((r) => {
      // Source filter
      if (sourceFilter === 'inHouse'    && !(r.state === 'IN_HOUSE' && !r.batchClosed)) return false;
      if (sourceFilter === 'packed'     && !(r.state === 'FINISHED' && processCode === 'PACKING' && !r.batchClosed)) return false;
      if (sourceFilter === 'shortClosed' && !r.batchClosed) return false;
      // Vendor filter
      if (vendorFilter && r.vendorCode !== vendorFilter) return false;
      return true;
    });
  }, [rows, sourceFilter, vendorFilter, processCode]);

  const sorted = React.useMemo(() => {
    const arr = [...visible];
    arr.sort((a, b) => {
      switch (sortBy) {
        case 'qtyDesc':    return b.qty - a.qty;
        case 'qtyAsc':     return a.qty - b.qty;
        case 'designAsc':  return String(a.itemNumber ?? '').localeCompare(String(b.itemNumber ?? ''), undefined, { numeric: true });
        case 'vendorAsc':  return String(a.vendorCode ?? '').localeCompare(String(b.vendorCode ?? ''));
        case 'batchAsc':   return String((a.batches ?? [])[0] ?? '').localeCompare(String((b.batches ?? [])[0] ?? ''));
        case 'default':
        default: {
          // Short-closed first → in-house → at-vendor → design# → colour
          if (a.batchClosed !== b.batchClosed) return a.batchClosed ? -1 : 1;
          if (a.state !== b.state) {
            const order: Record<string, number> = { FINISHED: 0, IN_HOUSE: 1, AT_VENDOR: 2 };
            return (order[a.state] ?? 9) - (order[b.state] ?? 9);
          }
          const an = String(a.itemNumber ?? ''); const bn = String(b.itemNumber ?? '');
          if (an !== bn) return an.localeCompare(bn, undefined, { numeric: true });
          return (a.color ?? '').localeCompare(b.color ?? '');
        }
      }
    });
    return arr;
  }, [visible, sortBy]);

  // Tally per-source for the chip counts (helps the user know what's
  // available before clicking a filter chip).
  const counts = React.useMemo(() => {
    const c = { all: rows.length, inHouse: 0, packed: 0, shortClosed: 0 };
    for (const r of rows) {
      if (r.batchClosed) c.shortClosed++;
      else if (r.state === 'FINISHED' && processCode === 'PACKING') c.packed++;
      else if (r.state === 'IN_HOUSE') c.inHouse++;
      // AT_VENDOR rows never reach here — excluded upstream.
    }
    return c;
  }, [rows, processCode]);

  // One Source badge per state — the user sees at a glance what's in hand
  // vs what's still with a vendor (and what's frozen from a short-close).
  const sourceBadge = (r: any) => {
    if (r.batchClosed) return <Badge variant="destructive" className="text-xs">⛔ Short-closed batch</Badge>;
    if (processCode === 'PACKING' && r.state === 'FINISHED') return <Badge variant="success" className="text-xs">📦 Packed & ready</Badge>;
    if (r.state === 'IN_HOUSE') return <Badge variant="warning" className="text-xs">🏭 In-house (received)</Badge>;
    if (r.state === 'AT_VENDOR') return <Badge variant="info" className="text-xs">🚚 Still at vendor</Badge>;
    return <Badge variant="outline" className="text-xs">{r.state}</Badge>;
  };

  const filtered = sourceFilter !== 'all' || !!vendorFilter;

  return (
    <div className="border-t border-border bg-card">
      {/* Per-table toolbar — source chips + vendor filter + sort. Sits on the
          left so the table breathes; clear-filters button only when active. */}
      <div className="flex flex-wrap items-end gap-2 border-b border-border bg-muted/20 px-3 py-2">
        {/* Source filter chips */}
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Source</label>
          <div className="inline-flex h-8 overflow-hidden rounded-md border border-border bg-background text-xs">
            {([
              ['all', `All (${counts.all})`],
              ['inHouse', `🏭 In-house (${counts.inHouse})`],
              ['packed', `📦 Packed (${counts.packed})`],
              ['shortClosed', `⛔ Short-closed (${counts.shortClosed})`],
            ] as [SourceFilter, string][]).filter(([k]) => k === 'all' || (counts as any)[k] > 0).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setSourceFilter(k)}
                className={cn(
                  'px-2.5 transition-colors',
                  sourceFilter === k ? 'bg-primary text-primary-foreground font-medium' : 'text-foreground hover:bg-muted',
                )}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Vendor filter */}
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Vendor</label>
          <select
            className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            value={vendorFilter}
            onChange={(e) => setVendorFilter(e.target.value)}
          >
            <option value="">All vendors ({vendorOptions.length})</option>
            {vendorOptions.map((v) => (
              <option key={v.code} value={v.code}>{v.code} · {v.name}</option>
            ))}
          </select>
        </div>

        {/* Sort */}
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Sort</label>
          <select
            className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as RowSortKey)}
          >
            <option value="default">Default (status-first)</option>
            <option value="qtyDesc">Qty: high → low</option>
            <option value="qtyAsc">Qty: low → high</option>
            <option value="designAsc">Design # A → Z</option>
            <option value="vendorAsc">Vendor A → Z</option>
            <option value="batchAsc">Batch # A → Z</option>
          </select>
        </div>

        {filtered && (
          <button type="button"
            onClick={() => { setSourceFilter('all'); setVendorFilter(''); }}
            className="ml-auto h-8 rounded-md border border-border bg-background px-3 text-xs font-medium text-muted-foreground hover:bg-muted">
            Clear filters
          </button>
        )}
      </div>

      <div className="table-scroll">
      {/* min-w keeps columns readable on phones — horizontal scroll inside
          the bordered card instead of squishing every column. */}
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="whitespace-nowrap px-3 py-2 font-semibold">Design</th>
            <th className="whitespace-nowrap px-3 py-2 font-semibold">Colour</th>
            <th className="whitespace-nowrap px-3 py-2 font-semibold">Vendor (last touched)</th>
            <th className="whitespace-nowrap px-3 py-2 font-semibold">From batch</th>
            <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">Qty in stock</th>
            <th className="whitespace-nowrap px-3 py-2 font-semibold">Source</th>
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                No rows match the current filters.
              </td>
            </tr>
          ) : sorted.map((r, i) => (
            <tr key={`${r.itemId}-${r.state}-${r.color ?? ''}-${(r.batches || [])[0] ?? ''}-${i}`}
              className={cn(
                'border-t border-border align-top',
                r.batchClosed && 'bg-destructive/10/40',
                !r.batchClosed && r.state === 'AT_VENDOR' && 'bg-info/10/30',
              )}>
              <td className="px-3 py-2 whitespace-nowrap">
                <div className="font-semibold text-foreground">#{r.itemNumber ?? '—'} · {r.designCode}</div>
                {r.itemName && <div className="text-xs text-muted-foreground">{r.itemName}</div>}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                {r.color ? <Badge variant="outline">{r.color}</Badge> : <span className="text-muted-foreground">—</span>}
              </td>
              <td className="px-3 py-2 whitespace-nowrap text-foreground">
                {r.vendorCode ? <><strong>{r.vendorCode}</strong> · {r.vendorName}</> : '—'}
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                <div className="max-w-[12rem] whitespace-normal break-words">{(r.batches || []).join(', ') || '—'}</div>
              </td>
              <td className="px-3 py-2 text-right text-lg font-bold tabular-nums text-foreground whitespace-nowrap">
                {r.qty.toLocaleString()}
              </td>
              <td className="px-3 py-2 whitespace-nowrap">{sourceBadge(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {/* Footer summary — filtered totals so the user knows the visible
          scope at a glance ("12 of 27 rows · 4,500 of 5,662 pcs"). */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span>
          Showing <strong className="text-foreground">{sorted.length}</strong> of <strong className="text-foreground">{rows.length}</strong> row(s)
          {sorted.length > 0 && (
            <> · <strong className="text-foreground">{sorted.reduce((s, r) => s + r.qty, 0).toLocaleString()}</strong> pcs in view</>
          )}
        </span>
        <span className="text-muted-foreground/70">
          In-house pieces can be absorbed into a new batch via <strong>Review existing stock</strong>.
        </span>
      </div>
    </div>
  );
}

/**
 * Our Items — design catalog grid. Catalog-level toolbar for search /
 * category filter / sort / stock-state filter, then a grid of uniform-
 * height tiles (photo + 3-line details + chips). Each tile rolls up live
 * stock totals from the parent's produced rows.
 */
type SortKey = 'recent' | 'stockDesc' | 'stockAsc' | 'priceDesc' | 'priceAsc' | 'codeAsc';
type StockFilter = 'all' | 'inStock' | 'outOfStock';

function ItemsCatalog({ rows, byDesign, search }: { rows: any[]; byDesign: any[]; search: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['items'],
    queryFn: () => Api.items.list(),
    refetchOnWindowFocus: true,
  });
  const items = (data ?? []) as any[];

  // Local toolbar state — additive to the page-level search at top.
  const [localSearch, setLocalSearch] = React.useState('');
  const [category, setCategory] = React.useState<string>('');
  const [stockFilter, setStockFilter] = React.useState<StockFilter>('all');
  const [sortBy, setSortBy] = React.useState<SortKey>('recent');
  // Selected item for the detail statement dialog. Null = closed.
  const [statementItem, setStatementItem] = React.useState<any>(null);

  // Stock totals per itemId. `shortClosed` now sums BOTH the received pcs
  // from short-closed batches (still in our stock, just from a frozen
  // batch) AND the short qty (pcs the vendor never delivered and got
  // frozen on the ledger). Tile chip shows the combined ordered total
  // so the user sees the full "lost batch" impact.
  // byDesign (from /casting/produced) carries rejected/in-repair totals
  // server-side; mapped here for O(1) lookup per item tile.
  const byDesignMap = React.useMemo(() => {
    const m = new Map<number, { rejected: number; inRepair: number; openRepairs: any[] }>();
    for (const d of byDesign) {
      m.set(d.itemId, {
        rejected: d.rejectedQty ?? 0,
        inRepair: d.inRepairQty ?? 0,
        openRepairs: d.openRepairs ?? [],
      });
    }
    return m;
  }, [byDesign]);
  const stockByItem = React.useMemo(() => {
    const m = new Map<number, {
      finished: number; inHouse: number; atVendor: number; shortClosed: number; total: number;
      rejected: number; inRepair: number; openRepairs: any[];
      rows: any[];
    }>();
    for (const r of rows) {
      if (!r.itemId) continue;
      const cur = m.get(r.itemId) ?? {
        finished: 0, inHouse: 0, atVendor: 0, shortClosed: 0, total: 0,
        rejected: 0, inRepair: 0, openRepairs: [] as any[],
        rows: [] as any[],
      };
      if (r.batchClosed) cur.shortClosed += r.qty + (r.shortQty ?? 0);
      if (r.state === 'FINISHED') cur.finished += r.qty;
      else if (r.state === 'IN_HOUSE') cur.inHouse += r.qty;
      else if (r.state === 'AT_VENDOR') cur.atVendor += r.qty;
      cur.total += r.qty;
      cur.rows.push(r);
      m.set(r.itemId, cur);
    }
    // Mix in rejected / in-repair / openRepairs[] from byDesign.
    for (const [itemId, agg] of m) {
      const d = byDesignMap.get(itemId);
      if (d) { agg.rejected = d.rejected; agg.inRepair = d.inRepair; agg.openRepairs = d.openRepairs; }
    }
    return m;
  }, [rows, byDesignMap]);

  // Unique categories for the filter dropdown.
  const categories = React.useMemo(() => {
    const set = new Set<string>();
    for (const it of items) if (it.category) set.add(it.category);
    return Array.from(set).sort();
  }, [items]);

  // Combine page-level + local search.
  const effectiveSearch = (search || localSearch).trim().toLowerCase();

  const filtered = items.filter((it) => {
    // Text search
    if (effectiveSearch) {
      const hay = [it.sampleDesignCode, String(it.itemNumber ?? ''), it.category, it.collection, it.designerName]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(effectiveSearch)) return false;
    }
    // Category filter
    if (category && it.category !== category) return false;
    // Stock filter
    const s = stockByItem.get(it.id);
    if (stockFilter === 'inStock' && (!s || s.total <= 0)) return false;
    if (stockFilter === 'outOfStock' && s && s.total > 0) return false;
    return true;
  });

  // Apply sort.
  const sorted = React.useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const sa = stockByItem.get(a.id)?.total ?? 0;
      const sb = stockByItem.get(b.id)?.total ?? 0;
      const pa = Number(a.sellingPrice ?? 0);
      const pb = Number(b.sellingPrice ?? 0);
      switch (sortBy) {
        case 'stockDesc': return sb - sa;
        case 'stockAsc':  return sa - sb;
        case 'priceDesc': return pb - pa;
        case 'priceAsc':  return pa - pb;
        case 'codeAsc':   return String(a.sampleDesignCode ?? '').localeCompare(String(b.sampleDesignCode ?? ''), undefined, { numeric: true });
        case 'recent':
        default:          return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
      }
    });
    return arr;
  }, [filtered, sortBy, stockByItem]);

  // Grand totals for the toolbar — handy at-a-glance summary.
  const grand = sorted.reduce(
    (acc, it) => {
      const s = stockByItem.get(it.id);
      if (s) { acc.total += s.total; acc.finished += s.finished; acc.inHouse += s.inHouse; acc.atVendor += s.atVendor; }
      return acc;
    },
    { total: 0, finished: 0, inHouse: 0, atVendor: 0 },
  );

  if (isLoading) {
    return <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground"><Spinner /> Loading items…</div>;
  }

  return (
    <Card>
      <CardContent className="p-4">
        {/* Toolbar — search, filters, sort. All compose with the page-level
            search box too (above the process cards). */}
        <div className="mb-4 flex flex-wrap items-end gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search the catalog (code / category / designer)…"
              className="pl-8"
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">Category</label>
            <select
              className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">All categories</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">Stock</label>
            <div className="inline-flex h-9 overflow-hidden rounded-md border border-border bg-background text-sm">
              {(['all', 'inStock', 'outOfStock'] as StockFilter[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setStockFilter(k)}
                  className={cn(
                    'px-3 transition-colors',
                    stockFilter === k ? 'bg-primary text-primary-foreground font-medium' : 'text-foreground hover:bg-muted',
                  )}
                >
                  {k === 'all' ? 'All' : k === 'inStock' ? 'In stock' : 'Out'}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">Sort</label>
            <select
              className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
            >
              <option value="recent">Recently updated</option>
              <option value="stockDesc">Stock: high → low</option>
              <option value="stockAsc">Stock: low → high</option>
              <option value="priceDesc">Price: high → low</option>
              <option value="priceAsc">Price: low → high</option>
              <option value="codeAsc">Design code A → Z</option>
            </select>
          </div>

          {(localSearch || category || stockFilter !== 'all' || sortBy !== 'recent') && (
            <button
              type="button"
              onClick={() => { setLocalSearch(''); setCategory(''); setStockFilter('all'); setSortBy('recent'); }}
              className="h-9 self-end rounded-md border border-border bg-background px-3 text-sm font-medium text-muted-foreground hover:bg-muted"
            >
              Clear filters
            </button>
          )}
        </div>

        {/* Result summary */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <div>
            <strong className="text-foreground">{sorted.length}</strong> design{sorted.length === 1 ? '' : 's'}
            {sorted.length !== items.length && <> (of {items.length})</>}
          </div>
          {grand.total > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span>Total stock in view:</span>
              <Badge variant="outline" className="font-semibold">{grand.total.toLocaleString()} pcs</Badge>
              {grand.finished > 0 && <Badge variant="success">✓ {grand.finished.toLocaleString()}</Badge>}
              {grand.inHouse > 0 && <Badge variant="warning">🏭 {grand.inHouse.toLocaleString()}</Badge>}
              {grand.atVendor > 0 && <Badge variant="info">🚚 {grand.atVendor.toLocaleString()}</Badge>}
            </div>
          )}
        </div>

        {/* Tile grid */}
        {sorted.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-muted-foreground">
            {items.length === 0
              ? 'No items in the system yet — add designs from the Item Master to populate this catalog.'
              : 'No items match the current filters.'}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {sorted.map((it) => (
              <CatalogTile
                key={it.id}
                item={it}
                stock={stockByItem.get(it.id)}
                onOpen={() => setStatementItem(it)}
              />
            ))}
          </div>
        )}
      </CardContent>
      {/* Detail "statement" dialog — opens when a tile is clicked. Shows the
          full breakdown of where this design's pcs are: finished, in-house
          per process, at vendor per vendor, and short-closed lots. */}
      <ItemStatementDialog
        item={statementItem}
        stock={statementItem ? stockByItem.get(statementItem.id) : undefined}
        open={!!statementItem}
        onClose={() => setStatementItem(null)}
      />
    </Card>
  );
}

/** Uniform tile: square photo + fixed 3-row details + fixed-height chip row.
 *  Total height is identical for every tile — no jagged grid.
 *  Click opens the per-item statement dialog (not the Item Master page —
 *  the dialog gives the focused production breakdown the user asked for). */
function CatalogTile({ item, stock, onOpen }: { item: any; stock?: { finished: number; inHouse: number; atVendor: number; shortClosed: number; total: number }; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-all hover:-translate-y-0.5 hover:shadow-lg"
    >
      {/* Square photo. Larger than before for visual punch. */}
      <div className="relative aspect-square overflow-hidden bg-gradient-to-br from-muted/40 to-muted">
        {item.thumbUrl ? (
          // Wrapped in an anchor so click on the photo (not the tile body)
          // opens the full image in a new tab. stopPropagation keeps the
          // tile's own click (item statement dialog) from firing.
          <a
            href={fileUrl(item.thumbUrl)}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-0"
            title="Open full image"
            aria-label="Open full image"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={fileUrl(item.thumbUrl)}
              alt={item.sampleDesignCode ?? `Item ${item.id}`}
              className="size-full object-contain bg-muted transition-transform duration-300 group-hover:scale-105"
              loading="lazy"
            />
          </a>
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-1.5 text-muted-foreground/60">
            <ImageIcon className="size-10" />
            <span className="text-xs font-medium">No photo</span>
          </div>
        )}
        {/* Stock badge top-right */}
        {stock && stock.total > 0 && (
          <div className="absolute right-2 top-2 rounded-full bg-foreground/90 px-2.5 py-0.5 text-xs font-bold text-white shadow-md backdrop-blur-sm">
            {stock.total.toLocaleString()} pcs
          </div>
        )}
        {/* Status flag bottom-left */}
        {item.sampleStatus === 'PRODUCTION_READY' && (
          <div className="absolute bottom-2 left-2 rounded bg-success/90 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow-md">
            Production Ready
          </div>
        )}
      </div>

      {/* Fixed-height details block — every tile has exactly the same layout
          so the grid stays a clean rectangle. */}
      <div className="flex flex-1 flex-col px-3 py-2.5">
        <div className="line-clamp-1 text-sm font-semibold text-foreground">
          #{item.itemNumber ?? '—'} · {item.sampleDesignCode ?? '—'}
        </div>
        <div className="line-clamp-1 text-xs text-muted-foreground" title={item.category ?? ''}>
          {item.category || (item.collection || '—')}
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium text-foreground/85">
            {item.sellingPrice != null ? formatCurrency(item.sellingPrice) : <span className="text-muted-foreground">—</span>}
          </span>
          {item.designerName && (
            <span className="line-clamp-1 text-[11px] text-muted-foreground" title={item.designerName}>
              {item.designerName}
            </span>
          )}
        </div>
        {/* Chip row — always 24px tall so tiles align even when chips absent.
            Short-closed chip is surfaced on the main page so the user sees
            "this design has lost N pcs to short-closes" at a glance. */}
        <div className="mt-2 flex h-6 flex-wrap gap-1 overflow-hidden">
          {stock && stock.finished > 0 && <Badge variant="success" className="text-[10px]">✓ {stock.finished.toLocaleString()}</Badge>}
          {stock && stock.inHouse > 0 && <Badge variant="warning" className="text-[10px]">🏭 {stock.inHouse.toLocaleString()}</Badge>}
          {stock && stock.atVendor > 0 && <Badge variant="info" className="text-[10px]">🚚 {stock.atVendor.toLocaleString()}</Badge>}
          {stock && stock.shortClosed > 0 && <Badge variant="destructive" className="text-[10px]">⛔ {stock.shortClosed.toLocaleString()}</Badge>}
          {(!stock || stock.total === 0) && (
            <span className="text-[10px] italic text-muted-foreground">No stock yet</span>
          )}
        </div>
      </div>
    </button>
  );
}

/**
 * Detailed inventory statement for a single design — a focused "where is
 * every piece of this design right now" view. Sections:
 *   📦 Finished & Ready — packed pcs in our hands
 *   🏭 In-House — pcs received mid-process, sitting at our place
 *   🚚 At Vendor — pcs currently with karigars
 *   ⛔ Short-Closed — frozen lots from closed batches
 * Each section breaks down further by process / vendor / batch so the
 * user knows exactly where to look for any piece.
 */
function ItemStatementDialog({
  item, stock, open, onClose,
}: {
  item: any;
  stock?: {
    finished: number; inHouse: number; atVendor: number; shortClosed: number; total: number; rows: any[];
    rejected?: number; inRepair?: number; openRepairs?: any[];
  };
  open: boolean;
  onClose: () => void;
}) {
  if (!item) return null;
  const itemRows = stock?.rows ?? [];

  // Bucket rows for each section.
  const finishedRows  = itemRows.filter((r) => r.state === 'FINISHED' && !r.batchClosed);
  const inHouseRows   = itemRows.filter((r) => r.state === 'IN_HOUSE' && !r.batchClosed);
  const atVendorRows  = itemRows.filter((r) => r.state === 'AT_VENDOR' && !r.batchClosed);
  const shortRows     = itemRows.filter((r) => r.batchClosed);

  // Group in-house and at-vendor rows by process for the per-section tables.
  const groupBy = (rows: any[], key: (r: any) => string) => {
    const m = new Map<string, any[]>();
    for (const r of rows) {
      const k = key(r);
      const arr = m.get(k) ?? [];
      arr.push(r);
      m.set(k, arr);
    }
    return Array.from(m.entries());
  };
  const inHouseByProcess = groupBy(inHouseRows, (r) => r.processName ?? '—');
  const atVendorByProcess = groupBy(atVendorRows, (r) => r.processName ?? '—');

  return (
    <Dialog open={open} onClose={onClose} size="xl"
      title={`📋 Statement — #${item.itemNumber ?? '—'} · ${item.sampleDesignCode ?? ''}`}
      description={item.category || item.collection || ''}
      footer={
        <>
          <Link href={`/items/${item.id}`}>
            <Button variant="outline" type="button">Open in Item Master</Button>
          </Link>
          <Button onClick={onClose}>Close</Button>
        </>
      }>
      <div className="space-y-4">
        {/* Hero strip — photo + headline numbers */}
        <div className="flex gap-4 rounded-lg border border-border bg-muted/30 p-3">
          <div className="size-32 shrink-0 overflow-hidden rounded-lg border border-border bg-card">
            {item.thumbUrl ? (
              <a href={fileUrl(item.thumbUrl)} target="_blank" rel="noreferrer" className="block size-full" title="Open full image">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={fileUrl(item.thumbUrl)} alt="" className="size-full object-contain bg-muted transition-opacity hover:opacity-80" />
              </a>
            ) : (
              <div className="flex size-full items-center justify-center text-xs text-muted-foreground">No photo</div>
            )}
          </div>
          <div className="flex-1 space-y-1.5">
            <div className="text-sm text-muted-foreground">{item.designerName ?? '—'}</div>
            <div className="text-2xl font-bold text-foreground">
              {(stock?.total ?? 0).toLocaleString()} <span className="text-sm font-normal text-muted-foreground">pcs total</span>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="success">✓ {(stock?.finished ?? 0).toLocaleString()} packed</Badge>
              <Badge variant="warning">🏭 {(stock?.inHouse ?? 0).toLocaleString()} in-house</Badge>
              <Badge variant="info">🚚 {(stock?.atVendor ?? 0).toLocaleString()} at vendor</Badge>
              {(stock?.shortClosed ?? 0) > 0 && (
                <Badge variant="destructive">⛔ {(stock!.shortClosed).toLocaleString()} short-closed</Badge>
              )}
            </div>
            {item.sellingPrice != null && (
              <div className="text-sm font-medium text-foreground">{formatCurrency(item.sellingPrice)}</div>
            )}
          </div>
        </div>

        {/* Empty fallback */}
        {(stock?.total ?? 0) === 0 && (
          <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
            No pieces of this design exist in production yet.
          </div>
        )}

        {/* Section 1 — Finished & Ready */}
        {finishedRows.length > 0 && (
          <StatementSection
            title="📦 Finished & Ready (packed, in our hands)"
            tone="emerald"
            total={finishedRows.reduce((s, r) => s + r.qty, 0)}
            rows={finishedRows}
            cols={['Colour', 'Vendor', 'Batch', 'Qty']}
            renderRow={(r) => [
              r.color || '—',
              r.vendorCode ? `${r.vendorCode} · ${r.vendorName}` : '—',
              (r.batches ?? []).join(', ') || '—',
              r.qty.toLocaleString(),
            ]}
          />
        )}

        {/* Section 2 — In-House (received mid-pipeline, sitting at our place) */}
        {inHouseRows.length > 0 && (
          <div>
            <SectionHeader
              title="🏭 In-House — half-made, at our place"
              subtitle="Received from a vendor at this step, not yet forwarded onward. Can be absorbed into a new batch."
              tone="amber"
              total={inHouseRows.reduce((s, r) => s + r.qty, 0)}
            />
            <div className="mt-2 space-y-2">
              {inHouseByProcess.map(([proc, prows]) => (
                <ProcessSubgroup key={proc} processName={proc} rows={prows} mode="inHouse" />
              ))}
            </div>
          </div>
        )}

        {/* Section 3 — At Vendor (currently with karigar) */}
        {atVendorRows.length > 0 && (
          <div>
            <SectionHeader
              title="🚚 Still At Vendor — under process with karigar"
              subtitle="Issued to a vendor for this step, not yet received back."
              tone="sky"
              total={atVendorRows.reduce((s, r) => s + r.qty, 0)}
            />
            <div className="mt-2 space-y-2">
              {atVendorByProcess.map(([proc, prows]) => (
                <ProcessSubgroup key={proc} processName={proc} rows={prows} mode="atVendor" />
              ))}
            </div>
          </div>
        )}

        {/* Section 3b — Rejected pcs (lifetime, across all batches). Info
            section; deductions apply on the vendor ledger. */}
        {(stock?.rejected ?? 0) > 0 && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10/40 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-semibold text-destructive">⛔ Rejected (failed QC)</span>
              <span className="font-bold text-red-900 tabular-nums">{stock?.rejected?.toLocaleString()} pcs</span>
            </div>
            <p className="mt-1 text-[11px] text-destructive">
              Pcs that vendors returned but failed QC. Payment treatment was recorded per rejection
              (No Pay / Adjusted / Full Pay) — see Vendor Ledger for the running deductions.
            </p>
          </div>
        )}

        {/* Section 3c — Pcs currently with a vendor for repair. No payment
            impact while open; if user gives up, they final-reject from /repairs.
            Lists each open RepairOrder so the user sees "where is each repair
            stuck" (which batch, which vendor, which cycle, what defect) in
            one place, instead of having to drill across batches. */}
        {(stock?.inRepair ?? 0) > 0 && (
          <div className="rounded-lg border border-warning/30 bg-warning/15 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-semibold text-warning">🔧 Currently at Repair</span>
              <span className="font-bold text-warning tabular-nums">{stock?.inRepair?.toLocaleString()} pcs</span>
            </div>
            {(stock?.openRepairs ?? []).length > 0 && (
              <div className="mt-2 table-scroll rounded border border-warning/30 bg-card">
                <table className="w-full min-w-[640px] text-xs">
                  <thead className="bg-warning/15/60 text-left text-warning">
                    <tr>
                      <th className="px-2 py-1.5 font-semibold">Repair</th>
                      <th className="px-2 py-1.5 font-semibold">Batch</th>
                      <th className="px-2 py-1.5 font-semibold">Vendor</th>
                      <th className="px-2 py-1.5 font-semibold">Process</th>
                      <th className="px-2 py-1.5 font-semibold">Colour</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Qty</th>
                      <th className="px-2 py-1.5 text-center font-semibold">Cycle</th>
                      <th className="px-2 py-1.5 font-semibold">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(stock?.openRepairs ?? []).map((r: any) => (
                      <tr key={r.id} className="border-t border-warning/30/50">
                        <td className="px-2 py-1.5 font-mono font-semibold text-warning">REP-{r.id}</td>
                        <td className="px-2 py-1.5 font-medium">{r.batchNumber ?? '—'}</td>
                        <td className="px-2 py-1.5">{r.vendorCode ? `${r.vendorCode} · ${r.vendorName}` : '—'}</td>
                        <td className="px-2 py-1.5">{r.processName}</td>
                        <td className="px-2 py-1.5">{r.color || '—'}</td>
                        <td className="px-2 py-1.5 text-right font-semibold tabular-nums">{r.qty}</td>
                        <td className="px-2 py-1.5 text-center">{r.cycle}</td>
                        <td className="px-2 py-1.5 italic text-muted-foreground" title={r.reason ?? ''}>
                          {r.reason
                            ? (r.reason.length > 40 ? r.reason.slice(0, 40) + '…' : r.reason)
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-2 text-[11px] text-warning">
              No extra charge — vendor fixes their own defects. Open the{' '}
              <Link href="/repairs" className="underline">Repair Orders</Link>{' '}
              page to receive back or final-reject.
            </p>
          </div>
        )}

        {/* Section 4 — Short-Closed lots. Shows BOTH the pcs we kept
            (received before close) AND the short qty (pcs vendor owes
            that got frozen as outstanding on the ledger). Total qty
            ordered = received + short. */}
        {shortRows.length > 0 && (() => {
          const receivedTotal = shortRows.reduce((s, r) => s + r.qty, 0);
          const shortTotal = shortRows.reduce((s, r) => s + (r.shortQty ?? 0), 0);
          return (
            <div>
              <SectionHeader
                title="⛔ Short-Closed — batch closure summary"
                subtitle={
                  shortTotal > 0
                    ? `${receivedTotal} pcs were received and kept; another ${shortTotal} pcs were owed by the vendor and frozen as an outstanding balance on the Vendor Ledger.`
                    : `${receivedTotal} pcs were received and kept before batch was closed.`
                }
                tone="red"
                total={receivedTotal + shortTotal}
              />
              <div className="mt-2 table-scroll rounded-lg border border-border bg-card">
                <table className="w-full min-w-[680px] text-sm">
                  <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="whitespace-nowrap px-3 py-2 font-semibold">Process</th>
                      <th className="whitespace-nowrap px-3 py-2 font-semibold">Colour</th>
                      <th className="whitespace-nowrap px-3 py-2 font-semibold">Vendor</th>
                      <th className="whitespace-nowrap px-3 py-2 font-semibold">Batch</th>
                      <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">Received</th>
                      <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">Short (owed)</th>
                      <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">Total ordered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shortRows.map((r: any, i: number) => {
                      const short = r.shortQty ?? 0;
                      const ordered = r.qty + short;
                      return (
                        <tr key={i} className="border-t border-border align-top">
                          <td className="px-3 py-2 whitespace-nowrap">{r.processName ?? '—'}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            {r.color ? <Badge variant="outline">{r.color}</Badge> : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap text-foreground">
                            {r.vendorCode ? <><strong>{r.vendorCode}</strong> · {r.vendorName}</> : '—'}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            <div className="max-w-[10rem] whitespace-normal break-words">{(r.batches ?? []).join(', ') || '—'}</div>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-semibold text-success">{r.qty.toLocaleString()}</td>
                          <td className={`px-3 py-2 text-right tabular-nums font-semibold ${short > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                            {short > 0 ? short.toLocaleString() : '—'}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-bold text-foreground">{ordered.toLocaleString()}</td>
                        </tr>
                      );
                    })}
                    <tr className="border-t-2 border-border bg-muted/40 font-bold">
                      <td className="px-3 py-2" colSpan={4}>Totals</td>
                      <td className="px-3 py-2 text-right tabular-nums text-success">{receivedTotal.toLocaleString()}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${shortTotal > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>
                        {shortTotal > 0 ? shortTotal.toLocaleString() : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-foreground">{(receivedTotal + shortTotal).toLocaleString()}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          );
        })()}
      </div>
    </Dialog>
  );
}

function SectionHeader({
  title, subtitle, tone, total,
}: { title: string; subtitle?: string; tone: 'emerald' | 'amber' | 'sky' | 'red'; total: number }) {
  const map = {
    emerald: 'bg-success/10 text-success border-success/30',
    amber:   'bg-warning/10 text-warning border-warning/30',
    sky:     'bg-info/10 text-sky-900 border-info/30',
    red:     'bg-destructive/10 text-red-900 border-destructive/30',
  } as const;
  return (
    <div className={cn('flex items-center justify-between gap-3 rounded-lg border px-3 py-2', map[tone])}>
      <div>
        <div className="text-sm font-semibold">{title}</div>
        {subtitle && <div className="text-xs opacity-80">{subtitle}</div>}
      </div>
      <Badge variant="outline" className="bg-white text-base font-bold">{total.toLocaleString()} pcs</Badge>
    </div>
  );
}

function StatementSection({
  title, tone, total, rows, cols, renderRow,
}: {
  title: string;
  tone: 'emerald' | 'amber' | 'sky' | 'red';
  total: number;
  rows: any[];
  cols: string[];
  renderRow: (r: any) => React.ReactNode[];
}) {
  return (
    <div>
      <SectionHeader title={title} tone={tone} total={total} />
      <div className="mt-2 table-scroll rounded-lg border border-border bg-card">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>{cols.map((c, i) => <th key={i} className={cn('px-3 py-2 font-semibold whitespace-nowrap', i === cols.length - 1 && 'text-right')}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const cells = renderRow(r);
              return (
                <tr key={i} className="border-t border-border">
                  {cells.map((c, j) => (
                    <td key={j} className={cn('px-3 py-2 align-top', j === cells.length - 1 && 'text-right text-lg font-bold tabular-nums text-foreground whitespace-nowrap')}>
                      {c}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProcessSubgroup({ processName, rows, mode }: { processName: string; rows: any[]; mode: 'inHouse' | 'atVendor' }) {
  const total = rows.reduce((s, r) => s + r.qty, 0);
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-sm">
        <span className="font-semibold">{processName}</span>
        <span className="text-xs text-muted-foreground">{rows.length} lot(s) · <strong className="text-foreground">{total.toLocaleString()} pcs</strong></span>
      </div>
      {/* Mobile: stack each lot as a card. Hidden on lg+ where the
          full table renders. */}
      <div className="space-y-2 p-2 lg:hidden">
        {rows.map((r, i) => (
          <div key={`m-${i}`} className="rounded border border-border/60 bg-background/60 p-2 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-semibold text-foreground">
                  {r.vendorCode ? `${r.vendorCode} · ${r.vendorName}` : <span className="text-muted-foreground">—</span>}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  {r.color ? <Badge variant="outline" className="text-[10px]">{r.color}</Badge> : null}
                  {(r.batches ?? []).length > 0 && <span>Batches: {(r.batches ?? []).join(', ')}</span>}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">qty</div>
                <div className="text-lg font-bold tabular-nums text-foreground">{r.qty.toLocaleString()}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="hidden table-scroll lg:block">
      <table className="w-full min-w-[520px] text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-1.5 font-medium">Colour</th>
            <th className="px-3 py-1.5 font-medium">{mode === 'atVendor' ? 'Vendor (currently holding)' : 'Vendor (last touched)'}</th>
            <th className="px-3 py-1.5 font-medium">Batch</th>
            <th className="px-3 py-1.5 text-right font-medium">Qty</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border/60">
              <td className="px-3 py-1.5">
                {r.color ? <Badge variant="outline">{r.color}</Badge> : <span className="text-muted-foreground">—</span>}
              </td>
              <td className="px-3 py-1.5 text-foreground whitespace-nowrap">
                {r.vendorCode ? <><strong>{r.vendorCode}</strong> · {r.vendorName}</> : '—'}
              </td>
              <td className="px-3 py-1.5 text-muted-foreground">{(r.batches ?? []).join(', ') || '—'}</td>
              <td className="px-3 py-1.5 text-right text-base font-bold tabular-nums text-foreground">{r.qty.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
