'use client';

import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, IndianRupee } from 'lucide-react';
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

export default function PaymentsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<any>({
    paymentDate: new Date().toISOString().slice(0, 10),
    mode: 'CASH',
  });

  const q = useQuery<any[]>({
    queryKey: ['payments'],
    queryFn: () => Api.billing.payments(),
  });
  const customersQ = useQuery<any[]>({
    queryKey: ['customers'],
    queryFn: () => Api.billing.customers(),
  });
  const openInvoicesQ = useQuery<any[]>({
    queryKey: ['invoices-open', form.customerId],
    queryFn: () =>
      form.customerId
        ? Api.billing.invoices({ customerId: form.customerId, status: 'ISSUED' })
        : Promise.resolve([]),
    enabled: !!form.customerId,
  });

  const create = useMutation({
    mutationFn: () =>
      Api.billing.createPayment({
        customerId: Number(form.customerId),
        paymentDate: form.paymentDate,
        amount: Number(form.amount),
        mode: form.mode,
        reference: form.reference || undefined,
        notes: form.notes || undefined,
        allocations: (form.allocations ?? [])
          .filter((a: any) => Number(a.amount) > 0)
          .map((a: any) => ({ invoiceId: Number(a.invoiceId), amount: Number(a.amount) })),
      }),
    onSuccess: () => {
      toast.success('Payment recorded.');
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['customers'] });
      setOpen(false);
      setForm({ paymentDate: new Date().toISOString().slice(0, 10), mode: 'CASH' });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Payments"
        description="Receipts from customers — cash / bank / UPI / cheque, with allocation to invoices."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus className="size-4" /> Record Payment
          </Button>
        }
      />

      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Spinner /> Loading...
            </div>
          ) : (
            <div className="table-scroll">
            <table className="w-full text-sm">
              <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Receipt</th>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Customer</th>
                  <th className="px-4 py-2">Mode</th>
                  <th className="px-4 py-2">Reference</th>
                  <th className="px-4 py-2 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {(q.data ?? []).map((p) => (
                  <tr key={p.id} className="border-t border-border">
                    <td className="px-4 py-2 font-semibold">{p.paymentNumber}</td>
                    <td className="px-4 py-2 text-xs">{new Date(p.paymentDate).toLocaleDateString('en-IN')}</td>
                    <td className="px-4 py-2">{p.customer?.customerName}</td>
                    <td className="px-4 py-2 text-xs">{p.mode}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{p.reference ?? '—'}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums text-success">
                      ₹ {Number(p.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
                {(q.data ?? []).length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">No payments recorded.</td></tr>
                )}
              </tbody>
            </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title="Record Payment"
        description="Receive money from a customer. Optionally allocate against specific invoices."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={create.isPending}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={create.isPending || !form.customerId || !form.amount}>
              {create.isPending && <Spinner className="text-primary-foreground" />} Save
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Customer *">
            <SearchableSelect
              value={form.customerId ?? ''}
              onChange={(v) => setForm({ ...form, customerId: v, allocations: [] })}
              placeholder="— pick customer —"
              options={(customersQ.data ?? []).map((c) => ({
                value: c.id,
                label: c.customerName,
                subtitle: `${c.customerCode} · Balance ₹ ${Number(c.balance).toFixed(2)}`,
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
          <Field label="Reference (cheque # / UPI ref)" className="col-span-2">
            <Input value={form.reference ?? ''} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </Field>
          {form.customerId && (openInvoicesQ.data ?? []).length > 0 && (
            <div className="col-span-2 rounded-md border border-border p-2">
              <div className="mb-2 text-xs font-semibold text-muted-foreground">
                Allocate to open invoices (optional — leave 0 to keep on-account)
              </div>
              <div className="table-scroll">
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1">Invoice</th>
                    <th className="py-1 text-right">Total</th>
                    <th className="py-1 text-right">Balance</th>
                    <th className="py-1 text-right">Allocate</th>
                  </tr>
                </thead>
                <tbody>
                  {(openInvoicesQ.data ?? []).filter((i: any) => i.type !== 'DELIVERY_CHALLAN').map((inv: any) => {
                    const allocs = form.allocations ?? [];
                    const cur = allocs.find((a: any) => a.invoiceId === inv.id)?.amount ?? '';
                    return (
                      <tr key={inv.id} className="border-t border-border">
                        <td className="py-1 font-semibold">{inv.invoiceNumber}</td>
                        <td className="py-1 text-right tabular-nums">₹ {Number(inv.totalAmount).toFixed(2)}</td>
                        <td className="py-1 text-right tabular-nums text-warning">₹ {Number(inv.balanceAmount).toFixed(2)}</td>
                        <td className="py-1 text-right">
                          <Input className="h-7 w-24 text-right" type="number" step="0.01"
                            value={cur}
                            onChange={(e) => {
                              const others = (form.allocations ?? []).filter((a: any) => a.invoiceId !== inv.id);
                              const v = e.target.value;
                              setForm({
                                ...form,
                                allocations: v ? [...others, { invoiceId: inv.id, amount: v }] : others,
                              });
                            }} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>
          )}
        </div>
      </Dialog>
    </div>
  );
}
