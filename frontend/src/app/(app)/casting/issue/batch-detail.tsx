'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileDown, XCircle, RotateCcw, ArrowRight, Palette, Trash2, Pencil, ChevronRight, ChevronDown, Plus, AlertTriangle, Share2, Wrench, CheckCircle2, Send } from 'lucide-react';
import Link from 'next/link';
import { ReceiveForm } from '../receipt/receive-form';
import { VariantForm } from '@/app/(app)/materials/variant-form';
import { ReissueMaterialsDialog } from '@/components/shared/reissue-materials-dialog';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Badge } from '@/components/ui/badge';
import { Field } from '@/components/shared/field';
import { CastingStatusBadge } from '@/components/shared/status-badge';
import { Spinner } from '@/components/ui/spinner';
import { cn, formatDate } from '@/lib/utils';
import type { ItemMeta } from '@/lib/types';

// Colour-coded lifecycle status pill (batch + stage).
const STATUS_CLS: Record<string, string> = {
  Issued: 'bg-secondary/50 text-text-muted',
  Pending: 'bg-secondary/50 text-text-muted',
  'In Process': 'bg-info/15 text-info',
  Partial: 'bg-warning/15 text-warning',
  Completed: 'bg-success/15 text-success',
  Closed: 'bg-destructive/15 text-destructive',
};
function ProdStatus({ label }: { label: string }) {
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_CLS[label] ?? 'bg-secondary/50 text-text-muted'}`}>{label}</span>;
}

// Split a whole quantity into k whole-number parts (remainder spread to the first parts).
function splitWhole(total: number, k: number): number[] {
  if (k <= 0) return [];
  const base = Math.floor(total / k);
  const rem = total - base * k;
  return Array.from({ length: k }, (_, i) => base + (i < rem ? 1 : 0));
}

// Visual swatch colour for a track separator dot. Maps common jewellery
// colour names to indicative hex codes; falls back to slate for unknown names.
function colourSwatch(name: string): string {
  const n = (name ?? '').trim().toLowerCase();
  const map: Record<string, string> = {
    gold: '#d4a013', 'bhari gold': '#c9920c', 'matt gold': '#caa84a',
    rose: '#e9967a', 'rose gold': '#e0997a',
    silver: '#c0c0c0', rhodium: '#d6d6e0',
    ruby: '#c0182f', red: '#dc2626',
    green: '#16a34a', emerald: '#10b981', meena: '#0ea96b',
    blue: '#2563eb', sapphire: '#1e40af',
    white: '#f8fafc', cream: '#f5edd6',
    black: '#1f2937',
    pink: '#ec4899',
    yellow: '#eab308',
    orange: '#f97316',
    purple: '#9333ea', violet: '#7c3aed',
    antique: '#8a6a35', rajwadi: '#a8742a',
    copper: '#b87333', bronze: '#cd7f32',
  };
  return map[n] ?? '#94a3b8';
}

// Dialog to forward a stage's received pieces to the next process (= issue slip).
// Colour steps (Plating/Meena/Fitting/Mala/Sticking) allow MULTIPLE colours — the
// quantity is split into whole numbers across them, and each colour becomes its own
// issue (its own vendor + slip). Non-colour steps forward as a single issue.
function ForwardDialog({ stage, open, onClose, onDone }: { stage: any; open: boolean; onClose: () => void; onDone: () => void }) {
  const [processId, setProcessId] = React.useState<number | ''>('');
  const [vendorId, setVendorId] = React.useState<number | ''>('');   // non-colour steps only
  const [vendorRef, setVendorRef] = React.useState('');               // non-colour steps only
  const [quantity, setQuantity] = React.useState('');
  const [weight, setWeight] = React.useState('');      // per-piece weight for the NEXT process
  const [totalWeight, setTotalWeight] = React.useState(''); // manual override for KG steps
  const [rate, setRate] = React.useState('');          // non-colour: rate/kg or cost/pc
  const [colors, setColors] = React.useState<string[]>([]); // colour steps: multi-select
  // Operator-typed colours that aren't in Item Master's procColours yet.
  // Rendered above the procColours list (with a "NEW" badge) and treated
  // exactly like a master colour at submit time — backend's
  // ensureProcessVendor persists them silently when the forward fires.
  const [customColours, setCustomColours] = React.useState<Array<{ color: string; vendorId: number }>>([]);
  const [newColourName, setNewColourName] = React.useState('');
  const [newColourVendorId, setNewColourVendorId] = React.useState<number | ''>('');
  const [colorQty, setColorQty] = React.useState<Record<string, string>>({}); // editable per-colour qty
  const [colorVendor, setColorVendor] = React.useState<Record<string, number>>({}); // per-colour vendor override
  const [bringsOwnMaterials, setBringsOwnMaterials] = React.useState(false); // sticking: vendor brings own raw materials
  const [bufferPercent, setBufferPercent] = React.useState('0'); // sticking: extra % over BOM
  // Forward (issue) date — operator can backdate when recording an issue
  // that physically happened on an earlier day. Defaults to today on open.
  const [forwardDate, setForwardDate] = React.useState<string>(() => new Date().toISOString().slice(0, 10));
  // Order purpose for the next stage — pre-filled from source stage on
  // open so the customer/order label carries forward automatically.
  // Operator can re-target when actually splitting one line into orders.
  const [purpose, setPurpose] = React.useState('');
  // Karigar-inclusive rate when brings-own is on. Empty = use the item-master
  // default (per-colour for colour steps, the `rate` state for non-colour).
  // Filled = override applied uniformly across colours when forwarding.
  const [karigarRateOverride, setKarigarRateOverride] = React.useState('');
  // Open the Material Variant create dialog from within the BOM preview, for
  // when the user realises a material needs to exist but doesn't yet.
  const [newVariantOpen, setNewVariantOpen] = React.useState(false);

  // Local query client used to refetch the BOM preview when the user creates
  // a new variant inline (so it appears in dropdowns without page reload).
  const qcLocal = useQueryClient();
  // sticking: editable qty per material variant (variantId → string for free typing).
  // Empty/unset → BOM × qty × (1 + buffer%) default is used on the server.
  const [materialOverride, setMaterialOverride] = React.useState<Record<number, string>>({});
  // Vendor-level rate cache for the CURRENT target process. Populated
  // lazily when a vendor is referenced (single-vendor pick OR per-colour
  // vendor) and its (item × vendor) master rate is blank. Reflects the
  // "Krishna does plating at ₹950/kg for everything" pattern — operator
  // picks vendor, system pre-fills the rate from that vendor's most
  // recent usage across any item. Operator override always wins.
  const [vendorRateCache, setVendorRateCache] = React.useState<Record<number, number>>({});
  // Sticking BOM AUTO-CAPTURE — when this dialog opens for a Sticking target
  // and the Item Master has no BOM for the chosen colour, this picker lets
  // the operator add BOM rows inline (material variant + qty/pc). On submit
  // the rows are sent as `bomCapture` and the backend persists them to
  // ItemMaterial BEFORE running the normal snapshot + auto-issue. Keyed by
  // a tmp _key (timestamps would break workflow resume, hence index-based).
  const [bomCaptureRows, setBomCaptureRows] = React.useState<Array<{ _key: number; variantId: number | ''; perPiece: string }>>([]);
  // Ad-hoc materials to issue WITH this forward — for Filing / Polish (or
  // any process where operator wants to send materials alongside the
  // work). One MaterialIssue voucher per forward; operator can re-issue
  // later from /material-issues if more is needed.
  const [extraMaterialRows, setExtraMaterialRows] = React.useState<Array<{ _key: number; variantId: number | ''; qty: string; weight: string; notes: string }>>([]);
  const newExtraRow = () => ({ _key: Math.random(), variantId: '' as number | '', qty: '', weight: '', notes: '' });

  const metaQ = useQuery<ItemMeta>({ queryKey: ['item-meta'], queryFn: () => Api.items.meta(), enabled: open });
  // Hide steps already done in this line (the source stage carries the line's process codes).
  const doneCodes: string[] = stage?.lineCodes ?? [];
  // Next-process options: hide processes already done on this line (from
  // `doneCodes`), the CAD designer-category (not a production step), the
  // RAW_MATERIAL_SUPPLIER supplier-category, and retired rows. Casting
  // stays — it's a valid next step out of CAM.
  const processes = (metaQ.data?.processes ?? []).filter(
    (p) =>
      (p as any).status !== 'INACTIVE' &&
      p.code !== 'CAD' &&
      p.code !== 'RAW_MATERIAL_SUPPLIER' &&
      !doneCodes.includes(p.code),
  );
  const targetProc = processes.find((p) => p.id === Number(processId));
  const isKg = targetProc?.costUnit === 'KG';
  const targetIsSticking = targetProc?.code === 'STICKING';
  // BOM-capable target — any process the Process master flags bomCapable.
  // Historically only STICKING had the inline BOM UI; user wants the same
  // shape (BOM capture picker + issue voucher + karigar rate override +
  // brings-own-materials toggle) available on every BOM-capable process
  // (KACHA_FITTING, FITTING_MALA today; whatever admins flag tomorrow).
  const targetIsBomCapable = !!(targetProc as any)?.bomCapable;
  const allVendors = metaQ.data?.allVendors ?? [];
  // Vendor pool for the forward pickers below. Three-tier fallback matches
  // the reference implementation so the dropdown never renders empty:
  //   (1) vendors configured on the ITEM for the target process (procVendors)
  //   (2) vendors tagged with that process at master level (targetProc.vendors)
  //   (3) every active vendor
  // Coerced to the shape the picker expects: { vendorId, vendorCode, vendorName }.
  const targetVendorPool: any[] = (() => {
    if (targetProc?.vendors?.length) {
      return targetProc.vendors.map((v: any) => ({
        vendorId: v.id ?? v.vendorId, id: v.id ?? v.vendorId,
        vendorCode: v.vendorCode, vendorName: v.vendorName,
      }));
    }
    return allVendors.map((v: any) => ({
      vendorId: v.id, id: v.id, vendorCode: v.vendorCode, vendorName: v.vendorName,
    }));
  })();
  // Variants list — drives both the inline Sticking BOM picker AND the
  // ad-hoc material issue picker (Filing / Polish / any non-Sticking).
  // Loaded once the dialog is open so the picker is responsive when the
  // operator decides to add materials mid-form.
  const variantsQ = useQuery({
    queryKey: ['variants-active'],
    queryFn: () => Api.materials.variants(),
    enabled: open,
    staleTime: 60_000,
  });
  const variants = variantsQ.data ?? [];

  // NOTE: filing-kit auto-load was removed per operator feedback —
  // materials were auto-appearing on processes that don't consume them
  // (Casting, Die Number, etc.) because eligible variants were tagged
  // for too many processes, and even removed rows sometimes leaked into
  // the receipt as "issued". Materials are now strictly opt-in via
  // "+ Add material" — the operator decides.

  // Design blueprint — to read the per-colour vendor/ref/rate and the vendor prefill.
  // staleTime:0 + refetchOnWindowFocus so when the user comes back from the
  // Item Master tab (after clicking "Add colour in Item Master"), the new
  // colour shows up without manual reload. The BroadcastChannel listener
  // below additionally pushes the refetch WITHOUT requiring tab focus.
  const itemQ = useQuery({
    queryKey: ['item', stage?.itemId],
    queryFn: () => Api.items.get(stage.itemId),
    enabled: open && !!stage?.itemId,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  // Cross-tab live sync — Item Master save (in another tab) broadcasts
  // `{ type: 'item-saved', itemId }` and we refetch ours instantly so the
  // colour list updates without the user having to switch tabs.
  const qcSync = useQueryClient();
  React.useEffect(() => {
    if (!open || !stage?.itemId) return;
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel('item-updates');
    ch.onmessage = (ev) => {
      if (ev.data?.type === 'item-saved' && ev.data?.itemId === stage.itemId) {
        qcSync.invalidateQueries({ queryKey: ['item', stage.itemId] });
        qcSync.invalidateQueries({ queryKey: ['item-meta'] });
        itemQ.refetch();
      }
    };
    return () => ch.close();
  }, [open, stage?.itemId, qcSync]);
  // Belt-and-suspenders refresh: every time the dialog gains focus or
  // becomes visible (e.g. user tabs back from Item Master), force a fresh
  // pull. Some browsers don't reliably fire `refetchOnWindowFocus` between
  // tabs of the same window — this listener fires for both window focus
  // AND visibility changes, covering both scenarios.
  React.useEffect(() => {
    if (!open || !stage?.itemId) return;
    const onActive = () => {
      if (document.visibilityState === 'visible') itemQ.refetch();
    };
    window.addEventListener('focus', onActive);
    document.addEventListener('visibilitychange', onActive);
    return () => {
      window.removeEventListener('focus', onActive);
      document.removeEventListener('visibilitychange', onActive);
    };
  }, [open, stage?.itemId]); // eslint-disable-line react-hooks/exhaustive-deps
  const procVendors: any[] = React.useMemo(() => {
    if (!itemQ.data || !processId) return [];
    const proc = (itemQ.data.processes ?? []).find((p: any) => p.processId === Number(processId));
    return proc?.vendors ?? [];
  }, [itemQ.data, processId]);
  // Distinct colour options for the target process (each carries its vendor/ref/rate).
  const procColours: any[] = React.useMemo(() => {
    const m = new Map<string, any>();
    for (const v of procVendors) { const nm = (v.color ?? '').trim(); if (nm && !m.has(nm.toLowerCase())) m.set(nm.toLowerCase(), v); }
    return Array.from(m.values());
  }, [procVendors]);
  // Target process is colour-bearing whenever the Process master flags it
  // as such (Plating, Meena, Fitting, Mala, Sticking — see
  // backend/processes.service.ts COLOUR_PROCESSES). We treat it as a
  // colour step EVEN WHEN the item's master has no colours yet — in that
  // case the "+ Add colour" composer is the primary path so the operator
  // can type a colour + pick a vendor inline without round-tripping to
  // Item Master. Without this widening, a fresh item being forwarded to
  // Plating fell into the non-colour single-vendor branch silently and
  // the slip went out without a colour at all.
  const targetUsesColor = !!targetProc?.usesColor;
  const isColourStep = procColours.length > 0 || targetUsesColor;

  React.useEffect(() => {
    if (open && stage) {
      setProcessId(''); setVendorId(''); setVendorRef('');
      setQuantity(String(stage.availableToForward ?? ''));
      // Carry the ACTUAL per-piece weight forward (sum of physical
      // receipt weights ÷ sum of physical receipt qtys). This is what
      // the karigar actually weighed at receive time — vs stage.receivedWeight
      // which is settledQty × the stage's ORIGINAL planned per-pc (so it
      // ignores any casting-loss / plating-gain the operator typed in).
      // Cascades through every process: each receive captures the new
      // physical weight, each forward carries that average per-pc into
      // the next stage as its new planned weight.
      const rawWt = Number(stage.rawReceivedWeight ?? 0);
      const rawQty = Number(stage.rawReceivedQty ?? 0);
      const actualPerPc = rawWt > 0 && rawQty > 0
        ? rawWt / rawQty
        : Number(stage.weight ?? 0);
      const qtyN = Number(stage.availableToForward ?? 0);
      setWeight(actualPerPc ? String(Math.round(actualPerPc * 1000) / 1000) : '');
      // Auto-init Total Wt = per-pc × qty so the operator sees a sensible
      // default instead of an empty input. Operator can override (they
      // weigh the whole lot when received, so the actual is the truth).
      const initTotal = actualPerPc > 0 && qtyN > 0
        ? Math.round(actualPerPc * qtyN * 1000) / 1000
        : 0;
      setTotalWeight(initTotal > 0 ? String(initTotal) : '');
      setRate(''); setColors([]); setBringsOwnMaterials(false); setBufferPercent('0'); setColorVendor({});
      setCustomColours([]); setNewColourName(''); setNewColourVendorId('');
      setMaterialOverride({});
      setBomCaptureRows([]);
      setExtraMaterialRows([]);
      setVendorRateCache({});
      setKarigarRateOverride('');
      // Default the forward date to today every time the dialog opens —
      // operator can backdate if the issue physically happened earlier.
      setForwardDate(new Date().toISOString().slice(0, 10));
      // Pre-fill purpose from source stage so customer info follows the
      // line forward without re-typing.
      setPurpose(stage.purpose ?? '');
    }
  }, [open, stage]);

  // On process change: colour step → preselect the preferred (first) colour
  // when master has any; for a colour-bearing target with NO master colours,
  // leave the picker empty so the "+ Add colour" composer becomes the
  // visible path (operator must type a new colour + vendor inline). For
  // non-colour targets, prefill the preferred/first vendor for the
  // single-issue path.
  React.useEffect(() => {
    if (!processId) { setVendorId(''); setVendorRef(''); setRate(''); setColors([]); return; }
    if (procColours.length) {
      setColors([procColours[0].color]);
      setVendorId(''); setVendorRef(''); setRate('');
      // For sticking, the toggle defaults to the first colour vendor's master flag.
      if (targetIsSticking) setBringsOwnMaterials(!!procColours[0].bringsOwnMaterials);
    } else if (targetUsesColor) {
      // Colour-bearing target but no colours configured yet. Stay in
      // colour mode so the composer renders; operator must add one.
      setColors([]);
      setVendorId(''); setVendorRef(''); setRate('');
      setBringsOwnMaterials(false);
    } else {
      const pref = procVendors.find((v: any) => v.isPreferred) ?? procVendors[0];
      setColors([]);
      setVendorId(pref?.vendorId ?? '');
      setVendorRef(pref?.vendorDesignReference ?? '');
      setRate(pref?.costPerPiece != null ? String(pref.costPerPiece) : '');
      if (targetIsSticking) setBringsOwnMaterials(!!pref?.bringsOwnMaterials);
    }
  }, [processId, procColours.length, targetUsesColor]); // eslint-disable-line react-hooks/exhaustive-deps

  const qty = Number(quantity || 0);
  const wt = Number(weight || 0);
  const toggleColour = (name: string) =>
    setColors((cs) => (cs.includes(name) ? cs.filter((c) => c !== name) : [...cs, name]));

  // Splits we'll actually send to the server — colour step splits per colour qty,
  // single-issue step is one split with the full quantity. Reused for BOM preview
  // and for the proportional materialIssueOverride sent per stage.
  const issueSplits: { color: string | null; quantity: number }[] = isColourStep
    ? colors.map((c) => ({ color: c, quantity: Number(colorQty[c] || 0) })).filter((s) => s.quantity > 0)
    : qty > 0 ? [{ color: null, quantity: qty }] : [];
  const totalIssueQty = issueSplits.reduce((s, x) => s + x.quantity, 0);

  // Fetch BOM × qty preview when forwarding to Sticking (and not "brings own").
  // Re-runs when colours / quantities / buffer change so defaults stay live.
  const bomPreviewQ = useQuery({
    queryKey: ['sticking-bom-preview', stage?.itemId, JSON.stringify(issueSplits), bufferPercent],
    queryFn: () => Api.casting.previewStickingIssue({
      itemId: stage!.itemId,
      splits: issueSplits.map((s) => ({ color: s.color, quantity: s.quantity })),
      bufferPercent: Number(bufferPercent || 0),
    }),
    enabled: open && targetIsBomCapable && !bringsOwnMaterials && !!stage?.itemId && totalIssueQty > 0,
  });

  // Primary vendor for the sticking issue — used to fetch their existing
  // material holdings so the BOM preview can subtract "vendor already has X".
  // For multi-vendor colour splits, picks the first split's vendor; the UI
  // shows a note when other splits go elsewhere.
  const primaryVendorId: number | null = React.useMemo(() => {
    if (!targetIsBomCapable || bringsOwnMaterials) return null;
    if (isColourStep) {
      // First selected colour with qty > 0.
      const firstSplit = colors.find((c) => Number(colorQty[c] || 0) > 0);
      if (!firstSplit) return null;
      const overrideId = colorVendor[firstSplit];
      if (overrideId) return overrideId;
      const auto = procColours.find((v) => (v.color ?? '').trim().toLowerCase() === firstSplit.trim().toLowerCase());
      return auto?.vendorId ?? null;
    }
    return vendorId ? Number(vendorId) : null;
  }, [targetIsBomCapable, bringsOwnMaterials, isColourStep, colors, colorQty, colorVendor, procColours, vendorId]);
  const vendorHoldingsQ = useQuery({
    queryKey: ['vendor-holdings', primaryVendorId],
    queryFn: () => Api.materialIssues.vendorHoldings(primaryVendorId!),
    enabled: open && primaryVendorId != null,
  });
  const heldByVariant = React.useMemo(() => {
    const m = new Map<number, number>();
    for (const h of (vendorHoldingsQ.data ?? []) as any[]) {
      m.set(h.variantId, (m.get(h.variantId) ?? 0) + Number(h.qty));
    }
    return m;
  }, [vendorHoldingsQ.data]);

  // Auto-pre-fill the override map with "min new" qty when the vendor already
  // holds materials — so the submit uses the reduced qty rather than the
  // server's default of BOM × buffer (which would over-issue).
  React.useEffect(() => {
    if (!targetIsBomCapable || bringsOwnMaterials) return;
    if (!bomPreviewQ.data?.lines?.length) return;
    if (heldByVariant.size === 0) return;
    const buffer = Number(bufferPercent || 0);
    setMaterialOverride((m) => {
      const next = { ...m };
      let changed = false;
      for (const ln of bomPreviewQ.data!.lines) {
        const held = heldByVariant.get(ln.variantId) ?? 0;
        if (held <= 0) continue;
        // Only set if the user hasn't already typed an override.
        if (next[ln.variantId] !== undefined) continue;
        const need = Math.max(0, ln.required - held);
        const minNew = Math.max(0, Math.ceil(need * (1 + buffer / 100)));
        next[ln.variantId] = String(minNew);
        changed = true;
      }
      return changed ? next : m;
    });
  }, [bomPreviewQ.data, heldByVariant, bufferPercent, targetIsBomCapable, bringsOwnMaterials]);

  // When the colour selection or total qty changes, pre-fill an equal whole-number
  // split; the per-colour quantities remain individually editable afterwards.
  React.useEffect(() => {
    if (!isColourStep || !colors.length) { setColorQty({}); return; }
    const parts = splitWhole(qty, colors.length);
    const next: Record<string, string> = {};
    colors.forEach((c, i) => { next[c] = String(parts[i]); });
    setColorQty(next);
  }, [colors.join('|'), quantity, isColourStep]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazily fill the vendor-rate cache for every vendor referenced in this
  // dialog whose (item × vendor) master row has no rate. Covers single-
  // vendor path AND each colour-vendor pick. Fires once per (vendor,
  // processId) — cached in state. Skipped if rate already known.
  React.useEffect(() => {
    if (!processId) return;
    const need = new Set<number>();
    if (vendorId && !isColourStep) {
      // Non-colour path — single vendor; only fetch if no master rate.
      const masterVend = procVendors.find((v: any) => v.vendorId === Number(vendorId));
      if (!masterVend || masterVend.costPerPiece == null || masterVend.costPerPiece === 0) {
        need.add(Number(vendorId));
      }
    }
    if (isColourStep) {
      for (const c of procColours) {
        const overrideId = colorVendor[c.color];
        const vid = overrideId ?? c.vendorId;
        if (!vid) continue;
        // Only fetch when this (colour × vendor) has no rate in master.
        if (overrideId || c.costPerPiece == null || c.costPerPiece === 0) {
          need.add(Number(vid));
        }
      }
      for (const cc of customColours) {
        if (cc.vendorId) need.add(Number(cc.vendorId));
      }
    }
    const toFetch = Array.from(need).filter((vid) => vendorRateCache[vid] == null);
    if (!toFetch.length) return;
    let cancelled = false;
    Promise.all(
      toFetch.map((vid) =>
        Api.casting.vendorRate(vid, Number(processId)).then((r) => ({ vid, rate: r.rate })).catch(() => null),
      ),
    ).then((results) => {
      if (cancelled) return;
      const next: Record<number, number> = {};
      for (const res of results) {
        if (res && res.rate != null && res.rate > 0) next[res.vid] = res.rate;
      }
      if (Object.keys(next).length) {
        setVendorRateCache((c) => ({ ...c, ...next }));
      }
    });
    return () => { cancelled = true; };
  }, [vendorId, processId, isColourStep, procColours, colorVendor, customColours, procVendors]); // eslint-disable-line react-hooks/exhaustive-deps

  // Non-colour path: auto-fill the rate field once the cache lands, if the
  // operator hasn't typed one yet. Only fires when master rate is null too
  // (otherwise the existing prefill effect already handled it).
  React.useEffect(() => {
    if (isColourStep || !vendorId || rate !== '') return;
    const masterVend = procVendors.find((v: any) => v.vendorId === Number(vendorId));
    if (masterVend?.costPerPiece != null && Number(masterVend.costPerPiece) > 0) return;
    const cached = vendorRateCache[Number(vendorId)];
    if (cached != null && cached > 0) setRate(String(cached));
  }, [vendorRateCache, vendorId, isColourStep]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-colour parts (from the editable quantities). Vendor falls back to the
  // colour's master vendor unless the user picked an override in the dropdown.
  const splits = colors.map((c) => {
    const auto = procColours.find((x) => (x.color ?? '').trim().toLowerCase() === c.trim().toLowerCase());
    const overrideId = colorVendor[c];
    const overrideVendor = overrideId
      ? allVendors.find((av: any) => av.id === overrideId)
      : null;
    const vendor = overrideVendor
      ? {
          vendorId: overrideVendor.id,
          vendorCode: overrideVendor.vendorCode,
          vendorName: overrideVendor.vendorName,
          // Keep auto-colour's ref/cost since the master row is keyed by colour+vendor.
          vendorDesignReference: auto?.vendorDesignReference,
          costPerPiece: auto?.costPerPiece,
          bringsOwnMaterials: auto?.bringsOwnMaterials,
        }
      : auto;
    const q = Number(colorQty[c] || 0);
    // When the karigar-rate override is filled (brings-own + sticking), it
    // wins over the colour's master rate so the user can record a one-off
    // price change without editing the item master.
    const overrideRate = targetIsBomCapable && bringsOwnMaterials && karigarRateOverride !== ''
      ? Number(karigarRateOverride)
      : null;
    // Fallback chain: karigar override → master rate for (item × vendor) →
    // vendor-level cache (vendor's most recent rate for this process across
    // any item) → 0. Reflects "Krishna does plating at ₹950/kg for everything"
    // pattern when a colour's master row has no rate yet.
    const vendorCacheRate = vendor?.vendorId ? vendorRateCache[vendor.vendorId] : undefined;
    const r = overrideRate != null ? overrideRate
      : vendor?.costPerPiece != null ? Number(vendor.costPerPiece)
      : vendorCacheRate != null ? vendorCacheRate
      : 0;
    const cost = isKg ? (wt * q) * r : r * q;
    return { color: c, qty: q, vendor, rate: r, cost };
  });
  const splitSum = splits.reduce((a, s) => a + s.qty, 0);

  const totalCost = isColourStep
    ? splits.reduce((s, x) => s + x.cost, 0)
    : (isKg ? (wt * qty) * Number(rate || 0) : Number(rate || 0) * qty);

  // Build an override list for ONE forward stage from the user-edited totals,
  // distributing each variant's qty proportionally to that stage's share of the
  // total forwarded qty. Last stage absorbs any rounding remainder so the sum
  // equals the user-typed totals exactly.
  function buildOverrideForStage(stageQty: number, stageIndex: number, totalStages: number) {
    if (!targetIsBomCapable || bringsOwnMaterials) return undefined;
    const lines = bomPreviewQ.data?.lines ?? [];
    if (!lines.length || totalIssueQty <= 0) return undefined;
    const result: { variantId: number; issuedQty: number }[] = [];
    for (const ln of lines) {
      const raw = materialOverride[ln.variantId];
      // Only send the variants the user actually touched — server falls back to
      // BOM × qty × (1 + buffer%) for everything else.
      if (raw === undefined || raw === '') continue;
      const total = Math.max(0, Math.trunc(Number(raw) || 0));
      const share = stageIndex === totalStages - 1
        ? total - Math.floor(total * ((totalIssueQty - stageQty) / totalIssueQty))
        : Math.floor(total * (stageQty / totalIssueQty));
      result.push({ variantId: ln.variantId, issuedQty: Math.max(0, share) });
    }
    return result.length ? result : undefined;
  }

  // Ref-lock against double-click. `forward.isPending` only flips AFTER the
  // mutation starts, leaving a race window where two rapid clicks both pass
  // the `disabled={forward.isPending}` check and fire two parallel
  // forwardStage calls — that's how B0046's Meena went from 108 → 216
  // (two child stages of 108 pcs each to the same vendor). The ref flips
  // synchronously inside the click handler so the second click bails before
  // React rerenders.
  const submittingRef = React.useRef(false);
  const forward = useMutation({
    mutationFn: async () => {
      if (!processId) throw new Error('Choose the next process.');
      if (qty <= 0) throw new Error('Enter a quantity.');
      if (qty > (stage.availableToForward ?? 0)) throw new Error(`Only ${stage.availableToForward} available to forward.`);
      // Collected across all forward calls (one per colour for colour steps,
      // a single call for non-colour) so we can fire toasts at the end.
      const rateUpdates: any[] = [];
      // Sticking BOM auto-capture rows (operator picked materials inline
      // because Item Master had no BOM for this design × colour). Only
      // sent when targetIsSticking + the picker actually has rows. On a
      // multi-colour forward, the BOM applies to the FIRST colour the
      // operator captured for — subsequent colours skip it (backend
      // dedups on (item × process × variant × color) anyway). For single-
      // colour or non-colour forwards, the BOM goes on the single call.
      const bomCaptureClean = bomCaptureRows
        .filter((r) => r.variantId !== '' && Number(r.perPiece) > 0)
        .map((r) => ({ variantId: Number(r.variantId), perPiece: Math.max(1, Math.round(Number(r.perPiece))) }));
      // Ad-hoc materials — sent on the FIRST forward call only (one issue
      // voucher per forward action; sub-colour splits inherit the original
      // voucher's stage linkage via the slip-grouping logic on the backend).
      const extraMaterialsClean = extraMaterialRows
        .filter((r) => r.variantId !== '' && (Number(r.qty) > 0 || Number(r.weight) > 0))
        .map((r) => ({
          variantId: Number(r.variantId),
          issuedQty: r.qty ? Math.max(0, Math.trunc(Number(r.qty))) : undefined,
          issuedWeight: r.weight ? Number(r.weight) : undefined,
          notes: r.notes || undefined,
        }));
      // Rate is required on every forward — UNLESS the assigned vendor is
      // in-house. In-house teams aren't billed per piece/kg, so we skip the
      // guard. For colour splits we evaluate per-colour vendor.
      const isVendorInhouse = (vId: number | '' | null | undefined) => {
        const id = Number(vId);
        if (!id) return false;
        // Look the vendor up in the item's process matrix first; fall back to
        // any vendor in the list (covers ad-hoc inline-picked vendors).
        const match = procVendors.find((v: any) => v.vendorId === id);
        return !!match?.isInhouse;
      };
      if (!isColourStep) {
        if (!isVendorInhouse(vendorId) && (!rate || Number(rate) <= 0)) {
          throw new Error('Rate is required.');
        }
      }
      if (isColourStep) {
        if (!colors.length) throw new Error('Select at least one colour.');
        const active = splits.filter((s) => s.qty > 0);
        if (!active.length) throw new Error('Enter a quantity for at least one colour.');
        if (splitSum > (stage.availableToForward ?? 0)) throw new Error(`Colour quantities total ${splitSum}, but only ${stage.availableToForward} available.`);
        const missingRate = active.filter((s) =>
          !isVendorInhouse(s.vendor?.vendorId) && (!s.rate || Number(s.rate) <= 0),
        );
        if (missingRate.length > 0) {
          throw new Error(`Rate is required for every colour. Missing on: ${missingRate.map((s) => s.color).join(', ')}.`);
        }
        // One issue (stage + slip) per colour with qty > 0; quantities are user-adjustable.
        for (let i = 0; i < active.length; i++) {
          const part = active[i];
          const r = await Api.casting.forwardStage(stage.id, {
            processId: Number(processId), quantity: part.qty,
            vendorId: part.vendor?.vendorId,
            vendorDesignReference: part.vendor?.vendorDesignReference || undefined,
            weight: weight !== '' ? Number(weight) : undefined,
            // Use the COMPUTED rate (includes karigar-rate override when set),
            // not the raw vendor.costPerPiece — otherwise overrides get lost.
            costPerKg: part.rate > 0 ? part.rate : undefined,
            color: part.color,
            bringsOwnMaterials: targetIsBomCapable ? bringsOwnMaterials : undefined,
            materialBufferPercent: targetIsBomCapable && !bringsOwnMaterials ? Number(bufferPercent || 0) : undefined,
            materialIssueOverride: buildOverrideForStage(part.qty, i, active.length),
            // BOM auto-capture only on the FIRST colour-lot call. Backend
            // saves to ItemMaterial with this call's `color`; later colour
            // lots will pick the BOM up from Item Master automatically.
            bomCapture: i === 0 && bomCaptureClean.length > 0 ? bomCaptureClean : undefined,
            // Ad-hoc materials only on the FIRST colour-lot call too —
            // we don't multiply the voucher across colours.
            extraMaterials: i === 0 && extraMaterialsClean.length > 0 ? extraMaterialsClean : undefined,
            forwardDate: forwardDate || undefined,
            purpose: purpose.trim() || undefined,
          });
          for (const u of (r?.rateUpdates ?? [])) rateUpdates.push(u);
        }
        return { count: active.length, rateUpdates };
      }
      if (!vendorId) throw new Error('Choose a vendor.');
      const r = await Api.casting.forwardStage(stage.id, {
        processId: Number(processId), quantity: qty,
        vendorId: Number(vendorId),
        vendorDesignReference: vendorRef || undefined,
        weight: weight !== '' ? Number(weight) : undefined,
        totalWeight: totalWeight !== '' ? Number(totalWeight) : undefined,
        costPerKg: rate !== '' ? Number(rate) : undefined,
        bringsOwnMaterials: targetIsBomCapable ? bringsOwnMaterials : undefined,
        materialBufferPercent: targetIsBomCapable && !bringsOwnMaterials ? Number(bufferPercent || 0) : undefined,
        materialIssueOverride: buildOverrideForStage(qty, 0, 1),
        bomCapture: bomCaptureClean.length > 0 ? bomCaptureClean : undefined,
        extraMaterials: extraMaterialsClean.length > 0 ? extraMaterialsClean : undefined,
        forwardDate: forwardDate || undefined,
        purpose: purpose.trim() || undefined,
      });
      for (const u of (r?.rateUpdates ?? [])) rateUpdates.push(u);
      return { count: 1, rateUpdates };
    },
    onSuccess: (r: any) => {
      submittingRef.current = false;
      toast.success(r.count > 1 ? `Issued in ${r.count} colours — ${r.count} slips created.` : 'Issued to next process (new slip created).');
      // When the operator captured a BOM inline, invalidate the item query
      // so a re-open of this dialog (or the Item Master tab) shows the
      // freshly-saved BOM rows instead of "no BOM configured".
      if (stage?.itemId) {
        qcLocal.invalidateQueries({ queryKey: ['item', stage.itemId] });
        qcLocal.invalidateQueries({ queryKey: ['sticking-bom-preview'] });
      }
      // Auto-rate-sync toasts: when the typed rate updated an item's master
      // rate (because it differed from the previous master value), surface a
      // separate toast per non-silent change with an Undo action that calls
      // the rate-only endpoint to revert.
      for (const u of ((r.rateUpdates ?? []) as any[])) {
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
                qcLocal.invalidateQueries({ queryKey: ['item', u.itemId] });
                qcLocal.invalidateQueries({ queryKey: ['item-meta'] });
              } catch (err) {
                toast.error(getApiError(err).message);
              }
            },
          },
        });
      }
      onDone(); onClose();
    },
    onError: (e: any) => {
      submittingRef.current = false;
      // Raw-material shortage on sticking forward — surface a structured popup
      // with shortage details + a link to Inventory so the user can order more
      // before retrying. The backend throws BadRequestException with a body
      // containing `shortages`.
      const body = e?.response?.data;
      const shortages = body?.shortages ?? body?.message?.shortages;
      if (Array.isArray(shortages) && shortages.length) {
        setStockShortage(shortages);
        return;
      }
      const msg = e instanceof Error && !(e as any).response ? e.message : getApiError(e).message;
      toast.error(msg);
      // "Only N received piece(s) available to forward" means our cached view
      // disagrees with reality (someone else forwarded, or our state is stale).
      // Refresh + close so the user sees the truth instead of stale numbers.
      if (/available to forward/i.test(msg ?? '')) {
        onDone(); // parent invalidates the batch query
        onClose();
      }
    },
  });
  const [stockShortage, setStockShortage] = React.useState<any[] | null>(null);

  if (!stage) return null;
  return (
    <>
    <Dialog open={open} onClose={onClose} size="xl"
      title={`Issue for next process — ${stage.vendorDesignReference || stage.processName}`}
      description={`${stage.availableToForward} received piece(s) available to forward from ${stage.processName}.`}
      footer={<><Button variant="outline" onClick={onClose} disabled={forward.isPending}>Cancel</Button>
        <Button
          onClick={() => {
            // Synchronous ref-lock — second click in the same tick bails
            // immediately, before isPending has a chance to flip.
            if (submittingRef.current || forward.isPending) return;
            submittingRef.current = true;
            forward.mutate();
          }}
          // Hard-block submit when the colour split exceeds available
          // forward qty — surfacing this only as a warning let operators
          // submit anyway and produce an over-allocated batch. Backend
          // also rejects (in the per-call quantity check), but blocking
          // at the button is the obvious UX.
          disabled={
            forward.isPending ||
            (isColourStep && splitSum > (stage.availableToForward ?? 0))
          }
          title={
            isColourStep && splitSum > (stage.availableToForward ?? 0)
              ? `Total across colours (${splitSum}) exceeds available (${stage.availableToForward}). Reduce a row.`
              : undefined
          }
        >
          {forward.isPending && <Spinner />} Issue &amp; Generate Slip
        </Button></>}>
      <div className="space-y-3">
        <div className="grid gap-3 grid-cols-1 md:grid-cols-[1fr_180px]">
          <Field label="Next process"><Select value={processId} onChange={(e) => setProcessId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">— Select —</option>
            {processes.map((p) => <option key={p.id} value={p.id}>{p.name}{p.costUnit === 'KG' ? ' (per g)' : ''}</option>)}
          </Select></Field>
          {/* Issue date — pre-filled to today; backdate when recording
              an issue that physically happened on an earlier day. The
              new stage row's createdAt is set to this date on the server,
              so the per-process date strip in the batch table reflects
              when work actually started, not when it was data-entered. */}
          <Field label="Issue date" hint="defaults to today; backdate if needed">
            <Input type="date" value={forwardDate} onChange={(e) => setForwardDate(e.target.value)} />
          </Field>
        </div>

        {/* Purpose — carried forward from the source stage so customer /
            order context follows the line through every process. Operator
            edits only when re-targeting (rare). Prints on the slip's
            Order Details box below the Grand Total. */}
        <Field label="Purpose" hint="Customer / order / Stock / Sample · carries forward from previous stage">
          <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Mr. Sharma" />
        </Field>

        {/* Total weight is the operator's primary input — they weigh the
            whole lot on the scale before sending. Per-pc weight is derived
            (totalWt / qty) and stored on the row but not asked for. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Quantity" hint={`Max ${stage.availableToForward}`}>
            <Input type="number" value={quantity}
              onChange={(e) => {
                setQuantity(e.target.value);
                const q = Number(e.target.value || 0);
                const tw = Number(totalWeight || 0);
                if (q > 0 && tw > 0) setWeight(String(Math.round((tw / q) * 1000) / 1000));
              }} />
          </Field>
          <Field label="Total Wt (g)" hint="whole-lot weighed weight; per-pc auto-derives">
            <Input type="number" step="0.001"
              value={totalWeight}
              onChange={(e) => {
                setTotalWeight(e.target.value);
                const q = Number(quantity || 0);
                const tw = Number(e.target.value || 0);
                if (q > 0 && tw > 0) setWeight(String(Math.round((tw / q) * 1000) / 1000));
              }} />
          </Field>
        </div>

        {isColourStep ? (
          <Field
            label="Colours for this step"
            hint="Tick colours — qty auto-splits in whole numbers but each is editable; each colour → its own vendor & slip"
            action={
              stage?.itemId && processId ? (
                // flex-wrap so Refresh + "Add colour in Item Master" stack
                // onto two lines instead of overflowing on narrow phone
                // viewports.
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <button
                    type="button"
                    onClick={() => itemQ.refetch()}
                    disabled={itemQ.isFetching}
                    className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-primary disabled:opacity-50"
                    title="Refetch this design's colour list from the server"
                  >
                    <RotateCcw className={`size-3.5 ${itemQ.isFetching ? 'animate-spin' : ''}`} />
                    {itemQ.isFetching ? 'Refreshing…' : 'Refresh'}
                  </button>
                  <a
                    href={`/items/${stage.itemId}/edit?focusProcess=${processId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    title="Open this design in Item Master and jump to this process to define a new colour"
                  >
                    <Plus className="size-3.5" /> Add in Item Master
                  </a>
                </span>
              ) : null
            }
          >
            <div className="space-y-1.5 rounded-lg border border-border p-2">
              {/* Empty-state: master has no colours yet AND operator hasn't
                  added any inline. Render only when both lists are empty.
                  The composer below is the way out — type a colour, pick
                  a vendor, hit Add. Backend will silently mirror it to
                  Item Master via ensureProcessVendor on submit. */}
              {procColours.length === 0 && customColours.length === 0 && (
                <div className="rounded-md border border-dashed border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                  <strong>{targetProc?.name ?? 'This process'} uses colours, but this design has no colours configured for it.</strong>
                  <br />
                  Add one below — colour name + vendor — and it'll save to Item Master automatically when you forward.
                </div>
              )}
              {/* Inline custom colours — appended to the Item Master's
                  procColours list with the same shape so they render
                  identically. When the operator forwards, the backend's
                  ensureProcessVendor silently writes the new (vendor ×
                  colour) row to Item Master, so the colour shows up in
                  procColours next time without this dance. */}
              {customColours.map((c) => (
                <div key={`custom-${c.color}`} className="rounded-md bg-primary/5 px-2 py-1.5 text-sm ring-1 ring-primary/20">
                  <div className="flex items-center justify-between gap-2">
                    {/* Same min-w-0 + two-line treatment as procColours
                        so the "NEW · will save…" badge can wrap below
                        the colour name on a narrow phone instead of
                        pushing the row past the viewport. */}
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                      <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={colors.includes(c.color)} onChange={() => toggleColour(c.color)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-medium">{c.color}</span>
                          <span className="text-[10px] font-semibold text-primary">NEW · will save to Item Master</span>
                        </div>
                      </div>
                    </label>
                    {colors.includes(c.color) && (
                      <div className="flex shrink-0 items-center gap-1">
                        <Input type="number" min={0} className="h-8 w-16 text-right sm:w-20"
                          value={colorQty[c.color] ?? ''}
                          onChange={(e) => setColorQty((m) => ({ ...m, [c.color]: e.target.value }))} />
                        <span className="text-xs text-muted-foreground">pcs</span>
                      </div>
                    )}
                  </div>
                  {colors.includes(c.color) && (
                    <div className="ml-6 mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-muted-foreground">Vendor:</span>
                      <div className="w-full sm:w-64">
                        <SearchableSelect
                          value={colorVendor[c.color] ?? c.vendorId ?? ''}
                          onChange={(val) => setColorVendor((m) => ({ ...m, [c.color]: Number(val) }))}
                          options={(procVendors.length ? procVendors : targetVendorPool).map((vv: any) => ({
                            value: vv.id ?? vv.vendorId,
                            label: `${vv.vendorCode} · ${vv.vendorName}`,
                            keywords: vv.vendorName,
                          }))}
                        />
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {procColours.map((v) => {
                const checked = colors.includes(v.color);
                const effVendorId = colorVendor[v.color] ?? v.vendorId;
                return (
                  <div key={v.id} className="rounded-md px-2 py-1.5 text-sm hover:bg-muted/50">
                    <div className="flex items-center justify-between gap-2">
                      {/* min-w-0 on the label + inner wrapper so long
                          "default V0026 · ₹0.08/pc" strings TRUNCATE
                          instead of forcing the whole row past the
                          viewport on phones. Colour name + (code) stay
                          on the first line; default-vendor metadata moves
                          to a smaller second line below. */}
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                        <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={checked} onChange={() => toggleColour(v.color)} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <span className="font-medium">{v.color}</span>
                            {v.colorCode && <span className="text-xs text-muted-foreground">({v.colorCode})</span>}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            default {v.vendorCode} · {isKg ? `₹${v.costPerPiece}/g` : `₹${v.costPerPiece}/pc`}
                          </div>
                        </div>
                      </label>
                      {checked && (
                        <div className="flex shrink-0 items-center gap-1">
                          <Input type="number" min={0} className="h-8 w-16 text-right sm:w-20"
                            value={colorQty[v.color] ?? ''}
                            onChange={(e) => setColorQty((m) => ({ ...m, [v.color]: e.target.value }))} />
                          <span className="text-xs text-muted-foreground">pcs</span>
                        </div>
                      )}
                    </div>
                    {checked && (
                      <div className="ml-6 mt-1.5 flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-muted-foreground">Vendor:</span>
                        <div className="w-full sm:w-64">
                          <SearchableSelect
                            value={effVendorId}
                            onChange={(val) => setColorVendor((m) => ({ ...m, [v.color]: Number(val) }))}
                            // Only vendors who handle THIS next process (e.g. "Mala"
                            // shows only Mala vendors). Falls back to the design's
                            // blueprint vendors if the meta list is empty.
                            options={(procVendors.length ? procVendors : targetVendorPool).map((vv: any) => ({
                              value: vv.id ?? vv.vendorId,
                              label: `${vv.vendorCode} · ${vv.vendorName}`,
                              keywords: vv.vendorName,
                            }))}
                          />
                        </div>
                        {effVendorId !== v.vendorId && (
                          <button type="button"
                            className="text-xs text-primary hover:underline"
                            onClick={() => setColorVendor((m) => { const n = { ...m }; delete n[v.color]; return n; })}>
                            Reset to default
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* + Add new colour — operator types a colour not in Item
                  Master, picks a vendor, hit Add. Appended to customColours
                  state; on forward, backend persists it to Item Master
                  silently. Saves the "open new tab → Item Master → save
                  draft → come back" round-trip. */}
              <div className="mt-1 rounded-md border border-dashed border-primary/30 bg-primary/5 px-2 py-2">
                <div className="text-xs font-semibold text-primary">+ Add new colour for this process</div>
                <div className="mt-1.5 flex flex-wrap items-end gap-2">
                  <div className="min-w-[140px] flex-1">
                    <Input
                      placeholder="Colour name — e.g. Rajwadi"
                      value={newColourName}
                      onChange={(e) => setNewColourName(e.target.value)}
                      className="h-8"
                    />
                  </div>
                  <div className="w-full sm:w-56">
                    <SearchableSelect
                      value={newColourVendorId}
                      placeholder="— Vendor —"
                      onChange={(val) => setNewColourVendorId(val ? Number(val) : '')}
                      options={(procVendors.length ? procVendors : targetVendorPool).map((vv: any) => ({
                        value: vv.id ?? vv.vendorId,
                        label: `${vv.vendorCode} · ${vv.vendorName}`,
                        keywords: vv.vendorName,
                      }))}
                    />
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!newColourName.trim() || !newColourVendorId}
                    onClick={() => {
                      const name = newColourName.trim();
                      if (!name) return;
                      const dup = [...procColours, ...customColours]
                        .some((c) => (c.color ?? '').trim().toLowerCase() === name.toLowerCase());
                      if (dup) {
                        toast.error(`Colour "${name}" already exists in this process — tick it above instead.`);
                        return;
                      }
                      setCustomColours((cs) => [...cs, { color: name, vendorId: Number(newColourVendorId) }]);
                      setColors((cs) => [...cs, name]);
                      setColorVendor((m) => ({ ...m, [name]: Number(newColourVendorId) }));
                      setNewColourName('');
                      setNewColourVendorId('');
                    }}
                  >
                    <Plus className="size-3.5" /> Add colour
                  </Button>
                </div>
              </div>
            </div>
          </Field>
        ) : (
          <>
            <Field label="Vendor (vendors of this process · preferred ★ auto-selected)">
              <SearchableSelect
                value={vendorId}
                placeholder={processId ? '— Select vendor —' : 'Pick a process first'}
                disabled={!processId}
                onChange={(val) => setVendorId(val ? Number(val) : '')}
                // Only vendors who handle the SELECTED next process — not all vendors.
                // Preferred (★) is the design's blueprint pick for this process.
                options={(targetProc?.vendors ?? []).map((v: any) => {
                  const pref = procVendors.some((pv: any) => pv.vendorId === v.id && pv.isPreferred);
                  return { value: v.id, label: `${v.vendorCode} · ${v.vendorName}${pref ? ' ★' : ''}`, keywords: v.vendorName };
                })}
              />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Vendor Design Ref"><Input value={vendorRef} onChange={(e) => setVendorRef(e.target.value)} placeholder="vendor's own code" /></Field>
              <Field label={isKg ? 'Rate / KG' : 'Cost / pc'}><Input type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
            </div>
          </>
        )}

        {isColourStep && colors.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Total across colours: <strong className="text-foreground">{splitSum}</strong> pcs
            {splitSum > (stage.availableToForward ?? 0) ? ` ⚠ exceeds available (${stage.availableToForward})` : ` of ${stage.availableToForward} available`}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Est. cost: <strong className="text-foreground">{totalCost ? `₹${totalCost.toFixed(2)}` : '—'}</strong>
          {isColourStep ? ' (sum across colours)' : isKg ? ' (total wt g × rate/g)' : ' (cost/pc × qty)'} · weight carries forward to the slip.
        </p>

        {targetIsBomCapable && (
          <div className="rounded-lg border border-info/30 bg-info/10 p-3 text-sm">
            <label className="flex cursor-pointer items-center gap-2 font-medium text-sky-900">
              <input type="checkbox" className="size-4 accent-primary" checked={bringsOwnMaterials}
                onChange={(e) => setBringsOwnMaterials(e.target.checked)} />
              Karigar brings their own raw materials (no material issue voucher)
            </label>
            {bringsOwnMaterials && (() => {
              // Pre-fill the rate input with the item-master default so the user
              // sees the actual number, not a placeholder. For colour steps,
              // uses the first selected colour's master rate; for non-colour,
              // uses the rate field. Editable — leave as-is or change.
              const defaultRate = isColourStep
                ? (procColours.find((v: any) => (v.color ?? '').trim().toLowerCase() === (colors[0] ?? '').trim().toLowerCase())?.costPerPiece ?? '')
                : (rate || '');
              const shownValue = karigarRateOverride !== '' ? karigarRateOverride : (defaultRate !== '' ? String(defaultRate) : '');
              return (
              <div className="mt-2 rounded-md border border-info/30 bg-white px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-xs text-sky-900">
                  <span className="font-medium">Karigar's all-inclusive rate per piece:</span>
                  <Input type="number" min="0" step="0.01" className="h-7 w-28 text-right font-medium"
                    placeholder="0.00"
                    value={shownValue}
                    onChange={(e) => setKarigarRateOverride(e.target.value.replace(/[^0-9.]/g, ''))} />
                  <span className="text-xs text-info">
                    Leave blank to use the rate from the item master. Fill only if the karigar has changed their price.
                  </span>
                </div>
                {isColourStep && splits.length > 0 && (
                  <div className="mt-1.5 text-xs text-info">
                    Per-colour: {splits.map((s, i) => (
                      <span key={i}>
                        {i > 0 && ' · '}
                        <strong>{s.color}</strong>: ₹{s.rate.toFixed(2)}/pc
                      </span>
                    ))}
                  </div>
                )}
              </div>
              );
            })()}
            {!bringsOwnMaterials && (
              <>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-sky-900">
                  <span>A material-issue voucher will be auto-created with BOM × qty.</span>
                  <span className="text-info">Buffer:</span>
                  <Input type="number" min="0" step="1" className="h-7 w-16 text-right"
                    value={bufferPercent}
                    onChange={(e) => setBufferPercent(e.target.value.replace(/[^0-9]/g, ''))} />
                  <span className="text-info">% extra → defaults below recalculate.</span>
                </div>

                {/* Editable Materials-to-Issue table — user can override any default. */}
                {totalIssueQty > 0 && (
                  <div className="mt-3 rounded-md border border-info/30 bg-white">
                    <div className="flex items-center justify-between border-b border-info/30 bg-info/15/50 px-3 py-1.5 text-xs font-semibold text-sky-900">
                      <span>Materials to issue · edit any qty (whole pieces)</span>
                      <span className="text-xs font-normal text-info">{bomPreviewQ.isFetching ? 'recomputing…' : `for ${totalIssueQty} pcs across ${issueSplits.length} colour-lot(s)`}</span>
                    </div>
                    {bomPreviewQ.isLoading ? (
                      <div className="px-3 py-2 text-xs text-info">Loading BOM…</div>
                    ) : (bomPreviewQ.data?.lines?.length ?? 0) === 0 ? (
                      // BOM AUTO-CAPTURE — Item Master has no Sticking BOM for
                      // this design × colour. Inline picker so the operator can
                      // add materials right here; backend persists them BEFORE
                      // issuing on this forward. Saves the round-trip through
                      // the Item Master page (especially nice on Quick-Add'd
                      // items where master is intentionally bare).
                      <div className="space-y-2 border-t border-info/30 bg-warning/10 px-3 py-2.5">
                        <div className="flex items-start gap-2 text-xs text-warning">
                          <AlertTriangle className="size-4 shrink-0" />
                          <div>
                            <div className="font-semibold">No Sticking BOM in Item Master for this design{isColourStep && colors[0] ? <> + <span className="rounded bg-warning/15 px-1 py-0.5">{colors[0]}</span></> : null}.</div>
                            <div className="mt-0.5 text-warning">
                              Add the BOM rows below — they'll be saved to the Item Master AND issued with this forward.
                              Next time, master picks up automatically.
                            </div>
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          {bomCaptureRows.length === 0 && (
                            <div className="rounded-md border border-dashed border-warning/40 bg-white px-3 py-2 text-center text-xs text-warning">
                              No materials added yet. Click "Add material" below to build the BOM.
                            </div>
                          )}
                          {bomCaptureRows.map((row, idx) => (
                            <div key={row._key} className="grid grid-cols-[1fr_64px_28px] sm:grid-cols-[1fr_120px_36px] items-center gap-2 rounded-md border border-warning/30 bg-white px-2 py-1.5">
                              <SearchableSelect
                                value={row.variantId === '' ? '' : String(row.variantId)}
                                onChange={(v) => {
                                  const id = v === '' ? '' : Number(v);
                                  setBomCaptureRows((rows) => rows.map((r, i) => i === idx ? { ...r, variantId: id } : r));
                                }}
                                options={(variantsQ.data ?? []).map((v: any) => ({
                                  value: String(v.id),
                                  label: `${v.variantCode} · ${v.variantName ?? v.material?.materialName ?? ''}`.trim(),
                                }))}
                                placeholder="Pick a material variant…"
                                className="h-8"
                              />
                              <Input
                                type="number" min="1" step="1"
                                className="h-8 text-right"
                                placeholder="qty / pc"
                                value={row.perPiece}
                                onChange={(e) => {
                                  const next = e.target.value.replace(/[^0-9]/g, '');
                                  setBomCaptureRows((rows) => rows.map((r, i) => i === idx ? { ...r, perPiece: next } : r));
                                }}
                              />
                              <button
                                type="button"
                                title="Remove row"
                                className="rounded-md border border-warning/30 bg-white p-1 text-warning hover:bg-warning/15"
                                onClick={() => setBomCaptureRows((rows) => rows.filter((_, i) => i !== idx))}
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-white px-2 py-1 text-xs font-medium text-warning hover:bg-warning/15"
                            onClick={() => setBomCaptureRows((rows) => [...rows, { _key: rows.length + 1, variantId: '', perPiece: '' }])}
                          >
                            <Plus className="size-3" /> Add material
                          </button>
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-md border border-warning/30 bg-white px-2 py-1 text-xs text-warning hover:bg-warning/15"
                            onClick={() => setNewVariantOpen(true)}
                          >
                            <Plus className="size-3" /> Create new variant
                          </button>
                        </div>
                      </div>
                    ) : (
                      // The table is 7 columns wide with an input + a wrapping
                      // "DEFERRED — order more" warning in the rightmost cell.
                      // Without table-scroll, the last column gets clipped
                      // on narrower viewports (was hitting on the issue
                      // dialog at sm:max-w-lg; bumped dialog to xl but keep
                      // the scroll wrapper so it stays safe on phones too).
                      <div className="table-scroll">
                      <table className="w-full min-w-[820px] text-xs">
                        <thead className="bg-info/10 text-left text-info">
                          <tr>
                            <th className="px-3 py-1.5 font-medium">Material</th>
                            <th className="px-3 py-1.5 font-medium" title="How the BOM requirement was calculated">Calculation</th>
                            <th className="px-3 py-1.5 text-right font-medium">BOM req.</th>
                            <th className="px-3 py-1.5 text-right font-medium" title="Vendor already holds this much from previous issues">Vendor has</th>
                            <th className="px-3 py-1.5 text-right font-medium" title="Minimum new qty we need to issue (BOM req. − vendor has, × buffer)">Min new</th>
                            <th className="px-3 py-1.5 text-right font-medium">In stock</th>
                            <th className="px-3 py-1.5 text-right font-medium">Issue qty</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bomPreviewQ.data!.lines.map((ln) => {
                            const value = materialOverride[ln.variantId] ?? '';
                            const held = heldByVariant.get(ln.variantId) ?? 0;
                            // Min new = BOM requirement reduced by what vendor already holds,
                            // then expanded by buffer. Default issue qty becomes this when no
                            // override is set, so we never over-issue when vendor still has stock.
                            const buffer = Number(bufferPercent || 0);
                            const need = Math.max(0, ln.required - held);
                            const minNew = Math.max(0, Math.ceil(need * (1 + buffer / 100)));
                            const computedDefault = held > 0 ? minNew : ln.defaultIssue;
                            const effective = value !== '' ? Math.max(0, Math.trunc(Number(value) || 0)) : computedDefault;
                            const short = effective > ln.stockQty;
                            return (
                              <tr key={ln.variantId} className="border-t border-sky-100">
                                <td className="px-3 py-1.5">
                                  <div className="font-medium text-foreground">{ln.variantName}</div>
                                  <div className="text-xs text-muted-foreground">{ln.variantCode}{ln.unit ? ` · ${ln.unit}` : ''}</div>
                                </td>
                                <td className="px-3 py-1.5 align-top">
                                  {/* Calculation cell — shows "N pcs × P per piece = R" when
                                      every split has the same perPiece (most common). If perPiece
                                      varies across colour splits (rare), shows each split line so
                                      the math is still visible: e.g. "50×2 + 50×1 = 150". */}
                                  {ln.perPiece != null ? (
                                    <span className="font-mono text-foreground/80 tabular-nums">
                                      <strong>{ln.totalPcs}</strong>
                                      <span className="text-muted-foreground"> × </span>
                                      <strong>{ln.perPiece}</strong>
                                      <span className="text-muted-foreground"> = </span>
                                      <strong>{ln.required}</strong>
                                    </span>
                                  ) : (
                                    <div className="font-mono text-foreground/80 tabular-nums">
                                      {(ln.breakdown ?? []).map((b, i) => (
                                        <div key={i}>
                                          {b.color && <span className="text-muted-foreground">{b.color}: </span>}
                                          <strong>{b.qty}</strong>
                                          <span className="text-muted-foreground"> × </span>
                                          <strong>{b.perPiece}</strong>
                                          <span className="text-muted-foreground"> = </span>
                                          <strong>{b.subtotal}</strong>
                                        </div>
                                      ))}
                                      <div className="mt-0.5 border-t border-info/30 pt-0.5">
                                        <span className="text-muted-foreground">total = </span><strong>{ln.required}</strong>
                                      </div>
                                    </div>
                                  )}
                                </td>
                                <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{ln.required}</td>
                                <td className={`px-3 py-1.5 text-right tabular-nums ${held > 0 ? 'text-success font-medium' : 'text-muted-foreground'}`}>{held}</td>
                                <td className="px-3 py-1.5 text-right tabular-nums font-medium text-sky-900">{minNew}</td>
                                <td className={`px-3 py-1.5 text-right tabular-nums ${short ? 'text-destructive font-medium' : ''}`}>{ln.stockQty}</td>
                                <td className="px-3 py-1.5 text-right">
                                  <div className="flex items-center justify-end gap-1">
                                    <Input
                                      type="number" min="0" step="1"
                                      className="h-7 w-20 text-right"
                                      placeholder={String(computedDefault)}
                                      value={value}
                                      onChange={(e) =>
                                        setMaterialOverride((m) => ({
                                          ...m,
                                          [ln.variantId]: e.target.value.replace(/[^0-9]/g, ''),
                                        }))
                                      }
                                    />
                                    {value !== '' && (
                                      <button
                                        type="button"
                                        title="Reset to default"
                                        className="text-xs text-primary hover:underline"
                                        onClick={() =>
                                          setMaterialOverride((m) => {
                                            const n = { ...m };
                                            delete n[ln.variantId];
                                            return n;
                                          })
                                        }
                                      >
                                        ↺
                                      </button>
                                    )}
                                  </div>
                                  {short && (
                                    <div className="mt-1 text-xs">
                                      <span className="inline-flex items-center gap-1 text-warning">
                                        <AlertTriangle className="size-3" />
                                        Short by {effective - ln.stockQty} — will be DEFERRED. Issue more when stock arrives via Raw Materials Inventory.
                                      </span>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      </div>
                    )}
                    {/* Footer with TWO escape hatches:
                        1) "Create new material variant" — when the variant
                           itself doesn't exist in the Material Master yet
                           (opens the variant-create dialog inline).
                        2) "Add material to this design (Item Master) ↗" —
                           opens the design's Item Master page in a NEW TAB
                           focused on the Sticking BOM section, so the user
                           can add the row to the BOM without losing this
                           issue dialog. Input in this dialog is lost on
                           refresh (by design — v1 keep-it-simple). */}
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-info/30 bg-info/10 px-3 py-1.5 text-xs text-info">
                      <span>Leave a row blank to use the BOM × qty × buffer default. Edited rows override the auto-calc.</span>
                      <div className="flex flex-wrap items-center gap-2">
                        {stage?.itemId && (
                          <a
                            href={`/items/${stage.itemId}/edit${processId ? `?focusProcess=${processId}` : ''}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded border border-sky-300 bg-white px-2 py-0.5 font-medium text-info hover:bg-info/15"
                            title="Open this design's Item Master in a new tab — the Sticking process opens with the BOM ready to edit. Add the material there, then refresh this issue to pick it up."
                          >
                            <Plus className="size-3" /> Add material to design (Item Master) ↗
                          </a>
                        )}
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded border border-sky-300 bg-white px-2 py-0.5 font-medium text-info hover:bg-info/15"
                          onClick={() => setNewVariantOpen(true)}>
                          <Plus className="size-3" /> Create new material variant
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Ad-hoc material issue — operator picks materials to send WITH
            this forward. Eligibility is filtered by the target process if
            any material variants declare process eligibility; variants
            with no eligibility set are always shown. Available on every
            non-BOM process; BOM-capable processes (Sticking, Kacha Fitting,
            Fitting+Mala) handle materials via their own BOM block above. */}
        {processId && !targetIsBomCapable && (() => {
          const targetCode = targetProc?.code;
          const eligibleVariants = (variants ?? []).filter((v: any) => {
            const procs: number[] = v.processIds ?? [];
            return procs.length === 0 || procs.includes(Number(processId));
          });
          const totalQty = extraMaterialRows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
          const totalWt = extraMaterialRows.reduce((s, r) => s + (Number(r.weight) || 0), 0);
          return (
            <div className="rounded-lg border border-gold/20 bg-gold/[0.04] p-3 text-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-wider text-gold">Issue materials with this forward</div>
                  <div className="text-[11px] text-text-faint">
                    Optional. Creates a material-issue voucher to {targetCode ?? 'this'} vendor for the picked materials. You can issue more later from /material-issues if the work needs it.
                  </div>
                </div>
                <Button
                  type="button" variant="outline" size="sm"
                  onClick={() => setExtraMaterialRows((rs) => [...rs, newExtraRow()])}
                >
                  <Plus className="size-3.5" /> Add material
                </Button>
              </div>
              {extraMaterialRows.length === 0 ? (
                <p className="rounded-md border border-dashed border-border bg-card/40 px-3 py-2 text-center text-xs text-text-faint">
                  No materials added. Click "Add material" if the karigar needs filings, polishing wax, etc. for this lot.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {extraMaterialRows.map((row, idx) => {
                    const v = eligibleVariants.find((x: any) => x.id === Number(row.variantId));
                    const trackByQty = v?.trackByQty ?? true;
                    const trackByWeight = v?.trackByWeight ?? false;
                    return (
                      <div key={row._key} className="grid grid-cols-12 items-end gap-2 rounded-md border border-border bg-card px-2 py-1.5">
                        <div className="col-span-12 sm:col-span-5">
                          <SearchableSelect
                            value={row.variantId === '' ? '' : String(row.variantId)}
                            placeholder={eligibleVariants.length === 0 ? '— no eligible variants —' : '— pick material —'}
                            onChange={(val) => {
                              const id = val === '' ? '' : Number(val);
                              setExtraMaterialRows((rs) => rs.map((r, i) => i === idx ? { ...r, variantId: id } : r));
                            }}
                            options={eligibleVariants.map((v: any) => ({
                              value: v.id,
                              label: v.variantName,
                              subtitle: `${v.materialName}${v.size ? ` · ${v.size}` : ''}${v.color ? ` · ${v.color}` : ''}`,
                              meta: [
                                trackByQty ? `${Number(v.stockQty).toFixed(0)} pcs` : null,
                                trackByWeight ? `${Number(v.stockWeight).toFixed(3)} g` : null,
                              ].filter(Boolean).join(' · '),
                              keywords: `${v.variantCode} ${v.materialName}`,
                            }))}
                          />
                        </div>
                        {(trackByQty || !v) && (
                          <div className="col-span-3 sm:col-span-2">
                            <Field label={idx === 0 ? 'Qty' : ''}>
                              <Input type="number" min="0" step="1" placeholder="0"
                                value={row.qty}
                                onChange={(e) => setExtraMaterialRows((rs) => rs.map((r, i) => i === idx ? { ...r, qty: e.target.value } : r))}
                              />
                            </Field>
                          </div>
                        )}
                        {trackByWeight && (
                          <div className="col-span-3 sm:col-span-2">
                            <Field label={idx === 0 ? 'Wt (g)' : ''}>
                              <Input type="number" min="0" step="0.001" placeholder="0.000"
                                value={row.weight}
                                onChange={(e) => setExtraMaterialRows((rs) => rs.map((r, i) => i === idx ? { ...r, weight: e.target.value } : r))}
                              />
                            </Field>
                          </div>
                        )}
                        <div className="col-span-5 sm:col-span-2">
                          <Field label={idx === 0 ? 'Notes' : ''}>
                            <Input placeholder="optional" value={row.notes}
                              onChange={(e) => setExtraMaterialRows((rs) => rs.map((r, i) => i === idx ? { ...r, notes: e.target.value } : r))}
                            />
                          </Field>
                        </div>
                        <div className={`col-span-1 ${idx === 0 ? 'pt-[26px]' : ''}`}>
                          <Button
                            type="button" variant="outline" size="icon"
                            className="text-destructive hover:bg-destructive/10"
                            title="Remove row"
                            onClick={() => setExtraMaterialRows((rs) => rs.filter((_, i) => i !== idx))}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                  <div className="flex items-center justify-between rounded-md border border-gold/15 bg-card/40 px-3 py-1.5 text-xs">
                    <span className="text-text-muted">Issue totals</span>
                    <span className="font-semibold tracking-tight text-gold tabular-nums">
                      {totalQty > 0 ? `${totalQty} pcs` : ''}{totalQty > 0 && totalWt > 0 ? ' · ' : ''}{totalWt > 0 ? `${totalWt.toFixed(3)} g` : ''}
                      {totalQty === 0 && totalWt === 0 ? '—' : ''}
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>
      {/* Raw-material shortage popup — shown when the backend refuses the issue
          because stock is insufficient. Lists every shortage with a deep-link
          to Raw Materials Inventory so the user can order more before retrying. */}
      {stockShortage && stockShortage.length > 0 && (
        <Dialog open onClose={() => setStockShortage(null)} size="md"
          title="Raw materials not available"
          description="Cannot issue to sticking — some materials don't have enough stock to cover the BOM."
          footer={
            <>
              <Button variant="outline" onClick={() => setStockShortage(null)}>Close</Button>
              <a href="/inventory" target="_blank" rel="noreferrer">
                <Button>Open Raw Materials Inventory</Button>
              </a>
            </>
          }>
          <div className="space-y-2">
            <p className="text-sm text-warning">
              Order or restock these materials before issuing this sticking batch. The forward is paused — your typed-in values are still here when you come back.
            </p>
            <div className="table-scroll rounded-md border border-destructive/30">
              <table className="w-full min-w-[480px] text-sm">
                <thead className="bg-destructive/10 text-left text-xs text-red-900">
                  <tr>
                    <th className="px-2 py-1.5">Material</th>
                    <th className="px-2 py-1.5 text-right">Need</th>
                    <th className="px-2 py-1.5 text-right">In stock</th>
                    <th className="px-2 py-1.5 text-right">Short by</th>
                  </tr>
                </thead>
                <tbody>
                  {stockShortage.map((s: any) => (
                    <tr key={s.variantId} className="border-t border-red-100">
                      <td className="px-2 py-1.5">
                        <div className="font-medium text-foreground">{s.variantName || s.variantCode}</div>
                        <div className="text-xs text-muted-foreground">{s.variantCode}</div>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{s.need}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{s.have}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-destructive">{s.short}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </Dialog>
      )}
    </Dialog>
    {/* Material Variant create dialog — opens when the user clicks
        "+ Create new material variant" inside the BOM preview. Refetches the
        BOM preview on close so a new variant added to the design's BOM
        appears immediately (after the user updates Item Master). */}
    {newVariantOpen && (
      <VariantForm
        open={newVariantOpen}
        onClose={() => {
          setNewVariantOpen(false);
          qcLocal.invalidateQueries({ queryKey: ['sticking-bom-preview'] });
          qcLocal.invalidateQueries({ queryKey: ['variants'] });
          qcLocal.invalidateQueries({ queryKey: ['stock'] });
        }}
        variantId={null}
      />
    )}
    </>
  );
}

// Dialog to EDIT a stage (vendor / qty / weight / rate / colour / remarks
// / DESIGN). Design SWAP is only safe when the stage is fresh (no receipts,
// no children forwarded, no material-issue voucher); backend re-enforces
// the same guards on save and surfaces a clear error if not.
const KG_PROCS = ['CASTING', 'PLATING'];
function EditStageDialog({ stage, open, onClose, onDone }: { stage: any; open: boolean; onClose: () => void; onDone: () => void }) {
  const [itemId, setItemId] = React.useState<number | ''>('');
  const [vendorId, setVendorId] = React.useState<number | ''>('');
  const [vendorRef, setVendorRef] = React.useState('');
  const [quantity, setQuantity] = React.useState('');
  const [weight, setWeight] = React.useState('');
  const [totalWeight, setTotalWeight] = React.useState('');
  const [rate, setRate] = React.useState('');
  const [color, setColor] = React.useState('');
  const [remarks, setRemarks] = React.useState('');
  // Order purpose — customer / Stock / Sample / etc. Carried into every
  // downstream stage by the backend on forward; surfaces on the slip
  // PDF's Order Details box.
  const [purpose, setPurpose] = React.useState('');
  // Operator-overridable slip date. The slip PDF normally uses createdAt,
  // but ops sometimes need to back-date a forward that was entered on the
  // wrong day. Blank = use the row's createdAt.
  const [issueDate, setIssueDate] = React.useState('');

  const metaQ = useQuery<ItemMeta>({ queryKey: ['item-meta'], queryFn: () => Api.items.meta(), enabled: open });
  const allVendors = metaQ.data?.allVendors ?? [];
  const isKg = stage ? KG_PROCS.includes(stage.processCode) : false;
  // Pool of designs the operator can SWAP to — only PRODUCTION_READY items
  // are valid stage targets. Loaded once on dialog open so the picker is
  // snappy even with 10k items.
  const itemsQ = useQuery<any[]>({
    queryKey: ['items-prod-ready'],
    queryFn: () => Api.items.list({ sampleStatus: 'PRODUCTION_READY' }),
    enabled: open,
    staleTime: 60_000,
  });
  // Design SWAP is only safe on a fresh stage. UI mirrors backend guards
  // so the operator sees WHY the picker is disabled rather than being
  // surprised by a server error on save. Receipts: stage.receivedQty +
  // openRepairQty > 0; children: stage.forwardedQty > 0; material issue:
  // sticking stages only — flagged via materialStatus.
  const canSwapDesign = React.useMemo(() => {
    if (!stage) return false;
    if (stage.closed) return false;
    if ((stage.acceptedQty ?? 0) + (stage.repairQty ?? 0) + (stage.rejectedQty ?? 0) > 0) return false;
    if ((stage.openRepairQty ?? 0) > 0) return false;
    if ((stage.forwardedQty ?? 0) > 0) return false;
    return true;
  }, [stage]);

  React.useEffect(() => {
    if (open && stage) {
      setItemId(stage.itemId ?? '');
      setVendorId(stage.vendorId); setVendorRef(stage.vendorDesignReference ?? '');
      setQuantity(String(stage.quantity)); setWeight(String(stage.weight));
      setTotalWeight(String(stage.totalWeight)); setRate(stage.costPerKg != null ? String(stage.costPerKg) : '');
      setColor(stage.color ?? ''); setRemarks(stage.remarks ?? '');
      setPurpose(stage.purpose ?? '');
      // issueDate is a Date | null on the row — normalise to YYYY-MM-DD
      // for the <input type="date">. Empty when no override is set
      // (slip falls back to createdAt server-side).
      setIssueDate(stage.issueDate ? String(stage.issueDate).slice(0, 10) : '');
    }
  }, [open, stage]);

  // Vendor-level rate fallback — when operator swaps the vendor on Edit
  // Stage AND no rate was carried forward from the OLD vendor, look up
  // the NEW vendor's most recent rate for this process and pre-fill.
  // Same "Krishna does casting at ₹760/kg for everything" pattern as
  // the New Batch row. Fires only when rate is currently blank so the
  // operator's explicit override is never clobbered.
  React.useEffect(() => {
    if (!open || !stage || !vendorId || rate !== '') return;
    if (vendorId === stage.vendorId) return; // unchanged from original
    let cancelled = false;
    Api.casting.vendorRate(Number(vendorId), stage.processId)
      .then((r) => {
        if (cancelled) return;
        if (r.rate != null && r.rate > 0) setRate(String(r.rate));
      })
      .catch(() => { /* silent — empty fallback is fine */ });
    return () => { cancelled = true; };
  }, [vendorId, open, stage, rate]);

  // When the operator picks a DIFFERENT design, offer to pre-fill vendor /
  // weight / rate from the new design's Item Master (matched to the
  // current stage process). Fields the operator has already touched stay
  // untouched — we never overwrite explicit user input. The picker fires
  // a confirmation toast on swap, so the operator sees what changed.
  const onPickItem = async (newIdStr: string) => {
    const newId = newIdStr ? Number(newIdStr) : '';
    setItemId(newId);
    if (!newId || newId === stage?.itemId) return;
    try {
      const it = await Api.items.get(Number(newId));
      const proc = (it.processes ?? []).find((p: any) => p.processId === stage.processId);
      const vend = proc?.vendors?.find((v: any) => v.isPreferred) ?? proc?.vendors?.[0];
      const wAttr = proc?.attributes?.find((a: any) => a.attrKey === 'weight');
      // Auto-fill only fields equal to the OLD stage's values (i.e.
      // untouched by the operator). Comparing string forms of numbers
      // for stable equality.
      if (vend?.vendorId && vendorId === stage.vendorId) setVendorId(vend.vendorId);
      if (vend?.vendorDesignReference && vendorRef === (stage.vendorDesignReference ?? '')) setVendorRef(vend.vendorDesignReference);
      if (vend?.costPerPiece != null && rate === (stage.costPerKg != null ? String(stage.costPerKg) : '')) {
        setRate(String(vend.costPerPiece));
      }
      if (wAttr?.attrValue && weight === String(stage.weight)) {
        const w = Number(wAttr.attrValue);
        if (w > 0) {
          setWeight(String(w));
          const q = Number(quantity || 0);
          setTotalWeight(q ? String(Math.round(w * q * 1000) / 1000) : '');
        }
      }
      toast.info(`Design swapped to #${it.itemNumber ?? it.sampleDesignCode}. Defaults from Item Master pre-filled where you hadn't already overridden.`);
    } catch (e) {
      toast.error(getApiError(e).message);
    }
  };

  const save = useMutation({
    mutationFn: () => Api.casting.updateStage(stage.id, {
      itemId: typeof itemId === 'number' && itemId !== stage.itemId ? itemId : undefined,
      vendorId: vendorId ? Number(vendorId) : undefined,
      vendorDesignReference: vendorRef || undefined,
      quantity: quantity !== '' ? Number(quantity) : undefined,
      weight: weight !== '' ? Number(weight) : undefined,
      totalWeight: totalWeight !== '' ? Number(totalWeight) : undefined,
      costPerKg: rate !== '' ? Number(rate) : undefined,
      color: color || undefined,
      remarks: remarks || undefined,
      purpose: purpose.trim() || undefined,
      // Send explicit '' (not undefined) when the operator cleared the
      // field, so the backend writes null and the slip reverts to
      // createdAt. Unchanged means we omit it.
      issueDate: issueDate !== (stage.issueDate ? String(stage.issueDate).slice(0, 10) : '')
        ? issueDate
        : undefined,
    }),
    onSuccess: (r: any) => {
      toast.success('Stage updated — slip reflects new details.');
      // Mirror the forward dialog's toast+undo pattern: when the edited
      // rate differed from the item master's rate, the backend updated
      // master and returns the change here. Surface it so the user can
      // undo (e.g. if they meant to override only this one stage, not
      // the master rate going forward).
      for (const u of ((r?.rateUpdates ?? []) as any[])) {
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
              } catch (err) {
                toast.error(getApiError(err).message);
              }
            },
          },
        });
      }
      onDone();
      onClose();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  if (!stage) return null;
  return (
    <Dialog open={open} onClose={onClose} size="md"
      title={`Edit — ${stage.processName} (${stage.vendorDesignReference || stage.itemNumber})`}
      footer={<><Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending && <Spinner />} Save</Button></>}>
      <div className="space-y-3">
        {/* Design picker — top of dialog so a wrong-design-number typo is
            the first thing the operator can fix. Disabled (with a one-line
            why) when receipts/children/material-issue exist; the right fix
            in that case is short-close + re-add. */}
        <Field
          label="Design"
          hint={canSwapDesign
            ? 'Swap to a different design — vendor / weight / rate auto-prefill from the new design where you haven\'t overridden.'
            : 'Locked — receipts or children exist on this stage. Short-close + re-add a fresh line to change the design.'}
        >
          <SearchableSelect
            value={itemId}
            placeholder="— Select design —"
            disabled={!canSwapDesign}
            onChange={(v) => onPickItem(v)}
            options={(itemsQ.data ?? []).map((it: any) => ({
              value: it.id,
              label: `#${it.itemNumber ?? it.sampleDesignCode}${it.itemName ? ` · ${it.itemName}` : ''}`,
              subtitle: it.sampleDesignCode !== it.itemNumber ? it.sampleDesignCode : undefined,
              keywords: `${it.itemName ?? ''} ${it.sampleDesignCode ?? ''}`,
            }))}
          />
        </Field>
        <Field label="Vendor">
          <Select value={vendorId} onChange={(e) => setVendorId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">— Select —</option>
            {allVendors.map((v: any) => <option key={v.id} value={v.id}>{v.vendorCode} · {v.vendorName}</option>)}
          </Select>
        </Field>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Vendor Design Ref"><Input value={vendorRef} onChange={(e) => setVendorRef(e.target.value)} /></Field>
          <Field label="Quantity" hint={stage.parentItemId != null ? 'Set by the Send amount' : undefined}>
            <Input type="number" value={quantity} disabled={stage.parentItemId != null}
              className={stage.parentItemId != null ? 'bg-muted' : ''}
              onChange={(e) => { setQuantity(e.target.value); const w = Number(weight || 0); setTotalWeight(w ? String(Math.round(w * Number(e.target.value || 0) * 1000) / 1000) : ''); }} /></Field>
        </div>
        {/* Total weight is the primary input here too — operator weighs
            the whole lot. Per-pc auto-derives so downstream stages still
            carry-forward the right per-pc number. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Total Wt (g)">
            <Input type="number" step="0.001" value={totalWeight}
              onChange={(e) => {
                setTotalWeight(e.target.value);
                const q = Number(quantity || 0);
                if (e.target.value && q > 0) {
                  setWeight(String(Math.round((Number(e.target.value) / q) * 1000) / 1000));
                }
              }} />
          </Field>
          <Field label={isKg ? 'Rate / g' : 'Cost / pc'}><Input type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <Field label="Colour"><Input value={color} onChange={(e) => setColor(e.target.value)} /></Field>
          <Field label="Purpose" hint="Customer / Stock / Sample">
            <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Mr. Sharma" />
          </Field>
          <Field label="Remarks"><Input value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
        </div>
        <Field label="Slip date" hint="Override only if the forward was wrongly date-stamped. Blank = use the row's created date.">
          <div className="flex items-center gap-2">
            <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} className="w-44" />
            {issueDate && (
              <Button type="button" variant="outline" size="sm" onClick={() => setIssueDate('')}>Clear</Button>
            )}
          </div>
        </Field>
        <p className="text-xs text-muted-foreground">Receipts already recorded are kept. The slip is generated live, so it shows the updated details.</p>
      </div>
    </Dialog>
  );
}

/**
 * Add a single design line to an existing OPEN batch — minimal one-row
 * form (design + qty + vendor + weight + rate + purpose). The added
 * design becomes a fresh root Casting stage; the batch's existing rows
 * (and their receipts) are untouched. Backend runs the same Item Master
 * auto-sync as createBatch (vendor + rate + weight + temp-weight marker
 * when the checkbox is ticked).
 */
function AddDesignDialog({
  open, batchId, onClose, onDone, existingDesigns,
}: {
  open: boolean;
  batchId: number | null;
  onClose: () => void;
  onDone: () => void;
  // Root Casting stages already in this batch — used to detect when the
  // operator is adding a design that's already there. Only roots (no
  // parent), with their current qty so the confirm dialog can show
  // "already on this batch with qty Y, increase or keep separate?".
  existingDesigns: Array<{ stageId: number; itemId: number; itemNumber: string | null; itemName: string | null; quantity: number }>;
}) {
  const qc = useQueryClient();
  const [itemId, setItemId] = React.useState<number | ''>('');
  const [vendorId, setVendorId] = React.useState<number | ''>('');
  const [quantity, setQuantity] = React.useState('');
  const [weight, setWeight] = React.useState('');
  const [rate, setRate] = React.useState('');
  const [purpose, setPurpose] = React.useState('');
  const [vendorRef, setVendorRef] = React.useState('');
  const [castingWeightTemporary, setCastingWeightTemporary] = React.useState(false);
  // Duplicate-design confirm — when operator hits "Add design" and the
  // chosen itemId is already on a root Casting stage in this batch, we
  // open this dialog instead of submitting. They pick "Increase qty on
  // existing" (calls updateStage on the existing stage with summed qty)
  // or "Add as separate line" (continues with addBatchDesign as normal).
  const [dupePending, setDupePending] = React.useState<null | { stage: typeof existingDesigns[number] }>(null);

  const metaQ = useQuery<ItemMeta>({ queryKey: ['item-meta'], queryFn: () => Api.items.meta(), enabled: open });
  const itemsQ = useQuery<any[]>({
    queryKey: ['items-prod-ready'],
    queryFn: () => Api.items.list({ sampleStatus: 'PRODUCTION_READY' }),
    enabled: open,
    staleTime: 60_000,
  });
  // When a design is picked, pre-fill vendor / weight / rate from its
  // Casting process in Item Master so the common case is one click.
  const itemQ = useQuery({
    queryKey: ['item', itemId],
    queryFn: () => Api.items.get(Number(itemId)),
    enabled: open && !!itemId,
    staleTime: 30_000,
  });
  React.useEffect(() => {
    if (!itemQ.data) return;
    const proc = (itemQ.data.processes ?? []).find((p: any) => p.process?.code === 'CASTING' || p.processCode === 'CASTING');
    const vend = proc?.vendors?.find((v: any) => v.isPreferred) ?? proc?.vendors?.[0];
    const wAttr = proc?.attributes?.find((a: any) => a.attrKey === 'weight');
    if (vend?.vendorId && vendorId === '') setVendorId(vend.vendorId);
    if (vend?.costPerPiece != null && rate === '') setRate(String(vend.costPerPiece));
    if (wAttr?.attrValue && weight === '') setWeight(String(wAttr.attrValue));
    if (vend?.vendorDesignReference && vendorRef === '') setVendorRef(vend.vendorDesignReference);
  }, [itemQ.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Master-side vendor ref for the CURRENTLY chosen (item × Casting ×
  // vendor) combo. Used to flag the field as "blank in master — will save
  // back" when the operator hasn't found one yet for this vendor.
  const masterVendorRef = React.useMemo(() => {
    if (!itemQ.data || !vendorId) return '';
    const proc = (itemQ.data.processes ?? []).find((p: any) => p.process?.code === 'CASTING' || p.processCode === 'CASTING');
    const vend = proc?.vendors?.find((v: any) => v.vendorId === Number(vendorId));
    return vend?.vendorDesignReference ?? '';
  }, [itemQ.data, vendorId]);

  // Vendor-level rate fallback — when the chosen vendor has no rate on
  // THIS item's Casting master AND operator hasn't typed one, look up
  // the vendor's most recent Casting rate across any item and pre-fill.
  const castingProcessId = React.useMemo(() => {
    return (metaQ.data?.processes ?? []).find((p: any) => p.code === 'CASTING')?.id ?? null;
  }, [metaQ.data]);
  React.useEffect(() => {
    if (!vendorId || !castingProcessId) return;
    if (rate !== '') return; // operator already typed
    // Skip when master has an item-level rate for this vendor (itemQ load
    // already pre-filled rate via the other effect — wait for that path).
    const proc = (itemQ.data?.processes ?? []).find((p: any) => p.process?.code === 'CASTING' || p.processCode === 'CASTING');
    const vend = proc?.vendors?.find((v: any) => v.vendorId === Number(vendorId));
    if (vend?.costPerPiece != null && Number(vend.costPerPiece) > 0) return;
    let cancelled = false;
    Api.casting.vendorRate(Number(vendorId), castingProcessId)
      .then((r) => {
        if (cancelled) return;
        if (r.rate != null && r.rate > 0) setRate(String(r.rate));
      })
      .catch(() => { /* silent — empty fallback is fine */ });
    return () => { cancelled = true; };
  }, [vendorId, castingProcessId, itemQ.data, rate]);

  // Reset on open so a second open doesn't leak the previous design.
  React.useEffect(() => {
    if (open) {
      setItemId(''); setVendorId(''); setQuantity(''); setWeight(''); setRate(''); setPurpose('');
      setVendorRef('');
      setCastingWeightTemporary(false);
    }
  }, [open]);

  const allVendors = metaQ.data?.allVendors ?? [];

  const add = useMutation({
    mutationFn: () => {
      if (!batchId) throw new Error('No batch selected.');
      if (!itemId) throw new Error('Pick a design.');
      if (!Number(quantity)) throw new Error('Enter a quantity.');
      if (!vendorId) throw new Error('Pick a vendor.');
      return Api.casting.addBatchDesign(batchId, {
        itemId: Number(itemId),
        quantity: Number(quantity),
        vendorId: Number(vendorId),
        weight: weight !== '' ? Number(weight) : undefined,
        costPerKg: rate !== '' ? Number(rate) : undefined,
        purpose: purpose.trim() || undefined,
        vendorDesignReference: vendorRef.trim() || undefined,
        castingWeightTemporary: castingWeightTemporary || undefined,
      });
    },
    onSuccess: (r: any) => {
      toast.success('Design added to batch. New Casting stage created.');
      // Auto-rate-sync toasts mirror createBatch / forward behaviour.
      for (const u of ((r?.rateUpdates ?? []) as any[])) {
        if (u.silent) continue;
        toast.info(`${u.processName} rate updated for #${u.itemId} → ₹${u.newRate} (was ₹${u.oldRate})`, {
          duration: 8000,
          action: {
            label: 'Undo',
            onClick: async () => {
              try {
                await Api.items.setProcessRate(u.itemId, u.processId, { vendorId: u.vendorId, rate: u.oldRate });
                toast.success(`Reverted ${u.processName} rate to ₹${u.oldRate}.`);
              } catch (err) { toast.error(getApiError(err).message); }
            },
          },
        });
      }
      const flagged = (r?.tempWeightFlagged ?? []) as number[];
      if (flagged.length > 0) {
        toast.info(`Casting weight saved as temporary — will prompt for final per-pc weight on receive.`, { duration: 7000 });
      }
      qc.invalidateQueries({ queryKey: ['item-meta'] });
      onDone();
      onClose();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  // Merge into an existing root stage — bumps that stage's quantity by
  // the qty typed in this dialog and closes. The receipts/forwards on
  // the existing stage are preserved (updateStage just increases the
  // ordered total).
  const mergeQty = useMutation({
    mutationFn: () => {
      if (!dupePending) throw new Error('No duplicate target.');
      const addQty = Math.max(0, Math.trunc(Number(quantity) || 0));
      const newQty = dupePending.stage.quantity + addQty;
      return Api.casting.updateStage(dupePending.stage.stageId, { quantity: newQty });
    },
    onSuccess: () => {
      toast.success(`Quantity on existing line increased — total now ${dupePending!.stage.quantity + Number(quantity)} pcs.`);
      setDupePending(null);
      onDone();
      onClose();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  // Pre-submit check: if the chosen itemId is already a root stage in
  // this batch, open the duplicate dialog instead of firing addBatchDesign.
  const submit = () => {
    if (!itemId || !quantity || !vendorId) return;
    const existing = existingDesigns.find((d) => d.itemId === Number(itemId));
    if (existing) {
      setDupePending({ stage: existing });
      return;
    }
    add.mutate();
  };

  return (
    <Dialog open={open} onClose={onClose} size="lg"
      title="Add design to batch"
      description="Append a new design line to this open batch — vendor / weight / rate auto-fill from Item Master. The other rows and their receipts stay untouched."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={add.isPending}>Cancel</Button>
          <Button onClick={submit} disabled={add.isPending || !itemId || !quantity || !vendorId}>
            {add.isPending && <Spinner />} Add design
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Design" hint="PRODUCTION-READY items only">
          <SearchableSelect
            value={itemId}
            placeholder="— Select design —"
            onChange={(v) => setItemId(v ? Number(v) : '')}
            options={(itemsQ.data ?? []).map((it: any) => ({
              value: it.id,
              label: `#${it.itemNumber ?? it.sampleDesignCode}${it.itemName ? ` · ${it.itemName}` : ''}`,
              subtitle: it.sampleDesignCode !== it.itemNumber ? it.sampleDesignCode : undefined,
              keywords: `${it.itemName ?? ''} ${it.sampleDesignCode ?? ''}`,
            }))}
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Vendor">
            <SearchableSelect
              value={vendorId}
              placeholder="— Select vendor —"
              onChange={(v) => setVendorId(v ? Number(v) : '')}
              options={allVendors.map((v: any) => ({
                value: v.id,
                label: `${v.vendorCode} · ${v.vendorName}`,
                keywords: v.vendorName,
              }))}
            />
          </Field>
          <Field label="Quantity">
            <Input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
        </div>
        {/* Vendor Design Ref — always rendered. When the master has it for
            this (item × vendor), we pre-fill. When blank, the hint nudges
            the operator to enter it now; backend will save it back to
            Item Master via ensureProcessVendor on submit. */}
        <Field
          label="Vendor Design Ref"
          hint={itemId && vendorId && !masterVendorRef
            ? 'Blank in master for this vendor — will save back to Item Master on submit.'
            : 'vendor\'s own item code'}
        >
          <Input
            value={vendorRef}
            placeholder={masterVendorRef || 'e.g. 8748'}
            onChange={(e) => setVendorRef(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Wt / pc (g)">
            <Input type="number" step="0.001" value={weight} onChange={(e) => setWeight(e.target.value)} />
            <label className="mt-1 flex cursor-pointer items-center gap-1.5 text-xs text-warning">
              <input
                type="checkbox"
                className="size-3.5 accent-amber-600"
                checked={castingWeightTemporary}
                onChange={(e) => setCastingWeightTemporary(e.target.checked)}
              />
              Casting weight temporary <span className="text-muted-foreground">(prompt for final on receive)</span>
            </label>
          </Field>
          <Field label="Rate / KG">
            <Input type="number" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} />
          </Field>
        </div>
        <Field label="Purpose" hint="Customer / Stock / Sample">
          <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. Mr. Sharma" />
        </Field>
      </div>

      {/* Duplicate-design confirm — opens when the operator clicks "Add
          design" with an itemId that's already a root Casting stage in
          this batch. Three options: increase qty on existing, add as
          separate line (continues to addBatchDesign), or cancel. */}
      {dupePending && (
        <Dialog
          open
          onClose={() => setDupePending(null)}
          size="md"
          title="Design already in this batch"
          description={`#${dupePending.stage.itemNumber ?? '?'}${dupePending.stage.itemName ? ` · ${dupePending.stage.itemName}` : ''} is already a line in this batch with qty ${dupePending.stage.quantity}. What would you like to do?`}
          footer={
            <>
              <Button variant="outline" onClick={() => setDupePending(null)}>Cancel</Button>
              <Button variant="outline" onClick={() => { setDupePending(null); add.mutate(); }} disabled={add.isPending}>
                {add.isPending && <Spinner />} Add as separate line
              </Button>
              <Button onClick={() => mergeQty.mutate()} disabled={mergeQty.isPending}>
                {mergeQty.isPending && <Spinner />} Increase qty on existing
              </Button>
            </>
          }
        >
          <div className="text-sm text-muted-foreground">
            <strong>Increase qty on existing</strong> bumps the existing line's quantity from {dupePending.stage.quantity} to {dupePending.stage.quantity + Math.max(0, Math.trunc(Number(quantity) || 0))} pcs. The existing line's receipts and forwards stay untouched.
            <br />
            <strong>Add as separate line</strong> creates a fresh line — useful when the same design needs to go to a different vendor / weight / purpose on this batch.
          </div>
        </Dialog>
      )}
    </Dialog>
  );
}

// Route excess produced pieces to another batch's design line, skipping the
// material issue (raw materials were already consumed upstream when these
// pieces were originally produced). Wraps the existing settle API which
// already supports cross-batch forwarding.
//
// Source = a stage where receivedQty > quantity. The user picks:
//   • target batch (any non-closed batch)
//   • next process for these pcs (typically the source's next step)
//   • vendor for that next process
//   • how many of the excess pcs to route (defaults to all)
// On submit, settle() creates a child stage in the target batch — parent
// link preserves the audit trail "these came from batch B0007 / vendor V12".
function RouteExcessDialog({
  stage, open, onClose, onDone,
}: { stage: any; open: boolean; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const excessAvail = stage ? Math.max(0, (stage.receivedQty ?? 0) - (stage.quantity ?? 0) - (stage.forwardedQty ?? 0)) : 0;
  const [targetBatchId, setTargetBatchId] = React.useState<number | ''>('');
  const [nextProcessId, setNextProcessId] = React.useState<number | ''>('');
  const [vendorId, setVendorId] = React.useState<number | ''>('');
  const [color, setColor] = React.useState<string>('');
  const [qty, setQty] = React.useState<string>('');

  React.useEffect(() => {
    if (!open) return;
    setTargetBatchId('');
    setNextProcessId('');
    setVendorId('');
    setColor(stage?.color ?? '');
    setQty(String(excessAvail));
  }, [open, stage, excessAvail]);

  const batchesQ = useQuery({
    queryKey: ['casting-batches-route-excess'],
    queryFn: () => Api.casting.batches(),
    enabled: open,
  });
  const processesQ = useQuery({
    queryKey: ['processes'],
    queryFn: () => Api.processes(),
    enabled: open,
  });
  const vendorsQ = useQuery({
    queryKey: ['vendors-by-process', nextProcessId],
    queryFn: () => Api.vendors.list({ processId: Number(nextProcessId) }),
    enabled: open && !!nextProcessId,
  });

  // Filter batches: non-closed only, and exclude the source batch (routing
  // to the same batch is just a regular forward — use the Send button).
  const targetBatches = (batchesQ.data ?? [])
    .filter((b: any) => !b.closed && b.id !== stage?.batchId);

  // Process options: every process EXCEPT the source's own process and
  // those that come before it. The vendor receiving the excess will do
  // the next step in the chain.
  const allProcesses = processesQ.data ?? [];
  const sourceProc = allProcesses.find((p: any) => p.id === stage?.processId);
  const nextProcessOptions = allProcesses
    .filter((p: any) => p.status === 'ACTIVE' && p.code !== 'RAW_MATERIAL_SUPPLIER')
    .filter((p: any) => !sourceProc || p.sortOrder > sourceProc.sortOrder);

  const submitting = React.useRef(false);
  const route = useMutation({
    mutationFn: async () => {
      const q = Math.max(0, Math.trunc(Number(qty || 0)));
      if (q <= 0) throw new Error('Enter a quantity to route.');
      if (q > excessAvail) throw new Error(`Only ${excessAvail} excess pcs available.`);
      if (!targetBatchId) throw new Error('Pick a target batch.');
      if (!nextProcessId) throw new Error('Pick the next process for these pieces.');
      if (!vendorId) throw new Error('Pick the vendor who will receive these pieces.');
      await Api.casting.settle({
        stageIds: [stage.id],
        nextProcessId: Number(nextProcessId),
        vendorId: Number(vendorId),
        color: color || undefined,
        maxQty: q,
        targetBatchId: Number(targetBatchId),
      });
      return { q };
    },
    onSuccess: ({ q }) => {
      toast.success(`Routed ${q} excess pcs to the target batch — no new materials issued.`);
      qc.invalidateQueries({ queryKey: ['casting-batch'] });
      qc.invalidateQueries({ queryKey: ['casting-batches'] });
      qc.invalidateQueries({ queryKey: ['produced'] });
      submitting.current = false;
      onDone();
      onClose();
    },
    onError: (e) => { submitting.current = false; toast.error(getApiError(e).message); },
  });
  const submit = () => {
    if (submitting.current || route.isPending) return;
    submitting.current = true;
    route.mutate();
  };

  if (!stage) return null;
  return (
    <Dialog open={open} onClose={onClose} size="md"
      title="Route excess pieces to another batch"
      description={`These pieces are already produced at ${stage.processName} by ${stage.vendorCode}. Routing them to another batch skips re-issuing raw materials — they're ready to go to the next step.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={route.isPending}>Cancel</Button>
          <Button onClick={submit} disabled={route.isPending || excessAvail === 0}>
            {route.isPending && <Spinner />} Route {qty || 0} pcs
          </Button>
        </>
      }>
      <div className="space-y-4">
        <div className="rounded-lg border border-info/30 bg-info/15 px-3 py-2 text-sm">
          <div className="font-semibold text-sky-900">Source</div>
          <div className="mt-0.5 text-foreground">
            {stage.itemName ?? '—'}{stage.itemNumber ? ` · #${stage.itemNumber}` : ''} ·{' '}
            <span className="font-medium">{stage.processName}</span> ·{' '}
            <span className="font-medium">{stage.vendorCode} {stage.vendorName}</span>
            {stage.color && <> · <span className="font-medium">{stage.color}</span></>}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
            Ordered {stage.quantity} · Received {stage.receivedQty} · Forwarded {stage.forwardedQty ?? 0} ·{' '}
            <strong className="text-success">{excessAvail} excess available</strong>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Target batch *">
            <SearchableSelect
              value={targetBatchId}
              placeholder="— Pick batch —"
              onChange={(v) => setTargetBatchId(v ? Number(v) : '')}
              options={targetBatches.map((b: any) => ({
                value: b.id,
                label: `${b.batchNumber} · ${b.batchDate?.slice(0, 10) ?? ''}`,
                keywords: b.batchNumber,
              }))}
            />
          </Field>
          <Field label="Next process *">
            <Select value={nextProcessId} onChange={(e) => { setNextProcessId(e.target.value ? Number(e.target.value) : ''); setVendorId(''); }}>
              <option value="">— Pick next step —</option>
              {nextProcessOptions.map((p: any) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Vendor (for next step) *">
            <SearchableSelect
              value={vendorId}
              placeholder="— Pick vendor —"
              onChange={(v) => setVendorId(v ? Number(v) : '')}
              options={(vendorsQ.data ?? []).map((v: any) => ({
                value: v.id,
                label: `${v.vendorCode} · ${v.vendorName}`,
                keywords: v.vendorName,
              }))}
            />
          </Field>
          <Field label={`Quantity to route (max ${excessAvail})`}>
            <Input
              type="number" min={1} max={excessAvail} step="1"
              value={qty}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9]/g, '');
                const clamped = raw === '' ? '' : String(Math.min(excessAvail, Math.max(0, Math.trunc(Number(raw)))));
                setQty(clamped);
              }}
            />
          </Field>
          <Field label="Colour (optional override)">
            <Input value={color} placeholder={stage.color ?? '—'} onChange={(e) => setColor(e.target.value)} />
          </Field>
        </div>

        <div className="rounded-lg border border-success/30 bg-success/15 px-3 py-2 text-xs text-success">
          ✓ <strong>No raw materials will be re-issued.</strong> The original batch already paid for casting / plating / materials — these pieces are pure cost savings for the target batch.
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Slip picker — opens when the user clicks the per-stage "Slips (N)"
 * button. Lists the stage's issue slip + every receipt that touched it,
 * each row with date / qty / open-PDF / delete-receipt. Tax selector at
 * the top (GST 3% / URD 0% / None) is applied to every PDF opened from
 * this picker — vendor's tax treatment usually doesn't change between
 * slips, so one pick covers all opens in this session.
 */
type TaxMode = 'GST' | 'URD' | 'none';
/**
 * BatchSlipsFolder — top-of-batch consolidated slip listing.
 *
 * Mirrors the existing ShareDialog modal (Production Management list "Slips"
 * button), shown INLINE at the top of the batch detail so the user doesn't
 * have to leave the batch to grab a PDF.
 *
 * Tree: 📁 Process › 📂 Vendor › [🧾 Issue slip + 📥 receipts]
 *
 * Issue slip URL = per-vendor consolidated PDF for that vendor in that
 * process within this batch (Api.casting.pdfUrl). Receipt URLs are the
 * per-receipt internal PDF.
 */
/**
 * Sequentially download every URL as an individual file. Browsers block
 * triggering many downloads at once, so we fetch each as a blob, create
 * a temporary object-URL anchor with `download` attribute, click it, and
 * wait ~250ms before the next. Modern browsers (Chrome, Edge, Firefox)
 * show a one-time "Allow this site to download multiple files?" prompt
 * on the first run; subsequent batches run silently after the user
 * approves. The download attribute forces a save (vs the inline view
 * the per-slip <a href> would render), so the operator gets actual
 * files even though the backend's Content-Disposition is `inline`.
 *
 * Filename uses the server's Content-Disposition when present, falling
 * back to the supplied suggestedName. Toast counters keep the operator
 * informed across the longer runs.
 */
/** Fetch a single slip PDF as a Blob and trigger a save dialog with the
 *  given filename. Used by the per-row Download button so the operator gets
 *  a real file instead of an inline preview opening in a new tab. */
async function downloadSlipFile(url: string, suggestedName: string): Promise<void> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const blob = await res.blob();
  const filename = suggestedName.endsWith('.pdf') ? suggestedName : `${suggestedName}.pdf`;
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

/** Share a slip as an actual File via the native Web Share API (mobile
 *  attaches the PDF to WhatsApp / mail / etc.). On desktop or browsers
 *  without `canShare({files})`, falls back to download — never shares a URL,
 *  per operator request (URLs leak the token). */
async function shareSlipFile(url: string, suggestedName: string, title: string): Promise<void> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const blob = await res.blob();
  const filename = suggestedName.endsWith('.pdf') ? suggestedName : `${suggestedName}.pdf`;
  const file = new File([blob], filename, { type: 'application/pdf' });
  const nav: any = typeof navigator !== 'undefined' ? navigator : null;
  if (nav?.canShare && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title });
      return;
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      // Fall through to download.
    }
  }
  await downloadSlipFile(url, filename);
}

/** Sanitise a label fragment so it's safe in a filename across OSes. */
function safeFilenamePart(s: string): string {
  return (s ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}

async function bulkDownloadSlips(
  items: { url: string; suggestedName: string }[],
  kind: 'issue' | 'receipt',
  processName: string,
): Promise<void> {
  if (!items.length) return;
  toast.info(`Downloading ${items.length} ${kind} slip${items.length === 1 ? '' : 's'} for ${processName}…`);
  let ok = 0;
  let failed = 0;
  for (const it of items) {
    try {
      const res = await fetch(it.url, { credentials: 'include' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const blob = await res.blob();
      // Pick a filename — prefer the server's Content-Disposition, fall
      // back to the suggested name we built from the batch + vendor.
      const cd = res.headers.get('content-disposition') ?? '';
      const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)"?/i);
      const serverName = m?.[1] ? decodeURIComponent(m[1]).replace(/^"|"$/g, '') : '';
      const filename = serverName || it.suggestedName;
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke after a short delay so the browser has time to start the
      // save. Immediate revoke occasionally races on slower browsers.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      ok += 1;
      // 250ms breathing room between clicks — keeps the browser's
      // "multiple downloads" detector happy and gives Save dialogs time
      // to settle on configurations where the user has chosen "Always
      // ask where to save".
      await new Promise((r) => setTimeout(r, 250));
    } catch (e) {
      failed += 1;
      // Don't toast every failure inline — would spam. Surface a single
      // summary at the end so the operator knows the count.
      console.error('bulkDownloadSlips failed for', it.url, e);
    }
  }
  if (failed === 0) {
    toast.success(`Downloaded ${ok} ${kind} slip${ok === 1 ? '' : 's'} for ${processName}.`);
  } else if (ok === 0) {
    toast.error(`Could not download any ${kind} slips for ${processName} (${failed} failed). Check the server.`);
  } else {
    toast.warning(`Downloaded ${ok} of ${items.length} ${kind} slips for ${processName} — ${failed} failed. Try again or grab them individually.`);
  }
}

function BatchSlipsFolder({ batch, onEditReceipt }: { batch: any; onEditReceipt?: (receiptId: number) => void }) {
  // Default closed — user clicks to expand. Cleaner first read of the batch
  // detail (the strip + traveler are usually what the user came for).
  const [open, setOpen] = React.useState(false);
  // Copy / Share-URL helpers were dropped — operator share now always sends
  // the PDF file blob via shareSlipFile() in BatchSlipRow, so the auth token
  // in the URL is never leaked. Download is the desktop fallback.

  // Folder tree: Process › Vendor › [Issue slip + receipt slips]. Same shape
  // as the ShareDialog on the batches list — kept identical so users see one
  // consistent format whether they opened it from there or here.
  // For each vendor we also pre-compute the total qty being issued (sum of
  // all stages they're handling in this process) so the slip label can read
  // "B0036 · Mangal Tai · 02 Jun · 350 pcs" at a glance.
  // Folder tree: Process › Vendor › [N issue slips (one per forward day) +
  // receipt rows]. One vendor folder per vendor — multiple slip rows inside
  // when the vendor received forwards on multiple days.
  const folders = React.useMemo(() => {
    // Local-time YYYY-MM-DD — slipper grouping key per forward day. Local
    // (not UTC) so "this evening's forward" and "tomorrow morning's forward"
    // round to the operator's view of the calendar, not the server's.
    const ymdLocal = (d: any): string | null => {
      if (!d) return null;
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return null;
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    };
    const map = new Map<string, { processName: string; processId: number; vendors: Map<string, any> }>();
    for (const it of (batch?.items ?? []) as any[]) {
      if (!map.has(it.processName)) map.set(it.processName, { processName: it.processName, processId: it.processId, vendors: new Map() });
      const f = map.get(it.processName)!;
      const cur = f.vendors.get(it.vendorName) ?? {
        vendorName: it.vendorName,
        vendorCode: it.vendorCode,
        vendorId: it.vendorId,
        processId: it.processId,
        // Per-day buckets inside this vendor — Map<YYYY-MM-DD, {forwardDate, issuedAt, issueQty}>.
        // Flattened to an `issues[]` array at the end and the map is removed.
        issuesByDate: new Map<string, { forwardDate: string; issuedAt: string | null; issueQty: number }>(),
        receipts: [] as any[],
      };
      const stageDate = it.forwardedAt ?? it.workDate ?? it.createdAt ?? null;
      const fd = ymdLocal(stageDate) ?? ymdLocal(batch.batchDate) ?? '0000-00-00';
      const day = cur.issuesByDate.get(fd) ?? { forwardDate: fd, issuedAt: stageDate, issueQty: 0 };
      day.issueQty += it.quantity ?? 0;
      if (stageDate && (!day.issuedAt || new Date(stageDate) < new Date(day.issuedAt))) {
        day.issuedAt = stageDate;
      }
      cur.issuesByDate.set(fd, day);
      f.vendors.set(it.vendorName, cur);
    }
    // Attach receipts to whichever vendor folder matches by name (any
    // process). Receipts don't need date splitting — they already carry
    // their own receiptDate per row.
    for (const r of (batch?.receipts ?? []) as any[]) {
      const v = map.get(r.processName)?.vendors.get(r.vendorName);
      if (v) v.receipts.push(r);
    }
    // Flatten issuesByDate → issues[] (sorted ascending by date), drop the
    // map so it's not iterated downstream.
    for (const f of map.values()) {
      for (const v of f.vendors.values()) {
        v.issues = Array.from(v.issuesByDate.values()).sort(
          (a: any, b: any) => a.forwardDate.localeCompare(b.forwardDate),
        );
        delete v.issuesByDate;
      }
    }
    return Array.from(map.values());
  }, [batch]);

  if (folders.length === 0) return null;

  // Tally the chip on the folder header (process count + vendor count + receipt count).
  const vendorCount = folders.reduce((s, f) => s + f.vendors.size, 0);
  const receiptCount = (batch?.receipts ?? []).length;

  return (
    <div className="order-2 rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/30"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
          <span className="text-sm font-semibold">Slips & Receipts</span>
          <Badge variant="outline" className="text-xs">
            {folders.length} process · {vendorCount} vendor · {receiptCount} receipt
          </Badge>
        </div>
        <span className="text-xs text-muted-foreground">Process › Vendor</span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-border p-2">
          {/* Both process and vendor folders are CLOSED by default — user
              clicks to expand. Keeps the section compact when many vendors
              are involved on a multi-process batch. */}
          {folders.map((f) => {
            // Tally per-process slip counts — one slip per vendor × day,
            // so issueCount sums across vendors instead of being vendor count.
            const issueCount = Array.from(f.vendors.values()).reduce((s: number, v: any) => s + (v.issues?.length ?? 0), 0);
            const receiptCount = Array.from(f.vendors.values()).reduce((s: number, v: any) => s + (v.receipts?.length ?? 0), 0);
            // Pre-build the per-process slip URL lists. Each (vendor × day)
            // is its own PDF, so flatMap over vendor → issues to emit one
            // URL (with ?forwardDate=…) per day.
            const issueUrls: { url: string; suggestedName: string }[] = Array.from(f.vendors.values()).flatMap((v: any) =>
              (v.issues ?? []).map((iss: any) => ({
                url: Api.casting.pdfUrl(batch.id, v.vendorId, v.processId, undefined, iss.forwardDate),
                suggestedName: `${batch.batchNumber}-${v.vendorCode}-${v.vendorName}-${iss.forwardDate}-issue.pdf`.replace(/[^A-Za-z0-9._-]+/g, '_'),
              })),
            );
            const receiptUrls: { url: string; suggestedName: string }[] = Array.from(f.vendors.values()).flatMap((v: any) =>
              (v.receipts ?? []).map((r: any) => ({
                url: Api.casting.receiptPdfUrl(r.id),
                suggestedName: `${batch.batchNumber}-${r.receiptNumber}-${v.vendorName}-receipt.pdf`.replace(/[^A-Za-z0-9._-]+/g, '_'),
              })),
            );
            return (
            <details key={f.processName} className="rounded-lg border border-border">
              <summary className="cursor-pointer select-none bg-muted/50 px-3 py-2 text-sm font-semibold flex flex-wrap items-center justify-between gap-2">
                <span>📁 {f.processName}</span>
                {/* Per-process bulk download. Two buttons: all issue slips
                    (one PDF per vendor) and all receipt slips (one PDF per
                    receipt). Triggers SEQUENTIAL individual file downloads
                    (not a ZIP) — browser will ask once "allow multiple
                    downloads from this site", then each subsequent click
                    works seamlessly. stopPropagation keeps the click from
                    toggling the folder open/closed. */}
                <span className="flex items-center gap-1">
                  {issueCount > 0 && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); e.preventDefault(); bulkDownloadSlips(issueUrls, 'issue', f.processName); }}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-xs font-medium text-foreground hover:bg-muted"
                      title={`Download ${issueCount} individual issue PDF${issueCount === 1 ? '' : 's'}`}
                    >
                      <FileDown className="size-3.5" /> Issues ({issueCount})
                    </button>
                  )}
                  {receiptCount > 0 && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); e.preventDefault(); bulkDownloadSlips(receiptUrls, 'receipt', f.processName); }}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-xs font-medium text-foreground hover:bg-muted"
                      title={`Download ${receiptCount} individual receipt PDF${receiptCount === 1 ? '' : 's'}`}
                    >
                      <FileDown className="size-3.5" /> Receipts ({receiptCount})
                    </button>
                  )}
                </span>
              </summary>
              <div className="space-y-1 p-2">
                {Array.from(f.vendors.values()).map((v: any) => (
                  <details key={v.vendorName} className="rounded-md border border-border">
                    <summary className="cursor-pointer select-none px-3 py-1.5 text-sm font-medium">
                      📂 {v.vendorCode} · {v.vendorName}
                      {(v.issues?.length ?? 0) > 1 && (
                        <span className="ml-2 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">
                          · {v.issues.length} issues
                        </span>
                      )}
                    </summary>
                    <div className="space-y-1 px-3 pb-2">
                      {/* One BatchSlipRow per forward day — vendor that
                          received the batch's pieces on Mon and Tue sees
                          two rows here, each with its own date + qty + PDF. */}
                      {(v.issues ?? []).map((iss: any) => (
                        <BatchSlipRow
                          key={iss.forwardDate}
                          label={`🧾 ${batch.batchNumber} · ${v.vendorName} · ${formatDate(iss.issuedAt ?? batch.batchDate)} · ${(iss.issueQty ?? 0).toLocaleString()} pcs`}
                          url={Api.casting.pdfUrl(batch.id, v.vendorId, v.processId, undefined, iss.forwardDate)}
                          suggestedName={`${safeFilenamePart(batch.batchNumber)}-${safeFilenamePart(v.vendorCode ?? '')}-${safeFilenamePart(v.vendorName ?? '')}-${safeFilenamePart(iss.forwardDate ?? 'issue')}.pdf`}
                        />
                      ))}
                      {v.receipts.map((r: any) => (
                        <BatchSlipRow
                          key={r.id}
                          label={`📥 ${batch.batchNumber} · ${v.vendorName} · ${formatDate(r.receiptDate)} · ${(r.qty ?? 0).toLocaleString()} pcs`}
                          url={Api.casting.receiptPdfUrl(r.id)}
                          suggestedName={`${safeFilenamePart(batch.batchNumber)}-${safeFilenamePart(r.receiptNumber ?? String(r.id))}-${safeFilenamePart(v.vendorName ?? '')}-receipt.pdf`}
                          onEdit={onEditReceipt ? () => onEditReceipt(r.id) : undefined}
                        />
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </details>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * BatchRepairsPanel — in-batch slice of /repairs. Lists every RepairOrder
 * tied to a stage in THIS batch so the user has full repair context without
 * leaving the batch dialog. Hidden when the batch has zero repairs.
 *
 * Each OPEN row carries two actions:
 *   • Repair slip  — opens the PDF in a new tab
 *   • Receive back — opens the in-batch ReceiveForm scoped to that repair
 *                    (vendor pre-selected, fromRepairOrderId stamped on
 *                    every line, lands the pcs back in this same batch)
 *
 * RETURNED + FINAL_REJECTED rows are surfaced as history so the user sees
 * what's resolved and what's still owed.
 */
function BatchRepairsPanel({ batch, onReceiveBack }: { batch: any; onReceiveBack: (r: any) => void }) {
  const [open, setOpen] = React.useState(true);
  const repairsQ = useQuery({
    queryKey: ['batch-repairs', batch?.id],
    queryFn: () => Api.casting.listRepairs({ batchId: batch.id }),
    enabled: !!batch?.id,
  });
  const rows = repairsQ.data ?? [];
  if (!batch?.id || rows.length === 0) return null;
  const openRows = rows.filter((r: any) => r.status === 'OPEN');
  const returnedRows = rows.filter((r: any) => r.status === 'RETURNED');
  const rejectedRows = rows.filter((r: any) => r.status === 'FINAL_REJECTED');

  return (
    <div className="order-2 rounded-lg border border-warning/30 bg-warning/15">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-warning/10/80"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
          <Wrench className="size-4 text-warning" />
          <span className="text-sm font-semibold text-warning">Repair Orders</span>
          <Badge variant="outline" className="text-xs">
            {openRows.length} open · {returnedRows.length} returned · {rejectedRows.length} final-rejected
          </Badge>
        </div>
        <span className="text-xs text-warning">
          Receive back lands pcs in this same batch
        </span>
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-warning/30 p-2">
          {openRows.map((r: any) => {
            const cycleHigh = r.cycle >= 3;
            return (
              <div
                key={r.id}
                className={cn(
                  'flex flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2 text-xs',
                  cycleHigh ? 'border-amber-400' : 'border-border',
                )}
              >
                <span className="font-mono text-[11px] font-semibold tracking-wide text-warning">
                  🔧 REP-{r.id}
                </span>
                <Badge variant="outline" className="text-[10px]">cycle {r.cycle}</Badge>
                {cycleHigh && (
                  <Badge variant="destructive" className="text-[10px]" title="Consider rejecting instead of repairing again">
                    ⚠ cycle ≥ 3
                  </Badge>
                )}
                <span className="text-muted-foreground">·</span>
                <span className="font-semibold tabular-nums">{r.qty} pcs</span>
                <span className="text-muted-foreground">·</span>
                <Badge variant="default" className="text-[10px]">{r.processName ?? '—'}</Badge>
                <span className="text-muted-foreground">·</span>
                <span className="text-foreground">{r.vendorCode} · {r.vendorName}</span>
                {r.reason && (
                  <span className="text-muted-foreground truncate" title={r.reason}>
                    · {r.reason}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1">
                  <a href={Api.casting.repairPdfUrl(r.id)} target="_blank" rel="noreferrer">
                    <Button variant="outline" size="sm">
                      <FileDown className="size-3.5" /> Slip
                    </Button>
                  </a>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => onReceiveBack(r)}
                    title="Open the Receive form scoped to this repair — pcs land back in this same batch"
                  >
                    <CheckCircle2 className="size-3.5" /> Receive back
                  </Button>
                </div>
              </div>
            );
          })}
          {returnedRows.length > 0 && (
            <details className="rounded-md border border-border bg-card/60 px-3 py-1.5">
              <summary className="cursor-pointer select-none text-xs font-medium text-success">
                ✓ Returned ({returnedRows.length})
              </summary>
              <div className="mt-1.5 space-y-1 text-[11px] text-muted-foreground">
                {returnedRows.map((r: any) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">REP-{r.id}</span>
                    <span>·</span>
                    <span>{r.qty} pcs</span>
                    <span>·</span>
                    <span>{r.processName} · {r.vendorCode}</span>
                    <span>·</span>
                    <span>cycle {r.cycle}</span>
                    {r.returnedAt && (<><span>·</span><span>returned {formatDate(r.returnedAt)}</span></>)}
                  </div>
                ))}
              </div>
            </details>
          )}
          {rejectedRows.length > 0 && (
            <details className="rounded-md border border-destructive/30 bg-destructive/10/40 px-3 py-1.5">
              <summary className="cursor-pointer select-none text-xs font-medium text-destructive">
                ⛔ Final-rejected ({rejectedRows.length})
              </summary>
              <div className="mt-1.5 space-y-1 text-[11px] text-muted-foreground">
                {rejectedRows.map((r: any) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">REP-{r.id}</span>
                    <span>·</span>
                    <span>{r.finalRejectedQty} pcs rejected</span>
                    <span>·</span>
                    <span>{r.processName} · {r.vendorCode}</span>
                    <span>·</span>
                    <span>cycle {r.cycle}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function BatchSlipRow({
  label, url, suggestedName, onEdit,
}: {
  label: string;
  url: string;
  // File-system safe basename used for Download + Share dialogs. Caller
  // composes from batch / vendor / date so the operator can find the file
  // later by name.
  suggestedName: string;
  // Only receipt rows get an Edit button — issue slips and repair slips
  // don't (their underlying data lives on stages / repair orders, not
  // a single editable receipt record).
  onEdit?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-card px-2.5 py-1.5 text-sm">
      <span className="min-w-0 truncate">{label}</span>
      <div className="flex flex-wrap gap-1">
        <a href={url} target="_blank" rel="noreferrer">
          <Button variant="outline" size="sm"><FileDown className="size-4" /> Open</Button>
        </a>
        <Button variant="outline" size="sm"
          onClick={() => downloadSlipFile(url, suggestedName).catch((e) => toast.error(`Download failed: ${e.message}`))}
          title="Save the PDF to your device">
          <FileDown className="size-4" /> Download
        </Button>
        <Button variant="outline" size="sm"
          onClick={() => shareSlipFile(url, suggestedName, label).catch((e) => toast.error(`Share failed: ${e.message}`))}
          title="Share the PDF file (mobile: WhatsApp / mail / etc.). Falls back to download on desktop.">
          <Share2 className="size-4" /> Share
        </Button>
        {onEdit && (
          <Button
            variant="outline" size="sm" className="text-warning hover:bg-warning/10"
            onClick={onEdit}
            title="Edit this receipt — opens the form pre-filled. Blocked if pieces were forwarded onward."
          >
            <Pencil className="size-4" /> Edit
          </Button>
        )}
      </div>
    </div>
  );
}

function SlipPickerDialog({
  stage, open, onClose, onDeleteReceipt, deleting, onEditReceipt,
}: { stage: any; open: boolean; onClose: () => void; onDeleteReceipt: (id: number) => void; deleting: boolean; onEditReceipt?: (receiptId: number) => void }) {
  const [taxMode, setTaxMode] = React.useState<TaxMode>('GST');
  React.useEffect(() => { if (open) setTaxMode('GST'); }, [open]);
  if (!stage) return null;
  const receipts = (stage.stageReceipts ?? []) as any[];
  const taxParam = taxMode === 'none' ? null : taxMode;
  return (
    <Dialog open={open} onClose={onClose} size="md"
      title="📑 Slips for this stage"
      description={`${stage.processName ?? ''} · ${stage.vendorCode ?? ''} ${stage.vendorName ?? ''}${stage.color ? ` · ${stage.color}` : ''}`}
      footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
      <div className="space-y-3">
        {/* Tax selector — chosen value gets added as ?tax=GST|URD on every
            PDF link below. "None" omits the parameter so the PDF skips the
            tax block entirely (useful for internal copies). */}
        <div className="rounded-lg border border-warning/30 bg-warning/15 px-3 py-2">
          <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-warning">Tax treatment for this vendor</div>
          <div className="inline-flex overflow-hidden rounded-md border border-warning/40 bg-white text-xs">
            {([
              ['GST', 'GST (+3%)'],
              ['URD', 'URD (+0%)'],
              ['none', 'No tax line'],
            ] as [TaxMode, string][]).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setTaxMode(k)}
                className={cn(
                  'px-3 py-1.5 transition-colors',
                  taxMode === k ? 'bg-warning/100 font-semibold text-white' : 'text-warning hover:bg-warning/15',
                )}>
                {label}
              </button>
            ))}
          </div>
          <div className="mt-1 text-[11px] text-warning">
            GST adds 3%. URD adds 0% (vendor un-registered). Affects the Subtotal · Tax · Grand Total block at the bottom of every PDF you open from here.
          </div>
        </div>

        {stage.issueSlipId && (
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">🧾 Issue slip</div>
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
              <div className="text-sm">
                <strong>ISS-{stage.issueSlipId}</strong>
                <span className="ml-2 text-muted-foreground">{stage.quantity} pcs ordered</span>
              </div>
              <a href={Api.casting.stagePdfUrl(stage.issueSlipId, taxParam)} target="_blank" rel="noreferrer">
                <Button variant="outline" size="sm"><FileDown className="size-4" /> Open PDF</Button>
              </a>
            </div>
          </div>
        )}
        {receipts.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              📥 Receipts ({receipts.length})
            </div>
            <div className="space-y-1">
              {receipts.map((r: any) => {
                const myItem = (r.items ?? []).find((ri: any) => ri.batchItemId === stage.id);
                const recdHere = myItem?.receivedQty ?? 0;
                return (
                  <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-info/30 bg-info/15 px-3 py-2">
                    <div className="text-sm">
                      <strong>{r.receiptNumber}</strong>
                      <span className="ml-2 text-muted-foreground">{formatDate(r.receiptDate)}</span>
                      <span className="ml-2 font-medium text-info">+{recdHere} pcs</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <a href={Api.casting.receiptPdfUrl(r.id, taxParam)} target="_blank" rel="noreferrer">
                        <Button variant="outline" size="sm"><FileDown className="size-4" /> Open PDF</Button>
                      </a>
                      {onEditReceipt && (
                        <Button variant="outline" size="sm" className="text-warning hover:bg-warning/10"
                          onClick={() => onEditReceipt(r.id)}
                          title="Edit this receipt — blocked if pieces were forwarded onward.">
                          <Pencil className="size-4" /> Edit
                        </Button>
                      )}
                      <Button variant="outline" size="sm" className="text-destructive hover:bg-destructive/10"
                        disabled={deleting}
                        onClick={() => {
                          if (window.confirm(`Delete receipt ${r.receiptNumber}? Balances will be restored (blocked if pieces were already forwarded).`)) {
                            onDeleteReceipt(r.id);
                          }
                        }} title="Delete receipt">
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {!stage.issueSlipId && receipts.length === 0 && (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            No slips for this stage yet.
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function BatchDetail({
  batchId, open, onClose, autoForward = false, autoReceiveRepairId = null,
}: {
  batchId: number | null;
  open: boolean;
  onClose: () => void;
  // When true, picks the first stage with availableToForward > 0 the moment
  // the batch data lands and opens the ForwardDialog directly. Used by the
  // ✈ Send button on Production Management so the user lands on the forward
  // dialog in one click instead of having to scroll the traveler.
  autoForward?: boolean;
  // When set, fetches that RepairOrder and auto-opens the in-batch Receive
  // form scoped to it. Used by /repairs "Receive back" so the user lands
  // inside the batch dialog with the receive form already up — full
  // context, single click from origin to save.
  autoReceiveRepairId?: number | null;
}) {
  const qc = useQueryClient();
  const [forwardStage, setForwardStage] = React.useState<any>(null);
  // Re-issue materials dialog — operator clicks "Issue more" on an at-vendor
  // stage that has pending work and needs additional materials sent.
  const [reissueStage, setReissueStage] = React.useState<any>(null);
  const [editStage, setEditStage] = React.useState<any>(null);
  // "+ Add design" — mid-batch addition of a new design line. Opens a
  // minimal one-row form; on save creates a fresh root Casting stage in
  // this batch (and runs the same Item Master auto-sync the New Batch
  // form does). Closed-batch state hides the button entirely.
  const [addDesignOpen, setAddDesignOpen] = React.useState(false);
  const [routeExcessStage, setRouteExcessStage] = React.useState<any>(null);
  // Stage whose slip-picker popup is open. Renders a small modal that lists
  // the stage's issue slip + every receipt that touched it, each with date /
  // qty / "Open PDF". Replaces the previous row of mini chips (issue + N
  // receipts) which crowded the Actions column.
  const [slipPickerStage, setSlipPickerStage] = React.useState<any>(null);
  const [openGroups, setOpenGroups] = React.useState<Record<string, boolean>>({});
  // receiveRepair: when set, the in-batch ReceiveForm opens scoped to this
  // RepairOrder. The form pre-fills the vendor + stamps fromRepairOrderId
  // on every submitted line so the backend can mark the repair RETURNED
  // and chain a re-repair cycle if anything still needs more work.
  const [receiveRepair, setReceiveRepair] = React.useState<any>(null);
  // editReceiptId: when set, opens the ReceiveForm in EDIT mode against
  // an existing receipt — preserves the receipt's id + receiptNumber.
  // Driven by the per-receipt "Edit" button in the Slips & Receipts
  // panel. Backend refuses when pieces were forwarded onward or the
  // receipt has repair-related rows (operator gets a clear toast).
  const [editReceiptId, setEditReceiptId] = React.useState<number | null>(null);
  const toggleGroup = (k: string) => setOpenGroups((g) => ({ ...g, [k]: !g[k] }));
  // Each design line is collapsible — a batch can hold many designs.
  const [openLines, setOpenLines] = React.useState<Record<string, boolean>>({});
  const toggleLine = (k: string) => setOpenLines((g) => ({ ...g, [k]: !g[k] }));

  const { data: batch, isLoading } = useQuery({
    queryKey: ['casting-batch', batchId],
    queryFn: () => Api.casting.batch(batchId!),
    enabled: open && !!batchId,
    // Always refetch when the dialog opens / window regains focus so the
    // available-to-forward counts on the action buttons reflect reality. The
    // stale numbers were the root cause of the "Only 0 available" surprise.
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  // 3-hour batch edit-window check. Backend enforces the lock on every
  // mutation; this is the UI mirror so non-admin operators see edit /
  // delete / add-design buttons greyed out (with a tooltip explaining
  // why) rather than clicking and getting a toast error. Admins always
  // see editable buttons. `editLockedAt` is an ISO string from the
  // backend (when the grace period ENDS). `editLockReason` carries a
  // friendly explanation for the button tooltip.
  const { user: authUser } = useAuth();
  const isAdmin = authUser?.role === 'ADMIN';
  const editLockedAt = batch?.editLockedAt ? new Date(batch.editLockedAt).getTime() : null;
  const editLocked = !isAdmin && editLockedAt != null && Date.now() > editLockedAt;
  const editLockReason = editLocked && batch?.createdAt
    ? `Batch ${batch.batchNumber} was issued more than 3 hours ago — edit window has closed. Ask an admin to make this change.`
    : undefined;

  // autoForward: as soon as batch data lands, find the first idle stage and
  // pop the Forward dialog directly. Picks the EARLIEST process in the
  // pipeline (lowest stageProcess.sortOrder is implicit in lineKey/sortOrder
  // ordering) and falls back to the first stage with availableToForward > 0
  // in document order. Fires once per dialog-open cycle — if the user closes
  // the forward dialog manually, we don't re-open it. autoForwardTriggered
  // resets when the dialog itself closes.
  // autoReceiveRepair: fetch the repair (when set) so its vendor/qty/etc.
  // are available BEFORE we open the in-batch ReceiveForm. Fires once per
  // dialog-open cycle. Resets when the dialog closes (open === false).
  const autoReceiveTriggered = React.useRef(false);
  const autoReceiveRepairQ = useQuery({
    queryKey: ['repair', autoReceiveRepairId],
    queryFn: () => Api.casting.getRepair(autoReceiveRepairId!),
    enabled: open && !!autoReceiveRepairId,
  });
  React.useEffect(() => {
    if (!open) { autoReceiveTriggered.current = false; return; }
    if (!autoReceiveRepairId || autoReceiveTriggered.current) return;
    const r = autoReceiveRepairQ.data;
    if (!r) return;
    autoReceiveTriggered.current = true;
    setReceiveRepair(r);
  }, [open, autoReceiveRepairId, autoReceiveRepairQ.data]);

  const autoForwardTriggered = React.useRef(false);
  React.useEffect(() => {
    if (!open) { autoForwardTriggered.current = false; return; }
    if (!autoForward || autoForwardTriggered.current || !batch) return;
    const candidates = (batch.lines ?? [])
      .flatMap((l: any) => l.stages ?? [])
      .filter((s: any) => !s.closed && (s.availableToForward ?? 0) > 0);
    if (candidates.length === 0) return; // nothing actionable; stay on overview
    const first = candidates[0];
    autoForwardTriggered.current = true;
    // Compute lineCodes (processes ALREADY done in this design line) by
    // walking up the parentItemId chain. Without this the Forward dialog's
    // "Next process" dropdown would include the CURRENT stage's process,
    // which lets the user re-pick the same process (B0046's Meena got
    // forwarded into another Meena because lineCodes was []).
    const stageById = new Map<number, any>();
    for (const ln of (batch.lines ?? [])) {
      for (const s of (ln.stages ?? [])) stageById.set(s.id, s);
    }
    const codes = new Set<string>();
    let cur: any = first;
    while (cur) {
      if (cur.processCode) codes.add(cur.processCode);
      cur = cur.parentItemId ? stageById.get(cur.parentItemId) : null;
    }
    setForwardStage({ ...first, lineCodes: Array.from(codes) });
  }, [open, autoForward, batch]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['casting-batch', batchId] });
    qc.invalidateQueries({ queryKey: ['casting-batches'] });
    qc.invalidateQueries({ queryKey: ['stock'] });
  };

  const closeItem = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => Api.casting.closeItem(id, reason),
    onSuccess: () => { toast.success('Order closed short. Balance moved to vendor ledger.'); refresh(); },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const reopenItem = useMutation({
    mutationFn: (id: number) => Api.casting.reopenItem(id),
    onSuccess: () => { toast.success('Order re-opened.'); refresh(); },
    onError: (e) => toast.error(getApiError(e).message),
  });
  // Undo a mistaken forward — only works when the stage is a child, has no
  // receipts, no children, and isn't short-closed. Backend reverses any
  // auto-issued sticking materials too.
  const undoForward = useMutation({
    mutationFn: (id: number) => Api.casting.deleteStage(id),
    onSuccess: (r: any) => {
      // Backend returns { id, batchId }. Root-stage delete vs child-stage
      // undo share the same endpoint — message picked by what the stage
      // WAS (we resolve via local lookup since the row has just unmounted).
      toast.success('Removed. If a forward was undone, pieces are back in the parent stage and materials restored to stock.');
      void r;
      refresh();
    },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const undoReceipt = useMutation({
    mutationFn: (payload: any) => Api.casting.createReceipt(payload),
    onSuccess: () => { toast.success('Receipt restored.'); refresh(); },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const closeBatchM = useMutation({
    mutationFn: (reason?: string) => Api.casting.closeBatch(batchId!, reason),
    onSuccess: (r: any) => { toast.success(`Batch closed — ${r.closedStages} stage(s) short-closed.`); refresh(); },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const reopenBatchM = useMutation({
    mutationFn: () => Api.casting.reopenBatch(batchId!),
    onSuccess: () => { toast.success('Batch reopened — back to Active.'); refresh(); },
    onError: (e) => toast.error(getApiError(e).message),
  });
  const delReceipt = useMutation({
    mutationFn: (id: number) => Api.casting.deleteReceipt(id),
    onSuccess: (res: any) => {
      refresh();
      toast.success('Receipt deleted — balances restored.', {
        action: res?.undo ? { label: 'Undo', onClick: () => undoReceipt.mutate(res.undo) } : undefined,
        duration: 8000,
      });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const onClickClose = (it: any) => {
    const reason = window.prompt(`Close this stage short?\nPending ${it.pendingQty} pcs will be recorded as an outstanding balance against ${it.vendorName}.\n\nReason (optional):`, 'Vendor will not supply / not needed');
    if (reason === null) return;
    closeItem.mutate({ id: it.id, reason });
  };

  // One stage as a TABLE ROW. `sub` = a child row inside a merged process group.
  // `lineCodes` = process codes already in this design line (to hide done steps when forwarding).
  const stageRow = (st: any, sub = false, lineCodes: string[] = []) => (
    <tr key={st.id} className="border-t border-border align-middle">
      <td className="px-3 py-2">
        {sub
          ? <span className="pl-4 text-xs text-muted-foreground">↳ issue</span>
          : (
            <div className="flex flex-col gap-0.5">
              <Badge variant="default" className="whitespace-nowrap">{st.processName}</Badge>
              {/* Work date — receiptDate of the latest receipt (= when
                  the operator says the work actually happened). Falls
                  back to forwardedAt for stages with no receipts yet.
                  Casting shows batchDate at the header; this gives
                  every OTHER process its own date the same way. */}
              {(st.workDate || st.forwardedAt) && (
                <span className="text-[10px] text-muted-foreground" title={st.workDate ? `Work date (latest receipt): ${formatDate(st.workDate)}` : `Forwarded: ${formatDate(st.forwardedAt)}`}>
                  {(st.receivedQty ?? 0) > 0 ? '✓ ' : '→ '}{formatDate(st.workDate ?? st.forwardedAt)}
                </span>
              )}
            </div>
          )}
      </td>
      <td className="px-3 py-2"><ProdStatus label={st.status} /></td>
      <td className="truncate px-3 py-2 text-muted-foreground" title={`${st.vendorCode} · ${st.vendorName}`}>{st.vendorCode} · {st.vendorName}</td>
      <td className="truncate px-3 py-2 text-muted-foreground">{st.vendorDesignReference || '—'}</td>
      <td className="truncate px-3 py-2">{st.color ? <Badge variant="outline">{st.color}</Badge> : '—'}</td>
      <td className="px-3 py-2 font-semibold">{st.quantity}</td>
      <td className="px-3 py-2 text-success">{st.receivedQty}</td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-1">
          {st.closed ? <span className="text-text-faint">short {st.shortQty ?? 0}</span>
            : st.pendingQty > 0 ? <span className="text-warning">{st.pendingQty} pending</span>
            : st.forwardedQty > 0 ? <span className="text-info">{st.forwardedQty} fwd</span>
            : <span className="text-muted-foreground">—</span>}
          {(st.openRepairQty ?? 0) > 0 && (
            <span
              className="inline-flex items-center gap-0.5 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning ring-1 ring-amber-300"
              title={`${st.openRepairQty} pc${st.openRepairQty > 1 ? 's' : ''} with ${st.vendorName} for repair`}
            >
              🔧 {st.openRepairQty} at repair
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2">
        {/* Wraps on mobile so 3-4 action buttons reflow onto two rows
            instead of overflowing the cell. */}
        <div className="flex flex-wrap items-center justify-end gap-1">
          <Button
            variant="outline" size="icon" className="size-8"
            disabled={editLocked}
            title={editLockReason ?? 'Edit this step'}
            onClick={() => setEditStage(st)}
          >
            <Pencil className="size-4" />
          </Button>
          {/* Delete — only when the stage is FRESH (no settle activity, no
              forwards, not closed). Root stage: removes the design line
              from the batch. Child stage: undoes the forward (pcs return
              to parent's idle pool). Same backend call, different copy. */}
          {!st.closed
            && (st.acceptedQty ?? 0) + (st.repairQty ?? 0) + (st.rejectedQty ?? 0) === 0
            && (st.openRepairQty ?? 0) === 0
            && (st.forwardedQty ?? 0) === 0 && (
            <Button
              variant="outline" size="icon"
              className="size-8 text-destructive hover:bg-destructive/10"
              disabled={undoForward.isPending || editLocked}
              title={editLockReason ?? (st.parentItemId == null
                ? 'Delete this design from the batch — no receipts or children exist yet.'
                : 'Undo this forward — pieces go back to the parent stage; auto-issued materials reverse.')}
              onClick={() => {
                const isRoot = st.parentItemId == null;
                const msg = isRoot
                  ? `Delete this design from the batch?\n\nDesign: #${st.itemNumber ?? '?'}${st.itemName ? ' · ' + st.itemName : ''}\n${st.quantity} pcs · ${st.vendorCode} · ${st.processName}\n\nThis line is fresh (no receipts, no children) — safe to remove. The rest of the batch is untouched.`
                  : `Undo this forward?\n\nStage: ${st.processName}${st.color ? ' · ' + st.color : ''} · ${st.quantity} pcs to ${st.vendorCode}\n\n• Pieces go back to the parent stage's idle pool.\n• Any auto-issued sticking materials are reversed.\n• No history is lost on the parent or upstream.`;
                if (window.confirm(msg)) undoForward.mutate(st.id);
              }}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
          {st.availableToForward > 0 && (
            <Button variant="outline" size="sm" onClick={() => setForwardStage({ ...st, lineCodes })}>
              Send {st.availableToForward} <ArrowRight className="size-4" />
            </Button>
          )}
          {/* Packing is final — instead of forwarding, pcs go through
              Categorize. Uses the SAME filled "default" variant as the
              Send button on other stages so the eye finds the "next step"
              affordance at a glance. */}
          {st.processCode === 'PACKING' && (st.receivedQty ?? 0) > 0 && (
            <Link href={`/casting/categorize/${batch.id}`} prefetch={false}>
              <Button variant="default" size="sm">
                <Send className="size-4" /> Categorize
              </Button>
            </Link>
          )}
          {!st.closed && st.pendingQty > 0 && (
            <Button variant="outline" size="sm" className="text-warning hover:bg-warning/10"
              onClick={() => onClickClose(st)} disabled={closeItem.isPending}>
              <XCircle className="size-4" /> Close
            </Button>
          )}
          {st.closed && (
            <button className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              onClick={() => reopenItem.mutate(st.id)} disabled={reopenItem.isPending}>
              <RotateCcw className="size-3" /> Reopen
            </button>
          )}
        </div>
      </td>
    </tr>
  );

  return (
    <Dialog open={open} onClose={onClose} size="full"
      title={batch ? `Production Batch ${batch.batchNumber}` : 'Production Batch'}
      description={batch ? formatDate(batch.batchDate) : undefined}>
      {isLoading || !batch ? (
        <div className="flex justify-center py-10"><Spinner className="size-6 text-primary" /></div>
      ) : (
        <div className="flex flex-col gap-3">
          {/* Edit-window banner — only when the 3h grace has closed AND
              the operator isn't ADMIN. Surfaces WHY edit buttons below
              are disabled (otherwise people would click and wonder). */}
          {editLocked && (
            <div className="order-0 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
              <span className="text-lg leading-none">🔒</span>
              <div>
                <div className="font-semibold">Editing locked</div>
                <div className="text-xs">{editLockReason}</div>
              </div>
            </div>
          )}
          <div className="order-1 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <ProdStatus label={batch.displayStatus ?? batch.status} />
              {/* Count DISTINCT designs (itemNumber), not raw lineKey rows —
                  one design with 5 colour splits is still 1 design, not 5.
                  batch.lines contains a row per (lineKey) which over-counts
                  when colour-splits or settle-absorbs are in play. */}
              {(() => {
                const distinct = new Set<string>();
                for (const ln of (batch.lines ?? [])) {
                  const k = ln.itemNumber ?? (ln.itemId != null ? `id:${ln.itemId}` : null);
                  if (k) distinct.add(k);
                }
                const designs = distinct.size;
                return (
                  <span className="text-sm text-muted-foreground">
                    {designs} design{designs === 1 ? '' : 's'} · {batch.vendors.length} vendor{batch.vendors.length === 1 ? '' : 's'}
                  </span>
                );
              })()}
            </div>
            {batch.closed ? (
              <Button variant="outline" size="sm" className="text-primary hover:bg-primary/10"
                disabled={reopenBatchM.isPending}
                onClick={() => {
                  if (!window.confirm('Reopen this short-closed batch? It will return to the Active folder. Per-stage closes stay as they are (reopen them individually if needed).')) return;
                  reopenBatchM.mutate();
                }}>
                <RotateCcw className="size-4" /> Reopen Batch
              </Button>
            ) : batch.displayStatus !== 'Completed' && (
              <>
                <Button variant="outline" size="sm"
                  disabled={editLocked}
                  title={editLockReason}
                  onClick={() => setAddDesignOpen(true)}>
                  <Plus className="size-4" /> Add Design
                </Button>
                <Button variant="outline" size="sm" className="text-warning hover:bg-warning/10"
                  disabled={closeBatchM.isPending}
                  onClick={() => {
                    const reason = window.prompt('Mark this batch Short-Closed?\nEvery still-open stage will be short-closed; the batch moves to the Short-Closed folder.\n\nReason (optional):', '');
                    if (reason === null) return;
                    closeBatchM.mutate(reason || undefined);
                  }}>
                  <XCircle className="size-4" /> Close Batch Short
                </Button>
              </>
            )}
          </div>

          {/* Live verification — strip on desktop; 2x2 grid on phones so the
              four stats stay readable without crowding into one line. */}
          {batch.summary && (
            <div className="order-2 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs sm:flex sm:flex-wrap sm:gap-x-4">
              {[
                ['Issued', `${batch.summary.issuedQty} pcs · ${batch.summary.issuedWeight} g`],
                ['Received', `${batch.summary.receivedQty} pcs · ${batch.summary.receivedWeight} g`],
                ['Pending', `${batch.summary.pendingQty} pcs · ${batch.summary.balanceWeight} g`],
                ['Excess / Short', `${batch.summary.excessQty} / ${batch.summary.shortQty}`],
              ].map(([label, val]) => (
                <div key={label as string} className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-1.5">
                  <span className="uppercase tracking-wide text-muted-foreground text-[10px] sm:text-xs">{label}:</span>
                  <span className="font-semibold text-foreground truncate">{val as any}</span>
                </div>
              ))}
            </div>
          )}

          {/* SLIPS FOLDER — every issue slip generated for this batch, grouped
              by issueSlipId (= one slip per vendor per ≤15-min window). One
              row per slip; opens the slip PDF in a new tab. Receipts go on
              their own row beneath the slip they belong to. */}
          <BatchSlipsFolder batch={batch} onEditReceipt={(id) => setEditReceiptId(id)} />

          {/* In-batch Repair Orders panel — lists every repair order tied
              to a stage in this batch so the user has the full repair
              context without leaving the batch detail. /repairs page stays
              as a cross-batch global list; this is the per-batch slice. */}
          <BatchRepairsPanel batch={batch} onReceiveBack={(r) => {
            // Open the receive form in the same dialog scoped to this repair.
            setReceiveRepair(r);
          }} />

          {/* Traveler — each design line and its journey through the processes */}
          <div className="order-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Production Traveler</div>
              {(batch.lines?.length ?? 0) > 1 && (
                <div className="flex gap-1 text-xs">
                  <button className="text-primary hover:underline"
                    onClick={() => setOpenLines(Object.fromEntries((batch.lines ?? []).map((l: any) => [l.lineKey, true])))}>Expand all</button>
                  <span className="text-muted-foreground">·</span>
                  <button className="text-primary hover:underline"
                    onClick={() => setOpenLines(Object.fromEntries((batch.lines ?? []).map((l: any) => [l.lineKey, false])))}>Collapse all</button>
                </div>
              )}
            </div>
            {(() => {
              // Group lines by design (itemId) so a single design with multiple
              // colour-split traveler tracks renders as ONE expandable card —
              // not three "Design #3141" rows at the top level. Inside the card,
              // each track is its own collapsible sub-section with its own
              // stages table.
              const designs = new Map<any, { itemId: any; itemNumber: any; itemName: any; colorModel: any; colorModelsAvailable: number; lines: any[] }>();
              for (const l of (batch.lines ?? []) as any[]) {
                const key = l.itemId ?? l.itemNumber ?? l.lineKey;
                const cur: { itemId: any; itemNumber: any; itemName: any; colorModel: any; colorModelsAvailable: number; lines: any[] } = designs.get(key) ?? {
                  itemId: l.itemId, itemNumber: l.itemNumber, itemName: l.itemName,
                  colorModel: l.colorModel, colorModelsAvailable: l.colorModelsAvailable ?? 0,
                  lines: [],
                };
                cur.lines.push(l);
                designs.set(key, cur);
              }
              const designList = Array.from(designs.values());
              const designKey = (d: any) => `design-${d.itemId ?? d.itemNumber ?? d.lines[0]?.lineKey}`;

              return designList.map((d) => {
                const dk = designKey(d);
                // Always start collapsed — user opens the designs they care
                // about. With 50 designs in a batch, default-open would be a
                // wall of trees. "Expand all" link at the top still works for
                // when the user wants to see everything.
                const isDesignOpen = openLines[dk] ?? false;
                // Flatten all stages for this design into one list — we then
                // build a true parent→child lineage tree (matches reality:
                // Casting → Plating splits into colours → Meena splits further).
                const allStages: any[] = d.lines.flatMap((l: any) => l.stages);
                // Distinct vendor design refs across this design's stages.
                // Surfaced alongside our internal item number in the line
                // header — vendors ship on THEIR number ("vRef 8748" on
                // the box), so seeing both makes matching the incoming
                // material to our line a one-look operation. Filters out
                // empty / placeholder refs so cards stay clean for items
                // that haven't captured a vendor code yet.
                const distinctVendorRefs = Array.from(new Set(
                  allStages
                    .map((s: any) => (s.vendorDesignReference ?? '').trim())
                    .filter((s: string) => s.length > 0),
                ));
                // Distinct PLATING colours only — these define the visible base
                // colour of each variant of the design. Other steps (Meena,
                // Sticking, Fitting) also carry colours but they're per-piece
                // detailing on top of the plating, not the variant identity.
                // Showing every colour across every process polluted the
                // header with 5-6 chips per design that didn't map cleanly
                // to "what variants are we making".
                const distinctColours = Array.from(new Set(
                  allStages
                    .filter((s: any) => s.processCode === 'PLATING')
                    .map((s: any) => s.color)
                    .filter(Boolean),
                ));
                // Distinct INTERNAL colour-model variants ("a — Ruby", "b — Pink")
                // present in this design's stages. Internal-only tracking info —
                // not shown to customers, but lets the shop floor instantly tell
                // which model each piece belongs to.
                const distinctVariants = Array.from(new Set(
                  allStages.map((s: any) => s.colorModel).filter(Boolean),
                )) as string[];
                const designStatus = d.lines.every((l: any) => l.completed)
                  ? 'Completed'
                  : allStages.some((s: any) => s.receivedQty > 0) ? 'In Process' : 'Issued';
                // Counters for the design header — gives the user instant insight
                // into what state this design is in BEFORE they expand.
                const actionsWaiting = allStages.filter((s: any) => !s.closed && s.availableToForward > 0).length;
                const shortClosedCount = allStages.filter((s: any) => s.closed).length;
                return (
                  <div key={dk} className="rounded-lg border border-border">
                    <button type="button" onClick={() => toggleLine(dk)}
                      className="flex w-full flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2 text-left hover:bg-muted/60">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                        {isDesignOpen ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
                        <span className="text-foreground">
                          {d.itemName ?? '—'}
                          {d.itemNumber && (
                            <span className="ml-2 rounded bg-secondary/60 px-2 py-0.5 text-xs font-semibold tracking-tight text-foreground">
                              #{d.itemNumber}
                            </span>
                          )}
                          {/* Vendor design ref(s) — printed alongside so
                              the operator sees "this is what the vendor
                              has on their box" right next to our number. */}
                          {distinctVendorRefs.length > 0 && (
                            <span className="ml-1.5 inline-flex flex-wrap items-center gap-1">
                              {distinctVendorRefs.map((r) => (
                                <span key={r} className="rounded bg-info/10 px-1.5 py-0.5 text-xs font-semibold tracking-tight text-info ring-1 ring-info/30"
                                  title="Vendor Design Ref — vendor's own item code">
                                  vRef {r}
                                </span>
                              ))}
                            </span>
                          )}
                        </span>
                        {/* Show every colour variant as a chip — colours ARE the tracking
                            granularity (not the lineKey-based "tracks" concept). */}
                        {distinctColours.length > 0 && (
                          <span className="inline-flex flex-wrap items-center gap-1.5">
                            {distinctColours.map((c) => (
                              <span key={c} className="inline-flex items-center gap-1 rounded-full bg-card px-2 py-0.5 text-xs font-medium text-foreground/80 ring-1 ring-border">
                                <span className="size-2 shrink-0 rounded-full ring-1 ring-border" style={{ backgroundColor: colourSwatch(c) }} />
                                {c}
                              </span>
                            ))}
                          </span>
                        )}
                        {d.colorModel && distinctColours.length === 0 && <Badge variant="secondary" className="ml-1"><Palette className="mr-1 size-3" />{d.colorModel}</Badge>}
                        {distinctVariants.length > 0 && (
                          <span className="inline-flex flex-wrap items-center gap-1 text-xs font-normal text-muted-foreground" title="Internal variant codes (not shown to customers)">
                            <span className="uppercase tracking-wide">our codes:</span>
                            {distinctVariants.map((v) => (
                              <span key={v} className="rounded bg-info/10 px-1.5 py-0.5 font-medium tracking-tight text-info ring-1 ring-info/30">
                                {v}
                              </span>
                            ))}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {shortClosedCount > 0 && (
                          <Badge variant="destructive" className="font-semibold">
                            ⛔ {shortClosedCount} short-closed
                          </Badge>
                        )}
                        {actionsWaiting > 0 && (
                          <Badge variant="warning" className="font-semibold">
                            ⚡ {actionsWaiting} action{actionsWaiting === 1 ? '' : 's'} waiting
                          </Badge>
                        )}
                        {d.colorModelsAvailable > 0 && (
                          <Badge variant="info">{d.colorModelsAvailable} colour model(s)</Badge>
                        )}
                        <ProdStatus label={designStatus} />
                      </div>
                    </button>
                    {isDesignOpen && (() => {
                      // PROCESS-PIPELINE VIEW: one row per process for this design.
                      // Aggregates all sibling/multi-colour stages of the same
                      // process into a single summary row showing total qty,
                      // colour breakdown, and aggregate received/forwarded/pending
                      // counts. Click a row to expand and see individual stages
                      // with full per-stage actions (Send, Close, Edit).
                      //
                      // Why this over the parent-child tree? With multi-colour
                      // designs you end up with 17+ stages per design — the tree
                      // becomes a wall. Production users think in terms of "where
                      // are my pieces in the pipeline", not "which Plating colour
                      // is the parent of which Antique stage". One row per
                      // process answers the real question.
                      const stagesByProc = new Map<string, any[]>();
                      for (const st of allStages) {
                        const arr = stagesByProc.get(st.processCode) ?? [];
                        arr.push(st);
                        stagesByProc.set(st.processCode, arr);
                      }
                      // Display order matches the seed sortOrder (Casting → ... → Packing).
                      const PROC_ORDER = ['CAM', 'CASTING', 'DIE_NUMBER', 'FILING', 'POLISH', 'KACHA_FITTING', 'MAGNET', 'SAND_BLAST', 'PLATING', 'MEENA', 'FITTING_MALA', 'STICKING', 'PACKING'];
                      const orderedProcs = PROC_ORDER
                        .map((code) => ({ code, stages: stagesByProc.get(code) }))
                        .filter((g): g is { code: string; stages: any[] } => !!g.stages && g.stages.length > 0);

                      const aggregate = (stages: any[]) => {
                        const totalQty = stages.reduce((a, s) => a + s.quantity, 0);
                        const totalRecd = stages.reduce((a, s) => a + s.receivedQty, 0);
                        const totalFwd = stages.reduce((a, s) => a + (s.forwardedQty ?? 0), 0);
                        const totalPending = stages.reduce((a, s) => a + (s.closed ? 0 : s.pendingQty), 0);
                        const totalShort = stages.reduce((a, s) => a + (s.closed ? (s.shortQty ?? 0) : 0), 0);
                        const actionable = stages.filter((s) => !s.closed && s.availableToForward > 0).length;
                        const actionableQty = stages.reduce((a, s) => a + (!s.closed ? s.availableToForward : 0), 0);
                        const allClosed = stages.every((s) => s.closed);
                        const allDone = stages.every((s) => s.closed || s.receivedQty >= s.quantity);
                        return { totalQty, totalRecd, totalFwd, totalPending, totalShort, actionable, actionableQty, allClosed, allDone };
                      };

                      const colourBreakdown = (stages: any[]): Array<[string, number]> => {
                        const m = new Map<string, number>();
                        for (const s of stages) {
                          if (!s.color) continue;
                          m.set(s.color, (m.get(s.color) ?? 0) + s.quantity);
                        }
                        return Array.from(m.entries());
                      };

                      // PER-STAGE lineage codes — walk UP the parentItemId
                      // chain from each stage to collect only the processes
                      // already done in THIS branch. Earlier we used a single
                      // design-wide set, which broke colour splits: if Silver
                      // Plating → Meena was forwarded, the dropdown for the
                      // sibling Bhari Gold Plating dropped Meena too. Each
                      // branch should be filtered independently.
                      const stageById = new Map<number, any>(allStages.map((s: any) => [s.id, s]));
                      const lineCodesByStage = new Map<number, string[]>();
                      for (const s of allStages) {
                        const codes = new Set<string>();
                        let cur: any = s;
                        while (cur) {
                          if (cur.processCode) codes.add(cur.processCode);
                          cur = cur.parentItemId ? stageById.get(cur.parentItemId) : null;
                        }
                        lineCodesByStage.set(s.id, Array.from(codes));
                      }

                      // PER-DESIGN slices of the batch-wide materials/consumption
                      // structures. Filtered so the panels here show only what's
                      // relevant to THIS design — no batch-wide totals to scan.
                      const designMaterialByVendor = (batch.materialByVendor ?? [])
                        .map((vg: any) => ({
                          ...vg,
                          items: (vg.items ?? []).filter((it: any) => it.itemNumber === d.itemNumber),
                        }))
                        .filter((vg: any) => vg.items.length > 0);
                      const designMaterialRequirement = (batch.materialRequirement ?? [])
                        .map((m: any) => {
                          const myShare = (m.byDesign ?? []).find((bd: any) => bd.itemNumber === d.itemNumber);
                          if (!myShare) return null;
                          return { ...m, required: myShare.qty };
                        })
                        .filter(Boolean) as any[];
                      const matKey = `${dk}::materials`;
                      const conKey = `${dk}::consumption`;
                      const isMatOpen = openLines[matKey] ?? false;
                      const isConOpen = openLines[conKey] ?? false;
                      return (
                        <>
                          {/* Per-design toolbar — Materials by Vendor + Inventory
                              Consumption buttons. Panels render BELOW the toolbar,
                              ABOVE the Casting process row. Empty buttons (no data
                              for this design — e.g. no sticking BOM) stay hidden. */}
                          {(designMaterialByVendor.length > 0 || designMaterialRequirement.length > 0) && (
                            <div className="border-b border-border bg-muted/20 px-3 py-2">
                              <div className="flex flex-wrap items-center gap-2">
                                {designMaterialByVendor.length > 0 && (
                                  <Button
                                    type="button" variant={isMatOpen ? 'default' : 'outline'} size="sm"
                                    onClick={() => toggleLine(matKey)} className="h-8 text-xs">
                                    💎 Materials to Stick — by Vendor
                                    {isMatOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                                  </Button>
                                )}
                                {designMaterialRequirement.length > 0 && (
                                  <Button
                                    type="button" variant={isConOpen ? 'default' : 'outline'} size="sm"
                                    onClick={() => toggleLine(conKey)} className="h-8 text-xs">
                                    📦 Inventory Consumption
                                    {isConOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                                  </Button>
                                )}
                              </div>
                              {isMatOpen && designMaterialByVendor.length > 0 && (
                                <div className="mt-2 space-y-2">
                                  {designMaterialByVendor.map((vg: any) => (
                                    <div key={vg.vendorId} className="rounded-lg border border-border bg-card">
                                      <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-sm font-semibold">
                                        {vg.vendorCode} · {vg.vendorName}
                                      </div>
                                      <div className="divide-y divide-border">
                                        {vg.items.map((it: any) => (
                                          <div key={it.batchItemId} className="px-3 py-2">
                                            <div className="mb-1 flex flex-wrap items-center gap-2 text-sm">
                                              {it.vendorDesignReference && <span className="font-medium">{it.vendorDesignReference}</span>}
                                              {it.color && <Badge variant="info">{it.color}</Badge>}
                                              <span className="text-muted-foreground">· {it.quantity} pcs</span>
                                            </div>
                                            <div className="flex flex-wrap gap-1.5">
                                              {(it.materials ?? []).map((m: any) => (
                                                <Badge key={m.variantId} variant="secondary" className="font-normal">
                                                  {m.variantName}: <span className="ml-1 font-semibold">{m.required} pcs</span>
                                                </Badge>
                                              ))}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {isConOpen && designMaterialRequirement.length > 0 && (
                                <div className="mt-2 table-scroll rounded-lg border border-border bg-card">
                                  <table className="w-full min-w-[640px] text-sm">
                                    <thead className="bg-muted/40 text-left text-muted-foreground">
                                      <tr>
                                        <th className="px-3 py-1.5">Material</th>
                                        <th className="px-3 py-1.5 text-right">Required (this design)</th>
                                        <th className="px-3 py-1.5 text-right">In Stock (global)</th>
                                        <th className="px-3 py-1.5">Status</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {designMaterialRequirement.map((m: any) => (
                                        <tr key={m.variantId} className="border-t border-border align-middle">
                                          <td className="px-3 py-1.5">
                                            <span className="font-medium">{m.variantName}</span>
                                            {m.variantCode && <span className="text-muted-foreground"> · {m.variantCode}</span>}
                                          </td>
                                          <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{m.required} pcs</td>
                                          <td className="px-3 py-1.5 text-right tabular-nums">{Math.trunc(Number(m.stockQty))} pcs</td>
                                          <td className="px-3 py-1.5">
                                            {m.short
                                              ? <Badge variant="destructive">Short stock (batch-wide)</Badge>
                                              : <Badge variant="success">OK</Badge>}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          )}
                          <div className="divide-y divide-border">
                          {orderedProcs.map((g) => {
                            const procKey = `${dk}::${g.code}`;
                            const isProcOpen = openLines[procKey] ?? false;
                            const a = aggregate(g.stages);
                            const colours = colourBreakdown(g.stages);
                            const stageCount = g.stages.length;
                            const procName = g.stages[0].processName;
                            const tone = a.allClosed ? 'bg-destructive/10/30'
                              : a.actionable > 0 ? 'bg-success/15'
                              : a.totalPending > 0 ? 'bg-warning/10/30'
                              : 'bg-card';
                            return (
                              <div key={procKey} className={tone}>
                                <button type="button" onClick={() => toggleLine(procKey)}
                                  className="flex w-full flex-wrap items-center gap-2 px-3 py-2.5 text-left text-sm font-medium text-foreground hover:bg-muted/50">
                                  {isProcOpen ? <ChevronDown className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
                                  <Badge variant="default" className="whitespace-nowrap">{procName}</Badge>
                                  {/* Process group work date — latest receiptDate across all
                                      its vendor rows. Reads as "(✓ DD MMM YYYY)" when work is
                                      done; "(→ DD MMM YYYY)" while still in progress. */}
                                  {(() => {
                                    const groupWorkDates = g.stages
                                      .map((s: any) => s.workDate ?? s.forwardedAt)
                                      .filter(Boolean)
                                      .map((d: any) => new Date(d).getTime());
                                    if (groupWorkDates.length === 0) return null;
                                    const latest = new Date(Math.max(...groupWorkDates));
                                    const anyReceived = g.stages.some((s: any) => (s.receivedQty ?? 0) > 0);
                                    return (
                                      <span
                                        className="text-xs text-muted-foreground"
                                        title={anyReceived ? `Latest receipt date across this process` : `Forwarded on`}
                                      >
                                        ({anyReceived ? '✓' : '→'} {formatDate(latest)})
                                      </span>
                                    );
                                  })()}
                                  <span className="text-sm text-muted-foreground">{stageCount === 1 ? '1 issue' : `${stageCount} issues`}</span>
                                  {colours.length > 0 && (
                                    <span className="inline-flex flex-wrap items-center gap-1">
                                      {colours.map(([c, q]) => (
                                        <span key={c} className="inline-flex items-center gap-1.5 rounded-full bg-background px-2 py-0.5 text-xs font-semibold text-foreground ring-1 ring-border">
                                          <span className="size-2.5 shrink-0 rounded-full ring-1 ring-border" style={{ backgroundColor: colourSwatch(c) }} />
                                          {c}
                                          <span className="tabular-nums text-muted-foreground">{q}</span>
                                        </span>
                                      ))}
                                    </span>
                                  )}
                                  <div className="ml-auto flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-sm tabular-nums">
                                    <span className="text-muted-foreground">issued <strong className="font-semibold text-foreground">{a.totalQty}</strong></span>
                                    <span className="text-muted-foreground/40">·</span>
                                    <span className="text-muted-foreground">recd <span className="font-semibold text-success">{a.totalRecd}</span></span>
                                    <span className="text-muted-foreground/40">·</span>
                                    <span className="text-muted-foreground">fwd <span className="font-semibold text-info">{a.totalFwd}</span></span>
                                    {a.totalPending > 0 && (
                                      <>
                                        <span className="text-muted-foreground/40">·</span>
                                        <span className="font-semibold text-warning">{a.totalPending} pending</span>
                                      </>
                                    )}
                                    {a.totalShort > 0 && (
                                      <>
                                        <span className="text-muted-foreground/40">·</span>
                                        <span className="font-semibold text-destructive">⛔ {a.totalShort} short</span>
                                      </>
                                    )}
                                    {a.actionable > 0 && (
                                      <Badge variant="warning" className="ml-1">⚡ {a.actionableQty} ready to send</Badge>
                                    )}
                                    {a.allClosed && <Badge variant="destructive" className="ml-1">closed</Badge>}
                                    {!a.allClosed && a.allDone && a.actionable === 0 && a.totalPending === 0 && (
                                      <span className="ml-1 font-semibold text-success">✓ done</span>
                                    )}
                                  </div>
                                </button>

                                {isProcOpen && (
                                  <div className="table-scroll border-t border-border/60 bg-background/60 px-3 py-2">
                                    {/* Mobile cards — one block per stage, with all the same
                                        actions stacked vertically. Hidden ≥ lg, where the
                                        full table below takes over. */}
                                    <div className="space-y-2 lg:hidden">
                                      {g.stages.map((st: any) => (
                                        <div key={`m-${st.id}`} className="rounded-md border border-border bg-card p-3 text-sm shadow-sm">
                                          <div className="flex flex-wrap items-start justify-between gap-2">
                                            <div className="min-w-0">
                                              <div className="truncate font-semibold text-foreground">{st.vendorCode} · {st.vendorName}</div>
                                              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                                                {st.color && (
                                                  <span className="inline-flex items-center gap-1">
                                                    <span className="size-2 rounded-full ring-1 ring-border" style={{ backgroundColor: colourSwatch(st.color) }} />
                                                    {st.color}
                                                  </span>
                                                )}
                                                {st.vendorDesignReference && (
                                                  <span className="rounded bg-info/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-info ring-1 ring-info/30">
                                                    {st.vendorDesignReference}
                                                  </span>
                                                )}
                                              </div>
                                            </div>
                                            <div className="text-right tabular-nums">
                                              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Qty · Recd</div>
                                              <div className="font-semibold text-foreground">{st.quantity} <span className="text-muted-foreground/60">·</span> <span className="text-success">{st.receivedQty}</span></div>
                                            </div>
                                          </div>
                                          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                                            {st.closed ? <span className="font-semibold text-destructive">⛔ short {st.shortQty ?? 0}</span>
                                              : st.pendingQty > 0 ? <span className="font-medium text-warning">{st.pendingQty} pending</span>
                                              : st.forwardedQty > 0 ? <span className="font-medium text-info">{st.forwardedQty} fwd</span>
                                              : <span className="text-muted-foreground">—</span>}
                                            {(st.openRepairQty ?? 0) > 0 && (
                                              <span className="inline-flex items-center gap-0.5 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning ring-1 ring-amber-300">
                                                🔧 {st.openRepairQty} at repair
                                              </span>
                                            )}
                                          </div>
                                          <div className="mt-2 flex flex-wrap items-center gap-1">
                                            {st.availableToForward > 0 && (
                                              <Button variant="default" size="sm" className="h-8 px-2.5 text-xs"
                                                onClick={() => setForwardStage({ ...st, lineCodes: lineCodesByStage.get(st.id) ?? [] })}>
                                                Send {st.availableToForward}
                                              </Button>
                                            )}
                                            {st.processCode === 'PACKING' && (st.receivedQty ?? 0) > 0 && (
                                              <Link href={`/casting/categorize/${batch.id}`} prefetch={false}>
                                                <Button variant="default" size="sm" className="h-8 px-2.5 text-xs">
                                                  <Send className="size-3.5" /> Categorize
                                                </Button>
                                              </Link>
                                            )}
                                            {(() => {
                                              const excess = Math.max(0, (st.receivedQty ?? 0) - (st.quantity ?? 0) - (st.forwardedQty ?? 0));
                                              return excess > 0 ? (
                                                <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs text-success hover:bg-success/10"
                                                  onClick={() => setRouteExcessStage({ ...st, batchId: batch.id })}>
                                                  ⚡ Route {excess}
                                                </Button>
                                              ) : null;
                                            })()}
                                            {!st.closed && st.pendingQty > 0 && (
                                              <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs text-warning hover:bg-warning/10"
                                                onClick={() => onClickClose(st)} disabled={closeItem.isPending}>
                                                <XCircle className="size-3.5" /> Close
                                              </Button>
                                            )}
                                            {!st.closed && st.pendingQty > 0 && (
                                              <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs"
                                                onClick={() => setReissueStage({ ...st, batchId: batch.id })}>
                                                <Plus className="size-3.5" /> Issue more
                                              </Button>
                                            )}
                                            {st.closed && (
                                              <button className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                                onClick={() => reopenItem.mutate(st.id)} disabled={reopenItem.isPending}>
                                                <RotateCcw className="size-3" /> Reopen
                                              </button>
                                            )}
                                            {st.parentItemId != null && !st.closed && (st.receivedQty ?? 0) === 0 && (st.forwardedQty ?? 0) === 0 && (
                                              <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs text-destructive hover:bg-destructive/10"
                                                disabled={undoForward.isPending || editLocked}
                                                onClick={() => {
                                                  const msg = `Undo this forward?\n\nStage: ${st.processName}${st.color ? ' · ' + st.color : ''} · ${st.quantity} pcs to ${st.vendorCode}\n\n• Pieces go back to the parent stage's idle pool.\n• Any auto-issued sticking materials are reversed.\n• No history is lost on the parent or upstream.`;
                                                  if (window.confirm(msg)) undoForward.mutate(st.id);
                                                }}>
                                                <Trash2 className="size-3.5" /> Undo
                                              </Button>
                                            )}
                                            {(() => {
                                              const stageReceipts = (batch.receipts ?? [])
                                                .filter((r: any) => (r.items ?? []).some((ri: any) => ri.batchItemId === st.id));
                                              const total = (st.issueSlipId ? 1 : 0) + stageReceipts.length;
                                              if (total === 0) return null;
                                              return (
                                                <Button type="button" variant="outline" size="sm" className="h-8 px-2 text-xs"
                                                  onClick={() => setSlipPickerStage({ ...st, stageReceipts })}>
                                                  <FileDown className="size-3.5" /> Slips ({total})
                                                </Button>
                                              );
                                            })()}
                                            <Button variant="outline" size="icon" className="size-8"
                                              disabled={editLocked}
                                              title={editLockReason ?? 'Edit this step'}
                                              onClick={() => setEditStage(st)}>
                                              <Pencil className="size-3.5" />
                                            </Button>
                                          </div>
                                        </div>
                                      ))}
                                    </div>

                                    {/* Wrap the desktop table in table-scroll
                                        so mid-density screens (13" laptops)
                                        still scroll cleanly if the min-width
                                        exceeds the panel column. */}
                                    <div className="table-scroll hidden lg:block">
                                    <table className="w-full min-w-[820px] text-sm">
                                      <thead className="text-muted-foreground">
                                        <tr className="text-left">
                                          <th className="px-3 py-2 font-semibold">Vendor</th>
                                          <th className="px-3 py-2 font-semibold">Colour</th>
                                          <th className="px-3 py-2 font-semibold" title="Vendor Design Ref — vendor's own item code">Vendor Code</th>
                                          <th className="px-3 py-2 font-semibold tabular-nums">Qty</th>
                                          <th className="px-3 py-2 font-semibold tabular-nums">Recd</th>
                                          <th className="px-3 py-2 font-semibold">Status</th>
                                          <th className="px-3 py-2 text-right font-semibold">Actions</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {g.stages.map((st: any) => (
                                          <React.Fragment key={st.id}>
                                          <tr className="border-t border-border/60 align-middle">
                                            <td className="px-3 py-2 text-foreground" title={`${st.vendorCode} · ${st.vendorName}`}>{st.vendorCode} · {st.vendorName}</td>
                                            <td className="px-3 py-2 text-foreground">
                                              {st.color ? (
                                                <span className="inline-flex items-center gap-1.5">
                                                  <span className="size-2.5 shrink-0 rounded-full ring-1 ring-border" style={{ backgroundColor: colourSwatch(st.color) }} />
                                                  {st.color}
                                                </span>
                                              ) : <span className="text-muted-foreground">—</span>}
                                            </td>
                                            <td className="px-3 py-2">
                                              {st.vendorDesignReference ? (
                                                <span className="inline-flex items-center rounded bg-info/10 px-2 py-0.5 font-mono text-xs font-semibold text-info ring-1 ring-info/30"
                                                  title="Vendor Design Ref — vendor's own item code">
                                                  {st.vendorDesignReference}
                                                </span>
                                              ) : <span className="text-muted-foreground">—</span>}
                                            </td>
                                            <td className="px-3 py-2 font-semibold tabular-nums text-foreground">{st.quantity}</td>
                                            <td className="px-3 py-2 tabular-nums font-medium text-success">{st.receivedQty}</td>
                                            <td className="px-3 py-2">
                                              <div className="flex flex-wrap items-center gap-1">
                                                {st.closed ? <span className="font-semibold text-destructive">⛔ short {st.shortQty ?? 0}</span>
                                                  : st.pendingQty > 0 ? <span className="font-medium text-warning">{st.pendingQty} pending</span>
                                                  : st.forwardedQty > 0 ? <span className="font-medium text-info">{st.forwardedQty} fwd</span>
                                                  : <span className="text-muted-foreground">—</span>}
                                                {(st.openRepairQty ?? 0) > 0 && (
                                                  <span
                                                    className="inline-flex items-center gap-0.5 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning ring-1 ring-amber-300"
                                                    title={`${st.openRepairQty} pc${st.openRepairQty > 1 ? 's' : ''} with ${st.vendorName} for repair`}
                                                  >
                                                    🔧 {st.openRepairQty} at repair
                                                  </span>
                                                )}
                                              </div>
                                            </td>
                                            <td className="px-3 py-2">
                                              <div className="flex items-center justify-end gap-1">
                                                {st.availableToForward > 0 && (
                                                  <Button variant="default" size="sm" className="h-8 px-2.5 text-xs"
                                                    onClick={() => setForwardStage({ ...st, lineCodes: lineCodesByStage.get(st.id) ?? [] })}>
                                                    Send {st.availableToForward}
                                                  </Button>
                                                )}
                                                {/* Packing is final — instead of a forward, finished pcs go
                                                    through the Categorize page. Filled "default" variant —
                                                    same visual weight as the Send N button on intermediate
                                                    stages so the next-step affordance reads at a glance. */}
                                                {st.processCode === 'PACKING' && (st.receivedQty ?? 0) > 0 && (
                                                  <Link href={`/casting/categorize/${batch.id}`} prefetch={false}>
                                                    <Button variant="default" size="sm" className="h-8 px-2.5 text-xs">
                                                      <Send className="size-3.5" /> Categorize
                                                    </Button>
                                                  </Link>
                                                )}
                                                {/* Excess available = received > ordered (after subtracting
                                                    forwarded). These pcs can be routed to another batch
                                                    without re-issuing materials — pure margin win. */}
                                                {(() => {
                                                  const excess = Math.max(0, (st.receivedQty ?? 0) - (st.quantity ?? 0) - (st.forwardedQty ?? 0));
                                                  return excess > 0 ? (
                                                    <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs text-success hover:bg-success/10"
                                                      onClick={() => setRouteExcessStage({ ...st, batchId: batch.id })}>
                                                      ⚡ Route {excess} excess
                                                    </Button>
                                                  ) : null;
                                                })()}
                                                {!st.closed && st.pendingQty > 0 && (
                                                  <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs text-warning hover:bg-warning/10"
                                                    onClick={() => onClickClose(st)} disabled={closeItem.isPending}>
                                                    <XCircle className="size-3.5" /> Close
                                                  </Button>
                                                )}
                                                {/* Re-issue materials — at-vendor stage with pending work
                                                    that needs more materials sent. Creates a new MaterialIssue
                                                    voucher linked to the same stage. */}
                                                {!st.closed && st.pendingQty > 0 && (
                                                  <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs"
                                                    title="Issue more materials to this vendor for this stage"
                                                    onClick={() => setReissueStage({ ...st, batchId: batch.id })}>
                                                    <Plus className="size-3.5" /> Issue more
                                                  </Button>
                                                )}
                                                {st.closed && (
                                                  <button className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                                    onClick={() => reopenItem.mutate(st.id)} disabled={reopenItem.isPending}>
                                                    <RotateCcw className="size-3" /> Reopen
                                                  </button>
                                                )}
                                                {/* UNDO forward — appears on any child stage that hasn't
                                                    been received and hasn't fanned out further. Reverses
                                                    auto-issued materials too. Hidden for root casting
                                                    stages (parentItemId == null) — those need batch-level
                                                    delete, not this. */}
                                                {st.parentItemId != null && !st.closed && (st.receivedQty ?? 0) === 0 && (st.forwardedQty ?? 0) === 0 && (
                                                  <Button
                                                    variant="outline" size="sm"
                                                    className="h-8 px-2.5 text-xs text-destructive hover:bg-destructive/10"
                                                    disabled={undoForward.isPending || editLocked}
                                                    onClick={() => {
                                                      const msg = `Undo this forward?\n\n` +
                                                        `Stage: ${st.processName}${st.color ? ' · ' + st.color : ''} · ${st.quantity} pcs to ${st.vendorCode}\n\n` +
                                                        `• Pieces go back to the parent stage's idle pool.\n` +
                                                        `• Any auto-issued sticking materials are reversed.\n` +
                                                        `• No history is lost on the parent or upstream.`;
                                                      if (window.confirm(msg)) undoForward.mutate(st.id);
                                                    }}
                                                    title={editLockReason ?? "Undo this forward — only available when the stage has no receipts and no further forwards. Restores pieces to the parent stage and reverses any auto-issued materials."}>
                                                    <Trash2 className="size-3.5" /> Undo
                                                  </Button>
                                                )}
                                                {/* Slip picker — ONE button per stage that opens
                                                    a popup listing the issue slip + every receipt
                                                    that touched this stage. Avoids cramming 5+
                                                    chips into the Actions column when partial
                                                    receivals create multiple receipts. */}
                                                {(() => {
                                                  const stageReceipts = (batch.receipts ?? [])
                                                    .filter((r: any) => (r.items ?? []).some((ri: any) => ri.batchItemId === st.id));
                                                  const total = (st.issueSlipId ? 1 : 0) + stageReceipts.length;
                                                  if (total === 0) return null;
                                                  return (
                                                    <Button
                                                      type="button" variant="outline" size="sm"
                                                      className="h-8 px-2 text-xs"
                                                      title="Open the issue slip / receipts for this stage"
                                                      onClick={() => setSlipPickerStage({ ...st, stageReceipts })}
                                                    >
                                                      <FileDown className="size-3.5" /> Slips ({total})
                                                    </Button>
                                                  );
                                                })()}
                                                <Button variant="outline" size="icon" className="size-8"
                                                  disabled={editLocked}
                                                  title={editLockReason ?? "Edit this step"}
                                                  onClick={() => setEditStage(st)}>
                                                  <Pencil className="size-3.5" />
                                                </Button>
                                              </div>
                                            </td>
                                          </tr>
                                          {/* Sticking-only material status panel: shows how many pieces
                                              can actually be produced given the materials issued so far.
                                              Surfaces the per-material gap so the user knows what to top
                                              up via the deferred-issuance flow on the inventory page. */}
                                          {st.processCode === 'STICKING' && st.materialStatus && st.materialStatus.lines.length > 0 && (
                                            <tr>
                                              <td colSpan={7} className="px-2 pb-2">
                                                <div className={`rounded border px-3 py-2 text-xs ${st.materialStatus.materialsShort ? 'border-warning/40 bg-warning/15' : 'border-success/30 bg-success/15'}`}>
                                                  <div className="mb-1 flex flex-wrap items-center gap-2 font-semibold">
                                                    <span>📦 Materials</span>
                                                    {st.materialStatus.materialsShort ? (
                                                      <>
                                                        <span className="text-warning">cover {st.materialStatus.maxProducible} / {st.materialStatus.stageQty} pcs</span>
                                                        <span className="rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning ring-1 ring-warning/30">
                                                          {st.materialStatus.pendingPiecesAwaitingMaterial} pcs await material top-up
                                                        </span>
                                                      </>
                                                    ) : (
                                                      <span className="text-success">sufficient for full {st.materialStatus.stageQty} pcs ✓</span>
                                                    )}
                                                  </div>
                                                  <div className="table-scroll">
                                                    <table className="w-full text-xs">
                                                      <thead className="text-muted-foreground">
                                                        <tr className="text-left">
                                                          <th className="px-1 py-0.5 font-medium">Material</th>
                                                          <th className="px-1 py-0.5 text-right font-medium">Per pc</th>
                                                          <th className="px-1 py-0.5 text-right font-medium">Required</th>
                                                          <th className="px-1 py-0.5 text-right font-medium">Issued</th>
                                                          <th className="px-1 py-0.5 text-right font-medium">Still owed</th>
                                                          <th className="px-1 py-0.5 text-right font-medium">Covers pcs</th>
                                                        </tr>
                                                      </thead>
                                                      <tbody>
                                                        {st.materialStatus.lines.map((ml: any) => (
                                                          <tr key={ml.variantId} className="border-t border-border/40">
                                                            <td className="px-1 py-0.5">{ml.materialName} <span className="text-muted-foreground">· {ml.variantName}</span></td>
                                                            <td className="px-1 py-0.5 text-right tabular-nums">{ml.perPiece}</td>
                                                            <td className="px-1 py-0.5 text-right tabular-nums">{ml.required}</td>
                                                            <td className="px-1 py-0.5 text-right tabular-nums text-success">{ml.issued}</td>
                                                            <td className={`px-1 py-0.5 text-right tabular-nums ${ml.stillToIssue > 0 ? 'font-semibold text-warning' : 'text-muted-foreground'}`}>
                                                              {ml.stillToIssue > 0 ? ml.stillToIssue : '—'}
                                                            </td>
                                                            <td className={`px-1 py-0.5 text-right tabular-nums ${ml.producibleFromThis < st.materialStatus.stageQty ? 'font-semibold text-warning' : 'text-success'}`}>
                                                              {ml.producibleFromThis}
                                                            </td>
                                                          </tr>
                                                        ))}
                                                      </tbody>
                                                    </table>
                                                  </div>
                                                  {st.materialStatus.materialsShort && (
                                                    <div className="mt-1.5 text-xs text-warning">
                                                      → To unblock the remaining {st.materialStatus.pendingPiecesAwaitingMaterial} pcs, top up materials on the
                                                      <a className="ml-1 font-semibold underline" href="/inventory" target="_blank" rel="noreferrer">Inventory page</a>
                                                      {' '}(deferred-issuance dialog).
                                                    </div>
                                                  )}
                                                </div>
                                              </td>
                                            </tr>
                                          )}
                                          </React.Fragment>
                                        ))}
                                      </tbody>
                                    </table>
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                );
              });
            })()}
          </div>

        </div>
      )}

      <ForwardDialog stage={forwardStage} open={forwardStage != null} onClose={() => setForwardStage(null)} onDone={refresh} />
      <ReissueMaterialsDialog
        stage={reissueStage}
        open={reissueStage != null}
        onClose={() => setReissueStage(null)}
        onIssued={refresh}
      />
      <EditStageDialog stage={editStage} open={editStage != null} onClose={() => setEditStage(null)} onDone={refresh} />
      <AddDesignDialog
        open={addDesignOpen}
        batchId={batch?.id ?? null}
        onClose={() => setAddDesignOpen(false)}
        onDone={refresh}
        // Root Casting stages already in this batch — the dialog uses
        // these to flag duplicates and offer "increase qty on existing".
        // Filtered to root casting (parentItemId == null + Casting code)
        // and only stages with a real itemId so legacy ad-hoc rows don't
        // accidentally match.
        existingDesigns={(batch?.items ?? [])
          .filter((it: any) => it.parentItemId == null && it.processCode === 'CASTING' && it.itemId)
          .map((it: any) => ({
            stageId: it.id,
            itemId: it.itemId,
            itemNumber: it.itemNumber ?? null,
            itemName: it.itemName ?? null,
            quantity: it.quantity,
          }))}
      />
      <RouteExcessDialog stage={routeExcessStage} open={routeExcessStage != null} onClose={() => setRouteExcessStage(null)} onDone={refresh} />
      <SlipPickerDialog stage={slipPickerStage} open={slipPickerStage != null} onClose={() => setSlipPickerStage(null)} onDeleteReceipt={(id) => delReceipt.mutate(id)} deleting={delReceipt.isPending} onEditReceipt={(id) => { setSlipPickerStage(null); setEditReceiptId(id); }} />
      {/* In-batch repair receive — opens scoped to one RepairOrder, sits
          INSIDE the batch dialog so the user never leaves the batch. */}
      <ReceiveForm
        open={receiveRepair != null}
        initialBatchId={batch?.id ?? null}
        initialVendorId={receiveRepair?.vendorId ?? null}
        repairOrderId={receiveRepair?.id ?? null}
        onClose={() => { setReceiveRepair(null); refresh(); }}
      />
      {/* Edit receipt — opens against an existing receipt id. The form
          fetches the receipt, pre-fills every row, locks batch + vendor,
          and dispatches updateReceipt on save. */}
      <ReceiveForm
        open={editReceiptId != null}
        editReceiptId={editReceiptId}
        onClose={() => { setEditReceiptId(null); refresh(); }}
      />
    </Dialog>
  );
}
