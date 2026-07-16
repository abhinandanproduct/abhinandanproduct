'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Sparkles } from 'lucide-react';
import { Api, getApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Field } from '@/components/shared/field';
import { ImageUpload } from '@/components/shared/image-upload';
import { Spinner } from '@/components/ui/spinner';

/**
 * Quick Add Item — the absolute minimal form to get a new design into
 * Item Master as PRODUCTION_READY so it can enter a batch the same day.
 * Process specs, vendor lists, BOM etc. stay empty and get filled in
 * automatically as batches run against this design.
 *
 * Intended workflow for the operator: open this dialog, type item number
 * + name + designer short, optionally upload an image, hit Save. The
 * item is created production-ready. Operator then clicks Create Batch
 * and picks it from the dropdown (per the user's choice — Quick Add
 * does NOT auto-jump to Create Batch).
 */
export function QuickAddItem({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved?: (item: { id: number; sampleDesignCode: string }) => void;
}) {
  const qc = useQueryClient();
  const [itemNumber, setItemNumber] = React.useState('');
  const [itemName, setItemName] = React.useState('');
  const [designerName, setDesignerName] = React.useState('');
  const [designerShort, setDesignerShort] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [imagePaths, setImagePaths] = React.useState<string[]>([]);
  // Designer picker — same data source as the full Item Master form:
  // vendors with the Design/CAD process (carrying a short name). Picking
  // one auto-fills both `designerName` + `designerShort`, so the operator
  // doesn't need to retype either every time. Free-text inputs stay
  // available as fallback for brand-new designers (which they can add
  // properly later via Vendors → Design/CAD).
  const metaQ = useQuery<{ designers?: Array<{ id: number; vendorName: string; shortName?: string | null }> }>({
    queryKey: ['item-meta'],
    queryFn: () => Api.items.meta(),
    enabled: open,
  });
  const designers = metaQ.data?.designers ?? [];

  // Preview the sample design code that the backend will assign — uses
  // the designer's short name as the prefix (e.g. TVM → TVM-001). Empty
  // short → empty preview, code will still be auto-generated server-side.
  const previewQ = useQuery({
    queryKey: ['next-design-code', designerShort],
    queryFn: () => Api.items.nextDesignCode(designerShort.trim() || undefined),
    enabled: open && designerShort.trim().length > 0,
    staleTime: 5000,
  });

  React.useEffect(() => {
    if (open) {
      setItemNumber('');
      setItemName('');
      setDesignerName('');
      setDesignerShort('');
      setNotes('');
      setImagePaths([]);
    }
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      Api.items.create({
        // Every field other than the explicit ones falls back to backend
        // defaults — empty processes, empty BOM, empty vendor lists.
        itemNumber: itemNumber.trim() || undefined,
        itemName: itemName.trim() || undefined,
        designerName: designerName.trim() || undefined,
        designerShortName: designerShort.trim() || undefined,
        notes: notes.trim() || undefined,
        images: imagePaths,
        // KEY DIFFERENTIATOR — Quick Add stamps the item as production-
        // ready immediately. Standard create-item form leaves it at DRAFT
        // until the user explicitly bumps it up.
        sampleStatus: 'PRODUCTION_READY' as const,
        processes: [],
        materials: [],
        colorModels: [],
      }),
    onSuccess: (item: any) => {
      toast.success(`Item ${item.sampleDesignCode} created (production-ready). You can now add it to a batch.`);
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['item-meta'] });
      onSaved?.({ id: item.id, sampleDesignCode: item.sampleDesignCode });
      onClose();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={<span className="inline-flex items-center gap-2"><Sparkles className="size-4 text-primary" /> Quick Add Item</span>}
      description="Bare-minimum entry to make a design production-ready. Processes / BOM / vendors fill in automatically as batches run against this design."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending && <Spinner />} Save (Production Ready)
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Item Number" hint="optional — your internal number">
            <Input value={itemNumber} onChange={(e) => setItemNumber(e.target.value)} placeholder="e.g. 9252" />
          </Field>
          <Field label="Item Name" hint="optional">
            <Input value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="e.g. Royal Earrings" />
          </Field>
        </div>

        <Field
          label="Designer"
          hint={designers.length
            ? 'Pick a designer — name + short auto-fill. Add a Design/CAD vendor (with short name) to add more.'
            : 'No designers configured yet. Add a Design/CAD vendor with a short name in Vendors, then pick here.'}
        >
          <SearchableSelect
            value={designers.find((d) => d.vendorName === designerName)?.id ?? ''}
            placeholder="— Select designer —"
            onChange={(v) => {
              const d = designers.find((x) => String(x.id) === v);
              if (d) {
                setDesignerName(d.vendorName);
                setDesignerShort((d.shortName ?? '').toUpperCase());
              } else {
                setDesignerName(''); setDesignerShort('');
              }
            }}
            options={designers.map((d) => ({
              value: d.id,
              label: `${d.vendorName}${d.shortName ? ` (${d.shortName})` : ''}`,
              keywords: d.shortName ?? '',
            }))}
          />
        </Field>

        {previewQ.data && (
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
            <span className="text-muted-foreground">Sample code preview:</span>{' '}
            <code className="font-semibold text-foreground">{previewQ.data.sampleDesignCode}</code>
          </div>
        )}

        <Field label="Notes" hint="optional — anything memorable about this design">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. matches XYZ collection, customer Mr. Sharma" />
        </Field>

        <Field label="Image" hint="optional — drop a photo so the design is recognisable">
          <ImageUpload module="items" value={imagePaths} onChange={setImagePaths} />
        </Field>

        <div className="rounded-md border border-amber-200 bg-warning/10 p-2.5 text-xs text-amber-900">
          <b>Heads up:</b> processes / BOM / vendor lists are deliberately left empty.
          As you run batches, the system auto-saves vendor picks, rates, colours and
          weights back to this Item Master — no manual entry needed.
        </div>
      </div>
    </Dialog>
  );
}
