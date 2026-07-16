'use client';

import * as React from 'react';
import { useFieldArray, useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Info, Ruler, ImageIcon, Users, Palette } from 'lucide-react';
import { Api, getApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Field, SectionTitle } from '@/components/shared/field';
import { ImageUpload } from '@/components/shared/image-upload';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { Category, MaterialVariant, VendorLite } from '@/lib/types';

const vendorSchema = z.object({
  vendorId: z.coerce.number().min(1, 'Select a vendor'),
  vendorReference: z.string().max(80).optional().or(z.literal('')),
  price: z.coerce.number().optional().or(z.nan()),
  moq: z.coerce.number().optional().or(z.nan()),
  notes: z.string().optional().or(z.literal('')),
  isPreferred: z.boolean().optional(),
});

const schema = z.object({
  materialName: z.string().min(1, 'Material name is required').max(150),
  categoryId: z.string().optional(),
  variantName: z.string().min(1, 'Variant name is required').max(150),
  size: z.string().min(1, 'Size is required'),
  color: z.string().min(1, 'Colour is required'),
  finish: z.string().optional(),
  shape: z.string().optional(),
  unit: z.string().optional(),
  notes: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  // Dual stock tracking. At least one must be true (form enforces a default
  // of qty-only; server re-validates).
  trackByQty: z.boolean().optional(),
  trackByWeight: z.boolean().optional(),
  // Manufacturing processes this variant is eligible for. Empty = no
  // restriction (variant shows up for any process at issue time).
  processIds: z.array(z.coerce.number().int()).optional(),
  // Opening stock — qty already with us when creating this variant. Whole
  // number; only used on CREATE (ignored when editing).
  initialStock: z.coerce.number().min(0).optional().or(z.nan()),
  initialStockWeight: z.coerce.number().min(0).optional().or(z.nan()),
  vendors: z.array(vendorSchema).min(1, 'Add at least one supplier'),
});
type FormValues = z.infer<typeof schema>;

