'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Factory, AlertTriangle } from 'lucide-react';
import { Api, getApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Field } from '@/components/shared/field';
import { Badge } from '@/components/ui/badge';
import { formatDate } from '@/lib/utils';

/**
 * Recast Missing Parts — opened from the design detail page's banner
 * when openMissingParts > 0. Lists every open MissingPart (with source
 * stage / batch for traceability). Operator ticks which ones to recast,
 * picks a Casting vendor, and submits. Backend creates a fresh Casting
 * batch with one row per part — summed across ticked records.
 *
 * Already-recast records render in a separate "Recently recast" section
 * with a link to the recast batch.
 */
export function RecastMissingPartsDialog({
  itemId,
  designCode,
  open,
  onClose,
  onRecast,
}: {
  itemId: number | null;
  designCode: string | null;
  open: boolean;
  onClose: () => void;
  onRecast?: (res: { batchId: number; batchNumber: string }) => void;
}) {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const [castingDate, setCastingDate] = React.useState(today);
  const [notes, setNotes] = React.useState('');
  const [vendorId, setVendorId] = React.useState<number | ''>('');
  const [picked, setPicked] = React.useState<Set<number>>(new Set());

  const missingQ = useQuery({
    queryKey: ['missing-parts', itemId],
    queryFn: () => Api.items.listMissingParts(itemId!),
    enabled: open && itemId != null,
  });
  const vendorsQ = useQuery({
    queryKey: ['vendors-all'],
    queryFn: () => Api.vendors.list(),
    enabled: open,
  });

  React.useEffect(() => {
    if (open) {
      setPicked(new Set());
      setCastingDate(today);
      setNotes('');
      setVendorId('');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, itemId]);

  // Auto-pick every open record when the list loads — operator can untick
  // any they want to recast later. Matches "I want all missing pieces
  // recast in one go" being the 95% case.
  React.useEffect(() => {
    if (!missingQ.data) return;
    const openIds = missingQ.data.filter((r: any) => r.isOpen).map((r: any) => r.id as number);
    setPicked(new Set(openIds));
  }, [missingQ.data]);

  const openRecords = (missingQ.data ?? []).filter((r: any) => r.isOpen);
  const recastRecords = (missingQ.data ?? []).filter((r: any) => !r.isOpen);

  // Casting-capable vendors. The vendor master's processNames is a
  // comma-joined display string — filter substring-wise.
  const castingVendors = (vendorsQ.data ?? []).filter((v: any) =>
    (v.processNames ?? '').toLowerCase().includes('casting'),
  );

  const recast = useMutation({
    mutationFn: () => {
      if (!itemId) throw new Error('No item');
      if (!vendorId) throw new Error('Pick a casting vendor.');
      if (!picked.size) throw new Error('Pick at least one missing-part record.');
      return Api.items.recastMissingParts(itemId, {
        vendorId: Number(vendorId),
        missingPartIds: Array.from(picked),
        castingDate,
        notes: notes.trim() || undefined,
      });
    },
    onSuccess: (res) => {
      toast.success(`Recast batch ${res.batchNumber} created with ${res.rows.length} part row${res.rows.length === 1 ? '' : 's'}.`);
      qc.invalidateQueries({ queryKey: ['missing-parts', itemId] });
      qc.invalidateQueries({ queryKey: ['item', itemId] });
      qc.invalidateQueries({ queryKey: ['casting-batches'] });
      onRecast?.(res);
      onClose();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const pickedRecords = openRecords.filter((r: any) => picked.has(r.id));
  const totalPcs = pickedRecords.reduce((s: number, r: any) => s + r.qtyMissing, 0);
  const totalWt = pickedRecords.reduce((s: number, r: any) => s + Number(r.weightMissing ?? 0), 0);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={`Recast missing parts${designCode ? ` — ${designCode}` : ''}`}
      description="Bundle the picked missing-part records into a new Casting batch. The records are linked back to the recast row so you can trace which earlier shortage each row makes good."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={recast.isPending}>Cancel</Button>
          <Button
            onClick={() => recast.mutate()}
            disabled={recast.isPending || !vendorId || !picked.size}
          >
            {recast.isPending && <Spinner className="text-primary-foreground" />}
            <Factory className="size-4" />
            Create recast batch
          </Button>
        </>
      }
    >
      {missingQ.isLoading ? (
        <div className="flex items-center justify-center py-8"><Spinner /></div>
      ) : (
        <div className="space-y-4">
          {/* Open records → pickable */}
          <section>
            <h3 className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-warning">
              <AlertTriangle className="size-3.5" /> Open missing-part records
              <Badge variant="warning" className="text-[9px]">{openRecords.length}</Badge>
            </h3>
            {openRecords.length === 0 ? (
              <p className="rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm text-text-faint">
                No open missing-part records. New flags from receive forms show up here.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-secondary/40 text-left text-text-faint">
                    <tr>
                      <th className="px-2 py-2 text-[11px] font-bold uppercase tracking-wider">Pick</th>
                      <th className="px-2 py-2 text-[11px] font-bold uppercase tracking-wider">Part</th>
                      <th className="px-2 py-2 text-[11px] font-bold uppercase tracking-wider text-right">Qty</th>
                      <th className="px-2 py-2 text-[11px] font-bold uppercase tracking-wider text-right">Wt (g)</th>
                      <th className="px-2 py-2 text-[11px] font-bold uppercase tracking-wider">Source</th>
                      <th className="px-2 py-2 text-[11px] font-bold uppercase tracking-wider">When · By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openRecords.map((r: any) => (
                      <tr key={r.id} className="border-t border-border">
                        <td className="px-2 py-1.5">
                          <input
                            type="checkbox"
                            className="accent-gold size-4 cursor-pointer"
                            checked={picked.has(r.id)}
                            onChange={(e) => {
                              setPicked((s) => {
                                const next = new Set(s);
                                if (e.target.checked) next.add(r.id); else next.delete(r.id);
                                return next;
                              });
                            }}
                          />
                        </td>
                        <td className="px-2 py-1.5 font-medium">{r.partName}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{r.qtyMissing}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{r.weightMissing != null ? Number(r.weightMissing).toFixed(3) : '—'}</td>
                        <td className="px-2 py-1.5 text-text-muted">
                          {r.sourceBatchNumber ?? '—'}
                          {r.sourceProcessName ? <span className="ml-1 text-text-faint">· {r.sourceProcessName}</span> : null}
                        </td>
                        <td className="px-2 py-1.5 text-text-faint text-xs">
                          {r.reportedAt ? formatDate(r.reportedAt) : '—'}
                          {r.reportedBy ? ` · ${r.reportedBy}` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Recast form — only when at least one open record exists. */}
          {openRecords.length > 0 && (
            <section className="rounded-md border border-gold/20 bg-gold/[0.04] p-3">
              <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-gold">
                Recast batch details
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Casting vendor" required>
                  <SearchableSelect
                    value={vendorId}
                    placeholder={castingVendors.length === 0 ? '— No casting vendors —' : '— Pick vendor —'}
                    onChange={(v) => setVendorId(v ? Number(v) : '')}
                    options={castingVendors.map((v: any) => ({
                      value: v.id, label: `${v.vendorCode} · ${v.vendorName}`, keywords: v.vendorName,
                    }))}
                  />
                </Field>
                <Field label="Casting date">
                  <Input type="date" value={castingDate} onChange={(e) => setCastingDate(e.target.value)} />
                </Field>
                <Field label="Notes">
                  <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
                </Field>
              </div>
              <p className="mt-2 text-xs text-text-muted">
                Summary: <strong>{picked.size}</strong> record{picked.size === 1 ? '' : 's'} ·{' '}
                <strong>{totalPcs}</strong> pcs · <strong>{totalWt.toFixed(3)}</strong> g
              </p>
            </section>
          )}

          {/* Already-recast records — read-only history. */}
          {recastRecords.length > 0 && (
            <section>
              <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-text-faint">
                Previously recast
              </h3>
              <ul className="space-y-1 text-xs text-text-muted">
                {recastRecords.map((r: any) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 rounded border border-border/60 bg-secondary/20 px-2 py-1.5">
                    <strong className="text-foreground">{r.partName}</strong>
                    <span>· {r.qtyMissing} pcs</span>
                    {r.recastBatchNumber && (
                      <Link href="/casting/batches" className="text-gold hover:underline">→ {r.recastBatchNumber}</Link>
                    )}
                    {r.recastAt && <span className="ml-auto text-text-faint">{formatDate(r.recastAt)}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Dialog>
  );
}
