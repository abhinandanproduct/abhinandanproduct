'use client';

import * as React from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';

const TYPE_LABEL: Record<string, string> = {
  PURCHASE_ORDER: 'Purchase Order',
  BILL: 'Bill',
  VENDOR_CREDIT: 'Debit Note',
  EXPENSE: 'Expense',
};

export default function BillDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const id = Number(params.id);
  const q = useQuery<any>({
    queryKey: ['bill', id],
    queryFn: () => Api.purchases.bill(id),
    enabled: !!id,
  });
  const cancel = useMutation({
    mutationFn: () => Api.purchases.cancelBill(id),
    onSuccess: () => {
      toast.success('Cancelled.');
      qc.invalidateQueries({ queryKey: ['bill', id] });
      qc.invalidateQueries({ queryKey: ['bills'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const convertPo = useMutation({
    mutationFn: () => Api.purchases.convertPo(id),
    onSuccess: (b: any) => {
      toast.success(`Bill ${b.billNumber} created.`);
      router.push(`/purchases/bills/${b.id}`);
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  if (q.isLoading) return <div className="flex items-center justify-center py-24 text-muted-foreground"><Spinner /> Loading...</div>;
  if (!q.data) return null;
  const b = q.data;

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${b.billNumber} · ${TYPE_LABEL[b.type]}`}
        description={`${b.vendorName} · ${new Date(b.billDate).toLocaleDateString('en-IN')} · ${b.status}`}
        back={true}
        actions={
          <div className="flex gap-2">
            {b.type === 'PURCHASE_ORDER' && !b.convertedFromId && b.status === 'ISSUED' && (
              <Button onClick={() => convertPo.mutate()} disabled={convertPo.isPending}>
                <ArrowRight className="size-4" /> Convert to Bill
              </Button>
            )}
            {b.status !== 'CANCELLED' && (
              <Button variant="outline" className="text-destructive" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                <Ban className="size-4" /> Cancel
              </Button>
            )}
          </div>
        }
      />

      <Card>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 md:grid-cols-4">
          <Info label="Vendor" value={b.vendorName} />
          <Info label="GSTIN" value={b.vendorGstin ?? '—'} />
          <Info label="Vendor Ref" value={b.vendorRefNumber ?? '—'} />
          <Info label="Tax Mode" value={b.isInterState ? `IGST ${b.gstPercent}%` : `CGST+SGST ${b.gstPercent}%`} />
          <Info label="Subtotal" value={`₹ ${Number(b.subtotal).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`} />
          <Info label="Total" value={`₹ ${Number(b.totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`} className="text-lg font-bold" />
          <Info label="Paid" value={`₹ ${Number(b.paidAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`} className="text-success" />
          <Info label="Balance" value={`₹ ${Number(b.balanceAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`} className="text-warning font-semibold" />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2">#</th>
                <th className="px-4 py-2">Description</th>
                <th className="px-4 py-2">HSN</th>
                <th className="px-4 py-2 text-right">Qty</th>
                <th className="px-4 py-2 text-right">Wt (g)</th>
                <th className="px-4 py-2 text-right">Rate</th>
                <th className="px-4 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {b.items.map((it: any, i: number) => (
                <tr key={it.id} className="border-t border-border">
                  <td className="px-4 py-2">{i + 1}</td>
                  <td className="px-4 py-2">{it.description}</td>
                  <td className="px-4 py-2 text-xs">{it.hsnCode ?? '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{Number(it.quantity).toFixed(2)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{it.weightG != null ? Number(it.weightG).toFixed(3) : '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{Number(it.rate).toFixed(2)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium">
                    ₹ {Number(it.lineAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function Info({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 ${className ?? ''}`}>{value}</div>
    </div>
  );
}
