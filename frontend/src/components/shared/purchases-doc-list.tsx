'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { Api } from '@/lib/api';
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
  BILLED:    'bg-warning/15 text-warning',
};

export function PurchasesDocList({
  type, title, description, newHref,
}: {
  type: 'PURCHASE_ORDER' | 'BILL' | 'VENDOR_CREDIT' | 'EXPENSE';
  title: string;
  description: string;
  newHref?: string;
}) {
  const [search, setSearch] = React.useState('');
  const { fy } = useFiscalYear();
  const q = useQuery<any[]>({
    queryKey: ['bills', { type, search, fy: fy.startYear }],
    queryFn: () => Api.purchases.bills({
      type,
      search: search || undefined,
      fromDate: fy.start,
      toDate: fy.end,
    }),
  });
  return (
    <div className="space-y-4">
      <PageHeader
        title={title}
        description={description}
        actions={
          <Link href={newHref ?? `/purchases/new?type=${type}`}>
            <Button><Plus className="size-4" /> New</Button>
          </Link>
        }
      />
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Number / vendor" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Spinner /> Loading...
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Number</th>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Vendor</th>
                  <th className="px-4 py-2">Vendor Ref</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2 text-right">Total</th>
                  <th className="px-4 py-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {(q.data ?? []).map((b) => (
                  <tr key={b.id} className="border-t border-border hover:bg-secondary/20">
                    <td className="px-4 py-2 font-semibold">
                      <Link href={`/purchases/bills/${b.id}`} className="text-info hover:underline">
                        {b.billNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-xs">{new Date(b.billDate).toLocaleDateString('en-IN')}</td>
                    <td className="px-4 py-2">{b.vendorName}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{b.vendorRefNumber ?? '—'}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_BADGE[b.status] ?? STATUS_BADGE.DRAFT}`}>
                        {b.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums">
                      ₹ {Number(b.totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-warning">
                      ₹ {Number(b.balanceAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
                {(q.data ?? []).length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">Nothing here yet.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
