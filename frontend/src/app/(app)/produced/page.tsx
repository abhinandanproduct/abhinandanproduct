'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, PackageCheck, Factory, Truck, ChevronDown, ChevronRight } from 'lucide-react';
import { Api } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { cn, formatDate } from '@/lib/utils';

/**
 * Inventory — ONE CARD PER DESIGN. At a glance:
 *   - Big total at the header (how many of this design exist anywhere).
 *   - Three coloured stat tiles: Finished / In-House / At Vendor.
 *   - Lots grouped by BATCH, each row one line you can read in plain English:
 *       "10 pcs · Ruby · with V0008 · Sticky (Sticking)".
 */
// Module-level cache — survives client-side nav, resets on hard reload.
let cachedProducedFilter = { search: '' };

export default function InventoryPage() {
  const [search, setSearch] = React.useState(() => cachedProducedFilter.search);
  React.useEffect(() => { cachedProducedFilter = { search }; }, [search]);
  // History dialog state — opens when user clicks "History" on any lot.
  // Carries the lot itself so the dialog header can show context (qty,
  // design #, colour) while the body fetches the lineage from the backend.
  const [historyLot, setHistoryLot] = React.useState<any>(null);
  const { data, isLoading } = useQuery({ queryKey: ['produced'], queryFn: () => Api.casting.produced() });

  const allRows = data?.rows ?? [];
  const byDesign = data?.byDesign ?? [];
  const q = search.trim().toLowerCase();

  const designMatches = (d: any) =>
    !q || [d.designCode, d.itemName, String(d.itemNumber ?? '')].some((x: any) => (x ?? '').toString().toLowerCase().includes(q));
  const lotMatches = (r: any) =>
    !q || [r.processName, r.vendorName, r.color, ...(r.batches || [])].some((x: any) => (x ?? '').toString().toLowerCase().includes(q));

  // Group lots by design + by batch within each design.
  const lotsByDesignAndBatch = React.useMemo(() => {
    const m = new Map<number, Map<string, any[]>>(); // itemId → batchNumber → lots[]
    for (const r of allRows) {
      const batchKey = (r.batches || ['—']).join(', ');
      const designMap = m.get(r.itemId) ?? new Map<string, any[]>();
      const arr = designMap.get(batchKey) ?? [];
      arr.push(r);
      designMap.set(batchKey, arr);
      m.set(r.itemId, designMap);
    }
    return m;
  }, [allRows]);

  // Apply search at both levels — keep a design if either it or any of its lots matches.
  const visibleDesigns = byDesign.filter((d: any) => {
    if (designMatches(d)) return true;
    const lots = lotsByDesignAndBatch.get(d.itemId);
    if (!lots) return false;
    for (const arr of lots.values()) if (arr.some(lotMatches)) return true;
    return false;
  });

  const grandFinished = byDesign.reduce((s: number, d: any) => s + d.finishedQty, 0);
  const grandInHouse  = byDesign.reduce((s: number, d: any) => s + d.inHouseQty, 0);
  const grandAtVendor = byDesign.reduce((s: number, d: any) => s + d.atVendorQty, 0);

  return (
    <div>
      <PageHeader
        title="Production Tracking"
        subtitle="Every piece of every design — where it is right now, in plain English."
      />

      {/* Search + grand totals */}
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="relative min-w-[260px] flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search design / item no. / batch / vendor / colour…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <StatPill icon={PackageCheck} colour="emerald" label="Finished" value={grandFinished} />
          <StatPill icon={Factory} colour="amber" label="In-House" value={grandInHouse} />
          <StatPill icon={Truck} colour="sky" label="At Vendor" value={grandAtVendor} />
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground"><Spinner /> Loading…</div>
      ) : visibleDesigns.length === 0 ? (
        <Card><CardContent className="px-5 py-10 text-center text-muted-foreground">No produced stock anywhere.</CardContent></Card>
      ) : (
        <div className="space-y-4">
          {visibleDesigns.map((d: any) => {
            // If the design itself matches the search (e.g. typed "#1501"),
            // the user wants the FULL breakdown — don't filter individual
            // lots by the same query (no lot row contains "1501", so every
            // row would render as null and the card would look empty).
            // Only narrow lots when the search matched on lot attributes
            // (vendor / colour / process / batch) instead.
            const designAlreadyMatched = designMatches(d);
            return (
              <DesignCard
                key={d.itemId}
                design={d}
                lotsByBatch={lotsByDesignAndBatch.get(d.itemId) ?? new Map()}
                search={designAlreadyMatched ? '' : q}
                onShowHistory={(lot) => setHistoryLot({ ...lot, designItemNumber: d.itemNumber, designCode: d.designCode, itemName: d.itemName })}
              />
            );
          })}
        </div>
      )}
      <LineageDialog lot={historyLot} open={!!historyLot} onClose={() => setHistoryLot(null)} />
    </div>
  );
}

