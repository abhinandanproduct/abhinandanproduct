'use client';

import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Coins, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/shared/field';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';

/**
 * Silver Lots — the FIFO metal-inventory system that feeds invoicing rates.
 * See project_erp_roadmap_2026-07 for background.
 */
export default function SilverLotsPage() {
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [filterSource, setFilterSource] = React.useState<'ALL' | 'BULLION' | 'CUSTOMER_ADVANCE'>('ALL');
  const [hasRemaining, setHasRemaining] = React.useState(true);

  const lotsQ = useQuery({
    queryKey: ['silver-lots', filterSource, hasRemaining],
    queryFn: () => Api.silverLots.list({
      source: filterSource === 'ALL' ? undefined : filterSource,
      hasRemaining,
    }),
  });
  const lots = lotsQ.data ?? [];

  const removeLot = useMutation({
    mutationFn: (id: number) => Api.silverLots.delete(id),
    onSuccess: (r) => { toast.success(`Deleted ${r.lotNumber}.`); qc.invalidateQueries({ queryKey: ['silver-lots'] }); },
    onError: (e) => toast.error(getApiError(e).message),
  });

  return (
    <div>
      <PageHeader
        title="Silver Lots"
        subtitle="Every kg of silver we hold — bullion purchases + customer advances. Invoices consume oldest lot first (FIFO). Fix-rate lots keep the receipt rate; unfix uses spot at invoice time."
        actions={<Button onClick={() => setDialogOpen(true)}><Plus className="size-4" /> New Lot</Button>}
      />

      <Card className="mb-4">
        <CardContent className="flex flex-col gap-3 p-3 sm:flex-row sm:flex-wrap sm:items-center sm:p-4">
          <Field label="Source">
            <Select value={filterSource} onChange={(e) => setFilterSource(e.target.value as any)}>
              <option value="ALL">All</option>
              <option value="BULLION">Bullion (purchased)</option>
              <option value="CUSTOMER_ADVANCE">Customer Advance</option>
            </Select>
          </Field>
          <label className="flex items-center gap-2 text-sm sm:mt-6">
            <input type="checkbox" className="accent-gold size-4" checked={hasRemaining} onChange={(e) => setHasRemaining(e.target.checked)} />
            Only lots with remaining balance
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-3 sm:p-4">
          {lotsQ.isLoading ? (
            <div className="flex justify-center py-12 text-text-faint"><Spinner /> Loading…</div>
          ) : lots.length === 0 ? (
            <div className="py-12 text-center text-text-faint">
              <Coins className="mx-auto mb-2 size-8 opacity-40" />
              No lots match these filters.
            </div>
          ) : (
            <div className="space-y-2">
              {lots.map((lot: any) => {
                const consumed = Number(lot.receivedWeightG) - Number(lot.remainingWeightG);
                const pct = Math.min(100, Math.round((consumed / Number(lot.receivedWeightG)) * 100));
                const party = lot.source === 'BULLION'
                  ? `${lot.vendor?.vendorCode ?? '?'} · ${lot.vendor?.vendorName ?? '?'}`
                  : `${lot.customer?.customerCode ?? '?'} · ${lot.customer?.customerName ?? '?'}`;
                return (
                  <div key={lot.id} className="rounded-lg border border-border bg-card p-3 sm:p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-base font-semibold">
                          {lot.lotNumber}
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            {lot.source === 'BULLION' ? 'Bullion' : 'Customer Advance'}
                          </Badge>
                          <Badge variant={lot.rateType === 'FIX' ? 'info' : 'secondary'} className="ml-1 text-[10px]">
                            {lot.rateType}
                          </Badge>
                        </div>
                        <div className="text-xs text-text-faint">
                          {party} · {lot.variant?.variantCode} · received {new Date(lot.receivedAt).toLocaleDateString('en-IN')}
                          {lot.billNumber ? ` · bill ${lot.billNumber}` : ''}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-semibold tabular-nums">
                          {Number(lot.remainingWeightG).toFixed(3)} <span className="text-xs text-text-faint">/ {Number(lot.receivedWeightG).toFixed(3)} g</span>
                        </div>
                        <div className="text-xs text-text-faint">
                          @ ₹{Number(lot.ratePerG).toFixed(2)}/g
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                      <div
                        className={`h-full ${pct >= 100 ? 'bg-warning' : 'bg-gold'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10px] text-text-faint">
                      <span>{consumed.toFixed(3)} g consumed ({pct}%)</span>
                      {/* Delete allowed only when nothing has drawn from
                          the lot AND no vendor holds any of it. Backend
                          re-checks the same guard. */}
                      {consumed <= 0.0005 && (
                        <Button
                          variant="outline" size="icon" title="Delete lot (only if untouched)"
                          className="h-6 w-6 text-destructive hover:bg-destructive/10"
                          onClick={() => {
                            if (confirm(`Delete ${lot.lotNumber}?\n\nThis is permanent. Only untouched lots (no draws, no vendor holdings) can be deleted.`)) {
                              removeLot.mutate(lot.id);
                            }
                          }}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <NewLotDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}

function NewLotDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [source, setSource] = React.useState<'BULLION' | 'CUSTOMER_ADVANCE'>('BULLION');
  const [rateType, setRateType] = React.useState<'FIX' | 'UNFIX'>('FIX');
  const [variantId, setVariantId] = React.useState<number | ''>('');
  const [vendorId, setVendorId] = React.useState<number | ''>('');
  const [customerId, setCustomerId] = React.useState<number | ''>('');
  const [receivedAt, setReceivedAt] = React.useState(new Date().toISOString().slice(0, 10));
  const [weightG, setWeightG] = React.useState('');
  const [ratePerG, setRatePerG] = React.useState('');
  const [billNumber, setBillNumber] = React.useState('');
  const [notes, setNotes] = React.useState('');

  const variantsQ = useQuery({
    queryKey: ['variants-silver'],
    queryFn: () => Api.materials.variants({ status: 'ACTIVE' }),
    enabled: open,
  });
  const vendorsQ = useQuery({ queryKey: ['vendors-list'], queryFn: () => Api.vendors.list({}), enabled: open && source === 'BULLION' });
  const customersQ = useQuery({ queryKey: ['customers'], queryFn: () => Api.billing.customers(), enabled: open && source === 'CUSTOMER_ADVANCE' });

  const silverVariants = (variantsQ.data ?? []).filter((v: any) =>
    v.trackByWeight && /silver/i.test(v.materialName ?? ''),
  );

  const save = useMutation({
    mutationFn: async () => {
      if (!variantId) throw new Error('Pick a silver variant.');
      if (source === 'BULLION' && !vendorId) throw new Error('Pick a vendor for BULLION.');
      if (source === 'CUSTOMER_ADVANCE' && !customerId) throw new Error('Pick a customer for CUSTOMER_ADVANCE.');
      if (!(Number(weightG) > 0)) throw new Error('Weight must be positive.');
      if (!(Number(ratePerG) > 0)) throw new Error('Rate must be positive.');
      return Api.silverLots.create({
        source, rateType,
        variantId: Number(variantId),
        vendorId: source === 'BULLION' ? Number(vendorId) : undefined,
        customerId: source === 'CUSTOMER_ADVANCE' ? Number(customerId) : undefined,
        receivedAt,
        receivedWeightG: Number(weightG),
        ratePerG: Number(ratePerG),
        billNumber: billNumber.trim() || undefined,
        notes: notes.trim() || undefined,
      });
    },
    onSuccess: () => {
      toast.success('Silver lot created.');
      qc.invalidateQueries({ queryKey: ['silver-lots'] });
      qc.invalidateQueries({ queryKey: ['variants'] });
      onClose();
      // Reset
      setWeightG(''); setRatePerG(''); setBillNumber(''); setNotes('');
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="New Silver Lot"
      description="Every metal receipt — from a bullion supplier or a customer advance — creates a lot with its own locked-in rate."
      footer={<>
        <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending && <Spinner />} Save Lot
        </Button>
      </>}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Source">
          <Select value={source} onChange={(e) => setSource(e.target.value as any)}>
            <option value="BULLION">Bullion (purchased)</option>
            <option value="CUSTOMER_ADVANCE">Customer Advance</option>
          </Select>
        </Field>
        <Field label="Rate Type" hint="Fix locks the rate at receipt; Unfix follows spot at invoice time.">
          <Select value={rateType} onChange={(e) => setRateType(e.target.value as any)}>
            <option value="FIX">Fix</option>
            <option value="UNFIX">Unfix (market-linked)</option>
          </Select>
        </Field>
        <Field label="Silver Variant *">
          <SearchableSelect
            value={variantId === '' ? '' : String(variantId)}
            placeholder="— pick silver 999 / 93.5 —"
            onChange={(v) => setVariantId(v ? Number(v) : '')}
            options={silverVariants.map((v: any) => ({
              value: v.id,
              label: `${v.variantCode} · ${v.variantName}`,
              subtitle: v.materialName,
            }))}
          />
        </Field>
        {source === 'BULLION' ? (
          <Field label="Vendor *">
            <SearchableSelect
              value={vendorId === '' ? '' : String(vendorId)}
              placeholder="— bullion vendor —"
              onChange={(v) => setVendorId(v ? Number(v) : '')}
              options={(vendorsQ.data ?? []).map((v: any) => ({
                value: v.id, label: `${v.vendorCode} · ${v.vendorName}`,
              }))}
            />
          </Field>
        ) : (
          <Field label="Customer *">
            <SearchableSelect
              value={customerId === '' ? '' : String(customerId)}
              placeholder="— customer providing advance —"
              onChange={(v) => setCustomerId(v ? Number(v) : '')}
              options={(customersQ.data ?? []).map((c: any) => ({
                value: c.id, label: `${c.customerCode} · ${c.customerName}`,
              }))}
            />
          </Field>
        )}
        <Field label="Received Date">
          <Input type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
        </Field>
        <Field label="Weight (g) *">
          <Input type="number" step="0.001" placeholder="10000.000" value={weightG} onChange={(e) => setWeightG(e.target.value)} />
        </Field>
        <Field label="Rate ₹/g *" hint="Bookkeeping rate. Ignored for consumption on UNFIX (spot rate used).">
          <Input type="number" step="0.01" placeholder="82.50" value={ratePerG} onChange={(e) => setRatePerG(e.target.value)} />
        </Field>
        <Field label="Bill / Ref Number">
          <Input placeholder="Supplier bill or customer memo" value={billNumber} onChange={(e) => setBillNumber(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Notes">
          <Input placeholder="Optional" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
