'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, FileText, Search, Ban, Printer, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { useFiscalYear } from '@/lib/fiscal-year';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';

const STATUS_BADGE: Record<string, string> = {
  DRAFT:     'bg-secondary text-muted-foreground',
  ISSUED:    'bg-info/15 text-info',
  PAID:      'bg-success/15 text-success',
  CANCELLED: 'bg-destructive/15 text-destructive',
};

export default function InvoicesPage() {
  const qc = useQueryClient();
  const [search, setSearch] = React.useState('');
  const { fy } = useFiscalYear();
  // This page is strictly TAX_INVOICE. Estimates live at /billing/quotes,
  // temp invoices at /billing/temp-invoices, delivery challans at
  // /billing/challans — mixing them here made the list harder to scan.
  const q = useQuery<any[]>({
    queryKey: ['invoices', { search, fy: fy.startYear }],
    queryFn: () => Api.billing.invoices({
      type: 'TAX_INVOICE',
      search: search || undefined,
      fromDate: fy.start,
      toDate: fy.end,
    }),
  });
  const cancel = useMutation({
    mutationFn: (id: number) => Api.billing.cancelInvoice(id),
    onSuccess: () => { toast.success('Cancelled.'); qc.invalidateQueries({ queryKey: ['invoices'] }); },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => Api.billing.deleteInvoice(id),
    onSuccess: () => { toast.success('Deleted.'); qc.invalidateQueries({ queryKey: ['invoices'] }); },
    onError: (e) => toast.error(getApiError(e).message),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Invoices"
        description="Tax invoices, estimates, and delivery challans."
        actions={
          <Link href="/billing/invoices/new">
            <Button><Plus className="size-4" /> New Invoice</Button>
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Invoice no / customer" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

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
                  <th className="px-4 py-2">Number</th>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Customer</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2 text-right">Pcs</th>
                  <th className="px-4 py-2 text-right">Weight&nbsp;(g)</th>
                  <th className="px-4 py-2 text-right">Total</th>
                  <th className="px-4 py-2 text-right">Balance</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(q.data ?? []).map((inv) => (
                  <tr key={inv.id} className="border-t border-border hover:bg-secondary/20">
                    <td className="px-4 py-2 font-semibold">
                      <Link href={`/billing/invoices/${inv.id}`} className="text-info hover:underline">
                        {inv.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-xs">{new Date(inv.invoiceDate).toLocaleDateString('en-IN')}</td>
                    <td className="px-4 py-2">{inv.billToName}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_BADGE[inv.status]}`}>
                        {inv.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-xs">
                      {(inv as any).summary?.totalPieces ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-xs">
                      {(inv as any).summary?.totalWeightG != null
                        ? Number((inv as any).summary.totalWeightG).toLocaleString('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
                        : '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums">
                      ₹ {Number(inv.totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-warning">
                      ₹ {Number(inv.balanceAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-1">
                        <Button variant="outline" size="icon" title="Print"
                          onClick={() => window.open(Api.billing.invoicePdfUrl(inv.id), '_blank')}>
                          <Printer className="size-4" />
                        </Button>
                        {inv.status !== 'CANCELLED' && (
                          <Button variant="outline" size="icon" className="text-warning hover:bg-warning/10"
                            title="Cancel (status → CANCELLED, keeps row)"
                            onClick={() => { if (confirm(`Cancel ${inv.invoiceNumber}?`)) cancel.mutate(inv.id); }}>
                            <Ban className="size-4" />
                          </Button>
                        )}
                        <Button variant="outline" size="icon" className="text-destructive hover:bg-destructive/10"
                          title="Delete (hard remove — testing only)"
                          onClick={() => {
                            if (confirm(`Permanently delete ${inv.invoiceNumber}?\n\nThis removes the row + all line items, charges, allocations. AR balance is unwound.`)) {
                              remove.mutate(inv.id);
                            }
                          }}>
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {(q.data ?? []).length === 0 && (
                  <tr><td colSpan={9} className="px-4 py-12 text-center text-muted-foreground">No invoices yet.</td></tr>
                )}
              </tbody>
            </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
