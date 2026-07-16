'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Badge } from '@/components/ui/badge';
import { Field, SectionTitle } from '@/components/shared/field';
import { Spinner } from '@/components/ui/spinner';
import { ReportMissingPartsDialog } from '@/components/shared/report-missing-parts-dialog';
import { RecastPopup } from '@/components/shared/recast-popup';
import { AlertTriangle, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

// Processes that receive per-variant — Plating CREATES the variants, every
// stage after that WEIGHS them individually. Each piece keeps its identity
// (TVM-001(1), (2)…) and its own birth weight + per-stage stops so the final
// sale price can use that exact piece's grams.
const VARIANT_RECEIVE_PROCESSES = ['PLATING', 'MEENA', 'FITTING_MALA', 'STICKING', 'PACKING'] as const;
const isVariantReceive = (code?: string | null) =>
  !!code && (VARIANT_RECEIVE_PROCESSES as readonly string[]).includes(code);

interface RowInput {
  receivedQty: string;
  receivedWeight: string;
  remarks: string;
  // QC breakdown — defaults: acceptedQty = receivedQty, others 0.
  acceptedQty: string;
  repairQty: string;
  rejectedQty: string;
  repairReason: string;
  rejectReason: string;
  // Required when rejectedQty > 0; '' means "pick one".
  rejectPaymentMode: '' | 'NO_PAY' | 'ADJUSTED' | 'FULL_PAY';
  rejectAdjustment: string;
  // Rate actually charged for this row. Pre-filled from the stage's
  // issue-slip rate so the common case (rate unchanged) needs zero
  // input. When the vendor's rate has shifted, operator types the
  // new value here — the backend persists it on the receipt AND
  // syncs the new rate to Item Master so the next batch defaults
  // to it. Empty string = use stage rate (no override).
  costPerKg: string;
  // Operator-reported metal delta for this row (grams). SIGNED — negative
  // means the process GAINED weight (sand blast picks up grit). Auto-fills
  // with planned − received on first edit; operator overrides as needed.
  // On save the backend posts the net into the LOSS-SILVER variant.
  lossWeight: string;
  // True when operator manually typed the loss field — stops auto-recompute
  // from clobbering their value when they tweak Recv Wt or Runners next.
  lossManual?: boolean;
  // Silver runners cut from the design at Filing / Polish (grams). On
  // save the backend posts this into the RUNNERS-SILVER recovery pool.
  // SINGLE input — includes the melted-ball weight from in-house dust.
  runnersWeight: string;
  // Pieces that physically didn't come back at all — auto-creates a
  // MissingPart record per piece on save, blocking the design's downstream
  // forwards until recast (or explicit write-off).
  lostQty?: string;
  lostReason?: string;
  // Pieces the vendor returned AS-IS (untouched — no work done). Flow
  // back to the batch item's pending pool for re-issue tomorrow, possibly
  // to a different vendor. NOT counted as received; overshoot guard
  // treats (recv + returnedAsIs) as physically returned.
  returnedAsIsQty?: string;
  // Vendor's CLAIMED sent weight for this design — what they SAY they sent
  // out of the karkhana. Compared against receivedWeight to compute the
  // per-vendor drift (over/under) surfaced in the purchase-bill reconciler.
  // Not printed on the vendor slip — internal cross-check only.
  claimedSentWeight?: string;
  // Die number the karigar stamped on this design at the Die Number stage.
  // Only surfaced when the receipt row's stage is on DIE_NUMBER; persisted
  // to Item.dieNumber (per-design master field) on save.
  dieNumber?: string;
  // Per-piece weights for PLATING rows — Plating bifurcates the group stage
  // into N individual ProductionVariants on receipt, each weighed in. Length
  // matches Recv Qty; rows render N inputs in the Recv Wt cell. Empty array
  // = no inputs typed yet; the backend falls back to evenly splitting Recv Wt
  // across pieces.
  perPieceWeights?: string[];
}
// Per-material-line input for the receive-time materials section.
//   - used: qty consumed in production. Auto-defaults to BOM × sticking pcs
//     received NOW (same formula the system used at issue time), editable
//     if the vendor used more (waste) or less.
//   - excessMode: what happens to the leftover (pending − used)?
//       'return' → vendor returned the excess (input qty, default = full).
//       'keep'   → vendor keeps it for future jobs (stays pending).
//   - returnQty: only used when excessMode = 'return'.
interface MatReturnRow {
  used: string;
  excessMode: 'return' | 'keep';
  returnQty: string;
  // Weight ledger — surfaced for weight-tracked variants (filing kadi / pan /
  // tachni / chaki etc.). Mirrors the qty inputs in grams.
  usedWeight: string;
  returnWeight: string;
  // Same model as the design rows above: loss = grams gone to dust, runners
  // = silver chips cut off the material and recovered into RUNNERS-SILVER.
  // lossManual=true when the operator overrode the auto-computed loss.
  runnersWeight: string;
  lossWeight: string;
  lossManual: boolean;
}
interface MatReturnInput { [lineId: number]: MatReturnRow }

export function ReceiveForm({
  open,
  onClose,
  initialBatchId,
  initialVendorId,
  // When set, every receipt row this form submits carries fromRepairOrderId.
  // The backend then marks that repair order RETURNED and chains the cycle
  // if the new receipt also has repair pcs flagged. Used by the /repairs
  // page's "Receive back" deep-link.
  repairOrderId,
  // EDIT MODE — when set, the form fetches the existing receipt, pre-fills
  // every row, and dispatches updateReceipt (PUT) on save instead of
  // createReceipt (POST). The receipt's id + receiptNumber are preserved
  // server-side. Backend guards forwarded-out + repair rows; both surface
  // as toasts here.
  editReceiptId,
}: {
  open: boolean;
  onClose: () => void;
  initialBatchId?: number | null;
  initialVendorId?: number | null;
  repairOrderId?: number | null;
  editReceiptId?: number | null;
}) {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  // Per-row "Report missing parts" dialog scope. Set when the operator
  // clicks the chip on a row; cleared on dialog close.
  const [missingCtx, setMissingCtx] = React.useState<{ stageId: number; itemId: number | null; designCode: string | null } | null>(null);
  const [batchId, setBatchId] = React.useState<number | ''>('');
  const [vendorId, setVendorId] = React.useState<number | ''>('');
  const [stageProcessId, setStageProcessId] = React.useState<number | ''>('');
  const [receiptDate, setReceiptDate] = React.useState(today);
  const [notes, setNotes] = React.useState('');
  // Silver runners returned this receipt — per-vendor total across every
  // design in the batch. Vendor weighs runners once on the scale, not
  // per design. Backend posts to RUNNERS-SILVER as IN stock.
  const [receiptRunnersWeight, setReceiptRunnersWeight] = React.useState('');
  // Silver LOSS reported for this receipt — per-vendor total for the
  // whole batch (not per design). Vendor states one loss number for the
  // visit; posts to LOSS-SILVER as an IN movement on save. Sums with any
  // per-row lossWeight already computed row-by-row.
  const [receiptLossWeight, setReceiptLossWeight] = React.useState('');
  // State key is a STRING rowKey, not the raw batchItemId. When a repair is
  // active on a stage that ALSO has normal pending pcs, we render that stage
  // as two rows (Normal + From REP-#) keyed `${id}:normal` and `${id}:repair`.
  // Stages without an active repair use plain `${id}`. This lets the user
  // QC-split the repair return independently from the fresh pcs and lets the
  // form send two separate receipt-item entries for the same batchItemId.
  const [inputs, setInputs] = React.useState<Record<string, RowInput>>({});
  // Stage filter (mobile-first) — narrows the receive table when many
  // stages are pending for one vendor / batch. Filters by item#, vendor
  // design ref, process and colour. Empty = show all.
  const [stageSearch, setStageSearch] = React.useState('');
  // For sticking stages: per-stage material return inputs. Keyed by batchItemId
  // (the sticking stage id), then by materialIssueLineId. Lets the user decide
  // per-material whether the vendor is returning extras or keeping them.
  const [matReturns, setMatReturns] = React.useState<Record<number, MatReturnInput>>({});
  // Items whose Casting weight is still flagged "temporary" — captured from
  // createReceipt's response.needsFinalWeight. When non-empty, we open the
  // FinalWeightDialog right after a successful save instead of closing the
  // receive form. Operator confirms the actual per-pc weight; the popup
  // calls /finalize-casting-weight per item which both overwrites the
  // master weight AND strips the marker from notes.
  const [finalWeightPrompt, setFinalWeightPrompt] = React.useState<
    Array<{ itemId: number; itemNumber: string | null; sampleDesignCode: string; currentWeight: number }>
  >([]);
  // Post-Packing details popup — populated from
  //   res.needsPackingDetails on a Packing receipt that auto-allocated
  // one or more item numbers. Each entry is a production variant that
  // needs its per-piece additional charge + Gross/Less/Net Wt captured.
  const [packingDetailsPrompt, setPackingDetailsPrompt] = React.useState<
    Array<{ id: number; variantCode: string; birthWeight: any; itemId: number; item: { itemNumber: string | null; itemName: string | null } }>
  >([]);
  // Recast popup — opens after a receipt that flagged any lost pieces. Asks
  // operator "recast same batch / new / later" for each new MissingPart row.
  const [recastOpen, setRecastOpen] = React.useState(false);
  const [recastRows, setRecastRows] = React.useState<any[]>([]);

  const batchesQ = useQuery({ queryKey: ['casting-batches-open'], queryFn: () => Api.casting.batches(), enabled: open });
  const batchQ = useQuery({
    queryKey: ['casting-batch', batchId],
    queryFn: () => Api.casting.batch(Number(batchId)),
    enabled: open && !!batchId,
  });
  const pendingQ = useQuery({
    // Edit mode: include editReceiptId in the query key + URL so the
    // backend adds the receipt's qty BACK to pending and includes
    // rows whose pending is now 0 because of this receipt. Without
    // this, the form can't render — or worse, drops items silently.
    queryKey: ['casting-pending', batchId, vendorId, editReceiptId ?? null],
    queryFn: () => Api.casting.pending(Number(batchId), Number(vendorId), editReceiptId ?? undefined),
    enabled: open && !!batchId && !!vendorId,
  });
  // Open repairs for the chosen batch + vendor — surfaced as a strip ABOVE
  // the items table when the form is opened in NORMAL mode (no specific
  // repairOrderId in the URL). Each row has a "Receive this repair" button
  // that flips the form into repair-receive mode for that order — same
  // flow as clicking "Receive back" on /repairs. Hidden in repair-receive
  // mode (no point — the user is already focused on one repair).
  const openRepairsQ = useQuery({
    queryKey: ['repairs', { batchId, vendorId, status: 'OPEN' }],
    queryFn: () =>
      Api.casting.listRepairs({ batchId: Number(batchId), vendorId: Number(vendorId), status: 'OPEN' }),
    // Fetch even when a URL deep-link is active so the chips strip can
    // surface the OTHER open repairs the user may also want to receive in
    // the same trip.
    enabled: open && !!batchId && !!vendorId,
  });
  // Stable reference — `?? []` would mint a new array every render until
  // data lands, which would invalidate downstream useMemo/useEffect deps
  // and risk the same "Maximum update depth" loop we hit before.
  const openRepairs = React.useMemo(() => openRepairsQ.data ?? [], [openRepairsQ.data]);
  // Multi-select repair state — user can include any subset of open repairs
  // in this single receipt. URL deep-link `repairOrderId` seeds the set so
  // "Receive back" from /repairs lands here with that repair already ticked.
  // Each ticked repair contributes its own "From REP-#" row alongside the
  // stage's Normal row; on submit, each row stamps its own repair.id as
  // fromRepairOrderId so all selected repairs close in one transaction.
  const [selectedRepairIds, setSelectedRepairIds] = React.useState<Set<number>>(new Set());
  // Reset on close + seed from URL prop on open.
  React.useEffect(() => {
    if (!open) { setSelectedRepairIds(new Set()); return; }
    setSelectedRepairIds(repairOrderId ? new Set([repairOrderId]) : new Set());
  }, [open, repairOrderId]);
  const toggleRepair = (id: number) =>
    setSelectedRepairIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  React.useEffect(() => {
    if (open) {
      // Pre-fill vendor too when caller knows it (e.g. /repairs → Receive
      // back deep-link knows the repair's vendor). Saves the user a click.
      setBatchId(initialBatchId ?? ''); setVendorId(initialVendorId ?? ''); setStageProcessId(''); setReceiptDate(today); setNotes(''); setInputs({}); setMatReturns({});
    }
  }, [open, initialBatchId, initialVendorId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Edit-mode load — fetches the receipt and writes its data into the
  // form state. Runs after the form opens AND only when editReceiptId is
  // set, so the create flow is unaffected. Pre-fills:
  //   • header: batch / vendor / date / notes
  //   • per-row: receivedQty / receivedWeight / acceptedQty / repairQty /
  //     rejectedQty / rejectPaymentMode / rejectAdjustment / costPerKg /
  //     remarks
  // Once loaded, the operator tweaks any field; submit dispatches
  // updateReceipt with the same payload shape createReceipt expects.
  const editReceiptQ = useQuery({
    queryKey: ['casting-receipt', editReceiptId],
    queryFn: () => Api.casting.receipt(Number(editReceiptId)),
    enabled: open && !!editReceiptId,
  });
  // Edit-mode header seed — runs as soon as the receipt payload lands.
  // Per-row input seeding is in a SEPARATE effect below that waits for
  // displayRows to build (so the rowKey matches the row the user sees,
  // and so the blank-init effect's wipe — gated on editReceiptId — can
  // never race the per-row seed).
  React.useEffect(() => {
    if (!open || !editReceiptId) return;
    const r = editReceiptQ.data;
    if (!r) return;
    setBatchId(r.batchId);
    setVendorId(r.vendorId);
    // Restore the process too — without this the Process selector reads
    // "—" and the items table won't render (it's gated on stageProcessId
    // matching the receipt's stages). Backend now surfaces processId on
    // the receipt response.
    if (r.processId != null) setStageProcessId(r.processId);
    setReceiptDate(typeof r.receiptDate === 'string' ? r.receiptDate.slice(0, 10) : new Date(r.receiptDate).toISOString().slice(0, 10));
    setNotes(r.notes ?? '');
  }, [open, editReceiptId, editReceiptQ.data]);

  // Fallback fetch for a selected repair that isn't (yet) in the openRepairs
  // list — happens when the URL deep-link arrives before the chips load, or
  // if the deep-linked repair has flipped to RETURNED in the meantime.
  // Covers a single id; multiple-missing is a rare edge that we accept.
  const missingRepairId = React.useMemo(() => {
    const ids = Array.from(selectedRepairIds);
    for (const id of ids) {
      if (!openRepairs.find((r: any) => r.id === id)) return id;
    }
    return null;
  }, [selectedRepairIds, openRepairs]);
  const repairFallbackQ = useQuery({
    queryKey: ['repair', missingRepairId],
    queryFn: () => Api.casting.getRepair(missingRepairId!),
    enabled: open && !!missingRepairId,
  });
  // Resolve the selected repair IDs into their full Repair objects (id,
  // stageId, processId, qty, cycle, reason, vendorCode, vendorName).
  // Sourced primarily from openRepairs; falls back to the singular fetch.
  const selectedRepairs = React.useMemo<any[]>(() => {
    const ids = Array.from(selectedRepairIds);
    return ids
      .map((id) => {
        const fromList = openRepairs.find((r: any) => r.id === id);
        if (fromList) return fromList;
        if (repairFallbackQ.data?.id === id) return repairFallbackQ.data;
        return null;
      })
      .filter(Boolean);
  }, [selectedRepairIds, openRepairs, repairFallbackQ.data]);

  // Distinct processes among this vendor's pending stages — a receipt is per process.
  // Stable ref (see openRepairs comment above) to keep downstream memos sane.
  const pendingItems = React.useMemo(() => pendingQ.data?.items ?? [], [pendingQ.data?.items]);
  const processesInList = React.useMemo(() => {
    const m = new Map<number, string>();
    for (const it of pendingItems) if (it.processId) m.set(it.processId, it.processName);
    return Array.from(m.entries()).map(([id, name]) => ({ id, name }));
  }, [pendingItems]);

  // Default to a single process so each receipt covers ONE process.
  // Priority order:
  //   1. Selected repair(s): lock in the first selected repair's processId.
  //      (All selected repairs SHOULD share the same process since one
  //      receipt = one process — backend will reject the mix anyway.)
  //   2. Normal receive: the first process found in the vendor's pending
  //      stages.
  const firstSelectedRepair = selectedRepairs[0];
  React.useEffect(() => {
    if (!open || !batchId || !vendorId) return;
    if (firstSelectedRepair?.processId) {
      if (stageProcessId !== firstSelectedRepair.processId) setStageProcessId(firstSelectedRepair.processId);
      return;
    }
    if (processesInList.length && !processesInList.some((p) => p.id === stageProcessId)) {
      setStageProcessId(processesInList[0].id);
    }
  }, [open, batchId, vendorId, firstSelectedRepair, processesInList]); // eslint-disable-line react-hooks/exhaustive-deps

  // Memoize so .filter() doesn't return a new array reference each render —
  // otherwise displayRows' useMemo invalidates every render, the init
  // useEffect fires setInputs every render, and React throws "Maximum
  // update depth exceeded".
  const visibleItems = React.useMemo(
    () => (stageProcessId ? pendingItems.filter((it: any) => it.processId === stageProcessId) : pendingItems),
    [pendingItems, stageProcessId],
  );

  // Expand visibleItems into the actual rows we render. For each stage:
  //   • No selected repairs touch this stage → one "only" row (normal
  //     pending).
  //   • One or more selected repairs target this stage → a Normal row plus
  //     ONE Repair row per selected repair, each independently QC-split.
  //     The Normal row tracks fresh pending pcs (no fromRepairOrderId); each
  //     Repair row carries its own repair.id so the backend closes that
  //     specific RepairOrder on submit.
  // This is what makes the user's flows work:
  //   • Vendor brings back REP-2 + REP-7 + 41 normal → 1 Normal + 2 Repair
  //     rows, one submit closes both repairs.
  //   • Vendor brings ONLY REP-2 (no normal) → leave Normal row at 0, fill
  //     the REP-2 row, submit.
  //   • Re-repair of 2 from REP-2 + 1 fresh defect from normal → each row
  //     gets its own QC split; backend spawns the correct RepairOrders
  //     (cycle 3 parent=REP-2 on the Repair row, fresh cycle 1 on Normal).
  type DisplayRow = {
    key: string;             // rowKey for `inputs` state
    stage: any;              // the underlying batch-item (it)
    kind: 'normal' | 'repair' | 'only';
    repair?: any;            // only set when kind === 'repair' — drives fromRepairOrderId + badge label
    pendingShown: number;    // pcs we expect on THIS row
    defaultQty: number;      // pre-fill for Recv Qty
  };
  const displayRows: DisplayRow[] = React.useMemo(() => {
    const out: DisplayRow[] = [];
    for (const it of visibleItems) {
      const stageRepairs = selectedRepairs.filter((r: any) => r.stageId === it.id);
      const normalPending = Math.max(0, it.pendingQty);
      if (stageRepairs.length > 0) {
        // Only emit the Normal row when there's actually normal pending
        // pcs the vendor still owes us. If everything's been settled and
        // ONLY the repair lot is outstanding, the Normal row with "Pending
        // 0 · Recv Qty 0" is dead weight — drop it so the user sees just
        // the active repair row(s).
        if (normalPending > 0) {
          out.push({
            key: `${it.id}:normal`,
            stage: it,
            kind: 'normal',
            pendingShown: normalPending,
            defaultQty: normalPending,
          });
        }
        for (const r of stageRepairs) {
          out.push({
            key: `${it.id}:repair:${r.id}`,
            stage: it,
            kind: 'repair',
            repair: r,
            pendingShown: r.qty,
            defaultQty: r.qty,
          });
        }
      } else {
        out.push({
          key: String(it.id),
          stage: it,
          kind: 'only',
          pendingShown: normalPending,
          defaultQty: normalPending,
        });
      }
    }
    return out;
  }, [visibleItems, selectedRepairs]);

  // Recv Qty starts BLANK on every row — operator must type the actual
  // received qty per item. Used to pre-fill with the pending qty as a
  // "vendor returned all his bag, one click" convenience, but that bit
  // us: when vendor returned only a subset (qty 0 on some items), the
  // operator easily missed zeroing those rows out and the receipt
  // recorded the defaults as received — phantom receipts. Now the field
  // shows the pending as PLACEHOLDER only; operator types real numbers.
  // A "Fill all with pending" button below restores the one-click
  // workflow when the vendor genuinely returned everything.
  React.useEffect(() => {
    // EDIT MODE: skip the blank-init wipe — the per-row seed effect
    // below populates from the receipt instead. Without this guard, this
    // effect would race the edit seed (both depend on displayRows) and
    // the operator would see an empty form.
    if (editReceiptId) return;
    if (!pendingQ.data?.items) return;
    const init: Record<string, RowInput> = {};
    for (const row of displayRows) {
      const it = row.stage;
      init[row.key] = {
        receivedQty: '',
        receivedWeight: '',
        remarks: '',
        acceptedQty: '',
        repairQty: '0',
        rejectedQty: '0',
        repairReason: '',
        rejectReason: '',
        rejectPaymentMode: '',
        rejectAdjustment: '',
        // Pre-fill from the stage's issue-slip rate (per-kg for KG
        // processes, per-pc for piece processes — both stored on the
        // same costPerKg column). Operator only touches this when the
        // vendor's rate changed between issue and receive.
        costPerKg: it.costPerKg != null ? String(it.costPerKg) : '',
        lossWeight: '',
        runnersWeight: '',
        lostQty: '',
        lostReason: '',
        claimedSentWeight: '',
        // Pre-fill die number from the Item Master when it's already been
        // stamped (recurring designs) so the receive slip shows what's on
        // file — operator confirms or overwrites for a re-cut.
        dieNumber: it.dieNumber ?? '',
      };
    }
    setInputs(init);
  }, [pendingQ.data, displayRows, editReceiptId]);

  // Edit-mode per-row seed — runs once displayRows has built so the
  // rowKey we write to is the same one the table renders against.
  // Walks the receipt's items and matches by batchItemId. Repair-bearing
  // receipts are blocked from editing by backend Guard 2, so rowKey is
  // always plain `String(it.id)` for editable receipts.
  React.useEffect(() => {
    if (!open || !editReceiptId) return;
    const r = editReceiptQ.data;
    if (!r || !r.items) return;
    if (!displayRows.length) return;
    const byBatchItemId = new Map<number, any>();
    for (const ri of r.items as any[]) byBatchItemId.set(ri.batchItemId, ri);
    const init: Record<string, RowInput> = {};
    for (const row of displayRows) {
      const ri = byBatchItemId.get(row.stage.id);
      if (!ri) continue;
      init[row.key] = {
        receivedQty: String(ri.receivedQty ?? ''),
        receivedWeight: ri.receivedWeight != null ? String(ri.receivedWeight) : '',
        remarks: ri.remarks ?? '',
        acceptedQty: String(ri.acceptedQty ?? ri.receivedQty ?? ''),
        repairQty: String(ri.repairQty ?? 0),
        rejectedQty: String(ri.rejectedQty ?? 0),
        repairReason: '',
        rejectReason: ri.rejectReason ?? '',
        rejectPaymentMode: (ri.rejectPaymentMode ?? '') as RowInput['rejectPaymentMode'],
        rejectAdjustment: ri.rejectAdjustment != null ? String(ri.rejectAdjustment) : '',
        costPerKg: ri.costPerKg != null ? String(ri.costPerKg) : '',
        lossWeight: ri.lossWeight != null ? String(ri.lossWeight) : '',
        runnersWeight: ri.runnersWeight != null ? String(ri.runnersWeight) : '',
        claimedSentWeight: ri.claimedSentWeight != null ? String(ri.claimedSentWeight) : '',
        // Edit mode reads the die number off the row's item (item.dieNumber
        // is the persisted value, one field per design master row).
        dieNumber: (row.stage as any).dieNumber ?? '',
      };
    }
    setInputs(init);
  }, [open, editReceiptId, editReceiptQ.data, displayRows]);


  const setInput = (key: string, patch: Partial<RowInput>) =>
    setInputs((s) => ({ ...s, [key]: { ...s[key], ...patch } }));

  /**
   * Recv Qty represents the NET pcs going to inventory (the accepted count).
   * Repair and Reject are DEDUCTIONS from the gross the vendor handed back.
   *
   * Mental model: "Vendor brought 1000 pcs. Of those, 2 need to go back for
   * repair and 3 are rejected. So 995 are received into inventory."
   *
   * Rules:
   *   • field='recv'   → User sets Recv directly. Accept mirrors it. The
   *                      gross from vendor (sent to backend) becomes
   *                      Recv+Rep+Rej.
   *   • field='repair' → Recv decreases by Δ (newRep − oldRep). Preserves
   *                      the gross. Accept = Recv. Clamps at 0.
   *   • field='reject' → Same as repair.
   *   • field='accept' → Treated as 'recv' (Accept and Recv are the same
   *                      number in this model).
   * Recv Wt is re-derived from per-pc weight × Recv (net weight). User can
   * override after the fact.
   */
  const syncRow = (
    key: string,
    perPcWeight: number,
    field: 'recv' | 'accept' | 'repair' | 'reject',
    rawValue: string,
  ) => {
    setInputs((s) => {
      const cur = s[key] ?? ({} as RowInput);
      const num = (v: string | undefined) => Math.max(0, Number(v ?? 0) || 0);
      const oldRecv = num(cur.receivedQty);
      const oldWt = num(cur.receivedWeight);
      let recv = oldRecv;
      let rep = num(cur.repairQty);
      let rej = num(cur.rejectedQty);
      const v = Math.max(0, Number(rawValue) || 0);
      if (field === 'recv' || field === 'accept') {
        recv = v;
      } else if (field === 'repair') {
        const delta = v - rep;
        recv = Math.max(0, recv - delta);
        rep = v;
      } else {
        const delta = v - rej;
        recv = Math.max(0, recv - delta);
        rej = v;
      }
      // Recv Wt handling — two paths:
      //   (a) Operator already typed an ACTUAL measured weight (oldWt > 0
      //       AND oldRecv > 0). Preserve their measurement by scaling
      //       proportionally to the new recv qty. Critical for the
      //       reject/repair flow: marking 2 of 230 as reject must NOT
      //       reset 12,390 g (their measured weight at 53.87 g/pc) back
      //       to 11,400 g (planned 50 g/pc × 228). Math:
      //       newWt = oldWt × newRecv / oldRecv → 12,390 × 228/230 ≈ 12,283 g.
      //   (b) Operator hasn't typed a weight yet, OR they just zeroed
      //       recv. Fall back to planned per-pc × new recv as the
      //       starting estimate. Operator can override afterwards.
      let wt: number;
      if (oldWt > 0 && oldRecv > 0) {
        wt = recv > 0 ? Math.round((oldWt * recv / oldRecv) * 1000) / 1000 : 0;
      } else {
        wt = perPcWeight > 0 ? Math.round(perPcWeight * recv * 1000) / 1000 : 0;
      }
      // Resize the per-piece weight array to match new recv qty. Preserve
      // operator-typed values where possible; pad/truncate as needed.
      const oldArr: string[] = Array.isArray(cur.perPieceWeights) ? cur.perPieceWeights : [];
      const newArr: string[] = Array.from({ length: recv }, (_, i) => oldArr[i] ?? '');
      return {
        ...s,
        [key]: {
          ...cur,
          receivedQty: String(recv),
          acceptedQty: String(recv),  // Accept always mirrors Recv in this model
          repairQty: String(rep),
          rejectedQty: String(rej),
          receivedWeight: wt > 0 ? String(wt) : '',
          perPieceWeights: newArr,
        },
      };
    });
  };

  // Guard against double-clicks racing the React re-render — once submitted, the
  // ref locks until success/error. Without this, an impatient user clicking Save
  // twice in the same tick can fire two parallel createReceipt calls (the button
  // hasn't visually flipped to disabled yet on the second click).
  const submittingRef = React.useRef(false);
  const create = useMutation({
    mutationFn: async () => {
      // One receipt-item entry PER displayRow. A repair-target stage will
      // produce two entries with the same batchItemId: one without
      // fromRepairOrderId (the fresh normal pcs) and one WITH it (the
      // repair return). The schema has no unique constraint on
      // (receiptId, batchItemId) so this is safe.
      const items = displayRows
        .map((row) => {
          const r = inputs[row.key] ?? {} as any;
          // Recv Qty in the form = NET (accepted pcs). Repair/Reject are
          // deductions from the gross vendor handed back. Backend's
          // invariant is acceptedQty + repairQty + rejectedQty === receivedQty,
          // so we reconstruct the GROSS as receivedQty here. acceptedQty
          // equals the displayed Recv (the inventory addition).
          const netRecv = Number(r.receivedQty || 0);
          const rep = Number(r.repairQty || 0);
          const rej = Number(r.rejectedQty || 0);
          const grossRecv = netRecv + rep + rej;
          // Scale weight proportionally to gross. User's typed Recv Wt is
          // treated as net weight (matches what they see); we expand it to
          // gross weight on submit so per-pc weight stays consistent.
          const netWt = Number(r.receivedWeight || 0);
          const grossWt = netRecv > 0 && grossRecv > netRecv
            ? Math.round((netWt * grossRecv / netRecv) * 1000) / 1000
            : netWt;
          const touched = rep > 0 || rej > 0;
          // Repair row → stamps THIS row's own repair.id (NOT a shared
          // singular id). Lets one receipt close several repairs at once
          // while a sibling Normal row stays fresh-pending. If a Repair
          // row's Recv Qty stays 0, the row is dropped by the filter below
          // and that repair stays OPEN — exactly what we want when the
          // vendor didn't bring it back this trip.
          const repairId = row.kind === 'repair' ? row.repair?.id : null;
          // Receipt rate — only send when it differs from the stage's
          // issue rate. Sending the unchanged stage rate would still
          // work (backend dedupes against equality) but skipping it
          // keeps the payload minimal and the receipt row's costPerKg
          // column null for unchanged rates (which the reader correctly
          // falls back to stage rate for).
          const typedRate = r.costPerKg != null && r.costPerKg !== '' ? Number(r.costPerKg) : null;
          const stageRate = row.stage.costPerKg != null ? Number(row.stage.costPerKg) : null;
          const rateChanged = typedRate != null && typedRate !== stageRate;
          return {
            batchItemId: row.stage.id,
            receivedQty: grossRecv,
            receivedWeight: grossWt,
            remarks: r.remarks || undefined,
            ...(touched ? {
              acceptedQty: netRecv,
              repairQty: rep,
              rejectedQty: rej,
              repairReason: r.repairReason || undefined,
              rejectReason: r.rejectReason || undefined,
              rejectPaymentMode: r.rejectPaymentMode || undefined,
              rejectAdjustment: r.rejectAdjustment ? Number(r.rejectAdjustment) : undefined,
            } : {}),
            ...(repairId ? { fromRepairOrderId: repairId } : {}),
            ...(rateChanged ? { costPerKg: typedRate } : {}),
            // Loss = ordered − received − runners. Operator-typed value
            // wins when set; otherwise we auto-compute. Casting rows skip
            // (sprue handled in its own flow). Sand-blast GAINS (recv >
            // given) are display-only and never sent to the backend so
            // they don't pollute LOSS-SILVER.
            ...((() => {
              const procCode = (row.stage as any).processCode;
              if (procCode === 'CASTING') return {};
              const ordWt = Number(row.stage.totalWeight ?? 0);
              if (ordWt <= 0 || grossWt <= 0) return {};
              const runners = Number(r.runnersWeight ?? 0);
              const auto = Math.round((ordWt - grossWt - runners) * 1000) / 1000;
              const typed = r.lossWeight != null && r.lossWeight !== ''
                ? Number(r.lossWeight)
                : null;
              const final = typed != null ? typed : auto;
              // Gain (recv exceeds given) shows in UI but doesn't post.
              if (final <= 0) return {};
              return { lossWeight: final };
            })()),
            ...(Number(r.runnersWeight ?? 0) > 0 ? { runnersWeight: Number(r.runnersWeight) } : {}),
            ...(Number((r as any).lostQty ?? 0) > 0 ? {
              lostQty: Math.trunc(Number((r as any).lostQty)),
              lostReason: (r as any).lostReason || undefined,
            } : {}),
            // Return-as-is — pieces the vendor brought back untouched. Not
            // counted as received; overshoot guard treats (recv + returned)
            // as physically returned.
            ...(Number((r as any).returnedAsIsQty ?? 0) > 0 ? {
              returnedAsIsQty: Math.trunc(Number((r as any).returnedAsIsQty)),
            } : {}),
            // Vendor's CLAIMED sent weight — surfaced in Casting receipts
            // for the drift accumulator. Only sent when the operator
            // actually typed a value (blank = don't record any claim).
            ...((r as any).claimedSentWeight != null && (r as any).claimedSentWeight !== ''
              ? { claimedSentWeight: Number((r as any).claimedSentWeight) }
              : {}),
            // Die number captured ONLY at DIE_NUMBER stages — sent up so
            // the backend can write Item.dieNumber (per-design master).
            ...((row.stage as any).processCode === 'DIE_NUMBER'
                && (r as any).dieNumber != null
                && String((r as any).dieNumber).trim() !== ''
              ? { dieNumber: String((r as any).dieNumber).trim() }
              : {}),
            // PLATING bifurcation — send per-piece weights when this row is
            // a PLATING receipt with the array filled in. Length must equal
            // accepted qty (= receivedQty since accepted mirrors received in
            // this model); backend evenly-splits Recv Wt as a fallback when
            // the array is missing or wrong length.
            ...(() => {
              const procCode = (row.stage as any).processCode;
              if (!isVariantReceive(procCode)) return {};
              const arr: string[] = Array.isArray((r as any).perPieceWeights) ? (r as any).perPieceWeights : [];
              const cleaned = arr
                .slice(0, netRecv)
                .map((v) => Number(v || 0));
              if (cleaned.length !== netRecv || cleaned.some((n) => !Number.isFinite(n))) return {};
              return { perPieceWeights: cleaned };
            })(),
          };
        })
        .filter((r: any) => r.receivedQty !== 0 || r.receivedWeight !== 0 || (r.returnedAsIsQty ?? 0) !== 0);
      if (!items.length) throw new Error('Enter received quantity for at least one item.');
      // 1. Save the receipt — UPDATE in edit mode (preserves receiptNumber +
      //    the receipt's identity in the books), else CREATE a new one.
      const payload = {
        batchId: Number(batchId), vendorId: Number(vendorId),
        receiptDate, notes: notes || undefined, items,
        // Receipt-level runners (per-vendor total) — see #7. Legacy per-row
        // runnersWeight still respected for back-compat.
        ...(Number(receiptRunnersWeight || 0) > 0
          ? { runnersWeight: Number(receiptRunnersWeight) }
          : {}),
        // Receipt-level LOSS (per-vendor visit total, not per design).
        // Sums into the LOSS-SILVER movement alongside per-row losses.
        ...(Number(receiptLossWeight || 0) > 0
          ? { lossWeight: Number(receiptLossWeight) }
          : {}),
      };
      const receipt = editReceiptId
        ? await Api.casting.updateReceipt(Number(editReceiptId), payload)
        : await Api.casting.createReceipt(payload);
      // 2. For each sticking stage being received, also record material
      //    consumption + return. "used" → consumedQty (written off, no stock
      //    movement). Excess in 'return' mode → returnedQty (stock IN).
      //    Excess in 'keep' mode → nothing recorded (stays pending).
      type RetLine = {
        lineId: number;
        returnedQty: number;
        consumedQty?: number;
        returnedWeight?: number;
        consumedWeight?: number;
        runnersWeight?: number;
        lostWeight?: number;
      };
      const returnsByIssue: Record<number, RetLine[]> = {};
      for (const it of visibleItems) {
        const issue = it.materialIssue;
        if (!issue) continue;
        const rowReturns: MatReturnInput = matReturns[it.id] ?? {};
        for (const line of issue.lines) {
          const cfg = rowReturns[line.lineId];
          if (!cfg) continue;
          const used = Math.max(0, Math.trunc(Number(cfg.used || 0)));
          const excess = Math.max(0, line.pendingQty - used);
          const ret = cfg.excessMode === 'return'
            ? Math.min(excess, Math.max(0, Math.trunc(Number(cfg.returnQty || 0))))
            : 0;
          const usedW = Math.max(0, Number(cfg.usedWeight || 0));
          const retW  = cfg.excessMode === 'return'
            ? Math.max(0, Number(cfg.returnWeight || 0))
            : 0;
          const runW = Math.max(0, Number(cfg.runnersWeight || 0));
          const pendingW = Number(line.pendingWeight ?? 0);
          // Loss = pending − used − returned − runners (operator override wins).
          const autoLoss = pendingW > 0
            ? Math.round((pendingW - usedW - retW - runW) * 1000) / 1000
            : 0;
          const lossW = cfg.lossManual
            ? Number(cfg.lossWeight || 0)
            : autoLoss;
          if (used === 0 && ret === 0 && usedW === 0 && retW === 0 && runW === 0 && lossW === 0) continue;
          if (used + ret > line.pendingQty) {
            throw new Error(`Used + returned exceeds pending for ${line.variantName} in voucher ${issue.voucherNumber}.`);
          }
          const accountedW = usedW + retW + runW + Math.max(0, lossW);
          if (pendingW > 0 && accountedW > pendingW + 0.0005) {
            throw new Error(`Weights total ${accountedW.toFixed(3)} g but only ${pendingW} g pending for ${line.variantName}.`);
          }
          // Weight-tracked materials (filing kadi/pan/tachni/chaki) → if any
          // qty came back, weight must be filled in too.
          if (line.trackByWeight && (used > 0 || ret > 0) && accountedW === 0) {
            throw new Error(`${line.variantName}: enter weight (g) for used / runners / loss.`);
          }
          (returnsByIssue[issue.issueId] ??= []).push({
            lineId: line.lineId,
            returnedQty: ret,
            consumedQty: used,
            returnedWeight: retW > 0 ? Math.round(retW * 1000) / 1000 : undefined,
            consumedWeight: usedW > 0 ? Math.round(usedW * 1000) / 1000 : undefined,
            runnersWeight: runW > 0 ? Math.round(runW * 1000) / 1000 : undefined,
            lostWeight: lossW !== 0 ? Math.round(lossW * 1000) / 1000 : undefined,
          });
        }
      }
      let matReturnTotal = 0;
      let matConsumedTotal = 0;
      for (const [issueId, lines] of Object.entries(returnsByIssue)) {
        await Api.materialIssues.recordReturn(Number(issueId), { lines });
        matReturnTotal += lines.reduce((s, l) => s + l.returnedQty, 0);
        matConsumedTotal += lines.reduce((s, l) => s + (l.consumedQty ?? 0), 0);
      }
      return { ...receipt, matReturnTotal, matConsumedTotal };
    },
    onSuccess: async (res: any) => {
      const parts: string[] = [];
      if (res.matReturnTotal > 0) parts.push(`${res.matReturnTotal} pcs returned to stock`);
      if (res.matConsumedTotal > 0) parts.push(`${res.matConsumedTotal} pcs written off as used`);
      toast.success(
        parts.length
          ? `Receipt ${res.receiptNumber} recorded — ${parts.join(', ')}.`
          : `Receipt ${res.receiptNumber} recorded.`,
      );
      // Auto-balance toasts — when colour-split shorts on the same
      // design were covered by sibling excesses (sum across the split
      // equals sum ordered), the backend auto-closed the short stages
      // with shortQty=0. Surface one info toast per closed stage so the
      // operator sees what just happened — no vendor debt was recorded
      // because the total returned matched the total ordered.
      const balanced = (res?.autoBalanced ?? []) as Array<{ stageId: number; itemNumber: string | null; color: string | null; shortBy: number }>;
      for (const b of balanced) {
        toast.info(
          `Auto-balanced: #${b.itemNumber ?? '?'}${b.color ? ` · ${b.color}` : ''} was short ${b.shortBy} pc${b.shortBy === 1 ? '' : 's'} — covered by excess on a sibling colour. Stage closed; no vendor debt.`,
          { duration: 8000 },
        );
      }
      // Receipt rate-override toasts — when the operator typed a new
      // rate on any receive row, the backend updated the Item Master
      // rate too (so the next batch defaults to it). Surface one toast
      // per non-silent change with Undo, matching the forward / edit
      // flows' UX.
      for (const u of ((res?.rateUpdates ?? []) as any[])) {
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
              } catch (err) {
                toast.error(getApiError(err).message);
              }
            },
          },
        });
      }
      // Invalidate EVERY query that depends on the receipt state — including the
      // pending list keyed by batch+vendor. Without this, reopening the dialog
      // shows stale "still pending" items and the user double-saves.
      //
      // material-issues + vendor-holdings + material-issue MUST refresh because
      // "Used" is gated on sticking pieces received: every receipt may bump up
      // the consumed materials for the linked sticking voucher.
      qc.invalidateQueries({ queryKey: ['casting-receipts'] });
      qc.invalidateQueries({ queryKey: ['casting-batches'] });
      qc.invalidateQueries({ queryKey: ['casting-batch'] });
      qc.invalidateQueries({ queryKey: ['casting-pending'] });
      qc.invalidateQueries({ queryKey: ['produced'] });
      qc.invalidateQueries({ queryKey: ['material-issues'] });
      qc.invalidateQueries({ queryKey: ['material-issue'] });
      qc.invalidateQueries({ queryKey: ['vendor-holdings'] });
      qc.invalidateQueries({ queryKey: ['stock'] });
      qc.invalidateQueries({ queryKey: ['stock-movements'] });
      qc.invalidateQueries({ queryKey: ['variants'] });
      // Repairs queries — without these, the in-batch RepairOrders panel +
      // the open-repair chips strip keep showing the stale qty after a
      // partial repair return (vendor brings 2 of 4, panel still says 4).
      qc.invalidateQueries({ queryKey: ['repairs'] });
      qc.invalidateQueries({ queryKey: ['repair'] });
      submittingRef.current = false;
      // Casting weight finalize popup — when this receipt touched items
      // whose Item Master weight is still flagged "casting weight
      // temporary" (initial guess on a freshly-made-production-ready
      // design), open the prompt INSTEAD of closing the receive form.
      // The popup's onClose then closes the parent. Empty array = normal
      // close (the common case once items have confirmed weights).
      const needs = (res?.needsFinalWeight ?? []) as Array<{ itemId: number; itemNumber: string | null; sampleDesignCode: string; currentWeight: number }>;
      // Recast popup — if this receipt flagged any lost pieces (lostQty > 0
      // on any row), open the recast popup with the freshly-created
      // MissingPart rows for this design. We re-fetch the pending list,
      // filter to the items just received, and pass them through.
      try {
        const anyLost = (res?.lostCreated ?? 0) > 0
          || displayRows.some((row) => Number((inputs[row.key] ?? {} as any).lostQty || 0) > 0);
        if (anyLost) {
          const pending = await Api.missingParts.pending();
          const justNow = pending.filter((p: any) => {
            const dt = new Date(p.createdAt).getTime();
            return Date.now() - dt < 60_000; // last minute
          });
          if (justNow.length > 0) {
            setRecastRows(justNow);
            setRecastOpen(true);
            // Keep the receive dialog open behind the popup; close happens
            // when the popup is dismissed.
            return;
          }
        }
      } catch {}
      // Post-Packing details prompt — variants whose item number was just
      // allocated on this receipt. Shown INSTEAD of closing when present.
      // If both prompts fire, finalWeight wins first; packing runs when
      // finalWeight closes (its onClose triggers next).
      const packingNeeds = (res?.needsPackingDetails ?? []) as Array<{
        id: number; variantCode: string; birthWeight: any; itemId: number;
        item: { itemNumber: string | null; itemName: string | null };
      }>;
      if (needs.length > 0) {
        setFinalWeightPrompt(needs);
        // Queue packing prompt for after finalWeight closes.
        if (packingNeeds.length > 0) setPackingDetailsPrompt(packingNeeds);
      } else if (packingNeeds.length > 0) {
        setPackingDetailsPrompt(packingNeeds);
      } else {
        onClose();
      }
    },
    onError: (e) => {
      submittingRef.current = false;
      toast.error(e instanceof Error && !(e as any).response ? e.message : getApiError(e).message);
    },
  });
  const submit = () => {
    if (submittingRef.current || create.isPending) return; // already in flight
    submittingRef.current = true;
    create.mutate();
  };

  const vendors = batchQ.data?.vendors ?? [];

  return (
    <>
    {/* Casting weight finalize popup — shown after a successful receipt that
        touched items whose Item Master weight is still flagged "casting weight
        temporary". User confirms the actual per-pc weight; the popup's onDone
        clears the prompt AND closes the parent receive form. The Receive
        Dialog below is hidden while this popup is active so the operator
        only sees ONE dialog at a time — without that hide, dismissing
        the popup uncovered the receive form behind it, which read as
        "the system showed the receive page again" and confused operators
        after a partial receipt. */}
    {finalWeightPrompt.length > 0 && (
      <FinalCastingWeightDialog
        items={finalWeightPrompt}
        onDone={() => {
          setFinalWeightPrompt([]);
          qc.invalidateQueries({ queryKey: ['items'] });
          qc.invalidateQueries({ queryKey: ['item'] });
          qc.invalidateQueries({ queryKey: ['item-meta'] });
          // If packing details are queued behind, don't close — let that
          // modal take the stage next. Otherwise close the receive form.
          if (packingDetailsPrompt.length === 0) onClose();
        }}
      />
    )}
    {/* Post-Packing details popup — shown after a Packing receipt that
        auto-allocated item numbers. Captures per-variant additional
        charge + Gross/Less/Net Wt. Operator can Save Now (per variant),
        Save All at once, or Save Later (dismisses without persisting;
        the /items pending badge surfaces them for deferred completion). */}
    {packingDetailsPrompt.length > 0 && (
      <PostPackingDetailsDialog
        variants={packingDetailsPrompt}
        onDone={() => {
          setPackingDetailsPrompt([]);
          qc.invalidateQueries({ queryKey: ['items'] });
          qc.invalidateQueries({ queryKey: ['item'] });
          qc.invalidateQueries({ queryKey: ['production-variants'] });
          qc.invalidateQueries({ queryKey: ['pending-packing-details'] });
          onClose();
        }}
      />
    )}
    <RecastPopup
      open={recastOpen}
      rows={recastRows}
      onClose={() => {
        setRecastOpen(false);
        setRecastRows([]);
        onClose();
      }}
    />
    <Dialog open={open && finalWeightPrompt.length === 0 && packingDetailsPrompt.length === 0 && !recastOpen} onClose={onClose} size="2xl"
      title={editReceiptId
        ? (editReceiptQ.data?.receiptNumber
            ? `Edit Receipt ${editReceiptQ.data.receiptNumber}`
            : 'Edit Receipt')
        : 'Receive Goods'}
      description={editReceiptId
        ? 'Adjusting an existing receipt. The receipt number stays the same; batch + vendor are locked. Repair-related receipts can\'t be edited — delete + create instead.'
        : 'Receive one process at a time. Partial & multiple receipts per stage are supported.'}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button onClick={submit} disabled={create.isPending || !batchId || !vendorId}>
            {create.isPending && <Spinner />} {create.isPending
              ? 'Saving…'
              : editReceiptId ? 'Save Changes' : 'Save Receipt'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-5">
          {/* In edit mode we render plain disabled Inputs showing the
              friendly names instead of SearchableSelects. The Select's
              options list filters out closed batches and completed
              vendors, so feeding it a locked id would just render the
              placeholder. Backend's findReceipt now ships the names
              + processId so this is data-safe. */}
          <Field label="Batch" hint={editReceiptId ? 'Locked — can\'t change the batch on an edit.' : undefined}>
            {editReceiptId ? (
              <Input
                value={editReceiptQ.data?.batchNumber ?? (batchId ? `Batch #${batchId}` : '')}
                disabled
              />
            ) : (
              <SearchableSelect
                value={batchId}
                placeholder="— Select batch —"
                onChange={(v) => { setBatchId(v ? Number(v) : ''); setVendorId(''); }}
                options={(batchesQ.data ?? []).map((b: any) => ({ value: b.id, label: b.batchNumber }))}
              />
            )}
          </Field>
          <Field label="Vendor" hint={editReceiptId ? 'Locked — can\'t change the vendor on an edit.' : 'Vendors that have fully delivered are not listed.'}>
            {editReceiptId ? (
              <Input
                value={
                  editReceiptQ.data?.vendorCode && editReceiptQ.data?.vendorName
                    ? `${editReceiptQ.data.vendorCode} · ${editReceiptQ.data.vendorName}`
                    : editReceiptQ.data?.vendorName ?? (vendorId ? `Vendor #${vendorId}` : '')
                }
                disabled
              />
            ) : (
              <SearchableSelect
                value={vendorId}
                placeholder="— Select vendor —"
                disabled={!batchId}
                onChange={(v) => setVendorId(v ? Number(v) : '')}
                options={vendors.filter((v: any) => !v.completed).map((v: any) => ({
                  value: v.id,
                  label: `${v.vendorCode} · ${v.vendorName}`,
                  keywords: v.vendorName,
                }))}
              />
            )}
          </Field>
          <Field label="Process" hint={editReceiptId ? 'Locked — same process as the original receipt.' : 'One receipt = one process.'}>
            {editReceiptId ? (
              <Input
                value={editReceiptQ.data?.processName ?? (stageProcessId ? `Process #${stageProcessId}` : '')}
                disabled
              />
            ) : (
              <SearchableSelect
                value={stageProcessId}
                placeholder="—"
                disabled={!vendorId || processesInList.length === 0}
                onChange={(v) => setStageProcessId(v ? Number(v) : '')}
                options={processesInList.map((p) => ({ value: p.id, label: p.name }))}
              />
            )}
          </Field>
          <Field label="Receipt Date"><Input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} /></Field>
          <Field
            label="Runners (g) — per vendor"
            hint="Total silver runners returned by this vendor this receipt. Weighed once on the scale, not per design."
          >
            <Input
              type="number" min="0" step="0.001"
              placeholder="0.000"
              value={receiptRunnersWeight}
              onChange={(e) => setReceiptRunnersWeight(e.target.value)}
            />
          </Field>
          <Field
            label="Loss (g) — per vendor"
            hint="Total metal loss reported by this vendor for the whole batch (not per design). Posts to LOSS-SILVER."
          >
            <Input
              type="number" min="0" step="0.001"
              placeholder="0.000"
              value={receiptLossWeight}
              onChange={(e) => setReceiptLossWeight(e.target.value)}
            />
          </Field>
          <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>

        {batchId && vendorId && (
          <div>
            <SectionTitle>Items to Receive</SectionTitle>
            {/* Open repairs strip — every OPEN RepairOrder against this
                batch+vendor renders as a TOGGLEABLE chip. Tick any subset
                the vendor is bringing back this trip; each ticked repair
                spawns its own "From REP-#" row alongside the stage's
                Normal pending row. Untick = drop the row. Empty selection
                = a normal-receive form. The same flow works whether the
                user deep-linked from /repairs (one auto-ticked) or opened
                the form fresh and ticked N repairs themselves. */}
            {openRepairs.length > 0 && (
              <div className="mb-2 rounded-md border border-warning/30 bg-warning/15 p-2 text-xs">
                <div className="mb-1 font-semibold text-warning">
                  🔧 Open repairs for this vendor in this batch ({openRepairs.length})
                  {selectedRepairIds.size > 0 && (
                    <span className="ml-2 rounded bg-warning/20 px-1.5 py-0.5 text-warning">
                      {selectedRepairIds.size} included in this receipt
                    </span>
                  )}
                  <span className="ml-2 font-normal text-warning">— tick the ones the vendor is returning now.</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {openRepairs.map((r: any) => {
                    const checked = selectedRepairIds.has(r.id);
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => toggleRepair(r.id)}
                        aria-pressed={checked}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded border px-2 py-1 transition-colors',
                          checked
                            ? 'border-amber-500 bg-warning/20 text-warning ring-1 ring-amber-400'
                            : 'border-warning/40 bg-card text-warning hover:bg-warning/15',
                        )}
                        title={checked ? 'Untick to remove this repair from the receipt' : 'Tick to include this repair in the receipt'}
                      >
                        <span aria-hidden className="text-[12px]">{checked ? '✓' : '☐'}</span>
                        <span className="font-mono font-semibold">🔧 REP-{r.id}</span>
                        <span className="rounded bg-warning/15 px-1 text-[10px]">cycle {r.cycle}</span>
                        <span className="tabular-nums">· {r.qty} pcs</span>
                        <span>· {r.processName}</span>
                        {r.reason && <span className="italic">· "{r.reason}"</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {pendingQ.isLoading ? (
              <div className="flex justify-center py-6"><Spinner className="text-primary" /></div>
            ) : visibleItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing pending for this vendor / process.</p>
            ) : (
              <div className="rounded-lg border border-border">
                {/* Search filter — narrows displayRows when many stages are
                    pending for the same vendor (10+ stages get tedious to
                    scroll on phone). Matches against item#, vendor design
                    ref, process and colour — anything an operator might
                    glance for. */}
                <div className="relative border-b border-border bg-muted/30 px-2 py-1.5">
                  <Search className="absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-text-faint" />
                  <Input
                    placeholder="Filter stages — item / vendor ref / process / colour…"
                    value={stageSearch}
                    onChange={(e) => setStageSearch(e.target.value)}
                    className="h-8 pl-7 text-sm"
                  />
                </div>
                {/* Compact layout — table-scroll so the wide table
                    scrolls on phone instead of breaking the page. Loss/Gain
                    is auto-computed from (ordered weight − received weight)
                    and shown as a small annotation under Recv Wt so the
                    operator doesn't have to type it. Casting hides it
                    entirely (sprue / re-melt handled elsewhere). Filing /
                    Polish show a separate Runners input under Recv Wt
                    when a runners value is needed. */}
                <div className="table-scroll">
                {(() => {
                  const isCastingReceipt = displayRows.some(
                    (r) => (r.stage as any).processCode === 'CASTING',
                  );
                  const showRunners = displayRows.some(
                    (r) => (r.stage as any).processCode === 'FILING'
                        || (r.stage as any).processCode === 'POLISH',
                  );
                  return (
                <div className="table-scroll">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-text-muted">
                    <tr>
                      <th className="px-2 py-2">Stage</th>
                      <th className="px-2 py-2 text-right">Ordered</th>
                      <th className="px-2 py-2 text-right">Recd / Pending</th>
                      <th className="px-2 py-2">Recv Qty</th>
                      <th
                        className="px-2 py-2"
                        title="Pieces returned by the vendor AS-IS (untouched). Not counted as received; flow back to pending for re-issue tomorrow. Vendor allocation decrements. Leave 0 for a fully-completed lot."
                      >Return As-Is</th>
                      <th className="px-2 py-2">Recv Wt</th>
                      <th className="px-2 py-2" title="Rate billed on this receipt — pre-filled from the issue slip. Edit if the vendor's rate changed.">Rate</th>
                      <th className="px-2 py-2 text-right">Excess/Short</th>
                      <th className="px-2 py-2">Remarks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const term = stageSearch.trim().toLowerCase();
                      if (!term) return displayRows;
                      return displayRows.filter((row) => {
                        const it: any = row.stage;
                        const hay = [
                          it.itemNumber, it.vendorDesignReference, it.processName,
                          it.processCode, it.color, it.itemName,
                        ].filter(Boolean).join(' ').toLowerCase();
                        return hay.includes(term);
                      });
                    })().map((row) => {
                      const it = row.stage;
                      const rowKey = row.key;
                      const recvNow = Number(inputs[rowKey]?.receivedQty || 0);
                      // Excess/Short measures how this row's TOTAL SETTLED pcs
                      // (acc+rej, what the stage actually accounts for) compares
                      // to ordered. Only Normal/only rows carry this — Repair
                      // rows just transition openRepair → settled and shouldn't
                      // double-count. it.receivedQty is now SETTLED on the
                      // backend (acc+rej of past receipts, no raw sum), so the
                      // math is simply current_settled + new_settled − ordered.
                      const isRepairRow = row.kind === 'repair';
                      const myNewSettled =
                        Number(inputs[rowKey]?.acceptedQty || 0) +
                        Number(inputs[rowKey]?.rejectedQty || 0);
                      // For Normal rows: every sibling Repair row on the same
                      // stage is ALSO converting openRepair → settled, so its
                      // accept+reject also bumps the stage's settled count.
                      const stageRepairs = row.kind === 'normal'
                        ? selectedRepairs.filter((r: any) => r.stageId === it.id)
                        : [];
                      const siblingRepairSettled = stageRepairs.reduce((s: number, r: any) => {
                        const inp = inputs[`${it.id}:repair:${r.id}`];
                        return s + Number(inp?.acceptedQty || 0) + Number(inp?.rejectedQty || 0);
                      }, 0);
                      const excessShort = isRepairRow
                        ? 0
                        : it.receivedQty + myNewSettled + siblingRepairSettled - it.quantity;
                      // For sticking stages: cap recd by what materials can support.
                      // If raw materials were short-issued, the vendor physically
                      // could not have produced more than `maxProducible` pcs total,
                      // so we cap input + show a hint. Already-received pcs count
                      // toward the cap, so the remaining headroom is
                      // (maxProducible − previously received).
                      const ms = it.materialStatus;
                      const stickingCap = ms ? Math.max(0, ms.maxProducible - it.receivedQty) : null;
                      const recvOverCap = stickingCap != null && recvNow > stickingCap;
                      return (
                        <React.Fragment key={rowKey}>
                        <tr className={cn(
                          'border-t border-border',
                          // Tint the Repair row amber so the user immediately
                          // reads it as a repair-return row, distinct from
                          // its Normal sibling on the same stage.
                          isRepairRow ? 'bg-warning/15' : undefined,
                        )}>
                          {/* Stage cell — merged Item # / Vendor Ref / Colour
                              so the table fits without horizontal scroll. */}
                          <td className="px-1.5 py-1.5">
                            <div className="flex flex-col gap-0.5">
                              <div className="flex flex-wrap items-center gap-1.5 font-semibold tracking-tight text-foreground">
                                <span>{it.itemNumber ? `#${it.itemNumber}` : '—'}</span>
                                <Badge variant="default" className="text-[10px]">{it.processName}</Badge>
                                {isRepairRow && row.repair && (
                                  <Badge variant="warning" className="text-[10px]" title={`Repair REP-${row.repair.id} · cycle ${row.repair.cycle}${row.repair.reason ? ` — ${row.repair.reason}` : ''}`}>
                                    🔧 REP-{row.repair.id}
                                  </Badge>
                                )}
                              </div>
                              <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-faint">
                                {it.vendorDesignReference && <span>vRef <strong className="text-text-muted">{it.vendorDesignReference}</strong></span>}
                                {it.color && <span>· {it.color}</span>}
                              </div>
                            </div>
                          </td>
                          {/* Ordered Qty/Wt merged. Repair rows blank since
                              the accounting is per-repair, not per-stage. */}
                          <td className="px-1.5 py-1.5 text-right">
                            {isRepairRow ? (
                              <span className="text-text-faint">—</span>
                            ) : (
                              <div className="flex flex-col">
                                <span className="font-medium">{it.quantity} pcs</span>
                                <span className="text-[11px] text-text-faint">{it.totalWeight} g</span>
                              </div>
                            )}
                          </td>
                          {/* Recd-so-far + Pending merged. */}
                          <td className="px-1.5 py-1.5 text-right">
                            {isRepairRow ? (
                              <div className="flex flex-col">
                                <span className="text-text-faint">—</span>
                                <span className={`text-[11px] ${row.pendingShown > 0 ? 'text-warning' : 'text-success'}`}>{row.pendingShown} pending</span>
                              </div>
                            ) : (
                              <div className="flex flex-col">
                                <span className="font-medium">{it.receivedQty} recd</span>
                                <span className={`text-[11px] ${row.pendingShown > 0 ? 'text-warning' : 'text-success'}`}>{row.pendingShown} pending</span>
                              </div>
                            )}
                            {isRepairRow && row.repair?.reason && (
                              <div className="text-[10px] italic text-warning" title={row.repair.reason}>
                                "{row.repair.reason.length > 18 ? row.repair.reason.slice(0, 18) + '…' : row.repair.reason}"
                              </div>
                            )}
                          </td>
                          <td className="px-1.5 py-1.5">
                            <Input
                              type="number"
                              className={`h-8 w-20 ${recvOverCap ? 'border-amber-400 ring-1 ring-warning/30' : ''}`}
                              value={inputs[rowKey]?.receivedQty ?? ''}
                              onChange={(e) => syncRow(rowKey, Number(it.weight || 0), 'recv', e.target.value)}
                            />
                            {ms && ms.materialsShort && !isRepairRow && (
                              <div className={`mt-0.5 text-[10px] font-semibold ${recvOverCap ? 'text-warning' : 'text-muted-foreground'}`}
                                title="Materials issued cover this many pieces — vendor may have actually produced more or less. Adjust freely.">
                                {recvOverCap
                                  ? `⚠ ${inputs[rowKey]?.receivedQty} > ${stickingCap}`
                                  : `ⓘ cover ${stickingCap}`}
                              </div>
                            )}
                          </td>
                          {/* Return-as-is — vendor brought back untouched pcs.
                              Casting doesn't have this concept (casting always
                              produces something or fails, no "returned as-is").
                              Repair rows skip too — they're already accounting
                              for repair returns. */}
                          <td className="px-1.5 py-1.5">
                            {isRepairRow || (it as any).processCode === 'CASTING' ? (
                              <span className="text-text-faint">—</span>
                            ) : (
                              <Input
                                type="number" min="0" step="1"
                                className="h-8 w-16"
                                placeholder="0"
                                value={inputs[rowKey]?.returnedAsIsQty ?? ''}
                                onChange={(e) => setInput(rowKey, { returnedAsIsQty: e.target.value })}
                                title="Pieces the vendor returned untouched. Flow back to pending pool for re-issue tomorrow."
                              />
                            )}
                          </td>
                          {/* Recv Wt + Runners + auto-but-editable Loss.
                              Computation:
                                loss = ordered − received − runners
                              Recomputes on every keystroke; operator can
                              override (mg-level corrections). Casting hides
                              loss entirely (sprue / re-melt handled elsewhere).
                              Sand Blast shows "↑ gain" instead of loss when
                              recv > given — gains don't post (not silver). */}
                          <td className="px-1.5 py-1.5">
                            <Input type="number" step="0.001" className="h-8 w-24"
                              value={inputs[rowKey]?.receivedWeight ?? ''}
                              onChange={(e) => {
                                // Recompute loss on weight change unless operator manually edited.
                                const wt = Number(e.target.value || 0);
                                const ord = Number(it.totalWeight || 0);
                                const runners = Number(inputs[rowKey]?.runnersWeight || 0);
                                const auto = wt > 0 && ord > 0
                                  ? Math.round((ord - wt - runners) * 1000) / 1000 : 0;
                                const cur = inputs[rowKey] ?? {} as any;
                                const lossWasAuto = cur.lossManual !== true;
                                // Auto-redistribute total weight across per-piece inputs
                                // for PLATING rows — operator can still override any
                                // single piece's weight after that. We only spray when
                                // every per-piece input is blank (no manual edits yet)
                                // so we don't clobber operator data.
                                const recvN = Math.max(0, Math.trunc(Number(cur.receivedQty || 0)));
                                let perPatch: { perPieceWeights?: string[] } = {};
                                if (isVariantReceive((it as any).processCode) && recvN > 0) {
                                  const existing: string[] = Array.isArray(cur.perPieceWeights) ? cur.perPieceWeights : [];
                                  const anyTyped = existing.some((v) => v !== undefined && v !== '');
                                  if (!anyTyped && wt > 0) {
                                    const even = Math.round((wt / recvN) * 1000) / 1000;
                                    perPatch.perPieceWeights = Array.from({ length: recvN }, () => String(even));
                                  }
                                }
                                setInput(rowKey, {
                                  receivedWeight: e.target.value,
                                  ...(lossWasAuto ? { lossWeight: auto !== 0 ? String(auto) : '' } as any : {}),
                                  ...perPatch,
                                });
                              }}
                            />
                            {showRunners && (it as any).processCode !== 'CASTING' && (
                              <div className="mt-1 flex items-center gap-1">
                                <span className="text-[10px] text-text-faint">Runners g</span>
                                <Input
                                  type="number" step="0.001" min="0"
                                  className="h-7 w-20"
                                  placeholder="0.000"
                                  value={inputs[rowKey]?.runnersWeight ?? ''}
                                  onChange={(e) => {
                                    const runners = Number(e.target.value || 0);
                                    const wt = Number(inputs[rowKey]?.receivedWeight || 0);
                                    const ord = Number(it.totalWeight || 0);
                                    const auto = wt > 0 && ord > 0
                                      ? Math.round((ord - wt - runners) * 1000) / 1000 : 0;
                                    const cur = inputs[rowKey] ?? {} as any;
                                    const lossWasAuto = cur.lossManual !== true;
                                    setInput(rowKey, {
                                      runnersWeight: e.target.value,
                                      ...(lossWasAuto ? { lossWeight: auto !== 0 ? String(auto) : '' } as any : {}),
                                    });
                                  }}
                                  title="Runners + melted-ball weight (combined). Posts to Silver Runners pool, subtracted from ordered to compute loss."
                                />
                              </div>
                            )}
                            {/* Vendor's CLAIMED sent weight — surfaced at
                                every non-Casting stage so the per-vendor
                                drift accumulator (claimed − actual) has
                                data to aggregate. Small input right below
                                Runners; blank = no claim on record. */}
                            {(it as any).processCode !== 'CASTING' && (
                              <div className="mt-1 flex items-center gap-1">
                                <span className="text-[10px] text-text-faint">Said sent g</span>
                                <Input
                                  type="number" step="0.001" min="0"
                                  className="h-7 w-20"
                                  placeholder="0.000"
                                  value={(inputs[rowKey] as any)?.claimedSentWeight ?? ''}
                                  onChange={(e) => setInput(rowKey, { claimedSentWeight: e.target.value } as any)}
                                  title="What the vendor CLAIMS they sent. Compared against Recv Wt for the drift accumulator on the purchase bill; not printed on the slip."
                                />
                              </div>
                            )}
                            {/* Die Number stamp — DIE_NUMBER stages only.
                                One field per design master; first non-blank
                                receipt wins, later ones overwrite (typo
                                fix / re-cut). Persisted to Item.dieNumber. */}
                            {(it as any).processCode === 'DIE_NUMBER' && (
                              <div className="mt-1 flex items-center gap-1">
                                <span className="text-[10px] text-text-faint">Die #</span>
                                <Input
                                  type="text"
                                  className="h-7 w-24"
                                  placeholder="e.g. D-1024"
                                  value={(inputs[rowKey] as any)?.dieNumber ?? ''}
                                  onChange={(e) => setInput(rowKey, { dieNumber: e.target.value } as any)}
                                  title="Die number the karigar stamped on this design. Saved to Item Master."
                                />
                              </div>
                            )}
                            {!isCastingReceipt && (() => {
                              const recvWt = Number(inputs[rowKey]?.receivedWeight || 0);
                              const ordWt  = Number(it.totalWeight || 0);
                              if (recvWt <= 0 || ordWt <= 0) return null;
                              const delta = recvWt - ordWt;
                              // Sand Blast can gain — show as "↑ gain" info only.
                              if (delta > 0) {
                                return (
                                  <div className="mt-1 text-[10px] font-semibold text-success" title="Weight increased — typical of Sand Blast (sand particles embed)">
                                    ↑ gain {Math.abs(delta).toFixed(3)} g
                                  </div>
                                );
                              }
                              // Otherwise editable Loss input. Pre-fills auto value but
                              // operator can correct by mg — `lossManual` flag stops
                              // future recv/runners changes from clobbering the typed value.
                              const lossVal = inputs[rowKey]?.lossWeight ?? '';
                              return (
                                <div className="mt-1 flex items-center gap-1">
                                  <span className="text-[10px] text-warning">Loss g</span>
                                  <Input
                                    type="number" step="0.001" min="0"
                                    className="h-7 w-20"
                                    placeholder="0.000"
                                    value={lossVal}
                                    onChange={(e) => setInput(rowKey, { lossWeight: e.target.value, lossManual: true } as any)}
                                    title="Auto = ordered − received − runners. Edit to correct by milligrams."
                                  />
                                </div>
                              );
                            })()}
                          </td>
                          {/* Rate cell — pre-filled from the stage's issue
                              rate. When the operator types a different
                              value, the receipt persists it and syncs to
                              Item Master. The 🔼 chip flags the row as
                              over the original rate; 🔽 flags under. */}
                          <td className="px-1.5 py-1.5">
                            {(() => {
                              const stageRate = it.costPerKg != null ? Number(it.costPerKg) : null;
                              const typed = inputs[rowKey]?.costPerKg;
                              const typedN = typed != null && typed !== '' ? Number(typed) : null;
                              const delta = typedN != null && stageRate != null ? typedN - stageRate : null;
                              return (
                                <div className="flex items-center gap-1">
                                  <Input
                                    type="number"
                                    step="0.01"
                                    className="h-8 w-20"
                                    value={inputs[rowKey]?.costPerKg ?? ''}
                                    onChange={(e) => setInput(rowKey, { costPerKg: e.target.value })}
                                    placeholder={stageRate != null ? String(stageRate) : '—'}
                                    title={stageRate != null ? `Issue rate: ₹${stageRate}` : 'No issue rate set'}
                                  />
                                  {delta != null && delta !== 0 && (
                                    <span
                                      className={`text-[10px] font-semibold ${delta > 0 ? 'text-warning' : 'text-success'}`}
                                      title={`${delta > 0 ? '+' : ''}₹${delta.toFixed(2)} vs issue rate — saves to Item Master on submit`}
                                    >
                                      {delta > 0 ? '🔼' : '🔽'}
                                    </span>
                                  )}
                                </div>
                              );
                            })()}
                          </td>
                          <td className="px-1.5 py-1.5 text-right">
                            {isRepairRow ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <span className={excessShort === 0 ? 'text-muted-foreground' : excessShort > 0 ? 'text-info font-medium' : 'text-destructive font-medium'}>
                                {excessShort > 0 ? `+${excessShort}` : excessShort}
                              </span>
                            )}
                          </td>
                          <td className="px-1.5 py-1.5">
                            <div className="flex items-center gap-1">
                              <Input className="h-8" value={inputs[rowKey]?.remarks ?? ''} onChange={(e) => setInput(rowKey, { remarks: e.target.value })} />
                              {/* Report Missing Parts — opens dialog scoped
                                  to this stage so multi-part designs that
                                  arrive short can be flagged for recast. */}
                              {!isRepairRow && it.itemId && (
                                <button
                                  type="button"
                                  onClick={() => setMissingCtx({ stageId: it.id, itemId: it.itemId, designCode: it.itemNumber ?? null })}
                                  title="Report missing parts for recast"
                                  className="shrink-0 rounded-md border border-warning/30 bg-warning/10 p-1.5 text-warning transition-colors hover:bg-warning/15"
                                >
                                  <AlertTriangle className="size-3.5" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {/* QC bucket strip — Repair / Reject DEDUCTIONS from
                            the gross the vendor handed back. Recv Qty above
                            already shows the NET (accepted) count, so the
                            Accept input is hidden as redundant. Sum mismatch
                            warning is gone because the backend gross is
                            reconstructed on submit (recv + repair + reject). */}
                        {(() => {
                          const r = inputs[rowKey];
                          const recv = Number(r?.receivedQty || 0);
                          const rep = Number(r?.repairQty || 0);
                          const rej = Number(r?.rejectedQty || 0);
                          if (recv + rep + rej <= 0) return null;
                          const mode = r?.rejectPaymentMode ?? '';
                          const gross = recv + rep + rej;
                          return (
                            <tr className={isRepairRow ? 'bg-warning/15' : 'bg-secondary/40'}>
                              <td colSpan={12} className="px-1.5 py-1.5">
                                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                                  <span className="font-semibold text-text-muted">
                                    Vendor returned {gross} pcs → {recv} accepted{isRepairRow && row.repair ? ` (from REP-${row.repair.id})` : ''}:
                                  </span>
                                  <label className="inline-flex items-center gap-1">
                                    <span className="text-warning">🔧 Repair{isRepairRow ? ' again' : ''}</span>
                                    <Input type="number" min={0} className="h-7 w-16 text-right" value={r?.repairQty ?? ''}
                                      onChange={(e) => syncRow(rowKey, Number(it.weight || 0), 'repair', e.target.value)} />
                                  </label>
                                  <label className="inline-flex items-center gap-1">
                                    <span className="text-destructive">⛔ Reject</span>
                                    <Input type="number" min={0} className="h-7 w-16 text-right" value={r?.rejectedQty ?? ''}
                                      onChange={(e) => syncRow(rowKey, Number(it.weight || 0), 'reject', e.target.value)} />
                                  </label>
                                  {/* Reject payment-mode picker — appears when Reject > 0.
                                      User MUST pick (no system default per their direction). */}
                                  {rej > 0 && (
                                    <>
                                      <span className="ml-1 text-destructive">Payment:</span>
                                      <Select className="h-7 w-44 text-[11px]"
                                        value={mode}
                                        onChange={(e) => setInput(rowKey, { rejectPaymentMode: e.target.value as any })}>
                                        <option value="">— pick one —</option>
                                        <option value="NO_PAY">No pay (deduct full)</option>
                                        <option value="ADJUSTED">Adjusted (custom deduct)</option>
                                        <option value="FULL_PAY">Full pay (our fault)</option>
                                      </Select>
                                      {mode === 'ADJUSTED' && (
                                        <label className="inline-flex items-center gap-1">
                                          <span className="text-destructive">Deduct ₹</span>
                                          <Input type="number" min={0} step="0.01" className="h-7 w-24 text-right" value={r?.rejectAdjustment ?? ''}
                                            onChange={(e) => setInput(rowKey, { rejectAdjustment: e.target.value })} />
                                        </label>
                                      )}
                                      {!mode && (
                                        <span className="rounded bg-destructive/15 px-1.5 py-0.5 font-semibold text-destructive ring-1 ring-red-200">
                                          ⚠ Pick a payment mode
                                        </span>
                                      )}
                                    </>
                                  )}
                                  {rep > 0 && (
                                    <label className="inline-flex items-center gap-1">
                                      <span className="text-warning">Repair reason:</span>
                                      <Input className="h-7 w-48 text-[11px]" placeholder="Finish defect / stone missing / …"
                                        value={r?.repairReason ?? ''}
                                        onChange={(e) => setInput(rowKey, { repairReason: e.target.value })} />
                                    </label>
                                  )}
                                  {/* Lost — pieces that physically didn't come
                                      back at all (dropped at karigar, broken in
                                      transit, etc.). Distinct from Reject (came
                                      back, failed QC). One MissingPart per lost
                                      piece is auto-created on save. Required
                                      reason when > 0 so the design's recast
                                      banner has context. */}
                                  {!isRepairRow && it.itemId && (
                                    <label className="inline-flex items-center gap-1">
                                      <span className="text-destructive">✗ Lost</span>
                                      <Input type="number" min={0} className="h-7 w-16 text-right"
                                        value={(r as any)?.lostQty ?? ''}
                                        onChange={(e) => setInput(rowKey, { lostQty: e.target.value } as any)}
                                        title="Pieces that didn't come back (lost / damaged beyond repair). Auto-creates MissingPart records that block further forwards until recast."
                                      />
                                      {Number((r as any)?.lostQty || 0) > 0 && (
                                        <Input className="h-7 w-44 text-[11px]" placeholder="Lost reason — required"
                                          value={(r as any)?.lostReason ?? ''}
                                          onChange={(e) => setInput(rowKey, { lostReason: e.target.value } as any)}
                                        />
                                      )}
                                    </label>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })()}
                        {/* Sticking-only material constraint banner: makes the cap
                            impossible to miss when raw materials are short. Shows
                            the per-material gap inline with the row so the user
                            knows exactly why they can't book more. */}
                        {it.processCode === 'STICKING' && ms && ms.materialsShort && (
                          <tr className="bg-warning/15">
                            <td colSpan={12} className="px-1.5 py-1.5">
                              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                                <span className="font-semibold text-warning">⚠ Materials cover only {ms.maxProducible} / {ms.stageQty} pcs.</span>
                                <span className="text-warning">{ms.pendingPiecesAwaitingMaterial} pcs awaiting material top-up.</span>
                                {ms.lines.filter((l: any) => l.stillToIssue > 0).map((l: any) => (
                                  <span key={l.variantId} className="rounded bg-warning/15 px-1.5 py-0.5 text-warning ring-1 ring-warning/30">
                                    Need <strong>{l.stillToIssue}</strong> more {l.materialName} ({l.variantName})
                                  </span>
                                ))}
                                <a href="/inventory" target="_blank" rel="noreferrer" className="text-warning underline">→ issue more from Inventory</a>
                              </div>
                            </td>
                          </tr>
                        )}
                        {/* PLATING per-piece sub-rows — one indented row per
                            ProductionVariant. Mandatory bifurcation: each piece
                            gets weighed individually before save. Sum must
                            match Recv Wt (Σ vs target shown in the footer cell). */}
                        {isVariantReceive((it as any).processCode) && Number(inputs[rowKey]?.receivedQty || 0) > 0 && (() => {
                          const recvN = Math.max(0, Math.trunc(Number(inputs[rowKey]?.receivedQty || 0)));
                          const list: string[] = Array.isArray(inputs[rowKey]?.perPieceWeights) ? (inputs[rowKey] as any).perPieceWeights : [];
                          const padded = Array.from({ length: recvN }, (_, i) => list[i] ?? '');
                          const sum = padded.reduce((s, v) => s + Number(v || 0), 0);
                          const target = Number(inputs[rowKey]?.receivedWeight || 0);
                          const diff = Math.round((sum - target) * 1000) / 1000;
                          const designCode = it.itemNumber ?? '—';
                          return (
                            <>
                              {padded.map((v, i) => (
                                <tr key={`pp-${rowKey}-${i}`} className="border-t border-dashed border-border bg-secondary/10">
                                  <td className="px-2 py-1 pl-8 text-xs text-text-faint">
                                    <span className="font-semibold tracking-tight">{designCode}({i + 1})</span>
                                    <span className="ml-2 text-text-faint">Piece {i + 1} of {recvN}</span>
                                  </td>
                                  <td className="px-2 py-1 text-xs text-text-faint">—</td>
                                  <td className="px-2 py-1 text-xs text-text-faint">—</td>
                                  <td className="px-2 py-1 text-xs text-text-faint">1 pc</td>
                                  <td className="px-2 py-1">
                                    <Input
                                      type="number" step="0.001" min="0"
                                      className="h-8 w-24 text-xs"
                                      placeholder="0.000"
                                      value={v}
                                      onChange={(e) => {
                                        const next = [...padded];
                                        next[i] = e.target.value;
                                        // Editing a per-piece weight is the operator's
                                        // declaration of truth — recompute Σ and push
                                        // it into Recv Wt so loss / Excess-Short
                                        // recompute downstream off the new total.
                                        const newSum = next.reduce((s, w) => s + Number(w || 0), 0);
                                        const newSumR3 = Math.round(newSum * 1000) / 1000;
                                        const ord = Number(it.totalWeight || 0);
                                        const runners = Number(inputs[rowKey]?.runnersWeight || 0);
                                        const auto = newSumR3 > 0 && ord > 0
                                          ? Math.round((ord - newSumR3 - runners) * 1000) / 1000
                                          : 0;
                                        const cur = inputs[rowKey] ?? {} as any;
                                        const lossWasAuto = cur.lossManual !== true;
                                        setInput(rowKey, {
                                          perPieceWeights: next,
                                          receivedWeight: newSumR3 > 0 ? String(newSumR3) : '',
                                          ...(lossWasAuto ? { lossWeight: auto !== 0 ? String(auto) : '' } as any : {}),
                                        });
                                      }}
                                    />
                                    <span className="ml-1 text-[10px] text-text-faint">g</span>
                                  </td>
                                  <td className="px-2 py-1 text-xs text-text-faint">—</td>
                                  <td className="px-2 py-1 text-xs text-text-faint">—</td>
                                  <td className="px-2 py-1"></td>
                                </tr>
                              ))}
                              <tr className="border-t border-dashed border-warning/40 bg-warning/5">
                                <td colSpan={4} className="px-2 py-1 pl-8 text-[11px] text-warning">
                                  Σ per-piece must match Recv Wt
                                </td>
                                <td className="px-2 py-1">
                                  <div className={`text-[11px] tabular-nums ${Math.abs(diff) > 0.05 ? 'text-destructive font-semibold' : 'text-warning'}`}>
                                    Σ {sum.toFixed(3)} / {target.toFixed(3)} g
                                  </div>
                                  {Math.abs(diff) > 0.001 && (
                                    <div className={`text-[10px] tabular-nums ${Math.abs(diff) > 0.05 ? 'text-destructive' : 'text-warning'}`}>
                                      diff {diff > 0 ? '+' : ''}{diff.toFixed(3)} g
                                    </div>
                                  )}
                                </td>
                                <td colSpan={3}></td>
                              </tr>
                            </>
                          );
                        })()}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
                </div>
                  );
                })()}
                </div>
              </div>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Received quantity is never assumed equal to ordered — short/excess is tracked for inventory settlement.
            </p>

            {/* Sticking receipts ALWAYS prompt about materials so the user has
                a clear yes/no answer recorded. Three scenarios per stage:
                  (a) Voucher with pending materials → ask "returning or keeping?"
                  (b) Voucher fully cleared / all used → green confirmation banner
                  (c) No voucher at all (bringsOwnMaterials, or no BOM) → grey info banner */}
            {visibleItems.some((it: any) => it.materialIssue) && (
              <div className="mt-4 space-y-3">
                <SectionTitle>Material Return from Vendor</SectionTitle>
                <p className="text-xs text-muted-foreground">
                  For every stage that received materials (Filing, Kacha Fitting, Fitting+Mala, Sticking, or any
                  ad-hoc issue), record what was returned, consumed, or kept.
                </p>
                {visibleItems.filter((it: any) => it.materialIssue).map((it: any) => {
                  const issue = it.materialIssue;
                  const headerLabel = `${it.vendorDesignReference || it.itemNumber}${it.color ? ` (${it.color})` : ''}`;

                  // Case (c): no linked voucher → vendor brought own materials or no BOM.
                  if (!issue) {
                    return (
                      <div key={`mr-${it.id}`} className="rounded-lg border border-slate-200 bg-secondary/30 px-3 py-2 text-sm text-text-muted">
                        <div className="font-semibold">{headerLabel}</div>
                        <div className="text-xs">No material voucher linked — vendor used their own raw materials, or no BOM was configured. Nothing to record.</div>
                      </div>
                    );
                  }

                  // Case (b): voucher exists but pending is 0 → all materials accounted for.
                  if (!issue.lines?.length) {
                    return (
                      <div key={`mr-${it.id}`} className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
                        <div className="font-semibold">Voucher {issue.voucherNumber} · {headerLabel}</div>
                        <div className="text-xs">All materials accounted for — nothing pending with vendor. ✓</div>
                      </div>
                    );
                  }

                  // Case (a): pending lines → for each material, two questions:
                  //   Q1. How much was actually USED? (auto-defaults to
                  //       perPiece × sticking pcs received NOW; editable so
                  //       waste / extra usage can be recorded).
                  //   Q2. The EXCESS (= pending − used). Is the vendor
                  //       returning it now, or keeping it for later?
                  //
                  // This mirrors how materials were issued: the system already
                  // computes BOM × stage qty for the auto-issue — we now ask
                  // the same question at receive time but adjusted for the
                  // pieces actually received back.
                  // Material consumption is per STAGE, not per displayRow —
                  // a sticking stage that has a Normal row + N Repair rows
                  // consumed materials once (when issued) and those
                  // materials cover the COMBINED pcs being received now.
                  // Sum across `${id}`, `${id}:normal`, and one
                  // `${id}:repair:${repairId}` per selected repair targeting
                  // this stage.
                  const stageSelectedRepairs = selectedRepairs.filter((r: any) => r.stageId === it.id);
                  const stickingReceivedNow = Math.max(0, Math.trunc(
                    Number(inputs[String(it.id)]?.receivedQty || 0) +
                    Number(inputs[`${it.id}:normal`]?.receivedQty || 0) +
                    stageSelectedRepairs.reduce(
                      (s: number, r: any) => s + Number(inputs[`${it.id}:repair:${r.id}`]?.receivedQty || 0),
                      0,
                    ),
                  ));
                  // If the user hasn't entered a Recv Qty for this sticking
                  // stage, recording material consumption is meaningless. Show
                  // a friendly note instead of the editable table to avoid
                  // confusion (no pieces back = no materials consumed).
                  if (stickingReceivedNow === 0) {
                    return (
                      <div key={`mr-${it.id}`} className="rounded-lg border border-slate-200 bg-secondary/30 px-3 py-2 text-sm text-text-muted">
                        <div className="font-semibold">Voucher {issue.voucherNumber} · {headerLabel}</div>
                        <div className="text-xs">Enter Recv Qty above to record material consumption. Materials stay pending with the vendor until pieces are received.</div>
                      </div>
                    );
                  }
                  const rowReturns: MatReturnInput = matReturns[it.id] ?? {};
                  const defaultRow = (line: any): MatReturnRow => ({
                    used: String(Math.max(0, Math.min(line.pendingQty, (line.perPiece ?? 0) * stickingReceivedNow))),
                    excessMode: 'keep',
                    returnQty: '',
                    usedWeight: '',
                    returnWeight: '',
                    runnersWeight: '',
                    lossWeight: '',
                    lossManual: false,
                  });
                  const cfgFor = (line: any): MatReturnRow => rowReturns[line.lineId] ?? defaultRow(line);
                  const setRow = (lineId: number, patch: Partial<MatReturnRow>) => {
                    const line = issue.lines.find((l: any) => l.lineId === lineId);
                    const base = rowReturns[lineId] ?? (line
                      ? defaultRow(line)
                      : { used: '0', excessMode: 'keep', returnQty: '', usedWeight: '', returnWeight: '', runnersWeight: '', lossWeight: '', lossManual: false });
                    setMatReturns((m) => ({
                      ...m,
                      [it.id]: { ...(m[it.id] ?? {}), [lineId]: { ...base, ...patch } },
                    }));
                  };
                  // Voucher totals for the bottom summary.
                  const lineTotals = issue.lines.reduce((acc: any, line: any) => {
                    const cfg = cfgFor(line);
                    const used = Math.max(0, Math.trunc(Number(cfg.used || 0)));
                    const excess = Math.max(0, line.pendingQty - used);
                    const ret = cfg.excessMode === 'return'
                      ? Math.min(excess, Math.max(0, Math.trunc(Number(cfg.returnQty || 0))))
                      : 0;
                    const kept = excess - ret;
                    return { used: acc.used + used, ret: acc.ret + ret, kept: acc.kept + kept };
                  }, { used: 0, ret: 0, kept: 0 });

                  return (
                    <div key={`mr-${it.id}`} className="table-scroll rounded-lg border border-warning/30 bg-warning/15">
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs">
                        <span className="font-semibold text-warning">
                          Voucher {issue.voucherNumber} · {headerLabel} · <span className="font-normal">{stickingReceivedNow} pcs being received</span>
                        </span>
                      </div>
                      {/* Min-width only kicks in at sm+. On phone the table
                          flows into narrower cells so the inputs stay tappable
                          without horizontal scroll. */}
                      <div className="table-scroll">
                      <table className="w-full text-sm sm:min-w-[680px]">
                        <thead className="bg-warning/10/30 text-left text-xs text-warning">
                          <tr>
                            <th className="px-3 py-2">Material</th>
                            <th className="px-3 py-2 text-right">With vendor</th>
                            <th className="px-3 py-2 text-right" title="Auto-calculated from BOM × sticking pcs received now. Edit if vendor used more/less.">Used? (auto)</th>
                            <th className="px-3 py-2 text-right">Excess</th>
                            <th className="px-3 py-2">Excess: return or keep?</th>
                            <th className="px-3 py-2 text-right">Result</th>
                          </tr>
                        </thead>
                        <tbody>
                          {issue.lines.map((line: any) => {
                            const cfg = cfgFor(line);
                            const autoUsed = Math.max(0, Math.min(line.pendingQty, (line.perPiece ?? 0) * stickingReceivedNow));
                            const used = Math.max(0, Math.trunc(Number(cfg.used || 0)));
                            const excess = Math.max(0, line.pendingQty - used);
                            const isReturn = cfg.excessMode === 'return';
                            const ret = isReturn
                              ? Math.min(excess, Math.max(0, Math.trunc(Number(cfg.returnQty || 0))))
                              : 0;
                            const kept = excess - ret;
                            const usedOver = used > line.pendingQty;
                            const retOver = ret > excess;
                            return (
                              <tr key={line.lineId} className="border-t border-amber-100">
                                <td className="px-3 py-2 align-top">
                                  <div className="font-medium text-foreground">{line.variantName}</div>
                                  <div className="text-[10px] text-muted-foreground">
                                    {line.variantCode}{line.unit ? ` · ${line.unit}` : ''}
                                    {line.perPiece > 0 && ` · ${line.perPiece}/pc`}
                                  </div>
                                </td>
                                <td className="px-3 py-2 text-right align-top">
                                  <div className="font-semibold text-warning tabular-nums">{line.pendingQty}</div>
                                  <div className="text-[10px] text-muted-foreground">pcs</div>
                                  {line.trackByWeight && Number(line.pendingWeight) > 0 && (
                                    <div className="mt-1 text-[10px] text-warning tabular-nums">{Number(line.pendingWeight).toFixed(3)} g</div>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right align-top">
                                  <Input type="number" min={0} max={line.pendingQty} step="1"
                                    className={`h-8 w-24 text-right font-medium ${usedOver ? 'border-red-300 bg-destructive/10' : ''}`}
                                    value={cfg.used ?? ''}
                                    onChange={(e) => setRow(line.lineId, { used: e.target.value.replace(/[^0-9]/g, '') })}
                                  />
                                  <div className="text-[10px] text-muted-foreground">
                                    auto: {autoUsed}
                                  </div>
                                  {usedOver && <div className="text-[10px] text-destructive">exceeds pending</div>}
                                  {line.trackByWeight && (() => {
                                    // Auto-compute loss exactly like the design rows:
                                    //   loss = pending − used − returned − runners
                                    // Operator can override (lossManual). Returned
                                    // weight included so the math stays consistent
                                    // when vendor sends some intact + some used.
                                    const pendW = Number(line.pendingWeight ?? 0);
                                    const usedW = Number(cfg.usedWeight || 0);
                                    const retW  = cfg.excessMode === 'return' ? Number(cfg.returnWeight || 0) : 0;
                                    const runW  = Number(cfg.runnersWeight || 0);
                                    const autoLoss = pendW > 0
                                      ? Math.round((pendW - usedW - retW - runW) * 1000) / 1000
                                      : 0;
                                    const lossDisplay = cfg.lossManual
                                      ? cfg.lossWeight
                                      : (autoLoss > 0 ? autoLoss.toFixed(3) : '0.000');
                                    return (
                                      <div className="mt-1 space-y-1">
                                        <div className="inline-flex items-center gap-1">
                                          <Input type="number" min={0} step="0.001"
                                            className="h-7 w-24 text-right text-xs"
                                            placeholder="0.000"
                                            value={cfg.usedWeight ?? ''}
                                            onChange={(e) => setRow(line.lineId, { usedWeight: e.target.value })}
                                          />
                                          <span className="text-[10px] text-muted-foreground">g used</span>
                                        </div>
                                        <div className="inline-flex items-center gap-1">
                                          <Input type="number" min={0} step="0.001"
                                            className="h-7 w-24 text-right text-xs"
                                            placeholder="0.000"
                                            value={cfg.runnersWeight ?? ''}
                                            onChange={(e) => setRow(line.lineId, { runnersWeight: e.target.value })}
                                          />
                                          <span className="text-[10px] text-muted-foreground">g runners</span>
                                        </div>
                                        <div className="inline-flex items-center gap-1">
                                          <Input type="number" step="0.001"
                                            className="h-7 w-24 text-right text-xs"
                                            placeholder="0.000"
                                            value={lossDisplay}
                                            onChange={(e) => setRow(line.lineId, { lossWeight: e.target.value, lossManual: true })}
                                          />
                                          <span className="text-[10px] text-muted-foreground">g loss</span>
                                        </div>
                                      </div>
                                    );
                                  })()}
                                </td>
                                <td className="px-3 py-2 text-right align-top">
                                  <div className="font-semibold text-foreground tabular-nums">{excess}</div>
                                  <div className="text-[10px] text-muted-foreground">left over</div>
                                </td>
                                <td className="px-3 py-2 align-top">
                                  {excess === 0 ? (
                                    <span className="text-[11px] text-muted-foreground">— no excess —</span>
                                  ) : (
                                    <div className="inline-flex flex-wrap items-center gap-2">
                                      <button type="button"
                                        onClick={() => setRow(line.lineId, { excessMode: 'keep', returnQty: '' })}
                                        className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                                          !isReturn
                                            ? 'border-slate-400 bg-secondary/50 text-foreground'
                                            : 'border-transparent text-text-muted hover:bg-secondary/50'
                                        }`}>
                                        ✋ Vendor keeping
                                      </button>
                                      <button type="button"
                                        onClick={() => setRow(line.lineId, { excessMode: 'return', returnQty: String(excess) })}
                                        className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors ${
                                          isReturn
                                            ? 'border-emerald-400 bg-success/15 text-success'
                                            : 'border-transparent text-success hover:bg-success/15'
                                        }`}>
                                        🔄 Vendor returning
                                      </button>
                                      {isReturn && (
                                        <span className="inline-flex flex-wrap items-center gap-1 text-[11px] text-success">
                                          <Input type="number" min={0} max={excess} step="1"
                                            className={`h-7 w-20 text-right ${retOver ? 'border-red-300 bg-destructive/10' : ''}`}
                                            value={cfg.returnQty ?? ''}
                                            onChange={(e) => setRow(line.lineId, { returnQty: e.target.value.replace(/[^0-9]/g, '') })}
                                          />
                                          <span className="text-[10px] text-muted-foreground">/ {excess}</span>
                                          {line.trackByWeight && (
                                            <span className="ml-1 inline-flex items-center gap-1">
                                              <Input type="number" min={0} step="0.001"
                                                className="h-7 w-24 text-right"
                                                placeholder="0.000"
                                                value={cfg.returnWeight ?? ''}
                                                onChange={(e) => setRow(line.lineId, { returnWeight: e.target.value })}
                                              />
                                              <span className="text-[10px] text-muted-foreground">g back</span>
                                            </span>
                                          )}
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right align-top text-xs">
                                  <div className="space-y-0.5">
                                    {used > 0 && (
                                      <div className="text-info tabular-nums">{used} used</div>
                                    )}
                                    {ret > 0 && (
                                      <div className="text-success tabular-nums">Stock +{ret}</div>
                                    )}
                                    {kept > 0 && (
                                      <div className="text-warning tabular-nums">{kept} stays with vendor</div>
                                    )}
                                    {used === 0 && ret === 0 && kept === 0 && (
                                      <div className="text-muted-foreground">—</div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="border-t border-warning/30 bg-warning/15">
                            <td colSpan={5} className="px-3 py-1.5 text-xs font-semibold text-warning">Voucher total</td>
                            <td className="px-3 py-1.5 text-right text-xs">
                              <span className="text-info font-semibold">{lineTotals.used} used</span>
                              {' · '}
                              <span className="text-success font-semibold">+{lineTotals.ret} returned</span>
                              {' · '}
                              <span className="text-warning font-semibold">{lineTotals.kept} kept</span>
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
    {/* Report Missing Parts — scoped to the stage the operator clicked.
        Renders outside the main Dialog so the modal stacking works. */}
    <ReportMissingPartsDialog
      stageId={missingCtx?.stageId ?? null}
      itemId={missingCtx?.itemId ?? null}
      designCode={missingCtx?.designCode ?? null}
      open={!!missingCtx}
      onClose={() => setMissingCtx(null)}
      onReported={() => {
        // Refresh anything that surfaces missing-parts counts (item detail).
        qc.invalidateQueries({ queryKey: ['item'] });
      }}
    />
    </>
  );
}

/**
 * Final Casting weight popup — opens after a receipt save when the just-
 * received items still have a "casting weight temporary" marker on their
 * Item Master notes. Operator types the actual per-piece weight (measured
 * on the returned cast pieces). Backend overwrites the master weight AND
 * strips the marker; on the NEXT receive of the same item, the popup
 * doesn't fire because the marker is gone.
 *
 * Multiple items show as a list; each row has its own confirm. "Skip"
 * leaves the marker on for that item (will prompt again on next receive).
 */
function FinalCastingWeightDialog({
  items,
  onDone,
}: {
  items: Array<{ itemId: number; itemNumber: string | null; sampleDesignCode: string; currentWeight: number }>;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  // Per-row input. Pre-filled with the current (temporary) weight so the
  // common "yes, that estimate was right" case is one click.
  const [weights, setWeights] = React.useState<Record<number, string>>(() => {
    const out: Record<number, string> = {};
    for (const it of items) out[it.itemId] = it.currentWeight ? String(it.currentWeight) : '';
    return out;
  });
  // Track which items have been finalised this session — we hide them from
  // the list once saved so the operator sees what's left.
  const [done, setDone] = React.useState<Set<number>>(new Set());

  const finalize = useMutation({
    mutationFn: async (it: { itemId: number; weight: number }) => {
      return Api.casting.finalizeCastingWeight(it);
    },
    onSuccess: (_res, vars) => {
      setDone((s) => new Set([...s, vars.itemId]));
      toast.success(`Final weight saved (${vars.weight}g/pc). Item Master updated.`);
      qc.invalidateQueries({ queryKey: ['items'] });
      qc.invalidateQueries({ queryKey: ['item'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const pending = items.filter((i) => !done.has(i.itemId));
  // Auto-close once every item is handled. Use a microtask so the success
  // toast has a moment to render before the dialog vanishes.
  React.useEffect(() => {
    if (items.length > 0 && pending.length === 0) {
      const t = setTimeout(onDone, 250);
      return () => clearTimeout(t);
    }
  }, [pending.length, items.length, onDone]);

  return (
    <Dialog
      open
      onClose={onDone}
      size="md"
      title="Confirm final Casting weight"
      description="These items had a temporary weight when production started. Weigh one returned piece and type the actual per-piece weight — it's saved to Item Master so the next batch uses the confirmed value."
      footer={
        <Button variant="outline" onClick={onDone}>
          {pending.length === items.length ? 'Skip for now' : pending.length === 0 ? 'Close' : `Close (${pending.length} left)`}
        </Button>
      }
    >
      <div className="space-y-2">
        {pending.map((it) => {
          const val = weights[it.itemId] ?? '';
          const valid = Number(val) > 0;
          return (
            <div key={it.itemId} className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <div>
                  <span className="font-semibold text-foreground">#{it.itemNumber ?? it.sampleDesignCode}</span>
                  {it.itemNumber && it.sampleDesignCode && (
                    <span className="ml-1 text-xs text-muted-foreground">{it.sampleDesignCode}</span>
                  )}
                </div>
                <div className="text-xs text-warning">
                  Temp weight: <b>{it.currentWeight ? `${it.currentWeight}g/pc` : '—'}</b>
                </div>
              </div>
              <div className="mt-1.5 flex flex-wrap items-end gap-2">
                <div className="min-w-[160px] flex-1">
                  <Field label="Final per-piece weight (g)" hint="weigh one returned cast piece">
                    <Input
                      type="number" step="0.001" min="0"
                      value={val}
                      onChange={(e) => setWeights((w) => ({ ...w, [it.itemId]: e.target.value.replace(/[^0-9.]/g, '') }))}
                    />
                  </Field>
                </div>
                <Button
                  className="shrink-0"
                  disabled={!valid || finalize.isPending}
                  onClick={() => finalize.mutate({ itemId: it.itemId, weight: Number(val) })}
                >
                  {finalize.isPending && <Spinner />} Save
                </Button>
              </div>
            </div>
          );
        })}
        {pending.length === 0 && (
          <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
            All weights confirmed. Closing…
          </div>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Post-Packing details dialog — shown after a Packing receipt that
 * auto-allocated one or more item numbers. Prompts for per-variant
 * additional charge + Gross/Less/Net Wt. Operator can Save Now (per
 * variant), Save All, or Save Later (dismisses; details stay pending
 * on the /items list until filled in).
 */
type PackingVariant = {
  id: number;
  variantCode: string;
  birthWeight: any;
  itemId: number;
  item: { itemNumber: string | null; itemName: string | null };
};

function PostPackingDetailsDialog({
  variants,
  onDone,
}: {
  variants: PackingVariant[];
  onDone: () => void;
}) {
  type Row = { addl: string; gross: string; less: string; net: string };
  const [rows, setRows] = React.useState<Record<number, Row>>(() => {
    const out: Record<number, Row> = {};
    for (const v of variants) {
      const bw = v.birthWeight != null ? String(v.birthWeight) : '';
      out[v.id] = { addl: '', gross: bw, less: '', net: bw };
    }
    return out;
  });
  const [done, setDone] = React.useState<Set<number>>(new Set());

  const save = useMutation({
    mutationFn: async (input: { id: number; addl: string; gross: string; less: string; net: string }) => {
      return Api.casting.savePackingDetails(input.id, {
        additionalCharge: input.addl ? Number(input.addl) : null,
        grossWt: input.gross ? Number(input.gross) : null,
        lessWt: input.less ? Number(input.less) : null,
        netWt: input.net ? Number(input.net) : null,
      });
    },
    onSuccess: (_r, vars) => {
      setDone((s) => new Set([...s, vars.id]));
      toast.success('Packing details saved.');
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const saveAll = async () => {
    const toSave = variants.filter((v) => !done.has(v.id));
    for (const v of toSave) {
      const r = rows[v.id];
      if (!r) continue;
      await save.mutateAsync({ id: v.id, ...r });
    }
  };

  const pending = variants.filter((v) => !done.has(v.id));
  React.useEffect(() => {
    if (variants.length > 0 && pending.length === 0) {
      const t = setTimeout(onDone, 250);
      return () => clearTimeout(t);
    }
  }, [pending.length, variants.length, onDone]);

  const update = (id: number, patch: Partial<Row>) =>
    setRows((s) => ({ ...s, [id]: { ...(s[id] ?? { addl: '', gross: '', less: '', net: '' }), ...patch } }));

  return (
    <Dialog
      open
      onClose={() => { /* Save Later — dismiss without persisting */ onDone(); }}
      size="2xl"
      title="Enter post-packing details"
      description="These designs just got their item numbers. Enter per-variant additional charges and Gross / Less / Net weights — or click Save Later to fill them in from the item page."
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-xs text-text-faint">
            {done.size} of {variants.length} saved
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onDone}>Save Later</Button>
            <Button onClick={saveAll} disabled={save.isPending || pending.length === 0}>
              {save.isPending && <Spinner />} Save All
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        {variants.map((v) => {
          const r = rows[v.id] ?? { addl: '', gross: '', less: '', net: '' };
          const isDone = done.has(v.id);
          return (
            <div key={v.id}
              className={`rounded-md border px-3 py-2 ${isDone ? 'border-success/30 bg-success/10' : 'border-border bg-card'}`}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">
                    {v.variantCode}
                    {v.item.itemNumber && <span className="ml-2 text-text-faint font-normal">· {v.item.itemNumber}</span>}
                  </div>
                  {v.item.itemName && <div className="truncate text-[11px] text-text-faint">{v.item.itemName}</div>}
                </div>
                {isDone
                  ? <span className="text-xs font-semibold text-success">✓ Saved</span>
                  : <Button size="sm" variant="outline"
                      onClick={() => save.mutate({ id: v.id, ...r })}
                      disabled={save.isPending}>
                      Save this
                    </Button>}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <label className="text-[11px] text-text-faint">
                  Additional Charge / pc
                  <Input className="mt-0.5 h-8" type="number" step="0.01"
                    value={r.addl} disabled={isDone}
                    onChange={(e) => update(v.id, { addl: e.target.value })} />
                </label>
                <label className="text-[11px] text-text-faint">
                  Gross Wt (g)
                  <Input className="mt-0.5 h-8" type="number" step="0.001"
                    value={r.gross} disabled={isDone}
                    onChange={(e) => update(v.id, { gross: e.target.value })} />
                </label>
                <label className="text-[11px] text-text-faint">
                  Less Wt (g)
                  <Input className="mt-0.5 h-8" type="number" step="0.001"
                    value={r.less} disabled={isDone}
                    onChange={(e) => update(v.id, { less: e.target.value })} />
                </label>
                <label className="text-[11px] text-text-faint">
                  Net Wt (g)
                  <Input className="mt-0.5 h-8" type="number" step="0.001"
                    value={r.net} disabled={isDone}
                    onChange={(e) => update(v.id, { net: e.target.value })} />
                </label>
              </div>
            </div>
          );
        })}
        {pending.length === 0 && (
          <div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
            All variants saved. Closing…
          </div>
        )}
      </div>
    </Dialog>
  );
}
