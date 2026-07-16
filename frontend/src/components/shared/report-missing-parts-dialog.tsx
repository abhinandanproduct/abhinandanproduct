'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import { Api, getApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Field } from '@/components/shared/field';

/**
 * Report Missing Parts — opened from a receive-form row when the
 * operator notices the karigar returned a set short some pieces (e.g.
 * "8 full sets, 2 sets missing one earring each"). One row per design
 * part with a Qty Missing input; submitting creates MissingPart records
 * on the backend. The design's detail page then surfaces a "Recast
 * missing parts" CTA that bundles them into a new casting batch.
 */
export function ReportMissingPartsDialog({
  stageId,
  itemId,
  designCode,
  open,
  onClose,
  onReported,
}: {
  stageId: number | null;
  itemId: number | null;
  designCode: string | null;
  open: boolean;
  onClose: () => void;
  onReported?: () => void;
}) {
  const qc = useQueryClient();
  const [notes, setNotes] = React.useState('');
  const [qtyByPart, setQtyByPart] = React.useState<Record<string, string>>({});

  const itemQ = useQuery({
    queryKey: ['item', itemId],
    queryFn: () => Api.items.get(itemId!),
    enabled: open && itemId != null,
  });

  React.useEffect(() => {
    if (open) {
      setQtyByPart({});
      setNotes('');
    }
  }, [open, stageId]);

  const parts: Array<{ partName: string; qtyPerSet: number; weightPerPc: number }> =
    (itemQ.data as any)?.designParts ?? [];

  const totalMissing = Object.values(qtyByPart).reduce((s, v) => s + (Number(v) || 0), 0);

  const submit = useMutation({
    mutationFn: () => {
      if (!stageId) throw new Error('No stage');
      const payload = {
        parts: parts
          .map((p) => ({
            partName: p.partName,
            qtyMissing: Number(qtyByPart[p.partName] ?? 0),
            notes: notes.trim() || undefined,
          }))
          .filter((p) => p.qtyMissing > 0),
      };
      if (!payload.parts.length) throw new Error('Enter qty missing for at least one part.');
      return Api.casting.reportMissingParts(stageId, payload);
    },
    onSuccess: (res) => {
      toast.success(`Flagged ${res.created.length} missing-part record${res.created.length === 1 ? '' : 's'}.`);
      qc.invalidateQueries({ queryKey: ['item', itemId] });
      qc.invalidateQueries({ queryKey: ['casting-batch'] });
      onReported?.();
      onClose();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={`Report missing parts${designCode ? ` — ${designCode}` : ''}`}
      description="Pieces returned short of the set. Flag the missing parts here; the design's detail page will surface a Recast button to bundle them into a new casting batch."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submit.isPending}>Cancel</Button>
          <Button onClick={() => submit.mutate()} disabled={submit.isPending || totalMissing === 0}>
            {submit.isPending && <Spinner />}
            <AlertTriangle className="size-4" />
            Flag {totalMissing > 0 ? `${totalMissing} piece${totalMissing === 1 ? '' : 's'}` : ''}
          </Button>
        </>
      }
    >
      {itemQ.isLoading ? (
        <div className="flex items-center justify-center py-8"><Spinner /></div>
      ) : !parts.length ? (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          This design has no parts configured in the Item Master. Add design parts (pendant, earring, patti…) first.
        </div>
      ) : (
        <div className="space-y-3">
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-secondary/40 text-left text-text-faint">
                <tr>
                  <th className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider">Part</th>
                  <th className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-right">Qty / Set</th>
                  <th className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-right">Wt / Pc (g)</th>
                  <th className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider">Qty Missing</th>
                </tr>
              </thead>
              <tbody>
                {parts.map((p) => (
                  <tr key={p.partName} className="border-t border-border">
                    <td className="px-3 py-2 font-medium">{p.partName}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.qtyPerSet}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{Number(p.weightPerPc).toFixed(3)}</td>
                    <td className="px-3 py-2">
                      <Input
                        type="number" min="0" step="1"
                        className="h-8 w-24"
                        placeholder="0"
                        value={qtyByPart[p.partName] ?? ''}
                        onChange={(e) => setQtyByPart((s) => ({ ...s, [p.partName]: e.target.value.replace(/[^0-9]/g, '') }))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Field label="Notes (optional)">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. lost in transit, broken at karigar" />
          </Field>
        </div>
      )}
    </Dialog>
  );
}
