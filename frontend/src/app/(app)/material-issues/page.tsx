'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Receipt, Truck, AlertTriangle, FileDown, ChevronDown, ChevronRight, Undo2 } from 'lucide-react';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Field, SectionTitle } from '@/components/shared/field';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatDate } from '@/lib/utils';
import type { Vendor, MaterialVariant } from '@/lib/types';

/**
 * Raw Material Issue & Return — voucher-based tracking of materials going to a
 * sticking karigar (or any vendor) and coming back. Mirrors the workflow:
 *   1. We issue 1000 stones (voucher created, stock -1000).
 *   2. They use 720, return 280 leftover (receipt qty 280, stock +280).
 *   3. If they short us — return less than expected — close shows the shortQty.
 */
export default function MaterialIssuesPage() {
  const qc = useQueryClient();
  const [openCreate, setOpenCreate] = React.useState(false);
  const [createKey, setCreateKey] = React.useState(0); // remount fresh per open
  const [viewId, setViewId] = React.useState<number | null>(null);

  // Refetch on focus + every 30s — receipts in the casting flow change "Used"
  // and "Pending" here, and the user shouldn't have to manually reload to see it.
  const issuesQ = useQuery({
    queryKey: ['material-issues'], queryFn: () => Api.materialIssues.list(),
    refetchOnWindowFocus: true, refetchInterval: 30_000,
  });
  const holdingsQ = useQuery({
    queryKey: ['vendor-holdings'], queryFn: () => Api.materialIssues.vendorHoldings(),
    refetchOnWindowFocus: true, refetchInterval: 30_000,
  });

  const issues = issuesQ.data ?? [];
  const holdings = holdingsQ.data ?? [];

  // Group holdings by vendor for display.
  const holdingsByVendor = React.useMemo(() => {
    const m = new Map<number, { vendorCode: string; vendorName: string; items: any[] }>();
    for (const h of holdings as any[]) {
      const v = m.get(h.vendorId) ?? { vendorCode: h.vendorCode, vendorName: h.vendorName, items: [] as any[] };
      v.items.push(h);
      m.set(h.vendorId, v);
    }
    return Array.from(m.entries()).map(([vendorId, v]) => ({ vendorId, ...v }));
  }, [holdings]);

  const openNew = () => { setCreateKey((k) => k + 1); setOpenCreate(true); };
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['material-issues'] });
    qc.invalidateQueries({ queryKey: ['vendor-holdings'] });
    qc.invalidateQueries({ queryKey: ['variants'] });
  };

  return (
    <div>
      <PageHeader
        title="Material Issues"
        subtitle="Raw materials given to vendors (sticking karigars etc.) — track what's out, what came back, and any shorts."
        actions={<Button onClick={openNew}><Plus className="size-4" /> Issue to Vendor</Button>}
      />

      {/* Vendor Holdings — collapsible per vendor. Click a vendor row to expand
          a table of materials they're holding. Same pattern as Production
          Inventory cards: collapsed by default, click to open the details. */}
      <VendorHoldingsCard vendors={holdingsByVendor} />

      {/* Slips folder — alternative view of the same voucher data, grouped
          by vendor. Each vendor folder is collapsible and shows running
          totals (issued · returned · used · short = what they still owe).
          Useful for monthly reconciliation: "what did Krishna take, what
          did they return, what's still owed?". The flat list view stays
          below for users who think in voucher-order rather than per-vendor. */}
      <SlipsFolder issues={issues} onOpenVoucher={(id) => setViewId(id)} />

      {/* Issue voucher list */}
      <Card>
        <CardContent className="p-0">
          <div className="flex items-center gap-2 border-b border-border px-5 py-3 font-semibold">
            <Receipt className="size-4 text-primary" /> All Vouchers (flat list)
          </div>
          {issuesQ.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground"><Spinner /> Loading…</div>
          ) : issues.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground">No material issues yet. Click "Issue to Vendor" to create the first one.</p>
          ) : (
            <div className="table-scroll">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-muted/40 text-left text-text-muted">
                  <tr>
                    <th className="px-4 py-2">Voucher</th>
                    <th className="px-4 py-2">Date</th>
                    <th className="px-4 py-2">Vendor</th>
                    <th className="px-4 py-2">Linked Batch</th>
                    <th className="px-4 py-2">Lines</th>
                    <th className="px-4 py-2 text-right">Issued</th>
                    <th className="px-4 py-2 text-right">Received</th>
                    <th className="px-4 py-2 text-right">Short</th>
                    <th className="px-4 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.map((r: any) => (
                    <tr key={r.id} className="cursor-pointer border-t border-border hover:bg-muted/40" onClick={() => setViewId(r.id)}>
                      <td className="px-4 py-2 font-semibold text-primary">{r.voucherNumber}</td>
                      <td className="px-4 py-2 text-muted-foreground">{formatDate(r.issueDate)}</td>
                      <td className="px-4 py-2">{r.vendorCode} · {r.vendorName}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{r.batchNumber || '—'}</td>
                      <td className="px-4 py-2">{r.lineCount}</td>
                      <td className="px-4 py-2 text-right font-medium">{r.totalIssued}</td>
                      <td className="px-4 py-2 text-right font-medium text-success">{r.totalReceived}</td>
                      <td className="px-4 py-2 text-right font-medium text-warning">{r.totalShort || '—'}</td>
                      <td className="px-4 py-2"><StatusPill status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {openCreate && (
        <IssueDialog
          key={createKey}
          open={openCreate}
          onClose={() => setOpenCreate(false)}
          onDone={() => { setOpenCreate(false); refresh(); }}
        />
      )}
      {viewId != null && (
        <IssueDetailDialog
          id={viewId}
          open={viewId != null}
          onClose={() => setViewId(null)}
          onChange={refresh}
        />
      )}
    </div>
  );
}

