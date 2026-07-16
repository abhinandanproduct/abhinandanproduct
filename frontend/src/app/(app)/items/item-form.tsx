'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft, Save, CheckCircle2, Plus, Trash2, FileUp, Star,
  Settings2, UploadCloud, Info, Eye, Boxes, Copy, AlertTriangle, RotateCw,
} from 'lucide-react';
import { Api, getApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Accordion, AccordionItem } from '@/components/ui/accordion';
import { Dialog } from '@/components/ui/dialog';
import { Field, SectionTitle } from '@/components/shared/field';
import { ImageUpload } from '@/components/shared/image-upload';
import { Spinner } from '@/components/ui/spinner';
import { cn, fileUrl, formatCurrency, SAMPLE_STATUS_LABELS } from '@/lib/utils';
import type { ItemMeta, Item } from '@/lib/types';

const schema = z.object({
  itemNumber: z.string().optional(),
  category: z.string().max(80).optional(),
  subcategory: z.string().max(80).optional(),
  collection: z.string().max(80).optional(),
  notes: z.string().optional(),
  designType: z.string().optional(),
  designerName: z.string().max(120).optional(),
  designerShortName: z.string().max(20).optional(),
  designCost: z.string().optional(),
  sellingPrice: z.string().optional(),
  sampleStatus: z.enum(['DRAFT', 'IN_DEVELOPMENT', 'SAMPLE_READY', 'PRODUCTION_READY']),
});
type FormValues = z.infer<typeof schema>;

interface FormVendor {
  vendorId: number; vendorDesignReference?: string; color?: string; colorPhotoPath?: string;
  costPerPiece?: string; isPreferred?: boolean; bringsOwnMaterials?: boolean; notes?: string;
}
interface ProcState {
  notes: string;
  attributes: Record<string, string>;
  photos: string[];
  vendors: FormVendor[];
  services: { serviceId: number; cost?: string }[];
}

const STEPS = ['design', 'basic', 'process'] as const;
type Step = (typeof STEPS)[number];
const STEP_LABEL: Record<Step, string> = { design: 'Design', basic: 'Basic Info', process: 'Processes' };

