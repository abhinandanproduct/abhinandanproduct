'use client';

import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/shared/field';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Spinner } from '@/components/ui/spinner';
import { SortableTh, useTableSort } from '@/components/shared/sortable-table';

export default function PaymentsMadePage() {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<any>({ paymentDate: new Date().toISOString().slice(0, 10), mode: 'BANK' });

  const q = useQuery<any[]>({ queryKey: ['vendor-payments'], queryFn: () => Api.purchases.payments() });
  const vendorsQ = useQuery<any[]>({ queryKey: ['vendors-all'], queryFn: () => Api.vendors.list() });
  const openBillsQ = useQuery<any[]>({
    queryKey: ['bills-open', form.vendorId],
    queryFn: () => form.vendorId
      ? Api.purchases.bills({ vendorId: form.vendorId, status: 'ISSUED' })
      : Promise.resolve([]),
    enabled: !!form.vendorId,
  });

  const { sorted, sortKey, sortDir, toggle } = useTableSort<any>(
    q.data,
    'paymentDate',
    'desc',
    {
      amount: (r) => Number(r.amount),
      vendor: (r) => r.vendor?.vendorName ?? '',
    },
  );

  const create = useMutation({
    mutationFn: () => Api.purchases.createPayment({
      vendorId: Number(form.vendorId),
      paymentDate: form.paymentDate,
      amount: Number(form.amount),
      mode: form.mode,
      reference: form.reference || undefined,
      notes: form.notes || undefined,
      allocations: (form.allocations ?? [])
        .filter((a: any) => Number(a.amount) > 0)
        .map((a: any) => ({ billId: Number(a.billId), amount: Number(a.amount) })),
    }),
    onSuccess: () => {
      toast.success('Payment recorded.');
      qc.invalidateQueries({ queryKey: ['vendor-payments'] });
      qc.invalidateQueries({ queryKey: ['bills'] });
      setOpen(false);
      setForm({ paymentDate: new Date().toISOString().slice(0, 10), mode: 'BANK' });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Payments Made"
        description="Money paid to vendors — cash / bank / UPI / cheque, with allocation to bills."
        actions={<Button onClick={() => setOpen(true)}><Plus className="size-4" /> Record Payment</Button>}
      />
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground"><Spinner /> Loading...</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
                <tr>
                  <SortableTh label="Receipt" sortKey="paymentNumber" currentKey={sortKey} currentDir={sortDir} onToggle={toggle} />
                  <SortableTh label="Date" sortKey="paymentDate" currentKey={sortKey} currentDir={sortDir} onToggle={toggle} />
                  <SortableTh label="Vendor" sortKey="vendor" currentKey={sortKey} currentDir={sortDir} onToggle={toggle} />
                  <SortableTh label="Mode" sortKey="mode" currentKey={sortKey} currentDir={sortDir} onToggle={toggle} />
                  <SortableTh label="Reference" sortKey="reference" currentKey={sortKey} currentDir={sortDir} onToggle={toggle} />
                  <SortableTh label="Amount" sortKey="amount" currentKey={sortKey} currentDir={sortDir} onToggle={toggle} align="right" />
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => (
                  <tr key={p.id} className="border-t border-border">
                    <td className="px-4 py-2 font-semibold">{p.paymentNumber}</td>
                    <td className="px-4 py-2 text-xs">{new Date(p.paymentDate).toLocaleDateString('en-IN')}</td>
                    <td className="px-4 py-2">{p.vendor?.vendorName}</td>
                    <td className="px-4 py-2 text-xs">{p.mode}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{p.reference ?? '—'}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums text-warning">
                      ₹ {Number(p.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
                {(q.data ?? []).length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">No payments recorded.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title="Record Payment"
        description="Pay a vendor and optionally allocate against specific bills."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={create.isPending}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending || !form.vendorId || !form.amount}>
              {create.isPending && <Spinner className="text-primary-foreground" />} Save
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Vendor *">
            <SearchableSelect
              value={form.vendorId ?? ''}
              onChange={(v) => setForm({ ...form, vendorId: v, allocations: [] })}
              placeholder="— pick vendor —"
              options={(vendorsQ.data ?? []).map((v: any) => ({
                value: v.id,
                label: v.vendorName,
                subtitle: v.vendorCode,
              }))}
            />
          </Field>
          <Field label="Date">
            <Input type="date" value={form.paymentDate} onChange={(e) => setForm({ ...form, paymentDate: e.target.value })} />
          </Field>
          <Field label="Amount (₹) *">
            <Input type="number" step="0.01" value={form.amount ?? ''} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>
          <Field label="Mode">
            <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
              <option value="CASH">Cash</option>
              <option value="BANK">Bank Transfer</option>
              <option value="UPI">UPI</option>
              <option value="CHEQUE">Cheque</option>
              <option value="OTHER">Other</option>
            </select>
          </Field>
          <Field label="Reference" className="col-span-2">
            <Input value={form.reference ?? ''} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </Field>
          {form.vendorId && (openBillsQ.data ?? []).length > 0 && (
            <div className="col-span-2 rounded-md border border-border p-2">
              <div className="mb-2 text-xs font-semibold text-muted-foreground">Allocate to open bills</div>
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1">Bill</th>
                    <th className="py-1 text-right">Total</th>
                    <th className="py-1 text-right">Balance</th>
                    <th className="py-1 text-right">Allocate</th>
                  </tr>
                </thead>
                <tbody>
                  {(openBillsQ.data ?? []).filter((b: any) => b.type !== 'PURCHASE_ORDER').map((b: any) => {
                    const allocs = form.allocations ?? [];
                    const cur = allocs.find((a: any) => a.billId === b.id)?.amount ?? '';
                    return (
                      <tr key={b.id} className="border-t border-border">
                        <td className="py-1 font-semibold">{b.billNumber}</td>
                        <td className="py-1 text-right tabular-nums">₹ {Number(b.totalAmount).toFixed(2)}</td>
                        <td className="py-1 text-right tabular-nums text-warning">₹ {Number(b.balanceAmount).toFixed(2)}</td>
                        <td className="py-1 text-right">
                          <Input className="h-7 w-24 text-right" type="number" step="0.01" value={cur}
                            onChange={(e) => {
                              const others = (form.allocations ?? []).filter((a: any) => a.billId !== b.id);
                              const v = e.target.value;
                              setForm({ ...form, allocations: v ? [...others, { billId: b.id, amount: v }] : others });
                            }} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Dialog>
    </div>
  );
}