export function VariantForm({
  open,
  onClose,
  variantId,
  initialMaterialName,
}: {
  open: boolean;
  onClose: () => void;
  variantId: number | null;
  // Pre-filled value for the Material Name field on create. Comes from the
  // "+ New Material Variant" deep-link out of Item Master's BOM picker —
  // so the user doesn't have to re-type what they were just searching for.
  // Ignored when variantId is set (edit mode).
  initialMaterialName?: string;
}) {
  const qc = useQueryClient();
  const [imagePaths, setImagePaths] = React.useState<string[]>([]);

  // ── Bulk-create colours mode (CREATE only) ─────────────────────────────
  // When ON: the single Color / Variant Name / Opening Stock / Image
  // inputs disappear; user enters one shared base + a list of colour rows
  // (color + price + initial stock + image). Submit hits the bulk-colors
  // endpoint and creates N variants in one transaction. Edit mode never
  // shows the toggle — you're editing one row, not creating N.
  type BulkColor = { _k: string; color: string; price: string; initialStock: string; initialStockWeight: string; imagePaths: string[] };
  const newBulkColor = (): BulkColor => ({ _k: Math.random().toString(36).slice(2, 9), color: '', price: '', initialStock: '0', initialStockWeight: '0', imagePaths: [] });
  const [bulkMode, setBulkMode] = React.useState(false);
  const [bulkColors, setBulkColors] = React.useState<BulkColor[]>([newBulkColor()]);
  // Edit mode forces single-mode regardless of the user's last toggle state.
  const showBulkToggle = !variantId;
  const inBulkMode = showBulkToggle && bulkMode;

  // Schema requires variantName + color to be non-empty. In bulk mode the
  // server derives both per-colour, so we stub the form values to pass
  // validation. Submit logic ignores them in bulk mode.
  React.useEffect(() => {
    if (inBulkMode) {
      setValue('variantName', '— bulk —');
      setValue('color', '— bulk —');
    } else {
      // Clear the stub when toggle goes off so the user sees a blank field
      // (rather than the placeholder).
      const v = (watch('variantName') ?? '').toString();
      const c = (watch('color') ?? '').toString();
      if (v === '— bulk —') setValue('variantName', '');
      if (c === '— bulk —') setValue('color', '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inBulkMode]);

  const categoriesQ = useQuery<Category[]>({
    queryKey: ['categories'], queryFn: () => Api.materials.categories(), enabled: open,
  });
  // Material variants are supplied by Raw Material Suppliers only — restrict the
  // vendor dropdown to vendors tagged with that role.
  const processesQ = useQuery({ queryKey: ['processes'], queryFn: () => Api.processes(), enabled: open });
  const supplierProcessId = (processesQ.data ?? []).find((p: any) => p.isSupplier)?.id;
  const vendorsQ = useQuery<VendorLite[]>({
    queryKey: ['suppliers-lite', supplierProcessId],
    queryFn: () => Api.vendors.list({ status: 'ACTIVE', processId: supplierProcessId }),
    enabled: open && !!supplierProcessId,
  });

  const {
    register, handleSubmit, reset, control, watch, setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { status: 'ACTIVE', vendors: [] },
  });

  const { fields, append, remove } = useFieldArray({ control, name: 'vendors' });

  // Live generated code: supplierShort-Material-Size-Colour (blank segments skipped).
  const wMaterial = watch('materialName');
  const wSize = watch('size');
  const wColor = watch('color');
  // Watched so the bulk-mode "Variant Name pattern" preview reflects
  // the shape live as the user types it. Kept off the single-mode
  // genCode (codes don't include shape).
  const wShape = watch('shape');
  const wVendors = watch('vendors');
  const supplierVendor = (wVendors ?? []).find((v) => v.isPreferred) ?? (wVendors ?? [])[0];
  const supplierShort = (vendorsQ.data ?? []).find((v) => v.id === Number(supplierVendor?.vendorId))?.shortName ?? '';
  const genCode = [supplierShort, wMaterial, wSize, wColor]
    .map((s) => (s ?? '').toString().trim().replace(/\s+/g, ''))
    .filter(Boolean)
    .join('-');

  React.useEffect(() => {
    if (!open) return;
    if (variantId) {
      Api.materials.getVariant(variantId).then((v: MaterialVariant) => {
        reset({
          materialName: v.materialName,
          categoryId: v.categoryId ? String(v.categoryId) : '',
          variantName: v.variantName,
          size: v.size ?? '', color: v.color ?? '', finish: v.finish ?? '',
          shape: v.shape ?? '', unit: v.unit ?? '', notes: v.notes ?? '',
          status: v.status,
          trackByQty: (v as any).trackByQty ?? true,
          trackByWeight: (v as any).trackByWeight ?? false,
          processIds: (v as any).processIds ?? [],
          vendors: (v.vendors ?? []).map((vv) => ({
            vendorId: vv.vendorId,
            vendorReference: vv.vendorReference ?? '',
            price: vv.price ?? (undefined as any),
            moq: vv.moq ?? (undefined as any),
            notes: vv.notes ?? '',
            isPreferred: vv.isPreferred ?? false,
          })),
        });
        setImagePaths(v.imagePath ? [v.imagePath] : []);
      });
    } else {
      // Pre-fill Material Name from the deep-link if provided (e.g. Item
      // Master BOM picker → "+ New Material Variant" opens this form with
      // the typed search query already in the field).
      reset({
        status: 'ACTIVE',
        materialName: initialMaterialName ?? '',
        variantName: '',
        vendors: [],
        trackByQty: true,
        trackByWeight: false,
        initialStock: 0 as any,
        initialStockWeight: 0 as any,
        processIds: [],
      });
      setImagePaths([]);
      setBulkMode(false);
      setBulkColors([newBulkColor()]);
    }
  }, [open, variantId, reset, initialMaterialName]);

  const mutation = useMutation({
    mutationFn: (values: FormValues) => {
      // ── Bulk-create colours path ─────────────────────────────────────
      if (inBulkMode) {
        // Local pre-check: at least one colour, all rows have a name,
        // no duplicate colour names. Backend re-validates.
        const rows = bulkColors;
        if (rows.length === 0) throw new Error('Add at least one colour row.');
        const seen = new Set<string>();
        for (const r of rows) {
          const k = r.color.trim().toLowerCase();
          if (!k) throw new Error('Every colour row needs a colour name.');
          if (seen.has(k)) throw new Error(`Duplicate colour "${r.color}" — every row must be distinct.`);
          seen.add(k);
        }
        const primaryVendor = values.vendors.find((v) => v.vendorId > 0) ?? values.vendors[0];
        if (!primaryVendor?.vendorId) throw new Error('Pick a supplier vendor.');
        return Api.materials.bulkCreateColorVariants({
          materialName: values.materialName,
          categoryId: values.categoryId ? Number(values.categoryId) : undefined,
          size: values.size || undefined,
          finish: values.finish || undefined,
          shape: values.shape || undefined,
          unit: values.unit || undefined,
          notes: values.notes || undefined,
          trackByQty: values.trackByQty ?? true,
          trackByWeight: values.trackByWeight ?? false,
          vendorId: Number(primaryVendor.vendorId),
          vendorReference: primaryVendor.vendorReference || undefined,
          moq: Number.isNaN(primaryVendor.moq as any) ? undefined : (primaryVendor.moq as number | undefined),
          vendorNotes: primaryVendor.notes || undefined,
          colors: rows.map((r) => ({
            color: r.color.trim(),
            price: r.price.trim() === '' ? undefined : Number(r.price),
            initialStock: r.initialStock.trim() === '' ? 0 : Math.max(0, Number(r.initialStock)),
            initialStockWeight: r.initialStockWeight.trim() === '' ? 0 : Math.max(0, Number(r.initialStockWeight)),
            imagePath: r.imagePaths[0] || undefined,
          })),
        });
      }
      // ── Standard single-variant path ─────────────────────────────────
      const body = {
        ...values,
        categoryId: values.categoryId ? Number(values.categoryId) : undefined,
        imagePath: imagePaths[0],
        trackByQty: values.trackByQty ?? true,
        trackByWeight: values.trackByWeight ?? false,
        processIds: (values.processIds ?? []).map((id) => Number(id)).filter((id) => id > 0),
        // Opening stock — only sent on CREATE. Backend writes the running
        // balances on the variant + a StockMovement entry per dimension.
        initialStock: !variantId && !Number.isNaN(values.initialStock as any)
          ? Math.max(0, Number(values.initialStock ?? 0))
          : undefined,
        initialStockWeight: !variantId && !Number.isNaN(values.initialStockWeight as any)
          ? Math.max(0, Number(values.initialStockWeight ?? 0))
          : undefined,
        vendors: values.vendors
          .filter((v) => v.vendorId > 0)
          .map((v) => ({
            vendorId: Number(v.vendorId),
            vendorReference: v.vendorReference || undefined,
            price: Number.isNaN(v.price as any) ? undefined : v.price,
            moq: Number.isNaN(v.moq as any) ? undefined : v.moq,
            notes: v.notes || undefined,
            isPreferred: !!v.isPreferred,
          })),
      };
      return variantId
        ? Api.materials.updateVariant(variantId, body)
        : Api.materials.createVariant(body);
    },
    onSuccess: (res: any) => {
      const n = res?.created?.length ?? 0;
      toast.success(
        inBulkMode ? `Created ${n} colour variant${n === 1 ? '' : 's'}.`
        : variantId ? 'Variant updated.' : 'Variant created.',
      );
      qc.invalidateQueries({ queryKey: ['variants'] });
      qc.invalidateQueries({ queryKey: ['materials-list'] });
      onClose();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title={variantId ? 'Edit Material Variant' : 'Add Material Variant'}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
          <Button form="variantForm" type="submit" disabled={isSubmitting}>
            {isSubmitting && <Spinner />} Save Variant
          </Button>
        </>
      }
    >
      <form id="variantForm" onSubmit={handleSubmit((v) => mutation.mutate(v))} className="space-y-5">
        {/* Bulk-mode toggle — CREATE only. When ON, the single Color /
            Variant Name / Image / Opening Stock inputs hide and a
            "Colours to create" section appears below. Each colour row
            becomes its own variant in one bulk save. */}
        {showBulkToggle && (
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
            <div className="flex items-center gap-2">
              <Palette className="size-4 text-primary" />
              <div>
                <div className="text-sm font-semibold">Bulk-create colour variants</div>
                <div className="text-xs text-muted-foreground">
                  Enter shared base (material / size / vendor) once + a list of colours below. One save → N variants.
                </div>
              </div>
            </div>
            <input
              type="checkbox"
              className="size-5 accent-primary"
              checked={bulkMode}
              onChange={(e) => setBulkMode(e.target.checked)}
            />
          </label>
        )}

        <div>
          <SectionTitle><Info className="size-4" /> Basic Information</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Material Name" required error={errors.materialName?.message}
              hint="Type a new name to create a material, or pick an existing one.">
              <Input list="materialDatalist" {...register('materialName')} />
              <MaterialDatalist />
            </Field>
            <Field label="Category">
              <Controller name="categoryId" control={control} render={({ field }) => (
                <SearchableSelect
                  value={field.value ?? ''}
                  placeholder="— Select or type to add —"
                  onChange={field.onChange}
                  options={(categoriesQ.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
                  // Inline create: POST a new MaterialCategory, refetch the
                  // dropdown's list, then auto-select the newly-created id
                  // so the form keeps the user's flow uninterrupted.
                  // Idempotent server-side (case-insensitive dedupe) so
                  // double-clicks won't spawn duplicates.
                  createLabel="Add category"
                  onCreate={async (name) => {
                    try {
                      const created = await Api.materials.createCategory(name);
                      await qc.invalidateQueries({ queryKey: ['categories'] });
                      field.onChange(String(created.id));
                      toast.success(`Category "${created.name}" added.`);
                    } catch (e) {
                      toast.error(getApiError(e).message);
                    }
                  }}
                />
              )} />
            </Field>
            {!inBulkMode && (
              <Field label="Variant Name" required error={errors.variantName?.message}>
                <Input placeholder="e.g. Pearl 4mm White" {...register('variantName')} />
              </Field>
            )}
            {inBulkMode && (
              <Field label="Variant Name pattern" hint="Auto-generated per colour as “{Size} {Shape} {Material} {Colour}”">
                <Input
                  disabled
                  value={[wSize, wShape, wMaterial, '<Colour>']
                    .map((s) => (s ?? '').toString().trim())
                    .filter(Boolean)
                    .join(' ') || '(Size) (Shape) (Material) <Colour>'}
                  className="bg-muted/40 italic"
                />
              </Field>
            )}
            <Field label="Status">
              <Select {...register('status')}>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </Select>
            </Field>
          </div>
        </div>

        <div>
          <SectionTitle><Ruler className="size-4" /> Variant Details</SectionTitle>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Field label="Size" required error={errors.size?.message}><Input {...register('size')} /></Field>
            {/* Color + Opening Stock are per-row in bulk mode — hide them in
                the shared section to avoid duplicate / confusing inputs. */}
            {!inBulkMode && (
              <Field label="Color" required error={errors.color?.message}><Input {...register('color')} /></Field>
            )}
            <Field label="Finish"><Input {...register('finish')} /></Field>
            <Field label="Shape"><Input {...register('shape')} /></Field>
            <Field label="Unit"><Input placeholder="pcs / gm / mm" {...register('unit')} /></Field>
            <Field label="Notes" className={variantId ? 'col-span-2 sm:col-span-3' : 'col-span-2'}><Input {...register('notes')} /></Field>
          </div>

          {/* Process eligibility — operators tick which manufacturing steps
              this material can be issued for. The Forward dialog's "issue
              materials" picker filters by these so a Filing forward only
              sees Filing-eligible variants. Empty = unrestricted. */}
          {(() => {
            const allProcs = (processesQ.data ?? []) as any[];
            const manufacturingProcs = allProcs.filter(
              (p: any) => !p.isSupplier && !p.batchOnly && p.code !== 'CAM',
            );
            const selectedIds: number[] = (watch('processIds') as any) ?? [];
            const toggle = (id: number) => {
              const next = selectedIds.includes(id)
                ? selectedIds.filter((x) => x !== id)
                : [...selectedIds, id];
              setValue('processIds', next, { shouldDirty: true });
            };
            return (
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">Process Eligibility</div>
                  <span className="text-[10px] text-text-faint">
                    {selectedIds.length === 0 ? 'unrestricted (all processes)' : `${selectedIds.length} ticked`}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {manufacturingProcs.map((p: any) => {
                    const checked = selectedIds.includes(p.id);
                    return (
                      <label
                        key={p.id}
                        className={cn(
                          'flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm transition-colors',
                          checked
                            ? 'border-gold/40 bg-gold/10 text-foreground'
                            : 'border-border bg-card text-text-muted hover:border-gold/30 hover:bg-secondary/40',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="accent-gold size-4"
                          checked={checked}
                          onChange={() => toggle(p.id)}
                        />
                        <span className="font-medium">{p.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Stock tracking dimensions — at least one of qty/weight must be
              ticked. Silver / loose metal is typically weight-only; counted
              parts like silver balls or hooks are qty-only; stones &
              findings often track both. */}
          <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">Stock Tracking</div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-primary size-4" {...register('trackByQty')} />
                Track by Quantity
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-primary size-4" {...register('trackByWeight')} />
                Track by Weight (g)
              </label>
              {!variantId && !inBulkMode && (watch('trackByQty') ?? true) && (
                <Field label="Opening Qty" hint="pcs already with us">
                  <Input type="number" step="0.001" min="0" placeholder="0" {...register('initialStock')} />
                </Field>
              )}
              {!variantId && !inBulkMode && (watch('trackByWeight') ?? false) && (
                <Field label="Opening Weight (g)" hint="grams already with us">
                  <Input type="number" step="0.001" min="0" placeholder="0.000" {...register('initialStockWeight')} />
                </Field>
              )}
            </div>
          </div>

          {!inBulkMode && (
            <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Generated Material Code</div>
              <div className={cn(
                'mt-1 text-sm',
                genCode ? 'font-semibold tracking-tight text-foreground' : 'italic text-text-faint',
              )}>
                {genCode || 'Pick a supplier and fill material / size / colour to preview the code.'}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Format: SupplierShort-Material-Size-Colour — auto from the preferred supplier.
              </p>
            </div>
          )}
        </div>

        {/* ── Bulk Colours block — only rendered in bulk mode ───────────── */}
        {inBulkMode && (
          <div>
            <SectionTitle><Palette className="size-4" /> Colours to create</SectionTitle>
            <div className="space-y-2">
              {bulkColors.map((row, idx) => {
                const previewCode = [
                  (vendorsQ.data ?? []).find((v) => v.id === Number(watch('vendors.0.vendorId')))?.shortName ?? '',
                  wMaterial,
                  wSize,
                  row.color,
                ].map((s) => (s ?? '').toString().trim().replace(/\s+/g, '')).filter(Boolean).join('-');
                return (
                  <div key={row._k} className="rounded-lg border border-border bg-muted/30 p-3">
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                      <div className="sm:col-span-2">
                        <Field label="Colour" required>
                          <Input
                            placeholder="e.g. White"
                            value={row.color}
                            onChange={(e) => {
                              const v = e.target.value;
                              setBulkColors((cur) => cur.map((r, i) => i === idx ? { ...r, color: v } : r));
                            }}
                          />
                        </Field>
                      </div>
                      <div className="sm:col-span-2">
                        <Field label="Price (₹)">
                          <Input
                            type="number"
                            step="0.01"
                            placeholder="0.00"
                            value={row.price}
                            onChange={(e) => {
                              const v = e.target.value;
                              setBulkColors((cur) => cur.map((r, i) => i === idx ? { ...r, price: v } : r));
                            }}
                          />
                        </Field>
                      </div>
                      {(watch('trackByQty') ?? true) && (
                        <div className="sm:col-span-2">
                          <Field label="Opening qty">
                            <Input
                              type="number"
                              step="0.001"
                              min="0"
                              placeholder="0"
                              value={row.initialStock}
                              onChange={(e) => {
                                const v = e.target.value;
                                setBulkColors((cur) => cur.map((r, i) => i === idx ? { ...r, initialStock: v } : r));
                              }}
                            />
                          </Field>
                        </div>
                      )}
                      {(watch('trackByWeight') ?? false) && (
                        <div className="sm:col-span-2">
                          <Field label="Opening wt (g)">
                            <Input
                              type="number"
                              step="0.001"
                              min="0"
                              placeholder="0.000"
                              value={row.initialStockWeight}
                              onChange={(e) => {
                                const v = e.target.value;
                                setBulkColors((cur) => cur.map((r, i) => i === idx ? { ...r, initialStockWeight: v } : r));
                              }}
                            />
                          </Field>
                        </div>
                      )}
                      <div className="sm:col-span-3">
                        <Field label="Image">
                          <ImageUpload
                            module="materials"
                            value={row.imagePaths}
                            onChange={(paths) => {
                              setBulkColors((cur) => cur.map((r, i) => i === idx ? { ...r, imagePaths: paths } : r));
                            }}
                          />
                        </Field>
                      </div>
                      <div className="flex items-end justify-end sm:col-span-1">
                        {bulkColors.length > 1 && (
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="mb-0.5 text-destructive hover:bg-destructive/10"
                            onClick={() => setBulkColors((cur) => cur.filter((_, i) => i !== idx))}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                    {/* Live per-colour code preview */}
                    <div className="mt-2 flex items-center gap-2 rounded bg-background px-2 py-1.5 text-xs">
                      <span className="text-muted-foreground">Will be created as:</span>
                      <span className={cn(previewCode ? 'font-semibold tracking-tight' : 'italic text-text-faint')}>
                        {previewCode || 'Pick supplier · material · size · colour to preview.'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                // New row defaults to the PREVIOUS row's price + opening
                // stock — saves the user from re-typing when colours
                // share rates (which is most of the time).
                const prev = bulkColors[bulkColors.length - 1];
                setBulkColors((cur) => [...cur, {
                  ...newBulkColor(),
                  price: prev?.price ?? '',
                  initialStock: prev?.initialStock ?? '0',
                  initialStockWeight: prev?.initialStockWeight ?? '0',
                }]);
              }}
            >
              <Plus className="size-4" /> Add colour
            </Button>
          </div>
        )}

        <div>
          <SectionTitle>
            <Users className="size-4" />
            {inBulkMode ? 'Raw Material Supplier — single, shared across colours' : 'Raw Material Supplier(s) — at least one required'}
          </SectionTitle>
          <div className="space-y-2">
            {/* In bulk mode we render ONLY the first vendor row + hide
                price (per-colour in the Colours section), Pref (always
                preferred), and the remove button. Add-vendor is also
                hidden. Secondary vendors can be added per-variant via
                the single-variant edit form after bulk creation. */}
            {(inBulkMode ? fields.slice(0, 1) : fields).map((f, idx) => (
              <div key={f.id} className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
                  <div className="sm:col-span-3">
                    <Field label="Vendor" error={errors.vendors?.[idx]?.vendorId?.message}>
                      <Controller name={`vendors.${idx}.vendorId` as const} control={control} render={({ field }) => (
                        <SearchableSelect
                          value={field.value ?? ''}
                          placeholder="— Select vendor —"
                          onChange={(v) => field.onChange(v ? Number(v) : '')}
                          options={(vendorsQ.data ?? []).map((v) => ({ value: v.id, label: `${v.vendorCode} · ${v.vendorName}`, keywords: v.vendorName }))}
                        />
                      )} />
                    </Field>
                  </div>
                  <div className="sm:col-span-3">
                    <Field label="Vendor Reference">
                      <Input placeholder="e.g. PRL-4W" {...register(`vendors.${idx}.vendorReference` as const)} />
                    </Field>
                  </div>
                  {!inBulkMode && (
                    <div className="sm:col-span-2">
                      <Field label="Price (₹)">
                        <Input type="number" step="0.01" {...register(`vendors.${idx}.price` as const)} />
                      </Field>
                    </div>
                  )}
                  <div className={inBulkMode ? 'sm:col-span-4' : 'sm:col-span-2'}>
                    <Field label="MOQ">
                      <Input type="number" step="0.01" {...register(`vendors.${idx}.moq` as const)} />
                    </Field>
                  </div>
                  {!inBulkMode && (
                    <div className="flex items-end justify-between gap-2 sm:col-span-2">
                      <label className="flex items-center gap-1.5 pb-2 text-sm">
                        <input type="checkbox" className="accent-primary" {...register(`vendors.${idx}.isPreferred` as const)} />
                        Pref
                      </label>
                      <Button type="button" variant="outline" size="icon"
                        className="mb-0.5 text-destructive hover:bg-destructive/10"
                        onClick={() => remove(idx)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {/* In bulk mode auto-seed the first vendor row if the user
                hasn't added one yet, so the Vendor SearchableSelect
                renders without the user clicking "Add Vendor" first. */}
            {inBulkMode && fields.length === 0 && (
              <Button
                type="button" variant="outline" size="sm"
                onClick={() => append({ vendorId: 0 as any, vendorReference: '', notes: '', isPreferred: true } as any)}
              >
                <Plus className="size-4" /> Pick supplier
              </Button>
            )}
          </div>
          {!inBulkMode && (
            <Button
              type="button" variant="outline" size="sm" className="mt-2"
              onClick={() => append({ vendorId: 0 as any, vendorReference: '', notes: '', isPreferred: false } as any)}
            >
              <Plus className="size-4" /> Add Vendor
            </Button>
          )}
        </div>

        {!inBulkMode && (
          <div>
            <SectionTitle><ImageIcon className="size-4" /> Image</SectionTitle>
            <ImageUpload module="materials" value={imagePaths} onChange={setImagePaths} />
          </div>
        )}
      </form>
    </Dialog>
  );
}

function MaterialDatalist() {
  const { data } = useQuery({ queryKey: ['materials-list'], queryFn: () => Api.materials.list() });
  return (
    <datalist id="materialDatalist">
      {(data ?? []).map((m: any) => (
        <option key={m.id} value={m.materialName} />
      ))}
    </datalist>
  );
}
