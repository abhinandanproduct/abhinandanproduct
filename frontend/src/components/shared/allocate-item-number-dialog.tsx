'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Hash, RefreshCw } from 'lucide-react';
import { Api, getApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/shared/field';
import { Spinner } from '@/components/ui/spinner';

/**
 * Allocate the sales item number (ABN-NNNN) for a design.
 *
 * Triggered once per design — after the first Packing receipt lands, the
 * operator opens this dialog from the item detail page. The server suggests
 * the next free ABN-NNNN; the operator can accept or override with any
 * unused alphanumeric value.
 *
 * Re-opening this dialog after allocation is blocked at the server (it
 * throws if itemNumber is already set), so the parent page hides the
 * trigger button after success.
 */
export function AllocateItemNumberDialog({
  itemId,
  designCode,
  open,
  onClose,
}: {
  itemId: number;
  designCode: string;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [value, setValue] = React.useState('');

  // Suggest the next free ABN-NNNN when the dialog opens. Refetches on each
  // open so a sibling allocation in another tab doesn't collide.
  const suggestQ = useQuery({
    queryKey: ['next-item-number'],
    queryFn: () => Api.items.nextItemNumber(),
    enabled: open,
    staleTime: 0,
  });

  React.useEffect(() => {
    if (open && suggestQ.data?.itemNumber && !value) {
      setValue(suggestQ.data.itemNumber);
    }
    if (!open) setValue('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, suggestQ.data?.itemNumber]);

  const allocate = useMutation({
    mutationFn: (n: string) => Api.items.allocateItemNumber(itemId, n),
    onSuccess: (res) => {
      toast.success(`Item number ${res.itemNumber} allocated to ${designCode}.`);
      qc.invalidateQueries({ queryKey: ['item', itemId] });
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['next-item-number'] });
      onClose();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && !allocate.isPending;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={`Allocate item number — ${designCode}`}
      description="Bind this design to a sales SKU. The number is set ONCE and persists for the design's lifetime."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={allocate.isPending}>Cancel</Button>
          <Button onClick={() => allocate.mutate(trimmed)} disabled={!canSubmit}>
            {allocate.isPending && <Spinner />} Allocate
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field
          label="Item Number"
          hint="Suggested: next free ABN-NNNN. Override with any unused alphanumeric value."
        >
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={value}
              placeholder={suggestQ.data?.itemNumber ?? 'ABN-0001'}
              onChange={(e) => setValue(e.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              title="Reload suggestion"
              onClick={() => {
                suggestQ.refetch().then((r) => {
                  if (r.data?.itemNumber) setValue(r.data.itemNumber);
                });
              }}
              disabled={suggestQ.isFetching}
            >
              <RefreshCw className={`size-4 ${suggestQ.isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </Field>
        <div className="rounded-md border border-border bg-secondary/30 p-3 text-xs text-text-muted">
          <div className="flex items-start gap-2">
            <Hash className="mt-0.5 size-3.5 shrink-0 text-gold" />
            <span>
              Once allocated, future orders for {designCode} will reference both the design
              code and the item number. The action is auditable but not undoable in-place —
              if you allocate the wrong number, contact an admin to reverse via Audit Log.
            </span>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
