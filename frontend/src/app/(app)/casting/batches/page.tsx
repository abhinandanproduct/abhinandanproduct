'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ColumnDef } from '@tanstack/react-table';
import { Plus, Eye, Trash2, Search, Share2, FileDown, PackageCheck, Pencil, Send, Sparkles } from 'lucide-react';
import { QuickAddItem } from '@/components/shared/quick-add-item';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { DataTable } from '@/components/shared/data-table';
import { CastingStatusBadge } from '@/components/shared/status-badge';
import { useConfirm } from '@/components/shared/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { formatDate } from '@/lib/utils';
import { BatchForm } from '../issue/batch-form';
import { BatchDetail } from '../issue/batch-detail';
import { BulkForwardDialog } from '../issue/bulk-forward-dialog';
import { ReceiveForm } from '../receipt/receive-form';

function ShareDialog({ batchId, open, onClose }: { batchId: number | null; open: boolean; onClose: () => void }) {
  const { data: batch, isLoading } = useQuery({
    queryKey: ['casting-batch', batchId], queryFn: () => Api.casting.batch(batchId!), enabled: open && !!batchId,
  });
  const copy = (url: string) =>
    navigator.clipboard?.writeText(url).then(() => toast.success('Link copied.'), () => toast.error('Could not copy.'));

  // Folder tree: Process › Vendor › [Issue slip + receipt slips]
  const folders = React.useMemo(() => {
    const map = new Map<string, { processName: string; vendors: Map<string, any> }>();
    for (const it of batch?.items ?? []) {
      if (!map.has(it.processName)) map.set(it.processName, { processName: it.processName, vendors: new Map() });
      const f = map.get(it.processName)!;
      if (!f.vendors.has(it.vendorName)) f.vendors.set(it.vendorName, { vendorName: it.vendorName, vendorCode: it.vendorCode, vendorId: it.vendorId, processId: it.processId, receipts: [] });
    }
    for (const r of batch?.receipts ?? []) {
      const v = map.get(r.processName)?.vendors.get(r.vendorName);
      if (v) v.receipts.push(r);
    }
    return Array.from(map.values());
  }, [batch]);

  return (
    <Dialog open={open} onClose={onClose} size="md" title="Slips — Process › Vendor"
      description="Open or copy any issue / receipt slip.">
      {isLoading || !batch ? <div className="flex justify-center py-8"><Spinner className="text-primary" /></div> : (
        <div className="space-y-2">
          {folders.map((f) => (
            <details key={f.processName} className="rounded-lg border border-border">
              <summary className="cursor-pointer select-none bg-muted/50 px-3 py-2 text-sm font-semibold">📁 {f.processName}</summary>
              <div className="space-y-1 p-2">
                {Array.from(f.vendors.values()).map((v: any) => (
                  <details key={v.vendorName} className="rounded-md border border-border">
                    <summary className="cursor-pointer select-none px-3 py-1.5 text-sm font-medium">📂 {v.vendorCode} · {v.vendorName}</summary>
                    <div className="space-y-1 px-3 pb-2">
                      <SlipRow
                        label="🧾 Issue Slip"
                        url={Api.casting.pdfUrl(batch.id, v.vendorId, v.processId)}
                        suggestedName={`${safeFilenamePart(batch.batchNumber)}-${safeFilenamePart(v.vendorCode ?? '')}-${safeFilenamePart(v.vendorName ?? '')}-issue.pdf`}
                      />
                      {v.receipts.map((r: any) => (
                        <SlipRow
                          key={r.id}
                          label={`📥 ${r.receiptNumber} · ${r.qty} pcs`}
                          url={Api.casting.receiptPdfUrl(r.id)}
                          suggestedName={`${safeFilenamePart(batch.batchNumber)}-${safeFilenamePart(r.receiptNumber ?? String(r.id))}-${safeFilenamePart(v.vendorName ?? '')}-receipt.pdf`}
                        />
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </details>
          ))}
          {folders.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No slips yet.</p>}
        </div>
      )}
    </Dialog>
  );
}

function SlipRow({ label, url, suggestedName }: { label: string; url: string; suggestedName: string }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-border bg-card px-2.5 py-1.5 text-sm">
      <span>{label}</span>
      <div className="flex gap-1">
        <a href={url} target="_blank" rel="noreferrer"><Button variant="outline" size="sm"><FileDown className="size-4" /> Open</Button></a>
        <Button variant="outline" size="sm"
          onClick={() => downloadSlipFile(url, suggestedName).catch((e) => toast.error(`Download failed: ${e.message}`))}>
          <FileDown className="size-4" /> Download
        </Button>
        <Button variant="outline" size="sm"
          onClick={() => shareSlipFile(url, suggestedName, label).catch((e) => toast.error(`Share failed: ${e.message}`))}>
          <Share2 className="size-4" /> Share
        </Button>
      </div>
    </div>
  );
}

/** Sanitise a string for use as part of a filename across OSes. */
function safeFilenamePart(s: string): string {
  return (s ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}

async function downloadSlipFile(url: string, suggestedName: string): Promise<void> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const blob = await res.blob();
  const filename = suggestedName.endsWith('.pdf') ? suggestedName : `${suggestedName}.pdf`;
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

async function shareSlipFile(url: string, suggestedName: string, title: string): Promise<void> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const blob = await res.blob();
  const filename = suggestedName.endsWith('.pdf') ? suggestedName : `${suggestedName}.pdf`;
  const file = new File([blob], filename, { type: 'application/pdf' });
  const nav: any = typeof navigator !== 'undefined' ? navigator : null;
  if (nav?.canShare && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title });
      return;
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
    }
  }
  await downloadSlipFile(url, filename);
}

// Module-level cache — survives client-side nav, resets on hard reload.
let cachedBatchesFilter = { search: '', status: '' };

export default function BatchManagementPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { confirm, dialog } = useConfirm();
  const [search, setSearch] = React.useState(() => cachedBatchesFilter.search);
  const [status, setStatus] = React.useState(() => cachedBatchesFilter.status);
  React.useEffect(() => { cachedBatchesFilter = { search, status }; }, [search, status]);
  const [formOpen, setFormOpen] = React.useState(false);
  // Quick-Add modal — minimal 30-second item creation so a design can
  // enter a batch the same day it's created. Operator types the bare
  // minimum (item number, name, designer, image); processes / BOM
  // auto-fill as batches progress.
  const [quickAddOpen, setQuickAddOpen] = React.useState(false);
  const [detailId, setDetailId] = React.useState<number | null>(null);
  // forwardId: when the user clicks ✈ Send on a row, we open the batch detail
  // with autoForward=true so the Forward dialog pops directly on the first
  // idle stage — no scrolling / hunting through the traveler.
  const [forwardId, setForwardId] = React.useState<number | null>(null);
  const [shareId, setShareId] = React.useState<number | null>(null);
  // receiveId: opens the standalone Receive Goods form scoped to a batch
  // (used by the floor's quick-receive button, NOT by the repair flow).
  const [receiveId, setReceiveId] = React.useState<number | null>(null);
  // autoReceiveRepairId: when the user clicks "Receive back" on /repairs,
  // this flows into BatchDetail which auto-opens its INTERNAL ReceiveForm
  // scoped to the repair. The form sits inside the batch dialog so the
  // user keeps full batch context throughout the receive.
  const [autoReceiveRepairId, setAutoReceiveRepairId] = React.useState<number | null>(null);

  // Deep-link handler — react to ?focusBatch=<id>&receiveRepair=<id>&vendorId=<id>
  // sent by /repairs "Receive back". Opens the batch detail dialog with
  // autoReceiveRepairId set; BatchDetail then fetches the repair, opens its
  // OWN ReceiveForm scoped to it, and the pcs land back in this same batch
  // when saved. Params are stripped after consumption so a refresh doesn't
  // re-trigger.
  React.useEffect(() => {
    const focusBatch = searchParams?.get('focusBatch');
    const receiveRepair = searchParams?.get('receiveRepair');
    if (focusBatch && receiveRepair) {
      setDetailId(Number(focusBatch));
      setAutoReceiveRepairId(Number(receiveRepair));
      router.replace('/casting/batches');
    } else if (focusBatch) {
      setDetailId(Number(focusBatch));
      router.replace('/casting/batches');
    }
  }, [searchParams, router]);

  const batchesQ = useQuery({
    queryKey: ['casting-batches', { search, status }],
    queryFn: () => Api.casting.batches({ search: search || undefined, status: status || undefined }),
  });

  // Production Management focuses on what the floor needs to act on now:
  // ACTIVE batches only — neither batch-closed nor in a settled state.
  // Both "Completed" and "Closed (shorts)" are SETTLED (no more receiving
  // is expected) and so move to Batch Inventory:
  //   • Cleanly received → Completed folder
  //   • Some stage short-closed → "Closed with shorts" folder
  // The short-closed qty stays visible on Batch Inventory (its own folder
  // + inline ⛔ badge on every row), so it never vanishes.
  const allRows = batchesQ.data ?? [];
  const rows = allRows.filter((b: any) =>
    !b.closed && b.displayStatus !== 'Completed' && b.displayStatus !== 'Closed (shorts)',
  );

  const remove = useMutation({
    mutationFn: (id: number) => Api.casting.removeBatch(id),
    onSuccess: () => { toast.success('Batch deleted.'); qc.invalidateQueries({ queryKey: ['casting-batches'] }); },
    onError: (e) => toast.error(getApiError(e).message),
  });

  // Highlight a substring (the operator's search query) inside any of
  // the matched fields so the eye lands on the hit immediately. Returns
  // a React fragment with the matched portion wrapped in <mark>.
  const highlight = (text: string | null | undefined, q: string) => {
    if (!text) return null;
    if (!q) return text;
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return text;
    return (
      <>
        {text.slice(0, i)}
        <mark className="rounded bg-warning/20 px-0.5">{text.slice(i, i + q.length)}</mark>
        {text.slice(i + q.length)}
      </>
    );
  };

  const columns: ColumnDef<any>[] = [
    {
      accessorKey: 'batchNumber',
      header: 'Batch #',
      cell: ({ row }) => {
        const matches = (row.original.matchedItems ?? []) as Array<{
          itemNumber: string | null; itemName: string | null; vendorDesignReference: string | null;
        }>;
        return (
          <div>
            <span className="font-semibold">{highlight(row.original.batchNumber, search)}</span>
            {/* Matched-design hint — when the operator typed a search
                term that landed on an item / vendor-ref inside this
                batch, surface up to 3 hits so they see WHY the batch
                came up. Hidden when the match was on the batch number
                itself (matchedItems would be empty in that case). */}
            {search && matches.length > 0 && (
              <div className="mt-0.5 flex flex-col gap-0.5 text-[11px] text-muted-foreground">
                {matches.slice(0, 3).map((m, i) => (
                  <div key={i} className="truncate" title={`${m.itemNumber ?? ''} ${m.itemName ?? ''} ${m.vendorDesignReference ?? ''}`}>
                    🔎 {m.itemNumber && <>#{highlight(m.itemNumber, search)}</>}
                    {m.itemName && <> · {highlight(m.itemName, search)}</>}
                    {m.vendorDesignReference && <> · vRef <span className="font-medium">{highlight(m.vendorDesignReference, search)}</span></>}
                  </div>
                ))}
                {matches.length > 3 && (
                  <div className="text-muted-foreground/80">…and {matches.length - 3} more</div>
                )}
              </div>
            )}
          </div>
        );
      },
    },
    {
      id: 'processes', header: 'Processes reached', enableSorting: false,
      cell: ({ row }) => (
        // max-w caps the cell so the badges wrap onto a second / third
        // line instead of pushing the table horizontally past the
        // viewport (which was hiding the Actions column behind a
        // scrollbar). 220px ≈ 3 process pills per line.
        <div className="flex max-w-[220px] flex-wrap items-center gap-x-1 gap-y-1">
          {(row.original.processNames ?? []).map((n: string, i: number) => (
            <React.Fragment key={n}>
              {i > 0 && <span className="text-muted-foreground">›</span>}
              <Badge variant="outline" className="whitespace-nowrap">{n}</Badge>
            </React.Fragment>
          ))}
        </div>
      ),
    },
    { accessorKey: 'batchDate', header: 'Date', cell: ({ row }) => formatDate(row.original.batchDate) },
    {
      id: 'designs', header: 'Production', enableSorting: false,
      cell: ({ row }) => (
        <div className="text-sm">
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant="info">{row.original.designCount} design(s)</Badge>
            {/* Multi-slip badge — surfaces partial-issuance batches so the
                user knows to use the per-stage slip picker for these. */}
            {row.original.slipCount > 1 && (
              <Badge variant="secondary" title="Multiple issue slips — partial issuances split across days">
                📑 {row.original.slipCount} slips
              </Badge>
            )}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{row.original.piecesOrdered} pcs ordered</div>
        </div>
      ),
    },
    {
      id: 'status', header: 'Status', enableSorting: false,
      cell: ({ row }) => {
        const s = row.original.displayStatus ?? '—';
        const cls = s === 'Completed' ? 'bg-success/15 text-success'
          : s === 'Closed (shorts)' ? 'bg-warning/15 text-warning'
          : s === 'In Process' ? 'bg-info/15 text-info'
          // Post-packing dispatch lifecycle states — readable colour cues:
          // violet for "needs categorize", indigo for "at DC awaiting ship".
          : s === 'Awaiting Categorization' ? 'bg-info/15 text-info'
          : s === 'At Dispatch Center' ? 'bg-indigo-100 text-indigo-800'
          : 'bg-secondary/50 text-text-muted';
        const shortQty = row.original.shortClosedQty ?? 0;
        const shortStages = row.original.shortClosedStages ?? 0;
        return (
          <div>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>{s}</span>
            <div className="mt-1 text-xs text-muted-foreground">
              {row.original.openStages > 0 ? `${row.original.openStages} step(s) awaiting receipt` : 'All steps received'}
            </div>
            {/* Short-closed badge — visible whenever any stage in this batch
                was short-closed. The qty is the sum of unreceived pcs that
                got frozen as outstanding balance on the vendor ledger. */}
            {shortQty > 0 && (
              <div className="mt-1">
                <Badge variant="destructive" className="text-xs"
                  title={`${shortStages} stage(s) short-closed · ${shortQty} pcs went to vendor ledger as outstanding`}>
                  ⛔ {shortQty} pcs short-closed
                </Badge>
              </div>
            )}
          </div>
        );
      },
    },
    {
      id: 'actions', header: () => <div className="text-right">Actions</div>, enableSorting: false,
      cell: ({ row }) => {
        const done = row.original.status === 'COMPLETED';
        return (
          <div className="flex justify-end gap-1">
            <Button variant="outline" size="icon" title="View" onClick={() => setDetailId(row.original.id)}><Eye className="size-4" /></Button>
            <Button variant="outline" size="icon" title="Edit steps" onClick={() => setDetailId(row.original.id)}><Pencil className="size-4" /></Button>
            <Button variant="outline" size="icon" title="Send to next process — opens the Forward dialog directly" onClick={() => setForwardId(row.original.id)}><Send className="size-4" /></Button>
            <Button variant="outline" size="icon" title={done ? 'Fully received' : 'Receive'} disabled={done} onClick={() => setReceiveId(row.original.id)}><PackageCheck className="size-4" /></Button>
            <Button variant="outline" size="icon" title="Slips" onClick={() => setShareId(row.original.id)}><Share2 className="size-4" /></Button>
            <Button variant="outline" size="icon" className="text-destructive hover:bg-destructive/10" title="Delete"
              onClick={() => confirm({ title: 'Delete batch?', message: `This deletes batch ${row.original.batchNumber} and its receipts.`, onConfirm: () => remove.mutateAsync(row.original.id) })}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Production Management"
        subtitle="Active batches in production. Closed and short-closed batches live on Batch Inventory."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => setQuickAddOpen(true)}>
              <Sparkles className="size-4" /> Quick Add Item
            </Button>
            <Button onClick={() => setFormOpen(true)}>
              <Plus className="size-4" /> New Production Batch
            </Button>
          </div>
        }
      />

      <QuickAddItem
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
      />

      <Card className="mb-4">
        {/* Tighter padding on mobile (p-3), roomier on desktop (sm:p-4).
            Search input is full-width on phone and flex-1 above sm — mirrors
            the reference implementation's responsive spacing. */}
        <CardContent className="flex flex-wrap items-center gap-3 p-3 sm:p-4">
          <div className="relative w-full sm:min-w-[220px] sm:flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search batch / vendor / item # / design ref / notes…"
              className="h-10 pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* DataTable renders its own bordered container. Below lg it swaps
          to `mobileCard` for a one-card-per-batch stack (no h-scroll). */}
      <DataTable columns={columns} data={rows} loading={batchesQ.isLoading}
            pageSize={10} pageSizeOptions={[10, 25, 50, 100]}
            emptyTitle="No active batches"
            emptyDescription="Everything is shipped — create a new batch when production resumes, or open Batch Inventory to browse history."
            mobileCard={(row: any) => {
              const s = row.displayStatus ?? '—';
              // Colour token for the status chip (gold/dark-friendly).
              const cls =
                s === 'Completed'                 ? 'bg-success/15 text-success' :
                s === 'Closed (shorts)'           ? 'bg-warning/15 text-warning' :
                s === 'In Process'                ? 'bg-info/15 text-info' :
                s === 'Awaiting Categorization'   ? 'bg-secondary text-foreground' :
                s === 'At Dispatch Center'        ? 'bg-primary/15 text-primary' :
                'bg-secondary text-text-muted';
              const shortQty = row.shortClosedQty ?? 0;
              const done = row.status === 'COMPLETED';
              return (
                <div className="text-sm">
                  {/* Header: batch number + status chip */}
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-base font-semibold">{row.batchNumber}</div>
                      <div className="text-xs text-text-faint">{formatDate(row.batchDate)}</div>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{s}</span>
                  </div>
                  {/* Processes reached — chain of process badges */}
                  {(row.processNames ?? []).length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1">
                      {row.processNames.map((n: string, i: number) => (
                        <React.Fragment key={`${n}-${i}`}>
                          {i > 0 && <span className="text-text-faint">›</span>}
                          <Badge variant="outline" className="whitespace-nowrap text-[10px]">{n}</Badge>
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                  {/* Production summary */}
                  <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
                    <Badge variant="info" className="text-[10px]">{row.designCount} design{row.designCount === 1 ? '' : 's'}</Badge>
                    {row.slipCount > 1 && (
                      <Badge variant="secondary" className="text-[10px]">📑 {row.slipCount} slips</Badge>
                    )}
                    <span className="text-text-muted">· {row.piecesOrdered} pcs ordered</span>
                  </div>
                  {/* Status detail + short-closed */}
                  <div className="mt-1 text-xs text-text-muted">
                    {row.openStages > 0 ? `${row.openStages} step(s) awaiting receipt` : 'All steps received'}
                  </div>
                  {shortQty > 0 && (
                    <div className="mt-1">
                      <Badge variant="destructive" className="text-[10px]">⛔ {shortQty} pcs short-closed</Badge>
                    </div>
                  )}
                  {/* Actions — wraps freely on narrow phones */}
                  <div className="mt-3 flex flex-wrap gap-1 border-t border-border pt-2">
                    <Button variant="outline" size="sm" onClick={() => setDetailId(row.id)}><Eye className="size-3.5" /> View</Button>
                    <Button variant="outline" size="sm" onClick={() => setForwardId(row.id)}><Send className="size-3.5" /> Send</Button>
                    <Button variant="outline" size="sm" disabled={done} onClick={() => setReceiveId(row.id)}><PackageCheck className="size-3.5" /> Receive</Button>
                    <Button variant="outline" size="sm" onClick={() => setShareId(row.id)}><Share2 className="size-3.5" /> Slips</Button>
                    <Button variant="outline" size="sm" className="text-destructive hover:bg-destructive/10"
                      onClick={() => confirm({ title: 'Delete batch?', message: `This deletes batch ${row.batchNumber} and its receipts.`, onConfirm: () => remove.mutateAsync(row.id) })}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              );
            }}
          />

      <BatchForm open={formOpen} onClose={() => setFormOpen(false)} onSaved={(id) => { setFormOpen(false); setDetailId(id); }} />
      <BatchDetail
        batchId={detailId}
        open={detailId != null}
        onClose={() => { setDetailId(null); setAutoReceiveRepairId(null); }}
        autoReceiveRepairId={autoReceiveRepairId}
      />
      {/* ✈ Send icon now opens the bulk-forward dialog — one row per idle
          stage with per-row target / vendor / qty / weight / rate / colour.
          BatchDetail's autoForward path stays available; it just isn't the
          default behaviour of the row button anymore. */}
      <BulkForwardDialog
        batchId={forwardId}
        open={forwardId != null}
        onClose={() => setForwardId(null)}
        onDone={() => qc.invalidateQueries({ queryKey: ['casting-batches'] })}
      />
      <ShareDialog batchId={shareId} open={shareId != null} onClose={() => setShareId(null)} />
      <ReceiveForm open={receiveId != null} initialBatchId={receiveId} onClose={() => setReceiveId(null)} />
      {dialog}
    </div>
  );
}
