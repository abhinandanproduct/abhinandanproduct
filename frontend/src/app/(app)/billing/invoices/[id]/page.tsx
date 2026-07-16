'use client';

import * as React from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Printer, Ban, ArrowRight, FileText, Pencil } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';

const TYPE_LABEL: Record<string, string> = {
  TAX_INVOICE: 'Tax Invoice',
  ESTIMATE: 'Estimate',
  DELIVERY_CHALLAN: 'Delivery Challan',
};

export default function InvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const id = Number(params.id);
  const q = useQuery<any>({
    queryKey: ['invoice', id],
    queryFn: () => Api.billing.invoice(id),
    enabled: !!id,
  });

  const cancel = useMutation({
    mutationFn: () => Api.billing.cancelInvoice(id),
    onSuccess: () => {
      toast.success('Invoice cancelled.');
      qc.invalidateQueries({ queryKey: ['invoice', id] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const convert = useMutation({
    mutationFn: () => Api.billing.convertEstimate(id),
    onSuccess: (inv: any) => {
      toast.success(`Converted to ${inv.invoiceNumber}.`);
      router.push(`/billing/invoices/${inv.id}`);
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  if (q.isLoading) {
    return <div className="flex items-center justify-center py-24 text-muted-foreground"><Spinner /> Loading...</div>;
  }
  if (!q.data) return null;
  const inv = q.data;
  const pdfUrl = Api.billing.invoicePdfUrl(id);

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${inv.invoiceNumber} · ${TYPE_LABEL[inv.type]}`}
        description={`${inv.billToName} · ${new Date(inv.invoiceDate).toLocaleDateString('en-IN')} · ${inv.status}`}
        // router.back() preserves the LIST's scroll position — pushing
        // to /billing/invoices as a fresh navigation would reset it.
        // Falls back to a no-op when there's no history (unlikely but
        // safe — sidebar link always works).
        back={true}
        actions={
          <div className="flex gap-2">
            {/* Edit — only when nothing has been paid yet AND the invoice
                isn't cancelled. Backend enforces the same rule; disabling
                here just prevents an obvious dead-end click. */}
            {inv.status !== 'CANCELLED' && Number(inv.paidAmount) === 0 && (
              <Link href={`/billing/invoices/new?id=${inv.id}`}>
                <Button variant="outline">
                  <Pencil className="size-4" /> Edit
                </Button>
              </Link>
            )}
            {inv.type === 'ESTIMATE' && !inv.convertedFromId && inv.status === 'ISSUED' && (
              <Button onClick={() => convert.mutate()} disabled={convert.isPending}>
                <ArrowRight className="size-4" /> Convert to Tax Invoice
              </Button>
            )}
            <Button variant="outline" onClick={() => window.open(pdfUrl, '_blank')}>
              <Printer className="size-4" /> Print
            </Button>
            {inv.status !== 'CANCELLED' && (
              <Button variant="outline" className="text-destructive" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                <Ban className="size-4" /> Cancel
              </Button>
            )}
          </div>
        }
      />

      <Card>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 md:grid-cols-4">
          <Info label="Customer" value={inv.billToName} />
          <Info label="GSTIN" value={inv.billToGstin ?? '—'} />
          <Info label="Place of Supply" value={inv.placeOfSupply ?? '—'} />
          <Info label="Tax Mode" value={inv.isInterState ? `IGST ${inv.gstPercent}%` : `CGST + SGST ${inv.gstPercent}%`} />
          <Info label="Silver /g" value={`₹ ${Number(inv.silverRatePerG).toFixed(2)}`} />
          <Info label="Making /g" value={`₹ ${Number(inv.makingRatePerG).toFixed(2)}`} />
          <Info label="Subtotal" value={`₹ ${Number(inv.subtotal).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`} />
          <Info label="Total" value={`₹ ${Number(inv.totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`} className="font-bold text-lg" />
          <Info label="Paid" value={`₹ ${Number(inv.paidAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`} className="text-success" />
          <Info label="Balance" value={`₹ ${Number(inv.balanceAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`} className="text-warning font-semibold" />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="table-scroll">
          <table className="w-full text-sm">
            <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2">#</th>
                <th className="px-4 py-2">Item</th>
                <th className="px-4 py-2">Description</th>
                <th className="px-4 py-2">HSN</th>
                <th className="px-4 py-2 text-right">Qty</th>
                <th className="px-4 py-2 text-right">Wt/pc (g)</th>
                <th className="px-4 py-2 text-right">Silver /g</th>
                <th className="px-4 py-2 text-right">Making /g</th>
                <th className="px-4 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {inv.items.map((it: any, i: number) => (
                <tr key={it.id} className="border-t border-border">
                  <td className="px-4 py-2">{i + 1}</td>
                  <td className="px-4 py-2 font-semibold">{it.itemNumber ?? '—'}</td>
                  <td className="px-4 py-2">{it.description}</td>
                  <td className="px-4 py-2 text-xs">{it.hsnCode}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{it.quantity}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{Number(it.weightG).toFixed(3)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{Number(it.silverRatePerG).toFixed(2)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{Number(it.makingRatePerG).toFixed(2)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium">
                    ₹ {Number(it.lineAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
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
