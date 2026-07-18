'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Wallet, Plus, ArrowDownLeft, Pencil, Filter, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/shared/field';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { formatDate } from '@/lib/utils';
import { SortableTh, useTableSort } from '@/components/shared/sortable-table';

type EventType = 'ALLOCATE_ADVANCE' | 'DRAW_INTO_BATCH' | 'RETURN_TO_ADVANCE' | 'ADJUST';
const EVENT_LABEL: Record<EventType, string> = {
  ALLOCATE_ADVANCE: 'Allocate',
  DRAW_INTO_BATCH:  'Drawn into batch',
  RETURN_TO_ADVANCE: 'Return',
  ADJUST:           'Adjust',
};
const EVENT_VARIANT: Record<EventType, 'success' | 'info' | 'warning' | 'secondary'> = {
  ALLOCATE_ADVANCE: 'success',
  DRAW_INTO_BATCH:  'info',
  RETURN_TO_ADVANCE: 'success',
  ADJUST:           'warning',
};

/**
 * Vendor Advances page — manage pre-allocated metal balances per (vendor × variant).
 *
 * Top: balances grid (positive balances only). Click a row → opens ledger
 * scoped to that pair. Top-right "Allocate" button opens a modal.
 * Below: ledger feed (most recent first) with optional vendor filter.
 */
