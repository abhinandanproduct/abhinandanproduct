'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Ban, Printer, Trash2, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { useFiscalYear } from '@/lib/fiscal-year';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { SortableTh, useTableSort } from './sortable-table';

const STATUS_BADGE: Record<string, string> = {
  DRAFT:     'bg-secondary text-muted-foreground',
  ISSUED:    'bg-info/15 text-info',
  PAID:      'bg-success/15 text-success',
  CANCELLED: 'bg-destructive/15 text-destructive',
  INVOICED:  'bg-warning/15 text-warning',
};

// Silver-side status for estimates, derived from covered-by-invoice grams.
const SILVER_BADGE: Record<string, string> = {
  OPEN:    'bg-warning/15 text-warning',
  PARTIAL: 'bg-info/15 text-info',
  CLOSED:  'bg-success/15 text-success',
};

/**
 * Reusable list view for any Invoice type (Quote / Sales Order / Tax Invoice /
 * Delivery Challan / Credit Note). Same shape, different lens — the type
 * filter narrows what shows up and the "New" link carries the type into the
 * create form via ?type=.
 *
 * Each row has per-row actions (Print + Cancel) — Cancel is hidden once the
 * row is already CANCELLED. Delete-style hard-delete isn't exposed here
 * because cancel preserves the document number sequence; full delete would
 * leave gaps. If the operator needs hard delete the detail page still has it.
 */
