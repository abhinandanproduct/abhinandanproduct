'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Users2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/shared/field';
import { Spinner } from '@/components/ui/spinner';

export default function CustomerLedgerPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  // Date range — matches Zoho's Statement of Accounts. Blank = full history.
  const [fromDate, setFromDate] = React.useState('');
  const [toDate, setToDate]     = React.useState('');
  const q = useQuery<any>({
    queryKey: ['customer-ledger', id, fromDate, toDate],
    queryFn: () => Api.billing.customerLedger(id, {
      fromDate: fromDate || undefined,
      toDate:   toDate   || undefined,
    }),
    enabled: !!id,
  });

  if (q.isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Spinner /> Loading ledger...
      </div>
    );
  }
  if (!q.data) return null;
  const { customer, rows, closingBalance, totalInvoiced, totalPaid, openingBalance } = q.data;

  return (
    <div className="space-y-4">
      <PageHeader
        title={customer.customerName}
        description={`${customer.customerCode} · ${customer.gstin ?? 'No GSTIN'} · ${customer.city ?? ''} ${customer.state ?? ''}`}
        back={true}
      />

      {/* Date range filter — matches Zoho's Statement date picker. */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-3 sm:flex-row sm:items-end">
          <Field label="From">
            <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </Field>
          {(fromDate || toDate) && (
            <Button variant="outline" onClick={() => { setFromDate(''); setToDate(''); }}>
              Clear range
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Account Summary — Opening / Invoiced / Received / Balance Due. */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Opening Balance</div>
            <div className="mt-1 text-xl font-bold tabular-nums">
              ₹ {Number(openingBalance ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Invoiced Amount</div>
            <div className="mt-1 text-xl font-bold tabular-nums">
              ₹ {Number(totalInvoiced).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Amount Received</div>
            <div className="mt-1 text-xl font-bold tabular-nums text-success">
              ₹ {Number(totalPaid).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Balance Due</div>
            <div className={`mt-1 text-xl font-bold tabular-nums ${closingBalance > 0 ? 'text-warning' : 'text-success'}`}>
              ₹ {Number(closingBalance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="table-scroll">
          <table className="w-full text-sm">
            <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Transactions</th>
                <th className="px-4 py-3">Details</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3 text-right">Payments</th>
                <th className="px-4 py-3 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: any, i: number) => (
                <tr key={i} className="border-t border-border align-top">
                  <td className="px-4 py-3 text-xs">
                    {r.kind === 'OPENING' ? '' : new Date(r.date).toLocaleDateString('en-IN')}
                  </td>
                  <td className="px-4 py-3 text-xs font-semibold">
                    {r.kind === 'OPENING' ? '***Opening Balance***'
                     : r.description}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {r.kind === 'OPENING' ? '' :
                      <>
                        <div className="font-semibold">
                          {r.kind === 'INVOICE' ? (
                            <Link href={`/billing/invoices/${r.id}`} className="text-info hover:underline">{r.ref}</Link>
                          ) : r.ref}
                        </div>
                        {(r.details ?? []).map((d: string, j: number) => (
                          <div key={j} className="text-[11px] text-muted-foreground">{d}</div>
                        ))}
                      </>
                    }
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {r.debit ? Number(r.debit).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : ''}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-success">
                    {r.credit ? Number(r.credit).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : ''}
                  </td>
                  <td className="px-4 py-3 text-right font-medium tabular-nums">
                    {Number(r.balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">No transactions in this range.</td></tr>
              )}
              <tr className="border-t-2 border-border bg-secondary/40 font-bold">
                <td colSpan={5} className="px-4 py-3 text-right">Balance Due</td>
                <td className="px-4 py-3 text-right tabular-nums text-warning">
                  ₹ {Number(closingBalance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </td>
              </tr>
            </tbody>
          </table>
          </div>
        </CardContent>
      </Card>

      <MetalLabourSection customerId={id} />
      <MetalTimelineSection customerId={id} />
    </div>
  );
}

function MetalLabourSection({ customerId }: { customerId: number }) {
  const qc = useQueryClient();
  const summaryQ = useQuery<any>({
    queryKey: ['customer-advances-summary', customerId],
    queryFn: () => Api.customerAdvances.summary(customerId),
    enabled: !!customerId,
  });
  const ledgerQ = useQuery<any[]>({
    queryKey: ['customer-advances-ledger', customerId],
    queryFn: () => Api.customerAdvances.ledger({ customerId, limit: 200 }),
    enabled: !!customerId,
  });
  const del = useMutation({
    mutationFn: (id: number) => Api.customerAdvances.deleteLedger(id),
    onSuccess: () => {
      toast.success('Deleted. Balances unwound.');
      qc.invalidateQueries({ queryKey: ['customer-advances-summary', customerId] });
      qc.invalidateQueries({ queryKey: ['customer-advances-ledger', customerId] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const totals = summaryQ.data?.totals;
  const balances = summaryQ.data?.metalBalances ?? [];
  const feed = ledgerQ.data ?? [];
  const isMetal = (t: string) =>
    t === 'ALLOCATE_ADVANCE' || t === 'DRAW_INTO_INVOICE' ||
    t === 'RETURN_TO_CUSTOMER' || t === 'ADJUST';
  const eventLabel: Record<string, string> = {
    ALLOCATE_ADVANCE:  'Metal received',
    DRAW_INTO_INVOICE: 'Metal drawn into invoice',
    RETURN_TO_CUSTOMER: 'Metal returned',
    LABOUR_GIVEN:      'Labour invoiced',
    LABOUR_RECEIVED:   'Labour payment',
    ADJUST:            'Adjustment',
  };

  return (
    <div className="space-y-3">
      <div className="pt-4 text-lg font-semibold">Metal &amp; Labour Ledger</div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryTile label="Total Metal Received" value={totals ? `${totals.totalMetalReceived.toFixed(3)} g` : '—'} tone="info" />
        <SummaryTile label="Total Metal Given"    value={totals ? `${totals.totalMetalGiven.toFixed(3)} g` : '—'} tone="warning" />
        <SummaryTile label="Total Labour Given"   value={totals ? `Rs. ${totals.totalLabourGiven.toFixed(2)}` : '—'} tone="warning" />
        <SummaryTile label="Total Labour Received" value={totals ? `Rs. ${totals.totalLabourReceived.toFixed(2)}` : '—'} tone="success" />
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Metal Advance Balances (by variant)
          </div>
          <div className="table-scroll">
          <table className="w-full text-sm">
            <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Variant</th>
                <th className="px-4 py-2">Material</th>
                <th className="px-4 py-2 text-right">Balance (g)</th>
                <th className="px-4 py-2 text-xs text-muted-foreground">Updated</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((b: any) => (
                <tr key={b.variantId} className="border-t border-border">
                  <td className="px-4 py-2 font-mono text-xs">{b.variantCode}</td>
                  <td className="px-4 py-2 text-xs">{b.materialName} · {b.variantName}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium">
                    {Number(b.balanceWeight).toFixed(3)}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {new Date(b.updatedAt).toLocaleDateString('en-IN')}
                  </td>
                </tr>
              ))}
              {balances.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-muted-foreground text-xs">No metal advance recorded.</td></tr>
              )}
            </tbody>
          </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Metal &amp; Labour Feed
          </div>
          <div className="table-scroll">
          <table className="w-full text-sm">
            <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Event</th>
                <th className="px-4 py-2">Variant</th>
                <th className="px-4 py-2 text-right">Weight&nbsp;(g)</th>
                <th className="px-4 py-2 text-right">Amount&nbsp;(Rs.)</th>
                <th className="px-4 py-2 text-right">Balance</th>
                <th className="px-4 py-2 text-xs">Note</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {feed.map((r: any) => {
                const isM = isMetal(r.eventType);
                return (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-4 py-2 text-xs">{new Date(r.createdAt).toLocaleDateString('en-IN')}</td>
                    <td className="px-4 py-2 text-xs">{eventLabel[r.eventType] ?? r.eventType}</td>
                    <td className="px-4 py-2 text-xs font-mono">{r.variantCode ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-xs">
                      {isM ? Number(r.weight).toFixed(3) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-xs">
                      {!isM ? Number(r.weight).toFixed(2) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-xs">
                      {r.balanceAfter != null ? Number(r.balanceAfter).toFixed(3) : '—'}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{r.note ?? ''}</td>
                    <td className="px-4 py-2 text-right">
                      {/* Invoice draws are tied to a bill — delete the
                          invoice to unwind them, not this row. */}
                      {r.eventType !== 'DRAW_INTO_INVOICE' ? (
                        <Button
                          variant="outline" size="icon"
                          className="h-7 w-7 text-destructive hover:bg-destructive/10"
                          title="Delete + unwind balance"
                          onClick={() => {
                            if (confirm(`Delete this ${r.eventType} entry?\n\nBalance impact will be reversed.`)) {
                              del.mutate(r.id);
                            }
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      ) : (
                        <span className="text-[10px] text-text-faint" title="Edit via source invoice">invoice-linked</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {feed.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-muted-foreground text-xs">No ledger events yet.</td></tr>
              )}
            </tbody>
          </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function MetalTimelineSection({ customerId }: { customerId: number }) {
  const ledgerQ = useQuery<any>({
    queryKey: ['customer-metal-ledger-full', customerId],
    queryFn: () => Api.customerAdvances.metalLedgerFull(customerId),
    enabled: !!customerId,
  });
  if (ledgerQ.isLoading || !ledgerQ.data) return null;
  const { lots, issuances, holdings, draws, totals } = ledgerQ.data;
  if (lots.length === 0) return null; // no advance metal ever → skip section entirely

  return (
    <div className="space-y-3">
      <div className="pt-4 text-lg font-semibold">Metal Timeline — end-to-end</div>

      {/* Consistency roll-up */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <SummaryTile label="Advance In"       value={`${totals.lotsIn.toFixed(3)} g`} tone="info" />
        <SummaryTile label="Still in Lots"    value={`${totals.remainingInLots.toFixed(3)} g`} tone="warning" />
        <SummaryTile label="At Vendors"       value={`${totals.atVendors.toFixed(3)} g`} tone="warning" />
        <SummaryTile label="Sold to Customer" value={`${totals.soldToCustomer.toFixed(3)} g`} tone="success" />
        <SummaryTile label="Unreconciled"     value={`${totals.unreconciled.toFixed(3)} g`} tone={Math.abs(totals.unreconciled) < 1 ? 'success' : 'warning'} />
      </div>

      {/* Lots */}
      <Card>
        <CardContent className="p-0">
          <div className="border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Advance Lots ({lots.length})
          </div>
          <div className="table-scroll">
          <table className="w-full text-sm">
            <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2">Lot</th>
                <th className="px-4 py-2">Received</th>
                <th className="px-4 py-2">Variant</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2 text-right">Rate (₹/g)</th>
                <th className="px-4 py-2 text-right">Received (g)</th>
                <th className="px-4 py-2 text-right">Sold (g)</th>
                <th className="px-4 py-2 text-right">Remaining (g)</th>
              </tr>
            </thead>
            <tbody>
              {lots.map((l: any) => (
                <tr key={l.id} className="border-t border-border">
                  <td className="px-4 py-2 font-mono text-xs">{l.lotNumber}</td>
                  <td className="px-4 py-2 text-xs">{new Date(l.receivedAt).toLocaleDateString('en-IN')}</td>
                  <td className="px-4 py-2 text-xs">{l.variant}</td>
                  <td className="px-4 py-2 text-xs">{l.rateType}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{Number(l.ratePerG).toFixed(2)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{Number(l.receivedWeightG).toFixed(3)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-success">{Number(l.soldWeightG).toFixed(3)}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium">{Number(l.remainingWeightG).toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </CardContent>
      </Card>

      {/* At vendors right now */}
      {holdings.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Currently at Vendors ({holdings.length})
            </div>
            <div className="table-scroll">
            <table className="w-full text-sm">
              <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Vendor</th>
                  <th className="px-4 py-2">Lot</th>
                  <th className="px-4 py-2 text-right">Weight (g)</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h: any, i: number) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-4 py-2">{h.vendor}</td>
                    <td className="px-4 py-2 font-mono text-xs">{h.lotNumber}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-medium">{Number(h.weightG).toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Sales (invoice draws) */}
      {draws.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Sold to Customer ({draws.length})
            </div>
            <div className="table-scroll">
            <table className="w-full text-sm">
              <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Invoice</th>
                  <th className="px-4 py-2">Lot</th>
                  <th className="px-4 py-2 text-right">Weight (g)</th>
                  <th className="px-4 py-2 text-right">Rate (₹/g)</th>
                  <th className="px-4 py-2 text-xs">Note</th>
                </tr>
              </thead>
              <tbody>
                {draws.map((d: any) => (
                  <tr key={d.id} className="border-t border-border">
                    <td className="px-4 py-2 text-xs">{d.invoiceDate ? new Date(d.invoiceDate).toLocaleDateString('en-IN') : new Date(d.drawnAt).toLocaleDateString('en-IN')}</td>
                    <td className="px-4 py-2 font-semibold">{d.invoiceNumber ?? '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs">{d.lotNumber}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{Number(d.weightG).toFixed(3)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{Number(d.ratePerG).toFixed(2)}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{d.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Vendor issuances (audit trail — who received customer's metal when) */}
      {issuances.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="border-b border-border px-4 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Vendor Issuances ({issuances.length})
            </div>
            <div className="table-scroll">
            <table className="w-full text-sm">
              <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Event</th>
                  <th className="px-4 py-2">Vendor</th>
                  <th className="px-4 py-2">Lot</th>
                  <th className="px-4 py-2 text-right">Weight (g)</th>
                </tr>
              </thead>
              <tbody>
                {issuances.map((r: any) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-4 py-2 text-xs">{new Date(r.createdAt).toLocaleDateString('en-IN')}</td>
                    <td className="px-4 py-2 text-xs">{r.eventType}</td>
                    <td className="px-4 py-2 text-xs">{r.vendor ?? '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs">{r.lotNumber ?? '—'}</td>
                    <td className={`px-4 py-2 text-right tabular-nums ${Number(r.weight) >= 0 ? 'text-warning' : 'text-success'}`}>
                      {Number(r.weight) >= 0 ? '' : ''}{Number(r.weight).toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: string; tone: 'info' | 'success' | 'warning' }) {
  const toneClass =
    tone === 'success' ? 'text-success' :
    tone === 'warning' ? 'text-warning' :
    'text-info';
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`mt-1 text-lg font-bold tabular-nums ${toneClass}`}>{value}</div>
      </CardContent>
    </Card>
  );
}
