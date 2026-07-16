'use client';

import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Flame, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/shared/field';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';

/**
 * Alloying (999 → 93.5) — see project_erp_roadmap_2026-07 for design.
 */
export default function AlloyingPage() {
  const [detailId, setDetailId] = React.useState<number | null>(null);
  const [newOpen, setNewOpen] = React.useState(false);

  const listQ = useQuery({ queryKey: ['alloying'], queryFn: () => Api.alloying.list() });
  const batches = listQ.data ?? [];

  return (
    <div>
      <PageHeader
        title="Alloying"
        subtitle="999 silver + copper → 93.5 silver. Every melt records inputs, outputs (alloy + runners + loss), and stock adjusts automatically on 'Melt'."
        actions={<Button onClick={() => setNewOpen(true)}><Plus className="size-4" /> New Alloying Batch</Button>}
      />

      <Card>
        <CardContent className="p-3 sm:p-4">
          {listQ.isLoading ? (
            <div className="flex justify-center py-12 text-text-faint"><Spinner /> Loading…</div>
          ) : batches.length === 0 ? (
            <div className="py-12 text-center text-text-faint">
              <Flame className="mx-auto mb-2 size-8 opacity-40" />
              No alloying batches yet.
            </div>
          ) : (
            <div className="space-y-2">
              {batches.map((b: any) => {
                const inW  = b.inputs.reduce((s: number, r: any) => s + Number(r.weightG), 0);
                const outW = b.outputs.reduce((s: number, r: any) => s + Number(r.weightG), 0);
                return (
                  <button
                    key={b.id}
                    className="block w-full rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-gold/40"
                    onClick={() => setDetailId(b.id)}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="text-base font-semibold">{b.batchNumber}</div>
                        <div className="text-xs text-text-faint">
                          {new Date(b.batchDate).toLocaleDateString('en-IN')}
                          {' · '}
                          <span>Input {inW.toFixed(3)} g → Output {outW.toFixed(3)} g</span>
                        </div>
                      </div>
                      <Badge variant={
                        b.status === 'MELTED' ? 'info' :
                        b.status === 'DRAFT' ? 'secondary' : 'destructive'
                      } className="text-[10px]">{b.status}</Badge>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <NewBatchDialog open={newOpen} onClose={() => setNewOpen(false)} onCreated={(id) => { setNewOpen(false); setDetailId(id); }} />
      <BatchDetailDialog id={detailId} onClose={() => setDetailId(null)} />
    </div>
  );
}

function NewBatchDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const [batchDate, setBatchDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = React.useState('');
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => Api.alloying.create({ batchDate, notes: notes.trim() || undefined }),
    onSuccess: (b) => { qc.invalidateQueries({ queryKey: ['alloying'] }); onCreated(b.id); },
    onError: (e) => toast.error(getApiError(e).message),
  });
  return (
    <Dialog
      open={open} onClose={onClose} size="md" title="New Alloying Batch"
      description="Create a draft batch. You'll add inputs and outputs, then click Melt to commit stock."
      footer={<>
        <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending && <Spinner />} Create Draft</Button>
      </>}
    >
      <div className="space-y-3">
        <Field label="Batch Date"><Input type="date" value={batchDate} onChange={(e) => setBatchDate(e.target.value)} /></Field>
        <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

function BatchDetailDialog({ id, onClose }: { id: number | null; onClose: () => void }) {
  const qc = useQueryClient();
  const batchQ = useQuery({ queryKey: ['alloying', id], queryFn: () => Api.alloying.findOne(id!), enabled: id != null });
  const variantsQ = useQuery({ queryKey: ['variants-active'], queryFn: () => Api.materials.variants({ status: 'ACTIVE' }), enabled: id != null });
  const silverVariants = (variantsQ.data ?? []).filter((v: any) => v.trackByWeight);

  type InLine = { _k: number; variantId: number | ''; weightG: string; notes: string };
  type OutLine = { _k: number; kind: 'ALLOY' | 'RUNNERS' | 'LOSS'; variantId: number | ''; weightG: string; notes: string };
  const [inputs, setInputs] = React.useState<InLine[]>([]);
  const [outputs, setOutputs] = React.useState<OutLine[]>([]);

  React.useEffect(() => {
    if (!batchQ.data) return;
    setInputs(batchQ.data.inputs.map((r: any) => ({ _k: r.id, variantId: r.variantId, weightG: String(r.weightG), notes: r.notes ?? '' })));
    setOutputs(batchQ.data.outputs.map((r: any) => ({ _k: r.id, kind: r.kind, variantId: r.variantId ?? '', weightG: String(r.weightG), notes: r.notes ?? '' })));
  }, [batchQ.data]);

  const isDraft = batchQ.data?.status === 'DRAFT';

  const save = useMutation({
    mutationFn: () => Api.alloying.saveLines(id!, {
      inputs: inputs.filter((r) => r.variantId && Number(r.weightG) > 0).map((r) => ({ variantId: Number(r.variantId), weightG: Number(r.weightG), notes: r.notes || undefined })),
      outputs: outputs.filter((r) => Number(r.weightG) > 0).map((r) => ({
        kind: r.kind,
        variantId: r.kind === 'LOSS' ? undefined : (r.variantId ? Number(r.variantId) : undefined),
        weightG: Number(r.weightG),
        notes: r.notes || undefined,
      })),
    }),
    onSuccess: () => { toast.success('Saved.'); qc.invalidateQueries({ queryKey: ['alloying'] }); },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const melt = useMutation({
    mutationFn: () => Api.alloying.melt(id!),
    onSuccess: () => { toast.success('Melted — stock updated.'); qc.invalidateQueries({ queryKey: ['alloying'] }); qc.invalidateQueries({ queryKey: ['variants'] }); },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const cancel = useMutation({
    mutationFn: () => Api.alloying.cancel(id!),
    onSuccess: () => { toast.success('Cancelled.'); qc.invalidateQueries({ queryKey: ['alloying'] }); onClose(); },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const hardDelete = useMutation({
    mutationFn: () => Api.alloying.hardDelete(id!),
    onSuccess: (r) => { toast.success(`Deleted ${r.batchNumber}.`); qc.invalidateQueries({ queryKey: ['alloying'] }); onClose(); },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const totalIn = inputs.reduce((s, r) => s + Number(r.weightG || 0), 0);
  const totalOut = outputs.reduce((s, r) => s + Number(r.weightG || 0), 0);
  const diff = totalIn - totalOut;

  return (
    <Dialog
      open={id != null} onClose={onClose} size="xl"
      title={batchQ.data ? `${batchQ.data.batchNumber} · ${batchQ.data.status}` : 'Loading…'}
      description="Inputs on the left (999 + alloys), outputs on the right (93.5 + runners + loss). The scale is always right — imbalance posts silently as loss."
      footer={<>
        {isDraft && <Button variant="outline" className="text-destructive" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Cancel Draft</Button>}
        {(isDraft || batchQ.data?.status === 'CANCELLED') && (
          <Button
            variant="outline" className="text-destructive"
            title="Hard-delete the batch (Draft or Cancelled only)"
            onClick={() => {
              if (confirm(`Permanently delete ${batchQ.data?.batchNumber}?\n\nThe row + every input / output line is removed. Melted batches can't be deleted.`)) {
                hardDelete.mutate();
              }
            }}
            disabled={hardDelete.isPending}
          >
            {hardDelete.isPending && <Spinner />} Delete
          </Button>
        )}
        <Button variant="outline" onClick={onClose}>Close</Button>
        {isDraft && <Button variant="outline" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending && <Spinner />} Save</Button>}
        {isDraft && <Button onClick={() => melt.mutate()} disabled={melt.isPending || totalIn <= 0 || totalOut <= 0}>{melt.isPending && <Spinner />} Melt & Commit</Button>}
      </>}
    >
      {/* 93.5 alloying planner — quick calculator: type the target 93.5
          output weight, we compute the 999 input needed at fineness 0.935
          (target / 0.935, rounded to 3 decimals). "Fill" drops a matching
          SILV-999 input row + a matching SILV-935 output row so the
          operator doesn't have to add them by hand. Draft-mode only. */}
      {isDraft && <AlloyPlanner
        silverVariants={silverVariants}
        onFill={(inputG, outputG) => {
          const v999 = silverVariants.find((v: any) => v.variantCode === 'SILV-999');
          const v935 = silverVariants.find((v: any) => v.variantCode === 'SILV-935');
          if (v999) {
            setInputs((rs) => [...rs, { _k: Math.random(), variantId: v999.id, weightG: inputG.toFixed(3), notes: `Planner: for ${outputG.toFixed(3)} g of 93.5` }]);
          }
          if (v935) {
            setOutputs((rs) => [...rs, { _k: Math.random(), kind: 'ALLOY', variantId: v935.id, weightG: outputG.toFixed(3), notes: '' }]);
          }
        }}
      />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Inputs */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-semibold">Inputs</h3>
            {isDraft && <Button variant="outline" size="sm" onClick={() => setInputs((rs) => [...rs, { _k: Math.random(), variantId: '', weightG: '', notes: '' }])}><Plus className="size-3.5" /> Add</Button>}
          </div>
          {inputs.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-text-faint">No inputs yet.</p>
          ) : (
            <div className="space-y-2">
              {inputs.map((r, idx) => (
                <div key={r._k} className="rounded-md border border-border bg-card p-2">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                    <div className="sm:col-span-6">
                      <SearchableSelect value={r.variantId === '' ? '' : String(r.variantId)} placeholder="— variant —"
                        onChange={(v) => setInputs((rs) => rs.map((x, i) => i === idx ? { ...x, variantId: v ? Number(v) : '' } : x))}
                        options={silverVariants.map((v: any) => ({ value: v.id, label: `${v.variantCode} · ${v.variantName}`, subtitle: `${Number(v.stockWeight).toFixed(3)} g in stock` }))}
                      />
                    </div>
                    <div className="sm:col-span-3"><Input type="number" step="0.001" placeholder="Weight (g)" value={r.weightG} onChange={(e) => setInputs((rs) => rs.map((x, i) => i === idx ? { ...x, weightG: e.target.value } : x))} /></div>
                    <div className="sm:col-span-2"><Input placeholder="Notes" value={r.notes} onChange={(e) => setInputs((rs) => rs.map((x, i) => i === idx ? { ...x, notes: e.target.value } : x))} /></div>
                    <div className="flex justify-end sm:col-span-1">
                      {isDraft && <Button variant="outline" size="icon" onClick={() => setInputs((rs) => rs.filter((_, i) => i !== idx))}><Trash2 className="size-3.5" /></Button>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 text-right text-xs font-mono">Total in: {totalIn.toFixed(3)} g</div>
        </div>

        {/* Outputs */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-semibold">Outputs</h3>
            {isDraft && <Button variant="outline" size="sm" onClick={() => setOutputs((rs) => [...rs, { _k: Math.random(), kind: 'ALLOY', variantId: '', weightG: '', notes: '' }])}><Plus className="size-3.5" /> Add</Button>}
          </div>
          {outputs.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-3 text-center text-xs text-text-faint">No outputs yet.</p>
          ) : (
            <div className="space-y-2">
              {outputs.map((r, idx) => (
                <div key={r._k} className="rounded-md border border-border bg-card p-2">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                    <div className="sm:col-span-3">
                      <Select value={r.kind} onChange={(e) => setOutputs((rs) => rs.map((x, i) => i === idx ? { ...x, kind: e.target.value as any } : x))}>
                        <option value="ALLOY">Alloy (93.5)</option>
                        <option value="RUNNERS">Runners</option>
                        <option value="LOSS">Loss</option>
                      </Select>
                    </div>
                    <div className="sm:col-span-4">
                      {r.kind === 'LOSS' ? (
                        <div className="text-xs text-text-faint">Not tracked in stock</div>
                      ) : (
                        <SearchableSelect value={r.variantId === '' ? '' : String(r.variantId)} placeholder="— variant —"
                          onChange={(v) => setOutputs((rs) => rs.map((x, i) => i === idx ? { ...x, variantId: v ? Number(v) : '' } : x))}
                          options={silverVariants.map((v: any) => ({ value: v.id, label: `${v.variantCode} · ${v.variantName}` }))}
                        />
                      )}
                    </div>
                    <div className="sm:col-span-3"><Input type="number" step="0.001" placeholder="Weight (g)" value={r.weightG} onChange={(e) => setOutputs((rs) => rs.map((x, i) => i === idx ? { ...x, weightG: e.target.value } : x))} /></div>
                    <div className="sm:col-span-1"><Input placeholder="Notes" value={r.notes} onChange={(e) => setOutputs((rs) => rs.map((x, i) => i === idx ? { ...x, notes: e.target.value } : x))} /></div>
                    <div className="flex justify-end sm:col-span-1">
                      {isDraft && <Button variant="outline" size="icon" onClick={() => setOutputs((rs) => rs.filter((_, i) => i !== idx))}><Trash2 className="size-3.5" /></Button>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-2 text-right text-xs font-mono">Total out: {totalOut.toFixed(3)} g</div>
        </div>
      </div>

      <div className={`mt-3 rounded-md p-2 text-xs ${Math.abs(diff) < 0.001 ? 'bg-success/10 text-success' : diff > 0 ? 'bg-warning/10 text-warning' : 'bg-info/10 text-info'}`}>
        Balance: {diff >= 0 ? '+' : ''}{diff.toFixed(3)} g
        {Math.abs(diff) >= 0.001 && diff > 0 && <> — will post as additional loss on melt.</>}
        {Math.abs(diff) >= 0.001 && diff < 0 && <> — outputs exceed inputs; recheck weights.</>}
      </div>
    </Dialog>
  );
}

// Quick planner: type target 93.5 output, get the 999 input required.
// Formula (operator spec):
//   input 999 (g) = target 93.5 (g) / 0.935   → round to 3 decimals.
// "Fill" appends both rows to the batch (SILV-999 input at the computed
// weight + SILV-935 output at the typed target). Operator can still edit
// or add copper/other alloy lines to bring the fineness down to exactly
// 93.5% before the melt.
function AlloyPlanner({
  silverVariants,
  onFill,
}: {
  silverVariants: any[];
  onFill: (input999: number, output935: number) => void;
}) {
  const [target, setTarget] = React.useState('');
  const t = Number(target);
  const inputG = t > 0 ? Math.round((t / 0.935) * 1000) / 1000 : 0;
  const has999 = silverVariants.some((v: any) => v.variantCode === 'SILV-999');
  const has935 = silverVariants.some((v: any) => v.variantCode === 'SILV-935');
  const canFill = t > 0 && has999 && has935;
  return (
    <div className="mb-3 rounded-lg border border-info/30 bg-info/5 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-info">
        93.5 alloy planner
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4 sm:items-end">
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-text-muted mb-1">Target 93.5 output (g)</label>
          <Input type="number" step="0.001" min="0" placeholder="e.g. 500.000"
            value={target}
            onChange={(e) => setTarget(e.target.value)} />
        </div>
        <div className="text-sm">
          <div className="text-[10px] uppercase tracking-wider text-text-muted">999 needed</div>
          <div className="font-mono font-semibold text-lg">
            {inputG > 0 ? inputG.toFixed(3) : '—'} <span className="text-xs text-text-faint">g</span>
          </div>
          <div className="text-[10px] text-text-faint">= target ÷ 0.935</div>
        </div>
        <div className="text-sm">
          <div className="text-[10px] uppercase tracking-wider text-text-muted">Alloying delta</div>
          <div className="font-mono font-semibold">
            {inputG > 0 ? (inputG - t).toFixed(3) : '—'} <span className="text-xs text-text-faint">g</span>
          </div>
          <div className="text-[10px] text-text-faint">difference = alloy metal to add</div>
        </div>
        <div>
          <Button variant="outline" className="w-full" onClick={() => onFill(inputG, t)} disabled={!canFill}>
            Fill batch
          </Button>
          {!has999 || !has935 ? (
            <div className="mt-1 text-[10px] text-warning">SILV-999 / SILV-935 variants missing.</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