/**
 * Slips folder — vendor-grouped view of every issue voucher in the system.
 * Each vendor folder is collapsible and shows running totals so monthly
 * reconciliation is one expand-and-read instead of a SQL query.
 *
 * Per-vendor totals show:
 *   • Issued     — total raw materials we gave
 *   • Returned   — what they physically gave back
 *   • Used       — what they consumed in production (written off)
 *   • Short/Owed — issued − returned − used (still at vendor or lost)
 *
 * Each voucher row inside the folder is clickable to drill into the lines
 * (same dialog as the flat-list view, so nothing's reimplemented).
 */
function SlipsFolder({ issues, onOpenVoucher }: {
  issues: any[];
  onOpenVoucher: (id: number) => void;
}) {
  // Top-level expand/collapse of the WHOLE card. Defaults to closed so the
  // page lands without a long list of vendor folders; user clicks the
  // header (with running totals) to open. Vendor-folder state (openVendors)
  // is nested inside.
  const [cardOpen, setCardOpen] = React.useState(false);
  const [openVendors, setOpenVendors] = React.useState<Record<number, boolean>>({});
  const [search, setSearch] = React.useState('');

  // Group issues by vendor + compute totals per vendor.
  const byVendor = React.useMemo(() => {
    const m = new Map<number, {
      vendorId: number;
      vendorCode: string;
      vendorName: string;
      vouchers: any[];
      totals: { issued: number; received: number; consumed: number; owed: number };
    }>();
    for (const v of issues) {
      const cur = m.get(v.vendorId) ?? {
        vendorId: v.vendorId,
        vendorCode: v.vendorCode,
        vendorName: v.vendorName,
        vouchers: [] as any[],
        totals: { issued: 0, received: 0, consumed: 0, owed: 0 },
      };
      cur.vouchers.push(v);
      cur.totals.issued += Number(v.totalIssued || 0);
      cur.totals.received += Number(v.totalReceived || 0);
      cur.totals.consumed += Number(v.totalConsumed || 0);
      m.set(v.vendorId, cur);
    }
    for (const r of m.values()) {
      r.totals.owed = Math.max(0, r.totals.issued - r.totals.received - r.totals.consumed);
      r.vouchers.sort((a, b) => new Date(b.issueDate).getTime() - new Date(a.issueDate).getTime());
    }
    return Array.from(m.values()).sort((a, b) => a.vendorName.localeCompare(b.vendorName));
  }, [issues]);

  // Filter by vendor name / code / voucher #.
  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return byVendor;
    return byVendor
      .map((v) => ({
        ...v,
        vouchers: v.vouchers.filter((x) =>
          x.voucherNumber?.toLowerCase().includes(q) ||
          v.vendorCode?.toLowerCase().includes(q) ||
          v.vendorName?.toLowerCase().includes(q),
        ),
      }))
      .filter((v) => v.vouchers.length > 0);
  }, [byVendor, search]);

  const gTot = byVendor.reduce(
    (s, v) => ({
      issued: s.issued + v.totals.issued,
      received: s.received + v.totals.received,
      consumed: s.consumed + v.totals.consumed,
      owed: s.owed + v.totals.owed,
    }),
    { issued: 0, received: 0, consumed: 0, owed: 0 },
  );

  return (
    <Card className="mb-4 border-warning/30">
      <CardContent className="p-0">
        <button
          type="button"
          onClick={() => setCardOpen((o) => !o)}
          className="flex w-full flex-wrap items-center gap-2 border-b border-warning/30 bg-warning/10 px-5 py-3 text-left hover:bg-warning/15/60"
        >
          {cardOpen ? <ChevronDown className="size-4 text-warning" /> : <ChevronRight className="size-4 text-warning" />}
          <Receipt className="size-5 text-warning" />
          <span className="font-semibold text-warning">Slips folder — vouchers grouped by vendor</span>
          <span className="ml-auto flex flex-wrap items-center gap-3 text-xs text-warning">
            <span>Issued: <strong>{gTot.issued}</strong></span>
            <span>· Returned: <strong className="text-success">{gTot.received}</strong></span>
            <span>· Used: <strong>{gTot.consumed}</strong></span>
            <span>· Owed/Short: <strong className="text-destructive">{gTot.owed}</strong></span>
          </span>
        </button>
        {!cardOpen ? null : (
        <>
        <div className="border-b border-warning/30 bg-warning/15 px-5 py-2">
          <Input placeholder="Search vendor or voucher #…" value={search}
            onChange={(e) => setSearch(e.target.value)} className="h-8 max-w-xs" />
        </div>
        {filtered.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            {issues.length === 0
              ? 'No vouchers yet. Use "Issue to Vendor" above to create the first one.'
              : 'No vouchers match the search.'}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((v) => {
              const isOpen = !!openVendors[v.vendorId];
              return (
                <div key={v.vendorId}>
                  <button type="button"
                    onClick={() => setOpenVendors((m) => ({ ...m, [v.vendorId]: !m[v.vendorId] }))}
                    className="flex w-full flex-wrap items-center gap-3 px-5 py-3 text-left hover:bg-warning/15"
                  >
                    {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                    <span className="font-semibold text-foreground">{v.vendorCode} · {v.vendorName}</span>
                    <span className="text-xs text-muted-foreground">{v.vouchers.length} voucher{v.vouchers.length === 1 ? '' : 's'}</span>
                    <span className="ml-auto flex flex-wrap items-center gap-3 text-xs">
                      <span>Issued: <strong>{v.totals.issued}</strong></span>
                      <span>· Ret: <strong className="text-success">{v.totals.received}</strong></span>
                      <span>· Used: <strong>{v.totals.consumed}</strong></span>
                      <span>· Owed: <strong className={v.totals.owed > 0 ? 'text-destructive' : 'text-muted-foreground'}>{v.totals.owed}</strong></span>
                    </span>
                  </button>
                  {isOpen && (
                    <div className="bg-warning/10/20 px-5 pb-3 pt-1">
                      <table className="w-full min-w-[680px] text-sm">
                        <thead className="text-left text-xs text-text-muted">
                          <tr>
                            <th className="px-2 py-1.5">Voucher</th>
                            <th className="px-2 py-1.5">Date</th>
                            <th className="px-2 py-1.5">Batch</th>
                            <th className="px-2 py-1.5 text-right">Issued</th>
                            <th className="px-2 py-1.5 text-right">Returned</th>
                            <th className="px-2 py-1.5 text-right">Used</th>
                            <th className="px-2 py-1.5 text-right">Owed/Short</th>
                            <th className="px-2 py-1.5">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {v.vouchers.map((x: any) => {
                            const owed = Math.max(0, Number(x.totalIssued || 0) - Number(x.totalReceived || 0) - Number(x.totalConsumed || 0));
                            return (
                              <tr key={x.id} className="cursor-pointer border-t border-amber-100 hover:bg-warning/15/40"
                                onClick={() => onOpenVoucher(x.id)}>
                                <td className="px-2 py-1.5 font-semibold text-primary">{x.voucherNumber}</td>
                                <td className="px-2 py-1.5 text-muted-foreground">{formatDate(x.issueDate)}</td>
                                <td className="px-2 py-1.5 text-xs text-muted-foreground">{x.batchNumber || '—'}</td>
                                <td className="px-2 py-1.5 text-right">{x.totalIssued}</td>
                                <td className="px-2 py-1.5 text-right text-success">{x.totalReceived || 0}</td>
                                <td className="px-2 py-1.5 text-right">{x.totalConsumed || 0}</td>
                                <td className={`px-2 py-1.5 text-right font-medium ${owed > 0 ? 'text-destructive' : 'text-muted-foreground'}`}>{owed > 0 ? owed : '—'}</td>
                                <td className="px-2 py-1.5"><StatusPill status={x.status} /></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        </>
        )}
      </CardContent>
    </Card>
  );
}

/** Vendor holdings — one row per vendor, click to expand a tidy table of
 *  what they hold + a "Return Materials" action that records returns across
 *  every open voucher in one shot (FIFO by issue date). */
function VendorHoldingsCard({ vendors }: { vendors: { vendorId: number; vendorCode: string; vendorName: string; items: any[] }[] }) {
  // Top-level expand/collapse of the WHOLE card. Defaults to closed so the
  // page lands without a wall of vendor rows; user clicks the header to
  // reveal. Vendor-row expand state (`open`) is nested inside.
  const [cardOpen, setCardOpen] = React.useState(false);
  const [open, setOpen] = React.useState<Record<number, boolean>>({});
  const [returnFor, setReturnFor] = React.useState<{ vendorId: number; vendorCode: string; vendorName: string; items: any[] } | null>(null);
  const toggle = (id: number) => setOpen((m) => ({ ...m, [id]: !m[id] }));
  const grandTotal = vendors.reduce((s, v) => s + v.items.reduce((ss, h: any) => ss + h.qty, 0), 0);

  return (
    <Card className="mb-4 border-info/30">
      <CardContent className="p-0">
        <button
          type="button"
          onClick={() => setCardOpen((o) => !o)}
          className="flex w-full flex-wrap items-center gap-2 border-b border-info/30 bg-info/10 px-5 py-3 text-left hover:bg-info/15/60"
        >
          {cardOpen ? <ChevronDown className="size-4 text-info" /> : <ChevronRight className="size-4 text-info" />}
          <Truck className="size-5 text-info" />
          <span className="font-semibold text-sky-900">Vendor holdings — raw materials currently with vendors</span>
          <span className="ml-auto text-sm font-medium text-info">
            {grandTotal} pcs across {vendors.length} vendor{vendors.length === 1 ? '' : 's'}
          </span>
        </button>
        {!cardOpen ? null : vendors.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            No raw materials currently with any vendor — everything has been returned or consumed.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {vendors.map((v) => {
              const isOpen = !!open[v.vendorId];
              const totalQty = v.items.reduce((s, h: any) => s + h.qty, 0);
              return (
                <div key={v.vendorId}>
                  <div className="flex w-full items-center justify-between gap-3 px-5 py-3 hover:bg-muted/40">
                    <button type="button" onClick={() => toggle(v.vendorId)}
                      className="flex flex-1 items-center gap-3 text-left">
                      {isOpen ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
                      <div>
                        <div className="text-sm font-semibold">{v.vendorCode} · {v.vendorName}</div>
                        <div className="text-xs text-muted-foreground">
                          {v.items.length} material{v.items.length === 1 ? '' : 's'} · {totalQty} pcs total
                        </div>
                      </div>
                    </button>
                    <Badge variant="info" className="font-semibold">{totalQty} pcs</Badge>
                    <Button size="sm" variant="outline"
                      onClick={(e) => { e.stopPropagation(); setReturnFor(v); }}>
                      <Undo2 className="size-3.5" /> Return Materials
                    </Button>
                  </div>
                  {isOpen && (
                    <div className="table-scroll border-t border-border bg-muted/20 px-5 py-2">
                      <table className="w-full min-w-[520px] text-sm">
                        <thead className="text-left text-xs text-muted-foreground">
                          <tr>
                            <th className="px-2 py-1.5">Material</th>
                            <th className="px-2 py-1.5">Code</th>
                            <th className="px-2 py-1.5 text-right">Qty held</th>
                            <th className="px-2 py-1.5">Vouchers</th>
                          </tr>
                        </thead>
                        <tbody>
                          {v.items.map((h: any) => (
                            <tr key={h.variantId} className="border-t border-border/50">
                              <td className="px-2 py-1.5">
                                <div className="font-medium text-foreground">{h.variantName}</div>
                                {h.unit && <div className="text-xs text-muted-foreground">{h.unit}</div>}
                              </td>
                              <td className="px-2 py-1.5 text-xs font-semibold tracking-tight text-muted-foreground">{h.variantCode}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-info">{h.qty}</td>
                              <td className="px-2 py-1.5 text-xs text-muted-foreground">{(h.vouchers ?? []).join(', ') || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
      {returnFor && (
        <VendorReturnDialog
          vendor={returnFor}
          open={!!returnFor}
          onClose={() => setReturnFor(null)}
        />
      )}
    </Card>
  );
}

/** Record a return across all materials a vendor is holding (across vouchers).
 *  Per row the user types Return Qty; the live "After return" column shows what
 *  remains with the vendor, with a "Nullified" pill once a material hits zero. */
function VendorReturnDialog({
  vendor, open, onClose,
}: {
  vendor: { vendorId: number; vendorCode: string; vendorName: string; items: any[] };
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  // variantId -> return qty (string for free typing).
  const [qty, setQty] = React.useState<Record<number, string>>({});

  React.useEffect(() => { if (open) setQty({}); }, [open, vendor.vendorId]);

  const setReturnQty = (variantId: number, qtyStr: string) =>
    setQty((m) => ({ ...m, [variantId]: qtyStr.replace(/[^0-9]/g, '') }));

  const submitting = React.useRef(false);
  const mutate = useMutation({
    mutationFn: () => {
      const items = vendor.items
        .map((h: any) => ({ variantId: h.variantId, returnedQty: Math.max(0, Math.trunc(Number(qty[h.variantId] || 0))) }))
        .filter((x) => x.returnedQty > 0);
      if (!items.length) throw new Error('Enter a return qty for at least one material.');
      // Defensive over-cap guard (server also enforces).
      for (const i of items) {
        const held = vendor.items.find((h: any) => h.variantId === i.variantId)?.qty ?? 0;
        if (i.returnedQty > held) throw new Error(`Cannot return ${i.returnedQty} — vendor only holds ${held}.`);
      }
      return Api.materialIssues.vendorReturn({ vendorId: vendor.vendorId, items });
    },
    onSuccess: (res) => {
      const total = (res.items ?? []).reduce((s, x) => s + x.returned, 0);
      toast.success(`Recorded ${total} pcs returned from ${vendor.vendorCode} — stock restored.`);
      qc.invalidateQueries({ queryKey: ['material-issues'] });
      qc.invalidateQueries({ queryKey: ['vendor-holdings'] });
      qc.invalidateQueries({ queryKey: ['stock'] });
      qc.invalidateQueries({ queryKey: ['stock-movements'] });
      qc.invalidateQueries({ queryKey: ['variants'] });
      submitting.current = false;
      onClose();
    },
    onError: (e) => {
      submitting.current = false;
      toast.error(e instanceof Error && !(e as any).response ? e.message : getApiError(e).message);
    },
  });
  const submit = () => {
    if (submitting.current || mutate.isPending) return;
    submitting.current = true;
    mutate.mutate();
  };

  const totalReturning = vendor.items.reduce((s, h: any) =>
    s + Math.max(0, Math.trunc(Number(qty[h.variantId] || 0))), 0);

  // Live search across material name / code / unit — vendors with 20+ materials
  // are common and scrolling sucks. Empty search = show everything.
  const [search, setSearch] = React.useState('');
  const visibleItems = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return vendor.items;
    return vendor.items.filter((h: any) =>
      [h.variantName, h.variantCode, h.unit].some((x: any) => (x ?? '').toString().toLowerCase().includes(q)),
    );
  }, [vendor.items, search]);

  // Toggle scope: when a search is active, "Return everything" only fills the
  // VISIBLE rows (matches what's on screen). Without that, typing "stone"
  // and hitting the toggle would clear/fill rows you can't even see.
  const allFilled = visibleItems.length > 0 && visibleItems.every((h: any) =>
    Math.max(0, Math.trunc(Number(qty[h.variantId] || 0))) === h.qty,
  );
  const toggleReturnAll = () => {
    if (allFilled) {
      setQty((m) => {
        const next = { ...m };
        for (const h of visibleItems) delete next[h.variantId];
        return next;
      });
      return;
    }
    setQty((m) => {
      const next = { ...m };
      for (const h of visibleItems) next[h.variantId] = String(h.qty);
      return next;
    });
  };

  return (
    <Dialog open={open} onClose={onClose} size="lg"
      title={`Return Materials — ${vendor.vendorCode} · ${vendor.vendorName}`}
      description="Distributes returns across this vendor's open vouchers (FIFO by issue date)."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={mutate.isPending}>Cancel</Button>
          <Button onClick={submit} disabled={mutate.isPending || totalReturning === 0}>
            {mutate.isPending && <Spinner />} {mutate.isPending ? 'Recording…' : `Record Return (${totalReturning} pcs)`}
          </Button>
        </>
      }>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Button type="button" size="sm"
            variant={allFilled ? 'default' : 'outline'}
            onClick={toggleReturnAll}>
            {allFilled ? 'Undo — clear all' : 'Return everything'}
          </Button>
          <div className="relative ml-auto min-w-[220px] flex-1">
            <Input
              placeholder="Search material name or code…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8"
            />
            <span className="absolute left-2.5 top-1.5 text-muted-foreground">🔍</span>
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground">Tip: enter only what the vendor is physically handing back. Anything left stays "currently with vendor".</p>
        <div className="table-scroll rounded-lg border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Material</th>
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2 text-right">Currently held</th>
                <th className="px-3 py-2 text-right">Return Now</th>
                <th className="px-3 py-2 text-right">After return</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No materials match "{search}".
                </td></tr>
              ) : visibleItems.map((h: any) => {
                const held = h.qty;
                const ret = Math.max(0, Math.trunc(Number(qty[h.variantId] || 0)));
                const remaining = Math.max(0, held - ret);
                const over = ret > held;
                const nullified = ret > 0 && remaining === 0;
                return (
                  <tr key={h.variantId} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      <div className="font-medium text-foreground">{h.variantName}</div>
                      {h.unit && <div className="text-[10px] text-muted-foreground">{h.unit}</div>}
                    </td>
                    <td className="px-3 py-2 text-xs font-semibold tracking-tight text-muted-foreground">{h.variantCode}</td>
                    <td className="px-3 py-2 text-right font-semibold text-info tabular-nums">{held}</td>
                    <td className="px-3 py-2 text-right">
                      <Input type="number" min={0} max={held} step="1"
                        className={`h-8 w-24 text-right ${over ? 'border-red-300 bg-destructive/10' : ''}`}
                        value={qty[h.variantId] ?? ''}
                        onChange={(e) => setReturnQty(h.variantId, e.target.value)}
                        placeholder="0"
                      />
                      {over && <div className="text-[10px] text-destructive">exceeds held</div>}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {ret === 0 ? (
                        <span className="text-muted-foreground tabular-nums">{held}</span>
                      ) : nullified ? (
                        <Badge variant="success">Nullified ✓</Badge>
                      ) : (
                        <span className="font-medium text-warning tabular-nums">{remaining} still held</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Returns are applied FIFO across open vouchers. Stock is restored on save and each affected voucher's status recomputes (OPEN / PARTIAL / COMPLETED).
        </p>
      </div>
    </Dialog>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls: Record<string, string> = {
    OPEN: 'bg-warning/15 text-warning',
    PARTIAL: 'bg-info/15 text-info',
    COMPLETED: 'bg-success/15 text-success',
    CLOSED: 'bg-secondary/60 text-text-muted',
  };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls[status] ?? 'bg-secondary/50 text-text-muted'}`}>{status}</span>;
}

/** Create a new material-issue voucher (manual flow). */
function IssueDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [vendorId, setVendorId] = React.useState<number | ''>('');
  const [lines, setLines] = React.useState<{ variantId: number | ''; issuedQty: string; notes: string }[]>([
    { variantId: '', issuedQty: '', notes: '' },
  ]);
  const [notes, setNotes] = React.useState('');

  // Raw materials are issued to STICKING vendors — restrict the dropdown to them.
  const processesQ = useQuery({ queryKey: ['processes'], queryFn: () => Api.processes() });
  const stickingId = (processesQ.data ?? []).find((p: any) => p.code === 'STICKING')?.id;
  const vendorsQ = useQuery<Vendor[]>({
    queryKey: ['sticking-vendors', stickingId],
    queryFn: () => Api.vendors.list({ status: 'ACTIVE', processId: stickingId }),
    enabled: !!stickingId,
  });
  const variantsQ = useQuery<MaterialVariant[]>({ queryKey: ['variants'], queryFn: () => Api.materials.variants({ status: 'ACTIVE' }) });

  const variantOf = (id: any) => (variantsQ.data ?? []).find((v) => v.id === Number(id));

  const setLine = (i: number, patch: any) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { variantId: '', issuedQty: '', notes: '' }]);
  const removeLine = (i: number) => setLines((ls) => ls.filter((_, k) => k !== i));

  // "Order more" — record an IN stock movement so the issue can proceed without the shortage warning.
  const qc = useQueryClient();
  const orderMore = useMutation({
    mutationFn: (args: { variantId: number; qty: number; name: string }) =>
      Api.materials.adjustStock(args.variantId, { type: 'IN', quantity: args.qty, note: `Ordered for issue voucher (${args.name})` }),
    onSuccess: (_, args) => {
      toast.success(`Stock +${args.qty} recorded for ${args.name}.`);
      qc.invalidateQueries({ queryKey: ['variants'] });
      qc.invalidateQueries({ queryKey: ['stock'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const create = useMutation({
    mutationFn: () => {
      if (!vendorId) throw new Error('Choose a vendor.');
      const valid = lines.filter((l) => l.variantId && Number(l.issuedQty) > 0);
      if (!valid.length) throw new Error('Add at least one material with a quantity.');
      for (const l of valid) {
        const q = Number(l.issuedQty);
        if (!Number.isInteger(q)) throw new Error('Quantities must be whole numbers.');
      }
      return Api.materialIssues.create({
        vendorId: Number(vendorId), notes: notes || undefined,
        lines: valid.map((l) => ({ variantId: Number(l.variantId), issuedQty: Number(l.issuedQty), notes: l.notes || undefined })),
      });
    },
    onSuccess: (r: any) => { toast.success(`Voucher ${r.voucherNumber} created.`); onDone(); },
    onError: (e) => toast.error(e instanceof Error && !(e as any).response ? e.message : getApiError(e).message),
  });

  // Stock-shortage warning per line.
  const shortLines = lines
    .map((l, i) => ({ i, line: l, variant: variantOf(l.variantId) }))
    .filter((x) => x.variant && Number(x.line.issuedQty || 0) > Math.trunc(Number(x.variant.stockQty)))
    .map((x) => ({ ...x, stock: Math.trunc(Number(x.variant!.stockQty)) }));

  return (
    <Dialog open={open} onClose={onClose} size="xl"
      title="Issue Raw Materials to Vendor"
      description="Stock is deducted immediately on save. Record returns from the voucher detail."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending && <Spinner />} Create Voucher
          </Button>
        </>
      }>
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Vendor" required>
            <SearchableSelect
              value={vendorId}
              placeholder="— Select vendor —"
              onChange={(v) => setVendorId(v ? Number(v) : '')}
              options={(vendorsQ.data ?? []).map((v) => ({ value: v.id, label: `${v.vendorCode} · ${v.vendorName}`, keywords: v.vendorName }))}
            />
          </Field>
          <Field label="Notes (optional)"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. For order #6633 Rajwadi" /></Field>
        </div>

        <div>
          <SectionTitle>Materials to Issue</SectionTitle>
          <div className="space-y-2">
            {lines.map((l, i) => {
              const variant = variantOf(l.variantId);
              const stock = variant ? Math.trunc(Number(variant.stockQty)) : 0;
              const qty = Number(l.issuedQty || 0);
              const short = variant && qty > stock;
              return (
                <div key={i} className="rounded-lg border border-border bg-muted/30 p-3">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                    <div className="sm:col-span-5">
                      <Field label="Material">
                        <SearchableSelect
                          value={l.variantId}
                          placeholder="— Select material —"
                          onChange={(val) => setLine(i, { variantId: val ? Number(val) : '' })}
                          options={(variantsQ.data ?? []).map((v) => {
                            const st = Math.trunc(Number(v.stockQty));
                            const specs = [v.size, v.color].filter(Boolean).join(' · ');
                            return {
                              value: v.id,
                              label: v.variantName,
                              subtitle: `${v.variantCode}${specs ? ` · ${specs}` : ''}`,
                              meta: `stock ${st}`,
                              keywords: `${v.variantCode} ${v.materialName ?? ''}`,
                            };
                          })}
                        />
                      </Field>
                    </div>
                    <div className="sm:col-span-2">
                      <Field label="Issued Qty" hint="whole number">
                        <Input type="number" step="1" min="0" value={l.issuedQty}
                          onChange={(e) => setLine(i, { issuedQty: e.target.value.replace(/[^0-9]/g, '') })} />
                      </Field>
                    </div>
                    <div className="sm:col-span-2">
                      <Field label="In Stock">
                        <div className={`flex h-9 items-center rounded-md border px-2.5 text-sm ${short ? 'border-red-300 bg-destructive/10 text-destructive' : 'border-border bg-card text-muted-foreground'}`}>
                          {variant ? `${stock}${variant.unit ? ' ' + variant.unit : ''}` : '—'}
                        </div>
                      </Field>
                    </div>
                    <div className="sm:col-span-2">
                      <Field label="Notes"><Input value={l.notes} onChange={(e) => setLine(i, { notes: e.target.value })} /></Field>
                    </div>
                    <div className="flex items-end sm:col-span-1">
                      <Button type="button" variant="outline" size="icon" className="mb-0.5 text-destructive hover:bg-destructive/10" onClick={() => removeLine(i)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                  {short && (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/30 bg-destructive/10/60 px-2.5 py-1.5 text-xs text-destructive">
                      <span className="flex items-center gap-2">
                        <AlertTriangle className="size-3.5" />
                        Need <strong>{qty}</strong> but only <strong>{stock}</strong> in stock —
                        short by <strong>{qty - stock}</strong>.
                      </span>
                      <Button type="button" size="sm" variant="outline"
                        className="h-7 border-red-300 bg-white text-destructive hover:bg-destructive/15"
                        disabled={orderMore.isPending}
                        onClick={() => {
                          if (window.confirm(`Order ${qty - stock} more of ${variant!.variantName}? This adds them to stock now (record the purchase).`)) {
                            orderMore.mutate({ variantId: variant!.id, qty: qty - stock, name: variant!.variantName });
                          }
                        }}>
                        <Plus className="size-3" /> Order {qty - stock} more
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={addLine}>
            <Plus className="size-4" /> Add Material
          </Button>
        </div>

        {shortLines.length > 0 && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <strong>Stock shortage:</strong> {shortLines.length} line{shortLines.length === 1 ? '' : 's'} exceed available stock. Use the <em>Order more</em> button on each row to record the purchase before issuing, or reduce the qty.
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** View a voucher's lines + record return + close. */
function IssueDetailDialog({ id, open, onClose, onChange }: { id: number; open: boolean; onClose: () => void; onChange: () => void }) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['material-issue', id], queryFn: () => Api.materialIssues.get(id), enabled: open,
    // Auto-refresh while the dialog is open so "Used" reflects the latest
    // sticking receipts without the user closing + reopening the voucher.
    refetchOnWindowFocus: true, refetchInterval: open ? 20_000 : false,
  });
  const [ret, setRet] = React.useState<Record<number, string>>({}); // lineId -> qty

  React.useEffect(() => { setRet({}); }, [id]);

  const setRetLine = (lineId: number, qty: string) =>
    setRet((m) => ({ ...m, [lineId]: qty.replace(/[^0-9]/g, '') }));

  const recordReturn = useMutation({
    mutationFn: () => {
      const lines = Object.entries(ret)
        .filter(([, q]) => Number(q) > 0)
        .map(([lineId, q]) => ({ lineId: Number(lineId), returnedQty: Number(q) }));
      if (!lines.length) throw new Error('Enter a return qty for at least one line.');
      return Api.materialIssues.recordReturn(id, { lines });
    },
    onSuccess: () => { toast.success('Return recorded — stock restored.'); refetch(); onChange(); setRet({}); },
    onError: (e) => toast.error(e instanceof Error && !(e as any).response ? e.message : getApiError(e).message),
  });

  const close = useMutation({
    mutationFn: () => {
      const reason = window.prompt('Close this voucher? Anything still pending is recorded as short.\n\nReason (optional):', '');
      if (reason === null) throw new Error('Cancelled.');
      return Api.materialIssues.close(id, { reason: reason || undefined });
    },
    onSuccess: () => { toast.success('Voucher closed.'); refetch(); onChange(); },
    onError: (e) => toast.error(e instanceof Error && !(e as any).response ? e.message : getApiError(e).message),
  });

  if (!data && isLoading) {
    return <Dialog open={open} onClose={onClose} size="md" title="Loading…"><div className="flex justify-center py-10"><Spinner /></div></Dialog>;
  }
  if (!data) return null;

  const totalPending = data.lines.reduce((s: number, l: any) => s + l.pendingQty, 0);

  return (
    <Dialog open={open} onClose={onClose} size="lg"
      title={`Voucher ${data.voucherNumber}`}
      description={`${data.vendor.vendorCode} · ${data.vendor.vendorName} · ${formatDate(data.issueDate)}${data.batchNumber ? ` · linked to batch ${data.batchNumber}` : ''}`}
      footer={
        <>
          <a href={Api.materialIssues.issuePdfUrl(data.id)} target="_blank" rel="noreferrer">
            <Button variant="outline" type="button"><FileDown className="size-4" /> Issue Slip</Button>
          </a>
          <a href={Api.materialIssues.returnPdfUrl(data.id)} target="_blank" rel="noreferrer">
            <Button variant="outline" type="button"><FileDown className="size-4" /> Status / Return Slip</Button>
          </a>
          <Button variant="outline" onClick={onClose}>Close</Button>
          {data.status !== 'CLOSED' && totalPending > 0 && (
            <Button onClick={() => recordReturn.mutate()} disabled={recordReturn.isPending}>
              {recordReturn.isPending && <Spinner />} Record Return
            </Button>
          )}
          {data.status !== 'CLOSED' && (
            <Button variant="outline" onClick={() => close.mutate()} disabled={close.isPending} className="text-warning hover:bg-warning/10">
              {close.isPending && <Spinner />} Close Short
            </Button>
          )}
        </>
      }>
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm">
          <StatusPill status={data.status} />
          <span className="text-muted-foreground">·</span>
          <span>{data.lines.length} material line(s)</span>
          {totalPending > 0 && <><span className="text-muted-foreground">·</span><span className="text-warning">{totalPending} pcs still pending return</span></>}
        </div>

        {data.usage && (
          <div className="rounded-md border border-info/30 bg-info/10 p-3 text-sm text-sky-900">
            <div className="font-semibold">Used for production:</div>
            <div className="mt-1">
              Batch <strong>{data.usage.batchNumber}</strong> · {data.usage.processName}
              {' · '}Design <strong>#{data.usage.itemNumber ?? '—'}</strong> ({data.usage.designCode})
              {data.usage.color && <> · Colour <strong>{data.usage.color}</strong></>}
              {' · '}<strong>{data.usage.stageQty}</strong> pcs being produced
              {' · '}<strong>{data.usage.stickingReceived ?? 0}</strong> pcs received back so far
            </div>
            <div className="mt-1 text-xs text-info">
              "Used" only counts BOM consumption for sticking pieces actually returned. The rest of the issued qty is sitting with the vendor.
            </div>
          </div>
        )}

        <div className="table-scroll">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-muted/40 text-left text-text-muted">
              <tr>
                <th className="px-3 py-2">Material</th>
                <th className="px-3 py-2 text-right">Issued</th>
                <th className="px-3 py-2 text-right" title="Materials consumed = BOM-per-piece × sticking pcs received back. Until pieces come back, this is 0.">Used</th>
                <th className="px-3 py-2 text-right">Returned</th>
                <th className="px-3 py-2 text-right">Pending</th>
                {data.status !== 'CLOSED' && <th className="px-3 py-2 text-right">Return Now</th>}
                <th className="px-3 py-2 text-right">Short</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l: any) => (
                <tr key={l.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <div className="font-medium">{l.variantName}</div>
                    <div className="text-xs text-muted-foreground">{l.variantCode}</div>
                  </td>
                  <td className="px-3 py-2 text-right font-medium">{l.issuedQty}</td>
                  <td className="px-3 py-2 text-right text-info">{l.usedQty}</td>
                  <td className="px-3 py-2 text-right text-success">{l.receivedQty}</td>
                  <td className="px-3 py-2 text-right text-warning">{l.pendingQty}</td>
                  {data.status !== 'CLOSED' && (
                    <td className="px-3 py-2 text-right">
                      <Input
                        type="number" min="0" step="1" className="h-8 w-24 text-right"
                        value={ret[l.id] ?? ''}
                        onChange={(e) => setRetLine(l.id, e.target.value)}
                        placeholder="0"
                        disabled={l.pendingQty === 0 && l.receivedQty + (l.usedQty ?? 0) >= l.issuedQty}
                      />
                    </td>
                  )}
                  <td className="px-3 py-2 text-right text-destructive">{l.shortQty ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {data.notes && (
          <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
            <div className="text-xs font-semibold uppercase text-muted-foreground">Notes</div>
            <p>{data.notes}</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
