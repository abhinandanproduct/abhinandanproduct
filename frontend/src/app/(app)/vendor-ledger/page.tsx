'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Wallet, ArrowUpRight, ArrowDownLeft, AlertTriangle, Clock, ChevronLeft, ChevronRight, FileDown, Scale, Droplet, Coins } from 'lucide-react';
import { Api } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { formatCurrency, formatDate } from '@/lib/utils';

const monthStart = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);
const wt = (g: number) => (g ? `${g.toFixed(3)} g` : '—');

// Shared column set for Issued / Received / Pending.
const UNIFIED_HEADERS = ['Date', 'Batch', 'Process', 'Item #', 'Vendor Ref', 'Qty', 'Total Wt', 'Recd', 'Pending', 'Amount'];

// Human labels for the VendorMetalLedger.eventType enum. Anything not in
// the map falls through to the raw enum value.
const METAL_EVENT_LABEL: Record<string, string> = {
  ALLOCATE_ADVANCE:  'Allocated',
  RETURN_TO_ADVANCE: 'Returned',
  DRAW_INTO_BATCH:   'Drawn to batch',
  ADJUST:            'Adjustment',
};

/** Pending cell: red when short (still owed), green "+n" when excess, grey when closed. */
function pendingCell(ordered: number, recd: number, closed: boolean, override?: number) {
  if (closed) return <span className="text-text-faint">closed</span>;
  const diff = override !== undefined ? override : ordered - recd;
  if (diff > 0) return <span className="font-medium text-destructive">{diff}</span>;
  if (diff < 0) return <span className="font-medium text-success">+{-diff}</span>;
  return <span className="text-muted-foreground">0</span>;
}

