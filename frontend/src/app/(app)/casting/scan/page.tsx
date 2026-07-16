'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Api } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { PackageCheck, X, AlertTriangle, ScanLine } from 'lucide-react';
import { formatDate } from '@/lib/utils';

/**
 * /casting/scan — landing page for the per-item QR codes printed on issue
 * slip Order Details cards. The QR encodes:
 *   ?b=<batchId>   — required
 *   ?v=<vendorId>  — required
 *   ?s=<stageId>   — optional, used only for context display
 *   ?i=<itemNo>    — optional, used only for context display
 *
 * Workflow: karigar scans → page opens → confirmation card with batch /
 * vendor / process / date / design hint → "Accept Receipt" navigates to
 * /casting/receipt?batchId=…&vendorId=… which opens the ReceiveForm
 * pre-scoped to that lot, just like the deep-link from /repairs.
 *
 * When required params are missing or the batch / vendor lookup fails,
 * we render a friendly "QR couldn't be matched" card with a back button
 * — never a blank page.
 */
export default function CastingScanPage() {
  const router = useRouter();
  const search = useSearchParams();
  const batchId = search?.get('b') ? Number(search.get('b')) : null;
  const vendorId = search?.get('v') ? Number(search.get('v')) : null;
  const itemNumberHint = search?.get('i') ?? null;

  // Fetch enough batch context to confirm the operator is about to
  // receive into the right batch + the right vendor. Skipped when
  // params are missing — the error card handles that case.
  const batchQ = useQuery({
    queryKey: ['casting-batch', batchId],
    queryFn: () => Api.casting.batch(batchId!),
    enabled: !!batchId,
  });

  const onAccept = () => {
    if (!batchId || !vendorId) return;
    const qs = new URLSearchParams();
    qs.set('batchId', String(batchId));
    qs.set('vendorId', String(vendorId));
    router.push(`/casting/receipt?${qs.toString()}`);
  };
  const onCancel = () => router.push('/casting/batches');

  return (
    <div className="mx-auto max-w-xl space-y-4 p-4 sm:p-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <ScanLine className="size-4" />
        <span>QR scan</span>
      </div>

      {!batchId || !vendorId ? (
        <Card>
          <CardContent className="space-y-3 p-5">
            <div className="flex items-start gap-2 text-warning">
              <AlertTriangle className="size-5 shrink-0" />
              <div>
                <div className="font-semibold">QR could not be matched.</div>
                <div className="text-sm">
                  The scanned link is missing the batch or vendor information.
                  Make sure you scanned the QR from a current issue slip and try again.
                </div>
              </div>
            </div>
            <Button variant="outline" onClick={onCancel}>
              <X className="size-4" /> Back to Production Management
            </Button>
          </CardContent>
        </Card>
      ) : batchQ.isLoading ? (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
            <Spinner /> Loading batch context…
          </CardContent>
        </Card>
      ) : batchQ.isError || !batchQ.data ? (
        <Card>
          <CardContent className="space-y-3 p-5">
            <div className="flex items-start gap-2 text-destructive">
              <AlertTriangle className="size-5 shrink-0" />
              <div>
                <div className="font-semibold">Batch not found.</div>
                <div className="text-sm">
                  The batch this QR points to (id {batchId}) couldn't be loaded.
                  It may have been deleted, or your sign-in may have expired.
                </div>
              </div>
            </div>
            <Button variant="outline" onClick={onCancel}>
              <X className="size-4" /> Back
            </Button>
          </CardContent>
        </Card>
      ) : (() => {
        const batch = batchQ.data;
        const vendor = (batch.vendors ?? []).find((v: any) => v.id === vendorId);
        // Items this vendor still has open in the batch — surfaced as a
        // hint so the karigar sees "yes, my plating lot is still open".
        const openItems = (batch.items ?? []).filter(
          (it: any) => it.vendorId === vendorId && !it.closed && it.pendingQty > 0,
        );
        const processName = openItems[0]?.processName ?? batch.processName ?? '—';
        return (
          <Card>
            <CardContent className="space-y-4 p-5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">Confirm receipt for</div>
                  <h1 className="text-2xl font-bold">{batch.batchNumber}</h1>
                </div>
                <Badge variant="outline" className="text-xs">
                  {processName}
                </Badge>
              </div>

              <div className="grid grid-cols-1 gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm sm:grid-cols-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Vendor</div>
                  <div className="font-semibold">{vendor ? `${vendor.vendorCode} · ${vendor.vendorName}` : `Vendor #${vendorId}`}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Batch date</div>
                  <div className="font-semibold">{formatDate(batch.batchDate)}</div>
                </div>
                {itemNumberHint && (
                  <div className="sm:col-span-2">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Scanned design</div>
                    <div className="font-semibold">#{itemNumberHint}</div>
                  </div>
                )}
                <div className="sm:col-span-2">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Open lots from this vendor</div>
                  <div className="font-semibold">
                    {openItems.length === 0
                      ? <span className="text-warning">No open lots — vendor may already be fully received.</span>
                      : openItems
                          .slice(0, 4)
                          .map((it: any) => `#${it.itemNumber ?? '—'} (${it.pendingQty}p${it.color ? ' · ' + it.color : ''})`)
                          .join(', ')}
                    {openItems.length > 4 && <span className="text-muted-foreground"> · +{openItems.length - 4} more</span>}
                  </div>
                </div>
              </div>

              <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
                Tap <strong>Accept Receipt</strong> to open the Receive Goods form with this batch + vendor pre-selected.
                You can still tweak per-row quantities and QC before saving.
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={onAccept} disabled={openItems.length === 0}>
                  <PackageCheck className="size-4" /> Accept Receipt
                </Button>
                <Button variant="outline" onClick={onCancel}>
                  <X className="size-4" /> Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })()}
    </div>
  );
}
