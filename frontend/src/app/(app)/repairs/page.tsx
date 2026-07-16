'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileDown, Search, AlertTriangle, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { formatDate } from '@/lib/utils';

/**
 * Repair Orders page — Open / Returned / Final-Rejected tabs over the
 * RepairOrder rows. Each row links to:
 *   • the Repair Slip PDF (the paper the karigar gets along with the pcs)
 *   • a "Receive back" deep-link into the Receive Goods form, scoped to
 *     this repair so the resulting receipt closes the order
 *   • a "Reject these N" button (final reject) that ends the cycle
 *
 * Soft warning kicks in at cycle >= 3 — the row is highlighted and the
 * dialog suggests rejecting instead of repairing again.
 */
// Module-level cache — survives client-side nav, resets on hard reload.
let cachedRepairsFilter: { tab: 'OPEN' | 'RETURNED' | 'FINAL_REJECTED'; search: string } = { tab: 'OPEN', search: '' };

export default function RepairsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = React.useState<'OPEN' | 'RETURNED' | 'FINAL_REJECTED'>(() => cachedRepairsFilter.tab);
  const [search, setSearch] = React.useState(() => cachedRepairsFilter.search);
  React.useEffect(() => { cachedRepairsFilter = { tab, search }; }, [tab, search]);
  const [rejectFor, setRejectFor] = React.useState<any | null>(null);

  const repairsQ = useQuery({
    queryKey: ['repairs', tab, search],
    queryFn: () => Api.casting.listRepairs({ status: tab, search: search || undefined }),
  });

  const rows = repairsQ.data ?? [];

  const counts = useQuery({
    queryKey: ['repairs-counts'],
    queryFn: async () => {
      const [open, ret, fin] = await Promise.all([
        Api.casting.listRepairs({ status: 'OPEN' }),
        Api.casting.listRepairs({ status: 'RETURNED' }),
        Api.casting.listRepairs({ status: 'FINAL_REJECTED' }),
      ]);
      return { OPEN: open.length, RETURNED: ret.length, FINAL_REJECTED: fin.length };
    },
  });

  const finalReject = useMutation({
    mutationFn: (args: {
      id: number;
      qty: number;
      reason?: string;
      paymentMode: 'NO_PAY' | 'ADJUSTED' | 'FULL_PAY';
      adjustment?: number;
    }) => Api.casting.finalRejectRepair(args.id, args),
    onSuccess: () => {
      toast.success('Repair final-rejected. Origin receipt updated; vendor ledger picks it up on next read.');
      setRejectFor(null);
      qc.invalidateQueries({ queryKey: ['repairs'] });
      qc.invalidateQueries({ queryKey: ['repairs-counts'] });
      qc.invalidateQueries({ queryKey: ['casting-batches'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const tabs: { key: 'OPEN' | 'RETURNED' | 'FINAL_REJECTED'; label: string; icon: any; tone: string }[] = [
    { key: 'OPEN', label: 'Open', icon: Loader2, tone: 'text-warning' },
    { key: 'RETURNED', label: 'Returned', icon: CheckCircle2, tone: 'text-success' },
    { key: 'FINAL_REJECTED', label: 'Final-Rejected', icon: XCircle, tone: 'text-destructive' },
  ];

  return (
    <div>
      <PageHeader
        title="Repair Orders"
        subtitle="Pcs sent back to vendors for rework — no extra charge. Each row tracks one repair attempt; a cycle ≥ 3 is flagged for review (consider rejecting instead)."
      />

      {/* Tabs */}
      <div className="mb-4 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-card text-foreground hover:bg-muted/40'
            }`}
          >
            <t.icon className={`size-4 ${t.tone}`} />
            {t.label}
            <Badge variant="outline" className="text-[10px]">
              {counts.data?.[t.key] ?? '…'}
            </Badge>
          </button>
        ))}
      </div>

      {/* Search */}
      <Card className="mb-4">
        <CardContent className="p-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by batch / vendor / item # / reason…"
              className="pl-8"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Rows */}
      {repairsQ.isLoading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
          <Spinner /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No {tab.toLowerCase().replace('_', '-')} repair orders.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((r: any) => {
            const showSoftWarn = r.status === 'OPEN' && r.cycle >= 3;
            return (
              <Card
                key={r.id}
                className={showSoftWarn ? 'border-warning/40 bg-warning/15' : undefined}
              >
                <CardContent className="p-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono text-xs font-semibold tracking-wide text-primary">
                        REP-{r.id}
                      </span>
                      <Badge variant="outline" className="text-[10px]">cycle {r.cycle}</Badge>
                      {showSoftWarn && (
                        <Badge variant="destructive" className="text-[10px]" title="Consider rejecting these pcs instead of repairing again">
                          ⚠ cycle ≥ 3 — review
                        </Badge>
                      )}
                      <span className="text-muted-foreground">·</span>
                      <span className="font-semibold tabular-nums">{r.qty} pcs</span>
                      <span className="text-muted-foreground">·</span>
                      <Badge variant="default" className="text-[10px]">{r.processName ?? '—'}</Badge>
                      {r.color && <Badge variant="outline" className="text-[10px]">{r.color}</Badge>}
                      <span className="text-muted-foreground">·</span>
                      <span title={r.vendorCode}>{r.vendorCode} · {r.vendorName}</span>
                      <span className="text-muted-foreground">·</span>
                      <span className="text-muted-foreground">
                        {r.batchNumber ?? '—'}
                        {r.itemNumber && <> · #{r.itemNumber}</>}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <a href={Api.casting.repairPdfUrl(r.id)} target="_blank" rel="noreferrer">
                        <Button variant="outline" size="sm">
                          <FileDown className="size-4" /> Repair slip
                        </Button>
                      </a>
                      {r.status === 'OPEN' && (
                        <>
                          {/* Receive back — opens the batch detail dialog,
                              which has its own in-batch Repair Orders panel
                              and pops the Receive form scoped to this repair
                              automatically (via ?receiveRepair= param). The
                              receive form sits INSIDE the batch dialog so
                              the user never leaves the batch — pcs land
                              back in the same batch on save. */}
                          <a href={`/casting/batches?focusBatch=${r.batchId}&receiveRepair=${r.id}&vendorId=${r.vendorId}`}>
                            <Button variant="outline" size="sm">
                              <CheckCircle2 className="size-4" /> Receive back
                            </Button>
                          </a>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive hover:bg-destructive/10"
                            onClick={() => setRejectFor(r)}
                          >
                            <XCircle className="size-4" /> Reject these {r.qty}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span>Sent: {formatDate(r.sentAt)}</span>
                    {r.returnedAt && <span>Returned: {formatDate(r.returnedAt)}</span>}
                    {r.closedAt && <span>Closed: {formatDate(r.closedAt)}</span>}
                    {r.originReceiptNumber && <span>Origin: {r.originReceiptNumber}</span>}
                    {r.finalRejectedQty > 0 && (
                      <span className="font-semibold text-destructive">Final-rejected: {r.finalRejectedQty}</span>
                    )}
                    {r.reason && <span>Reason: {r.reason}</span>}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Final-reject dialog */}
      <FinalRejectDialog
        repair={rejectFor}
        onClose={() => setRejectFor(null)}
        onConfirm={(payload) => rejectFor && finalReject.mutate({ id: rejectFor.id, ...payload })}
        pending={finalReject.isPending}
      />
    </div>
  );
}

function FinalRejectDialog({
  repair,
  onClose,
  onConfirm,
  pending,
}: {
  repair: any | null;
  onClose: () => void;
  onConfirm: (args: {
    qty: number;
    reason?: string;
    paymentMode: 'NO_PAY' | 'ADJUSTED' | 'FULL_PAY';
    adjustment?: number;
  }) => void;
  pending: boolean;
}) {
  const [qty, setQty] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [mode, setMode] = React.useState<'' | 'NO_PAY' | 'ADJUSTED' | 'FULL_PAY'>('');
  const [adj, setAdj] = React.useState('');

  React.useEffect(() => {
    if (repair) {
      setQty(String(repair.qty));
      setReason(repair.reason ?? '');
      setMode('');
      setAdj('');
    }
  }, [repair]);

  if (!repair) return null;
  const qNum = Math.max(0, Math.trunc(Number(qty || 0)));
  const valid = qNum > 0 && qNum <= repair.qty && !!mode && (mode !== 'ADJUSTED' || Number(adj) >= 0);

  return (
    <Dialog
      open={!!repair}
      onClose={onClose}
      size="md"
      title={<span className="text-destructive">Final-reject REP-{repair.id}</span>}
      description={`Give up on repair. ${repair.qty} pcs were sent; pick how many to reject + the payment decision.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={!valid || pending}
            onClick={() =>
              onConfirm({
                qty: qNum,
                reason: reason || undefined,
                paymentMode: mode as any,
                adjustment: mode === 'ADJUSTED' ? Number(adj || 0) : undefined,
              })
            }
          >
            {pending && <Spinner />} Final-reject {qNum} pcs
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="rounded-md border border-warning/30 bg-warning/15 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mb-0.5 mr-1 inline size-3.5" /> This is the
          last step on the repair cycle. The pcs are written off (or kept) per the
          payment decision below — the repair order is closed FINAL_REJECTED.
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="w-40 text-muted-foreground">Reject qty</span>
          <Input
            type="number"
            min={1}
            max={repair.qty}
            className="h-9 w-24 text-right"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
          <span className="text-xs text-muted-foreground">of {repair.qty} sent</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="w-40 text-muted-foreground">Payment mode</span>
          <Select className="h-9" value={mode} onChange={(e) => setMode(e.target.value as any)}>
            <option value="">— pick one —</option>
            <option value="NO_PAY">No pay (deduct full)</option>
            <option value="ADJUSTED">Adjusted (custom deduct)</option>
            <option value="FULL_PAY">Full pay (our fault)</option>
          </Select>
        </label>
        {mode === 'ADJUSTED' && (
          <label className="flex items-center gap-2 text-sm">
            <span className="w-40 text-muted-foreground">Deduct ₹</span>
            <Input
              type="number"
              min={0}
              step="0.01"
              className="h-9 w-32 text-right"
              value={adj}
              onChange={(e) => setAdj(e.target.value)}
            />
          </label>
        )}
        <label className="flex items-start gap-2 text-sm">
          <span className="w-40 pt-2 text-muted-foreground">Reason</span>
          <textarea
            className="min-h-[60px] flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            placeholder="e.g. multiple repair attempts, still off-spec"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      </div>
    </Dialog>
  );
}