export function ItemForm({ itemId }: { itemId?: number }) {
  const router = useRouter();
  const qc = useQueryClient();
  const metaQ = useQuery<ItemMeta>({
    queryKey: ['item-meta'],
    queryFn: () => Api.items.meta(),
    // Auto-refetch when the user returns to this tab — covers the case
    // where they open the Material Variants page in a new tab via the
    // BOM picker's "+ New Material Variant", create a variant there,
    // and switch back. Without this, the new variant only appears
    // after saving the draft + reload (annoying). With refetchOnWindowFocus
    // the dropdown picks it up the moment focus returns.
    refetchOnWindowFocus: true,
  });
  // Distinct Category / Subcategory / Collection values across every item.
  // Drives the dropdowns on the Basic Info step so existing taxonomy is
  // reused (no more "Ring" vs "ring" duplicates), with an inline + Add
  // path when a brand-new value is needed.
  const lookupsQ = useQuery({ queryKey: ['item-lookups'], queryFn: () => Api.items.lookups() });
  // Deep-link from elsewhere (Forward Dialog's "Add Colour" button) to a
  // specific process's accordion — opens it pre-expanded and scrolls to it.
  const searchParams = useSearchParams();
  const focusProcessId = Number(searchParams?.get('focusProcess') ?? '') || null;
  React.useEffect(() => {
    if (!focusProcessId) return;
    // Wait a beat for the accordion to mount + expand, then jump to it.
    const t = setTimeout(() => {
      const el = document.getElementById(`process-${focusProcessId}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 250);
    return () => clearTimeout(t);
  }, [focusProcessId, metaQ.data]);

  const [step, setStep] = React.useState<Step>('design');
  const [existingImages, setExistingImages] = React.useState<{ id: number; path: string }[]>([]);
  const [imagePaths, setImagePaths] = React.useState<string[]>([]);
  const [cadPath, setCadPath] = React.useState<string | undefined>();
  const [cadUploading, setCadUploading] = React.useState(false);
  const [cadViewerOpen, setCadViewerOpen] = React.useState(false);
  const [procState, setProcState] = React.useState<Record<number, ProcState>>({});
  const [sampleCode, setSampleCode] = React.useState<string>('');
  // Design parts — pendant / earring / patti. Per-piece weight × qty per set
  // drives the planned issue weight at Casting. Order preserved as the
  // operator typed it; empty by default for new designs (a small "+ Add
  // Part" UX is rendered in the Basic Info step).
  const [designParts, setDesignParts] = React.useState<Array<{ _k: string; partName: string; qtyPerSet: string; weightPerPc: string; photoPath: string; notes: string }>>([]);
  const newDesignPart = () => ({ _k: Math.random().toString(36).slice(2, 9), partName: '', qtyPerSet: '1', weightPerPc: '', photoPath: '', notes: '' });
  // BOM rows (materials consumed by Sticking / Kacha Fitting / Fitting / Packing).
  //   • processId — which process this BOM line belongs to (set when added).
  //     Older Sticking-only data without a processId is treated as Sticking
  //     by the backend default; the loader fills it in from the response.
  //   • color — sticking-colour split (Sticking only — others ignore).
  //   • rate  — per-line override of the variant's master price. Blank =
  //     use the master price; non-blank = override for cost calc + slip.
  const [bom, setBom] = React.useState<{
    variantId: number | '';
    quantity: string;
    notes: string;
    color?: string;
    processId?: number;
    rate?: string;
    // Client-only marker — when a Copy-from operation couldn't find an
    // equivalent variant in the target colour, the cloned row lands empty
    // and this stashes WHICH source we were trying to clone. The "+ Create
    // {colour} variant" chip in the row uses these to one-click create the
    // missing variant and auto-fill the row. Never sent to the backend.
    _unresolvedCopy?: { sourceVariantId: number; targetColour: string };
  }[]>([]);
  // Snapshot of rates AS LOADED — keyed by `processId|variantId|color`. On
  // save we compare every row against this map; any line where the rate has
  // changed surfaces a small confirm dialog so the user explicitly chooses
  // whether to commit the new rate or revert to the previous one. Empty
  // for create mode (no "previous" rate exists yet).
  const [originalRates, setOriginalRates] = React.useState<Map<string, string>>(new Map());
  // Open when rate changes are detected on submit. Holds the diff rows +
  // the user's per-row pick (old/new). Re-fires save once confirmed.
  const [rateChangeDialog, setRateChangeDialog] = React.useState<{
    pendingPayload: any;
    forceDraft: boolean;
    changes: { idx: number; variantId: number; variantName: string; processName: string; color: string; oldRate: string; newRate: string; pick: 'old' | 'new' }[];
  } | null>(null);

  // Open when the user flips a Sticking vendor's "Brings own materials" toggle.
  // Asks for the new rate so the user understands the semantic change:
  //   OFF→ON  rate is now per PIECE (flat, includes materials)
  //   ON→OFF  rate is back to per STONE (labor only, materials added separately)
  // Pre-fills the current rate as the default — the user can keep it or
  // type a new one. Cancel reverts the toggle (no change applied).
  const [brOwnDialog, setBrOwnDialog] = React.useState<{
    pid: number;
    idx: number;
    nextValue: boolean;  // what the toggle wants to become
    oldRate: string;
    newRate: string;
  } | null>(null);

  const {
    register, handleSubmit, reset, watch, setValue,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { sampleStatus: 'DRAFT' } });

  const designers = metaQ.data?.designers ?? [];
  const services = metaQ.data?.services ?? [];
  const variants = metaQ.data?.variants ?? [];
  const shortName = watch('designerShortName');
  const designCostNum = Number(watch('designCost') || 0);
  // Item Master excludes Design/CAD (handled above) and batch-only processes (e.g. Antique).
  const processSections = (metaQ.data?.processes ?? []).filter((p) => p.code !== 'CAM' && !p.batchOnly);

  // Colour code resets PER PROCESS: each colour process letters its own colours a/b/c.
  const itemNumberVal = watch('itemNumber');
  const colourLetterMap = React.useMemo(() => {
    const m = new Map<string, string>(); // `${processId}:${name}` -> letter
    for (const p of processSections) {
      if (!p.usesColor) continue;
      let i = 0;
      for (const v of procState[p.id]?.vendors ?? []) {
        const nm = (v.color ?? '').trim();
        if (!nm) continue;
        const key = `${p.id}:${nm.toLowerCase()}`;
        if (!m.has(key)) { m.set(key, String.fromCharCode(97 + i)); i++; }
      }
    }
    return m;
  }, [processSections, procState]);
  const colourCode = (pid: number, name?: string) => {
    const nm = (name ?? '').trim();
    const letter = nm ? colourLetterMap.get(`${pid}:${nm.toLowerCase()}`) : undefined;
    if (!itemNumberVal || !letter) return '';
    return `${itemNumberVal}(${letter})-${nm}`;
  };

  // A single BOM material row — reused across Sticking colour panels AND
  // the shared Kacha Fitting / Fitting / Packing BOM panels. The Rate
  // input lets the user override the variant's master price PER LINE: when
  // blank we use v.price (shown muted as a placeholder), when set we
  // apply the override on cost calc and slip rendering. The "↺" reset
  // button clears the override.
  // ── Sticking-BOM "Copy from another colour" ──────────────────────────
  // Flexible colour-string parser: "Ruby Green", "Ruby+Green", "Ruby/Green",
  // "Ruby, Green" all → ["Ruby", "Green"]. Employees use whatever separator
  // feels right; we accept all.
  const parseColours = React.useCallback(
    (raw: string | null | undefined): string[] =>
      (raw ?? '')
        .split(/[\s+/,;|]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [],
  );

  // Structural match — find the variant of the SAME stone (same materialId
  // × size × shape × finish) but in `targetColour`. Returns null if no
  // such variant exists in the master.
  const findEquivalentVariant = React.useCallback(
    (sourceVariantId: number, targetColour: string) => {
      const source = variants.find((v) => v.id === sourceVariantId);
      if (!source) return null;
      // Colour-agnostic source row → return source unchanged (keeps the
      // same variantId across colours, e.g. clear pearls used everywhere).
      if (!source.color || !source.color.trim()) return source;
      const t = targetColour.trim().toLowerCase();
      const srcCol = source.color.trim().toLowerCase();
      // PRESERVATION CASE — when target colour equals the source's own
      // colour, the source IS the answer. Without this, the matcher would
      // search OTHER variants matching the structural quadruple AND in
      // that colour, and find nothing if the source is the only variant
      // in that colour for that stone (which is the common case for
      // "shared neutral" colours like shadow / white that get preserved
      // by the smart mapping rule). Result: false "no shadow variant of
      // shadow-10 exists" chips on every preserved row.
      if (srcCol === t) return source;
      return (
        variants.find(
          (v) =>
            v.id !== source.id &&
            v.materialId === source.materialId &&
            (v.size ?? '') === (source.size ?? '') &&
            (v.shape ?? '') === (source.shape ?? '') &&
            (v.finish ?? '') === (source.finish ?? '') &&
            (v.color ?? '').trim().toLowerCase() === t,
        ) ?? null
      );
    },
    [variants],
  );

  // Mapping-dialog state for combo copies (Phase 2). null = no dialog open.
  const [copyMapping, setCopyMapping] = React.useState<{
    targetVendorIdx: number;
    targetProcId: number;
    sourceColourLabel: string;     // e.g. "Ruby Green" (sticking-colour, NOT variant-colour)
    targetColourLabel: string;     // e.g. "Pink Blue"
    sourceVariantColours: string[]; // distinct variant colours found in source rows
    targetParsedColours: string[];  // parseColours(targetColourLabel)
    mapping: Record<string, string>; // sourceVariantColour → targetVariantColour
    sourceRows: typeof bom;
  } | null>(null);

  // Inline "+ Create {colour} variant" — calls the bulk endpoint for a
  // single colour. Fires after the user clicks the chip on a row whose
  // auto-match failed. On success, refetches meta + auto-assigns the
  // newly-created variant id to the row.
  const createVariantMutation = useMutation({
    mutationFn: async (args: { sourceVariantId: number; targetColour: string }) => {
      const source = variants.find((v) => v.id === args.sourceVariantId);
      if (!source) throw new Error('Source variant not found.');
      // Find which vendor row is preferred (Sticking) so we can pick a
      // sensible default supplier for the new variant. Falls back to the
      // source variant's own preferred vendor in a future iteration; for
      // now we surface a friendly error if the user has no vendor set.
      const supplierId = await pickDefaultSupplier(source.id);
      if (!supplierId) throw new Error('Set a Raw Material Supplier for this variant first.');
      const res = await Api.materials.bulkCreateColorVariants({
        materialName: source.materialName,
        size: source.size ?? undefined,
        shape: source.shape ?? undefined,
        finish: source.finish ?? undefined,
        unit: source.unit ?? undefined,
        vendorId: supplierId,
        colors: [{ color: args.targetColour }],
      });
      return res.created[0];
    },
    onSuccess: async (created) => {
      toast.success(`Created "${created.color}" variant (${created.variantCode}).`);
      // Refresh meta to load the new variant id, then auto-assign it to
      // every row that's currently empty AND was targeting this colour.
      await metaQ.refetch();
      setBom((rs) =>
        rs.map((r) =>
          r.variantId === '' &&
          r._unresolvedCopy &&
          r._unresolvedCopy.targetColour.trim().toLowerCase() === created.color.trim().toLowerCase()
            ? { ...r, variantId: created.id, _unresolvedCopy: undefined }
            : r,
        ),
      );
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  // Find a supplier id for inline-create. Pulls from the SOURCE variant's
  // own vendor list (which we don't have on VariantLite) by calling the
  // detail endpoint; falls back to null if no supplier is set.
  const pickDefaultSupplier = async (variantId: number): Promise<number | null> => {
    try {
      const v: any = await Api.materials.getVariant(variantId);
      const pref = (v.vendors ?? []).find((vv: any) => vv.isPreferred) ?? (v.vendors ?? [])[0];
      return pref?.vendorId ?? null;
    } catch {
      return null;
    }
  };

  // The core copy operation. Used by both the direct path (single colour)
  // and the post-mapping path (combo). Clones source rows into the target
  // sticking colour and resolves each row's variantId via the mapping.
  //
  // Resolution order for each row's TARGET colour:
  //   (1) Explicit operator mapping (from the dialog) → wins outright.
  //   (2) Else if the source variant's colour appears in the source LABEL
  //       (e.g. variant "Ruby" inside source label "Ruby") → zip by
  //       position to the target label ("Ruby Green" → "Pink Blue" gives
  //       Ruby→Pink, Green→Blue). Falls back to the last target slot.
  //   (3) Else (shared / neutral colour like "shadow" or "white" that
  //       never appears in either label) → PRESERVE as-is. The shadow
  //       diamond stays a shadow diamond whether the target is green,
  //       blue or pink.
  //
  // Step (3) used to live ONLY in the dialog's smart-default init, so
  // the Phase 1 trivial path (single source variant colour + single
  // target colour) silently remapped shadow → target colour. Centralised
  // here so BOTH paths preserve shared colours uniformly.
  const applyCopy = (opts: {
    sourceRows: typeof bom;
    targetProcId: number;
    sourceColourLabel: string;
    targetVendorColour: string;
    /** variantColour-from → variantColour-to. Empty for the trivial
     *  path; populated by the dialog. Operator overrides win over the
     *  parse-label-and-preserve logic below. */
    colourMap: Record<string, string>;
  }) => {
    const sourceParsed = parseColours(opts.sourceColourLabel);
    const targetParsed = parseColours(opts.targetVendorColour);
    let resolved = 0;
    let unresolved = 0;
    const newRows = opts.sourceRows.map((r) => {
      const srcVariant = variants.find((v) => v.id === Number(r.variantId));
      if (!srcVariant) return null;
      const srcColour = (srcVariant.color ?? '').trim();
      // Colour-agnostic row → keep the variant as-is.
      if (!srcColour) {
        resolved++;
        return {
          variantId: srcVariant.id,
          quantity: r.quantity,
          notes: r.notes,
          rate: r.rate,
          color: opts.targetVendorColour,
          processId: opts.targetProcId,
        };
      }
      // Resolve target colour for THIS variant — operator mapping first,
      // then "in source label? zip by position : preserve" rule.
      let mapped: string;
      const userMapping = opts.colourMap[srcColour.toLowerCase()];
      if (userMapping !== undefined && userMapping.trim() !== '') {
        mapped = userMapping.trim();
      } else {
        const idx = sourceParsed.findIndex((p) => p.toLowerCase() === srcColour.toLowerCase());
        if (idx >= 0) {
          // In source label → map by position to target.
          mapped = targetParsed[idx] ?? targetParsed[targetParsed.length - 1] ?? opts.targetVendorColour;
        } else {
          // PRESERVE — shared/neutral colour (shadow, white, …) that
          // belongs to no specific colour combo. Keeps shadow as shadow
          // regardless of target.
          mapped = srcColour;
        }
      }
      const equiv = findEquivalentVariant(srcVariant.id, mapped);
      if (equiv) resolved++; else unresolved++;
      return {
        variantId: (equiv?.id ?? '') as number | '',
        quantity: r.quantity,
        notes: r.notes,
        rate: r.rate,
        color: opts.targetVendorColour,
        processId: opts.targetProcId,
        // Tag the row with what we tried so the "+ Create variant" chip
        // knows what to build. Cleared when the row gets a variantId.
        _unresolvedCopy: equiv ? undefined : { sourceVariantId: srcVariant.id, targetColour: mapped },
      };
    }).filter(Boolean) as typeof bom;
    setBom((rs) => [...rs, ...newRows]);
    if (unresolved === 0) {
      toast.success(`Copied ${resolved} row${resolved === 1 ? '' : 's'}.`);
    } else {
      toast.warning(
        `Copied ${resolved + unresolved} rows — ${unresolved} need a manual variant pick. Use the "+ Create variant" chip on each.`,
        { duration: 8000 },
      );
    }
  };

  // User picked "Copy from X" on the target colour's BOM. Decides whether
  // to apply directly (Phase 1) or open the mapping dialog (Phase 2 combo).
  const handleCopyFromSelected = (args: {
    targetProcId: number;
    targetVendorIdx: number;
    targetVendorColour: string;
    sourceColourLabel: string;
  }) => {
    // Gather source rows: same processId + matching colour.
    const sourceRows = bom.filter(
      (b) =>
        (b.processId == null || b.processId === args.targetProcId) &&
        (b.color ?? '').trim().toLowerCase() === args.sourceColourLabel.trim().toLowerCase(),
    );
    if (sourceRows.length === 0) {
      toast.error(`"${args.sourceColourLabel}" has no BOM rows to copy.`);
      return;
    }
    // Distinct variant-colours present in source rows (ignoring
    // colour-agnostic ones).
    const variantColoursInSource = Array.from(
      new Set(
        sourceRows
          .map((r) => variants.find((v) => v.id === Number(r.variantId))?.color ?? '')
          .map((c) => (c ?? '').trim())
          .filter(Boolean),
      ),
    );
    const targetParsed = parseColours(args.targetVendorColour);
    // Trivial case (Phase 1): source has ≤1 distinct variant-colour AND
    // target sticking-colour parses to ≤1 colour → apply directly. The
    // matcher uses applyCopy's "in source label? zip by position : preserve"
    // rule so a shadow-only source still gets shadow→shadow even though we
    // skipped the dialog.
    if (variantColoursInSource.length <= 1 && targetParsed.length <= 1) {
      applyCopy({
        sourceRows,
        targetProcId: args.targetProcId,
        sourceColourLabel: args.sourceColourLabel,
        targetVendorColour: args.targetVendorColour,
        colourMap: {},
      });
      return;
    }
    // Combo case (Phase 2): open the mapping dialog.
    //
    // Smart defaults — for each distinct source-variant colour:
    //   (1) If it appears in the SOURCE label (e.g. "Pink" is in "Pink Blue"),
    //       map it to the target's colour at the same position
    //       ("Ruby Green" → "Pink"→position 0→"Ruby", "Blue"→position 1→"Green").
    //   (2) Else (a "shared" colour like White that's used across all
    //       combos but isn't part of either label), PRESERVE it — map the
    //       colour to itself so the cloned row resolves to the same colour
    //       variant instead of being remapped to an arbitrary target slot.
    //
    // Matches the user's mental model: "Pink Blue" with [Pink, White, Blue]
    // → "Ruby Green" defaults to [Pink→Ruby, White→White, Blue→Green]. User
    // overrides if wrong.
    const sourceParsed = parseColours(args.sourceColourLabel);
    const defaultMap: Record<string, string> = {};
    variantColoursInSource.forEach((c) => {
      const idx = sourceParsed.findIndex(
        (p) => p.toLowerCase() === c.toLowerCase(),
      );
      if (idx >= 0) {
        // In source label → zip to target by position; falls back to the
        // last target slot or the raw target label if target has fewer
        // slots than source.
        defaultMap[c.toLowerCase()] =
          targetParsed[idx] ?? targetParsed[targetParsed.length - 1] ?? args.targetVendorColour;
      } else {
        // Not in source label → it's a shared/neutral colour, preserve.
        defaultMap[c.toLowerCase()] = c;
      }
    });
    setCopyMapping({
      targetVendorIdx: args.targetVendorIdx,
      targetProcId: args.targetProcId,
      sourceColourLabel: args.sourceColourLabel,
      targetColourLabel: args.targetVendorColour,
      sourceVariantColours: variantColoursInSource,
      targetParsedColours: targetParsed,
      mapping: defaultMap,
      sourceRows,
    });
  };

  const bomRowJSX = (b: (typeof bom)[number], idx: number) => {
    const v = variants.find((x) => x.id === Number(b.variantId));
    const masterPrice = v?.price ?? 0;
    const rateOverride = b.rate !== undefined && b.rate !== '' ? Number(b.rate) : null;
    const effectiveRate = rateOverride ?? masterPrice;
    const line = effectiveRate * Number(b.quantity || 0);
    const setBomRow = (patch: any) => setBom((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    return (
      <div key={idx} className="rounded-lg border border-border bg-card p-2.5">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
          <div className="sm:col-span-4">
            <Field
              label="Material Variant"
              action={
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
                  onClick={() => metaQ.refetch()}
                  disabled={metaQ.isFetching}
                  title="Re-fetch the variant list — click after creating a new variant in another tab"
                >
                  <RotateCw className={metaQ.isFetching ? 'size-3 animate-spin' : 'size-3'} /> Refresh
                </button>
              }
            >
              <SearchableSelect
                value={b.variantId}
                placeholder="— Select material —"
                onChange={(val) => setBomRow({ variantId: val ? Number(val) : '', _unresolvedCopy: undefined })}
                options={variants.map((vo) => ({
                  value: vo.id,
                  label: `${vo.variantName}${vo.size ? ` · ${vo.size}` : ''}${vo.color ? ` · ${vo.color}` : ''} (stock ${vo.stockQty})`,
                  keywords: `${vo.materialName ?? ''} ${vo.variantCode ?? ''}`,
                }))}
                // No-match path: open the Material Variants page in a NEW
                // TAB with the typed query pre-filled (?addVariant=Pearl).
                // The materials page detects the param + auto-opens the
                // create dialog with the material name in place — user
                // just adds the variant details and saves. On return to
                // this tab the dropdown will pick up the new variant on
                // its next refetch (item-meta is invalidated on save).
                createLabel="New Material Variant"
                onCreate={(query) => {
                  const url = '/materials?addVariant=' + encodeURIComponent(query);
                  window.open(url, '_blank', 'noopener');
                }}
              />
              {/* Unresolved-copy chip — appears when a copy-from operation
                  couldn't find an equivalent variant in the target colour.
                  One click creates the missing variant (same material /
                  size / shape / finish, target colour) via the bulk-create
                  endpoint and auto-fills this row. */}
              {b._unresolvedCopy && b.variantId === '' && (() => {
                const src = variants.find((vv) => vv.id === b._unresolvedCopy!.sourceVariantId);
                const tgt = b._unresolvedCopy!.targetColour;
                if (!src) return null;
                return (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-xs text-warning">
                    <AlertTriangle className="size-3.5 shrink-0" />
                    <span>
                      No <b>{tgt}</b> variant of <b>{src.materialName}{src.size ? ` ${src.size}` : ''}</b>{src.shape ? ` · ${src.shape}` : ''}{src.finish ? ` · ${src.finish}` : ''} exists.
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs"
                      disabled={createVariantMutation.isPending}
                      onClick={() => createVariantMutation.mutate({ sourceVariantId: src.id, targetColour: tgt })}
                    >
                      <Plus className="size-3" /> Create {tgt} variant
                    </Button>
                  </div>
                );
              })()}
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Qty / piece" hint="whole number">
              <Input type="number" step="1" min="0" value={b.quantity}
                onChange={(e) => setBomRow({ quantity: e.target.value.replace(/[^0-9]/g, '') })} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Rate / unit" hint={v ? `default ${formatCurrency(masterPrice)}` : 'pick a variant first'}>
              <div className="flex items-center gap-1">
                <Input type="number" step="0.01" min="0"
                  placeholder={v ? String(masterPrice) : ''}
                  value={b.rate ?? ''}
                  onChange={(e) => setBomRow({ rate: e.target.value })} />
                {b.rate !== undefined && b.rate !== '' && (
                  <button type="button" title="Reset to master price"
                    className="text-xs text-primary hover:underline"
                    onClick={() => setBomRow({ rate: '' })}>
                    ↺
                  </button>
                )}
              </div>
            </Field>
          </div>
          <div className="sm:col-span-3">
            <Field label="Notes">
              <Input value={b.notes} onChange={(e) => setBomRow({ notes: e.target.value })} />
            </Field>
          </div>
          <div className="sm:col-span-1 flex items-end">
            <Button type="button" variant="outline" size="icon"
              className="mb-0.5 text-destructive hover:bg-destructive/10"
              onClick={() => setBom((rs) => rs.filter((_, i) => i !== idx))}>
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
        {v && (
          <div className="mt-1 text-xs text-muted-foreground">
            Master price: <strong className="text-foreground">{formatCurrency(masterPrice)}</strong>
            {rateOverride != null && (
              <> · <span className="text-warning">Override: <strong>{formatCurrency(rateOverride)}</strong></span></>
            )}
            {' · '}Line cost: <strong className="text-foreground">{formatCurrency(line)}</strong>
          </div>
        )}
      </div>
    );
  };

  // Load existing item (edit).
  React.useEffect(() => {
    if (!itemId) return;
    Api.items.get(itemId).then((it: Item) => {
      reset({
        itemNumber: it.itemNumber != null ? String(it.itemNumber) : '',
        category: it.category ?? '', subcategory: it.subcategory ?? '', collection: it.collection ?? '',
        notes: it.notes ?? '', designType: it.designType ?? '',
        designerName: it.designerName ?? '', designerShortName: it.designerShortName ?? '',
        designCost: it.designCost != null ? String(it.designCost) : '',
        sellingPrice: it.sellingPrice != null ? String(it.sellingPrice) : '',
        sampleStatus: it.sampleStatus,
      });
      setSampleCode(it.sampleDesignCode);
      setExistingImages(it.images.map((im) => ({ id: im.id, path: im.filePath })));
      setImagePaths(it.images.map((im) => im.filePath));
      setCadPath(it.cadFilePath ?? undefined);
      const ps: Record<number, ProcState> = {};
      it.processes.forEach((p) => {
        ps[p.processId] = {
          notes: p.notes ?? '',
          attributes: p.attributes ?? {},
          photos: (p.photos ?? []).map((ph) => ph.filePath!).filter(Boolean),
          vendors: (p.vendors ?? []).map((v) => ({
            vendorId: v.vendorId, vendorDesignReference: v.vendorDesignReference ?? '',
            color: v.color ?? '', colorPhotoPath: (v as any).colorPhotoPath ?? undefined,
            costPerPiece: v.costPerPiece != null ? String(v.costPerPiece) : '',
            isPreferred: v.isPreferred ?? false,
            bringsOwnMaterials: (v as any).bringsOwnMaterials ?? false,
            notes: v.notes ?? '',
          })),
          services: (p.services ?? []).map((s) => ({ serviceId: s.serviceId, cost: s.cost != null ? String(s.cost) : '' })),
        };
      });
      setProcState(ps);
      const loadedBom = (it.materials ?? []).map((m) => ({
        variantId: m.variantId, quantity: String(m.quantity),
        notes: m.notes ?? '',
        color: (m as any).stickingColor ?? undefined,
        processId: (m as any).processId ?? undefined,
        rate: (m as any).rate != null ? String((m as any).rate) : '',
      }));
      setBom(loadedBom);
      const loadedParts = ((it as any).designParts ?? []) as Array<{ partName: string; qtyPerSet: number; weightPerPc: any; notes?: string }>;
      setDesignParts(
        loadedParts.map((p: any) => ({
          _k: Math.random().toString(36).slice(2, 9),
          partName: p.partName ?? '',
          qtyPerSet: String(p.qtyPerSet ?? 1),
          weightPerPc: p.weightPerPc != null ? String(p.weightPerPc) : '',
          photoPath: p.photoPath ?? '',
          notes: p.notes ?? '',
        })),
      );
      // Snapshot the rates EXACTLY as they were when the item was loaded.
      // On save, any line where the rate differs from this snapshot is
      // flagged for user confirmation — they pick old vs new per row,
      // so a typo or stale rate doesn't silently flow into the costing.
      const snap = new Map<string, string>();
      for (const b of loadedBom) {
        const key = `${b.processId ?? 'na'}|${b.variantId}|${(b.color ?? '').toLowerCase()}`;
        snap.set(key, b.rate ?? '');
      }
      setOriginalRates(snap);
    });
  }, [itemId, reset]);

  // Preview the auto sample code (create mode) as short name changes.
  React.useEffect(() => {
    if (itemId) return;
    const sn = (shortName || '').trim();
    let active = true;
    Api.items.nextDesignCode(sn || undefined).then((r) => { if (active) setSampleCode(r.sampleDesignCode); }).catch(() => {});
    return () => { active = false; };
  }, [shortName, itemId]);

  const getProc = (pid: number): ProcState =>
    procState[pid] ?? { notes: '', attributes: {}, photos: [], vendors: [], services: [] };
  const setProc = (pid: number, patch: Partial<ProcState>) =>
    setProcState((s) => ({ ...s, [pid]: { ...getProc(pid), ...patch } }));
  const vendorOptionsFor = (pid: number) => metaQ.data?.processes.find((p) => p.id === pid)?.vendors ?? [];
  const updateVendor = (pid: number, idx: number, patch: Partial<FormVendor>) => {
    const st = getProc(pid);
    setProc(pid, { vendors: st.vendors.map((v, i) => (i === idx ? { ...v, ...patch } : v)) });
  };

  // Add a new service to the master (e.g. a new Casting service) on the fly.
  const addService = useMutation({
    mutationFn: (body: { name: string; appliesTo?: string }) => Api.createService(body),
    onSuccess: (svc: any) => {
      toast.success(`Service "${svc.name}" added.`);
      qc.invalidateQueries({ queryKey: ['item-meta'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const promptAddService = (appliesTo: string) => {
    const name = window.prompt('New service name (e.g. Polishing):')?.trim();
    if (name) addService.mutate({ name, appliesTo });
  };

  // The PREFERRED (★) sticking colour — its BOM represents the item's material cost.
  const prefStickColour = React.useMemo(() => {
    const st = processSections.find((p) => p.code === 'STICKING');
    const vs = st ? (procState[st.id]?.vendors ?? []) : [];
    return ((vs.find((v) => v.isPreferred) ?? vs[0])?.color ?? '').trim();
  }, [processSections, procState]);

  // Does the preferred sticking vendor bring their own raw materials?
  // When YES, their per-piece rate covers materials — including the BOM
  // again would double-count, so we skip it (mirrors backend buildCostBreakup).
  const stickingBringsOwnMaterials = React.useMemo(() => {
    const st = processSections.find((p) => p.code === 'STICKING');
    if (!st) return false;
    const vs = procState[st.id]?.vendors ?? [];
    const pref = vs.find((v) => v.isPreferred) ?? vs[0];
    return !!pref?.bringsOwnMaterials;
  }, [processSections, procState]);

  // BOM line cost helper — honours the per-line rate override when present,
  // otherwise falls back to the variant's master price. Used by both the
  // live total and the breakup. Matches backend buildCostBreakup() exactly.
  const lineCostOf = React.useCallback((b: (typeof bom)[number]) => {
    const v = variants.find((x) => x.id === Number(b.variantId));
    if (!v) return 0;
    const override = b.rate !== undefined && b.rate !== '' ? Number(b.rate) : null;
    const price = override ?? (v.price || 0);
    return price * Number(b.quantity || 0);
  }, [variants]);

  // Combined breakup helper — single source of truth, used by both
  // costPrice (total only) and costLines (itemised). Mirrors backend
  // buildCostBreakup() exactly so the live preview matches what
  // Item.costPrice will get persisted to on save.
  const breakup = React.useMemo(() => {
    const casting = processSections.find((p) => p.code === 'CASTING');
    const weightG = casting ? Number(procState[casting.id]?.attributes?.weight || 0) : 0;
    const lines: { label: string; amount: number; excludeFromTotal?: boolean }[] = [];
    if (designCostNum) lines.push({
      label: 'Design cost (informational — not in total)',
      amount: designCostNum,
      excludeFromTotal: true,
    });

    // Resolve preferred Sticking vendor up-front — needed for the per-stone
    // labor calc and to know whether materials are excluded (brings-own).
    const stick = processSections.find((p) => p.code === 'STICKING');
    const stickVendors = stick ? procState[stick.id]?.vendors ?? [] : [];
    const prefStick = stickVendors.find((v) => v.isPreferred) ?? stickVendors[0];
    const stickRatePerStone = Number(prefStick?.costPerPiece || 0);
    const prefColour = (prefStick?.color ?? '').trim().toLowerCase();

    for (const p of processSections) {
      const st = procState[p.id];
      if (!st) continue;
      const entries = st.vendors.filter((v) => v.vendorId > 0);
      const chosen = entries.find((e) => e.isPreferred) ?? entries.find((e) => e.costPerPiece) ?? entries[0];

      if (p.code === 'STICKING') {
        // Branch on brings-own-materials: when ON the rate is a flat
        // per-piece all-inclusive (flat-rate karigar); when OFF it's a
        // per-stone labor rate. Materials block is included separately
        // only when brings-own is OFF — when ON, the rate covers them.
        if (stickingBringsOwnMaterials) {
          if (stickRatePerStone) lines.push({
            label: `Sticking labor (₹${stickRatePerStone}/pc · incl. materials${prefColour ? ` · ${prefColour}` : ''})`,
            amount: Math.round(stickRatePerStone * 100) / 100,
          });
        } else {
          const lines4colour = bom.filter(
            (b) => (b.processId == null || b.processId === p.id) &&
                   (b.color ?? '').trim().toLowerCase() === prefColour,
          );
          const totalStones = lines4colour.reduce((s, b) => s + Number(b.quantity || 0), 0);
          const labor = stickRatePerStone * totalStones;
          if (labor) lines.push({
            label: `Sticking labor (${stickRatePerStone}/stone × ${totalStones} stones${prefColour ? ` · ${prefColour}` : ''})`,
            amount: Math.round(labor * 100) / 100,
          });
        }
      } else if (chosen) {
        const rate = Number(chosen.costPerPiece || 0);
        const amt = p.costUnit === 'KG' ? weightG * rate : rate;
        if (amt) lines.push({ label: `${p.name}${p.costUnit === 'KG' ? ' (per g)' : ''}`, amount: Math.round(amt * 100) / 100 });
      }
      const svc = (st.services ?? []).reduce((s, sv) => s + Number(sv.cost || 0), 0);
      if (svc) lines.push({ label: `${p.name} — services`, amount: svc });
    }

    // Sticking materials — preferred-colour BOM, unless vendor brings own.
    if (!stickingBringsOwnMaterials && stick) {
      const stickBom = bom
        .filter((b) =>
          (b.processId == null || b.processId === stick.id) &&
          (b.color ?? '').trim().toLowerCase() === prefColour,
        )
        .reduce((s, b) => s + lineCostOf(b), 0);
      if (stickBom) lines.push({
        label: `Sticking materials${prefColour ? ` (${prefColour})` : ''}`,
        amount: Math.round(stickBom * 100) / 100,
      });
    }

    // Materials for Kacha Fitting / Fitting + Mala — shared BOM (no colour).
    // Filing / Polish use ad-hoc material issue at forward time, no BOM.
    const EXTRA = ['KACHA_FITTING', 'FITTING_MALA'] as const;
    for (const code of EXTRA) {
      const proc = processSections.find((p) => p.code === code);
      if (!proc) continue;
      const amt = bom.filter((b) => b.processId === proc.id).reduce((s, b) => s + lineCostOf(b), 0);
      if (amt) lines.push({ label: `${proc.name} materials`, amount: Math.round(amt * 100) / 100 });
    }

    const total = Math.round(lines.reduce((s, l) => s + (l.excludeFromTotal ? 0 : l.amount), 0) * 100) / 100;
    return { lines, total };
  }, [procState, processSections, designCostNum, bom, lineCostOf, stickingBringsOwnMaterials]);

  const costPrice = breakup.total;
  const costLines = breakup.lines;

  const existingPathSet = new Set(existingImages.map((i) => i.path));
  const newImagePaths = imagePaths.filter((p) => !existingPathSet.has(p));

  const buildPayload = (values: FormValues, forceDraft: boolean) => ({
    ...values,
    itemNumber: values.itemNumber ? String(values.itemNumber).trim() : undefined,
    designType: values.designType || undefined,
    designCost: values.designCost ? Number(values.designCost) : undefined,
    sellingPrice: values.sellingPrice ? Number(values.sellingPrice) : undefined,
    sampleStatus: forceDraft ? 'DRAFT' : values.sampleStatus,
    cadFilePath: cadPath,
    images: imagePaths,
    processes: processSections.map((p) => {
      const st = getProc(p.id);
      return {
        processId: p.id,
        notes: st.notes || undefined,
        attributes: st.attributes,
        photos: st.photos,
        services: (st.services ?? []).map((s) => ({ serviceId: s.serviceId, cost: s.cost ? Number(s.cost) : undefined })),
        vendors: st.vendors.filter((v) => v.vendorId > 0).map((v) => ({
          vendorId: Number(v.vendorId),
          vendorDesignReference: v.vendorDesignReference || undefined,
          color: v.color || undefined,
          colorPhotoPath: v.colorPhotoPath || undefined,
          costPerPiece: v.costPerPiece !== undefined && v.costPerPiece !== '' ? Number(v.costPerPiece) : undefined,
          isPreferred: !!v.isPreferred,
          bringsOwnMaterials: !!v.bringsOwnMaterials,
          notes: v.notes || undefined,
        })),
      };
    }),
    materials: bom
      .filter((b) => b.variantId)
      .map((b) => ({
        variantId: Number(b.variantId),
        quantity: Math.max(0, Math.trunc(Number(b.quantity || 0))), // whole number — never fractions
        color: b.color || undefined,
        // processId: which process this BOM line belongs to (Sticking / Kacha
        // Fitting / Fitting / Packing). The "Add Material" button sets this
        // when the user adds a new row. Legacy rows loaded without one are
        // defaulted to Sticking by the backend.
        processId: b.processId ?? undefined,
        // Rate override: null/blank means "use the variant's master price".
        rate: b.rate !== undefined && b.rate !== '' ? Number(b.rate) : undefined,
        notes: b.notes || undefined,
      })),
    designParts: designParts
      .filter((p) => p.partName.trim().length > 0)
      .map((p, i) => ({
        partName: p.partName.trim(),
        qtyPerSet: Math.max(1, Math.trunc(Number(p.qtyPerSet || 1))),
        weightPerPc: Math.max(0, Number(p.weightPerPc || 0)),
        photoPath: p.photoPath || undefined,
        sortOrder: i,
        notes: p.notes || undefined,
      })),
  });

  const save = useMutation({
    mutationFn: (body: any) => (itemId ? Api.items.update(itemId, body) : Api.items.create(body)),
    onSuccess: (res: any) => {
      // Backend may have regenerated sampleDesignCode (when the designer
      // short name changed). Mirror the server's value locally so the
      // header chip + "Sample Design Code" field re-render with the new
      // prefix immediately — otherwise the user thinks the change didn't
      // take. Toast also picks up the new code on rename, not the old.
      if (res?.sampleDesignCode) setSampleCode(res.sampleDesignCode);
      const renamed = itemId && res?.sampleDesignCode && res.sampleDesignCode !== sampleCode;
      toast.success(
        itemId
          ? (renamed ? `Item saved · code is now ${res.sampleDesignCode}.` : 'Item saved.')
          : `Item ${res.sampleDesignCode} created.`,
      );
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['item', res.id] });
      qc.invalidateQueries({ queryKey: ['item-meta'] });
      // Pick up any newly-typed Category / Subcategory / Collection so the
      // dropdown's "+ Add" value joins the suggestions on the next form open.
      qc.invalidateQueries({ queryKey: ['item-lookups'] });
      // Cross-tab live sync — if a sibling tab (e.g. the Forward Dialog the
      // user came from) is listening, push the update so its colour list
      // refreshes without manual reload or tab focus.
      if (typeof BroadcastChannel !== 'undefined') {
        const ch = new BroadcastChannel('item-updates');
        ch.postMessage({ type: 'item-saved', itemId: res.id });
        ch.close();
      }
      router.push(`/items/${res.id}`);
    },
    onError: (e) => toast.error(getApiError(e).message),
  });
  // On submit: build the payload, then check for BOM-rate changes. When any
  // line's rate has changed from the originally-loaded value, halt the save
  // and pop a confirm dialog so the user can pick old/new per row. After
  // confirmation, the dialog applies the chosen rates to the payload and
  // fires the mutation. When there are no changes (create mode, or no
  // rates moved), the save fires immediately.
  const submit = (forceDraft: boolean) => handleSubmit((v) => {
    const payload = buildPayload(v, forceDraft);
    if (!itemId || originalRates.size === 0) {
      save.mutate(payload);
      return;
    }
    const changes: NonNullable<typeof rateChangeDialog>['changes'] = [];
    bom.forEach((b, idx) => {
      if (!b.variantId) return;
      const key = `${b.processId ?? 'na'}|${b.variantId}|${(b.color ?? '').toLowerCase()}`;
      const oldRate = originalRates.get(key);
      if (oldRate === undefined) return; // new row, not a "change"
      const newRate = b.rate ?? '';
      if (oldRate === newRate) return;
      const variant = variants.find((x) => x.id === Number(b.variantId));
      const proc = processSections.find((p) => p.id === b.processId);
      changes.push({
        idx,
        variantId: Number(b.variantId),
        variantName: variant?.variantName ?? `Variant ${b.variantId}`,
        processName: proc?.name ?? 'BOM',
        color: b.color ?? '',
        oldRate,
        newRate,
        pick: 'new',
      });
    });
    if (changes.length === 0) { save.mutate(payload); return; }
    setRateChangeDialog({ pendingPayload: payload, forceDraft, changes });
  })();

  const deleteExistingImage = async (img: { id: number; path: string }) => {
    if (itemId) await Api.items.deleteImage(itemId, img.id);
    setExistingImages((arr) => arr.filter((i) => i.id !== img.id));
    setImagePaths((arr) => arr.filter((p) => p !== img.path));
    toast.success('Image removed.');
  };

  const cadInput = React.useRef<HTMLInputElement>(null);
  const onCadFile = async (file?: File) => {
    if (!file) return;
    setCadUploading(true);
    try {
      const res = await Api.upload(file, 'cad', 'cad');
      setCadPath(res.path);
      toast.success('CAD file uploaded.');
    } catch (e) { toast.error(getApiError(e).message); } finally { setCadUploading(false); }
  };

  const onPickDesigner = (vendorId: string) => {
    const d = designers.find((x) => String(x.id) === vendorId);
    if (d) {
      setValue('designerName', d.vendorName);
      setValue('designerShortName', d.shortName ?? '');
    }
  };

  return (
    <div className="relative pb-24">
      {/* Full-form blocking overlay while save is in flight — disables every input
          and shows a spinner so the user can't double-submit or edit mid-save. */}
      {save.isPending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm">
          <div className="flex items-center gap-3 rounded-lg bg-card px-5 py-3 text-sm shadow-xl">
            <Spinner className="text-primary" />
            <span className="font-medium">Saving item — please wait…</span>
          </div>
        </div>
      )}
      <fieldset disabled={save.isPending} className={save.isPending ? 'pointer-events-none' : ''}>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xl font-bold">
            <span>{itemId ? 'Edit Item' : 'Create Item'}</span>
            {/* When editing: surface the item number + sample design code
                next to the heading so the user always knows WHICH item is
                being edited without scrolling to the form fields. Hidden
                on Create (those identifiers don't exist yet). */}
            {itemId && (itemNumberVal || sampleCode) && (
              <span className="text-base font-medium text-muted-foreground">
                {itemNumberVal ? <>#<span className="text-foreground">{itemNumberVal}</span></> : null}
                {itemNumberVal && sampleCode ? <span className="px-1">·</span> : null}
                {sampleCode ? <span className="text-foreground">{sampleCode}</span> : null}
              </span>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">Design → Basic Info → Processes. Save anytime as a draft.</p>
        </div>
        {/* router.back() returns to the caller (list, detail, or wherever
            the operator came from) while preserving scroll — pushing a
            fixed /items route would reset scroll to the top. */}
        <Button variant="outline" onClick={() => router.back()}><ArrowLeft className="size-4" /> Back</Button>
      </div>

      <div className="mb-4 flex gap-2 table-scroll">
        {STEPS.map((s, i) => (
          <button key={s} onClick={() => setStep(s)}
            className={cn('whitespace-nowrap rounded-md border px-4 py-2 text-sm font-medium transition-colors',
              step === s ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card hover:bg-accent')}>
            {i + 1}. {STEP_LABEL[s]}
          </button>
        ))}
      </div>

      {/* Step 1: Design */}
      {step === 'design' && (
        <Card><CardContent className="p-5">
          <SectionTitle><FileUp className="size-4" /> Design / CAD Section</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Design Type">
              <Select {...register('designType')}>
                <option value="">— Select —</option>
                <option value="CAD">CAD</option>
                <option value="HANDMADE">Handmade</option>
              </Select>
            </Field>
            <Field label="Designer"
              hint={designers.length ? 'Designers are vendors with the Design/CAD process.' : 'Add a Design/CAD vendor (with a short name) first.'}>
              <SearchableSelect
                value={designers.find((d) => d.vendorName === watch('designerName'))?.id ?? ''}
                placeholder="— Select designer —"
                onChange={(v) => onPickDesigner(v)}
                options={designers.map((d) => ({ value: d.id, label: `${d.vendorName}${d.shortName ? ` (${d.shortName})` : ''}`, keywords: d.shortName ?? '' }))}
              />
            </Field>
            <Field label="Designer Short Name" hint="Drives the sample design code (e.g. TVM → TVM-001).">
              <Input placeholder="e.g. TVM" {...register('designerShortName')} />
            </Field>
            <Field label="Design Cost"><Input type="number" step="0.01" {...register('designCost')} /></Field>
            <Field label="Sample Status">
              <Select {...register('sampleStatus')}>
                {Object.entries(SAMPLE_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="CAD File" hint="Opens in a viewer (not downloaded). STL / OBJ / 3DM / ZIP / PDF / image.">
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" onClick={() => cadInput.current?.click()} disabled={cadUploading}>
                  {cadUploading ? <Spinner /> : <UploadCloud className="size-4" />} Upload CAD
                </Button>
                {cadPath && <Button type="button" variant="outline" onClick={() => setCadViewerOpen(true)}><Eye className="size-4" /> View</Button>}
                <input ref={cadInput} type="file" className="hidden" onChange={(e) => onCadFile(e.target.files?.[0])} />
              </div>
            </Field>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">
            Sample Design Code will be <span className="font-semibold text-foreground">{sampleCode || '—'}</span>
          </p>
        </CardContent></Card>
      )}

      {/* Step 2: Basic Info */}
      {step === 'basic' && (
        <Card><CardContent className="p-5">
          <SectionTitle><Info className="size-4" /> Basic Item Info</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Sample Design Code" hint="Auto-generated from designer short name.">
              <Input readOnly disabled value={sampleCode} className="bg-muted font-semibold" />
            </Field>
            <Field label="Item Number" hint="Alphanumeric, unique (e.g. 1501 or 1501a)">
              <Input type="text" maxLength={40} {...register('itemNumber')} />
            </Field>
            <Field label="Sample Status">
              <Select {...register('sampleStatus')}>
                {Object.entries(SAMPLE_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            {/* Category / Subcategory / Collection — SearchableSelect with
                inline + Add. Options are the distinct values already used
                across other items (so reuse is the path of least
                resistance). onCreate just sets the field's free-text
                value — no separate persist needed, the new value flows in
                with the next item save and joins the dropdown automatically. */}
            <Field label="Category">
              <SearchableSelect
                value={watch('category') ?? ''}
                onChange={(v) => setValue('category', v, { shouldDirty: true })}
                onCreate={(v) => setValue('category', v, { shouldDirty: true })}
                createLabel="Add category"
                placeholder="— Select or type to add —"
                options={(lookupsQ.data?.categories ?? []).map((c) => ({ value: c, label: c }))}
              />
            </Field>
            <Field label="Subcategory">
              <SearchableSelect
                value={watch('subcategory') ?? ''}
                onChange={(v) => setValue('subcategory', v, { shouldDirty: true })}
                onCreate={(v) => setValue('subcategory', v, { shouldDirty: true })}
                createLabel="Add subcategory"
                placeholder="— Select or type to add —"
                options={(lookupsQ.data?.subcategories ?? []).map((c) => ({ value: c, label: c }))}
              />
            </Field>
            <Field label="Collection">
              <SearchableSelect
                value={watch('collection') ?? ''}
                onChange={(v) => setValue('collection', v, { shouldDirty: true })}
                onCreate={(v) => setValue('collection', v, { shouldDirty: true })}
                createLabel="Add collection"
                placeholder="— Select or type to add —"
                options={(lookupsQ.data?.collections ?? []).map((c) => ({ value: c, label: c }))}
              />
            </Field>
            <Field label="Selling Price"><Input type="number" step="0.01" {...register('sellingPrice')} /></Field>
            <Field label="Cost Price" hint="Auto-calculated from design + process costs.">
              <Input readOnly disabled value={formatCurrency(costPrice)} className="bg-muted font-semibold" />
            </Field>
          </div>

          {/* Live cost-price breakup */}
          <div className="mt-4 rounded-lg border border-border bg-muted/30 p-4">
            <div className="mb-2 text-sm font-semibold">Cost Price Breakup</div>
            {costLines.length === 0 ? (
              <p className="text-sm text-muted-foreground">Add design cost / process rates / materials to see the breakup.</p>
            ) : (
              <div className="space-y-1 text-sm">
                {costLines.map((l, i) => (
                  <div key={i} className="flex justify-between border-b border-border/60 py-1 last:border-0">
                    <span className="text-muted-foreground">{l.label}</span>
                    <span className="font-medium">{formatCurrency(l.amount)}</span>
                  </div>
                ))}
                <div className="flex justify-between pt-1.5 text-base font-bold text-primary">
                  <span>Total Cost Price</span><span>{formatCurrency(costPrice)}</span>
                </div>
                {Number(watch('sellingPrice') || 0) > 0 && (
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Margin at selling price</span>
                    <span>{formatCurrency(Number(watch('sellingPrice') || 0) - costPrice)}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Design Parts — pendant + earring + patti + ... Each part has
              qty-per-set + per-piece weight. Sum across parts is the
              expected weight per set issued at Casting. */}
          <SectionTitle><Boxes className="size-4" /> Design Parts</SectionTitle>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            {designParts.length === 0 ? (
              <p className="text-sm text-text-muted">
                A design can be one piece (e.g. ring) or a set with multiple components.
                Add a row for each component — Pendant, Earring, Patti, etc.
              </p>
            ) : (
              <div className="space-y-2">
                {designParts.map((row, idx) => (
                  <div key={row._k} className="rounded-md border border-border/60 bg-background p-2">
                    <div className="grid grid-cols-12 gap-2">
                      <div className="col-span-12 sm:col-span-3">
                        <Field label={idx === 0 ? 'Part name' : ''}>
                          <Input
                            placeholder="Pendant / Earring / Patti…"
                            value={row.partName}
                            onChange={(e) => {
                              const v = e.target.value;
                              setDesignParts((arr) => arr.map((r, i) => i === idx ? { ...r, partName: v } : r));
                            }}
                          />
                        </Field>
                      </div>
                      <div className="col-span-4 sm:col-span-2">
                        <Field label={idx === 0 ? 'Qty / set' : ''}>
                          <Input
                            type="number" min="1" step="1"
                            value={row.qtyPerSet}
                            onChange={(e) => {
                              const v = e.target.value;
                              setDesignParts((arr) => arr.map((r, i) => i === idx ? { ...r, qtyPerSet: v } : r));
                            }}
                          />
                        </Field>
                      </div>
                      <div className="col-span-4 sm:col-span-2">
                        <Field label={idx === 0 ? 'Wt / pc (g)' : ''}>
                          <Input
                            type="number" min="0" step="0.001" placeholder="0.000"
                            value={row.weightPerPc}
                            onChange={(e) => {
                              const v = e.target.value;
                              setDesignParts((arr) => arr.map((r, i) => i === idx ? { ...r, weightPerPc: v } : r));
                            }}
                          />
                        </Field>
                      </div>
                      <div className="col-span-3 sm:col-span-4">
                        <Field label={idx === 0 ? 'Notes' : ''}>
                          <Input
                            placeholder="Optional"
                            value={row.notes}
                            onChange={(e) => {
                              const v = e.target.value;
                              setDesignParts((arr) => arr.map((r, i) => i === idx ? { ...r, notes: v } : r));
                            }}
                          />
                        </Field>
                      </div>
                      <div className={`col-span-1 ${idx === 0 ? 'pt-[26px]' : 'pt-0'}`}>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          title="Remove part"
                          onClick={() => setDesignParts((arr) => arr.filter((_, i) => i !== idx))}
                          className="text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>
                    {/* Per-part photo — small disc + uploader. Operators
                        confirm "this is the curved pendant" / "earring with
                        the pearl drop" separately from the main set photo. */}
                    <div className="mt-2 flex items-center gap-3">
                      {row.photoPath ? (
                        <a href={fileUrl(row.photoPath)} target="_blank" rel="noreferrer" title="Open full size">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={fileUrl(row.photoPath)} alt={row.partName} className="size-12 rounded-md border border-border object-cover" />
                        </a>
                      ) : (
                        <div className="flex size-12 items-center justify-center rounded-md border border-dashed border-border text-text-faint">
                          <Boxes className="size-5" />
                        </div>
                      )}
                      <div className="flex-1">
                        <ImageUpload
                          module="items"
                          value={row.photoPath ? [row.photoPath] : []}
                          onChange={(paths) => {
                            const next = paths[0] ?? '';
                            setDesignParts((arr) => arr.map((r, i) => i === idx ? { ...r, photoPath: next } : r));
                          }}
                        />
                      </div>
                      {row.photoPath && (
                        <Button
                          type="button" variant="outline" size="sm"
                          onClick={() => setDesignParts((arr) => arr.map((r, i) => i === idx ? { ...r, photoPath: '' } : r))}
                        >
                          Remove photo
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
                {(() => {
                  const totalPcs = designParts.reduce((s, p) => s + (Number(p.qtyPerSet) || 0), 0);
                  const totalWt = designParts.reduce((s, p) => s + (Number(p.qtyPerSet) || 0) * (Number(p.weightPerPc) || 0), 0);
                  return (
                    <div className="flex items-center justify-between rounded border border-border/60 bg-background px-3 py-1.5 text-sm">
                      <span className="text-text-muted">Set totals</span>
                      <span className="font-semibold tabular-nums">{totalPcs} pcs · {totalWt.toFixed(3)} g</span>
                    </div>
                  );
                })()}
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setDesignParts((arr) => [...arr, newDesignPart()])}
            >
              <Plus className="size-4" /> Add Part
            </Button>
          </div>

          <SectionTitle><UploadCloud className="size-4" /> Product Photos</SectionTitle>
          {existingImages.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {existingImages.map((img) => (
                <div key={img.id} className="relative">
                  <a href={fileUrl(img.path)} target="_blank" rel="noreferrer" title="Open full image">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={fileUrl(img.path)} alt="" className="size-20 rounded-lg border border-border object-cover transition-opacity hover:opacity-80" />
                  </a>
                  <button type="button" onClick={() => deleteExistingImage(img)}
                    className="absolute -right-2 -top-2 flex size-5 items-center justify-center rounded-full border-2 border-card bg-destructive text-destructive-foreground">
                    <Trash2 className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <ImageUpload module="items" multiple value={newImagePaths}
            onChange={(paths) => setImagePaths([...existingImages.map((i) => i.path), ...paths])} />

          <SectionTitle><Info className="size-4" /> Notes</SectionTitle>
          <Textarea rows={3} placeholder="General notes about this design…" {...register('notes')} />
        </CardContent></Card>
      )}

      {/* Step 3: Processes */}
      {step === 'process' && (
        <Card><CardContent className="p-5">
          <SectionTitle><Settings2 className="size-4" /> Manufacturing / Job-Work Processes</SectionTitle>
          <p className="mb-4 text-sm text-muted-foreground">
            Casting &amp; Plating are priced per gram. Plating &amp; Meena allow the same vendor in multiple colours.
          </p>
          <Accordion>
            {processSections.map((p) => {
              const st = getProc(p.id);
              const procVendors = vendorOptionsFor(p.id);
              // Sticking has TWO possible rate semantics depending on the
              // vendor's brings-own-materials toggle:
              //   • OFF → ₹X per STONE stuck (labor only). Item BOM adds
              //     materials cost separately.
              //   • ON  → ₹X per PIECE (flat, includes materials).
              // The label flips per-vendor so the user always sees the
              // correct unit when typing the rate.
              const baseRateLabel = p.costUnit === 'KG' ? 'Cost / g' : 'Cost / Piece';
              const rateLabel = baseRateLabel;
              const procServices = services.filter((s) => !s.appliesTo || s.appliesTo === p.code);
              return (
                <AccordionItem key={p.id}
                  id={`process-${p.id}`}
                  defaultOpen={focusProcessId === p.id}
                  title={<><Settings2 className="size-4" /> {p.name} {p.costUnit === 'KG' && <Badge variant="info">per g</Badge>}</>}
                  badge={<Badge variant="secondary">{st.vendors.length} {p.usesColor ? 'colour(s)' : 'vendor(s)'}</Badge>}>

                  {p.attributes.length > 0 && (
                    <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                      {p.attributes.map((a) => (
                        <Field key={a.key} label={a.label}>
                          <Input value={st.attributes[a.key] ?? ''}
                            onChange={(e) => setProc(p.id, { attributes: { ...st.attributes, [a.key]: e.target.value } })} />
                        </Field>
                      ))}
                    </div>
                  )}

                  {/* Optional services (e.g. Casting → Soldering / Fitting) */}
                  {p.usesServices && (
                    <div className="mb-3">
                      <div className="mb-1 flex items-center justify-between">
                        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Optional Services <span className="font-normal normal-case">(cost is per piece)</span>
                        </div>
                        <button type="button"
                          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline disabled:opacity-50"
                          onClick={() => promptAddService(p.code)} disabled={addService.isPending}>
                          <Plus className="size-3" /> Add service
                        </button>
                      </div>
                      {procServices.length === 0 && (
                        <p className="mb-2 text-xs text-muted-foreground">No services yet — use “Add service”.</p>
                      )}
                      <div className="flex flex-wrap gap-3">
                        {procServices.map((sv) => {
                          const sel = st.services.find((x) => x.serviceId === sv.id);
                          const toggle = () => {
                            const next = sel
                              ? st.services.filter((x) => x.serviceId !== sv.id)
                              : [...st.services, { serviceId: sv.id, cost: '' }];
                            setProc(p.id, { services: next });
                          };
                          return (
                            <div key={sv.id} className="rounded-md border border-border px-2.5 py-1.5">
                              <label className="flex cursor-pointer items-center gap-2">
                                <input type="checkbox" className="accent-primary" checked={!!sel} onChange={toggle} />
                                <span className="text-sm">{sv.name}</span>
                              </label>
                              {sel && (
                                <div className="mt-1.5 flex items-center gap-1">
                                  <span className="text-xs text-muted-foreground">₹/pc</span>
                                  <Input type="number" step="0.01" placeholder="rate per piece" className="h-7 w-28"
                                    value={sel.cost ?? ''}
                                    onChange={(e) => setProc(p.id, {
                                      services: st.services.map((x) => x.serviceId === sv.id ? { ...x, cost: e.target.value } : x),
                                    })} />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Notes + Photos side-by-side on desktop, stacked on mobile */}
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <Field label="Process Notes">
                      <Textarea rows={4} value={st.notes} onChange={(e) => setProc(p.id, { notes: e.target.value })} />
                    </Field>
                    <Field label="Process Photos" hint="Development / progress / before-after.">
                      <ImageUpload module="items" multiple value={st.photos} onChange={(paths) => setProc(p.id, { photos: paths })} />
                    </Field>
                  </div>

                  <div className="mt-4">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {p.usesColor ? 'Colours for this process' : 'Vendors for this process'}
                    </span>
                  </div>

                  {procVendors.length === 0 ? (
                    <div className="mt-2 flex flex-col items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
                      <span>No vendors support <strong>{p.name}</strong> yet.</span>
                      <Link href="/vendors"><Button type="button" variant="outline" size="sm"><Plus className="size-4" /> Add Vendor in Vendor Master</Button></Link>
                    </div>
                  ) : (
                    <div className="mt-2 space-y-2">
                      {st.vendors.map((v, idx) => (
                        <div key={idx} className="rounded-lg border border-border bg-muted/30 p-3">
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                            <div className="sm:col-span-3">
                              <Field label="Vendor">
                                <SearchableSelect
                                  value={v.vendorId || ''}
                                  placeholder="— Select —"
                                  onChange={(val) => updateVendor(p.id, idx, { vendorId: Number(val) })}
                                  options={procVendors.map((vo) => ({ value: vo.id, label: `${vo.vendorCode} · ${vo.vendorName}`, keywords: vo.vendorName }))}
                                />
                              </Field>
                            </div>
                            {p.usesColor && (
                              <div className="sm:col-span-2">
                                <Field label="Colour"><Input placeholder="e.g. Gold" value={v.color ?? ''} onChange={(e) => updateVendor(p.id, idx, { color: e.target.value })} /></Field>
                              </div>
                            )}
                            <div className={p.usesColor ? 'sm:col-span-2' : 'sm:col-span-3'}>
                              <Field label="Vendor Design Ref."><Input placeholder="e.g. CST-88" value={v.vendorDesignReference ?? ''} onChange={(e) => updateVendor(p.id, idx, { vendorDesignReference: e.target.value })} /></Field>
                            </div>
                            <div className="sm:col-span-2">
                              <Field label={
                                p.code === 'STICKING'
                                  ? (v.bringsOwnMaterials ? 'Cost / Piece (incl. materials)' : 'Cost / Stone')
                                  : rateLabel
                              }>
                                <Input type="number" step="0.01" value={v.costPerPiece ?? ''}
                                  onChange={(e) => updateVendor(p.id, idx, { costPerPiece: e.target.value })} />
                              </Field>
                            </div>
                            <div className={p.usesColor ? 'sm:col-span-2' : 'sm:col-span-3'}>
                              <Field label="Notes"><Input value={v.notes ?? ''} onChange={(e) => updateVendor(p.id, idx, { notes: e.target.value })} /></Field>
                            </div>
                            <div className="flex items-end justify-between gap-2 sm:col-span-1">
                              <label className="flex items-center gap-1 pb-2 text-sm" title="Preferred">
                                <input type="checkbox" className="accent-primary" checked={!!v.isPreferred} onChange={(e) => updateVendor(p.id, idx, { isPreferred: e.target.checked })} />
                                <Star className="size-3.5" />
                              </label>
                              <Button type="button" variant="outline" size="icon" className="mb-0.5 text-destructive hover:bg-destructive/10"
                                onClick={() => setProc(p.id, { vendors: st.vendors.filter((_, i) => i !== idx) })}>
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          </div>
                          {p.code === 'STICKING' && (
                            <label className="mt-2 flex cursor-pointer items-center gap-2 rounded-md border border-info/30 bg-info/15 px-2.5 py-1.5 text-xs text-sky-900">
                              <input type="checkbox" className="size-3.5 accent-primary" checked={!!v.bringsOwnMaterials}
                                onChange={(e) => {
                                  // Don't apply immediately — open a rate prompt
                                  // because the toggle changes what the rate
                                  // VALUE means (per-stone labor vs per-piece
                                  // all-inclusive). If the user just clicks the
                                  // toggle and leaves the rate at 0.08, the
                                  // sticking cost would be off by orders of
                                  // magnitude. The dialog forces a conscious
                                  // rate update with the new semantic.
                                  setBrOwnDialog({
                                    pid: p.id,
                                    idx,
                                    nextValue: e.target.checked,
                                    oldRate: v.costPerPiece ?? '',
                                    newRate: v.costPerPiece ?? '',
                                  });
                                }} />
                              <span><strong>This vendor brings their own raw materials.</strong> Their per-piece rate covers materials — BOM cost is excluded from cost price and no material issue is auto-created on forward.</span>
                            </label>
                          )}
                          {p.usesColor && (
                            <div className="mt-2 grid grid-cols-1 gap-3 border-t border-border pt-2 sm:grid-cols-2">
                              <div className="flex items-center gap-2 text-sm">
                                <span className="text-muted-foreground">Colour code:</span>
                                <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-semibold">{colourCode(p.id, v.color) || (itemNumberVal ? '—' : 'set item number')}</code>
                              </div>
                              <Field label="Colour photo">
                                <ImageUpload module="items" value={v.colorPhotoPath ? [v.colorPhotoPath] : []} onChange={(paths) => updateVendor(p.id, idx, { colorPhotoPath: paths[0] })} />
                              </Field>
                            </div>
                          )}
                          {/* This colour's own BOM (Sticking) — 1 colour = 1 BOM.
                              processId is recorded on add so the backend
                              routes it correctly even after rows are mixed
                              with Kacha/Fitting/Packing BOM lines elsewhere
                              on the same item. */}
                          {p.code === 'STICKING' && (
                            <div className="mt-2 rounded-md border border-primary/20 bg-primary/5 p-2.5">
                              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-sm font-semibold text-primary">
                                <span className="inline-flex items-center gap-1.5">
                                  <Boxes className="size-4" /> BOM for {v.color || 'this colour'}{colourCode(p.id, v.color) ? ` · ${colourCode(p.id, v.color)}` : ''}
                                </span>
                                {/* "Copy from another colour" — Phase 1 + 2.
                                    Shows other sticking colours on this same
                                    item that have at least one BOM row. Only
                                    available once this colour has a name (so
                                    the matcher knows the target colour). */}
                                {(() => {
                                  const otherColours = (st.vendors ?? [])
                                    .map((vv, vi) => ({ vi, colour: (vv.color ?? '').trim() }))
                                    .filter((o) => o.vi !== idx && o.colour)
                                    .filter((o) =>
                                      bom.some(
                                        (b) =>
                                          (b.processId == null || b.processId === p.id) &&
                                          (b.color ?? '').trim().toLowerCase() === o.colour.toLowerCase(),
                                      ),
                                    );
                                  if (otherColours.length === 0 || !(v.color ?? '').trim()) return null;
                                  return (
                                    // Pill-shaped Copy-from picker — sized so the
                                    // label reads at a glance and the native
                                    // <select> behaves like an obvious primary
                                    // action rather than a small attached input.
                                    <div className="inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 py-1 pl-3 pr-1 text-sm text-primary shadow-sm hover:bg-primary/15">
                                      <Copy className="size-4 shrink-0" />
                                      <span className="font-semibold">Copy BOM from</span>
                                      <select
                                        className="h-8 cursor-pointer rounded-full border border-primary/30 bg-white px-3 text-sm font-semibold text-primary outline-none focus:border-primary"
                                        value=""
                                        onChange={(e) => {
                                          const src = e.target.value;
                                          if (!src) return;
                                          handleCopyFromSelected({
                                            targetProcId: p.id,
                                            targetVendorIdx: idx,
                                            targetVendorColour: (v.color ?? '').trim(),
                                            sourceColourLabel: src,
                                          });
                                          // Reset the select so the same colour can be re-picked later.
                                          e.target.value = '';
                                        }}
                                      >
                                        <option value="">— pick a colour —</option>
                                        {otherColours.map((o) => (
                                          <option key={o.vi} value={o.colour}>{o.colour}</option>
                                        ))}
                                      </select>
                                    </div>
                                  );
                                })()}
                              </div>
                              {variants.length === 0 ? (
                                <p className="text-xs text-warning">Add material variants in <Link href="/materials" className="underline">Material Variants</Link> first.</p>
                              ) : (
                                <>
                                  <div className="space-y-2">
                                    {bom.map((b, bidx) => (
                                      // Filter by Sticking processId AND colour. Older
                                      // rows without processId fall back to colour-only
                                      // matching so the BOM continues to render after
                                      // a load before the user re-saves.
                                      (b.processId == null || b.processId === p.id) && (b.color ?? '') === (v.color ?? '')
                                        ? bomRowJSX(b, bidx) : null
                                    ))}
                                  </div>
                                  <Button type="button" variant="outline" size="sm" className="mt-2"
                                    onClick={() => setBom((rs) => [...rs, { variantId: '', quantity: '', notes: '', color: v.color || undefined, processId: p.id, rate: '' }])}>
                                    <Plus className="size-4" /> Add Material
                                  </Button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                      {st.vendors.length === 0 && (
                        <p className="text-sm text-muted-foreground">None added — click below.</p>
                      )}
                      <Button type="button" variant="outline" size="sm"
                        onClick={() => setProc(p.id, { vendors: [...st.vendors, { vendorId: 0 }] })}>
                        <Plus className="size-4" /> {p.usesColor ? 'Add Colour' : 'Add Vendor'}
                      </Button>

                      {/* Shared BOM panel for Kacha Fitting / Fitting / Packing.
                          Unlike Sticking (one BOM per colour), these processes
                          have a single BOM that applies across all colours of
                          the item. The panel sits at the bottom of the process
                          accordion — directly below the vendor list — so each
                          process card visually owns its BOM (no scrolling to
                          the bottom of the page to find it). The labour rate
                          stays on the vendor row above; this block is for
                          MATERIAL costs only. */}
                      {(p.code === 'KACHA_FITTING' || p.code === 'FITTING_MALA') && (
                        <div className="mt-3 rounded-md border border-primary/20 bg-primary/5 p-2.5">
                          <div className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-primary">
                            <Boxes className="size-4" /> BOM Materials for {p.name}
                          </div>
                          {variants.length === 0 ? (
                            <p className="text-xs text-warning">
                              Add material variants in <Link href="/materials" className="underline">Material Variants</Link> first.
                            </p>
                          ) : (
                            <>
                              <div className="space-y-2">
                                {bom.map((b, bidx) => (
                                  b.processId === p.id ? bomRowJSX(b, bidx) : null
                                ))}
                              </div>
                              <Button type="button" variant="outline" size="sm" className="mt-2"
                                onClick={() => setBom((rs) => [...rs, { variantId: '', quantity: '', notes: '', processId: p.id, rate: '' }])}>
                                <Plus className="size-4" /> Add Material
                              </Button>
                              <p className="mt-2 text-[10px] text-muted-foreground">
                                Materials below are shared across every colour of this item — no per-colour split.
                                Labor rate stays on the vendor row above.
                              </p>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                </AccordionItem>
              );
            })}
          </Accordion>
        </CardContent></Card>
      )}

      {/* Sticky action bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/95 px-4 py-3 backdrop-blur lg:pl-64">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">
            Cost: <strong className="text-foreground">{formatCurrency(costPrice)}</strong>
          </span>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {STEPS.indexOf(step) > 0 && <Button variant="outline" onClick={() => setStep(STEPS[STEPS.indexOf(step) - 1])}>Previous</Button>}
            {STEPS.indexOf(step) < STEPS.length - 1 && <Button variant="outline" onClick={() => setStep(STEPS[STEPS.indexOf(step) + 1])}>Next</Button>}
            <span className="mx-1 hidden h-6 w-px bg-border sm:inline-block" />
            <Button variant="secondary" onClick={() => submit(true)} disabled={save.isPending}>
              {save.isPending && <Spinner />} <Save className="size-4" /> Save Draft
            </Button>
            <Button onClick={() => submit(false)} disabled={save.isPending}>
              {save.isPending && <Spinner />} <CheckCircle2 className="size-4" /> Save Item
            </Button>
          </div>
        </div>
      </div>

      {/* Combo-colour mapping dialog (Phase 2). Opens when the user
          picks Copy-from on a BOM whose source has multiple distinct
          variant colours, OR whose target sticking-colour parses to
          multiple colours. The user maps each source variant-colour
          to the target variant-colour it should resolve to. */}
      <Dialog
        open={copyMapping != null}
        onClose={() => setCopyMapping(null)}
        size="md"
        title="Map colours for copy"
        description={
          copyMapping
            ? `Source "${copyMapping.sourceColourLabel}" → target "${copyMapping.targetColourLabel}". Pick which target colour each source colour should map to. Auto-defaulted by parsing the labels — change if wrong.`
            : undefined
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setCopyMapping(null)}>Cancel</Button>
            <Button
              onClick={() => {
                if (!copyMapping) return;
                applyCopy({
                  sourceRows: copyMapping.sourceRows,
                  targetProcId: copyMapping.targetProcId,
                  sourceColourLabel: copyMapping.sourceColourLabel,
                  targetVendorColour: copyMapping.targetColourLabel,
                  colourMap: copyMapping.mapping,
                });
                setCopyMapping(null);
              }}
            >
              Apply mapping
            </Button>
          </>
        }
      >
        {copyMapping && (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-muted/40 p-2.5 text-xs text-muted-foreground">
              We detected <b>{copyMapping.sourceVariantColours.length}</b> source colour{copyMapping.sourceVariantColours.length === 1 ? '' : 's'} and parsed <b>{copyMapping.targetParsedColours.length || 1}</b> target colour{copyMapping.targetParsedColours.length === 1 ? '' : 's'} from "{copyMapping.targetColourLabel}".
            </div>
            <div className="space-y-2">
              {copyMapping.sourceVariantColours.map((sc) => (
                <div key={sc} className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
                  <div className="rounded-md border border-border bg-card px-3 py-2 text-sm">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Source colour</div>
                    <div className="font-semibold">{sc}</div>
                  </div>
                  <div className="text-center text-muted-foreground">→</div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Target colour</div>
                    {/* Auto-suggest from parsed targets, but user can type
                        anything (in case the target sticking-colour string
                        doesn't actually carry the variant colour name). */}
                    <Input
                      list={`copy-target-colours`}
                      value={copyMapping.mapping[sc.toLowerCase()] ?? ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        setCopyMapping((cur) =>
                          cur ? { ...cur, mapping: { ...cur.mapping, [sc.toLowerCase()]: val } } : cur,
                        );
                      }}
                      placeholder="e.g. Pink"
                    />
                  </div>
                </div>
              ))}
              <datalist id="copy-target-colours">
                {copyMapping.targetParsedColours.map((c) => <option key={c} value={c} />)}
              </datalist>
            </div>
            <p className="text-xs text-muted-foreground">
              For each row in the source BOM, we'll look up the variant of the same material/size/shape/finish in the target colour. Rows with no match will show an inline "+ Create variant" chip.
            </p>
          </div>
        )}
      </Dialog>

      {/* CAD viewer modal */}
      <Dialog open={cadViewerOpen} onClose={() => setCadViewerOpen(false)} size="xl" title="CAD File Preview">
        {cadPath ? (
          <div className="space-y-2">
            <iframe src={fileUrl(cadPath)} className="h-[70vh] w-full rounded-md border border-border" title="CAD preview" />
            <a href={fileUrl(cadPath)} target="_blank" rel="noreferrer" className="text-sm text-primary hover:underline">Open in new tab</a>
          </div>
        ) : <p className="text-sm text-muted-foreground">No CAD file.</p>}
      </Dialog>

      {/* "Brings own materials" toggle prompt — opens when the user flips the
          checkbox on a Sticking vendor row. The rate's MEANING changes
          (per-stone labor vs per-piece all-inclusive) so we force a
          conscious rate update with the new semantic spelled out. Cancel
          aborts the toggle entirely. Confirm applies BOTH the toggle and
          the new rate in one go. */}
      <Dialog
        open={!!brOwnDialog}
        onClose={() => setBrOwnDialog(null)}
        size="md"
        title={brOwnDialog?.nextValue ? 'Switching to all-inclusive rate' : 'Switching back to per-stone labor'}
        description={
          brOwnDialog?.nextValue
            ? 'Vendor brings their own materials — the rate is now a FLAT per-piece price that covers labor + materials. BOM cost is excluded from the item cost. Update the rate below if it needs to change.'
            : 'Vendor will be supplied materials — the rate is now per STONE stuck (labor only). BOM materials get added separately to the item cost. Update the rate below.'
        }
        footer={
          <>
            <Button variant="outline" type="button" onClick={() => setBrOwnDialog(null)}>Cancel</Button>
            <Button
              type="button"
              onClick={() => {
                if (!brOwnDialog) return;
                const { pid, idx, nextValue, newRate } = brOwnDialog;
                // Apply the toggle AND the new rate in a single update so
                // the live cost preview reflects the correct semantic on
                // the very next render.
                updateVendor(pid, idx, {
                  bringsOwnMaterials: nextValue,
                  costPerPiece: newRate,
                });
                setBrOwnDialog(null);
              }}
            >
              Confirm
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <div className="font-semibold">Rate semantic is changing:</div>
            <div className="mt-1 flex items-center gap-2">
              <span className="rounded bg-card px-1.5 py-0.5 font-mono">
                ₹{brOwnDialog?.oldRate || '0'} {brOwnDialog?.nextValue ? '/ stone (labor)' : '/ pc (incl. mat.)'}
              </span>
              <span className="text-warning">→</span>
              <span className="rounded bg-card px-1.5 py-0.5 font-mono">
                ₹{brOwnDialog?.newRate || '0'} {brOwnDialog?.nextValue ? '/ pc (incl. mat.)' : '/ stone (labor)'}
              </span>
            </div>
          </div>
          <Field label={brOwnDialog?.nextValue ? 'New rate (₹ per piece · all-inclusive)' : 'New rate (₹ per stone · labor only)'}>
            <Input
              type="number"
              step="0.01"
              autoFocus
              value={brOwnDialog?.newRate ?? ''}
              onChange={(e) => {
                if (!brOwnDialog) return;
                setBrOwnDialog({ ...brOwnDialog, newRate: e.target.value });
              }}
            />
          </Field>
          <p className="text-[10px] text-muted-foreground">
            {brOwnDialog?.nextValue
              ? 'Example: vendor charges ₹15 per piece flat for sticking + materials, regardless of stone count.'
              : 'Example: vendor charges ₹0.08 per stone they stick; you supply pearls/stones/etc.'}
          </p>
        </div>
      </Dialog>

      {/* Rate-change confirmation dialog — opens when one or more BOM lines'
          rates differ from the values loaded on form open. User picks per
          row whether to commit the new rate or revert to the previous.
          Confirming applies their picks back into the bom state AND fires
          the save with the materialised payload. Cancelling closes the
          dialog with no state mutation — the user goes back to the form. */}
      <Dialog
        open={!!rateChangeDialog}
        onClose={() => setRateChangeDialog(null)}
        size="lg"
        title="Rate changes detected"
        description="Some BOM materials have a different rate than the last save. Pick which value to use for each row, then confirm to save."
        footer={
          <>
            <Button variant="outline" type="button" onClick={() => setRateChangeDialog(null)}>Cancel</Button>
            <Button
              type="button"
              onClick={() => {
                if (!rateChangeDialog) return;
                // Apply picks back to the bom state so the row inputs reflect
                // the chosen value AND build a fresh payload that mirrors it.
                const nextBom = [...bom];
                const nextPayloadMaterials = (rateChangeDialog.pendingPayload.materials ?? []).map((m: any) => ({ ...m }));
                for (const c of rateChangeDialog.changes) {
                  const chosen = c.pick === 'old' ? c.oldRate : c.newRate;
                  nextBom[c.idx] = { ...nextBom[c.idx], rate: chosen };
                  // Find matching payload row by variantId + processId + color.
                  const pm = nextPayloadMaterials.find(
                    (m: any) => m.variantId === c.variantId &&
                      ((m.processId ?? null) === (nextBom[c.idx].processId ?? null)) &&
                      ((m.color ?? '') === (nextBom[c.idx].color ?? '')),
                  );
                  if (pm) pm.rate = chosen !== '' ? Number(chosen) : undefined;
                }
                setBom(nextBom);
                // Refresh the originalRates snapshot so saving again won't
                // re-prompt for the same rows.
                const snap = new Map(originalRates);
                for (const c of rateChangeDialog.changes) {
                  const key = `${nextBom[c.idx].processId ?? 'na'}|${c.variantId}|${(c.color ?? '').toLowerCase()}`;
                  snap.set(key, c.pick === 'old' ? c.oldRate : c.newRate);
                }
                setOriginalRates(snap);
                const payload = { ...rateChangeDialog.pendingPayload, materials: nextPayloadMaterials };
                setRateChangeDialog(null);
                save.mutate(payload);
              }}
              disabled={save.isPending}
            >
              {save.isPending && <Spinner />} Confirm &amp; Save
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-sm">
          {rateChangeDialog?.changes.map((c, ci) => (
            <div key={ci} className="rounded-md border border-warning/30 bg-warning/15 p-3">
              <div className="mb-2 font-semibold text-warning">
                {c.variantName}
                <span className="ml-2 text-xs font-normal text-warning">
                  · {c.processName}{c.color ? ` · ${c.color}` : ''}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {(['old', 'new'] as const).map((opt) => {
                  const val = opt === 'old' ? c.oldRate : c.newRate;
                  const labelTop = opt === 'old' ? 'Previous rate (last save)' : 'New rate (current input)';
                  return (
                    <label
                      key={opt}
                      className={`flex cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-2 transition-colors ${
                        c.pick === opt
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border bg-card text-muted-foreground hover:bg-muted/50'
                      }`}
                    >
                      <div className="flex flex-col">
                        <span className="text-[10px] uppercase tracking-wide">{labelTop}</span>
                        <span className="font-semibold tabular-nums text-foreground">
                          {val === '' ? '(master price)' : `₹${val}`}
                        </span>
                      </div>
                      <input
                        type="radio"
                        className="size-4 accent-primary"
                        checked={c.pick === opt}
                        onChange={() => {
                          if (!rateChangeDialog) return;
                          setRateChangeDialog({
                            ...rateChangeDialog,
                            changes: rateChangeDialog.changes.map((x, xi) => (xi === ci ? { ...x, pick: opt } : x)),
                          });
                        }}
                      />
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Dialog>
      </fieldset>
    </div>
  );
}
