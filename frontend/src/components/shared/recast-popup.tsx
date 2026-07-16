'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

interface PendingRecast {
  id: number;
  designCode: string | null;
  partName: string;
  qtyMissing: number;
  batchNumber: string | null;
}

/**
 * One popup per missing-part row — operator picks "recast in same batch",
 * "new batch", or "later". Used:
 *   - On receive-form save when lost qty > 0 (we re-fetch pending list and
 *     show the rows added by THIS receipt).
 *   - From the dashboard "Pending Recasts" card row click.
 */
export function RecastPopup({
  open,
  rows,
  onClose,
}: {
  open: boolean;
  rows: PendingRecast[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [idx, setIdx] = React.useState(0);
  React.useEffect(() => { if (open) setIdx(0); }, [open]);

  const recast = useMutation({
    mutationFn: (p: { id: number; where: 'SAME_BATCH' | 'NEW_BATCH' }) =>
      Api.missingParts.recast(p.id, p.where),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['casting-batch'] });
      qc.invalidateQueries({ queryKey: ['casting-batches'] });
      qc.invalidateQueries({ queryKey: ['pending-recasts'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  if (!rows.length) return null;
  const cur = rows[idx];
  if (!cur) return null;

  const advance = () => {
    if (idx + 1 < rows.length) {
      setIdx(idx + 1);
    } else {
      toast.success('All missing-part recasts resolved.');
      onClose();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Recast ${cur.designCode ?? 'design'} · ${cur.partName}`}
      description={`${cur.qtyMissing} pc${cur.qtyMissing === 1 ? '' : 's'} marked missing. Pick where to recast — or postpone via "Later".`}
      footer={
        <>
          <Button variant="outline" onClick={() => { advance(); }} disabled={recast.isPending}>
            Later
          </Button>
          {cur.batchNumber && (
            <Button variant="outline" onClick={async () => {
              await recast.mutateAsync({ id: cur.id, where: 'SAME_BATCH' });
              toast.success(`Added casting line to ${cur.batchNumber}.`);
              advance();
            }} disabled={recast.isPending}>
              {recast.isPending && <Spinner />} Recast in {cur.batchNumber}
            </Button>
          )}
          <Button onClick={async () => {
            const res: any = await recast.mutateAsync({ id: cur.id, where: 'NEW_BATCH' });
            toast.success(`New batch created (id ${res?.targetBatchId}).`);
            advance();
          }} disabled={recast.isPending}>
            {recast.isPending && <Spinner className="text-primary-foreground" />} Recast in new batch
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm">
        <div className="rounded-md border border-warning/30 bg-warning/10 p-3">
          <div className="font-semibold text-warning">{cur.qtyMissing} pc{cur.qtyMissing === 1 ? '' : 's'} of "{cur.partName}"</div>
          {cur.batchNumber && (
            <div className="text-xs text-muted-foreground">From batch {cur.batchNumber}</div>
          )}
        </div>
        {rows.length > 1 && (
          <div className="text-xs text-muted-foreground">
            {idx + 1} of {rows.length} pending — answer each one.
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          <b>Same batch:</b> adds a fresh CASTING line in the original batch — same vendor flow, ties back to the same order.<br />
          <b>New batch:</b> spawns a standalone batch with just this design × qty. Independent vendor / colour choices.<br />
          <b>Later:</b> keep on the dashboard "Pending Recasts" card and decide when the operator has time.
        </p>
      </div>
    </Dialog>
  );
}
