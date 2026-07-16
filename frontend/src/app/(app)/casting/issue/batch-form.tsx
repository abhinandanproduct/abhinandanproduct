'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, AlertTriangle, PackageSearch } from 'lucide-react';
import { Api, getApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Field, SectionTitle } from '@/components/shared/field';
import { Spinner } from '@/components/ui/spinner';
import { formatCurrency } from '@/lib/utils';
import type { ItemMeta, Item } from '@/lib/types';

// A production batch's first stage is chosen per-row. CAM is the default
// (most designs start there), but the operator can override to Casting or
// any other production process. Colours are chosen later, per process
// step (Plating / Meena / …), not here.
interface Row {
  itemId?: number;
  // Initial process for this row. Defaults to CAM at seed time; the
  // operator can pick any production process from the picker on the row.
  entryProcessId?: number | '';
  quantity: string;
  vendorId?: number | '';
  weight?: string;
  costPerKg?: string;
  totalWeight?: string;
  remarks: string;
  // Customer / order purpose — free-form label (customer name, PO #,
  // "Stock", "Sample", etc). Captured here so the slip's Order Details
  // box can show who this line is for. Carried forward to every
  // downstream stage by the backend automatically.
  purpose?: string;
  // Vendor's reference for this design (their own item code on the slip
  // / box). When empty in Item Master for the chosen vendor, the input
  // is still rendered so the operator can capture it on the spot —
  // backend's ensureProcessVendor saves it back to the master row.
  vendorDesignReference?: string;
  // When ticked, the operator is recording a TEMPORARY casting weight
  // (no accurate per-pc weight on hand yet — common for fresh designs
  // entering production). Backend will save the weight as usual but ALSO
  // append "casting weight temporary" to the Casting ItemProcess.notes
  // (per-process, not the item-level notes). The Casting receipt then
  // prompts for the FINAL per-pc weight on receive; finalizeCastingWeight
  // overwrites the master weight and strips the marker.
  castingWeightTemporary?: boolean;
  // Pending settle ops carried over from the "existing stock" dialog; applied
  // AFTER batch creation so the absorbed pieces live in the NEW batch.
  pendingSettles?: PendingSettle[];
  // Pending planned-forwards for AT-VENDOR stages — registered with the
  // backend after batch creation so receipts later auto-route into the new batch.
  pendingPlans?: PendingPlan[];
}
const emptyRow = (): Row => ({ quantity: '', remarks: '', purpose: '' });

// Settle operation captured from the dialog and applied AFTER the new batch is
// created — so the resulting child stage lives in the NEW batch (not the old,
// often-short-closed one) and shows up alongside the freshly cast pieces.
type PendingSettle = {
  stageIds: number[];
  nextProcessId: number;
  color?: string;
  vendorId?: number;
  maxQty: number;
  // For the UI summary on the row strip.
  fromProcessName: string;
  toProcessName: string;
};

// Planned forward registered on AT-VENDOR stages — applied automatically by the
// backend when the stage is later received via Receive Goods. Lets the new-batch
// dialog steer at-vendor pieces into the new batch the moment they come back.
// If `receiveNow=true`, the dialog also fires a receipt at batch-create time
// so the pieces land in the new batch immediately, not later.
type PendingPlan = {
  stageId: number;
  nextProcessId: number;
  vendorId?: number;
  color?: string;
  // For the UI summary on the row strip.
  fromProcessName: string;
  toProcessName: string;
  qty: number;
  // Receive-now: record the receipt at batch-create time.
  receiveNow: boolean;
  receiveQty: number;
  sourceBatchId: number;
  sourceVendorId: number;
  perPieceWeight: number;
};

/**
 * Dialog shown when the user selects a design that already has produced/in-process
 * stock. Three strategies the user can pick:
 *   1. Use existing only — zeroes this row's cast qty.
 *   2. Use existing + cast more — settles the lots they tick, the row keeps its
 *      target qty (so casting is created for the rest).
 *   3. Use part of existing — settles only N of the available in-house pieces;
 *      the rest stay in stock and the row's cast qty is recalculated.
 *
 * For every IN-HOUSE lot the user can configure WHERE those pieces go (next
 * process, vendor, colour). Lots already with vendors / packed aren't touched.
 */
