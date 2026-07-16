'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/shared/field';
import { Card, CardContent } from '@/components/ui/card';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Spinner } from '@/components/ui/spinner';
import { QuickAddVendor } from '@/components/shared/quick-add-vendor';

const TITLE: Record<string, string> = {
  PURCHASE_ORDER: 'New Purchase Order',
  BILL: 'New Bill',
  VENDOR_CREDIT: 'New Debit Note',
  EXPENSE: 'New Expense',
};

type LineRow = {
  _k: number;
  description: string;
  hsnCode: string;
  quantity: string;
  weightG: string;
  rate: string;
};

const newRow = (): LineRow => ({
  _k: Math.random(),
  description: '',
  hsnCode: '',
  quantity: '1',
  weightG: '',
  rate: '',
});

export default function NewPurchaseDocPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const type = (sp.get('type') as 'PURCHASE_ORDER' | 'BILL' | 'VENDOR_CREDIT' | 'EXPENSE') || 'BILL';

  const [vendorId, setVendorId] = React.useState<number | ''>('');
  const [billDate, setBillDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [vendorRef, setVendorRef] = React.useState('');
  const [gstPercent, setGstPercent] = React.useState('18');
  const [interState, setInterState] = React.useState(false);
  const [category, setCategory] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [lines, setLines] = React.useState<LineRow[]>([newRow()]);

  const vendorsQ = useQuery<any[]>({ queryKey: ['vendors-all'], queryFn: () => Api.vendors.list() });

  const totals = React.useMemo(() => {
    const sub = lines.reduce((s, l) => s + Number(l.quantity || 0) * Number(l.rate || 0), 0);
    const gst = sub * (Number(gstPercent || 0) / 100);
    const cgst = !interState ? gst / 2 : 0;
    const sgst = !interState ? gst - cgst : 0;
    const igst = interState ? gst : 0;
    const pre = sub + cgst + sgst + igst;
    const total = Math.round(pre);
    return { sub, cgst, sgst, igst, total };
  }, [lines, gstPercent, interState]);

  const create = useMutation({
    mutationFn: () => {
      if (!vendorId) throw new Error('Pick a vendor.');
      const cleanLines = lines
        .filter((l) => Number(l.quantity) > 0 && Number(l.rate) >= 0)
        .map((l) => ({
          description: l.description || 'Item',
          hsnCode: l.hsnCode || undefined,
          quantity: Number(l.quantity),
          weightG: l.weightG ? Number(l.weightG) : undefined,
          rate: Number(l.rate),
        }));
      if (!cleanLines.length) throw new Error('Add at least one line.');
      return Api.purchases.createBill({
        type,
        vendorId: Number(vendorId),
        billDate,
        vendorRefNumber: vendorRef || undefined,
        gstPercent: gstPercent ? Number(gstPercent) : undefined,
        isInterState: interState,
        category: category || undefined,
        lines: cleanLines,
        notes: notes || undefined,
      });
    },
    onSuccess: (b: any) => {
      toast.success(`${b.billNumber} created.`);
      router.push(`/purchases/bills/${b.id}`);
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title={TITLE[type]}
        description="Record a transaction with a vendor — captures GST and feeds the vendor ledger."
        back={true}
        actions={
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending && <Spinner className="text-primary-foreground" />} Save
          </Button>
        }
      />

      <Card>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 md:grid-cols-4">
          <Field label="Vendor *">
            <div className="flex items-center gap-1">
              <div className="flex-1">
                <SearchableSelect
                  value={vendorId === '' ? '' : String(vendorId)}
                  onChange={(v) => setVendorId(v === '' ? '' : Number(v))}
                  placeholder="— pick vendor —"
                  options={(vendorsQ.data ?? []).map((v: any) => ({
                    value: v.id,
                    label: v.vendorName,
                    subtitle: v.vendorCode,
                  }))}
                />
              </div>
              <QuickAddVendor onCreated={(id) => setVendorId(id)} />
            </div>
          </Field>
          <Field label="Date">
            <Input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} />
          </Field>
          <Field label="Vendor Ref #">
            <Input value={vendorRef} onChange={(e) => setVendorRef(e.target.value)} placeholder="Their invoice number" />
          </Field>
          {type === 'EXPENSE' ? (
            <Field label="Category">
              <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Rent / Electricity / etc." />
            </Field>
          ) : (
            <Field label="GST %">
              <Input type="number" step="0.01" value={gstPercent} onChange={(e) => setGstPercent(e.target.value)} />
            </Field>
          )}
          <Field label="Tax mode" className="col-span-2">
            <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={interState ? 'IGST' : 'CGST_SGST'}
              onChange={(e) => setInterState(e.target.value === 'IGST')}>
              <option value="CGST_SGST">CGST + SGST (intra-state)</option>
              <option value="IGST">IGST (inter-state)</option>
            </select>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="table-scroll">
            <table className="w-full text-sm">
              <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-2 py-2">#</th>
                  <th className="px-2 py-2">Description</th>
                  <th className="px-2 py-2">HSN</th>
                  <th className="px-2 py-2 text-right">Qty</th>
                  <th className="px-2 py-2 text-right">Wt (g)</th>
                  <th className="px-2 py-2 text-right">Rate</th>
                  <th className="px-2 py-2 text-right">Amount</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const amt = Number(l.quantity || 0) * Number(l.rate || 0);
                  return (
                    <tr key={l._k} className="border-t border-border">
                      <td className="px-2 py-2 text-xs text-muted-foreground">{i + 1}</td>
                      <td className="px-2 py-2 w-72">
                        <Input value={l.description}
                          onChange={(e) => setLines((rs) => rs.map((r, idx) => idx === i ? { ...r, description: e.target.value } : r))} />
                      </td>
                      <td className="px-2 py-2 w-20">
                        <Input value={l.hsnCode}
                          onChange={(e) => setLines((rs) => rs.map((r, idx) => idx === i ? { ...r, hsnCode: e.target.value } : r))} />
                      </td>
                      <td className="px-2 py-2 w-20">
                        <Input type="number" step="0.001" value={l.quantity}
                          onChange={(e) => setLines((rs) => rs.map((r, idx) => idx === i ? { ...r, quantity: e.target.value } : r))}
                          className="text-right" />
                      </td>
                      <td className="px-2 py-2 w-24">
                        <Input type="number" step="0.001" value={l.weightG}
                          onChange={(e) => setLines((rs) => rs.map((r, idx) => idx === i ? { ...r, weightG: e.target.value } : r))}
                          className="text-right" />
                      </td>
                      <td className="px-2 py-2 w-24">
                        <Input type="number" step="0.01" value={l.rate}
                          onChange={(e) => setLines((rs) => rs.map((r, idx) => idx === i ? { ...r, rate: e.target.value } : r))}
                          className="text-right" />
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums font-medium">
                        ₹ {amt.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-2 py-2">
                        <Button type="button" variant="outline" size="icon" className="text-destructive"
                          onClick={() => setLines((rs) => rs.filter((_, idx) => idx !== i))}>
                          <Trash2 className="size-4" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-border p-2">
            <Button variant="outline" size="sm" onClick={() => setLines((rs) => [...rs, newRow()])}>
              <Plus className="size-4" /> Add row
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <Field label="Notes">
              <textarea
                className="min-h-[80px] w-full rounded-md border border-input bg-background p-2 text-sm"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </Field>
            <div className="ml-auto w-full max-w-xs space-y-1 text-sm">
              <Row label="Subtotal" value={totals.sub} />
              {interState
                ? <Row label={`IGST @ ${gstPercent}%`} value={totals.igst} />
                : <>
                    <Row label={`CGST @ ${(Number(gstPercent || 0) / 2).toFixed(2)}%`} value={totals.cgst} />
                    <Row label={`SGST @ ${(Number(gstPercent || 0) / 2).toFixed(2)}%`} value={totals.sgst} />
                  </>}
              <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                <span className="font-semibold">Total</span>
                <span className="text-lg font-bold tabular-nums">
                  ₹ {totals.total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">₹ {Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
    </div>
  );
}