export default function VendorLedgerPage() {
  const [vendorId, setVendorId] = React.useState<number | ''>('');
  const [from, setFrom] = React.useState(monthStart());
  const [to, setTo] = React.useState(today());

  const vendorsQ = useQuery({ queryKey: ['vendors-all'], queryFn: () => Api.vendors.list() });
  const ledgerQ = useQuery({
    queryKey: ['vendor-ledger', vendorId, from, to],
    queryFn: () => Api.casting.vendorLedger(Number(vendorId), from, to),
    enabled: !!vendorId,
  });
  const d = ledgerQ.data;

  return (
    <div>
      <PageHeader
        title="Vendor Ledger"
        subtitle="Complete board for the selected vendor — work bills, metal advance, per-receipt loss + runners + drift. Every section is scoped to the date range; widen it to see older activity."
      />

      <Card className="mb-4">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-end">
          <div className="min-w-0 flex-1 sm:min-w-[240px]">
            <label className="mb-1 block text-sm font-medium text-foreground/80">Vendor</label>
            <SearchableSelect
              value={vendorId}
              placeholder="— Select vendor —"
              onChange={(v) => setVendorId(v ? Number(v) : '')}
              options={(vendorsQ.data ?? []).map((v: any) => ({ value: v.id, label: `${v.vendorCode} · ${v.vendorName}`, keywords: v.vendorName }))}
            />
          </div>
          <div className="w-full sm:w-auto">
            <label className="mb-1 block text-sm font-medium text-foreground/80">From</label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="w-full sm:w-auto">
            <label className="mb-1 block text-sm font-medium text-foreground/80">To</label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            disabled={!vendorId}
            onClick={() => {
              if (!vendorId) return;
              window.open(Api.casting.vendorLedgerReportPdfUrl(Number(vendorId), from, to), '_blank');
            }}
            title={vendorId ? 'Download sectioned PDF report for this period' : 'Pick a vendor first'}
          >
            <FileDown className="size-4" /> Download Report
          </Button>
        </CardContent>
      </Card>

      {!vendorId ? (
        <Card><CardContent className="p-4"><EmptyState icon={Wallet} title="Select a vendor" description="Pick a vendor to see their transactions and balances for the period." /></CardContent></Card>
      ) : ledgerQ.isLoading || !d ? (
        <div className="flex justify-center py-16"><Spinner className="size-6 text-primary" /></div>
      ) : (
        <div className="space-y-4">
          {/* Vendor identity chip — flags in-house so the operator knows
              why some fields (billable amount) might read as zero. */}
          {d.vendor && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">{d.vendor.vendorName}</span>
              <span className="text-text-faint">·</span>
              <span className="font-mono">{d.vendor.vendorCode}</span>
              {d.vendor.isInhouse && (
                <Badge variant="info">In-house</Badge>
              )}
            </div>
          )}

          {/* Work-bill summary */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard icon={ArrowUpRight} color="bg-primary/10 text-primary" label="Issued"
              lines={[`${d.summary.issued.qty} pcs`, wt(d.summary.issued.weight), formatCurrency(d.summary.issued.amount)]} />
            <SummaryCard icon={ArrowDownLeft} color="bg-success/15 text-success" label="Received"
              lines={[`${d.summary.received.qty} pcs`, wt(d.summary.received.weight)]} />
            <SummaryCard icon={Clock} color="bg-warning/15 text-warning" label="Under Process (with vendor)"
              lines={[`${d.summary.underProcess?.qty ?? 0} pcs`, wt(d.summary.underProcess?.weight ?? 0)]} />
            <SummaryCard icon={AlertTriangle} color="bg-destructive/15 text-destructive" label="Outstanding (short-closed)"
              lines={[`${d.summary.outstanding.qty} pcs`, wt(d.summary.outstanding.weight), formatCurrency(d.summary.outstanding.amount)]} />
            <SummaryCard icon={AlertTriangle} color="bg-destructive/15 text-destructive" label="Rejected (QC fails)"
              lines={[
                `${d.summary.rejected?.qty ?? 0} pcs`,
                `Deduct ${formatCurrency(d.summary.rejected?.deduction ?? 0)}`,
              ]} />
            <SummaryCard icon={Clock} color="bg-warning/15 text-warning" label="In Repair (with vendor)"
              lines={[
                `${d.summary.inRepair?.qty ?? 0} pcs`,
                `${d.summary.inRepair?.count ?? 0} order(s)`,
              ]} />
          </div>

          {/* METAL BOARD — advance balance, in/out flow, loss + runners
              + drift. Works for in-house vendors identically to outsourced. */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryCard icon={Coins} color="bg-gold/15 text-gold" label="Metal Advance (current)"
              lines={[
                wt(d.summary.metalAdvance?.currentBalance ?? 0),
                'sitting with vendor now',
              ]} />
            <SummaryCard icon={ArrowUpRight} color="bg-primary/10 text-primary" label="Allocated (this period)"
              lines={[
                wt(d.summary.metalAdvance?.allocated ?? 0),
                `Drawn to batches ${wt(d.summary.metalAdvance?.drawn ?? 0)}`,
                `Returned ${wt(d.summary.metalAdvance?.returned ?? 0)}`,
              ]} />
            <SummaryCard icon={Droplet} color="bg-destructive/15 text-destructive" label="Metal Loss (period)"
              lines={[
                wt(d.summary.metalFlow?.totalLoss ?? 0),
                `across ${d.summary.metalFlow?.receiptCount ?? 0} receipt(s)`,
                `Runners recovered ${wt(d.summary.metalFlow?.totalRunners ?? 0)}`,
              ]} />
            <SummaryCard icon={Scale} color="bg-warning/15 text-warning" label="Drift (claimed − actual)"
              lines={[
                (d.summary.metalFlow?.totalDrift ?? 0) === 0
                  ? '— no drift on record'
                  : `${(d.summary.metalFlow.totalDrift > 0 ? '+' : '')}${d.summary.metalFlow.totalDrift.toFixed(3)} g`,
                `Claimed ${wt(d.summary.metalFlow?.totalClaimed ?? 0)}`,
                `Actual  ${wt(d.summary.metalFlow?.totalActual ?? 0)}`,
              ]} />
          </div>

          {/* Sort newest-first so the most recent transactions are on page 1. */}
          {(() => {
            const byDateDesc = (a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime();
            const issuesSorted = [...d.issues].sort(byDateDesc);
            const receiptsSorted = [...d.receipts].sort(byDateDesc);
            const outstandingSorted = [...d.outstanding].sort(byDateDesc);
            return (
              <>
                {/* 1) Issued — colored Pending (red short / green excess) + totals */}
                <LedgerTable title={`Issued (${formatDate(from)} – ${formatDate(to)})`} empty="No issues in this period."
                  headers={UNIFIED_HEADERS}
                  rows={issuesSorted.map((i: any) => [
                    formatDate(i.date), i.batchNumber, i.processName, i.itemNumber, i.vendorDesignReference || '—',
                    i.qty, wt(i.weight), i.receivedQty, pendingCell(i.qty, i.receivedQty, i.closed), formatCurrency(i.amount),
                  ])}
                  totalRow={['Total', '', '', '', '',
                    d.summary.issued.qty, wt(d.summary.issued.weight),
                    d.issues.reduce((s: number, i: any) => s + (i.receivedQty || 0), 0),
                    d.summary.pending.qty, formatCurrency(d.summary.issued.amount),
                  ]} />

                {/* 2) Received — same columns; Recd = qty received in that receipt */}
                <LedgerTable title={`Received (${formatDate(from)} – ${formatDate(to)})`} empty="No receipts in this period."
                  headers={UNIFIED_HEADERS}
                  rows={receiptsSorted.map((r: any) => [
                    formatDate(r.date), r.batchNumber, r.processName, r.itemNumber, r.vendorDesignReference || '—',
                    r.qty, wt(r.weight), r.recd, pendingCell(r.qty, r.recd + 0, false, r.pending), formatCurrency(r.amount),
                  ])}
                  totalRow={['Total', '', '', '', '', '', '', d.summary.received.qty, '', '']} />

                {/* 3) Under Process — what the vendor is physically holding right now (all dates) */}
                <LedgerTable title="Under Process — currently held by this vendor" empty="Vendor is holding nothing right now."
                  headers={['Batch', 'Process', 'Item #', 'Colour', 'Vendor Ref', 'Pending Qty', 'Pending Wt']}
                  rows={(d.underProcess ?? []).map((u: any) => [
                    u.batchNumber, u.processName, u.itemNumber, u.color || '—', u.vendorDesignReference || '—',
                    u.pendingQty, wt(u.pendingWeight),
                  ])}
                  totalRow={(d.underProcess ?? []).length ? ['Total', '', '', '', '', d.summary.underProcess.qty, wt(d.summary.underProcess.weight)] : undefined}
                  pending />

                {/* 4) Short-close — outstanding balances */}
                <LedgerTable title="Short-Closed (outstanding balances)" empty="No outstanding balances."
                  headers={['Closed', 'Batch', 'Process', 'Item #', 'Short Qty', 'Short Wt', 'Amount', 'Reason']}
                  rows={outstandingSorted.map((o: any) => [
                    formatDate(o.date), o.batchNumber, o.processName, o.itemNumber,
                    o.shortQty, wt(o.shortWeight), formatCurrency(o.amount), o.reason || '—',
                  ])}
                  totalRow={d.outstanding.length ? ['Total', '', '', '', d.summary.outstanding.qty, wt(d.summary.outstanding.weight), formatCurrency(d.summary.outstanding.amount), ''] : undefined}
                  highlight />

                {/* 5) Rejections — pcs that failed QC at receive. Each row
                    carries the payment mode the user picked and the
                    computed deduction (NO_PAY = full per-pc cost, ADJUSTED
                    = custom amount, FULL_PAY = 0). */}
                <LedgerTable
                  title={`Rejections — failed QC at receive (${formatDate(from)} – ${formatDate(to)})`}
                  empty="No rejections in this period."
                  headers={['Date', 'Receipt', 'Batch', 'Process', 'Item #', 'Qty', 'Payment Mode', 'Deduction']}
                  rows={[...(d.rejections ?? [])].sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime()).map((r: any) => [
                    formatDate(r.date),
                    r.receiptNumber,
                    r.batchNumber,
                    r.processName,
                    r.itemNumber || '—',
                    r.qty,
                    r.paymentMode === 'NO_PAY' ? 'No Pay'
                      : r.paymentMode === 'ADJUSTED' ? `Adjusted ₹${r.adjustment?.toFixed(2)}`
                      : 'Full Pay',
                    formatCurrency(r.deduction ?? 0),
                  ])}
                  totalRow={(d.rejections ?? []).length ? ['Total', '', '', '', '', d.summary.rejected?.qty ?? 0, '', formatCurrency(d.summary.rejected?.deduction ?? 0)] : undefined}
                />

                {/* 6) Open Repairs — pcs currently with this vendor for repair.
                    Info section only; ledger impact happens only if the user
                    later final-rejects them. */}
                <LedgerTable
                  title="Open Repairs — currently with this vendor for rework"
                  empty="No open repair orders."
                  headers={['Sent', 'REP', 'Cycle', 'Batch', 'Process', 'Item #', 'Qty', 'Reason']}
                  rows={[...(d.openRepairs ?? [])].sort((a: any, b: any) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime()).map((r: any) => [
                    formatDate(r.sentAt),
                    `REP-${r.id}`,
                    r.cycle,
                    r.batchNumber || '—',
                    r.processName,
                    r.itemNumber || '—',
                    r.qty,
                    r.reason || '—',
                  ])}
                  totalRow={(d.openRepairs ?? []).length ? ['Total', '', '', '', '', '', d.summary.inRepair?.qty ?? 0, ''] : undefined}
                />

                {/* 7) Metal Advance — snapshot balance + in-period ledger. */}
                {(d.metalAdvance?.currentBalances?.length ?? 0) > 0 && (
                  <LedgerTable
                    title="Metal Advance — current balances (all-time snapshot)"
                    empty="No metal advance held right now."
                    headers={['Variant', 'Balance']}
                    rows={(d.metalAdvance?.currentBalances ?? []).map((b: any) => [
                      `${b.variantCode} · ${b.variantName}`,
                      wt(b.balanceWeight),
                    ])}
                    totalRow={['Total', wt(d.summary.metalAdvance?.currentBalance ?? 0)]}
                  />
                )}

                <LedgerTable
                  title={`Metal Advance Ledger (${formatDate(from)} – ${formatDate(to)})`}
                  empty="No metal advance activity in this period."
                  headers={['Date', 'Event', 'Variant', 'Weight', 'Balance after', 'Note']}
                  rows={[...(d.metalAdvance?.ledger ?? [])].map((m: any) => [
                    formatDate(m.date),
                    METAL_EVENT_LABEL[m.eventType] ?? m.eventType,
                    m.variantCode,
                    <span key="w" className={m.weight >= 0 ? 'font-medium text-success' : 'font-medium text-destructive'}>
                      {m.weight > 0 ? '+' : ''}{Number(m.weight).toFixed(3)} g
                    </span>,
                    wt(Number(m.balanceAfter)),
                    m.note || '—',
                  ])}
                />

                {/* 8) Metal Flow — per-receipt loss / runners / drift. */}
                <LedgerTable
                  title={`Metal Flow per receipt (${formatDate(from)} – ${formatDate(to)})`}
                  empty="No receipts with recorded loss / runners / drift in this period."
                  headers={['Date', 'Receipt', 'Rows', 'Loss', 'Runners', 'Claimed', 'Actual', 'Drift']}
                  rows={[...(d.metalFlow ?? [])].map((f: any) => [
                    formatDate(f.date),
                    f.receiptNumber,
                    f.rowCount,
                    f.totalLoss > 0
                      ? <span key="l" className="text-destructive">{wt(f.totalLoss)}</span>
                      : f.totalLoss < 0
                        ? <span key="l" className="text-info">{f.totalLoss.toFixed(3)} g (gain)</span>
                        : '—',
                    f.totalRunners > 0
                      ? <span key="r" className="text-success">{wt(f.totalRunners)}</span>
                      : '—',
                    f.claimedTotal > 0 ? wt(f.claimedTotal) : '—',
                    f.actualTotal > 0 ? wt(f.actualTotal) : '—',
                    f.drift === 0
                      ? '—'
                      : <span key="d" className={f.drift > 0 ? 'font-medium text-destructive' : 'font-medium text-info'}>
                          {f.drift > 0 ? '+' : ''}{f.drift.toFixed(3)} g
                        </span>,
                  ])}
                  totalRow={(d.metalFlow ?? []).length ? [
                    'Total', '', d.summary.metalFlow?.receiptCount ?? 0,
                    wt(d.summary.metalFlow?.totalLoss ?? 0),
                    wt(d.summary.metalFlow?.totalRunners ?? 0),
                    wt(d.summary.metalFlow?.totalClaimed ?? 0),
                    wt(d.summary.metalFlow?.totalActual ?? 0),
                    `${(d.summary.metalFlow?.totalDrift ?? 0) > 0 ? '+' : ''}${(d.summary.metalFlow?.totalDrift ?? 0).toFixed(3)} g`,
                  ] : undefined}
                />
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function SummaryCard({ icon: Icon, color, label, lines }: { icon: any; color: string; label: string; lines: string[] }) {
  return (
    <Card className="h-full">
      <CardContent className="flex h-full items-center gap-4 p-5">
        <div className={`flex size-12 shrink-0 items-center justify-center rounded-xl ${color}`}><Icon className="size-6" /></div>
        <div className="min-w-0">
          <div className="text-lg font-bold leading-tight">{lines[0]}</div>
          <div className="text-sm text-muted-foreground">{label}</div>
          {lines.slice(1).map((l, i) => <div key={i} className="text-xs text-muted-foreground">{l}</div>)}
        </div>
      </CardContent>
    </Card>
  );
}

function LedgerTable({ title, headers, rows, empty, highlight, pending, totalRow, pageSize = 5 }: { title: string; headers: string[]; rows: any[][]; empty: string; highlight?: boolean; pending?: boolean; totalRow?: any[]; pageSize?: number }) {
  const rowTint = highlight ? 'bg-destructive/10/40' : pending ? 'bg-warning/15' : '';
  // Pagination — show pageSize (default 5) most-recent rows; user pages
  // through the rest with prev/next. Reset to page 0 when the underlying
  // row set changes (vendor / date filter switched).
  const [page, setPage] = React.useState(0);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  React.useEffect(() => { setPage(0); }, [rows.length, title]);
  const safePage = Math.min(page, totalPages - 1);
  const start = safePage * pageSize;
  const pageRows = rows.slice(start, start + pageSize);
  const showPager = rows.length > pageSize;
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <span className="font-semibold">{title}</span>
          {rows.length > 0 && <Badge variant={pending ? 'warning' : highlight ? 'destructive' : 'secondary'}>{rows.length}</Badge>}
        </div>
        {rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">{empty}</p>
        ) : (
          <>
            <div className="table-scroll">
              <table className="w-full text-sm" style={{ minWidth: 880 }}>
                <thead className="bg-muted/40 text-left text-text-muted">
                  <tr>{headers.map((h) => <th key={h} className="px-4 py-2 font-semibold">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {pageRows.map((r, i) => (
                    <tr key={start + i} className={`border-t border-border ${rowTint}`}>
                      {r.map((c, j) => <td key={j} className="px-4 py-2">{c}</td>)}
                    </tr>
                  ))}
                </tbody>
                {totalRow && (
                  <tfoot>
                    <tr className="border-t-2 border-border bg-muted/60 font-semibold">
                      {totalRow.map((c, j) => <td key={j} className="px-4 py-2">{c}</td>)}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            {showPager && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/30 px-5 py-2 text-xs">
                <span className="text-muted-foreground">
                  Showing <strong className="text-foreground">{start + 1}–{Math.min(start + pageSize, rows.length)}</strong> of <strong className="text-foreground">{rows.length}</strong>
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={safePage === 0}
                    className="inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-1 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ChevronLeft className="size-3.5" /> Prev
                  </button>
                  <span className="px-2 text-muted-foreground">
                    Page <strong className="text-foreground">{safePage + 1}</strong> of <strong className="text-foreground">{totalPages}</strong>
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={safePage >= totalPages - 1}
                    className="inline-flex items-center gap-1 rounded border border-border bg-card px-2 py-1 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Next <ChevronRight className="size-3.5" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
