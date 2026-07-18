'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Ban, Printer, Trash2, FileText, Scale } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { useFiscalYear } from '@/lib/fiscal-year';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/shared/field';
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

  // Metal-invoice dialog — opens with a customer selected + their
  // OPEN/PARTIAL estimates listed with grams inputs.
  const [metalOpen, setMetalOpen] = React.useState(false);

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
          <div className="flex gap-2">
            {isEstimate && (
              <Button variant="outline" onClick={() => setMetalOpen(true)}>
                <Scale className="size-4" /> Metal Invoice
              </Button>
            )}
            <Link href={newHref ?? `/billing/invoices/new?type=${type}`}>
              <Button><Plus className="size-4" /> New</Button>
            </Link>
          </div>
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
            <div className="table-scroll">
            <table className="w-full text-sm">
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
                  <th className="px-4 py-2 text-right">Actions</th>
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
                    <td className="px-4 py-2">{inv.billToName}</td>
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

      {isEstimate && (
        <MetalInvoiceDialog
          open={metalOpen}
          estimates={(q.data ?? []).filter((e) => e.status !== 'CANCELLED' && (e.summary?.silverStatus ?? 'OPEN') !== 'CLOSED')}
          onClose={() => setMetalOpen(false)}
          onSaved={() => {
            setMetalOpen(false);
            qc.invalidateQueries({ queryKey: ['invoices'] });
          }}
        />
      )}
    </div>
  );
}

/**
 * Raise an ABN-XXXXXX tax invoice for silver received against multiple
 * estimates. Operator picks a customer (via the estimates that show up in
 * the picker), sets grams per estimate, sets silver rate + optional GST/
 * inter-state flag, saves. Backend validates:
 *   - Every estimate belongs to the same customer.
 *   - Grams per estimate ≤ that estimate's remaining silver need.
 *   - At least one gram in total.
 */
function MetalInvoiceDialog({
  open, estimates, onClose, onSaved,
}: {
  open: boolean;
  estimates: any[];
  onClose: () => void;
  onSaved: () => void;
}) {
  // Group open estimates by customer so the operator picks a customer and
  // then sees only that customer's rows. Prevents accidental cross-customer
  // allocation.
  const byCustomer = React.useMemo(() => {
    const m = new Map<number, { name: string; rows: any[] }>();
    for (const e of estimates) {
      if (!e.customerId) continue;
      const cur: { name: string; rows: any[] } = m.get(e.customerId) ?? { name: e.billToName ?? '?', rows: [] };
      cur.rows.push(e);
      m.set(e.customerId, cur);
    }
    return m;
  }, [estimates]);
  const [customerId, setCustomerId] = React.useState<number | ''>('');
  const [invoiceDate, setInvoiceDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [rate, setRate] = React.useState('');
  const [gstPct, setGstPct] = React.useState('0');
  const [interState, setInterState] = React.useState(false);
  const [rows, setRows] = React.useState<Record<number, string>>({}); // estimateId → grams str
  const [notes, setNotes] = React.useState('');

  React.useEffect(() => {
    if (!open) {
      setCustomerId(''); setInvoiceDate(new Date().toISOString().slice(0, 10));
      setRate(''); setGstPct('0'); setInterState(false); setRows({}); setNotes('');
    }
  }, [open]);

  React.useEffect(() => {
    // Reset per-estimate grams when the customer changes.
    setRows({});
  }, [customerId]);

  const shown = customerId ? (byCustomer.get(customerId as number)?.rows ?? []) : [];
  const totalGrams = shown.reduce((s, e) => s + (Number(rows[e.id] || 0) || 0), 0);

  const save = useMutation({
    mutationFn: () => Api.billing.raiseMetalInvoice({
      customerId: Number(customerId),
      invoiceDate,
      silverRatePerG: Number(rate),
      coverages: shown
        .filter((e) => Number(rows[e.id] || 0) > 0)
        .map((e) => ({ estimateId: e.id, silverAllocatedG: Number(rows[e.id]) })),
      notes: notes || undefined,
      gstPercent: Number(gstPct) || 0,
      isInterState: interState,
    }),
    onSuccess: (inv) => {
      toast.success(`${inv.invoiceNumber} raised for ${Number(totalGrams).toFixed(3)} g.`);
      onSaved();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const canSubmit =
    !!customerId && !!invoiceDate && Number(rate) > 0 && totalGrams > 0 && !save.isPending;

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Raise Metal Invoice (ABN-)"
      description="Select which estimates the silver received covers. Backend validates against each estimate's remaining requirement."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!canSubmit}>
            {save.isPending && <Spinner />} Create ABN
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Customer" required>
            <select
              className="h-10 w-full rounded-md border border-border bg-secondary/20 px-3 text-sm"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">— Pick a customer with open estimates —</option>
              {Array.from(byCustomer.entries()).map(([id, { name, rows }]) => (
                <option key={id} value={id}>{name} ({rows.length} open)</option>
              ))}
            </select>
          </Field>
          <Field label="Invoice date" required>
            <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </Field>
          <Field label="Silver rate ₹/g" required>
            <Input type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="e.g. 95.50" />
          </Field>
          <Field label="GST %">
            <Input type="number" step="0.01" value={gstPct} onChange={(e) => setGstPct(e.target.value)} />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={interState} onChange={(e) => setInterState(e.target.checked)} />
          Inter-state (IGST instead of CGST+SGST)
        </label>

        {customerId && shown.length === 0 && (
          <div className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            This customer has no OPEN/PARTIAL estimates in the current filter.
          </div>
        )}

        {customerId && shown.length > 0 && (
          <div className="table-scroll">
            <table className="w-full text-sm">
              <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Estimate</th>
                  <th className="px-3 py-2 text-right">Required g</th>
                  <th className="px-3 py-2 text-right">Already alloc.</th>
                  <th className="px-3 py-2 text-right">Remaining</th>
                  <th className="px-3 py-2 text-right">Cover g</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => {
                  const req = Number(e.summary?.silverRequiredG ?? 0);
                  const alloc = Number(e.summary?.silverAllocatedG ?? 0);
                  const remain = Math.max(0, req - alloc);
                  const cur = Number(rows[e.id] || 0);
                  const over = cur > remain + 0.0005;
                  return (
                    <tr key={e.id} className="border-t border-border">
                      <td className="px-3 py-2 font-semibold">{e.invoiceNumber}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs">{req.toFixed(3)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs">{alloc.toFixed(3)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-xs text-warning">{remain.toFixed(3)}</td>
                      <td className="px-3 py-2 text-right">
                        <Input
                          type="number" step="0.001" min="0" max={remain}
                          value={rows[e.id] ?? ''}
                          onChange={(ev) => setRows((r) => ({ ...r, [e.id]: ev.target.value }))}
                          placeholder="0.000"
                          className={`h-8 w-24 text-right ${over ? 'border-destructive' : ''}`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-secondary/30 font-semibold">
                  <td colSpan={4} className="px-3 py-2 text-right">Total to cover</td>
                  <td className="px-3 py-2 text-right tabular-nums">{totalGrams.toFixed(3)} g</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <Field label="Notes">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional: e.g. 1 kg bar received against ests #3/#4/#5" />
        </Field>
      </div>
    </Dialog>
  );
}
