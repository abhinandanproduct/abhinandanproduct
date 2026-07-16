'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Scale, ChevronRight } from 'lucide-react';
import { Api } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Field } from '@/components/shared/field';
import { Button } from '@/components/ui/button';

// Vendor Drift Accumulator — surfaces "vendor said X grams, we actually got
// Y" per vendor across every receipt-item that recorded a claim. Fleet-wide
// roll-up on the left; click a row to drill into that vendor's per-receipt
// breakdown for the reconciliation section of the purchase bill.
export default function VendorDriftPage() {
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [selectedVendorId, setSelectedVendorId] = React.useState<number | null>(null);

  const rollupQ = useQuery({
    queryKey: ['vendor-drift-rollup', from, to],
    queryFn: () => Api.casting.vendorDrift({
      from: from || undefined,
      to: to || undefined,
    }),
  });
  const detailQ = useQuery({
    queryKey: ['vendor-drift-detail', selectedVendorId, from, to],
    queryFn: () => Api.casting.vendorDrift({
      vendorId: selectedVendorId!,
      from: from || undefined,
      to: to || undefined,
    }),
    enabled: selectedVendorId != null,
  });

  const rollup = rollupQ.data;
  const detail = detailQ.data;

  const fmt = (n: number) => n.toFixed(3);
  const driftClass = (d: number) =>
    d > 0.005 ? 'text-danger font-semibold'
    : d < -0.005 ? 'text-info font-semibold'
    : 'text-text-faint';

  return (
    <div>
      <PageHeader
        title="Vendor Drift"
        subtitle="Claimed sent vs actually received, per vendor. Positive drift = vendor said they sent more than we got — surfaces on the purchase-bill reconciler as an outstanding amount to recover."
      />

      <Card className="mb-4">
        <CardContent className="flex flex-col gap-3 p-3 sm:flex-row sm:flex-wrap sm:items-end sm:py-3">
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          {(from || to) && (
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => { setFrom(''); setTo(''); }}>
              Clear dates
            </Button>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,4fr)]">
        <Card>
          <CardContent className="p-0">
            <div className="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
              Vendors — biggest drift first
            </div>
            {rollupQ.isLoading ? (
              <div className="flex items-center justify-center py-8 gap-2 text-text-faint">
                <Spinner /> Loading…
              </div>
            ) : !rollup?.vendors.length ? (
              <div className="p-6 text-center text-sm text-text-faint">
                No receipts have recorded a &ldquo;Said sent&rdquo; weight in this range. Fill the field at receive time to build the drift history.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-secondary/30 text-[11px] uppercase tracking-wider text-text-muted">
                    <th className="px-3 py-1.5 text-left font-medium">Vendor</th>
                    <th className="px-3 py-1.5 text-right font-medium">Claimed g</th>
                    <th className="px-3 py-1.5 text-right font-medium">Actual g</th>
                    <th className="px-3 py-1.5 text-right font-medium">Drift g</th>
                    <th className="px-3 py-1.5 text-right font-medium">Rcpts</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {rollup.vendors.map((v) => {
                    const selected = v.vendorId === selectedVendorId;
                    return (
                      <tr
                        key={v.vendorId}
                        className={`cursor-pointer border-b border-border hover:bg-secondary/40 ${selected ? 'bg-gold/[0.06]' : ''}`}
                        onClick={() => setSelectedVendorId(v.vendorId)}
                      >
                        <td className="px-3 py-1.5">
                          <div className="font-medium">{v.vendorName ?? '—'}</div>
                          <div className="text-[11px] text-text-faint">{v.vendorCode ?? ''}</div>
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmt(v.totalClaimed)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmt(v.totalReceived)}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${driftClass(v.totalDrift)}`}>
                          {v.totalDrift > 0 ? '+' : ''}{fmt(v.totalDrift)}
                        </td>
                        <td className="px-3 py-1.5 text-right text-text-faint tabular-nums">
                          {v.receiptCount}
                        </td>
                        <td className="text-text-faint"><ChevronRight className="size-4" /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-0">
            <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs">
              <span className="font-semibold uppercase tracking-wider text-text-muted">
                Detail — {selectedVendorId ? 'per-receipt breakdown' : 'pick a vendor'}
              </span>
              {detail?.detail?.length ? (
                <Badge variant="info">{detail.detail.length} rows</Badge>
              ) : null}
            </div>
            {!selectedVendorId ? (
              <div className="p-6 text-center text-sm text-text-faint">
                <Scale className="mx-auto mb-2 size-6 opacity-60" />
                Click a vendor row to see every receipt-item that recorded a claim.
              </div>
            ) : detailQ.isLoading ? (
              <div className="flex items-center justify-center py-8 gap-2 text-text-faint">
                <Spinner /> Loading…
              </div>
            ) : !detail?.detail?.length ? (
              <div className="p-6 text-center text-sm text-text-faint">
                No detail rows for this vendor in the selected range.
              </div>
            ) : (
              <div className="max-h-[600px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-secondary/60 backdrop-blur">
                    <tr className="border-b border-border text-[11px] uppercase tracking-wider text-text-muted">
                      <th className="px-3 py-1.5 text-left font-medium">Date</th>
                      <th className="px-3 py-1.5 text-left font-medium">Receipt</th>
                      <th className="px-3 py-1.5 text-left font-medium">Design</th>
                      <th className="px-3 py-1.5 text-left font-medium">Stage</th>
                      <th className="px-3 py-1.5 text-right font-medium">Claimed g</th>
                      <th className="px-3 py-1.5 text-right font-medium">Actual g</th>
                      <th className="px-3 py-1.5 text-right font-medium">Drift g</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.detail.map((r) => (
                      <tr key={`${r.receiptId}-${r.itemNumber}`} className="border-b border-border">
                        <td className="px-3 py-1.5 text-xs text-text-faint">
                          {new Date(r.receiptDate).toLocaleDateString()}
                        </td>
                        <td className="px-3 py-1.5">
                          <div className="font-medium">{r.receiptNumber}</div>
                          <div className="text-[11px] text-text-faint">{r.batchNumber ?? ''}</div>
                        </td>
                        <td className="px-3 py-1.5">
                          <div className="font-medium">{r.designCode ?? r.itemNumber ?? '—'}</div>
                          <div className="text-[11px] text-text-faint">{r.itemNumber ?? ''}</div>
                        </td>
                        <td className="px-3 py-1.5 text-xs">{r.processName ?? r.processCode ?? '—'}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmt(r.claimedSentWeight)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmt(r.receivedWeight)}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${driftClass(r.drift)}`}>
                          {r.drift > 0 ? '+' : ''}{fmt(r.drift)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