export function BillingDocList({
  type, title, description, newHref,
}: {
  type: string;
  title: string;
  description: string;
  newHref?: string;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = React.useState('');
  const { fy } = useFiscalYear();
  const q = useQuery<any[]>({
    queryKey: ['invoices', { type, search, fy: fy.startYear }],
    queryFn: () => Api.billing.invoices({
      type,
      search: search || undefined,
      fromDate: fy.start,
      toDate: fy.end,
    }),
  });

  const cancel = useMutation({
    mutationFn: (id: number) => Api.billing.cancelInvoice(id),
    onSuccess: () => {
      toast.success('Cancelled.');
      qc.invalidateQueries({ queryKey: ['invoices'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });
  // Hard delete — testing only. Cascades items/charges/allocations and
  // unwinds the AR balance. Remove this once test data is clean.
  const remove = useMutation({
    mutationFn: (id: number) => Api.billing.deleteInvoice(id),
    onSuccess: () => {
      toast.success('Deleted.');
      qc.invalidateQueries({ queryKey: ['invoices'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });
  // Estimates only — collapses all lines into a single-row TEMP_INVOICE
  // and jumps the operator to its detail page. Prints as a regular
  // invoice; the TEMP marker is software-only.
  const genTemp = useMutation({
    mutationFn: (id: number) => Api.billing.generateTempInvoice(id),
    onSuccess: (inv) => {
      toast.success(`Temp invoice ${inv.invoiceNumber} generated.`);
      qc.invalidateQueries({ queryKey: ['invoices'] });
      window.open(Api.billing.invoicePdfUrl(inv.id), '_blank');
    },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const showTempAction = type === 'QUOTE' || type === 'ESTIMATE';
  const isEstimate     = type === 'QUOTE' || type === 'ESTIMATE';

  // Sort by the invoice date ascending by default (matches the ordering the
  // backend now returns; clickable headers let the operator flip any column).
  const { sorted, sortKey, sortDir, toggle } = useTableSort<any>(
    q.data,
    'invoiceDate',
    'asc',
    {
      // Total + Balance come off the wire as strings — pull them as numbers
      // so "1,97,871.00" doesn't sort lexicographically before "60,386.00".
      totalAmount: (r) => Number(r.totalAmount),
      balanceAmount: (r) => Number(r.balanceAmount),
      // Estimate-only silver columns lands in summary — surface them for
      // sorting on the estimate list.
      silverRequiredG:  (r) => Number(r.summary?.silverRequiredG ?? 0),
      silverAllocatedG: (r) => Number(r.summary?.silverAllocatedG ?? 0),
      silverStatus:     (r) => r.summary?.silverStatus ?? '',
    },
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={title}
        description={description}
        actions={
          <Link href={newHref ?? `/billing/invoices/new?type=${type}`}>
            <Button><Plus className="size-4" /> New</Button>
          </Link>
        }
      />

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Number / customer" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <Card>
        <CardContent className="p-0">
          {q.isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Spinner /> Loading...
            </div>
          ) : (
            <div className="overflow-x-auto">
            <table className="w-full text-sm" style={isEstimate ? { minWidth: 1200 } : undefined}>
              <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
                <tr>
                  <SortableTh label="Number"   sortKey="invoiceNumber"  currentKey={sortKey} currentDir={sortDir} onToggle={toggle} />
                  <SortableTh label="Date"     sortKey="invoiceDate"    currentKey={sortKey} currentDir={sortDir} onToggle={toggle} />
                  <SortableTh label="Customer" sortKey="billToName"     currentKey={sortKey} currentDir={sortDir} onToggle={toggle} />
                  <SortableTh label="Status"   sortKey="status"         currentKey={sortKey} currentDir={sortDir} onToggle={toggle} />
                  {isEstimate && (
                    <>
                      <SortableTh label="Silver Req.g" sortKey="silverRequiredG"  currentKey={sortKey} currentDir={sortDir} onToggle={toggle} align="right" />
                      <SortableTh label="Alloc.g"      sortKey="silverAllocatedG" currentKey={sortKey} currentDir={sortDir} onToggle={toggle} align="right" />
                      <SortableTh label="Silver"       sortKey="silverStatus"     currentKey={sortKey} currentDir={sortDir} onToggle={toggle} />
                    </>
                  )}
                  <SortableTh label="Total"    sortKey="totalAmount"    currentKey={sortKey} currentDir={sortDir} onToggle={toggle} align="right" />
                  <SortableTh label="Balance"  sortKey="balanceAmount"  currentKey={sortKey} currentDir={sortDir} onToggle={toggle} align="right" />
                  <th className="px-4 py-2 text-right whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((inv) => (
                  <tr key={inv.id} className="border-t border-border hover:bg-secondary/20">
                    <td className="px-4 py-2 font-semibold tracking-tight">
                      <Link href={`/billing/invoices/${inv.id}`} className="text-info hover:underline">
                        {inv.invoiceNumber}
                      </Link>
                      {inv.type === 'TEMP_INVOICE' && (
                        <span className="ml-2 rounded bg-warning/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-warning ring-1 ring-warning/30"
                          title="Software-only marker — the PDF prints as a regular invoice">
                          TEMP
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs">{new Date(inv.invoiceDate).toLocaleDateString('en-IN')}</td>
                    <td className="px-4 py-2 max-w-[200px] truncate" title={inv.billToName}>{inv.billToName}</td>
                    <td className="px-4 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_BADGE[inv.status] ?? STATUS_BADGE.DRAFT}`}>
                        {inv.status}
                      </span>
                    </td>
                    {isEstimate && (
                      <>
                        <td className="px-4 py-2 text-right tabular-nums text-xs">
                          {Number(inv.summary?.silverRequiredG ?? 0).toFixed(3)}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-xs">
                          {Number(inv.summary?.silverAllocatedG ?? 0).toFixed(3)}
                        </td>
                        <td className="px-4 py-2">
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${SILVER_BADGE[inv.summary?.silverStatus ?? 'OPEN']}`}>
                            {inv.summary?.silverStatus ?? 'OPEN'}
                          </span>
                        </td>
                      </>
                    )}
                    <td className="px-4 py-2 text-right font-medium tabular-nums">
                      ₹ {Number(inv.totalAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-warning">
                      ₹ {Number(inv.balanceAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-1">
                        {showTempAction && inv.status !== 'CANCELLED' && (
                          <Button variant="outline" size="sm" className="h-8 px-2 text-xs"
                            title="Consolidate all lines into a single-row Temp Invoice (prints as regular invoice)"
                            disabled={genTemp.isPending}
                            onClick={() => {
                              if (confirm(`Generate temp invoice from ${inv.invoiceNumber}?\n\nAll line items will be summed into ONE consolidated silver row. Prints as a regular invoice; the TEMP marker is software-only.`)) {
                                genTemp.mutate(inv.id);
                              }
                            }}>
                            <FileText className="size-3.5" /> Temp
                          </Button>
                        )}
                        <Button variant="outline" size="icon" title="Print"
                          onClick={() => window.open(Api.billing.invoicePdfUrl(inv.id), '_blank')}>
                          <Printer className="size-4" />
                        </Button>
                        {inv.status !== 'CANCELLED' && (
                          <Button variant="outline" size="icon" className="text-warning hover:bg-warning/10"
                            title="Cancel (status → CANCELLED, keeps row)"
                            onClick={() => {
                              if (confirm(`Cancel ${inv.invoiceNumber}?`)) cancel.mutate(inv.id);
                            }}>
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
                {sorted.length === 0 && (
                  <tr><td colSpan={isEstimate ? 10 : 7} className="px-4 py-12 text-center text-muted-foreground">Nothing here yet.</td></tr>
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
