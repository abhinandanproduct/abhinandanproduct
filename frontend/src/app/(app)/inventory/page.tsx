'use client';

import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ColumnDef } from '@tanstack/react-table';
import { Search, PackagePlus } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable } from '@/components/shared/data-table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { Field } from '@/components/shared/field';
import { formatCurrency, formatDate } from '@/lib/utils';

function AdjustDialog({ variant, open, onClose, onPendingDemand }: { variant: any; open: boolean; onClose: () => void; onPendingDemand?: (demand: any[]) => void }) {
  const qc = useQueryClient();
  const [type, setType] = React.useState('IN');
  const [quantity, setQuantity] = React.useState('');
  const [weight, setWeight] = React.useState('');
  const [note, setNote] = React.useState('');
  // Purchase-slip fields — only used when type=IN. Tags the movement as a
  // proper purchase from a raw-material supplier so the /raw-materials page
  // can show received-slip folders grouped by vendor.
  const [vendorId, setVendorId] = React.useState<number | ''>('');
  const [invoiceNumber, setInvoiceNumber] = React.useState('');
  const [unitPrice, setUnitPrice] = React.useState('');
  const [unitRatePerGram, setUnitRatePerGram] = React.useState('');

  const trackByQty    = variant?.trackByQty    ?? true;
  const trackByWeight = variant?.trackByWeight ?? false;

  React.useEffect(() => {
    if (open) {
      setType('IN'); setQuantity(''); setWeight(''); setNote('');
      setVendorId(''); setInvoiceNumber('');
      // Pre-fill unit price from the variant's master rate so the slip total
      // computes by default; user can still override per receipt.
      setUnitPrice(variant?.pricePerPiece != null ? String(variant.pricePerPiece) : '');
      setUnitRatePerGram('');
    }
  }, [open, variant]);

  // Vendors that supply raw materials — only those tagged with the
  // RAW_MATERIAL_SUPPLIER process. The vendor API doesn't include the
  // raw `processes` relation, but it serves `processNames` (comma-
  // joined display string) which we filter on client-side. No "fallback
  // to all vendors" — if no supplier is configured yet, the dropdown
  // stays empty and we surface an empty hint so the user knows to go
  // add one in Vendor Master.
  const vendorsQ = useQuery({
    queryKey: ['vendors-suppliers'],
    queryFn: () => Api.vendors.list(),
    enabled: open,
  });
  const supplierVendors = React.useMemo(() => {
    const all = (vendorsQ.data ?? []) as any[];
    return all.filter((v) => {
      const names = (v.processNames ?? '').toLowerCase();
      return names.includes('raw material supplier') || names.includes('raw material');
    });
  }, [vendorsQ.data]);

  const qtyNum = trackByQty    ? Math.max(0, Number(quantity || 0)) : 0;
  const wtNum  = trackByWeight ? Math.max(0, Number(weight   || 0)) : 0;
  const unitPriceNum = unitPrice === '' ? null : Number(unitPrice);
  const unitGramRateNum = unitRatePerGram === '' ? null : Number(unitRatePerGram);
  const lineTotal =
    unitPriceNum != null && qtyNum > 0 ? unitPriceNum * qtyNum
    : unitGramRateNum != null && wtNum > 0 ? unitGramRateNum * wtNum
    : null;

  const save = useMutation({
    mutationFn: () => Api.materials.adjustStock(variant.id, {
      type,
      quantity: qtyNum,
      weight: wtNum,
      note: note || undefined,
      // Only attach purchase metadata for vendor-tagged IN movements.
      vendorId: type === 'IN' && vendorId ? Number(vendorId) : null,
      invoiceNumber: type === 'IN' && vendorId ? (invoiceNumber || null) : null,
      unitPrice: type === 'IN' && vendorId && unitPriceNum != null ? unitPriceNum : null,
      unitRatePerGram: type === 'IN' && vendorId && unitGramRateNum != null ? unitGramRateNum : null,
    }),
    onSuccess: async () => {
      toast.success(type === 'IN' && vendorId ? 'Purchase slip recorded · stock updated.' : 'Stock updated.');
      qc.invalidateQueries({ queryKey: ['stock'] });
      qc.invalidateQueries({ queryKey: ['stock-movements'] });
      qc.invalidateQueries({ queryKey: ['pending-demand'] });
      qc.invalidateQueries({ queryKey: ['purchase-receipts'] });
      // After an IN movement, check if any vouchers have deferred demand for
      // this variant. If yes, the parent shows a "Issue now to vendor?" popup.
      if (type === 'IN' || type === 'ADJUST') {
        try {
          const demand = await Api.materialIssues.pendingDemand(variant.id);
          if (demand.length > 0 && onPendingDemand) {
            onPendingDemand(demand);
          }
        } catch { /* non-blocking */ }
      }
      onClose();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  return (
    <Dialog open={open} onClose={onClose} size="md"
      title={`Stock — ${variant?.variantName ?? ''}`}
      description={
        [
          trackByQty    ? `${Number(variant?.stockQty ?? 0)} pcs` : null,
          trackByWeight ? `${Number(variant?.stockWeight ?? 0)} g` : null,
        ].filter(Boolean).join(' · ') || 'No stock recorded'
      }
      footer={<><Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending || (qtyNum <= 0 && wtNum <= 0)}>{save.isPending && <Spinner />} Apply</Button></>}>
      <div className="space-y-3">
        <Field label="Action">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="IN">Add stock (IN) — from supplier</option>
            <option value="OUT">Remove stock (OUT)</option>
            <option value="ADJUST">Set exact balance (ADJUST)</option>
          </Select>
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {trackByQty && (
            <Field label={type === 'ADJUST' ? 'New balance (pcs)' : 'Quantity (pcs)'}>
              <Input type="number" step="0.001" min="0" value={quantity}
                onChange={(e) => setQuantity(e.target.value)} />
            </Field>
          )}
          {trackByWeight && (
            <Field label={type === 'ADJUST' ? 'New balance (g)' : 'Weight (g)'}>
              <Input type="number" step="0.001" min="0" value={weight}
                onChange={(e) => setWeight(e.target.value)} />
            </Field>
          )}
        </div>

        {/* Purchase slip block — only relevant for IN movements. Optional:
            if user skips the vendor field, this stays a plain stock adjust;
            if they pick one, the movement becomes a proper purchase receipt
            that lands in the vendor's "Received slips" folder on this page. */}
        {type === 'IN' && (
          <div className="success-tint space-y-3 rounded-lg p-3">
            <div className="text-[11px] font-bold uppercase tracking-wider text-success">
              📥 Purchase slip <span className="ml-1 font-normal normal-case tracking-normal text-text-faint">(optional — file this under a supplier)</span>
            </div>
            <Field label="Supplier (vendor)">
              <SearchableSelect
                value={vendorId}
                placeholder={
                  supplierVendors.length === 0
                    ? '— No raw-material suppliers configured —'
                    : '— Pick supplier (leave blank for ad-hoc) —'
                }
                onChange={(v) => setVendorId(v ? Number(v) : '')}
                options={supplierVendors.map((v: any) => ({
                  value: v.id, label: `${v.vendorCode} · ${v.vendorName}`, keywords: v.vendorName,
                }))}
              />
              {supplierVendors.length === 0 && (
                <p className="mt-1 text-xs text-warning">
                  No vendor has the &ldquo;Raw Material Supplier&rdquo; process yet.{' '}
                  <a href="/vendors" target="_blank" rel="noreferrer" className="font-medium underline">
                    Open Vendor Master ↗
                  </a>{' '}
                  and tick that process on the supplier&rsquo;s row, then come back.
                </p>
              )}
            </Field>
            {vendorId && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Field label="Supplier invoice #">
                  <Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="e.g. INV/2026/1234" />
                </Field>
                {trackByQty && (
                  <Field label="Unit price (₹/pc)">
                    <Input type="number" step="0.01" min="0" value={unitPrice}
                      onChange={(e) => setUnitPrice(e.target.value)} placeholder="optional" />
                  </Field>
                )}
                {trackByWeight && (
                  <Field label="Rate per gram (₹/g)">
                    <Input type="number" step="0.01" min="0" value={unitRatePerGram}
                      onChange={(e) => setUnitRatePerGram(e.target.value)} placeholder="optional" />
                  </Field>
                )}
                {lineTotal != null && lineTotal > 0 && (
                  <div className="col-span-2 text-xs text-success">
                    Slip total: <strong>{formatCurrency(lineTotal)}</strong>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. opening stock / purchase" /></Field>
      </div>
    </Dialog>
  );
}

// Columns for the Recent Stock Movements table. Lives at module scope so the
// reference is stable across renders (avoids react-table re-init churn).
const MOVEMENTS_COLUMNS: ColumnDef<any>[] = [
  {
    accessorKey: 'date', header: 'Date',
    cell: ({ row }) => formatDate(row.original.date),
  },
  {
    accessorKey: 'variantName', header: 'Material',
    cell: ({ row }) => (
      <div>
        <div className="font-medium">{row.original.variantName}</div>
        <div className="text-xs text-muted-foreground">{row.original.variantCode}</div>
      </div>
    ),
  },
  {
    accessorKey: 'type', header: 'Type',
    cell: ({ row }) => {
      const t = row.original.type;
      return <Badge variant={t === 'IN' ? 'success' : t === 'OUT' ? 'destructive' : 'secondary'}>{t}</Badge>;
    },
  },
  {
    accessorKey: 'quantity', header: 'Change',
    cell: ({ row }) => {
      const q = Number(row.original.quantity);
      return <span className={`font-medium tabular-nums ${q >= 0 ? 'text-success' : 'text-destructive'}`}>{q >= 0 ? `+${q}` : q}</span>;
    },
  },
  {
    accessorKey: 'balanceAfter', header: 'Balance',
    cell: ({ row }) => <span className="tabular-nums">{row.original.balanceAfter}</span>,
  },
  {
    accessorKey: 'refType', header: 'Ref', enableSorting: false,
    cell: ({ row }) => {
      const m = row.original;
      if (m.refType === 'purchase' && m.vendorCode) {
        return (
          <span className="text-muted-foreground">
            📥 from <strong className="text-foreground">{m.vendorCode}</strong> {m.vendorName}
            {m.invoiceNumber ? <> · {m.invoiceNumber}</> : null}
          </span>
        );
      }
      if (m.refType === 'sticking_batch') return <span className="text-muted-foreground">Sticking #{m.refId}</span>;
      if (m.refType === 'sticking_stage') return <span className="text-muted-foreground">Sticking stage #{m.refId}</span>;
      if (m.refType === 'material_issue') return <span className="text-muted-foreground">Issued via MIV #{m.refId}</span>;
      if (m.refType === 'material_issue_deferred') return <span className="text-muted-foreground">Deferred issue · MIV #{m.refId}</span>;
      return <span className="text-muted-foreground">{m.refType ?? '—'}</span>;
    },
  },
  {
    accessorKey: 'note', header: 'Note', enableSorting: false,
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.note || '—'}</span>,
  },
];

// Module-level cache — survives client-side nav, resets on hard reload.
let cachedInventoryFilter = { search: '' };

export default function InventoryPage() {
  const [search, setSearch] = React.useState(() => cachedInventoryFilter.search);
  React.useEffect(() => { cachedInventoryFilter = { search }; }, [search]);
  const [adjustVariant, setAdjustVariant] = React.useState<any>(null);
  // Pending demand for a specific variant, surfaced after stock IN. Triggers
  // the "Issue now to vendor X?" popup so the user doesn't have to remember
  // which voucher was waiting for materials.
  const [pendingDemand, setPendingDemand] = React.useState<any[] | null>(null);

  const stockQ = useQuery({ queryKey: ['stock', { search }], queryFn: () => Api.materials.stock(search || undefined) });
  const movesQ = useQuery({ queryKey: ['stock-movements'], queryFn: () => Api.materials.movements() });
  // All currently-deferred lines for the page-level "Pending demand" banner.
  const demandQ = useQuery({
    queryKey: ['pending-demand'],
    queryFn: () => Api.materialIssues.pendingDemand(),
    refetchOnWindowFocus: true, refetchInterval: 30_000,
  });

  const columns: ColumnDef<any>[] = [
    { accessorKey: 'variantCode', header: 'Code', cell: ({ row }) => <span className="font-semibold">{row.original.variantCode}</span> },
    {
      accessorKey: 'variantName', header: 'Material / Variant',
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.variantName}</div>
          <div className="text-xs text-muted-foreground">{row.original.materialName}{row.original.categoryName ? ` · ${row.original.categoryName}` : ''}</div>
        </div>
      ),
    },
    {
      id: 'specs', header: 'Specs', enableSorting: false,
      cell: ({ row }) => [row.original.size, row.original.color].filter(Boolean).join(' · ') || '—',
    },
    { accessorKey: 'price', header: 'Price/pc', cell: ({ row }) => formatCurrency(row.original.price) },
    {
      accessorKey: 'stockQty', header: 'In Stock',
      cell: ({ row }) => {
        const r = row.original;
        const trackQ = r.trackByQty ?? true;
        const trackW = r.trackByWeight ?? false;
        const q = Number(r.stockQty ?? 0);
        const w = Number(r.stockWeight ?? 0);
        if (!trackQ && !trackW) return <Badge variant="secondary">—</Badge>;
        return (
          <div className="flex flex-col gap-1">
            {trackQ && (
              <Badge variant={q <= 0 ? 'destructive' : q < 20 ? 'warning' : 'success'}>
                {q % 1 === 0 ? q.toFixed(0) : q.toFixed(3)} pcs
              </Badge>
            )}
            {trackW && (
              <Badge variant={w <= 0 ? 'destructive' : 'info'}>
                {w.toFixed(3)} g
              </Badge>
            )}
          </div>
        );
      },
    },
    {
      id: 'actions', header: () => <div className="text-right">Actions</div>, enableSorting: false,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => setAdjustVariant(row.original)}><PackagePlus className="size-4" /> Stock</Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Raw Materials Inventory" subtitle="Raw material stock on hand. Consumed when a Sticking material-issue voucher is created." />

      {/* Persistent Pending Demand banner — shows what's still owed to vendors
          across all open vouchers. Click "Issue all now" to fire the popup
          (which includes only rows where we now have enough stock). */}
      {(demandQ.data ?? []).length > 0 && (
        <Card className="mb-4 border-warning/30 bg-warning/5">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <div className="text-sm font-semibold text-warning">
                Pending material demand — {demandQ.data!.length} line(s) waiting on stock
              </div>
              <div className="text-xs text-warning">
                {demandQ.data!.reduce((s, d) => s + d.deferredQty, 0)} pcs owed across
                {' '}{new Set(demandQ.data!.map((d) => d.vendorId)).size} vendor(s)
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="border-amber-400 bg-white text-warning hover:bg-warning/15"
              onClick={() => {
                // Always open the dialog — even when stock is 0. The dialog
                // now includes per-row "Add stock" so the user can record
                // a purchase IN and issue in the same flow, without bouncing
                // back to the stock-adjust dialog.
                setPendingDemand(demandQ.data ?? []);
              }}>
              Review & issue
            </Button>
          </CardContent>
        </Card>
      )}

      <Card className="mb-4">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative flex-1 min-w-0 sm:min-w-[240px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search material / variant / code…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      {/* DataTable renders its own bordered card. */}
      <div className="mb-4">
        <DataTable columns={columns} data={stockQ.data ?? []} loading={stockQ.isLoading}
          emptyTitle="No materials yet" emptyDescription="Add material variants first." />
      </div>

      {/* Purchase History — vendor folders. Each folder = one supplier;
          inside, the individual received slips (date, material, qty,
          invoice #, ₹/pc, line total). Built from IN stock-movements
          that were tagged with a vendor at receive time. */}
      <PurchaseHistoryCard />

      <div className="mb-3 font-semibold">Recent Stock Movements</div>
      <DataTable
        columns={MOVEMENTS_COLUMNS}
        data={movesQ.data ?? []}
        loading={movesQ.isLoading}
        emptyTitle="No movements yet"
        emptyDescription="Stock IN / OUT movements will appear here as soon as the first one is recorded."
        searchable="Search date / material / vendor / invoice / ref…"
      />

      <AdjustDialog
        variant={adjustVariant}
        open={!!adjustVariant}
        onClose={() => setAdjustVariant(null)}
        onPendingDemand={(demand) => setPendingDemand(demand)}
      />
      {/* Auto-popup after stock IN that targets a variant with deferred demand. */}
      {pendingDemand && pendingDemand.length > 0 && (
        <IssueDeferredDialog
          demand={pendingDemand}
          open={true}
          onClose={() => setPendingDemand(null)}
        />
      )}
    </div>
  );
}

/**
 * Purchase History — one collapsible folder per supplier vendor; inside,
 * each folder lists the individual received slips (date, material, qty,
 * invoice #, ₹/pc, line total). Builds from IN stock movements that were
 * tagged with a vendor at receive time via the Stock dialog's purchase
 * slip block. Ad-hoc adjustments (no vendor) don't appear here — they
 * stay in "Recent Stock Movements" only.
 */
function PurchaseHistoryCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['purchase-receipts'],
    queryFn: () => Api.materials.purchaseReceipts(),
    refetchOnWindowFocus: true,
  });
  const [open, setOpen] = React.useState<Record<number, boolean>>({});
  const folders = (data ?? []) as any[];

  return (
    <Card className="mb-4">
      <CardContent className="p-0">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="font-semibold">📦 Purchase Receipts — by Supplier</div>
          {folders.length > 0 && (
            <div className="text-xs text-muted-foreground">{folders.length} supplier(s) · {folders.reduce((s, f) => s + f.slipCount, 0)} slip(s)</div>
          )}
        </div>
        {isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : folders.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">
            No purchase receipts yet. When you add stock IN and pick a supplier in the Stock dialog, the slip lands here in that vendor's folder.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {folders.map((f: any) => {
              const isOpen = !!open[f.vendorId];
              return (
                <div key={f.vendorId}>
                  <button type="button" onClick={() => setOpen((m) => ({ ...m, [f.vendorId]: !isOpen }))}
                    className="flex w-full items-center justify-between gap-3 px-5 py-2.5 text-left text-sm hover:bg-muted/40">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">{isOpen ? '▾' : '▸'}</span>
                      <span className="font-semibold">📁 {f.vendorCode} · {f.vendorName}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-muted-foreground">{f.slipCount} slip{f.slipCount === 1 ? '' : 's'}</span>
                      <span className="tabular-nums text-muted-foreground">·</span>
                      <span className="tabular-nums">total qty <strong className="text-foreground">{f.totalQty.toLocaleString()}</strong></span>
                      {f.totalAmount > 0 && (
                        <>
                          <span className="tabular-nums text-muted-foreground">·</span>
                          <span className="tabular-nums">total <strong className="text-success">{formatCurrency(f.totalAmount)}</strong></span>
                        </>
                      )}
                    </div>
                  </button>
                  {isOpen && (
                    <div className="table-scroll bg-background/60 px-5 py-2">
                      <table className="w-full min-w-[560px] text-sm">
                        <thead className="text-left text-xs text-muted-foreground">
                          <tr>
                            <th className="px-2 py-1 font-medium">Date</th>
                            <th className="px-2 py-1 font-medium">Invoice #</th>
                            <th className="px-2 py-1 font-medium">Material</th>
                            <th className="px-2 py-1 text-right font-medium">Qty</th>
                            <th className="px-2 py-1 text-right font-medium">₹ / unit</th>
                            <th className="px-2 py-1 text-right font-medium">Line total</th>
                            <th className="px-2 py-1 font-medium">Note</th>
                          </tr>
                        </thead>
                        <tbody>
                          {f.slips.map((s: any) => (
                            <tr key={s.id} className="border-t border-border/60">
                              <td className="px-2 py-1.5 tabular-nums">{formatDate(s.date)}</td>
                              <td className="px-2 py-1.5 font-medium">{s.invoiceNumber || <span className="text-muted-foreground">—</span>}</td>
                              <td className="px-2 py-1.5">
                                <div className="font-medium">{s.variantName}</div>
                                <div className="text-xs text-muted-foreground">{s.variantCode}{s.unit ? ` · ${s.unit}` : ''}</div>
                              </td>
                              <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-success">+{Math.abs(s.qty)}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums">{s.unitPrice != null ? formatCurrency(s.unitPrice) : <span className="text-muted-foreground">—</span>}</td>
                              <td className="px-2 py-1.5 text-right tabular-nums font-medium">{s.lineTotal > 0 ? formatCurrency(s.lineTotal) : <span className="text-muted-foreground">—</span>}</td>
                              <td className="px-2 py-1.5 text-muted-foreground">{s.note || '—'}</td>
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
    </Card>
  );
}

/**
 * "Issue now?" popup shown after a stock IN movement on a variant that one
 * or more vendors are still waiting for. The user can issue all, some, or
 * skip — each row records its own deferred decrement + OUT movement.
 */
// One aggregated row in the issue dialog — folds duplicate vouchers for
// the SAME (batch, vendor, design, variant) into a single line that the
// user types ONE qty against and that gets distributed back to the
// underlying MaterialIssueLines on submit.
interface DemandAggregate {
  key: string;
  batchNumber: string | null;
  vendorId: number;
  vendorCode: string;
  vendorName: string;
  itemNumber: string | null;
  variantId: number;
  variantName: string;
  variantCode: string;
  unit: string;
  totalDeferred: number;
  // Underlying MIVs and their share of the deferred qty — needed to
  // distribute the user-entered total back to the right MaterialIssueLine
  // when we actually call issueDeferred. Sorted largest deferred first
  // so the smallest line absorbs the leftover rounding.
  lines: { lineId: number; deferredQty: number; voucherNumber: string }[];
  voucherNumbers: string[];
  availableStock: number;
}

function IssueDeferredDialog({
  demand, open, onClose,
}: {
  demand: any[];
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  // Qty is now keyed by AGGREGATE key, not lineId — the user types one
  // qty for "V0017 · #5001 · Hook Standard in B0025" even if it spans
  // multiple vouchers.
  const [qty, setQty] = React.useState<Record<string, string>>({});
  const [liveStock, setLiveStock] = React.useState<Record<number, number>>({});
  const [addStock, setAddStock] = React.useState<Record<number, string>>({});

  // Group demand into aggregate rows. Same (batch, vendor, design, variant)
  // tuple — even if it comes from N different vouchers — renders as ONE row.
  const aggregates: DemandAggregate[] = React.useMemo(() => {
    const m = new Map<string, DemandAggregate>();
    for (const d of demand) {
      const key = `${d.batchNumber ?? ''}|${d.vendorId}|${d.itemNumber ?? ''}|${d.variantId}`;
      const agg = m.get(key) ?? {
        key,
        batchNumber: (d.batchNumber ?? null) as string | null,
        vendorId: d.vendorId,
        vendorCode: d.vendorCode,
        vendorName: d.vendorName,
        itemNumber: (d.itemNumber ?? null) as string | null,
        variantId: d.variantId,
        variantName: d.variantName ?? '',
        variantCode: d.variantCode ?? '',
        unit: d.unit ?? '',
        totalDeferred: 0,
        lines: [] as { lineId: number; deferredQty: number; voucherNumber: string }[],
        voucherNumbers: [] as string[],
        availableStock: d.availableStock,
      };
      agg.totalDeferred += d.deferredQty;
      agg.lines.push({ lineId: d.lineId, deferredQty: d.deferredQty, voucherNumber: d.voucherNumber });
      if (!agg.voucherNumbers.includes(d.voucherNumber)) agg.voucherNumbers.push(d.voucherNumber);
      m.set(key, agg);
    }
    // Sort underlying lines largest-first so issuing partial fills
    // the bigger demand voucher first.
    for (const a of m.values()) a.lines.sort((x, y) => y.deferredQty - x.deferredQty);
    return Array.from(m.values());
  }, [demand]);

  React.useEffect(() => {
    if (!open) return;
    const init: Record<string, string> = {};
    const stockInit: Record<number, number> = {};
    for (const a of aggregates) {
      stockInit[a.variantId] = a.availableStock;
      init[a.key] = '0';
    }
    setLiveStock(stockInit);
    setAddStock({});
    setQty(init);
  }, [open, aggregates]);

  // "Add N to stock" — fires an IN movement against the variant, updates the
  // local cap, and bumps the default issue-now qty so the user can hit Issue.
  const orderMore = useMutation({
    mutationFn: (args: { variantId: number; qty: number; name: string }) =>
      Api.materials.adjustStock(args.variantId, {
        type: 'IN', quantity: args.qty,
        note: `Recorded purchase for pending demand`,
      }),
    onSuccess: (_, args) => {
      toast.success(`Stock +${args.qty} recorded for ${args.name}.`);
      setLiveStock((s) => ({ ...s, [args.variantId]: (s[args.variantId] ?? 0) + args.qty }));
      // Note: we DO NOT auto-fill qty on demand rows after stock arrives.
      // The user explicitly picks which batch/design to send the new stock
      // to via the per-row Issue button or by typing in the qty field.
      setAddStock((m) => ({ ...m, [args.variantId]: '' }));
      qc.invalidateQueries({ queryKey: ['stock'] });
      qc.invalidateQueries({ queryKey: ['stock-movements'] });
      qc.invalidateQueries({ queryKey: ['pending-demand'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  // Distribute an aggregate's typed qty across its underlying MIV lines,
  // largest-line-first. Returns [{lineId, qty}] tuples to fire.
  const distribute = (agg: DemandAggregate, total: number): { lineId: number; qty: number }[] => {
    let remaining = Math.max(0, Math.trunc(total));
    const out: { lineId: number; qty: number }[] = [];
    for (const ln of agg.lines) {
      if (remaining <= 0) break;
      const take = Math.min(ln.deferredQty, remaining);
      if (take > 0) out.push({ lineId: ln.lineId, qty: take });
      remaining -= take;
    }
    return out;
  };

  const submitting = React.useRef(false);
  const apply = useMutation({
    mutationFn: async () => {
      // Track how much each variant lost so we can decrement liveStock
      // immediately on success — the dialog's "stock NNN" pill won't refetch
      // its source data until the dialog is reopened, so without this the
      // visible stock count would stay stale until the dialog closes.
      const perVariant: Record<number, number> = {};
      let issued = 0;
      for (const a of aggregates) {
        const q = Math.max(0, Math.trunc(Number(qty[a.key] || 0)));
        if (q <= 0) continue;
        for (const part of distribute(a, q)) {
          await Api.materialIssues.issueDeferred(part.lineId, part.qty);
          issued += part.qty;
          perVariant[a.variantId] = (perVariant[a.variantId] ?? 0) + part.qty;
        }
      }
      return { issued, perVariant };
    },
    onSuccess: (r) => {
      toast.success(`Issued ${r.issued} pcs of pending material — vendors topped up.`);
      // Decrement local stock state so the pool pill reflects what just left
      // even if the dialog stays open.
      setLiveStock((s) => {
        const next = { ...s };
        for (const [vid, taken] of Object.entries(r.perVariant)) {
          const id = Number(vid);
          next[id] = Math.max(0, (next[id] ?? 0) - taken);
        }
        return next;
      });
      qc.invalidateQueries({ queryKey: ['pending-demand'] });
      qc.invalidateQueries({ queryKey: ['material-issues'] });
      qc.invalidateQueries({ queryKey: ['vendor-holdings'] });
      qc.invalidateQueries({ queryKey: ['stock'] });
      qc.invalidateQueries({ queryKey: ['stock-movements'] });
      submitting.current = false;
      onClose();
    },
    onError: (e) => { submitting.current = false; toast.error(getApiError(e).message); },
  });
  const submit = () => {
    if (submitting.current || apply.isPending) return;
    submitting.current = true;
    apply.mutate();
  };

  // Per-row issue — user picks ONE aggregate to fulfil now. The typed qty
  // is distributed across the underlying MIV lines for that vendor+design.
  const issueOneRow = useMutation({
    mutationFn: async (args: { aggKey: string; qty: number; name: string }) => {
      const agg = aggregates.find((a) => a.key === args.aggKey);
      if (!agg) throw new Error('Row not found');
      for (const part of distribute(agg, args.qty)) {
        await Api.materialIssues.issueDeferred(part.lineId, part.qty);
      }
      return { ...args, variantId: agg.variantId };
    },
    onSuccess: (args) => {
      toast.success(`Issued ${args.qty} pcs of ${args.name}.`);
      setQty((m) => ({ ...m, [args.aggKey]: '0' }));
      // Decrement local stock pool so the pill updates immediately.
      setLiveStock((s) => ({
        ...s,
        [args.variantId]: Math.max(0, (s[args.variantId] ?? 0) - args.qty),
      }));
      qc.invalidateQueries({ queryKey: ['pending-demand'] });
      qc.invalidateQueries({ queryKey: ['material-issues'] });
      qc.invalidateQueries({ queryKey: ['vendor-holdings'] });
      qc.invalidateQueries({ queryKey: ['stock'] });
      qc.invalidateQueries({ queryKey: ['stock-movements'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const clearAll = () => setQty(Object.fromEntries(aggregates.map((a) => [a.key, '0'])));
  const fillAll = () => {
    const next: Record<string, string> = {};
    const remaining: Record<number, number> = {};
    for (const a of aggregates) {
      if (!(a.variantId in remaining)) remaining[a.variantId] = liveStock[a.variantId] ?? a.availableStock;
    }
    for (const a of aggregates) {
      const r = remaining[a.variantId] ?? 0;
      const take = Math.max(0, Math.min(a.totalDeferred, r));
      next[a.key] = String(take);
      remaining[a.variantId] = r - take;
    }
    setQty(next);
  };

  const total = aggregates.reduce((s, a) => s + Math.max(0, Math.trunc(Number(qty[a.key] || 0))), 0);
  const nonZeroRows = aggregates.filter((a) => Math.max(0, Math.trunc(Number(qty[a.key] || 0))) > 0).length;

  return (
    <Dialog open={open} onClose={onClose} size="lg"
      title="Pending material demand — issue now?"
      description="A vendor was waiting on these materials. Stock just arrived; here's what's still owed."
      footer={
        <>
          <div className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
            <button type="button" className="text-primary hover:underline disabled:opacity-40"
              onClick={clearAll} disabled={apply.isPending || total === 0}>
              Clear all
            </button>
            <span className="text-muted-foreground/40">·</span>
            <button type="button" className="text-primary hover:underline disabled:opacity-40"
              onClick={fillAll} disabled={apply.isPending}>
              Fill all (max)
            </button>
          </div>
          <Button variant="outline" onClick={onClose} disabled={apply.isPending}>Close</Button>
          <Button onClick={submit} disabled={apply.isPending || total === 0}>
            {apply.isPending && <Spinner />}
            {apply.isPending ? 'Issuing…' : `Issue selected (${nonZeroRows} row${nonZeroRows === 1 ? '' : 's'} · ${total} pcs)`}
          </Button>
        </>
      }>
      <div className="space-y-3">
        {/* Per-variant stock pool panel — ONE card per raw material, with
            global stock + total demand + the "+ Add stock" control. Lives
            ABOVE the table so the user doesn't see 50 copies of the same
            input next to identical "0 stock · need 5000 more" labels. */}
        {(() => {
          const perVariant = new Map<number, { name: string; code: string; demanded: number; rows: number; allocated: number; available: number }>();
          for (const a of aggregates) {
            const cur = perVariant.get(a.variantId) ?? {
              name: a.variantName, code: a.variantCode,
              demanded: 0, rows: 0, allocated: 0,
              available: liveStock[a.variantId] ?? a.availableStock,
            };
            cur.demanded += a.totalDeferred;
            cur.rows += 1;
            cur.allocated += Math.max(0, Math.trunc(Number(qty[a.key] || 0)));
            perVariant.set(a.variantId, cur);
          }
          const variants = Array.from(perVariant.entries()).map(([id, v]) => ({ id, ...v }));
          if (variants.length === 0) return null;
          return (
            <div className="rounded-lg border border-info/30 bg-info/15 p-2">
              <div className="mb-1.5 px-1 text-xs font-semibold text-sky-900">📊 Stock pool — global per material, shared across all rows below</div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {variants.map((v) => {
                  const needToBuy = Math.max(0, v.demanded - v.available);
                  const stockInVal = addStock[v.id] ?? '';
                  const stockInNum = Math.max(0, Math.trunc(Number(stockInVal || 0)));
                  return (
                    <div key={v.id} className="flex flex-wrap items-center gap-2 rounded border border-info/30 bg-white px-2 py-1.5 text-xs">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{v.name}</div>
                        <div className="text-[10px] text-muted-foreground">{v.code}</div>
                      </div>
                      <div className="tabular-nums whitespace-nowrap text-[11px]">
                        <span className="text-muted-foreground">need </span>
                        <strong className={needToBuy > 0 ? 'text-warning' : 'text-success'}>{v.demanded.toLocaleString()}</strong>
                        <span className="text-muted-foreground"> · stock </span>
                        <strong className={v.available === 0 ? 'text-destructive' : ''}>{v.available.toLocaleString()}</strong>
                        {v.allocated > 0 && (
                          <>
                            <span className="text-muted-foreground"> · using </span>
                            <strong className="text-info">{v.allocated.toLocaleString()}</strong>
                          </>
                        )}
                      </div>
                      {needToBuy > 0 && (
                        <div className="inline-flex items-center gap-1">
                          <Input
                            type="number" min={0} step="1"
                            placeholder={String(needToBuy)}
                            className="h-7 w-20 text-right"
                            value={stockInVal}
                            onChange={(e) => setAddStock((m) => ({ ...m, [v.id]: e.target.value.replace(/[^0-9]/g, '') }))}
                          />
                          <Button
                            type="button" size="sm" variant="outline" className="h-7 px-2 text-[11px]"
                            disabled={orderMore.isPending || stockInNum <= 0}
                            onClick={() => orderMore.mutate({ variantId: v.id, qty: stockInNum, name: v.name })}>
                            + Add
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}
        {/* overflow-x:auto so the right-side Issue column stays reachable on
            narrower screens. min-w on the table keeps columns from squashing
            into unreadable widths. */}
        <div className="table-scroll rounded-lg border border-border">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Vendor · Design</th>
                <th className="px-3 py-2">Material</th>
                <th className="px-3 py-2 text-right">Owed (all vouchers)</th>
                <th className="px-3 py-2 text-right">Issue this</th>
              </tr>
            </thead>
            <tbody>
              {/* Rows are aggregated by (batch, vendor, design, variant) — so
                  two vouchers for the SAME vendor+design+material in the same
                  batch fold into ONE line whose Owed is the sum. Stock & "+ Add"
                  live in the per-material pool panel above; nothing in this
                  table varies by variant beyond name + owed + cap. */}
              {(() => {
                const groups = new Map<string, { batchNumber: string | null; aggs: DemandAggregate[] }>();
                for (const a of aggregates) {
                  const k = a.batchNumber ?? '__none__';
                  const g = groups.get(k) ?? { batchNumber: a.batchNumber, aggs: [] as DemandAggregate[] };
                  g.aggs.push(a);
                  groups.set(k, g);
                }
                const ordered = Array.from(groups.values()).sort((a, b) => {
                  if (!a.batchNumber) return 1;
                  if (!b.batchNumber) return -1;
                  return a.batchNumber.localeCompare(b.batchNumber);
                });

                // Within each batch, sort: vendor, then design, then material.
                for (const g of ordered) {
                  g.aggs.sort((x, y) => {
                    if (x.vendorCode !== y.vendorCode) return x.vendorCode.localeCompare(y.vendorCode);
                    if ((x.itemNumber ?? '') !== (y.itemNumber ?? '')) return (x.itemNumber ?? '').localeCompare(y.itemNumber ?? '');
                    return x.variantName.localeCompare(y.variantName);
                  });
                }

                const fillBatch = (aggs: DemandAggregate[]) => {
                  setQty((m) => {
                    const next = { ...m };
                    const remaining: Record<number, number> = {};
                    for (const a of aggs) {
                      if (a.variantId in remaining) continue;
                      const avail = liveStock[a.variantId] ?? a.availableStock;
                      const otherBatchUsage = aggregates
                        .filter((x) => x.variantId === a.variantId && !aggs.includes(x))
                        .reduce((s, x) => s + Math.max(0, Math.trunc(Number(next[x.key] || 0))), 0);
                      remaining[a.variantId] = Math.max(0, avail - otherBatchUsage);
                    }
                    for (const a of aggs) {
                      const r = remaining[a.variantId] ?? 0;
                      const take = Math.max(0, Math.min(a.totalDeferred, r));
                      next[a.key] = String(take);
                      remaining[a.variantId] = r - take;
                    }
                    return next;
                  });
                };

                return ordered.flatMap((g) => {
                  const groupOwed = g.aggs.reduce((s, a) => s + a.totalDeferred, 0);
                  const designSet = new Set(g.aggs.map((a) => a.itemNumber).filter(Boolean));
                  const groupAllocated = g.aggs.reduce((s, a) => s + Math.max(0, Math.trunc(Number(qty[a.key] || 0))), 0);
                  const groupHeader = (
                    <tr key={`hdr-${g.batchNumber ?? 'none'}`} className="border-t border-border bg-info/10/50">
                      <td colSpan={4} className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-semibold text-sky-900">
                            📦 {g.batchNumber ? `Batch ${g.batchNumber}` : 'Other (no batch)'}
                          </span>
                          <span className="text-muted-foreground">
                            {designSet.size} design{designSet.size === 1 ? '' : 's'} · {g.aggs.length} row{g.aggs.length === 1 ? '' : 's'} · owes <strong className="text-warning tabular-nums">{groupOwed.toLocaleString()}</strong> pcs
                          </span>
                          {groupAllocated > 0 && (
                            <span className="rounded bg-info/15 px-1.5 py-0.5 text-info ring-1 ring-info/30">
                              allocating <strong className="tabular-nums">{groupAllocated.toLocaleString()}</strong>
                            </span>
                          )}
                          <div className="ml-auto flex items-center gap-1.5">
                            <button type="button" className="text-[11px] text-primary hover:underline"
                              onClick={() => fillBatch(g.aggs)}>
                              Fill this batch
                            </button>
                            <span className="text-muted-foreground/40">·</span>
                            <button type="button" className="text-[11px] text-primary hover:underline"
                              onClick={() => setQty((m) => {
                                const next = { ...m };
                                for (const a of g.aggs) next[a.key] = '0';
                                return next;
                              })}>
                              Clear this batch
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                  const rowTrs = g.aggs.map((a) => {
                    const avail = liveStock[a.variantId] ?? a.availableStock;
                    const otherRowsTaking = aggregates
                      .filter((x) => x.variantId === a.variantId && x.key !== a.key)
                      .reduce((s, x) => s + Math.max(0, Math.trunc(Number(qty[x.key] || 0))), 0);
                    const availForThisRow = Math.max(0, avail - otherRowsTaking);
                    const cap = Math.min(a.totalDeferred, availForThisRow);
                    const v = Math.max(0, Math.trunc(Number(qty[a.key] || 0)));
                    const over = v > cap;
                    return (
                      <tr key={a.key} className="border-t border-border">
                        <td className="px-3 py-2 text-xs align-top">
                          <div className="font-medium">{a.vendorCode} · {a.vendorName}</div>
                          {a.itemNumber && <div className="text-muted-foreground">Design #{a.itemNumber}</div>}
                          {a.voucherNumbers.length > 0 && (
                            <div className="mt-0.5 text-[10px] text-muted-foreground" title={a.voucherNumbers.join(', ')}>
                              {a.voucherNumbers.length === 1
                                ? a.voucherNumbers[0]
                                : `${a.voucherNumbers.length} vouchers (${a.voucherNumbers.slice(0, 2).join(', ')}${a.voucherNumbers.length > 2 ? '…' : ''})`}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <div className="font-medium">{a.variantName}</div>
                          <div className="text-[10px] text-muted-foreground">{a.variantCode}{a.unit ? ` · ${a.unit}` : ''}</div>
                          {/* Per-row stock state — the SOLE indicator of why
                              the Issue button is enabled or disabled. No extra
                              text in the Issue column so the layout stays tight. */}
                          {(() => {
                            const tone = cap === 0
                              ? 'bg-destructive/10 text-destructive ring-red-200'
                              : cap < a.totalDeferred
                                ? 'bg-warning/10 text-warning ring-warning/30'
                                : 'bg-success/10 text-success ring-success/30';
                            let label: string;
                            if (avail === 0) label = '🔒 no stock';
                            else if (cap === 0) label = '🔒 pool taken';
                            else if (availForThisRow < avail) label = `${availForThisRow.toLocaleString()} free`;
                            else if (avail >= a.totalDeferred) label = `stock ${avail.toLocaleString()} ✓`;
                            else label = `stock ${avail.toLocaleString()}`;
                            return (
                              <div className={`mt-1 inline-flex max-w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${tone}`}>
                                {label}
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-warning align-top">{a.totalDeferred.toLocaleString()}</td>
                        <td className={`px-3 py-2 text-right align-top ${cap === 0 ? 'bg-muted/30' : ''}`}>
                          <div className="inline-flex items-center gap-1 whitespace-nowrap">
                            <Input type="number" min={0} max={cap} step="1"
                              className={`h-8 w-24 text-right ${over ? 'border-red-300 bg-destructive/10' : ''}`}
                              value={qty[a.key] ?? ''}
                              disabled={cap === 0}
                              onChange={(e) => {
                                const raw = e.target.value.replace(/[^0-9]/g, '');
                                const clamped = raw === '' ? '' : String(Math.min(cap, Math.max(0, Math.trunc(Number(raw)))));
                                setQty((m) => ({ ...m, [a.key]: clamped }));
                              }}
                            />
                            <Button
                              type="button" size="sm" variant="outline"
                              className="h-8 px-2 text-[11px]"
                              disabled={v <= 0 || over || issueOneRow.isPending || apply.isPending}
                              onClick={() => issueOneRow.mutate({ aggKey: a.key, qty: v, name: a.variantName })}>
                              Issue
                            </Button>
                          </div>
                          {over && <div className="text-[10px] text-destructive">max {cap}</div>}
                        </td>
                      </tr>
                    );
                  });
                  return [groupHeader, ...rowTrs];
                });
              })()}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Rows are aggregated by vendor + design + material — duplicate vouchers fold into one line. Use the per-row <strong>Issue</strong> button to top up one material now, or the footer <strong>Issue selected</strong> button to fire every row with a qty &gt; 0. <strong>Close</strong> leaves remaining demand in place.
        </p>
      </div>
    </Dialog>
  );
}
