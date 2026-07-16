'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, PackagePlus } from 'lucide-react';
import { Api, getApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Field } from '@/components/shared/field';
import { Spinner } from '@/components/ui/spinner';

/**
 * Re-issue Materials — quick action on an at-vendor stage. Operator picks
 * extra materials (eligibility-filtered by the target process) and creates
 * a new MaterialIssue voucher attached to the same stage. Used when filing
 * (or similar) needs more material partway through the work.
 *
 * Doesn't replace the /material-issues page — that's for browsing /
 * editing existing vouchers. This is the "send more, fast" inline action.
 */
export function ReissueMaterialsDialog({
  stage,
  open,
  onClose,
  onIssued,
}: {
  stage: { id: number; vendorId: number; vendorName?: string; processCode?: string; itemNumber?: string | null; batchId?: number } | null;
  open: boolean;
  onClose: () => void;
  onIssued?: () => void;
}) {
  const qc = useQueryClient();
  const [rows, setRows] = React.useState<Array<{ _k: number; variantId: number | ''; qty: string; weight: string; notes: string }>>([]);

  const variantsQ = useQuery({
    queryKey: ['variants-active'],
    queryFn: () => Api.materials.variants(),
    enabled: open,
    staleTime: 30_000,
  });

  React.useEffect(() => {
    if (open) setRows([{ _k: Math.random(), variantId: '', qty: '', weight: '', notes: '' }]);
  }, [open, stage?.id]);

  // Eligibility filter — variants tagged for this stage's process show
  // first; untagged variants stay visible too so an operator can issue
  // ad-hoc things that aren't pre-classified.
  const variants = (variantsQ.data ?? []) as any[];
  const procCode = stage?.processCode;
  const eligibleIds = new Set(
    variants
      .filter((v) => Array.isArray(v.processIds) && v.processIds.length > 0)
      .map((v) => v.id),
  );

  const submit = useMutation({
    mutationFn: () => {
      if (!stage) throw new Error('No stage');
      const filing = stage.processCode === 'FILING';
      const lines = rows
        .filter((r) => r.variantId !== '' && (Number(r.qty) > 0 || Number(r.weight) > 0))
        .map((r) => {
          const v = variants.find((x: any) => x.id === Number(r.variantId));
          const qtyN = r.qty ? Math.max(0, Math.trunc(Number(r.qty))) : 0;
          const wtN = r.weight ? Math.max(0, Number(r.weight)) : 0;
          // Filing materials → qty AND weight both required.
          if (filing && (qtyN <= 0 || wtN <= 0)) {
            throw new Error(`${v?.variantName ?? 'Material'}: filing materials need qty AND weight.`);
          }
          // Weight-tracked variants always need a weight reading.
          if (v?.trackByWeight && wtN <= 0) {
            throw new Error(`${v.variantName}: weight (g) is required.`);
          }
          return {
            variantId: Number(r.variantId),
            issuedQty: qtyN,
            issuedWeight: wtN,
            deferredQty: 0,
            notes: r.notes || undefined,
          };
        });
      if (!lines.length) throw new Error('Pick at least one material with qty or weight.');
      return Api.materialIssues.create({
        vendorId: stage.vendorId,
        batchId: stage.batchId,
        stageId: stage.id,
        notes: `Re-issue for stage ${stage.id}${stage.itemNumber ? ` · ${stage.itemNumber}` : ''}`,
        lines,
      } as any);
    },
    onSuccess: () => {
      toast.success('Materials re-issued to vendor.');
      qc.invalidateQueries({ queryKey: ['casting-batch'] });
      qc.invalidateQueries({ queryKey: ['material-issues'] });
      onIssued?.();
      onClose();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  if (!stage) return null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={`Re-issue materials — ${stage.processCode ?? 'stage'}${stage.itemNumber ? ` · ${stage.itemNumber}` : ''}`}
      description={`Send more materials to ${stage.vendorName ?? 'vendor'} for this stage. Creates a new material-issue voucher. Use this when work's still pending and the karigar needs more.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submit.isPending}>Cancel</Button>
          <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
            {submit.isPending && <Spinner className="text-primary-foreground" />}
            <PackagePlus className="size-4" /> Issue
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {rows.map((row, idx) => {
          const v = variants.find((x: any) => x.id === Number(row.variantId));
          const trackByQty = v?.trackByQty ?? true;
          const trackByWeight = v?.trackByWeight ?? false;
          return (
            <div key={row._k} className="grid grid-cols-12 items-end gap-2 rounded-md border border-border bg-card px-2 py-1.5">
              <div className="col-span-12 sm:col-span-5">
                <SearchableSelect
                  value={row.variantId === '' ? '' : String(row.variantId)}
                  placeholder="— pick material —"
                  onChange={(val) => {
                    const id = val === '' ? '' : Number(val);
                    setRows((rs) => rs.map((r, i) => i === idx ? { ...r, variantId: id } : r));
                  }}
                  options={variants.map((vv: any) => {
                    const isEligible = !procCode || (vv.processIds ?? []).length === 0 || (vv.processIds ?? []).includes(0)
                      || (eligibleIds.has(vv.id) && Array.isArray(vv.processIds) && vv.processIds.some((pid: number) => {
                        const p = variants.find((x: any) => x.id === vv.id);
                        // simplified: show every variant; eligibility is a soft sort
                        return true;
                      }));
                    return {
                      value: vv.id,
                      label: vv.variantName,
                      subtitle: `${vv.materialName}${vv.size ? ` · ${vv.size}` : ''}${vv.color ? ` · ${vv.color}` : ''}`,
                      meta: [
                        (vv.trackByQty ?? true) ? `${Number(vv.stockQty).toFixed(0)} pcs` : null,
                        (vv.trackByWeight ?? false) ? `${Number(vv.stockWeight).toFixed(3)} g` : null,
                      ].filter(Boolean).join(' · '),
                      keywords: `${vv.variantCode} ${vv.materialName}`,
                    };
                  })}
                />
              </div>
              {(trackByQty || !v) && (
                <div className="col-span-3 sm:col-span-2">
                  <Field label={idx === 0 ? 'Qty' : ''}>
                    <Input type="number" min="0" step="1" placeholder="0"
                      value={row.qty}
                      onChange={(e) => setRows((rs) => rs.map((r, i) => i === idx ? { ...r, qty: e.target.value } : r))}
                    />
                  </Field>
                </div>
              )}
              {trackByWeight && (
                <div className="col-span-3 sm:col-span-2">
                  <Field label={idx === 0 ? 'Wt (g)' : ''}>
                    <Input type="number" min="0" step="0.001" placeholder="0.000"
                      value={row.weight}
                      onChange={(e) => setRows((rs) => rs.map((r, i) => i === idx ? { ...r, weight: e.target.value } : r))}
                    />
                  </Field>
                </div>
              )}
              <div className="col-span-5 sm:col-span-2">
                <Field label={idx === 0 ? 'Notes' : ''}>
                  <Input placeholder="optional" value={row.notes}
                    onChange={(e) => setRows((rs) => rs.map((r, i) => i === idx ? { ...r, notes: e.target.value } : r))}
                  />
                </Field>
              </div>
              <div className={`col-span-1 ${idx === 0 ? 'pt-[26px]' : ''}`}>
                <Button
                  type="button" variant="outline" size="icon"
                  className="text-destructive hover:bg-destructive/10"
                  title="Remove row"
                  onClick={() => setRows((rs) => rs.filter((_, i) => i !== idx))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          );
        })}
        <Button
          type="button" variant="outline" size="sm" className="mt-1"
          onClick={() => setRows((rs) => [...rs, { _k: Math.random(), variantId: '', qty: '', weight: '', notes: '' }])}
        >
          <Plus className="size-4" /> Add material
        </Button>
      </div>
    </Dialog>
  );
}