function StatPill({ icon: Icon, colour, label, value }: { icon: any; colour: 'emerald'|'amber'|'sky'; label: string; value: number }) {
  const cls: Record<string,string> = {
    emerald: 'bg-success/10 text-success border-success/30',
    amber:   'bg-warning/10 text-warning border-warning/30',
    sky:     'bg-info/10 text-info border-info/30',
  };
  return (
    <div className={cn('flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium', cls[colour])}>
      <Icon className="size-4" />
      <span>{label}</span>
      <span className="font-bold">{value}</span>
      <span className="text-xs opacity-70">pcs</span>
    </div>
  );
}

/** One card = one design, everything about it in one place. */
function DesignCard({ design, lotsByBatch, search, onShowHistory }: { design: any; lotsByBatch: Map<string, any[]>; search: string; onShowHistory: (lot: any) => void }) {
  const [open, setOpen] = React.useState(false);
  const batches = Array.from(lotsByBatch.entries()).sort(); // sort batches by name

  return (
    <Card>
      <CardContent className="p-0">
        {/* Header */}
        <button type="button" onClick={() => setOpen(!open)}
          className="flex w-full flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-5 py-3 text-left hover:bg-muted/50">
          <div className="flex items-center gap-3">
            {open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
            <div>
              <div className="text-base font-semibold">
                #{design.itemNumber ?? '—'} · {design.designCode}
                {design.itemName && <span className="ml-2 text-sm font-normal text-muted-foreground">— {design.itemName}</span>}
              </div>
              <div className="text-xs text-muted-foreground">{batches.length} batch{batches.length === 1 ? '' : 'es'} contributing</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {design.finishedQty > 0 && <Badge variant="success" className="font-semibold">✓ {design.finishedQty} packed</Badge>}
            {design.inHouseQty > 0 && <Badge variant="warning" className="font-semibold">🏭 {design.inHouseQty} in-house</Badge>}
            {design.atVendorQty > 0 && <Badge variant="info" className="font-semibold">🚚 {design.atVendorQty} at vendor</Badge>}
            <Badge variant="outline" className="text-base font-bold">Total {design.totalQty}</Badge>
          </div>
        </button>

        {open && (
          <div className="divide-y divide-border">
            {batches.map(([batchKey, lots]) => (
              <BatchBlock key={batchKey} batch={batchKey} lots={lots} search={search} onShowHistory={onShowHistory} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Inside a design card: one row per batch, listing every lot in plain English. */
function BatchBlock({ batch, lots, search, onShowHistory }: { batch: string; lots: any[]; search: string; onShowHistory: (lot: any) => void }) {
  const finished = lots.filter((l) => l.state === 'FINISHED');
  const inHouse  = lots.filter((l) => l.state === 'IN_HOUSE');
  const atVendor = lots.filter((l) => l.state === 'AT_VENDOR');
  const sum = (arr: any[]) => arr.reduce((s, l) => s + l.qty, 0);

  return (
    <div className="px-5 py-3">
      <div className="mb-2 flex items-center gap-2 text-sm">
        <span className="font-semibold text-foreground">Batch {batch}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{sum(lots)} pcs across {lots.length} lot(s)</span>
      </div>
      <div className="space-y-1">
        {finished.map((l, i) => <LotLine key={`f${i}`} lot={l} search={search} onShowHistory={onShowHistory} />)}
        {inHouse.map((l, i) => <LotLine key={`h${i}`} lot={l} search={search} onShowHistory={onShowHistory} />)}
        {atVendor.map((l, i) => <LotLine key={`v${i}`} lot={l} search={search} onShowHistory={onShowHistory} />)}
      </div>
    </div>
  );
}

/** One plain-English row: "12 pcs · Ruby · Sticking · with V0008 Sticky Solutions". */
function LotLine({ lot, search, onShowHistory }: { lot: any; search: string; onShowHistory: (lot: any) => void }) {
  const q = search.trim().toLowerCase();
  const hidden = q && ![lot.processName, lot.vendorName, lot.color, ...(lot.batches || [])]
    .some((x: any) => (x ?? '').toString().toLowerCase().includes(q));
  if (hidden && q) return null;

  // When the parent batch is short-closed, override the active-process labels —
  // these pieces aren't "ready for X", they're frozen in their last-touched state.
  const baseCls = {
    FINISHED: { bar: 'bg-success/100', label: 'Packed & ready', tone: 'text-success' },
    IN_HOUSE: { bar: 'bg-warning/100',   label: `In stock · ready for ${lot.nextProcessName || 'next step'}`, tone: 'text-warning' },
    AT_VENDOR:{ bar: 'bg-info/100',     label: 'Currently with vendor', tone: 'text-info' },
  }[lot.state as 'FINISHED'|'IN_HOUSE'|'AT_VENDOR'];

  const closedCls = {
    FINISHED: { bar: 'bg-secondary/300', label: 'Packed (from short-closed batch)', tone: 'text-text-muted' },
    IN_HOUSE: { bar: 'bg-secondary/300', label: 'Frozen at this step · batch short-closed', tone: 'text-text-muted' },
    AT_VENDOR:{ bar: 'bg-secondary/300', label: 'With vendor · batch short-closed', tone: 'text-text-muted' },
  }[lot.state as 'FINISHED'|'IN_HOUSE'|'AT_VENDOR'];
  const cls = lot.batchClosed ? closedCls : baseCls;

  // Action links per lot — surface "reopen" and "forward" actions inline so
  // the user doesn't have to hunt for the batch in Production Management.
  // Closed-batch lots get a reopen link (Batch Inventory has the toggle);
  // in-house lots get a forward link (deep-links into the active batch).
  const batchLink = lot.batches && lot.batches[0]
    ? `/casting/batches?focus=${encodeURIComponent(lot.batches[0])}`
    : '/casting/batches';
  return (
    <div className={cn('flex flex-wrap items-center gap-3 rounded-md border bg-card px-3 py-2 text-sm', lot.batchClosed ? 'border-slate-300 bg-secondary/40' : 'border-border')}>
      <span className={cn('inline-block size-1.5 shrink-0 rounded-full', cls.bar)} />
      <span className={cn('text-lg font-bold', lot.batchClosed ? 'text-text-muted' : 'text-foreground')}>{lot.qty}</span>
      <span className="text-xs text-muted-foreground">pcs</span>
      <span className="text-muted-foreground">·</span>
      <Badge variant="default">{lot.processName}</Badge>
      {lot.color && <Badge variant="outline">{lot.color}</Badge>}
      {lot.batchClosed && <Badge variant="destructive" className="text-[10px]">SHORT-CLOSED</Badge>}
      <span className="text-muted-foreground">·</span>
      {lot.state === 'FINISHED' ? (
        <>
          <span className={cn('text-sm font-medium', cls.tone)}>{cls.label}</span>
          {lot.productionCostPerPc != null && lot.productionCostPerPc > 0 && (
            <>
              <span className="text-muted-foreground">·</span>
              <span
                className="inline-flex items-center gap-1 rounded bg-success/10 px-1.5 py-0.5 text-xs font-medium text-success ring-1 ring-success/30"
                title={[
                  `Total run cost: Rs. ${lot.productionCost?.toLocaleString('en-IN', { minimumFractionDigits: 2 }) ?? '—'}`,
                  '',
                  ...Object.entries(lot.productionCostByProcess ?? {}).map(
                    ([proc, amt]) => `${proc}: Rs. ${(amt as number).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
                  ),
                ].join('\n')}
              >
                💰 Rs. {lot.productionCostPerPc.toLocaleString('en-IN', { minimumFractionDigits: 2 })}/pc
              </span>
            </>
          )}
        </>
      ) : (
        <>
          <span className={cn('text-sm font-medium', cls.tone)}>{cls.label}</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-sm">
            {lot.state === 'AT_VENDOR' ? 'with ' : 'last sent to '}
            <strong>{lot.vendorCode}</strong> {lot.vendorName}
          </span>
        </>
      )}
      {/* Action links — deep-link to the right page based on lot state.
          History button is ALWAYS present so the user can trace any lot's
          provenance (batch → process → vendor chain) regardless of state. */}
      <span className="ml-auto flex items-center gap-2">
        <button type="button"
          onClick={() => onShowHistory(lot)}
          className="text-xs font-medium text-primary hover:underline"
          title="Trace where this lot came from — full batch / process / vendor history"
        >
          📜 History
        </button>
        {lot.batchClosed ? (
          <a href="/batch-inventory" className="text-xs font-medium text-primary hover:underline">
            Reopen batch →
          </a>
        ) : lot.state === 'IN_HOUSE' && lot.nextProcessName ? (
          <a href={batchLink} className="text-xs font-medium text-primary hover:underline">
            Forward to {lot.nextProcessName} →
          </a>
        ) : lot.state === 'AT_VENDOR' ? (
          <a href="/casting/receipt" className="text-xs font-medium text-primary hover:underline">
            Receive →
          </a>
        ) : null}
      </span>
    </div>
  );
}

/**
 * Lineage / history dialog — opens when user clicks "📜 History" on any
 * lot. Walks UP the parentItemId chain from the lot's first stage all
 * the way back to its origin Casting stage and renders the result as a
 * timeline: each row is one step in the design's production journey,
 * showing batch / process / vendor / colour / qty / receipts /
 * short / close. Cross-batch absorbs (excess routing, settle-on-create)
 * are flagged so the user sees where pieces "jumped" between batches.
 */
function LineageDialog({ lot, open, onClose }: { lot: any; open: boolean; onClose: () => void }) {
  // Use the first stage in this lot as the anchor for the lineage walk —
  // every stage in a single lot shares the same parent chain by definition.
  const stageId = lot?.stages?.[0]?.id ?? null;
  const { data, isLoading } = useQuery({
    queryKey: ['stage-lineage', stageId],
    queryFn: () => Api.casting.stageLineage(stageId!),
    enabled: open && stageId != null,
  });
  if (!lot) return null;
  const chain = (data?.chain ?? []) as any[];

  const headerLine = `${lot.qty} pcs · ${lot.processName}${lot.color ? ` · ${lot.color}` : ''} · ${lot.designItemNumber ? `#${lot.designItemNumber} · ` : ''}${lot.designCode ?? ''}`;

  return (
    <Dialog open={open} onClose={onClose} size="lg"
      title="📜 Lot history"
      description={headerLine}
      footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground"><Spinner /> Loading lineage…</div>
      ) : chain.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          No history found for this lot.
        </div>
      ) : (
        <div className="relative space-y-3">
          {/* Vertical timeline track */}
          <div className="absolute bottom-2 left-[14px] top-2 w-0.5 bg-border" />
          {chain.map((step: any, idx: number) => (
            <LineageStep key={step.id} step={step} isFirst={idx === 0} isLast={idx === chain.length - 1} />
          ))}
          {/* Where these pieces are NOW — small recap. */}
          <div className="ml-8 mt-4 rounded-lg border border-success/30 bg-success/15 px-3 py-2 text-xs">
            <span className="font-semibold text-success">📍 Where they are now:</span>{' '}
            <span className="text-success">
              {lot.batchClosed
                ? `Frozen from short-closed batch ${(lot.batches ?? []).join(', ')}`
                : lot.state === 'FINISHED'
                  ? `Packed & ready (${lot.vendorCode} ${lot.vendorName})`
                  : lot.state === 'IN_HOUSE'
                    ? `In our stock — ready for ${lot.nextProcessName ?? 'next step'}`
                    : `Still with ${lot.vendorCode} ${lot.vendorName} for ${lot.processName}`}
            </span>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** One step in the lineage timeline. Rendered with a coloured node on the
 *  left, then the batch/process/vendor/qty/receipt details. */
function LineageStep({ step, isFirst, isLast }: { step: any; isFirst: boolean; isLast: boolean }) {
  const tone = step.closed ? 'bg-destructive/100'
    : step.processCode === 'PACKING' ? 'bg-success/100'
    : step.receivedQty > 0 ? 'bg-warning/100'
    : 'bg-info/100';
  return (
    <div className="relative pl-8">
      {/* Timeline node */}
      <div className={cn('absolute left-2 top-2 size-3.5 rounded-full ring-2 ring-card', tone)} />
      <div className={cn(
        'rounded-lg border bg-card px-3 py-2',
        step.closed ? 'border-destructive/30 bg-destructive/10/40' : 'border-border',
      )}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-2">
            <Badge variant="default" className="font-semibold">{step.processName}</Badge>
            {step.color && <Badge variant="outline">{step.color}</Badge>}
            {step.colorModel && (
              <span className="rounded bg-info/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-info ring-1 ring-purple-200">
                {step.colorModel}
              </span>
            )}
            {isFirst && <Badge variant="secondary" className="text-[10px]">📦 Origin</Badge>}
            {isLast && !isFirst && <Badge variant="info" className="text-[10px]">⮕ This lot</Badge>}
            {step.crossBatchSettle && (
              <Badge variant="warning" className="text-[10px]" title={`Absorbed from batch ${step.sourceBatchNumber}`}>
                🔀 cross-batch
              </Badge>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            Batch <strong className="text-foreground">{step.batchNumber}</strong> · {formatDate(step.batchDate)}
          </div>
        </div>
        <div className="mt-1 text-sm text-foreground">
          <strong>{step.vendorCode}</strong> · {step.vendorName}
          {step.vendorDesignReference && <span className="text-muted-foreground"> · ref {step.vendorDesignReference}</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span><span className="text-muted-foreground">Issued </span><strong className="tabular-nums">{step.quantity}</strong></span>
          <span className="text-muted-foreground">·</span>
          <span><span className="text-muted-foreground">Received </span><strong className="tabular-nums text-success">{step.receivedQty}</strong></span>
          {step.forwardedQty > 0 && (
            <>
              <span className="text-muted-foreground">·</span>
              <span><span className="text-muted-foreground">Forwarded </span><strong className="tabular-nums text-info">{step.forwardedQty}</strong></span>
            </>
          )}
          {step.shortQty > 0 && (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="font-semibold text-destructive">⛔ Short {step.shortQty}</span>
            </>
          )}
          {step.closed && (
            <Badge variant="destructive" className="text-[10px]">closed{step.closedReason ? `: ${step.closedReason}` : ''}</Badge>
          )}
        </div>
        {step.receipts && step.receipts.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>Receipts:</span>
            {step.receipts.map((r: any) => (
              <span key={r.receiptId} className="rounded bg-info/10 px-1.5 py-0.5 text-info ring-1 ring-info/30">
                {r.receiptNumber ?? `#${r.receiptId}`} · +{r.receivedQty} pcs · {formatDate(r.receiptDate)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
