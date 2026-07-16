'use client';

import * as React from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Send, ExternalLink, Info, Plus, Trash2, Package } from 'lucide-react';
import { Api, getApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { cn } from '@/lib/utils';

/**
 * Bulk Forward — opens from the ✈ Send icon on a batch row in Production
 * Management. Lists EVERY idle stage on the batch (anything with
 * availableToForward > 0), one row each. Operator picks a target process,
 * vendor, qty, weight, rate, and colour per row. "Set all rows to…" forces
 * one process across every row with fresh defaults. Submit fires
 * forwardStage per row in sequence.
 *
 * Sticking targets are supported inline — the per-row "+ Sticking BOM"
 * expandable lets the operator capture variant × qty/piece rows AND flip
 * the "karigar brings own materials" toggle before send. Same feature
 * set as the single-stage ForwardDialog per the forward-parity rule.
 * "Open individually" link per row defers to the parent's
 * onForwardIndividually callback when wired.
 */

type RowInput = {
  include: boolean;
  targetProcessId: number | '';
  color: string;
  // EXPLICIT custom-colour flag — don't infer from `color` value alone. When
  // true, the colour cell renders a text input + "↺ list" button to revert
  // to the dropdown. Without this flag, an operator who types a fresh
  // colour and tabs away would see their text snap back to "+ custom…" the
  // next render. Pratik's bulk-forward used the same pattern.
  customMode: boolean;
  vendorId: number | '';
  quantity: string;
  weight: string;
  costPerKg: string;
  vendorRef: string;
  // Purpose — customer / order label. Defaults to source stage's purpose so
  // the carried-over context is editable per row before submit.
  purpose: string;
};

// Colour-capable processes — these get a Colour picker; others render "—".
// Mirrors backend COLOUR_PROCESSES for the silver chain.
const COLOUR_PROCESS_CODES = new Set(['PLATING', 'MEENA', 'FITTING_MALA', 'STICKING']);

// Per-piece weight carry-forward — parity with single-forward's
// pre-fill (see batch-detail.tsx `ForwardDialog`'s init effect):
//   raw* = physical receipt sums (what the karigar actually weighed)
//   settled = plan × qty (ignores casting-loss / plating-gain)
// We use the raw pair so casting-loss / plating-gain cascade through
// every downstream stage. Falls back to the source's planned per-pc
// when nothing has been physically received yet.
function recvPerPc(st: any): string {
  const rawW = Number(st.rawReceivedWeight ?? 0);
  const rawQ = Number(st.rawReceivedQty ?? 0);
  if (rawQ > 0 && rawW > 0) return (rawW / rawQ).toFixed(3);
  // Legacy fallback for rows that predate the raw* columns being populated.
  const recvQ = Number(st.receivedQty ?? 0);
  const recvW = Number(st.receivedWeight ?? 0);
  if (recvQ > 0 && recvW > 0) return (recvW / recvQ).toFixed(3);
  return '';
}

// Compute fresh row defaults for a stage given a target process and optional
// forced colour. `itemByStage` maps stageId → item-master payload (from the
// useQueries fetch).
function computeRowDefaults(
  st: any,
  targetProcessId: number | '',
  forcedColour: string | undefined,
  itemByStage: Map<number, any>,
): RowInput {
  const lineDone = (st.lineCodes ?? []).includes(
    (st as any).targetProcessCode ?? '',
  );
  const item = itemByStage.get(st.id);
  const itemProc = item?.processes?.find((p: any) => p.processId === targetProcessId);
  const procVendors: any[] = itemProc?.vendors ?? [];

  // Colour: forced > source > first master colour on (item × process) > ''
  const sourceColour = (st.color ?? '').trim();
  const firstMasterColour = procVendors.find((v) => (v.color ?? '').trim())?.color ?? '';
  const color = forcedColour ?? sourceColour ?? firstMasterColour ?? '';

  // Vendor: master vendor for the chosen colour > preferred > source > ''
  const colourLower = (color ?? '').trim().toLowerCase();
  const colourMatch = colourLower
    ? procVendors.find((v) => (v.color ?? '').trim().toLowerCase() === colourLower)
    : null;
  const preferred = procVendors.find((v) => v.isPreferred);
  const chosen = colourMatch ?? preferred ?? procVendors[0] ?? null;
  const vendorId: number | '' = chosen?.vendorId ?? (st.vendorId ?? '');

  // Weight: ACTUAL received per-pc from the source's receipts wins, else
  // source's planned per-pc, else blank.
  const weight = recvPerPc(st) || (st.weight != null ? String(st.weight) : '');

  return {
    include: !lineDone,
    targetProcessId,
    color: color ?? '',
    vendorId,
    quantity: String(st.availableToForward ?? 0),
    weight,
    costPerKg: chosen?.costPerPiece != null ? String(chosen.costPerPiece) : '',
    vendorRef:
      chosen?.vendorDesignReference ??
      (st.vendorDesignReference ?? ''),
    purpose: st.purpose ?? '',
    customMode: false,
  };
}

export function BulkForwardDialog({
  batchId,
  open,
  onClose,
  onDone,
  onForwardIndividually,
}: {
  batchId: number | null;
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
  onForwardIndividually?: (stage: any) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [forwardDate, setForwardDate] = React.useState<string>(today);
  const [bulkProcessId, setBulkProcessId] = React.useState<number | ''>('');
  const [rows, setRows] = React.useState<Record<number, RowInput>>({});
  // Per-row material issuance. Keyed by stageId → list of material lines.
  // Each row can independently attach materials that ride along with its
  // forward call (bundled as `extraMaterials` on the backend forwardStage
  // payload, so the receiving vendor gets a material-issue voucher).
  type MatLine = { _k: number; variantId: number | ''; qty: string; weight: string; notes: string };
  const [matRows, setMatRows] = React.useState<Record<number, MatLine[]>>({});
  const [openMats, setOpenMats] = React.useState<Record<number, boolean>>({});
  const newMatLine = (): MatLine => ({ _k: Math.random(), variantId: '', qty: '', weight: '', notes: '' });
  const addMatLine = (stageId: number) =>
    setMatRows((m) => ({ ...m, [stageId]: [...(m[stageId] ?? []), newMatLine()] }));
  const patchMatLine = (stageId: number, idx: number, patch: Partial<MatLine>) =>
    setMatRows((m) => ({
      ...m,
      [stageId]: (m[stageId] ?? []).map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    }));
  const removeMatLine = (stageId: number, idx: number) =>
    setMatRows((m) => ({ ...m, [stageId]: (m[stageId] ?? []).filter((_, i) => i !== idx) }));
  const toggleMats = (stageId: number) => {
    setOpenMats((m) => ({ ...m, [stageId]: !m[stageId] }));
    // Seed an empty line the first time the section opens so the picker is
    // immediately usable — otherwise the operator has to click "+ Add" first.
    setMatRows((m) => (m[stageId]?.length ? m : { ...m, [stageId]: [newMatLine()] }));
  };

  // Per-row Sticking BOM. Only relevant when the row's target process is
  // STICKING. Mirrors single-forward's inline BOM auto-capture: operator
  // adds { variant × qty/piece } rows that are saved to the Item Master
  // AND applied to this forward's material-issue voucher.
  type BomLine = { _k: number; variantId: number | ''; perPiece: string };
  const [bomRows, setBomRows] = React.useState<Record<number, BomLine[]>>({});
  const [openBom, setOpenBom] = React.useState<Record<number, boolean>>({});
  const [bringsOwn, setBringsOwn] = React.useState<Record<number, boolean>>({});
  const newBomLine = (): BomLine => ({ _k: Math.random(), variantId: '', perPiece: '' });
  const addBomLine = (stageId: number) =>
    setBomRows((m) => ({ ...m, [stageId]: [...(m[stageId] ?? []), newBomLine()] }));
  const patchBomLine = (stageId: number, idx: number, patch: Partial<BomLine>) =>
    setBomRows((m) => ({
      ...m,
      [stageId]: (m[stageId] ?? []).map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    }));
  const removeBomLine = (stageId: number, idx: number) =>
    setBomRows((m) => ({ ...m, [stageId]: (m[stageId] ?? []).filter((_, i) => i !== idx) }));
  const toggleBom = (stageId: number) => {
    setOpenBom((m) => ({ ...m, [stageId]: !m[stageId] }));
    setBomRows((m) => (m[stageId]?.length ? m : { ...m, [stageId]: [newBomLine()] }));
  };
  const [submitting, setSubmitting] = React.useState(false);

  const batchQ = useQuery({
    queryKey: ['casting-batch', batchId],
    queryFn: () => Api.casting.batch(batchId!),
    enabled: open && batchId != null,
  });
  const metaQ = useQuery({ queryKey: ['item-meta'], queryFn: () => Api.items.meta(), enabled: open });
  // Material variants — powers each row's optional "+ material" issuance
  // section. Loaded once when the dialog opens so the picker is snappy.
  const variantsQ = useQuery({
    queryKey: ['variants-active'],
    queryFn: () => Api.materials.variants(),
    enabled: open,
    staleTime: 60_000,
  });
  const variants: any[] = (variantsQ.data ?? []) as any[];

  // Stages with pieces ready to forward — the dialog's row source.
  const idleStages: any[] = React.useMemo(() => {
    const items = (batchQ.data?.items ?? []) as any[];
    return items.filter((s) => (s.availableToForward ?? 0) > 0);
  }, [batchQ.data]);

  // Master data for each unique item — parallel queries; result kept in a
  // Map keyed by stageId for cheap lookup in the row renderer / defaults.
  const uniqueItemIds = React.useMemo(() => {
    const ids = new Set<number>();
    for (const s of idleStages) if (s.itemId) ids.add(s.itemId);
    return Array.from(ids);
  }, [idleStages]);

  const itemQs = useQueries({
    queries: uniqueItemIds.map((id) => ({
      queryKey: ['item', id],
      queryFn: () => Api.items.get(id),
      enabled: open,
      staleTime: 60_000,
    })),
  });

  const itemById = React.useMemo(() => {
    const m = new Map<number, any>();
    itemQs.forEach((q, i) => {
      if (q.data) m.set(uniqueItemIds[i], q.data);
    });
    return m;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uniqueItemIds, itemQs.map((q) => q.dataUpdatedAt).join(',')]);

  // stageId → item payload (for computeRowDefaults).
  const itemByStage = React.useMemo(() => {
    const m = new Map<number, any>();
    for (const s of idleStages) {
      if (s.itemId && itemById.has(s.itemId)) m.set(s.id, itemById.get(s.itemId));
    }
    return m;
  }, [idleStages, itemById]);

  // Init guard — useQueries returns a new array reference on every render,
  // so we can't just depend on it. Build a deterministic key from stage ids
  // and the items-loaded mask; only re-init when one of those changes.
  const initKeyRef = React.useRef<string>('');
  React.useEffect(() => {
    if (!open) return;
    if (!idleStages.length) return;
    const itemsLoadedMask = uniqueItemIds.map((id) => (itemById.has(id) ? '1' : '0')).join('');
    const key = `${idleStages.map((s) => s.id).join(',')}|${itemsLoadedMask}`;
    if (key === initKeyRef.current) return;
    initKeyRef.current = key;
    setRows((prev) => {
      const next: Record<number, RowInput> = {};
      for (const st of idleStages) {
        // Preserve operator's typed values if a row already exists, else
        // build fresh defaults. Fresh-default builder is used after a
        // submit-with-failures cycle when we reset the key.
        next[st.id] = prev[st.id] ?? computeRowDefaults(st, '', undefined, itemByStage);
      }
      return next;
    });
  }, [open, idleStages, uniqueItemIds, itemById, itemByStage]);

  if (!open) return null;
  const batch = batchQ.data;

  // Bulk-forward target options (used by the "Set all rows to…" picker):
  // everything active EXCEPT CAM (the entry process — you never forward
  // INTO CAM), CAD (designer vendor-category, not a production step) and
  // supplier roles. Per-row dropdowns additionally filter out the row's
  // OWN process + everything already done on the line (`processesForRow`).
  const allProcesses: any[] = (metaQ.data?.processes ?? []).filter(
    (p: any) =>
      !p.batchOnly &&
      p.code !== 'CAM' &&
      p.code !== 'CAD' &&
      p.code !== 'RAW_MATERIAL_SUPPLIER',
  );
  const processesForRow = (st: any) => {
    const done = new Set<string>(st?.lineCodes ?? []);
    // The row's current process itself is a "done" step — you can't
    // forward Casting → Casting.
    if (st?.processCode) done.add(st.processCode);
    return allProcesses.filter((p) => !done.has(p.code));
  };

  const changeRow = (stageId: number, patch: Partial<RowInput>) => {
    setRows((r) => ({ ...r, [stageId]: { ...r[stageId], ...patch } }));
  };

  const changeRowProcess = (st: any, newProcId: number | '') => {
    if (!newProcId) {
      changeRow(st.id, { targetProcessId: '' });
      return;
    }
    const fresh = computeRowDefaults(st, newProcId, undefined, itemByStage);
    const cur = rows[st.id];
    // Preserve operator's typed quantity / weight / vendorRef but recompute
    // colour + vendor + rate against the new process.
    setRows((r) => ({
      ...r,
      [st.id]: {
        ...fresh,
        quantity: cur?.quantity ?? fresh.quantity,
        weight: cur?.weight ?? fresh.weight,
        vendorRef: cur?.vendorRef || fresh.vendorRef,
        purpose: cur?.purpose || fresh.purpose,
      },
    }));
    // NOTE: filing-kit auto-load was removed per operator feedback —
    // materials were showing up on processes that don't consume them
    // (Casting, Die Number, etc.) because eligible variants were tagged
    // to too many processes. Materials are now strictly opt-in via
    // "+ Materials" per row; the operator decides.
  };

  const changeRowColour = (st: any, newColour: string) => {
    const cur = rows[st.id];
    if (!cur || !cur.targetProcessId) {
      changeRow(st.id, { color: newColour });
      return;
    }
    const fresh = computeRowDefaults(st, cur.targetProcessId, newColour, itemByStage);
    // Keep quantity / weight / include — recompute vendor + rate + ref.
    setRows((r) => ({
      ...r,
      [st.id]: {
        ...fresh,
        quantity: cur.quantity,
        weight: cur.weight,
        include: cur.include,
      },
    }));
  };

  const applyBulkProcess = (procId: number | '') => {
    setBulkProcessId(procId);
    if (!procId) return;
    setRows(() => {
      const next: Record<number, RowInput> = {};
      for (const st of idleStages) {
        next[st.id] = computeRowDefaults(st, procId, undefined, itemByStage);
      }
      return next;
    });
    // NOTE: bulk filing-kit auto-load also removed. See changeRowProcess.
  };

  const includedRows = idleStages
    .map((st) => ({ st, row: rows[st.id] }))
    .filter(({ row }) => row?.include);

  // All targets supported — the per-row expandables handle Sticking BOM
  // capture, ad-hoc materials, and brings-own toggling inline. Backend
  // still auto-applies the design's master BOM × qty when no inline BOM
  // is sent. Kept "Open individually" per row for edge cases (colour
  // splits, BOM buffer %) that the single-forward dialog exposes.
  const onSubmit = async () => {
    if (!includedRows.length) {
      toast.error('Tick at least one row to send.');
      return;
    }
    setSubmitting(true);
    let okCount = 0;
    const failures: { st: any; err: any }[] = [];
    for (const { st, row } of includedRows) {
      if (!row.targetProcessId || !row.vendorId || !row.quantity) {
        failures.push({ st, err: new Error('Missing process / vendor / qty.') });
        continue;
      }
      // Rate is required on every forward — vendor's per-piece / per-gram
      // billing cannot be inferred later without a manual edit.
      const rateN = row.costPerKg ? Number(row.costPerKg) : 0;
      if (!rateN || rateN <= 0) {
        failures.push({ st, err: new Error('Rate is required.') });
        continue;
      }
      try {
        const mats = (matRows[st.id] ?? [])
          .filter((r) => r.variantId !== '' && (Number(r.qty) > 0 || Number(r.weight) > 0))
          .map((r) => ({
            variantId: Number(r.variantId),
            issuedQty: r.qty ? Math.max(0, Math.trunc(Number(r.qty))) : undefined,
            issuedWeight: r.weight ? Number(r.weight) : undefined,
            notes: r.notes || undefined,
          }));
        // BOM auto-capture — persist inline BOM to Item Master AND include
        // in the forward call. Fires for every BOM-capable target (Sticking,
        // Kacha Fitting, Fitting+Mala) — same shape, same server code path.
        // Skipped when the karigar is bringing their own materials.
        const bomProc = allProcesses.find((p) => p.id === Number(row.targetProcessId));
        const isBomTarget = !!(bomProc as any)?.bomCapable;
        const bomCapture = isBomTarget && !bringsOwn[st.id]
          ? (bomRows[st.id] ?? [])
              .filter((r) => r.variantId !== '' && Number(r.perPiece) > 0)
              .map((r) => ({
                variantId: Number(r.variantId),
                perPiece: Math.max(1, Math.round(Number(r.perPiece))),
              }))
          : [];
        await Api.casting.forwardStage(st.id, {
          processId: Number(row.targetProcessId),
          quantity: Number(row.quantity),
          vendorId: Number(row.vendorId),
          vendorDesignReference: row.vendorRef || undefined,
          weight: row.weight ? Number(row.weight) : undefined,
          costPerKg: row.costPerKg ? Number(row.costPerKg) : undefined,
          color: row.color || st.color || undefined,
          purpose: row.purpose || st.purpose || undefined,
          forwardDate,
          extraMaterials: mats.length ? mats : undefined,
          bomCapture: bomCapture.length ? bomCapture : undefined,
          bringsOwnMaterials: isBomTarget ? !!bringsOwn[st.id] : undefined,
        } as any);
        okCount += 1;
      } catch (e) {
        failures.push({ st, err: e });
      }
    }
    setSubmitting(false);

    if (okCount > 0) toast.success(`Forwarded ${okCount} stage${okCount === 1 ? '' : 's'}.`);
    for (const f of failures) {
      const itemId = f.st.itemNumber ?? f.st.id;
      toast.error(`#${itemId}: ${getApiError(f.err).message}`);
    }

    if (failures.length === 0) {
      onDone?.();
      onClose();
    } else {
      // Force a refetch so completed rows drop out, then re-init so the
      // remaining rows get clean defaults again.
      await batchQ.refetch();
      initKeyRef.current = '';
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title={batch ? `Bulk Forward — Batch ${batch.batchNumber}` : 'Bulk Forward'}
      description="Pick a target process + vendor for each idle stage and send in one go. Per-row controls override the bulk picker."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            onClick={onSubmit}
            disabled={submitting || !includedRows.length}
          >
            {submitting && <Spinner className="text-primary-foreground" />}
            <Send className="size-4" />
            Send {includedRows.length || ''}
          </Button>
        </>
      }
    >
      {batchQ.isLoading || itemQs.some((q) => q.isLoading) ? (
        <div className="flex items-center justify-center py-12 gap-2 text-text-faint">
          <Spinner /> Loading batch…
        </div>
      ) : !idleStages.length ? (
        <div className="py-8 text-center text-sm text-text-faint">
          No idle stages ready to forward in this batch.
        </div>
      ) : (
        <div className="space-y-3">
          {/* Bulk controls */}
          <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-secondary/30 p-3">
            <div className="min-w-[240px] flex-1">
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                Set all rows to…
              </label>
              <Select value={bulkProcessId} onChange={(e) => applyBulkProcess(e.target.value ? Number(e.target.value) : '')}>
                <option value="">— pick a process —</option>
                {allProcesses.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                Forward date
              </label>
              <Input type="date" value={forwardDate} onChange={(e) => setForwardDate(e.target.value)} />
            </div>
            <div className="text-[11px] text-text-faint flex items-start gap-1">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>Bulk picker overwrites typed values intentionally — it's a reset, not an additive fill.</span>
            </div>
          </div>

          {/* Card list — one card per idle stage. No table, no horizontal
              scroll possible at any viewport width. Fields flow into a
              responsive grid; materials + Sticking BOM expand inline. */}
          <div className="space-y-2">
            {idleStages.map((st) => {
              const row = rows[st.id];
              if (!row) return null;
              const item = itemByStage.get(st.id);
              const itemProc = item?.processes?.find((p: any) => p.processId === Number(row.targetProcessId));
              const procColours: string[] = Array.from(
                new Set(
                  (itemProc?.vendors ?? [])
                    .map((v: any) => (v.color ?? '').trim())
                    .filter(Boolean),
                ),
              );
              const targetProc = allProcesses.find((p) => p.id === Number(row.targetProcessId));
              const procCode = targetProc?.code;
              const usesColour = procCode ? COLOUR_PROCESS_CODES.has(procCode) : false;
              // BOM-capable target — Sticking, Kacha Fitting, Fitting+Mala,
              // or anything else the process master flags. Same inline BOM
              // + brings-own toggle UI for all of them.
              const isBomTarget = !!(targetProc as any)?.bomCapable;
              const procVendors: any[] = itemProc?.vendors ?? [];
              const processLevelVendors: any[] = (targetProc?.vendors ?? []).map((v: any) => ({
                vendorId: v.id, vendorCode: v.vendorCode, vendorName: v.vendorName, costPerPiece: null,
              }));
              const allActiveVendors: any[] = (metaQ.data?.allVendors ?? []).map((v: any) => ({
                vendorId: v.id, vendorCode: v.vendorCode, vendorName: v.vendorName, costPerPiece: null,
              }));
              const vendorOptions: any[] = procVendors.length
                ? Array.from(new Map(procVendors.map((v) => [v.vendorId, v])).values())
                : (processLevelVendors.length ? processLevelVendors : allActiveVendors);
              return (
                <div
                  key={st.id}
                  className={cn(
                    'rounded-lg border p-3 transition-colors',
                    row.include ? 'border-gold/30 bg-gold/[0.03]' : 'border-border bg-card',
                  )}
                >
                  {/* Card header — checkbox + item + from→to + avail */}
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={row.include}
                      onChange={(e) => changeRow(st.id, { include: e.target.checked })}
                      className="accent-gold mt-1 size-4 shrink-0 cursor-pointer"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{st.itemNumber ?? '—'}</div>
                      <div className="text-xs text-text-faint">
                        {st.processName ?? '?'}
                        <span className="mx-1 text-gold">→</span>
                        {targetProc?.name ?? <span className="italic text-text-faint">pick a target</span>}
                        {st.itemName ? <> · {st.itemName}</> : null}
                      </div>
                    </div>
                    <Badge variant="info" className="shrink-0 text-[10px]">
                      avail {st.availableToForward}
                    </Badge>
                  </div>

                  {/* Form grid — 1/2/3/4 cols across breakpoints. */}
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-wider text-text-faint">Next Process</label>
                      <Select
                        value={row.targetProcessId}
                        onChange={(e) => changeRowProcess(st, e.target.value ? Number(e.target.value) : '')}
                        className="h-8 w-full"
                      >
                        <option value="">— pick —</option>
                        {processesForRow(st).map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </Select>
                    </div>
                    {usesColour && (
                      <div>
                        <label className="text-[10px] font-bold uppercase tracking-wider text-text-faint">Colour</label>
                        {row.customMode ? (
                          <div className="flex items-center gap-1">
                            <Input
                              placeholder="Custom colour"
                              className="h-8 flex-1"
                              value={row.color}
                              onChange={(e) => changeRow(st.id, { color: e.target.value })}
                              autoFocus
                            />
                            <button
                              type="button"
                              onClick={() => changeRow(st.id, { customMode: false, color: '' })}
                              className="text-[10px] text-info hover:underline"
                            >
                              ↺
                            </button>
                          </div>
                        ) : (
                          <Select
                            value={row.color}
                            onChange={(e) => {
                              if (e.target.value === '__custom__') changeRow(st.id, { customMode: true, color: '' });
                              else changeRowColour(st, e.target.value);
                            }}
                            className="h-8 w-full"
                          >
                            <option value="">— pick —</option>
                            {procColours.map((c) => <option key={c} value={c}>{c}</option>)}
                            <option value="__custom__">+ custom…</option>
                          </Select>
                        )}
                      </div>
                    )}
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-wider text-text-faint">Qty</label>
                      <Input
                        type="number"
                        className="h-8 w-full"
                        value={row.quantity}
                        onChange={(e) => changeRow(st.id, { quantity: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-wider text-text-faint">Vendor</label>
                      <Select
                        value={row.vendorId}
                        onChange={(e) => changeRow(st.id, { vendorId: e.target.value ? Number(e.target.value) : '' })}
                        className="h-8 w-full"
                      >
                        <option value="">— pick —</option>
                        {vendorOptions.map((v: any) => (
                          <option key={v.vendorId} value={v.vendorId}>
                            {v.vendorCode ?? ''} · {v.vendorName ?? ''}{v.isPreferred ? ' ★' : ''}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-wider text-text-faint">Vendor Ref</label>
                      <Input
                        className="h-8 w-full"
                        value={row.vendorRef}
                        onChange={(e) => changeRow(st.id, { vendorRef: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-wider text-text-faint">Wt/pc (g)</label>
                      <Input
                        type="number" step="0.001"
                        className="h-8 w-full"
                        value={row.weight}
                        onChange={(e) => changeRow(st.id, { weight: e.target.value })}
                        title="Defaults to actual received per-pc on the source stage (recvWt ÷ recvQty)"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-wider text-text-faint">Rate</label>
                      <Input
                        type="number" step="0.01"
                        className="h-8 w-full"
                        value={row.costPerKg}
                        onChange={(e) => changeRow(st.id, { costPerKg: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold uppercase tracking-wider text-text-faint">Purpose</label>
                      <Input
                        className="h-8 w-full"
                        placeholder="Customer / Stock"
                        value={row.purpose}
                        onChange={(e) => changeRow(st.id, { purpose: e.target.value })}
                        title="Defaults to source stage's purpose; edit per row for different customer / order."
                      />
                    </div>
                  </div>

                  {/* Action strip — attach materials / open single dialog. */}
                  <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-2">
                    <button
                      type="button"
                      onClick={() => toggleMats(st.id)}
                      className="inline-flex items-center gap-1 text-xs text-gold hover:underline"
                      title="Attach materials to issue with this forward"
                    >
                      <Package className="size-3.5" />
                      {openMats[st.id] ? 'Hide materials' : `+ Materials${(matRows[st.id]?.length ?? 0) > 0 ? ` (${matRows[st.id]!.length})` : ''}`}
                    </button>
                    {isBomTarget && (
                      <button
                        type="button"
                        onClick={() => toggleBom(st.id)}
                        className="inline-flex items-center gap-1 text-xs text-info hover:underline"
                        title="Set up the Sticking BOM for this design"
                      >
                        <Package className="size-3.5" />
                        {openBom[st.id] ? 'Hide BOM' : `+ Sticking BOM${(bomRows[st.id]?.length ?? 0) > 0 ? ` (${bomRows[st.id]!.length})` : ''}`}
                      </button>
                    )}
                    {onForwardIndividually && (
                      <button
                        type="button"
                        onClick={() => { onForwardIndividually(st); onClose(); }}
                        className="ml-auto inline-flex items-center gap-1 text-xs text-text-faint hover:text-gold hover:underline"
                      >
                        <ExternalLink className="size-3" /> Open individually
                      </button>
                    )}
                  </div>

                  {/* Materials expandable — per-row material lines. */}
                  {openMats[st.id] && (
                    <div className="mt-2 rounded-md border border-gold/20 bg-gold/[0.04] p-2">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-gold">
                          Materials to issue with this forward
                        </div>
                        <Button type="button" variant="outline" size="sm" onClick={() => addMatLine(st.id)}>
                          <Plus className="size-3.5" /> Add material
                        </Button>
                      </div>
                      {(matRows[st.id] ?? []).length === 0 ? (
                        <p className="rounded-md border border-dashed border-border bg-card/40 px-3 py-2 text-center text-xs text-text-faint">
                          No materials attached.
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {(matRows[st.id] ?? []).map((mr, idx) => {
                            const v = variants.find((x: any) => x.id === Number(mr.variantId));
                            const trackByQty = v?.trackByQty ?? true;
                            const trackByWeight = v?.trackByWeight ?? false;
                            return (
                              <div key={mr._k} className="grid grid-cols-1 items-end gap-2 rounded-md border border-border bg-card p-2 sm:grid-cols-12">
                                <div className="sm:col-span-5">
                                  <label className="text-[10px] font-bold uppercase text-text-faint">Material</label>
                                  <SearchableSelect
                                    value={mr.variantId === '' ? '' : String(mr.variantId)}
                                    placeholder={variants.length === 0 ? '— no variants —' : '— pick —'}
                                    onChange={(val) => patchMatLine(st.id, idx, { variantId: val === '' ? '' : Number(val) })}
                                    options={variants.map((vv: any) => ({
                                      value: vv.id,
                                      label: vv.variantName,
                                      subtitle: `${vv.materialName}${vv.size ? ` · ${vv.size}` : ''}${vv.color ? ` · ${vv.color}` : ''}`,
                                      meta: [
                                        (vv.trackByQty ?? true) ? `${Number(vv.stockQty).toFixed(0)} pcs` : null,
                                        (vv.trackByWeight ?? false) ? `${Number(vv.stockWeight).toFixed(3)} g` : null,
                                      ].filter(Boolean).join(' · '),
                                      keywords: `${vv.variantCode} ${vv.materialName}`,
                                    }))}
                                  />
                                </div>
                                {(trackByQty || !v) && (
                                  <div className="sm:col-span-2">
                                    <label className="text-[10px] font-bold uppercase text-text-faint">Qty</label>
                                    <Input type="number" min="0" step="1" placeholder="0"
                                      value={mr.qty}
                                      onChange={(e) => patchMatLine(st.id, idx, { qty: e.target.value })}
                                    />
                                  </div>
                                )}
                                {trackByWeight && (
                                  <div className="sm:col-span-2">
                                    <label className="text-[10px] font-bold uppercase text-text-faint">Wt (g)</label>
                                    <Input type="number" min="0" step="0.001" placeholder="0.000"
                                      value={mr.weight}
                                      onChange={(e) => patchMatLine(st.id, idx, { weight: e.target.value })}
                                    />
                                  </div>
                                )}
                                <div className="sm:col-span-2">
                                  <label className="text-[10px] font-bold uppercase text-text-faint">Notes</label>
                                  <Input placeholder="optional"
                                    value={mr.notes}
                                    onChange={(e) => patchMatLine(st.id, idx, { notes: e.target.value })}
                                  />
                                </div>
                                <div className="flex justify-end sm:col-span-1">
                                  <Button type="button" variant="outline" size="icon" onClick={() => removeMatLine(st.id, idx)} title="Remove">
                                    <Trash2 className="size-3.5" />
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Sticking BOM expandable — only when target is Sticking. */}
                  {isBomTarget && openBom[st.id] && (
                    <div className="mt-2 rounded-md border border-info/20 bg-info/[0.05] p-2">
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-info">
                          Sticking BOM · per-piece requirements
                        </div>
                        <Button type="button" variant="outline" size="sm" onClick={() => addBomLine(st.id)}>
                          <Plus className="size-3.5" /> Add BOM row
                        </Button>
                      </div>
                      <label className="mb-2 flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          className="size-3.5 accent-info"
                          checked={!!bringsOwn[st.id]}
                          onChange={(e) => setBringsOwn((b) => ({ ...b, [st.id]: e.target.checked }))}
                        />
                        <span>Karigar brings own raw materials (no material-issue voucher)</span>
                      </label>
                      {!bringsOwn[st.id] && ((bomRows[st.id] ?? []).length === 0 ? (
                        <p className="rounded-md border border-dashed border-border bg-card/40 px-3 py-2 text-center text-xs text-text-faint">
                          Add rows below — they'll be saved to the Item Master AND issued with this forward.
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {(bomRows[st.id] ?? []).map((br, idx) => (
                            <div key={br._k} className="grid grid-cols-1 items-end gap-2 rounded-md border border-border bg-card p-2 sm:grid-cols-12">
                              <div className="sm:col-span-8">
                                <label className="text-[10px] font-bold uppercase text-text-faint">Material Variant</label>
                                <SearchableSelect
                                  value={br.variantId === '' ? '' : String(br.variantId)}
                                  placeholder={variants.length === 0 ? '— no variants —' : '— pick —'}
                                  onChange={(val) => patchBomLine(st.id, idx, { variantId: val === '' ? '' : Number(val) })}
                                  options={variants.map((vv: any) => ({
                                    value: vv.id,
                                    label: vv.variantName,
                                    subtitle: `${vv.materialName}${vv.size ? ` · ${vv.size}` : ''}${vv.color ? ` · ${vv.color}` : ''}`,
                                    keywords: `${vv.variantCode} ${vv.materialName}`,
                                  }))}
                                />
                              </div>
                              <div className="sm:col-span-3">
                                <label className="text-[10px] font-bold uppercase text-text-faint">Qty / piece</label>
                                <Input type="number" min="1" step="1" placeholder="1"
                                  value={br.perPiece}
                                  onChange={(e) => patchBomLine(st.id, idx, { perPiece: e.target.value })}
                                />
                              </div>
                              <div className="flex justify-end sm:col-span-1">
                                <Button type="button" variant="outline" size="icon" onClick={() => removeBomLine(st.id, idx)} title="Remove">
                                  <Trash2 className="size-3.5" />
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <p className="flex items-center gap-1 text-[11px] text-text-faint">
            <Badge variant="info" className="text-[9px]">{includedRows.length}</Badge>
            row{includedRows.length === 1 ? '' : 's'} ticked to send.
          </p>
        </div>
      )}
    </Dialog>
  );
}