export default function VendorAdvancesPage() {
  const qc = useQueryClient();
  const [vendorFilter, setVendorFilter] = React.useState<number | ''>('');
  const [allocOpen, setAllocOpen] = React.useState(false);
  const [returnOpen, setReturnOpen] = React.useState<{ vendorId: number; variantId: number; vendorName: string; variantName: string; balance: number } | null>(null);
  const [editLedger, setEditLedger] = React.useState<{ id: number; weight: number; note: string | null } | null>(null);

  const deleteLedger = useMutation({
    mutationFn: (id: number) => Api.vendorAdvances.deleteLedger(id),
    onSuccess: () => {
      toast.success('Deleted. Balances unwound.');
      qc.invalidateQueries({ queryKey: ['vendor-advance-balances'] });
      qc.invalidateQueries({ queryKey: ['vendor-advance-ledger'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const balancesQ = useQuery({
    queryKey: ['vendor-advance-balances', vendorFilter],
    queryFn: () => Api.vendorAdvances.balances(vendorFilter ? Number(vendorFilter) : undefined),
  });
  const ledgerQ = useQuery({
    queryKey: ['vendor-advance-ledger', vendorFilter],
    queryFn: () => Api.vendorAdvances.ledger({ vendorId: vendorFilter ? Number(vendorFilter) : undefined, limit: 200 }),
  });
  const vendorsQ = useQuery({ queryKey: ['vendors-all'], queryFn: () => Api.vendors.list() });

  const totalAdvance = (balancesQ.data ?? []).reduce((s, r) => s + Number(r.balanceWeight || 0), 0);
  const vendorCount  = new Set((balancesQ.data ?? []).map((r) => r.vendorId)).size;

  const balancesSort = useTableSort<any>(
    balancesQ.data,
    'balanceWeight',
    'desc',
    {
      balanceWeight: (r) => Number(r.balanceWeight),
      updatedAt:     (r) => new Date(r.updatedAt).getTime(),
    },
  );
  const ledgerSort = useTableSort<any>(
    ledgerQ.data,
    'createdAt',
    'desc',
    {
      createdAt:    (r) => new Date(r.createdAt).getTime(),
      weight:       (r) => Number(r.weight),
      balanceAfter: (r) => Number(r.balanceAfter),
    },
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Vendor Advances"
        description="Pre-allocated metal sitting with karigars. Allocate fresh advance, record returns, adjust manually."
        action={
          <Button onClick={() => setAllocOpen(true)}>
            <Plus className="size-4" /> Allocate Advance
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card><CardContent className="p-4">
          <div className="section-label">Total Advance Outstanding</div>
          <div className="mt-1 font-mono text-2xl font-bold text-gold">{totalAdvance.toFixed(3)} <span className="text-base text-text-faint">g</span></div>
          <div className="text-xs text-text-faint">across {vendorCount} vendor{vendorCount === 1 ? '' : 's'}</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="section-label">Active Balances</div>
          <div className="mt-1 font-mono text-2xl font-bold text-info">{balancesQ.data?.length ?? 0}</div>
          <div className="text-xs text-text-faint">(vendor × variant) rows</div>
        </CardContent></Card>
        <Card><CardContent className="p-4 flex flex-col gap-2">
          <div className="section-label">Filter</div>
          <SearchableSelect
            value={vendorFilter}
            placeholder="All vendors"
            onChange={(v) => setVendorFilter(v ? Number(v) : '')}
            options={[
              { value: '', label: 'All vendors', keywords: '' },
              ...(vendorsQ.data ?? []).map((v: any) => ({
                value: v.id, label: `${v.vendorCode} · ${v.vendorName}`, keywords: v.vendorName,
              })),
            ]}
          />
        </CardContent></Card>
      </div>

      {/* Balances */}
      <Card>
        <CardContent className="p-4">
          <h2 className="mb-3 section-label flex items-center gap-2"><Wallet className="size-4 text-gold" /> Balances</h2>
          {balancesQ.isLoading ? (
            <div className="py-8 text-center"><Spinner /></div>
          ) : (balancesQ.data ?? []).length === 0 ? (
            <p className="py-4 text-sm text-text-muted">No active advances. Click "Allocate Advance" to start.</p>
          ) : (
            <div className="table-scroll">
              <table className="w-full text-sm">
                <thead className="text-left text-text-faint">
                  <tr>
                    <SortableTh label="Vendor"           sortKey="vendorName"    currentKey={balancesSort.sortKey} currentDir={balancesSort.sortDir} onToggle={balancesSort.toggle} />
                    <SortableTh label="Material variant" sortKey="variantName"   currentKey={balancesSort.sortKey} currentDir={balancesSort.sortDir} onToggle={balancesSort.toggle} />
                    <SortableTh label="Balance (g)"      sortKey="balanceWeight" currentKey={balancesSort.sortKey} currentDir={balancesSort.sortDir} onToggle={balancesSort.toggle} align="right" />
                    <SortableTh label="Updated"          sortKey="updatedAt"     currentKey={balancesSort.sortKey} currentDir={balancesSort.sortDir} onToggle={balancesSort.toggle} />
                    <th className="py-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {balancesSort.sorted.map((r: any) => (
                    <tr key={`${r.vendorId}-${r.variantId}`} className="border-t border-border">
                      <td className="py-2 pr-3">
                        <div className="font-medium">{r.vendorName}</div>
                        <div className="text-xs text-text-faint">{r.vendorCode}{r.vendorShortName ? ` · ${r.vendorShortName}` : ''}</div>
                      </td>
                      <td className="py-2 pr-3">
                        <div>{r.variantName}</div>
                        <div className="text-xs text-text-faint">{r.materialName} · {r.variantCode}</div>
                      </td>
                      <td className="py-2 pr-3 text-right">
                        <span className="font-mono font-semibold text-gold">{Number(r.balanceWeight).toFixed(3)}</span>
                      </td>
                      <td className="py-2 pr-3 text-text-muted">{formatDate(r.updatedAt)}</td>
                      <td className="py-2 text-right">
                        <Button
                          variant="outline" size="sm"
                          onClick={() => setReturnOpen({
                            vendorId: r.vendorId, variantId: r.variantId,
                            vendorName: r.vendorName, variantName: r.variantName,
                            balance: Number(r.balanceWeight),
                          })}
                        >
                          <ArrowDownLeft className="size-4" /> Return
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Ledger */}
      <Card>
        <CardContent className="p-4">
          <h2 className="mb-3 section-label flex items-center gap-2"><Filter className="size-4 text-gold" /> Recent ledger entries</h2>
          {ledgerQ.isLoading ? (
            <div className="py-8 text-center"><Spinner /></div>
          ) : (ledgerQ.data ?? []).length === 0 ? (
            <p className="py-4 text-sm text-text-muted">No ledger entries yet.</p>
          ) : (
            <div className="table-scroll">
              <table className="w-full text-sm">
                <thead className="text-left text-text-faint">
                  <tr>
                    <SortableTh label="When"          sortKey="createdAt"    currentKey={ledgerSort.sortKey} currentDir={ledgerSort.sortDir} onToggle={ledgerSort.toggle} />
                    <SortableTh label="Event"         sortKey="eventType"    currentKey={ledgerSort.sortKey} currentDir={ledgerSort.sortDir} onToggle={ledgerSort.toggle} />
                    <SortableTh label="Vendor"        sortKey="vendorName"   currentKey={ledgerSort.sortKey} currentDir={ledgerSort.sortDir} onToggle={ledgerSort.toggle} />
                    <SortableTh label="Variant"       sortKey="variantName"  currentKey={ledgerSort.sortKey} currentDir={ledgerSort.sortDir} onToggle={ledgerSort.toggle} />
                    <SortableTh label="Weight (g)"    sortKey="weight"       currentKey={ledgerSort.sortKey} currentDir={ledgerSort.sortDir} onToggle={ledgerSort.toggle} align="right" />
                    <SortableTh label="Balance after" sortKey="balanceAfter" currentKey={ledgerSort.sortKey} currentDir={ledgerSort.sortDir} onToggle={ledgerSort.toggle} align="right" />
                    <SortableTh label="Note"          sortKey="note"         currentKey={ledgerSort.sortKey} currentDir={ledgerSort.sortDir} onToggle={ledgerSort.toggle} />
                    <th className="py-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerSort.sorted.map((r: any) => {
                    // Production draws (DRAW_INTO_BATCH) can't be edited or
                    // deleted here — they're linked to a receipt. Edit them
                    // via the source receipt so stock/lot effects unwind
                    // consistently.
                    const canMutate = r.eventType !== 'DRAW_INTO_BATCH';
                    return (
                      <tr key={r.id} className="border-t border-border">
                        <td className="py-2 pr-3 text-text-muted">{formatDate(r.createdAt)}</td>
                        <td className="py-2 pr-3"><Badge variant={EVENT_VARIANT[r.eventType as EventType]}>{EVENT_LABEL[r.eventType as EventType]}</Badge></td>
                        <td className="py-2 pr-3">{r.vendorName} <span className="text-xs text-text-faint">({r.vendorCode})</span></td>
                        <td className="py-2 pr-3">{r.variantName}</td>
                        <td className={`py-2 pr-3 text-right font-mono ${r.weight < 0 ? 'text-warning' : 'text-success'}`}>
                          {r.weight > 0 ? '+' : ''}{Number(r.weight).toFixed(3)}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono">{Number(r.balanceAfter).toFixed(3)}</td>
                        <td className="py-2 pr-3 text-text-muted">{r.note ?? '—'}</td>
                        <td className="py-2 text-right">
                          {canMutate ? (
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="outline" size="icon" title="Edit weight / note"
                                onClick={() => setEditLedger({ id: r.id, weight: Math.abs(Number(r.weight)), note: r.note })}
                              >
                                <Pencil className="size-4" />
                              </Button>
                              <Button
                                variant="outline" size="icon" title="Delete + unwind balances"
                                className="text-destructive hover:bg-destructive/10"
                                onClick={() => {
                                  if (confirm(`Delete this ${EVENT_LABEL[r.eventType as EventType]} entry?\n\nWeight: ${Number(r.weight).toFixed(3)} g\nBalance impact will be reversed.`)) {
                                    deleteLedger.mutate(r.id);
                                  }
                                }}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          ) : (
                            <span className="text-xs text-text-faint" title="Edit via the source receipt">receipt-linked</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <AllocateDialog
        open={allocOpen} onClose={() => setAllocOpen(false)}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ['vendor-advance-balances'] });
          qc.invalidateQueries({ queryKey: ['vendor-advance-ledger'] });
        }}
      />
      <ReturnDialog
        ctx={returnOpen} onClose={() => setReturnOpen(null)}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ['vendor-advance-balances'] });
          qc.invalidateQueries({ queryKey: ['vendor-advance-ledger'] });
        }}
      />
      <EditLedgerDialog
        ctx={editLedger} onClose={() => setEditLedger(null)}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ['vendor-advance-balances'] });
          qc.invalidateQueries({ queryKey: ['vendor-advance-ledger'] });
        }}
      />
    </div>
  );
}

function EditLedgerDialog({
  ctx, onClose, onSaved,
}: {
  ctx: { id: number; weight: number; note: string | null } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const open = ctx != null;
  const [weight, setWeight] = React.useState('');
  const [note, setNote]     = React.useState('');
  React.useEffect(() => {
    if (ctx) { setWeight(String(ctx.weight)); setNote(ctx.note ?? ''); }
  }, [ctx]);

  const save = useMutation({
    mutationFn: () => Api.vendorAdvances.updateLedger(ctx!.id, {
      weight: Number(weight), note: note || undefined,
    }),
    onSuccess: () => { toast.success('Updated.'); onSaved(); onClose(); },
    onError: (e) => toast.error(getApiError(e).message),
  });

  return (
    <Dialog open={open} onClose={onClose} size="sm"
      title="Edit Ledger Entry"
      description="Weight sign (allocate vs return) is preserved — only the magnitude changes. Balances shift by the delta."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => save.mutate()}
            disabled={!weight || Number(weight) <= 0 || save.isPending}>
            {save.isPending && <Spinner />} Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Weight (g)" required>
          <Input type="number" step="0.001" min="0.001" value={weight}
            onChange={(e) => setWeight(e.target.value)} />
        </Field>
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
        </Field>
      </div>
    </Dialog>
  );
}

function AllocateDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const vendorsQ  = useQuery({ queryKey: ['vendors-all'],   queryFn: () => Api.vendors.list(),   enabled: open });
  const variantsQ = useQuery({ queryKey: ['materials-weight'], queryFn: () => Api.materials.stock(), enabled: open });

  const [vendorId, setVendorId]   = React.useState<number | ''>('');
  const [variantId, setVariantId] = React.useState<number | ''>('');
  const [weight, setWeight]       = React.useState('');
  const [note, setNote]           = React.useState('');

  React.useEffect(() => {
    if (open) { setVendorId(''); setVariantId(''); setWeight(''); setNote(''); }
  }, [open]);

  const weightTrackedVariants = (variantsQ.data ?? []).filter((v: any) => v.trackByWeight);

  // Note: source-lot picker was removed here per operator spec. Lots are
  // only meaningful for the customer's estimate/invoice FIFO pricing —
  // vendor allocations don't need to be lot-tagged. Backend still accepts
  // sourceLotId (kept for backfills and the customer-side draw math),
  // but the form no longer asks for it.
  const save = useMutation({
    mutationFn: () => Api.vendorAdvances.allocate({
      vendorId: Number(vendorId), variantId: Number(variantId),
      weight: Number(weight), note: note || undefined,
    }),
    onSuccess: () => {
      toast.success(`Allocated ${Number(weight).toFixed(3)} g.`);
      onSaved(); onClose();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const canSubmit = vendorId && variantId && Number(weight) > 0 && !save.isPending;

  return (
    <Dialog open={open} onClose={onClose} size="md"
      title="Allocate Advance Metal"
      description="Debits main stock and credits the vendor's advance balance."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!canSubmit}>{save.isPending && <Spinner />} Allocate</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Vendor" required>
          <SearchableSelect
            value={vendorId}
            placeholder="— Pick vendor —"
            onChange={(v) => setVendorId(v ? Number(v) : '')}
            options={(vendorsQ.data ?? []).map((v: any) => ({
              value: v.id, label: `${v.vendorCode} · ${v.vendorName}`, keywords: v.vendorName,
            }))}
          />
        </Field>
        <Field label="Material variant" required hint="Must be weight-tracked (e.g. silver)">
          <SearchableSelect
            value={variantId}
            placeholder={weightTrackedVariants.length === 0 ? '— No weight-tracked variants —' : '— Pick variant —'}
            onChange={(v) => setVariantId(v ? Number(v) : '')}
            options={weightTrackedVariants.map((v: any) => ({
              value: v.id,
              label: `${v.variantCode} · ${v.variantName} · ${Number(v.stockWeight).toFixed(3)} g in stock`,
              keywords: `${v.materialName} ${v.variantName}`,
            }))}
          />
        </Field>
        <Field label="Weight (g)" required>
          <Input type="number" step="0.001" min="0" value={weight}
            onChange={(e) => setWeight(e.target.value)} placeholder="0.000" />
        </Field>
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. lump for upcoming chocker batch" />
        </Field>
      </div>
    </Dialog>
  );
}

function ReturnDialog({ ctx, onClose, onSaved }: {
  ctx: { vendorId: number; variantId: number; vendorName: string; variantName: string; balance: number } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [weight, setWeight] = React.useState('');
  const [note, setNote] = React.useState('');

  React.useEffect(() => {
    if (ctx) { setWeight(''); setNote(''); }
  }, [ctx]);

  const save = useMutation({
    mutationFn: () => Api.vendorAdvances.returnFromVendor({
      vendorId: ctx!.vendorId, variantId: ctx!.variantId,
      weight: Number(weight), note: note || undefined,
    }),
    onSuccess: () => {
      toast.success(`Returned ${Number(weight).toFixed(3)} g back to stock.`);
      onSaved(); onClose();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  if (!ctx) return null;
  const wt = Number(weight || 0);
  const canSubmit = wt > 0 && wt <= ctx.balance && !save.isPending;

  return (
    <Dialog open={!!ctx} onClose={onClose} size="md"
      title={`Return metal — ${ctx.vendorName}`}
      description={`Current balance: ${ctx.balance.toFixed(3)} g of ${ctx.variantName}. Returns reduce the vendor's advance and add the weight back to main stock.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!canSubmit}>{save.isPending && <Spinner />} Record return</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Weight returned (g)" required hint={`Max ${ctx.balance.toFixed(3)} g`}>
          <Input type="number" step="0.001" min="0" max={ctx.balance} value={weight}
            onChange={(e) => setWeight(e.target.value)} placeholder="0.000" />
        </Field>
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. job complete, leftover returned" />
        </Field>
      </div>
    </Dialog>
  );
}