type Strategy = 'only' | 'add' | 'partial';
function SettleExistingStockDialog({
  open, onClose, design, lots, summary, initialTargetQty, meta, onApplied,
}: {
  open: boolean;
  onClose: () => void;
  design: { itemId: number; itemNumber?: string | null; designCode: string; itemName?: string | null };
  // All "rows" from produced (FINISHED + IN_HOUSE + AT_VENDOR) for this design.
  lots: any[];
  summary: { finished: number; inHouse: number; atVendor: number };
  initialTargetQty: number; // pre-fill from the row, but editable inside the dialog
  meta: ItemMeta;
  // newCastQty < targetQty after settling; the parent updates the row + holds
  // the pending settles + plans to fire AFTER the new batch is created. Settles
  // are immediate forwards; plans are pre-registered on at-vendor stages so the
  // backend auto-forwards them when they're received.
  onApplied: (newCastQty: number, settles: PendingSettle[], plans: PendingPlan[]) => void;
}) {
  const inHouseLots = React.useMemo(() => lots.filter((l) => l.state === 'IN_HOUSE'), [lots]);
  const atVendorLots = React.useMemo(() => lots.filter((l) => l.state === 'AT_VENDOR'), [lots]);
  const finishedQty = summary.finished;
  const atVendorQty = summary.atVendor;
  // The user types the ORDER TARGET inside the dialog — this is the source of
  // truth for all "should we cast more?" math. Pre-filled from the row if any.
  const [targetInput, setTargetInput] = React.useState('');
  // Per-lot settle config. For colour-using next processes (Plating, Meena,
  // Fitting, Mala, Sticking) the user can split the settle qty across
  // multiple colours — same UX as ForwardDialog. `colorSplits` is a map of
  // colour-name → qty string, `colorVendors` is a colour-name → vendor
  // override (blank = auto by colour from item config).
  type Cfg = {
    enabled: boolean;
    qty: string;
    processId: number | '';
    vendorId: number | '';
    color: string; // legacy single-colour fallback (non-colour steps)
    colorSplits: Record<string, string>;
    colorVendors: Record<string, number>;
  };
  const [cfg, setCfg] = React.useState<Record<number, Cfg>>({});
  // Per AT-VENDOR-lot planned-forward config — applied to the backend as a
  // "planned forward" on the source stage, so when received it auto-routes.
  // `receiveNow=true` ALSO creates a receipt against the source batch at create
  // time, marking those pieces as physically returned now (the plan-based
  // auto-forward fires automatically in createReceipt and lands them in the
  // new batch — everything in one batch, exactly as the user wanted).
  type AvCfg = {
    enabled: boolean;
    processId: number | '';
    vendorId: number | '';
    color: string;
    receiveNow: boolean;
    receiveQty: string;
  };
  const [avCfg, setAvCfg] = React.useState<Record<number, AvCfg>>({});
  const [strategy, setStrategy] = React.useState<Strategy>('add');

  // Initialise per-lot config + target input when the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    const next: Record<number, Cfg> = {};
    inHouseLots.forEach((lot, i) => {
      const firstColor = lot.nextUsesColor && lot.nextColorOptions?.length ? lot.nextColorOptions[0] : '';
      next[i] = {
        enabled: true,
        qty: String(lot.qty),
        processId: lot.nextProcessId ?? '',
        vendorId: '', // auto by colour on the server when blank
        color: firstColor,
        // Pre-tick the first colour with the full lot qty so the user has
        // a working default — they can untick / add others as needed.
        colorSplits: firstColor ? { [firstColor]: String(lot.qty) } : {},
        colorVendors: {},
      };
    });
    setCfg(next);
    const nextAv: Record<number, AvCfg> = {};
    atVendorLots.forEach((lot, i) => {
      nextAv[i] = {
        enabled: true,
        processId: lot.nextProcessId ?? '',
        vendorId: '',
        color: lot.nextUsesColor && lot.nextColorOptions?.length ? lot.nextColorOptions[0] : '',
        receiveNow: false,
        receiveQty: String(lot.qty),
      };
    });
    setAvCfg(nextAv);
    setStrategy('add');
    setTargetInput(initialTargetQty > 0 ? String(initialTargetQty) : '');
  }, [open, inHouseLots.length, atVendorLots.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Available processes for the "send to" choice. CAM is filtered out
  // (entry only), CAD is filtered out (designer vendor-category, not a
  // production step), and RAW_MATERIAL_SUPPLIER is filtered out (supplier
  // role). Every other process (Casting, Filing, …) is a valid downstream.
  const processes = (meta.processes ?? []).filter(
    (p) => p.code !== 'CAM' && p.code !== 'CAD' && p.code !== 'RAW_MATERIAL_SUPPLIER',
  );

  // Live colour sync — when the user opens Item Master (via the "Add colour"
  // link below a colour dropdown) and saves a new colour, the Item Master
  // save mutation broadcasts `{ type: 'item-saved', itemId }`. We listen
  // and invalidate this design's `produced` cache so `nextColorOptions`
  // refreshes inside the dialog rows without any reload or tab switch.
  const qcSync = useQueryClient();
  React.useEffect(() => {
    if (!open || !design?.itemId) return;
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel('item-updates');
    ch.onmessage = (ev) => {
      if (ev.data?.type === 'item-saved' && ev.data?.itemId === design.itemId) {
        qcSync.invalidateQueries({ queryKey: ['produced', design.itemId] });
        qcSync.invalidateQueries({ queryKey: ['produced'] });
        qcSync.invalidateQueries({ queryKey: ['item', design.itemId] });
        qcSync.invalidateQueries({ queryKey: ['item-meta'] });
      }
    };
    return () => ch.close();
  }, [open, design?.itemId, qcSync]);

  const targetQty = Math.max(0, Math.trunc(Number(targetInput || 0)));
  // Sum across enabled lots. For colour-using next processes we sum the
  // colour-split values (since one lot may fan out across multiple colours);
  // for non-colour processes we sum the row's single qty field.
  const sumLotQty = (lot: any, c: Cfg | undefined): number => {
    if (!c?.enabled) return 0;
    if (lot.nextUsesColor) {
      return Object.values(c.colorSplits ?? {}).reduce((s, q) => s + Math.max(0, Math.trunc(Number(q || 0))), 0);
    }
    return Math.max(0, Math.trunc(Number(c.qty || 0)));
  };
  const totalSettling = inHouseLots.reduce((sum, lot, i) => sum + sumLotQty(lot, cfg[i]), 0);
  // Combined "we already have" — packed (ready now) + in-house being settled +
  // pieces already at a vendor doing some step. The at-vendor pieces are ALREADY
  // cast and progressing; they'll come back via Receive Goods and continue from
  // wherever they are. So they DO count toward fulfilling the new order and we
  // should NOT re-cast them. (Pessimists can flip to "Cast new only".)
  const alreadyHave = finishedQty + totalSettling + atVendorQty;
  // Strategy-specific recommended cast qty.
  const recommendedCastQty =
    strategy === 'only' ? 0
    : strategy === 'add' ? targetQty
    : Math.max(0, targetQty - alreadyHave);
  const canApply = targetQty > 0 || strategy === 'only';

  // "Cast new only" leaves existing pieces alone — no settles fire. The other
  // two strategies BOTH settle the enabled lots; they only differ in how many
  // new pieces to cast on top.
  const settlesEnabled = strategy !== 'add';

  // Apply is synchronous now: just bundle up the settle + plan configs and hand
  // them to the parent. The actual API calls fire AFTER the batch is created so
  // settled pieces land in the new batch (with `targetBatchId`), and at-vendor
  // plans get registered so receipts auto-route into the new batch.
  const apply = {
    isPending: false,
    mutate: () => {
      try {
        const settles: PendingSettle[] = [];
        const plans: PendingPlan[] = [];
        if (settlesEnabled) {
          for (let i = 0; i < inHouseLots.length; i++) {
            const lot = inHouseLots[i];
            const c = cfg[i];
            if (!c?.enabled) continue;
            if (!c.processId) {
              toast.error(`Choose a next process for the ${lot.processName} lot.`);
              return;
            }
            const target = processes.find((p) => p.id === Number(c.processId));
            const usesColor = !!target && lot.nextUsesColor;
            const stageIds = lot.stages.map((s: any) => s.id);
            if (usesColor) {
              // Colour-using next process — fan out ONE settle per ticked
              // colour, each with its own qty + vendor (matches the Forward
              // Dialog UX where each colour becomes its own slip).
              const entries = Object.entries(c.colorSplits ?? {})
                .map(([color, qStr]) => ({ color, qty: Math.max(0, Math.trunc(Number(qStr || 0))), vendorId: c.colorVendors?.[color] }))
                .filter((e) => e.qty > 0);
              if (entries.length === 0) continue;
              const split = entries.reduce((s, e) => s + e.qty, 0);
              if (split > lot.qty) {
                // Over-cap: short by (split - lot.qty). Tell the user how to fix:
                // reduce a colour qty OR cast new pieces to cover the gap.
                toast.error(
                  `Colour split (${split}) exceeds the ${lot.qty} pcs available in the ${lot.processName} lot — short by ${split - lot.qty}. ` +
                  `Reduce a colour qty, or switch to "Use existing + cast shortfall" to auto-cast the extra ${split - lot.qty} pcs.`,
                );
                return;
              }
              for (const e of entries) {
                settles.push({
                  stageIds,
                  nextProcessId: Number(c.processId),
                  color: e.color,
                  vendorId: e.vendorId ? Number(e.vendorId) : undefined,
                  maxQty: e.qty,
                  fromProcessName: lot.processName,
                  toProcessName: target?.name ?? '—',
                });
              }
            } else {
              // Non-colour next process — single settle from the row's qty.
              const askQty = Math.max(0, Math.trunc(Number(c.qty || 0)));
              if (askQty <= 0) continue;
              settles.push({
                stageIds,
                nextProcessId: Number(c.processId),
                color: undefined,
                vendorId: c.vendorId ? Number(c.vendorId) : undefined,
                maxQty: askQty,
                fromProcessName: lot.processName,
                toProcessName: target?.name ?? '—',
              });
            }
          }
          // At-vendor plans — one per stage in each enabled at-vendor lot.
          // Receive-now qty is split across the lot's stages proportionally so
          // multi-stage lots distribute correctly (most lots = 1 stage anyway).
          for (let i = 0; i < atVendorLots.length; i++) {
            const lot = atVendorLots[i];
            const a = avCfg[i];
            if (!a?.enabled) continue;
            if (!a.processId) {
              toast.error(`Choose a next process for the at-vendor ${lot.processName} lot.`);
              return;
            }
            const target = processes.find((p) => p.id === Number(a.processId));
            const usesColor = !!target && lot.nextUsesColor;
            const stages = (lot.stages ?? []) as { id: number; idle: number; batchId: number; perPieceWeight: number }[];
            const totalIdle = stages.reduce((s, x) => s + x.idle, 0);
            const wantReceive = a.receiveNow ? Math.min(Math.max(0, Math.trunc(Number(a.receiveQty || 0))), totalIdle) : 0;
            let remaining = wantReceive;
            stages.forEach((s, idx) => {
              const isLast = idx === stages.length - 1;
              const myReceive = a.receiveNow
                ? (isLast ? remaining : Math.floor(wantReceive * (s.idle / totalIdle)))
                : 0;
              remaining -= myReceive;
              plans.push({
                stageId: s.id,
                nextProcessId: Number(a.processId),
                vendorId: a.vendorId ? Number(a.vendorId) : undefined,
                color: usesColor && a.color ? a.color : undefined,
                fromProcessName: lot.processName,
                toProcessName: target?.name ?? '—',
                qty: s.idle,
                receiveNow: a.receiveNow,
                receiveQty: Math.max(0, myReceive),
                sourceBatchId: s.batchId,
                sourceVendorId: lot.vendorId,
                perPieceWeight: s.perPieceWeight,
              });
            });
          }
        }
        onApplied(recommendedCastQty, settles, plans);
        const settleQty = settles.reduce((s, x) => s + x.maxQty, 0);
        const planQty = plans.reduce((s, x) => s + x.qty, 0);
        toast.success(
          settleQty + planQty > 0
            ? `Plan saved — ${settleQty} pcs absorbed now, ${planQty} pcs auto-route into the new batch when received.`
            : 'Cast qty updated.',
        );
        onClose();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to plan settles.');
      }
    },
  };

  const designLabel = `${design.itemNumber ? `#${design.itemNumber} · ` : ''}${design.designCode}${design.itemName ? ` — ${design.itemName}` : ''}`;

  return (
    <Dialog open={open} onClose={onClose} size="xl"
      title="Existing stock found"
      description={designLabel}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={apply.isPending}>Cancel</Button>
          <Button onClick={() => apply.mutate()} disabled={apply.isPending || !canApply}>
            {apply.isPending && <Spinner />} Apply &amp; set cast qty to {recommendedCastQty}
          </Button>
        </>
      }>
      <div className="space-y-4">
        {/* Plain-English alert at the top so the user understands WHY this dialog popped up. */}
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <strong>Heads up —</strong> this design already exists in your system:
          {summary.finished > 0 && <> <strong>{summary.finished}</strong> packed &amp; ready,</>}
          {summary.inHouse > 0 && <> <strong>{summary.inHouse}</strong> half-done in stock,</>}
          {summary.atVendor > 0 && <> <strong>{summary.atVendor}</strong> already at a vendor (no re-casting needed).</>}
          {' '}Tell us your new order target and how you'd like to fulfil it.
        </div>

        {/* Summary chips */}
        <div className="flex flex-wrap gap-2 text-sm">
          <span className="inline-flex items-center gap-1 rounded-full border border-success/40 bg-success/10 px-3 py-1 text-success">
            ✓ {summary.finished} packed &amp; ready
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-warning">
            🏭 {summary.inHouse} half-done in stock
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-sky-300 bg-info/10 px-3 py-1 text-info">
            🚚 {summary.atVendor} at vendor
          </span>
        </div>

        {/* The order target — collected here so all strategy math is meaningful. */}
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm font-semibold text-foreground">New order target</label>
            <Input
              type="number" min="0" step="1" className="h-9 w-32 text-right text-base font-semibold"
              placeholder="how many pcs?"
              value={targetInput}
              onChange={(e) => setTargetInput(e.target.value.replace(/[^0-9]/g, ''))}
              autoFocus
            />
            <span className="text-sm text-muted-foreground">pieces needed for this order</span>
          </div>
          {targetQty === 0 && (
            <p className="mt-1.5 text-xs text-warning">Enter the order qty so we can suggest how many to cast new.</p>
          )}
        </div>

        {/* Strategy radios — disabled when target is 0 (except "use only" which is always valid). */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <StrategyCard checked={strategy === 'only'} onClick={() => setStrategy('only')}
            title="Use existing only"
            body={`Cast nothing new — fulfil from the ${alreadyHave} pcs already in your system (packed + half-done + at vendor).`} />
          <StrategyCard checked={strategy === 'add'} onClick={() => targetQty > 0 && setStrategy('add')}
            disabled={targetQty === 0}
            title="Cast new only"
            body={targetQty > 0
              ? `Ignore existing stock — cast ${targetQty} fresh pieces. Existing pieces continue on their own track.`
              : 'Enter an order qty first.'} />
          <StrategyCard checked={strategy === 'partial'} onClick={() => targetQty > 0 && setStrategy('partial')}
            disabled={targetQty === 0}
            title="Use existing + cast shortfall"
            body={targetQty > 0
              ? `Cast only ${Math.max(0, targetQty - alreadyHave)} more — the ${alreadyHave} existing pcs cover the rest.`
              : 'Enter an order qty first.'} />
        </div>

        {/* In-house lots — per-lot settle config. Dimmed when strategy = "add". */}
        {inHouseLots.length === 0 ? (
          <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            No in-process lots to continue. (Packed &amp; at-vendor pieces are tracked separately.)
          </p>
        ) : (
          <div className={`overflow-hidden rounded-lg border border-border ${settlesEnabled ? '' : 'opacity-50'}`}>
            <div className="border-b border-border bg-muted/50 px-3 py-1.5 text-xs font-semibold text-muted-foreground">
              {settlesEnabled
                ? 'In-process lots — choose where each settled piece goes'
                : 'In-process lots — not used in "Cast new only" mode'}
            </div>
            <div className="table-scroll">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-muted/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5"></th>
                  <th className="px-2 py-1.5">Lot</th>
                  <th className="px-2 py-1.5 text-right">Settle qty</th>
                  <th className="px-2 py-1.5">Next process</th>
                  <th className="px-2 py-1.5">Vendor</th>
                  <th className="px-2 py-1.5">Colour</th>
                </tr>
              </thead>
              <tbody>
                {inHouseLots.map((lot, i) => {
                  // Typed fallback so every field is defined from first render
                  // (avoids React's uncontrolled→controlled input warning when
                  // the init effect later sets state with these same fields).
                  const c: Cfg = cfg[i] ?? {
                    enabled: true,
                    qty: String(lot.qty),
                    processId: lot.nextProcessId ?? '',
                    vendorId: '',
                    color: '',
                    colorSplits: {},
                    colorVendors: {},
                  };
                  const targetProc = processes.find((p) => p.id === Number(c.processId));
                  const procVendors = targetProc?.vendors ?? [];
                  const colourOpts: string[] = lot.nextColorOptions ?? [];
                  // Hide processes already done for THIS lot — meta `processes` is sorted
                  // by workflow order, so anything at-or-before the lot's current process
                  // index is already finished and shouldn't be a "next step" option.
                  // (CASTING is filtered out of `processes` entirely → idx -1 means show all.)
                  const lotProcIdx = processes.findIndex((p) => p.code === lot.processCode);
                  const nextProcessOpts = lotProcIdx >= 0 ? processes.slice(lotProcIdx + 1) : processes;
                  return (
                    <tr key={i} className="border-t border-border align-top">
                      <td className="px-2 py-1.5">
                        <input type="checkbox" className="mt-1 size-4 accent-primary"
                          disabled={!settlesEnabled}
                          checked={c.enabled && settlesEnabled}
                          onChange={(e) => setCfg((m) => ({ ...m, [i]: { ...c, enabled: e.target.checked } }))} />
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="font-medium text-foreground">{lot.qty} pcs · {lot.processName} done</div>
                        <div className="text-xs text-muted-foreground">
                          at {lot.vendorCode ? `${lot.vendorCode} · ${lot.vendorName}` : '—'}{lot.color ? ` (${lot.color})` : ''}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {lot.nextUsesColor ? (
                          // Multi-colour mode: the row's "Settle qty" is the SUM
                          // of the per-colour splits below. Read-only here so
                          // the per-colour inputs are the single source of truth.
                          <>
                            <div className="text-base font-bold tabular-nums">{sumLotQty(lot, c)}</div>
                            <div className="text-[10px] text-muted-foreground">sum of colours · max {lot.qty}</div>
                          </>
                        ) : (
                          <>
                            <Input type="number" min={0} max={lot.qty} className="h-7 w-20 text-right"
                              disabled={!settlesEnabled || !c.enabled}
                              value={c.qty}
                              onChange={(e) => setCfg((m) => ({ ...m, [i]: { ...c, qty: e.target.value.replace(/[^0-9]/g, '') } }))} />
                            <div className="text-[10px] text-muted-foreground">max {lot.qty}</div>
                          </>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <Select value={c.processId}
                          disabled={!settlesEnabled || !c.enabled}
                          onChange={(e) => setCfg((m) => ({ ...m, [i]: { ...c, processId: e.target.value ? Number(e.target.value) : '', vendorId: '' } }))}>
                          <option value="">— Select —</option>
                          {nextProcessOpts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </Select>
                      </td>
                      <td className="px-2 py-1.5">
                        {lot.nextUsesColor ? (
                          <span className="text-xs text-muted-foreground">per-colour ↓</span>
                        ) : (
                          <>
                            <SearchableSelect
                              value={c.vendorId}
                              disabled={!settlesEnabled || !c.enabled || !c.processId}
                              placeholder={c.processId ? 'auto by colour' : 'pick process first'}
                              onChange={(v) => setCfg((m) => ({ ...m, [i]: { ...c, vendorId: v ? Number(v) : '' } }))}
                              options={procVendors.map((v: any) => ({
                                value: v.id, label: `${v.vendorCode} · ${v.vendorName}`, keywords: v.vendorName,
                              }))}
                            />
                            {c.processId && procVendors.length === 0 && (
                              <div className="text-[10px] text-warning">No vendor configured for this process — auto-pick will fail.</div>
                            )}
                          </>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {colourOpts.length > 0 ? (
                          <div className="space-y-1">
                            {/* Multi-pick: tick the colours you want this lot
                                to fan out into. Each ticked colour gets its
                                own qty input + per-colour vendor override
                                (auto by colour when blank), matching ForwardDialog. */}
                            {colourOpts.map((co) => {
                              const checked = c.colorSplits?.[co] !== undefined;
                              const qtyStr = c.colorSplits?.[co] ?? '';
                              const vId = c.colorVendors?.[co] ?? '';
                              return (
                                <div key={co} className="rounded-md border border-border bg-card/50 px-2 py-1">
                                  <label className="flex items-center gap-1.5">
                                    <input type="checkbox" className="size-3.5 accent-primary"
                                      disabled={!settlesEnabled || !c.enabled}
                                      checked={checked}
                                      onChange={(e) => setCfg((m) => {
                                        const cur = m[i] ?? c;
                                        const splits = { ...(cur.colorSplits ?? {}) };
                                        const vendors = { ...(cur.colorVendors ?? {}) };
                                        if (e.target.checked) {
                                          splits[co] = '0'; // placeholder before redistribute
                                        } else {
                                          delete splits[co];
                                          delete vendors[co];
                                        }
                                        // AUTO-DISTRIBUTE lot.qty evenly across all
                                        // currently-ticked colours — even-whole split
                                        // (remainder spread to the first colours).
                                        // Overwrites any prior manual edits so the sum
                                        // always equals lot.qty after tick/untick.
                                        const keys = Object.keys(splits);
                                        const k = keys.length;
                                        if (k > 0) {
                                          const base = Math.floor(lot.qty / k);
                                          const rem = lot.qty - base * k;
                                          keys.forEach((key, idx) => {
                                            splits[key] = String(base + (idx < rem ? 1 : 0));
                                          });
                                        }
                                        return { ...m, [i]: { ...cur, colorSplits: splits, colorVendors: vendors } };
                                      })} />
                                    <span className="flex-1 text-xs font-medium">{co}</span>
                                    {checked && (
                                      <Input type="number" min={0} className="h-6 w-16 text-right text-xs"
                                        disabled={!settlesEnabled || !c.enabled}
                                        value={qtyStr}
                                        onChange={(e) => setCfg((m) => {
                                          const cur = m[i] ?? c;
                                          return { ...m, [i]: { ...cur, colorSplits: { ...(cur.colorSplits ?? {}), [co]: e.target.value.replace(/[^0-9]/g, '') } } };
                                        })} />
                                    )}
                                  </label>
                                  {checked && (
                                    <div className="mt-1 ml-5">
                                      <SearchableSelect
                                        value={vId}
                                        disabled={!settlesEnabled || !c.enabled || !c.processId}
                                        placeholder="auto by colour"
                                        onChange={(v) => setCfg((m) => {
                                          const cur = m[i] ?? c;
                                          const vendors = { ...(cur.colorVendors ?? {}) };
                                          if (v) vendors[co] = Number(v);
                                          else delete vendors[co];
                                          return { ...m, [i]: { ...cur, colorVendors: vendors } };
                                        })}
                                        options={procVendors.map((v: any) => ({
                                          value: v.id, label: `${v.vendorCode} · ${v.vendorName}`, keywords: v.vendorName,
                                        }))}
                                      />
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                            {/* Over-cap warning — sum exceeds available pcs.
                                Cleaner than a toast on submit because the user
                                sees it WHILE editing the numbers. Hint
                                suggests casting more new pieces to cover the
                                gap (the main strategy radios above handle the
                                "cast new" path). */}
                            {(() => {
                              const sum = sumLotQty(lot, c);
                              const over = sum - lot.qty;
                              if (over <= 0) return null;
                              return (
                                <div className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning">
                                  ⚠ Sum {sum} &gt; {lot.qty} available · need {over} more pcs.
                                  Reduce a colour qty or switch strategy to <strong>"Use existing + cast shortfall"</strong> above to cast the extra.
                                </div>
                              );
                            })()}
                            {design?.itemId && c.processId && (
                              <a
                                href={`/items/${design.itemId}/edit?focusProcess=${c.processId}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                                title="Open this design in Item Master to define a new colour for this process"
                              >
                                <Plus className="size-3" /> Add colour
                              </a>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        )}

        {/* At-vendor lots — now ACTIONABLE via "planned forward". The user picks
            where these pieces go AFTER they're received, and the backend
            auto-forwards them into the new batch the moment a receipt is made.
            Dimmed when strategy = "Cast new only" (planning doesn't apply). */}
        {atVendorLots.length > 0 && (
          <div className={`overflow-hidden rounded-lg border border-info/30 ${settlesEnabled ? '' : 'opacity-50'}`}>
            <div className="border-b border-info/30 bg-info/10 px-3 py-1.5 text-xs font-semibold text-sky-900">
              {settlesEnabled
                ? 'At-vendor lots — pre-plan next step · auto-routes into the new batch on receipt'
                : 'At-vendor lots — not pre-planned in "Cast new only" mode'}
            </div>
            <div className="table-scroll">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-info/10/50 text-left text-xs text-info">
                <tr>
                  <th className="px-2 py-1.5"></th>
                  <th className="px-2 py-1.5">Lot</th>
                  <th className="px-2 py-1.5">When received, send to</th>
                  <th className="px-2 py-1.5">Vendor</th>
                  <th className="px-2 py-1.5">Colour</th>
                </tr>
              </thead>
              <tbody>
                {atVendorLots.map((lot, i) => {
                  // Fallback MUST match the AvCfg type exactly (all 6 fields)
                  // or React fires "uncontrolled→controlled" warnings when the
                  // init effect later populates state with the missing fields.
                  const a: AvCfg = avCfg[i] ?? {
                    enabled: true,
                    processId: lot.nextProcessId ?? '',
                    vendorId: '',
                    color: '',
                    receiveNow: false,
                    receiveQty: String(lot.qty),
                  };
                  const target = processes.find((p) => p.id === Number(a.processId));
                  const procVendors = target?.vendors ?? [];
                  const colourOpts: string[] = lot.nextColorOptions ?? [];
                  // Filter to processes AFTER the lot's current process (no re-doing done steps).
                  const lotProcIdx = processes.findIndex((p) => p.code === lot.processCode);
                  const nextProcessOpts = lotProcIdx >= 0 ? processes.slice(lotProcIdx + 1) : processes;
                  return (
                    <React.Fragment key={`av-${i}`}>
                      <tr className="border-t border-sky-100 align-top">
                        <td className="px-2 py-1.5">
                          <input type="checkbox" className="mt-1 size-4 accent-primary"
                            disabled={!settlesEnabled}
                            checked={a.enabled && settlesEnabled}
                            onChange={(e) => setAvCfg((m) => ({ ...m, [i]: { ...a, enabled: e.target.checked } }))} />
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="font-medium text-foreground">{lot.qty} pcs · {lot.processName} at vendor</div>
                          <div className="text-xs text-muted-foreground">
                            {lot.vendorCode ? `${lot.vendorCode} · ${lot.vendorName}` : '—'}{lot.color ? ` (${lot.color})` : ''} · batch {(lot.batches || []).join(', ') || '—'}
                          </div>
                        </td>
                        <td className="px-2 py-1.5">
                          <Select value={a.processId}
                            disabled={!settlesEnabled || !a.enabled}
                            onChange={(e) => setAvCfg((m) => ({ ...m, [i]: { ...a, processId: e.target.value ? Number(e.target.value) : '', vendorId: '' } }))}>
                            <option value="">— Select —</option>
                            {nextProcessOpts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </Select>
                        </td>
                        <td className="px-2 py-1.5">
                          <SearchableSelect
                            value={a.vendorId}
                            disabled={!settlesEnabled || !a.enabled || !a.processId}
                            placeholder={a.processId ? 'auto by colour' : 'pick process first'}
                            onChange={(v) => setAvCfg((m) => ({ ...m, [i]: { ...a, vendorId: v ? Number(v) : '' } }))}
                            options={procVendors.map((v: any) => ({
                              value: v.id ?? v.vendorId,
                              label: `${v.vendorCode} · ${v.vendorName}`,
                              keywords: v.vendorName,
                            }))}
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          {colourOpts.length > 0 ? (
                            <>
                              <Select value={a.color}
                                disabled={!settlesEnabled || !a.enabled}
                                onChange={(e) => setAvCfg((m) => ({ ...m, [i]: { ...a, color: e.target.value } }))}>
                                {colourOpts.map((co) => <option key={co} value={co}>{co}</option>)}
                              </Select>
                              {design?.itemId && a.processId && (
                                <a
                                  href={`/items/${design.itemId}/edit?focusProcess=${a.processId}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                                  title="Open this design in Item Master to define a new colour for this process"
                                >
                                  <Plus className="size-3" /> Add colour
                                </a>
                              )}
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                      {/* Receive-now toggle row — when checked, vendor returns are
                          recorded at batch-create time so the pieces land in the
                          new batch immediately (rather than waiting for Receive Goods). */}
                      <tr className="bg-info/10/30">
                        <td></td>
                        <td colSpan={4} className="px-2 pb-2 pt-0">
                          <label className="inline-flex items-center gap-2 text-xs text-sky-900">
                            <input type="checkbox" className="size-3.5 accent-primary"
                              disabled={!settlesEnabled || !a.enabled}
                              checked={a.receiveNow}
                              onChange={(e) => setAvCfg((m) => ({ ...m, [i]: { ...a, receiveNow: e.target.checked } }))} />
                            Receive now — the vendor has returned these pieces, record receipt at batch-create time
                          </label>
                          {a.receiveNow && (
                            <div className="mt-1.5 flex items-center gap-2 text-xs text-sky-900">
                              <span className="text-info">Qty received:</span>
                              <Input type="number" min={0} max={lot.qty} className="h-7 w-20 text-right"
                                value={a.receiveQty}
                                onChange={(e) => setAvCfg((m) => ({ ...m, [i]: { ...a, receiveQty: e.target.value.replace(/[^0-9]/g, '') } }))} />
                              <span className="text-info">/ {lot.qty} at vendor</span>
                              <span className="text-info">· will auto-forward into the new batch</span>
                            </div>
                          )}
                        </td>
                      </tr>
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
            </div>
            <div className="border-t border-info/30 bg-info/10 px-3 py-1.5 text-[11px] text-info">
              When the vendor returns these pieces, Receive Goods will auto-forward them to the planned next step + vendor — landing in this new batch alongside the freshly cast pieces.
            </div>
          </div>
        )}

        {/* Numbers preview — live summary of what's about to happen on Apply. */}
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
          <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-5">
            <div><span className="text-muted-foreground">Order target:</span> <strong>{targetQty}</strong></div>
            <div><span className="text-muted-foreground">Packed:</span> <strong>{summary.finished}</strong></div>
            <div><span className="text-muted-foreground">Settling now:</span> <strong>{settlesEnabled ? totalSettling : 0}</strong></div>
            <div><span className="text-muted-foreground">At vendor:</span> <strong>{atVendorQty}</strong></div>
            <div><span className="text-muted-foreground">→ Cast new:</span> <strong className="text-foreground">{recommendedCastQty}</strong></div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function StrategyCard({ checked, onClick, title, body, disabled = false }: { checked: boolean; onClick: () => void; title: string; body: string; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`text-left rounded-lg border p-3 transition-colors ${
        disabled ? 'cursor-not-allowed opacity-50 border-border'
        : checked ? 'border-primary bg-primary/5 ring-1 ring-primary'
        : 'border-border hover:bg-muted/40'
      }`}>
      <div className="flex items-center gap-2">
        <span className={`inline-block size-3.5 rounded-full border-2 ${checked ? 'border-primary bg-primary' : 'border-muted-foreground'}`} />
        <span className="font-semibold">{title}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{body}</p>
    </button>
  );
}

function CastingRow({
  row, castingProcessId, processVendors, allVendors, items, chosenItemIds, otherRows, meta, onChange, onRemove, onMergeInto,
}: {
  row: Row; castingProcessId: number;
  processVendors: { id: number; vendorCode: string; vendorName: string }[];
  allVendors: { id: number; vendorCode: string; vendorName: string }[];
  items: any[]; chosenItemIds: number[];
  // Other rows in the batch — used for the duplicate-design check. When
  // operator picks an item already on another row, we show a confirm
  // dialog asking whether to merge qty into the existing row or keep
  // both as separate lines.
  otherRows: Array<{ itemId?: number; quantity: string }>;
  meta: ItemMeta;
  onChange: (patch: Partial<Row>) => void; onRemove: () => void;
  // Called when operator chooses "merge into existing" on the duplicate
  // dialog — parent adds this row's qty to the existing row's qty AND
  // removes this row. Existing row's qty might be empty; in that case
  // the merged value is just this row's qty.
  onMergeInto: (existingItemId: number, addQty: number) => void;
}) {
  // Pending duplicate pick — when the operator picks an itemId that's
  // already on another row, we stash it here and show a confirmation
  // dialog. Operator picks "merge qty" (calls onMergeInto + removes this
  // row), "keep separate" (commits the pick, dismisses dialog), or
  // "cancel" (clears the picked itemId).
  const [dupePending, setDupePending] = React.useState<{ itemId: number; existingQty: number } | null>(null);
  const { data: item } = useQuery<Item>({
    queryKey: ['item', row.itemId], queryFn: () => Api.items.get(row.itemId!), enabled: !!row.itemId,
  });
  // Produced-goods alert: warn if this design already has finished/idle pieces
  // in stock. refetchOnFocus so re-entering the form picks up any inventory
  // changes from other tabs / actions (no stale "stock found" surprises).
  const { data: produced } = useQuery({
    queryKey: ['produced', row.itemId], queryFn: () => Api.casting.produced(row.itemId!),
    enabled: !!row.itemId,
    refetchOnWindowFocus: true,
    staleTime: 0, // always check freshness when this query is used
  });
  // Exclude SHORT-CLOSED batch lots from "existing stock" — those pieces are
  // frozen write-offs the user already accepted as lost; they're not free
  // inventory for a new order.
  const allLots = (produced?.rows ?? []).filter((r: any) => !r.batchClosed);
  const finishedQty = allLots.filter((r: any) => r.state === 'FINISHED').reduce((s: number, r: any) => s + r.qty, 0);
  const inHouseQty = allLots.filter((r: any) => r.state === 'IN_HOUSE').reduce((s: number, r: any) => s + r.qty, 0);
  const atVendorQty = allLots.filter((r: any) => r.state === 'AT_VENDOR').reduce((s: number, r: any) => s + r.qty, 0);
  const producedQty = finishedQty + inHouseQty + atVendorQty;
  // Only AUTO-OPEN the popup when we have ACTIONABLE stock — pieces in our
  // hands (packed + half-done idle). At-vendor counts as "in production",
  // not "stock", so it doesn't trigger the interrupt (the user can still
  // review them via the "Review existing stock" button if they want).
  const actionableQty = finishedQty + inHouseQty;

  // Settle dialog open/close. Auto-opens ONCE per design selection when
  // ACTIONABLE stock exists — at-vendor alone doesn't trigger the popup.
  const [settleOpen, setSettleOpen] = React.useState(false);
  const autoOpenedFor = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!row.itemId) { autoOpenedFor.current = null; return; }
    if (actionableQty > 0 && autoOpenedFor.current !== row.itemId) {
      autoOpenedFor.current = row.itemId;
      setSettleOpen(true);
    }
  }, [row.itemId, actionableQty]);
  // Row-level entry process. Defaults to CAM (the standard first stage)
  // but the operator can override per row so designs that skip CAM start
  // further down the chain (e.g. begin at Casting or Polish).
  const camProc = meta.processes.find((p) => p.code === 'CAM');
  const effectiveEntryId = (row.entryProcessId != null && row.entryProcessId !== '')
    ? Number(row.entryProcessId)
    : (camProc?.id ?? 0);
  const effectiveEntryProc = meta.processes.find((p) => p.id === effectiveEntryId);
  const effectiveEntryCode = effectiveEntryProc?.code ?? 'CAM';
  const isCastingEntry = effectiveEntryCode === 'CASTING';
  // Look up the item's config for the SELECTED entry process (vendor,
  // weight, rate). Fall back to CAM / CASTING for legacy items whose
  // process rows haven't been reconfigured yet.
  const casting = item?.processes.find((p) => p.code === effectiveEntryCode)
                ?? item?.processes.find((p) => p.code === 'CAM')
                ?? item?.processes.find((p) => p.code === 'CASTING');
  const weight = casting ? Number(casting.attributes?.weight || 0) : 0;
  const entries = casting?.vendors ?? [];
  const preferred = entries.find((e) => e.isPreferred) ?? entries[0];
  // Vendors offered in the picker follow the ROW'S entry process — a
  // Casting-entry row lists Casting vendors, a CAM-entry row lists CAM
  // vendors, etc. `processVendors` from the parent is only the default
  // (CAM), so we source per-row from the meta.processes list.
  const vendorList = effectiveEntryProc?.vendors ?? processVendors;

  const effectiveVendor = (row.vendorId || preferred?.vendorId) ?? '';
  const chosenEntry = (effectiveVendor ? entries.find((e) => e.vendorId === Number(effectiveVendor)) : null) ?? preferred;
  const ref = chosenEntry?.vendorDesignReference ?? '';
  const resolvedRate = chosenEntry?.costPerPiece ?? null;
  const qty = Number(row.quantity || 0);

  // Vendor-level rate fallback — when the item × vendor master has no
  // rate AND operator hasn't typed one, look up this vendor's MOST RECENT
  // casting rate across any item and pre-fill. Reflects "Krishna does
  // casting at ₹760/kg for everything" — operator only overrides for the
  // rare design that's priced differently. Fires once per (vendor, item)
  // combo so a vendor switch re-fetches but a quantity edit doesn't.
  React.useEffect(() => {
    if (!effectiveVendor || !castingProcessId) return;
    if (row.costPerKg != null && row.costPerKg !== '') return; // operator already typed
    if (resolvedRate != null) return; // item master has its own rate
    let cancelled = false;
    Api.casting.vendorRate(Number(effectiveVendor), castingProcessId)
      .then((r) => {
        if (cancelled) return;
        if (r.rate != null && r.rate > 0) {
          onChange({ costPerKg: String(r.rate) });
        }
      })
      .catch(() => { /* silent — empty fallback is fine */ });
    return () => { cancelled = true; };
  }, [effectiveVendor, castingProcessId, resolvedRate, row.itemId]); // eslint-disable-line react-hooks/exhaustive-deps

  const weightStr = row.weight ?? (weight ? String(weight) : '');
  const costStr = row.costPerKg ?? (resolvedRate != null ? String(resolvedRate) : '');
  const computedTotal = Number(weightStr || 0) * qty;
  const totalWeightStr = row.totalWeight ?? (computedTotal ? String(computedTotal) : '');
  const effTotalWeight = Number(totalWeightStr || 0);
  const totalCost = effTotalWeight * Number(costStr || 0); // casting priced per gram

  // All Production-Ready designs are pickable — duplicates allowed but a
  // confirm dialog asks "merge or keep separate" so the operator doesn't
  // accidentally add the same design twice in the same batch without
  // realising. `chosenItemIds` is no longer used to filter the picker;
  // it's read elsewhere to drive the duplicate detection.
  const selectableItems = items;
  void chosenItemIds; // kept on the prop signature for future use; intentionally unread here

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      {row.itemId && producedQty > 0 && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-warning" />
            <span>
              <strong>{producedQty} pcs</strong> of this design already exist
              {finishedQty > 0 && <> — <strong>{finishedQty}</strong> packed</>}
              {inHouseQty > 0 && <>, <strong>{inHouseQty}</strong> in-process</>}
              {atVendorQty > 0 && <>, <strong>{atVendorQty}</strong> at vendor</>}.
              Settle first — cast only the shortfall.
            </span>
          </div>
          <Button
            type="button" size="sm" variant="outline"
            className="h-7 border-amber-400 bg-white px-2 text-xs text-warning hover:bg-warning/15"
            onClick={() => setSettleOpen(true)}
          >
            <PackageSearch className="size-3.5" /> Review existing stock
          </Button>
        </div>
      )}
      {row.itemId && item && (
        <SettleExistingStockDialog
          open={settleOpen}
          onClose={() => setSettleOpen(false)}
          design={{ itemId: row.itemId, itemNumber: item.itemNumber, designCode: item.sampleDesignCode, itemName: item.category ?? null }}
          lots={allLots}
          summary={{ finished: finishedQty, inHouse: inHouseQty, atVendor: atVendorQty }}
          initialTargetQty={Number(row.quantity || 0)}
          meta={meta}
          onApplied={(newQty, settles, plans) => onChange({ quantity: String(newQty), pendingSettles: settles, pendingPlans: plans })}
        />
      )}
      {row.pendingSettles && row.pendingSettles.length > 0 && (
        <div className="mb-2 rounded-md border border-success/40 bg-success/10 px-3 py-1.5 text-xs text-success">
          <strong>Will absorb into this new batch:</strong>{' '}
          {row.pendingSettles.map((s, i) => (
            <span key={i}>
              {i > 0 && <>, </>}
              {s.maxQty} pcs from {s.fromProcessName} → {s.toProcessName}{s.color ? ` (${s.color})` : ''}
            </span>
          ))}
        </div>
      )}
      {row.pendingPlans && row.pendingPlans.length > 0 && (
        <div className="mb-2 rounded-md border border-sky-300 bg-info/10 px-3 py-1.5 text-xs text-sky-900">
          <strong>From at-vendor:</strong>{' '}
          {row.pendingPlans.map((p, i) => (
            <span key={i}>
              {i > 0 && <>, </>}
              {p.receiveNow && p.receiveQty > 0
                ? <>{p.receiveQty} pcs received now → {p.toProcessName}{p.color ? ` (${p.color})` : ''}</>
                : <>{p.qty} pcs · {p.fromProcessName} → {p.toProcessName}{p.color ? ` (${p.color})` : ''} (when vendor returns)</>}
            </span>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-12">
        <div className="sm:col-span-4">
          <Field label="Design (Production Ready)">
            <SearchableSelect
              value={row.itemId ?? ''}
              placeholder="— Select design —"
              onChange={(v) => {
                const newId = v ? Number(v) : undefined;
                if (newId && newId !== row.itemId) {
                  // Check if another row already has this design in the
                  // current batch — pop the confirm dialog instead of
                  // silently adding a duplicate.
                  const existing = otherRows.find((r) => r.itemId === newId);
                  if (existing) {
                    setDupePending({ itemId: newId, existingQty: Number(existing.quantity || 0) });
                    return;
                  }
                }
                onChange({ itemId: newId, vendorId: '', weight: undefined, costPerKg: undefined, totalWeight: undefined });
              }}
              options={selectableItems.map((it) => ({
                value: it.id,
                label: `${it.itemNumber != null ? `#${it.itemNumber} · ` : ''}${it.sampleDesignCode}`,
                keywords: `${it.category ?? ''} ${it.collection ?? ''} ${it.designerName ?? ''}`,
              }))}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Initial Process" hint="default CAM; pick another to skip / re-enter">
            <SearchableSelect
              value={effectiveEntryId || ''}
              placeholder="— Pick —"
              onChange={(v) => onChange({ entryProcessId: v ? Number(v) : '', vendorId: '' })}
              options={meta.processes
                .filter((p) => p.code !== 'RAW_MATERIAL_SUPPLIER' && p.code !== 'CAD')
                .map((p) => ({
                  value: p.id,
                  label: `${p.name}${p.costUnit === 'KG' ? ' (per g)' : ''}`,
                  keywords: p.code,
                }))}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label={`${effectiveEntryProc?.name ?? 'Entry'} Vendor`}>
            <SearchableSelect
              value={effectiveVendor}
              placeholder="— Select —"
              onChange={(v) => onChange({ vendorId: v ? Number(v) : '' })}
              options={vendorList.map((v) => ({ value: v.id, label: `${v.vendorCode} · ${v.vendorName}`, keywords: v.vendorName }))}
            />
          </Field>
        </div>
        {/* Vendor Design Ref — vendor's own item code on the slip. When
            blank in Item Master for the chosen vendor, the hint flags it
            and the operator can capture on the spot. Backend's
            ensureProcessVendor saves it back to the master row silently,
            so the next batch defaults from it. */}
        <div className="sm:col-span-2">
          <Field
            label="Vendor Design Ref"
            hint={row.itemId && !ref && (row.vendorDesignReference ?? '') === ''
              ? 'Blank in master — will save back on submit.'
              : 'vendor\'s own item code'}
          >
            <Input
              value={row.vendorDesignReference ?? ref}
              placeholder={ref || 'e.g. 8748'}
              onChange={(e) => onChange({ vendorDesignReference: e.target.value })}
            />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Total Qty"><Input type="number" value={row.quantity} onChange={(e) => onChange({ quantity: e.target.value })} /></Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Wt / pc (g)"><Input type="number" step="0.001" value={weightStr} onChange={(e) => onChange({ weight: e.target.value })} /></Field>
          {/* Casting weight temporary — operator's escape hatch when no
              accurate per-pc weight is on hand yet (common on fresh
              designs). Only relevant when the row's entry process is
              CASTING — hidden for CAM / other entries. */}
          {isCastingEntry && (
          <label className="mt-1 flex cursor-pointer items-center gap-1.5 text-xs text-warning">
            <input
              type="checkbox"
              className="size-3.5 accent-amber-600"
              checked={!!row.castingWeightTemporary}
              onChange={(e) => onChange({ castingWeightTemporary: e.target.checked })}
            />
            Casting weight temporary <span className="text-muted-foreground">(prompt for final on receive)</span>
          </label>
          )}
        </div>
        <div className="sm:col-span-2">
          <Field label="Rate / g"><Input type="number" step="0.01" value={costStr} onChange={(e) => onChange({ costPerKg: e.target.value })} /></Field>
        </div>
        <div className="sm:col-span-3">
          <Field label="Total Weight (g) · editable"><Input type="number" step="0.001" value={totalWeightStr} onChange={(e) => onChange({ totalWeight: e.target.value })} /></Field>
        </div>
        <div className="sm:col-span-3">
          <Field label="Purpose" hint="Customer / order / Stock / Sample">
            <Input value={row.purpose ?? ''} onChange={(e) => onChange({ purpose: e.target.value })} placeholder="e.g. Mr. Sharma" />
          </Field>
        </div>
        <div className="sm:col-span-4">
          <Field label="Remarks"><Input value={row.remarks} onChange={(e) => onChange({ remarks: e.target.value })} /></Field>
        </div>
        <div className="sm:col-span-2 flex items-end">
          <Button type="button" variant="outline" size="icon" className="mb-0.5 text-destructive hover:bg-destructive/10" onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span>Vendor Ref: <strong className="text-foreground">{ref || '—'}</strong></span>
        <span>Total Wt: <strong className="text-foreground">{effTotalWeight ? effTotalWeight.toFixed(3) + ' g' : '—'}</strong></span>
        <span>Casting Cost: <strong className="text-foreground">{totalCost ? formatCurrency(totalCost) : '—'}</strong></span>
      </div>

      {/* Duplicate-design confirm — operator picked a design that's
          already on another row of this batch. Three choices: bump qty
          on the existing row (this row is removed), keep both as
          separate lines (commits the pick), or cancel (clears it). */}
      {dupePending && (() => {
        const pickedItem = items.find((it) => it.id === dupePending.itemId);
        const designLabel = pickedItem
          ? `#${pickedItem.itemNumber ?? pickedItem.sampleDesignCode}${pickedItem.itemName ? ` · ${pickedItem.itemName}` : ''}`
          : `#${dupePending.itemId}`;
        return (
          <Dialog
            open
            onClose={() => setDupePending(null)}
            size="md"
            title="Design already in this batch"
            description={`${designLabel} is already on another row (qty ${dupePending.existingQty || '—'}). What would you like to do?`}
            footer={
              <>
                <Button variant="outline" onClick={() => setDupePending(null)}>Cancel</Button>
                <Button variant="outline" onClick={() => {
                  // Keep both as separate lines — commit the pick on this row.
                  onChange({
                    itemId: dupePending.itemId, vendorId: '',
                    weight: undefined, costPerKg: undefined, totalWeight: undefined,
                  });
                  setDupePending(null);
                }}>Add as separate line</Button>
                <Button onClick={() => {
                  // Merge: parent bumps the existing row's qty by THIS
                  // row's typed qty (if any) and removes this row.
                  const addQty = Math.max(0, Math.trunc(Number(row.quantity) || 0));
                  onMergeInto(dupePending.itemId, addQty);
                  setDupePending(null);
                }}>Increase qty on existing</Button>
              </>
            }
          >
            <div className="text-sm text-muted-foreground">
              Choosing <strong>Increase qty on existing</strong> will add this row's quantity ({Math.max(0, Math.trunc(Number(row.quantity) || 0))} pcs) to the existing line and remove this row.
              <br />
              <strong>Add as separate line</strong> keeps both rows — useful when the same design goes to two different vendors / colours / purposes.
            </div>
          </Dialog>
        );
      })()}
    </div>
  );
}

export function BatchForm({
  open, onClose, onSaved, batchId,
}: {
  open: boolean; onClose: () => void; onSaved: (batchId: number) => void; batchId?: number | null;
}) {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const [batchNumber, setBatchNumber] = React.useState('');
  const [batchDate, setBatchDate] = React.useState(today);
  const [notes, setNotes] = React.useState('');
  const [rows, setRows] = React.useState<Row[]>([emptyRow()]);

  const metaQ = useQuery<ItemMeta>({ queryKey: ['item-meta'], queryFn: () => Api.items.meta(), enabled: open });
  const itemsQ = useQuery({
    queryKey: ['items-prod-ready'],
    queryFn: () => Api.items.list({ sampleStatus: 'PRODUCTION_READY' }),
    enabled: open,
  });

  // Entry-process lookup — CAM is the first stage. Fallback to CASTING for
  // legacy items whose process config hasn't been migrated to CAM yet.
  const casting = (metaQ.data?.processes ?? []).find((p) => p.code === 'CAM')
              ?? (metaQ.data?.processes ?? []).find((p) => p.code === 'CASTING');
  const processVendors = casting?.vendors ?? [];

  React.useEffect(() => {
    if (!open) return;
    setBatchDate(today); setNotes(''); setRows([emptyRow()]); setBatchNumber('…');
    Api.casting.nextBatchNumber().then((r) => setBatchNumber(r.batchNumber)).catch(() => setBatchNumber(''));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const setRow = (idx: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const chosenItemIds = rows.map((r) => r.itemId).filter((x): x is number => !!x);

  // Ref guard against double-click — `save.isPending` only flips AFTER the
  // mutation actually starts, leaving a tiny race window where two rapid
  // clicks can both pass the `disabled` check and fire `mutate()` twice
  // (which is how the duplicate B0029 / B0030 pair got created). The ref
  // flips synchronously inside the click handler so the second click bails
  // immediately. Reset on both onSuccess and onError so the user can retry
  // after a failure.
  const submitting = React.useRef(false);
  const submit = () => {
    if (submitting.current || save.isPending) return;
    submitting.current = true;
    save.mutate();
  };

  const save = useMutation({
    mutationFn: async () => {
      const num = (v?: string) => (v !== undefined && v !== '' ? Number(v) : undefined);
      const items = rows
        .filter((r) => r.itemId && Number(r.quantity) > 0)
        .map((r) => ({
          itemId: r.itemId,
          entryProcessId: r.entryProcessId ? Number(r.entryProcessId) : undefined,
          quantity: Number(r.quantity),
          vendorId: r.vendorId ? Number(r.vendorId) : undefined,
          weight: num(r.weight),
          costPerKg: num(r.costPerKg),
          totalWeight: num(r.totalWeight),
          remarks: r.remarks || undefined,
          purpose: r.purpose?.trim() || undefined,
          vendorDesignReference: r.vendorDesignReference?.trim() || undefined,
          castingWeightTemporary: r.castingWeightTemporary || undefined,
        }));
      // Pending settles + plans flatten across all rows.
      const allSettles = rows.flatMap((r) => r.pendingSettles ?? []);
      const allPlans = rows.flatMap((r) => r.pendingPlans ?? []);
      if (!items.length && !allSettles.length && !allPlans.length) {
        throw new Error('Add at least one design (cast new pieces, absorb existing stock, or plan an at-vendor return).');
      }
      const created = await Api.casting.createBatch({ batchDate, notes: notes || undefined, items });
      // Settle now — child stages land in the new batch.
      for (const s of allSettles) {
        await Api.casting.settle({
          stageIds: s.stageIds, nextProcessId: s.nextProcessId, color: s.color,
          vendorId: s.vendorId, maxQty: s.maxQty, targetBatchId: created.id,
        });
      }
      // Register at-vendor plans FIRST so receive-now receipts can find them
      // and auto-forward into the new batch.
      for (const p of allPlans) {
        await Api.casting.planForward(p.stageId, {
          nextProcessId: p.nextProcessId, vendorId: p.vendorId, color: p.color,
          targetBatchId: created.id,
        });
      }
      // Group receive-now plans by source batch + vendor, fire one receipt per
      // group. Each receipt triggers the backend auto-forward (because the plan
      // is now registered above), so received pieces land in the new batch.
      const receiveNowPlans = allPlans.filter((p) => p.receiveNow && p.receiveQty > 0);
      const groupKey = (p: PendingPlan) => `${p.sourceBatchId}:${p.sourceVendorId}`;
      const groupedReceipts = new Map<string, PendingPlan[]>();
      for (const p of receiveNowPlans) {
        const key = groupKey(p);
        const arr = groupedReceipts.get(key) ?? [];
        arr.push(p);
        groupedReceipts.set(key, arr);
      }
      const receiveNowTotal = receiveNowPlans.reduce((s, p) => s + p.receiveQty, 0);
      for (const group of groupedReceipts.values()) {
        const sample = group[0];
        await Api.casting.createReceipt({
          batchId: sample.sourceBatchId,
          vendorId: sample.sourceVendorId,
          receiptDate: batchDate,
          notes: `Auto-receipt at new batch ${created.batchNumber} creation`,
          items: group.map((p) => ({
            batchItemId: p.stageId,
            receivedQty: p.receiveQty,
            receivedWeight: Math.round(p.receiveQty * p.perPieceWeight * 1000) / 1000,
          })),
        });
      }
      return {
        ...created,
        absorbed: allSettles.reduce((sum, s) => sum + s.maxQty, 0),
        planned: allPlans.filter((p) => !p.receiveNow).reduce((sum, p) => sum + p.qty, 0),
        receivedNow: receiveNowTotal,
      };
    },
    onSuccess: (res: any) => {
      const absorbed = res.absorbed ?? 0;
      const planned = res.planned ?? 0;
      const receivedNow = res.receivedNow ?? 0;
      const extras: string[] = [];
      if (absorbed > 0) extras.push(`${absorbed} pcs absorbed`);
      if (receivedNow > 0) extras.push(`${receivedNow} pcs received now`);
      if (planned > 0) extras.push(`${planned} pcs scheduled to auto-route on receipt`);
      toast.success(
        extras.length
          ? `Production batch ${res.batchNumber} created — ${extras.join(', ')}.`
          : `Production batch ${res.batchNumber} created (Casting issued).`,
      );
      // Heads-up toast — design(s) whose Casting weight was just captured for
      // the first time get "casting weight temporary" added to Item Master
      // notes. The receive form will prompt for the final per-pc weight on
      // the first Casting receipt; until then the master uses the guess.
      const tempFlagged = (res.tempWeightFlagged ?? []) as number[];
      if (tempFlagged.length > 0) {
        toast.info(
          tempFlagged.length === 1
            ? `Casting weight saved as temporary on 1 design — will prompt for final per-pc weight when received.`
            : `Casting weight saved as temporary on ${tempFlagged.length} designs — will prompt for final per-pc weight when received.`,
          { duration: 7000 },
        );
      }
      // Auto-rate-sync toasts: when the typed Casting rate updated an item's
      // master rate (because it differed from what was there before), the
      // backend returns one rateUpdate per item that changed. Show a toast
      // with Undo per non-silent change — silent ones are blank-fills the
      // user implicitly asked for by typing a rate.
      for (const u of (res.rateUpdates ?? []) as any[]) {
        if (u.silent) continue;
        toast.info(`${u.processName} rate updated for #${u.itemId} → ₹${u.newRate} (was ₹${u.oldRate})`, {
          duration: 8000,
          action: {
            label: 'Undo',
            onClick: async () => {
              try {
                await Api.items.setProcessRate(u.itemId, u.processId, {
                  vendorId: u.vendorId,
                  rate: u.oldRate,
                });
                toast.success(`Reverted ${u.processName} rate to ₹${u.oldRate}.`);
                qc.invalidateQueries({ queryKey: ['item', u.itemId] });
                qc.invalidateQueries({ queryKey: ['item-meta'] });
              } catch (e) {
                toast.error(getApiError(e).message);
              }
            },
          },
        });
      }
      qc.invalidateQueries({ queryKey: ['casting-batches'] });
      qc.invalidateQueries({ queryKey: ['casting-batch'] });
      qc.invalidateQueries({ queryKey: ['casting-pending'] });
      qc.invalidateQueries({ queryKey: ['casting-receipts'] });
      qc.invalidateQueries({ queryKey: ['produced'] });
      // Item-meta needs refresh too — rate sync changed master values, so the
      // batch form, item statement etc. would otherwise show stale rates.
      qc.invalidateQueries({ queryKey: ['item-meta'] });
      // Receive-now creates auto-receipts → may consume materials → refresh
      // every page that surfaces material-issue state so we don't show stale.
      qc.invalidateQueries({ queryKey: ['material-issues'] });
      qc.invalidateQueries({ queryKey: ['material-issue'] });
      qc.invalidateQueries({ queryKey: ['vendor-holdings'] });
      qc.invalidateQueries({ queryKey: ['stock'] });
      qc.invalidateQueries({ queryKey: ['variants'] });
      submitting.current = false;
      onSaved(res.id);
    },
    onError: (e) => {
      submitting.current = false;
      toast.error(e instanceof Error && !(e as any).response ? e.message : getApiError(e).message);
    },
  });

  return (
    <Dialog open={open} onClose={onClose} size="xl"
      title="New Production Batch"
      description="Add designs by quantity — vendor, weight & cost auto-fetch from the picked initial process. Forward to the next process from the batch later."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending && <Spinner />} Create &amp; Issue Batch
          </Button>
        </>
      }>
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Batch Number"><Input readOnly disabled value={batchNumber} className="bg-muted font-semibold" /></Field>
          <Field label="Batch Date"><Input type="date" value={batchDate} onChange={(e) => setBatchDate(e.target.value)} /></Field>
          <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>

        <div>
          <SectionTitle>Designs for Production</SectionTitle>
          <div className="space-y-2">
            {rows.map((r, idx) => (
              <CastingRow key={idx} row={r} castingProcessId={casting?.id ?? 0}
                processVendors={processVendors} allVendors={metaQ.data?.allVendors ?? []}
                items={itemsQ.data ?? []}
                chosenItemIds={chosenItemIds.filter((id) => id !== r.itemId)}
                // Sibling rows for the duplicate-design check (everything
                // except THIS row). The dialog inside the row reads from
                // here to compose its "already on row N with qty Y" copy.
                otherRows={rows
                  .map((rr, i) => ({ itemId: rr.itemId, quantity: rr.quantity, _i: i }))
                  .filter((rr) => rr._i !== idx)}
                meta={metaQ.data ?? ({ processes: [], allVendors: [], designers: [], services: [], variants: [], sampleStatuses: [] } as unknown as ItemMeta)}
                onChange={(patch) => setRow(idx, patch)}
                onRemove={() => setRows((rs) => rs.filter((_, i) => i !== idx))}
                // Merge: bump the existing matching row's qty by `addQty`
                // and remove THIS row in the same setRows pass to avoid
                // a transient zero-row state.
                onMergeInto={(existingItemId, addQty) => {
                  setRows((rs) => rs
                    .map((rr) => rr.itemId === existingItemId
                      ? { ...rr, quantity: String((Number(rr.quantity) || 0) + addQty) }
                      : rr)
                    .filter((_, i) => i !== idx));
                }} />
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setRows((rs) => [...rs, emptyRow()])}>
            <Plus className="size-4" /> Add Design
          </Button>
          {(itemsQ.data ?? []).length === 0 && (
            <p className="mt-2 text-sm text-warning">No Production-Ready designs yet. Mark designs as Production Ready first.</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
