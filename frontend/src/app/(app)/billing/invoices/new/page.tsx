'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, FilePlus } from 'lucide-react';
import { toast } from 'sonner';
import { Api, getApiError } from '@/lib/api';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/shared/field';
import { Card, CardContent } from '@/components/ui/card';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Spinner } from '@/components/ui/spinner';
import { QuickAddCustomer } from '@/components/shared/quick-add-customer';
import { Dialog } from '@/components/ui/dialog';

type LineRow = {
  _k: number;
  itemId: number | '';
  // Material variant reference — mutually exclusive with itemId. When
  // set, the picker displays the material name; itemId stays ''.
  variantId: number | '';
  itemNumber: string;
  description: string;
  hsnCode: string;
  quantity: string;
  weightG: string;
  // When set, the operator typed a total weight directly (no per-piece
  // weight in hand). Wins over weightG on save; back-computed to per-pc
  // via totalWtG / quantity in the payload.
  totalWtG: string;
  // Additional charges — PER PIECE. On save we compute
  //   extraAmount = additionalPerPc × quantity
  // and send that as the flat `extraAmount` the backend expects. On edit
  // we back-derive perPc = storedExtra / quantity.
  additionalPerPc: string;
  silverRatePerG: string;
  makingRatePerG: string;
  // Detailed breakdown — collapsed by default. Purity + Wastage
  // removed per operator spec (no longer used anywhere).
  detailOpen: boolean;
  lessWeightG: string;
  boxWeightG: string;
  bagWeightG: string;
  tagWeightG: string;
  padWeightG: string;
  totalGrossWeightG: string;
  size: string;
  category: string;
  plating: string;
  laborOn: 'WEIGHT' | 'PIECE';
  laborRateWithTax: string;
  laborRateWithoutTax: string;
  laborAmount: string;
  extraAmount: string;
  extraDescription: string;
  packetNo: string;
  productionOrderRef: string;
  boxRef: string;
  barcode: string;
};

const newRow = (): LineRow => ({
  _k: Math.random(),
  itemId: '',
  variantId: '',
  itemNumber: '',
  description: '',
  hsnCode: '7113',
  totalWtG: '',
  additionalPerPc: '',
  quantity: '1',
  weightG: '',
  silverRatePerG: '',
  makingRatePerG: '',
  detailOpen: false,
  lessWeightG: '',
  boxWeightG: '',
  bagWeightG: '',
  tagWeightG: '',
  padWeightG: '',
  totalGrossWeightG: '',
  size: '',
  category: '',
  plating: '',
  laborOn: 'WEIGHT',
  laborRateWithTax: '',
  laborRateWithoutTax: '',
  laborAmount: '',
  extraAmount: '',
  extraDescription: '',
  packetNo: '',
  productionOrderRef: '',
  boxRef: '',
  barcode: '',
});

export default function NewInvoicePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Edit mode — same form, POST → PUT when ?id=<n>. Falls back to create
  // when the query param is absent or invalid so the "New Invoice" URL
  // and every existing bookmark keeps working.
  const editIdRaw = searchParams.get('id');
  const editId = editIdRaw && /^\d+$/.test(editIdRaw) ? Number(editIdRaw) : null;
  const isEdit = editId != null;
  const initialType = (searchParams.get('type') as any) || 'TAX_INVOICE';
  const [type, setType] = React.useState<'QUOTE' | 'SALES_ORDER' | 'TAX_INVOICE' | 'DELIVERY_CHALLAN' | 'CREDIT_NOTE' | 'ESTIMATE' | 'TEMP_INVOICE'>(initialType);
  const [customerId, setCustomerId] = React.useState<number | ''>('');
  // Place of Supply — GSTIN rule of thumb: it's the buyer's state. We
  // auto-fill from the picked customer's state so operators don't hand-
  // type "Gujarat (24)" every invoice. Manual edits still stick.
  const [placeOfSupply, setPlaceOfSupply] = React.useState('');
  const placeTouchedRef = React.useRef(false);
  const [invoiceDate, setInvoiceDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [silverRate, setSilverRate] = React.useState('');
  const [makingRate, setMakingRate] = React.useState('');
  const [gstPercent, setGstPercent] = React.useState('3');
  const [interState, setInterState] = React.useState(false);
  const [notes, setNotes] = React.useState('');
  // Editable total weight for delivery challans — overrides the sum of
  // per-line weights on the printed PDF. Left blank = use calculated sum.
  const [totalWeightG, setTotalWeightG] = React.useState('');
  // Free-text purpose for delivery challans (e.g. "Plating", "Casting").
  const [purpose, setPurpose] = React.useState('');
  // Editable invoice / estimate number. Blank = auto-generate on save; any
  // value overrides the auto sequence.
  const [invoiceNumber, setInvoiceNumber] = React.useState('');
  // Status: DRAFT (customer optional) | READY (queued for issue) | ISSUED (default).
  const [status, setStatus] = React.useState<'DRAFT' | 'READY' | 'ISSUED'>('ISSUED');
  const [lines, setLines] = React.useState<LineRow[]>([newRow()]);
  // Optional labor discount + additional charges. Both sit at the header
  // level; charges sum into chargesTotal which adds to subtotal pre-GST.
  const [laborDiscountPercent, setLaborDiscountPercent] = React.useState('');
  const [charges, setCharges] = React.useState<Array<{ _k: number; chargeTypeId: number | ''; label: string; amount: string }>>([]);
  // Estimate coverages — only meaningful for TAX_INVOICE with a "Mixed
  // Silver Jewellery" line. Map from estimateId → grams string. Populated
  // via the coverage-picker dialog reachable from the header field.
  // Now carries both the grams to cover and an "includeOtherCharges" toggle
  // that pulls that estimate's Σ(making + extra) into an "Other Charges"
  // synthesized line on the ABN.
  type CovEntry = { grams: string; include: boolean };
  const [coverages, setCoverages] = React.useState<Record<number, CovEntry>>({});
  const [coverageOpen, setCoverageOpen] = React.useState(false);

  const customersQ = useQuery<any[]>({
    queryKey: ['customers'],
    queryFn: () => Api.billing.customers(),
  });

  // Customer's OPEN/PARTIAL estimates — pulled ONLY when TAX_INVOICE +
  // customer selected, so quotes / challans / credit-notes don't fire
  // the extra request. Backend returns summary.silverStatus which we use
  // to hide already-CLOSED estimates from the picker.
  const openEstimatesQ = useQuery<any[]>({
    queryKey: ['open-estimates', customerId, type],
    queryFn: () => Api.billing.invoices({ type: 'QUOTE', customerId: Number(customerId) }),
    enabled: !!customerId && type === 'TAX_INVOICE',
  });
  // Explicit sort by invoice number so the coverage picker rows read
  // EST0001, EST0002, EST0003, … regardless of when each was created.
  const openEstimates = (openEstimatesQ.data ?? [])
    .filter((e: any) => e.status !== 'CANCELLED' && (e.summary?.silverStatus ?? 'OPEN') !== 'CLOSED')
    .slice()
    .sort((a: any, b: any) =>
      String(a.invoiceNumber ?? '').localeCompare(String(b.invoiceNumber ?? ''), undefined, { numeric: true }),
    );

  // "Mixed Silver Jewellery" line detection — trigger for the coverage
  // field. Case-insensitive substring match on either the item slot or
  // the description so typing variants ("Mixed Silver", "mixed silver
  // jewellery") still triggers.
  const hasMixedSilverLine = React.useMemo(() =>
    lines.some((l) => /mixed\s+silver/i.test(`${l.itemNumber ?? ''} ${l.description ?? ''}`)),
  [lines]);
  // Field is visible whenever the type + line qualify — but the picker
  // button is disabled until a customer is picked so the operator sees
  // the section exists and why it's not clickable yet.
  const showCoverageField = type === 'TAX_INVOICE' && hasMixedSilverLine;
  const coverageTotals = React.useMemo(() => {
    const entries = Object.entries(coverages)
      .filter(([, v]) => Number(v.grams) > 0 || v.include)
      .map(([id, v]) => ({
        estimateId: Number(id),
        grams: Number(v.grams) || 0,
        include: !!v.include,
      }));
    return {
      count: entries.length,
      grams: entries.reduce((s, e) => s + e.grams, 0),
      entries,
    };
  }, [coverages]);

  // Reset coverages when customer or type changes — stale selection would
  // point at the wrong customer's estimates. Skipped in edit mode so the
  // seed effect (below) that pre-fills coverages from the existing invoice
  // doesn't get wiped when the seeded customer id arrives one render later.
  React.useEffect(() => { if (!isEdit) setCoverages({}); }, [customerId, type, isEdit]);

  // Whenever the picked customer changes AND the operator hasn't hand-
  // edited Place of Supply, seed it from customer.state (with stateCode
  // in parens when available). Fires on initial pick and on customer-swap.
  React.useEffect(() => {
    if (placeTouchedRef.current) return;
    if (customerId === '') { setPlaceOfSupply(''); return; }
    const c = (customersQ.data ?? []).find((r: any) => r.id === customerId);
    if (!c) return;
    const label = c.stateCode ? `${c.state ?? ''} (${c.stateCode})`.trim() : (c.state ?? '');
    setPlaceOfSupply(label);
  }, [customerId, customersQ.data]);
  const piecesQ = useQuery<any[]>({
    queryKey: ['invoiceable-pieces'],
    queryFn: () => Api.billing.invoiceablePieces(),
  });
  // Material variants (raw materials — stones / pearls / chains / packaging)
  // are also billable on invoices and delivery challans. We merge them into
  // the same line-item picker with a "[Material]" tag so operators can pick
  // either a finished piece or a raw material variant.
  const variantsQ = useQuery<any[]>({
    queryKey: ['billing-material-variants'],
    queryFn: () => Api.materials.variants({ status: 'ACTIVE' }),
  });
  const chargeTypesQ = useQuery<any[]>({
    queryKey: ['charge-types'],
    queryFn: () => Api.billing.chargeTypes(),
  });

  // Existing invoice → seed state on edit mode. Only fires when the ?id=
  // query resolves to a real record. Loads once, then user edits freely.
  const editQ = useQuery<any>({
    queryKey: ['invoice-edit', editId],
    queryFn: () => Api.billing.invoice(editId as number),
    enabled: isEdit,
    // Always fetch fresh — this form seeds ONCE from the response and
    // any stale cached entry would silently rehydrate the form with an
    // out-of-date snapshot (the "2 saves ago" bug). Setting gcTime to 0
    // also drops the cache the moment we leave the page, so the next
    // Edit click can't pick up whatever the router prefetched earlier.
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });
  // After edit-mode seeds the lines, wait for the variants list to load
  // and back-fill `variantId` on any row whose description matches an
  // MV#### code (primary) or whose itemNumber matches a variantName
  // (fallback for edited descriptions). That way opening Edit shows the
  // picker with the originally-selected material instead of a blank.
  const variantBackfillDoneRef = React.useRef(false);
  React.useEffect(() => {
    if (!isEdit) return;
    if (!variantsQ.data || variantsQ.data.length === 0) return;
    if (variantBackfillDoneRef.current) return;
    if (!editQ.data || lines.length === 0) return;
    variantBackfillDoneRef.current = true;
    setLines((rs) => rs.map((r) => {
      if (r.itemId !== '' || r.variantId !== '') return r;
      // Match either way: itemNumber = MV#### code, description = name.
      // Legacy rows (before the swap) may still have code in description
      // and name in itemNumber — we try both orderings.
      const codeKey = (r.itemNumber ?? '').trim().toLowerCase();
      const nameKey = (r.description ?? '').trim().toLowerCase();
      const legacyCode = (r.description ?? '').trim().toLowerCase();
      const legacyName = (r.itemNumber ?? '').trim().toLowerCase();
      const mv = variantsQ.data!.find((v: any) => {
        const vcode = (v.variantCode ?? '').trim().toLowerCase();
        const vname = (v.variantName ?? '').trim().toLowerCase();
        return (
          (codeKey && vcode === codeKey)
          || (nameKey && vname === nameKey)
          || (legacyCode && vcode === legacyCode)
          || (legacyName && vname === legacyName)
        );
      });
      return mv ? { ...r, variantId: mv.id } : r;
    }));
  }, [isEdit, variantsQ.data, editQ.data, lines.length]);

  const seededRef = React.useRef(false);
  React.useEffect(() => {
    if (!isEdit || !editQ.data || seededRef.current) return;
    seededRef.current = true;
    const inv = editQ.data;
    setType(inv.type);
    if (inv.placeOfSupply) {
      // Mark as touched so the customer-swap effect doesn't clobber
      // whatever value was saved on the invoice.
      placeTouchedRef.current = true;
      setPlaceOfSupply(inv.placeOfSupply);
    }
    setInvoiceDate(String(inv.invoiceDate).slice(0, 10));
    setSilverRate(String(inv.silverRatePerG ?? ''));
    setMakingRate(String(inv.makingRatePerG ?? ''));
    setGstPercent(String(inv.gstPercent ?? '3'));
    setInterState(!!inv.isInterState);
    setNotes(inv.notes ?? '');
    setTotalWeightG(inv.totalWeightG != null ? String(inv.totalWeightG) : '');
    setPurpose(inv.purpose ?? '');
    setInvoiceNumber(inv.invoiceNumber ?? '');
    if (inv.status === 'DRAFT' || inv.status === 'READY' || inv.status === 'ISSUED') {
      setStatus(inv.status);
    }
    setCustomerId(inv.customerId ?? '');
    setLaborDiscountPercent(inv.laborDiscountPercent != null ? String(inv.laborDiscountPercent) : '');
    // Charges — the detail response includes them if the include chain
    // pulled them; fall back to [] otherwise.
    setCharges(((inv.charges ?? []) as any[]).map((c: any) => ({
      _k: Math.random(),
      chargeTypeId: c.chargeTypeId,
      label: c.label ?? '',
      amount: String(c.amount ?? ''),
    })));
    // Line items — hydrate every field back to string form so the
    // controlled inputs don't NaN-out.
    // Filter out the synthesized "Other Charges" line — that row is
    // controlled from the coverage picker's include-toggles, not the
    // regular line editor. Backend re-inserts it on every save based on
    // the current toggles.
    setLines(((inv.items ?? []) as any[])
      .filter((it: any) => it.itemNumber !== '__OTHER_CHARGES__')
      .map((it: any): LineRow => ({
      _k: Math.random(),
      itemId: it.itemId ?? '',
      // InvoiceItem schema doesn't persist the variant reference, so
      // edit-mode always starts with variantId blank; the material NAME
      // is still there in the itemNumber cell from the original pick.
      variantId: '',
      // Load the persisted total-weight snapshot when the invoice was
      // saved with one — keeps the operator-typed total exact on edit
      // (2000 g stays 2000, doesn't drift to 1999.98 from per-piece
      // rounding). Falls back to empty so weightG × qty is the display.
      totalWtG: (it as any).totalWeightG != null ? String((it as any).totalWeightG) : '',
      // Back-derive per-piece additional charge from stored flat total.
      // extraAmount is a whole-line figure; ÷ qty gives the per-piece
      // rate the operator originally typed.
      additionalPerPc: (it.extraAmount != null && Number(it.quantity) > 0)
        ? String(Number(it.extraAmount) / Number(it.quantity))
        : '',
      itemNumber: it.itemNumber ?? '',
      description: it.description ?? '',
      hsnCode: it.hsnCode ?? '7113',
      quantity: String(it.quantity ?? '1'),
      weightG: String(it.weightG ?? ''),
      silverRatePerG: it.silverRatePerG != null ? String(it.silverRatePerG) : '',
      makingRatePerG: it.makingRatePerG != null ? String(it.makingRatePerG) : '',
      detailOpen: false,
      lessWeightG: it.lessWeightG != null ? String(it.lessWeightG) : '',
      boxWeightG: it.boxWeightG != null ? String(it.boxWeightG) : '',
      bagWeightG: it.bagWeightG != null ? String(it.bagWeightG) : '',
      tagWeightG: it.tagWeightG != null ? String(it.tagWeightG) : '',
      padWeightG: it.padWeightG != null ? String(it.padWeightG) : '',
      totalGrossWeightG: it.totalGrossWeightG != null ? String(it.totalGrossWeightG) : '',
      size: it.size ?? '',
      category: it.category ?? '',
      plating: it.plating ?? '',
      laborOn: (it.laborOn as any) ?? 'WEIGHT',
      laborRateWithTax: it.laborRateWithTax != null ? String(it.laborRateWithTax) : '',
      laborRateWithoutTax: it.laborRateWithoutTax != null ? String(it.laborRateWithoutTax) : '',
      laborAmount: it.laborAmount != null ? String(it.laborAmount) : '',
      extraAmount: it.extraAmount != null ? String(it.extraAmount) : '',
      extraDescription: (it as any).extraDescription ?? '',
      packetNo: it.packetNo != null ? String(it.packetNo) : '',
      productionOrderRef: it.productionOrderRef ?? '',
      boxRef: it.boxRef ?? '',
      barcode: it.barcode ?? '',
    })));
    // Seed the coverage picker from any existing InvoiceEstimateCoverage
    // rows on the invoice being edited. Without this the picker starts
    // blank on Edit and saving would wipe the coverages the operator
    // had previously chosen.
    const covs = (editQ.data as any).coverages ?? [];
    if (covs.length) {
      const next: Record<number, CovEntry> = {};
      for (const c of covs) {
        next[Number(c.estimateId)] = {
          grams: String(Number(c.silverAllocatedG).toFixed(3)),
          include: !!c.includeOtherCharges,
        };
      }
      setCoverages(next);
    }
  }, [isEdit, editQ.data]);
  const qcc = useQueryClient();
  const newChargeType = useMutation({
    mutationFn: (name: string) => Api.billing.createChargeType(name),
    onSuccess: (c: any) => {
      toast.success(`${c.name} added.`);
      qcc.invalidateQueries({ queryKey: ['charge-types'] });
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  const totals = React.useMemo(() => {
    // Same math as the per-row Amount cell:
    //   wt × (silver + making) + addl-per-pc × qty
    // Using totalWtG when the operator typed it avoids the 33.333 × 60
    // = 1999.98 drift caused by re-multiplying a rounded per-piece weight.
    // Include additionalPerPc × qty so charge-only lines (delivery fee,
    // rework labor) actually feed into the subtotal → CGST/SGST calc.
    const lineSub = lines.reduce((s, l) => {
      const wt = l.totalWtG
        ? Number(l.totalWtG)
        : Number(l.weightG || 0) * Number(l.quantity || 0);
      const sv = Number(l.silverRatePerG || silverRate || 0);
      const mk = Number(l.makingRatePerG || makingRate || 0);
      const qtyN = Number(l.quantity || 0);
      const addl = Number(l.additionalPerPc || 0) * qtyN;
      return s + wt * (sv + mk) + addl;
    }, 0);
    // Making total (labor-discount base) — same weight logic; addl is
    // deliberately NOT included because the discount only applies to
    // making-charges, not custom line-level extras.
    const makingSub = lines.reduce((s, l) => {
      const wt = l.totalWtG
        ? Number(l.totalWtG)
        : Number(l.weightG || 0) * Number(l.quantity || 0);
      const mk = Number(l.makingRatePerG || makingRate || 0);
      return s + wt * mk;
    }, 0);
    const ldp = Number(laborDiscountPercent || 0);
    const laborDiscount = ldp > 0 ? makingSub * (ldp / 100) : 0;
    const chargesTotal = charges.reduce((s, c) => s + Number(c.amount || 0), 0);
    const sub = Math.max(0, lineSub - laborDiscount + chargesTotal);
    const isChallan = type === 'DELIVERY_CHALLAN';
    const gst = isChallan ? 0 : sub * (Number(gstPercent || 0) / 100);
    const cgst = !interState && !isChallan ? gst / 2 : 0;
    const sgst = !interState && !isChallan ? gst - cgst : 0;
    const igst = interState && !isChallan ? gst : 0;
    const pre = sub + cgst + sgst + igst;
    const total = Math.round(pre);
    const round = total - pre;
    return { sub, cgst, sgst, igst, round, total, laborDiscount, chargesTotal };
  }, [lines, silverRate, makingRate, gstPercent, interState, type, laborDiscountPercent, charges]);

  const create = useMutation({
    mutationFn: () => {
      if (!customerId && status !== 'DRAFT') {
        throw new Error('Pick a customer (or set status to DRAFT to save an unassigned invoice).');
      }
      const cleanLines = lines
        // A row is valid if it has qty AND at least one billable field:
        // weight, per-piece additional charge, or explicit silver/making
        // rate. This lets pure charge lines (e.g. "delivery fee", labor
        // rework) save without a weight — previously such rows were
        // silently dropped and never appeared on the printed PDF.
        .filter((l) => {
          if (!(Number(l.quantity) > 0)) return false;
          const hasWeight = Number(l.weightG) > 0 || Number(l.totalWtG) > 0;
          const hasAddl   = Number(l.additionalPerPc) > 0 || Number(l.extraAmount) > 0;
          const hasRate   = Number(l.silverRatePerG) > 0 || Number(l.makingRatePerG) > 0;
          return hasWeight || hasAddl || hasRate;
        })
        .map((l) => {
          const qty = Math.max(1, Math.trunc(Number(l.quantity)));
          // If the operator typed the total weight (challan flow), back-
          // calculate per-piece so the backend contract (weight × qty) still
          // holds. Otherwise use the per-piece value they typed.
          const perPc = l.totalWtG
            ? Number(l.totalWtG) / qty
            : Number(l.weightG);
          // Snapshot the operator-typed total so the PDF can print it
          // verbatim — avoids the 33.333 × 60 = 1999.98 drift that comes
          // from re-multiplying a 3-decimal per-piece weight.
          const snapshotTotal = l.totalWtG ? Number(l.totalWtG) : undefined;
          return {
          itemId: l.itemId === '' ? undefined : Number(l.itemId),
          itemNumber: l.itemNumber || undefined,
          description: l.description || (l.itemNumber ?? 'Item'),
          hsnCode: l.hsnCode || undefined,
          quantity: qty,
          weightG: perPc,
          totalWeightG: snapshotTotal,
          silverRatePerG: l.silverRatePerG ? Number(l.silverRatePerG) : undefined,
          makingRatePerG: l.makingRatePerG ? Number(l.makingRatePerG) : undefined,
          // Detailed — send only the fields the operator actually filled in.
          lessWeightG: l.lessWeightG ? Number(l.lessWeightG) : undefined,
          boxWeightG: l.boxWeightG ? Number(l.boxWeightG) : undefined,
          bagWeightG: l.bagWeightG ? Number(l.bagWeightG) : undefined,
          tagWeightG: l.tagWeightG ? Number(l.tagWeightG) : undefined,
          padWeightG: l.padWeightG ? Number(l.padWeightG) : undefined,
          totalGrossWeightG: l.totalGrossWeightG ? Number(l.totalGrossWeightG) : undefined,
          size: l.size || undefined,
          category: l.category || undefined,
          plating: l.plating || undefined,
          laborOn: l.laborOn,
          laborRateWithTax: l.laborRateWithTax ? Number(l.laborRateWithTax) : undefined,
          laborRateWithoutTax: l.laborRateWithoutTax ? Number(l.laborRateWithoutTax) : undefined,
          laborAmount: l.laborAmount ? Number(l.laborAmount) : undefined,
          // Additional charges: prefer the per-piece rate × qty when the
          // operator typed a perPc value; otherwise fall back to the flat
          // extraAmount from the detail panel.
          // Send the extra amount ALWAYS (0 when cleared) so the backend
          // wipes the previous value instead of leaving it in place. The
          // additionalPerPc row input is the source of truth and the
          // onChange handler keeps l.extraAmount in sync; falling back
          // to the raw extraAmount catches detail-panel edits when the
          // operator uses the flat-total input instead of per-piece.
          extraAmount: l.additionalPerPc !== ''
            ? Number(l.additionalPerPc) * qty
            : (l.extraAmount !== '' ? Number(l.extraAmount) : 0),
          extraDescription: l.extraDescription?.trim() || undefined,
          packetNo: l.packetNo ? Math.trunc(Number(l.packetNo)) : undefined,
          productionOrderRef: l.productionOrderRef || undefined,
          boxRef: l.boxRef || undefined,
          barcode: l.barcode || undefined,
          };
        });
      if (!cleanLines.length) throw new Error('Add at least one line with qty + weight.');
      const body = {
        type,
        invoiceDate,
        status,
        invoiceNumber: invoiceNumber.trim() || undefined,
        customerId: customerId ? Number(customerId) : undefined,
        placeOfSupply: placeOfSupply.trim() || undefined,
        silverRatePerG: silverRate ? Number(silverRate) : undefined,
        makingRatePerG: makingRate ? Number(makingRate) : undefined,
        gstPercent: gstPercent ? Number(gstPercent) : undefined,
        isInterState: interState,
        lines: cleanLines,
        notes: notes || undefined,
        totalWeightG: totalWeightG ? Number(totalWeightG) : undefined,
        purpose: purpose.trim() || undefined,
        laborDiscountPercent: laborDiscountPercent ? Number(laborDiscountPercent) : undefined,
        charges: charges
          .filter((c) => c.chargeTypeId !== '' && Number(c.amount) > 0)
          .map((c) => ({
            chargeTypeId: Number(c.chargeTypeId),
            label: c.label || undefined,
            amount: Number(c.amount),
          })),
        coverages: showCoverageField && coverageTotals.entries.length
          ? coverageTotals.entries.map((e) => ({
              estimateId: e.estimateId,
              silverAllocatedG: e.grams,
              includeOtherCharges: e.include,
            }))
          : undefined,
      };
      return isEdit && editId != null
        ? Api.billing.updateInvoice(editId, body)
        : Api.billing.createInvoice(body);
    },
    onSuccess: async (inv: any) => {
      toast.success(`${inv.invoiceNumber} ${isEdit ? 'updated' : 'created'}.`);
      // The edit form seeds ONCE from the first editQ.data value and
      // guards re-seeds behind a ref. TanStack returns stale cache on
      // mount alongside a background refetch, so a plain invalidate
      // still leaves the seed effect using the stale snapshot until
      // the user manually refreshes. removeQueries() nukes the cache
      // so the next Edit click has to fetch fresh before the seed runs.
      qcc.removeQueries({ queryKey: ['invoice-edit', inv.id] });
      // refetchType: 'all' forces every matching query (including inactive
      // ones — the estimates list page the user just left) to refetch
      // immediately, so navigating back to it shows the updated
      // Alloc.g + Silver status without a hard reload.
      await Promise.all([
        qcc.invalidateQueries({ queryKey: ['invoices'],           refetchType: 'all' }),
        qcc.invalidateQueries({ queryKey: ['temp-invoices'],      refetchType: 'all' }),
        qcc.invalidateQueries({ queryKey: ['invoice', inv.id],    refetchType: 'all' }),
        qcc.invalidateQueries({ queryKey: ['open-estimates'],     refetchType: 'all' }),
        qcc.invalidateQueries({ queryKey: ['customer-ledger', inv.customerId], refetchType: 'all' }),
        qcc.invalidateQueries({ queryKey: ['customer-advances-ledger'],  refetchType: 'all' }),
        qcc.invalidateQueries({ queryKey: ['customer-advances-summary'], refetchType: 'all' }),
      ]);
      router.push(`/billing/invoices/${inv.id}`);
    },
    onError: (e) => toast.error(getApiError(e).message),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title={isEdit ? `Edit ${editQ.data?.invoiceNumber ?? 'Invoice'}` : 'New Invoice'}
        description={
          isEdit
            ? 'Editing an existing invoice — line items, rates, charges and totals are replaced on save. Customer balance is rebalanced.'
            : 'Tax invoice / estimate / delivery challan — pick a customer, add lines, set rates.'
        }
        // router.back() so we return exactly where the operator came from
        // (list scroll position preserved, or the detail page for edit
        // flows) — pushing a fresh href would reset scroll.
        back={true}
        actions={
          <Button onClick={() => create.mutate()} disabled={create.isPending || (isEdit && editQ.isLoading)}>
            {create.isPending && <Spinner className="text-primary-foreground" />}
            {isEdit ? 'Save Changes' : 'Save & Issue'}
          </Button>
        }
      />

      <Card>
        {/* [&>*]:min-w-0 stops grid children from expanding past their track
            width — without it, long customer names bleed into the next
            column. Applies to every Field cell below. */}
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 md:grid-cols-4 [&>*]:min-w-0">
          <Field label="Type">
            <select className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={type} onChange={(e) => setType(e.target.value as any)}>
              <option value="QUOTE">Estimate</option>
              <option value="SALES_ORDER">Sales Order</option>
              <option value="TAX_INVOICE">Tax Invoice</option>
              <option value="DELIVERY_CHALLAN">Delivery Challan</option>
              <option value="CREDIT_NOTE">Credit Note</option>
            </select>
          </Field>
          {/* Customer picker is inside a grid cell — needs min-w-0 on the
              flex + its child so long customer names truncate instead of
              stretching the column into the next field. */}
          <Field label="Customer *">
            <div className="flex min-w-0 items-center gap-1">
              <div className="min-w-0 flex-1">
                <SearchableSelect
                  value={customerId === '' ? '' : String(customerId)}
                  onChange={(v) => setCustomerId(v === '' ? '' : Number(v))}
                  placeholder="— pick customer —"
                  options={(customersQ.data ?? []).map((c) => ({
                    value: c.id,
                    label: c.customerName,
                    subtitle: `${c.customerCode}${c.gstin ? ` · ${c.gstin}` : ''}`,
                  }))}
                />
              </div>
              <QuickAddCustomer onCreated={(id) => setCustomerId(id)} />
            </div>
          </Field>
          <Field label={
            type === 'QUOTE' || type === 'ESTIMATE' ? 'Estimate Date'
              : type === 'DELIVERY_CHALLAN'         ? 'Delivery Date'
              :                                       'Invoice Date'
          }>
            <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </Field>
          <Field
            label={type === 'QUOTE' ? 'Estimate No.' : 'Invoice No.'}
            hint="Leave blank to auto-generate. Override to set a specific number.">
            <Input
              placeholder={isEdit ? String(editQ.data?.invoiceNumber ?? '') : 'auto-generated'}
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              maxLength={40}
            />
          </Field>
          <Field label="Status" hint="DRAFT skips AR balance & lets you save without a customer.">
            <select className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={status} onChange={(e) => setStatus(e.target.value as any)}>
              <option value="DRAFT">Draft (unassigned)</option>
              <option value="READY">Ready</option>
              <option value="ISSUED">Issued</option>
            </select>
          </Field>
          <Field label="Place of Supply" hint="Auto-filled from customer's state. Edit only if different.">
            <Input
              placeholder="State name"
              value={placeOfSupply}
              onChange={(e) => { placeTouchedRef.current = true; setPlaceOfSupply(e.target.value); }}
            />
          </Field>
          {type === 'DELIVERY_CHALLAN' && (
            <Field label="Purpose" hint="Reason for dispatch — e.g. Plating, Casting, Repair. Prints next to Challan No. on the PDF.">
              <Input
                placeholder="e.g. Plating"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                maxLength={120}
              />
            </Field>
          )}

          <Field label="Silver Rate /g (₹)" hint="Applies to every line — overwrites per-row overrides.">
            <Input type="number" step="0.01" value={silverRate}
              onChange={(e) => {
                const v = e.target.value;
                setSilverRate(v);
                // Broadcast to every line so the amounts recompute on the
                // same rate. If the operator wants a per-line override they
                // can edit the row's Silver /g afterwards.
                setLines((rows) => rows.map((r) => ({ ...r, silverRatePerG: v })));
              }}
              placeholder="e.g. 75.00" />
          </Field>
          <Field label="Making /g (₹)" hint="Applies to every line — overwrites per-row overrides.">
            <Input type="number" step="0.01" value={makingRate}
              onChange={(e) => {
                const v = e.target.value;
                setMakingRate(v);
                setLines((rows) => rows.map((r) => ({ ...r, makingRatePerG: v })));
              }}
              placeholder="e.g. 30.00" />
          </Field>
          <Field label="GST %">
            <Input type="number" step="0.01" value={gstPercent} onChange={(e) => setGstPercent(e.target.value)} disabled={type === 'DELIVERY_CHALLAN'} />
          </Field>
          <Field label="Tax mode">
            <select className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={interState ? 'IGST' : 'CGST_SGST'}
              onChange={(e) => setInterState(e.target.value === 'IGST')}
              disabled={type === 'DELIVERY_CHALLAN'}>
              <option value="CGST_SGST">CGST + SGST (intra-state)</option>
              <option value="IGST">IGST (inter-state)</option>
            </select>
          </Field>
          {showCoverageField && (
            <Field label="Estimates covered"
              hint={customerId
                ? "Which estimates does this invoice's silver settle. Opens a picker with the customer's OPEN/PARTIAL estimates."
                : 'Pick a customer above to enable this picker.'}>
              <Button
                type="button"
                variant="outline"
                className="h-9 justify-start"
                onClick={() => setCoverageOpen(true)}
                disabled={!customerId}
              >
                {coverageTotals.count === 0
                  ? 'Select estimates…'
                  : `${coverageTotals.count} estimate${coverageTotals.count === 1 ? '' : 's'} · ${coverageTotals.grams.toFixed(3)} g`}
              </Button>
            </Field>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {/* .table-scroll: on xl+ (1280px+) renders as a proper table;
              below xl each row collapses into a stacked card (labels sit
              above their inputs). No horizontal scroll on either mode. */}
          <div className="table-scroll">
            <table className="w-full text-sm table-fixed">
              {/* Explicit column widths let table-fixed distribute space
                  predictably. Sums to ~100% so no column blows out to
                  fit the widest content — the table stays inside the
                  viewport at 1280px+ and stacks below that. */}
              {/* Column widths as % — table-fixed distributes them
                  predictably. Wt/pc column removed per operator spec:
                  entering per-piece weight and re-multiplying by qty
                  rounds off (e.g. 2000/30 = 66.6667 · 30 = 1999.998).
                  Total Wt is now typed directly and stored as a
                  snapshot so the printed weight is exact. */}
              <colgroup>
                {type !== 'DELIVERY_CHALLAN' ? (
                  <>
                    <col style={{ width: '3%' }} />
                    <col style={{ width: '22%' }} />
                    <col style={{ width: '9%' }} />
                    <col style={{ width: '7%' }} />
                    <col style={{ width: '11%' }} />
                    <col style={{ width: '9%' }} />
                    <col style={{ width: '9%' }} />
                    <col style={{ width: '12%' }} />
                    <col style={{ width: '11%' }} />
                    <col style={{ width: '7%' }} />
                  </>
                ) : (
                  <>
                    <col style={{ width: '4%' }} />
                    <col style={{ width: '48%' }} />
                    <col style={{ width: '14%' }} />
                    <col style={{ width: '12%' }} />
                    <col style={{ width: '14%' }} />
                    <col style={{ width: '8%' }} />
                  </>
                )}
              </colgroup>
              {/* Challan = goods-only doc → no money columns. Silver/g + Making/g
                  + Amount hide; Total Wt column always shows so the operator
                  sees qty × wt/pc rolled up per row. */}
              <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-2 py-2">#</th>
                  <th className="px-2 py-2">Item &amp; Description</th>
                  <th className="px-2 py-2">HSN</th>
                  <th className="px-2 py-2 text-right">Qty</th>
                  <th className="px-2 py-2 text-right">Total Wt (g)</th>
                  {type !== 'DELIVERY_CHALLAN' && (
                    <>
                      <th className="px-2 py-2 text-right">Silver /g</th>
                      <th className="px-2 py-2 text-right">Making /g</th>
                      <th className="px-2 py-2 text-right">Addl / Reason</th>
                      <th className="px-2 py-2 text-right">Amount</th>
                    </>
                  )}
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, idx) => {
                  // Total weight: use the directly-typed totalWtG when set,
                  // otherwise fall back to per-piece × quantity.
                  const wt = l.totalWtG
                    ? Number(l.totalWtG)
                    : Number(l.weightG || 0) * Number(l.quantity || 0);
                  const sv = Number(l.silverRatePerG || silverRate || 0);
                  const mk = Number(l.makingRatePerG || makingRate || 0);
                  // Additional charges are per-piece × qty (flat line total).
                  const qtyN = Number(l.quantity || 0);
                  const addl = Number(l.additionalPerPc || 0) * qtyN;
                  const amt = wt * (sv + mk) + addl;
                  return (
                  <React.Fragment key={l._k}>
                    <tr className="border-t border-border">
                      <td className="px-2 py-2 text-xs text-muted-foreground align-top pt-4">{idx + 1}</td>
                      {/* Item cell — free-text name up top with a datalist
                          suggesting master items/materials (native browser
                          combobox: user can type ANY value, or pick a
                          suggestion to auto-fill HSN / weight / description
                          from the master). Description input below. */}
                      <td className="px-2 py-2 align-top">
                        <Input
                          list={`items-master-${idx}`}
                          value={l.itemNumber}
                          placeholder="Item name (or type freely)"
                          onChange={(e) => {
                            const typed = e.target.value;
                            // Try to match a master option; if we match,
                            // populate HSN/weight/description from the pick.
                            // If we don't (custom text), leave the item as-is
                            // — the row still saves as a free-text line.
                            const piece = (piecesQ.data ?? []).find((p) => p.itemNumber === typed);
                            const mv = piece ? null : (variantsQ.data ?? []).find((m: any) =>
                              (m.variantCode === typed) || (m.variantName === typed)
                            );
                            setLines((rs) => rs.map((r, i) => {
                              if (i !== idx) return r;
                              if (piece) {
                                return {
                                  ...r,
                                  itemId: piece.itemId,
                                  variantId: '',
                                  itemNumber: piece.itemNumber ?? typed,
                                  description: piece.description ?? r.description,
                                  weightG: piece.perPieceWeightG ? String(piece.perPieceWeightG) : r.weightG,
                                };
                              }
                              if (mv) {
                                return {
                                  ...r,
                                  itemId: '',
                                  variantId: mv.id,
                                  itemNumber: mv.variantCode ?? typed,
                                  description: mv.variantName ?? mv.materialName ?? r.description,
                                  hsnCode: mv.hsnCode ?? r.hsnCode,
                                };
                              }
                              // Custom text — clear any master link and
                              // just keep the typed name.
                              return { ...r, itemId: '', variantId: '', itemNumber: typed };
                            }));
                          }}
                          className="px-2 text-sm"
                        />
                        <datalist id={`items-master-${idx}`}>
                          {(piecesQ.data ?? []).map((p) => (
                            <option key={`i-${p.itemId}`} value={p.itemNumber ?? ''}>
                              {p.description}
                            </option>
                          ))}
                          {(variantsQ.data ?? []).map((mv: any) => (
                            <option key={`v-${mv.id}`} value={mv.variantCode ?? mv.variantName ?? ''}>
                              {mv.variantName ?? mv.materialName ?? ''}
                            </option>
                          ))}
                        </datalist>
                        <Input
                          value={l.description}
                          placeholder="Description (optional)"
                          onChange={(e) => setLines((rs) => rs.map((r, i) => i === idx ? { ...r, description: e.target.value } : r))}
                          className="mt-1 h-8 text-xs"
                        />
                      </td>
                      <td className="px-2 py-2 align-top">
                        <Input value={l.hsnCode}
                          onChange={(e) => setLines((rs) => rs.map((r, i) => i === idx ? { ...r, hsnCode: e.target.value } : r))}
                          className="px-2 text-sm" />
                      </td>
                      <td className="px-2 py-2 align-top">
                        <Input type="number" min="1" value={l.quantity}
                          onChange={(e) => setLines((rs) => rs.map((r, i) => i === idx ? { ...r, quantity: e.target.value } : r))}
                          className="text-right px-2 text-sm" />
                      </td>
                      {/* Total Wt — the ONLY weight input now (Wt/pc removed
                          per operator spec). Snapshotted on save so the PDF
                          prints the exact typed value, no per-piece drift.
                          weightG is back-derived on save = totalWtG / qty. */}
                      <td className="px-2 py-2 align-top">
                        <Input type="number" step="0.001"
                          placeholder="0.000"
                          value={l.totalWtG || (l.weightG && Number(l.quantity) > 0
                            ? (Number(l.weightG) * Number(l.quantity)).toFixed(3)
                            : '')}
                          onChange={(e) => setLines((rs) => rs.map((r, i) => i === idx ? {
                            ...r, totalWtG: e.target.value, weightG: '',
                          } : r))}
                          className="text-right px-2 text-sm" />
                      </td>
                      {type !== 'DELIVERY_CHALLAN' && (
                        <>
                          <td className="px-2 py-2 align-top">
                            <Input type="number" step="0.01" placeholder={silverRate || '—'} value={l.silverRatePerG}
                              onChange={(e) => setLines((rs) => rs.map((r, i) => i === idx ? { ...r, silverRatePerG: e.target.value } : r))}
                              className="text-right px-2 text-sm" />
                          </td>
                          <td className="px-2 py-2 align-top">
                            <Input type="number" step="0.01" placeholder={makingRate || '—'} value={l.makingRatePerG}
                              onChange={(e) => setLines((rs) => rs.map((r, i) => i === idx ? { ...r, makingRatePerG: e.target.value } : r))}
                              className="text-right px-2 text-sm" />
                          </td>
                          {/* Additional Charges — PER PIECE. On save we
                              compute extraAmount = perPc × qty; on load we
                              back-derive from stored extraAmount ÷ qty.
                              A short description field below the amount
                              lets the operator capture WHY the extra is
                              being charged (rework, urgent, etc.) — the
                              PDF prints it as a caption on the row. */}
                          <td className="px-2 py-2 align-top">
                            <Input type="number" step="0.01" placeholder="Addl /pc" value={l.additionalPerPc}
                              onChange={(e) => setLines((rs) => rs.map((r, i) => {
                                if (i !== idx) return r;
                                const raw = e.target.value;
                                // Keep row-level additionalPerPc AND
                                // detail-panel extraAmount in lockstep so
                                // clearing the row input actually clears
                                // the persisted extra. Otherwise a stale
                                // extraAmount from load re-hydrates on save.
                                const qtyN = Math.max(0, Math.trunc(Number(r.quantity || 0)));
                                const nextExtra = raw === '' ? '' : String(Number(raw) * qtyN);
                                return { ...r, additionalPerPc: raw, extraAmount: nextExtra };
                              }))}
                              className="text-right px-2 text-sm" title="Additional charges per piece (multiplied by qty on save)." />
                            <Input type="text" placeholder="reason (optional)" value={l.extraDescription}
                              onChange={(e) => setLines((rs) => rs.map((r, i) => i === idx ? { ...r, extraDescription: e.target.value } : r))}
                              className="mt-1 h-7 px-2 text-xs" maxLength={120}
                              title="Short description printed on the PDF next to the addl amount (e.g. 'urgent delivery')." />
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums font-medium text-sm whitespace-nowrap">
                            ₹ {amt.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                        </>
                      )}
                      <td className="px-2 py-2 flex gap-1">
                        <Button type="button" variant="outline" size="icon"
                          title={l.detailOpen ? 'Hide weight breakdown' : 'Add weight breakdown'}
                          onClick={() => setLines((rs) => rs.map((r, i) => i === idx ? { ...r, detailOpen: !r.detailOpen } : r))}>
                          {l.detailOpen ? '−' : '+'}
                        </Button>
                        <Button type="button" variant="outline" size="icon" className="text-destructive"
                          onClick={() => setLines((rs) => rs.filter((_, i) => i !== idx))}>
                          <Trash2 className="size-4" />
                        </Button>
                      </td>
                    </tr>
                    {l.detailOpen && (
                      <tr className="border-t border-dashed border-border bg-secondary/10">
                        <td colSpan={type === 'DELIVERY_CHALLAN' ? 6 : 10} className="px-3 py-3">
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-xs md:grid-cols-6">
                            <DetailInput row={l} idx={idx} setLines={setLines} field="productionOrderRef" label="Prod Order" />
                            <DetailInput row={l} idx={idx} setLines={setLines} field="boxRef" label="Box" />
                            <DetailInput row={l} idx={idx} setLines={setLines} field="category" label="Category" />
                            <DetailInput row={l} idx={idx} setLines={setLines} field="plating" label="Plating" />
                            <DetailInput row={l} idx={idx} setLines={setLines} field="size" label="Size" />
                            <DetailInput row={l} idx={idx} setLines={setLines} field="barcode" label="Barcode" />

                            <DetailNum row={l} idx={idx} setLines={setLines} field="lessWeightG" label="Less Wt (g)" step="0.001" />
                            <DetailNum row={l} idx={idx} setLines={setLines} field="boxWeightG" label="Box (g)" step="0.001" />
                            <DetailNum row={l} idx={idx} setLines={setLines} field="bagWeightG" label="Bag (g)" step="0.001" />
                            <DetailNum row={l} idx={idx} setLines={setLines} field="tagWeightG" label="Tag (g)" step="0.001" />
                            <DetailNum row={l} idx={idx} setLines={setLines} field="padWeightG" label="Pad (g)" step="0.001" />
                            <DetailNum row={l} idx={idx} setLines={setLines} field="totalGrossWeightG" label="Total Gross (g)" step="0.001" />

                            <div className="col-span-2">
                              <div className="text-[10px] text-muted-foreground">Labor On</div>
                              <select className="mt-0.5 h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                                value={l.laborOn}
                                onChange={(e) => setLines((rs) => rs.map((r, i) => i === idx ? { ...r, laborOn: e.target.value as any } : r))}>
                                <option value="WEIGHT">Weight</option>
                                <option value="PIECE">Piece</option>
                              </select>
                            </div>
                            <DetailNum row={l} idx={idx} setLines={setLines} field="laborRateWithTax" label="Labor Rate (w/ Tax)" step="0.0001" />
                            <DetailNum row={l} idx={idx} setLines={setLines} field="laborRateWithoutTax" label="Labor Rate (w/o Tax)" step="0.0001" />
                            <DetailNum row={l} idx={idx} setLines={setLines} field="laborAmount" label="Labor Amount" step="0.01" />
                            <DetailNum row={l} idx={idx} setLines={setLines} field="extraAmount" label="Extra Amount" step="0.01" />
                            <DetailNum row={l} idx={idx} setLines={setLines} field="packetNo" label="Packet No" step="1" />
                          </div>
                          {/* Derived preview — Net = Gross − Less. Fine and
                              Wastage Fine dropped along with the Purity and
                              Wastage inputs. */}
                          {(() => {
                            const gross = Number(l.weightG || 0) * Number(l.quantity || 0);
                            const less = Number(l.lessWeightG || 0);
                            const net = Math.max(0, gross - less);
                            return (
                              <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                                <span>Gross = <b className="text-foreground tabular-nums">{gross.toFixed(3)} g</b></span>
                                <span>Net = <b className="text-foreground tabular-nums">{net.toFixed(3)} g</b></span>
                              </div>
                            );
                          })()}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                  );
                })}
              </tbody>
              {/* Totals footer — sums Qty + Total Wt across all lines. For
                  non-challan docs the Amount column already has a Grand Total
                  card below; this footer is just for the row table itself. */}
              <tfoot className="border-t border-border bg-secondary/20 text-sm font-semibold">
                <tr>
                  {/* Cols: # Item HSN Qty TotalWt Silver Making Addl Amount Actions
                      TOTAL label spans # + Item + HSN. */}
                  <td colSpan={3} className="px-2 py-2 text-right text-text-faint">TOTAL</td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {type === 'DELIVERY_CHALLAN' ? (
                      <div className="flex items-center justify-end gap-1">
                        <Input
                          type="number" step="0.001"
                          className="h-7 w-24 text-right"
                          placeholder={lines.reduce((s, l) => s + (l.totalWtG ? Number(l.totalWtG) : Number(l.weightG || 0) * Number(l.quantity || 0)), 0).toFixed(3)}
                          value={totalWeightG}
                          onChange={(e) => setTotalWeightG(e.target.value)}
                          title="Override the calculated sum — e.g. include tare, dust, or a physical dispatch weight."
                        />
                        <span className="text-text-faint">g</span>
                      </div>
                    ) : (
                      <>{lines.reduce((s, l) => s + (l.totalWtG ? Number(l.totalWtG) : Number(l.weightG || 0) * Number(l.quantity || 0)), 0).toFixed(3)} g</>
                    )}
                  </td>
                  {type !== 'DELIVERY_CHALLAN' && (
                    <>
                      <td className="px-2 py-2"></td>
                      <td className="px-2 py-2"></td>
                      <td className="px-2 py-2"></td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        ₹ {lines.reduce((s, l) => {
                          // Use the operator-typed total when set, else
                          // per-piece × qty. Same math as the per-row Amount
                          // so the TOTAL matches the visible row values.
                          const wt = l.totalWtG
                            ? Number(l.totalWtG)
                            : Number(l.weightG || 0) * Number(l.quantity || 0);
                          const sv = Number(l.silverRatePerG || silverRate || 0);
                          const mk = Number(l.makingRatePerG || makingRate || 0);
                          const qtyN = Number(l.quantity || 0);
                          const addl = Number(l.additionalPerPc || 0) * qtyN;
                          return s + wt * (sv + mk) + addl;
                        }, 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                    </>
                  )}
                  <td className="px-2 py-2"></td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="border-t border-border p-2">
            <Button variant="outline" size="sm" onClick={() => setLines((rs) => [...rs, newRow()])}>
              <Plus className="size-4" /> Add row
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Optional: labor discount + additional charges (freight / packaging / etc.) */}
      <Card>
        <CardContent className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold">Additional Charges & Discounts</div>
              <div className="text-xs text-muted-foreground">All optional. Charges go pre-GST; labor discount reduces making amount.</div>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm"
                onClick={() => setCharges((cs) => [...cs, { _k: Math.random(), chargeTypeId: '', label: '', amount: '' }])}>
                <Plus className="size-4" /> Add charge
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label="Labor / Making discount %">
              <Input type="number" step="0.01" min="0" placeholder="0"
                value={laborDiscountPercent}
                onChange={(e) => setLaborDiscountPercent(e.target.value)} />
            </Field>
            <div className="md:col-span-2">
              {charges.length === 0 ? (
                <div className="text-xs text-muted-foreground">No additional charges. Click "Add charge" to include freight, packaging, insurance, etc.</div>
              ) : (
                <div className="space-y-2">
                  {charges.map((c, idx) => (
                    <div key={c._k} className="grid grid-cols-12 gap-2">
                      <div className="col-span-4">
                        <select
                          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                          value={c.chargeTypeId === '' ? '' : String(c.chargeTypeId)}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v === '__add__') {
                              const name = window.prompt('New charge type (e.g. Hamali)');
                              if (name) newChargeType.mutate(name);
                              return;
                            }
                            setCharges((cs) => cs.map((x, i) => i === idx ? { ...x, chargeTypeId: v === '' ? '' : Number(v) } : x));
                          }}>
                          <option value="">— pick charge —</option>
                          {(chargeTypesQ.data ?? []).map((t) => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                          <option value="__add__">+ Add new type…</option>
                        </select>
                      </div>
                      <div className="col-span-5">
                        <Input placeholder="Label (optional override)"
                          value={c.label}
                          onChange={(e) => setCharges((cs) => cs.map((x, i) => i === idx ? { ...x, label: e.target.value } : x))} />
                      </div>
                      <div className="col-span-2">
                        <Input type="number" step="0.01" min="0" placeholder="Amount"
                          value={c.amount}
                          onChange={(e) => setCharges((cs) => cs.map((x, i) => i === idx ? { ...x, amount: e.target.value } : x))} />
                      </div>
                      <div className="col-span-1">
                        <Button type="button" variant="outline" size="icon" className="text-destructive"
                          onClick={() => setCharges((cs) => cs.filter((_, i) => i !== idx))}>
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <div>
              <Field label="Notes">
                <textarea
                  className="min-h-[80px] w-full rounded-md border border-input bg-background p-2 text-sm"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </Field>
            </div>
            <div className="ml-auto w-full max-w-xs space-y-1 text-sm">
              {totals.laborDiscount > 0 && <Row label="Labor discount" value={-totals.laborDiscount} />}
              {totals.chargesTotal > 0 && <Row label="Additional charges" value={totals.chargesTotal} />}
              <Row label="Subtotal" value={totals.sub} />
              {type !== 'DELIVERY_CHALLAN' && (interState
                ? <Row label={`IGST @ ${gstPercent}%`} value={totals.igst} />
                : <>
                    <Row label={`CGST @ ${(Number(gstPercent || 0) / 2).toFixed(2)}%`} value={totals.cgst} />
                    <Row label={`SGST @ ${(Number(gstPercent || 0) / 2).toFixed(2)}%`} value={totals.sgst} />
                  </>)}
              {Math.abs(totals.round) > 0.005 && <Row label="Round off" value={totals.round} />}
              <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                <span className="font-semibold">Grand Total</span>
                <span className="text-lg font-bold tabular-nums">
                  ₹ {totals.total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {showCoverageField && (
        <CoveragePickerDialog
          open={coverageOpen}
          estimates={openEstimates}
          value={coverages}
          onClose={() => setCoverageOpen(false)}
          onSave={(next) => { setCoverages(next); setCoverageOpen(false); }}
        />
      )}
    </div>
  );
}

/**
 * Coverage picker — modal listing the customer's OPEN/PARTIAL estimates
 * with a grams input per row. "Auto-fill" button drops the running silver
 * total across the still-uncovered estimates until the invoice's Mixed
 * Silver Jewellery grams are exhausted (FIFO by estimate id, matches the
 * ordering the estimate list uses).
 */
type CoveragePickerEntry = { grams: string; include: boolean };
function CoveragePickerDialog({
  open, estimates, value, onClose, onSave,
}: {
  open: boolean;
  estimates: any[];
  value: Record<number, CoveragePickerEntry>;
  onClose: () => void;
  onSave: (next: Record<number, CoveragePickerEntry>) => void;
}) {
  const [local, setLocal] = React.useState<Record<number, CoveragePickerEntry>>(value);
  React.useEffect(() => { if (open) setLocal(value); }, [open, value]);

  const total = Object.values(local).reduce((s, v) => s + (Number(v?.grams) || 0), 0);
  const overRows = estimates.some((e) => {
    const req   = Number(e.summary?.silverRequiredG  ?? 0);
    const done  = Number(e.summary?.silverAllocatedG ?? 0);
    const remain = Math.max(0, req - done);
    const cur   = Number(local[e.id]?.grams || 0);
    return cur > remain + 0.0005;
  });
  // Total "Other Charges" that will fold into the synthesized ABN line
  // once toggles are honored — the sum of Σ(making + extra) across every
  // estimate whose "Include" box is ticked in this dialog.
  const otherChargesTotal = estimates.reduce((s, e) => {
    if (!local[e.id]?.include) return s;
    return s + Number(e.summary?.otherChargesAmt ?? 0);
  }, 0);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Estimates Covered"
      description="How many grams of this invoice's silver settle each of the customer's open estimates. Backend rejects any row that exceeds its remaining need. Tick 'Include other charges' to roll that estimate's (making + additional) sum into an 'Other Charges' line on the invoice."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave(local)} disabled={overRows}>
            Save · {total.toFixed(3)} g{otherChargesTotal > 0 ? ` + ₹${otherChargesTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : ''}
          </Button>
        </>
      }
    >
      {estimates.length === 0 ? (
        <div className="rounded border border-warning/40 bg-warning/10 px-3 py-3 text-sm text-warning">
          This customer has no OPEN or PARTIAL estimates. Nothing to cover.
        </div>
      ) : (
        <div className="table-scroll">
          <table className="w-full text-sm">
            <thead className="bg-secondary/30 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Estimate</th>
                <th className="px-3 py-2 text-right">Required g</th>
                <th className="px-3 py-2 text-right">Already alloc.</th>
                <th className="px-3 py-2 text-right">Remaining</th>
                <th className="px-3 py-2 text-right">Cover g</th>
                <th className="px-3 py-2 text-right">Other Charges ₹</th>
                <th className="px-3 py-2 text-center">Include</th>
              </tr>
            </thead>
            <tbody>
              {estimates.map((e) => {
                const req      = Number(e.summary?.silverRequiredG  ?? 0);
                const done     = Number(e.summary?.silverAllocatedG ?? 0);
                const remain   = Math.max(0, req - done);
                const other    = Number(e.summary?.otherChargesAmt ?? 0);
                const cur      = Number(local[e.id]?.grams || 0);
                const included = !!local[e.id]?.include;
                const over     = cur > remain + 0.0005;
                return (
                  <tr key={e.id} className="border-t border-border">
                    <td className="px-3 py-2 font-semibold">{e.invoiceNumber}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-xs">{req.toFixed(3)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-xs">{done.toFixed(3)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-xs text-warning">{remain.toFixed(3)}</td>
                    <td className="px-3 py-2 text-right">
                      <Input
                        type="number" step="0.001" min="0" max={remain}
                        value={local[e.id]?.grams ?? ''}
                        onChange={(ev) => setLocal((r) => ({ ...r, [e.id]: { grams: ev.target.value, include: r[e.id]?.include ?? false } }))}
                        placeholder="0.000"
                        className={`h-8 w-24 text-right ${over ? 'border-destructive' : ''}`}
                      />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-xs">
                      {other.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={included}
                        disabled={other <= 0}
                        onChange={(ev) => setLocal((r) => ({ ...r, [e.id]: { grams: r[e.id]?.grams ?? '', include: ev.target.checked } }))}
                        className="size-4 cursor-pointer"
                        title={other <= 0 ? 'No other charges on this estimate' : 'Roll this estimate\'s making + additional into the invoice'}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-border bg-secondary/30 font-semibold">
                <td colSpan={4} className="px-3 py-2 text-right">Total covered</td>
                <td className="px-3 py-2 text-right tabular-nums">{total.toFixed(3)} g</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  ₹{otherChargesTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">₹ {Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
    </div>
  );
}

function DetailInput({ row, idx, setLines, field, label }: {
  row: LineRow; idx: number;
  setLines: React.Dispatch<React.SetStateAction<LineRow[]>>;
  field: keyof LineRow; label: string;
}) {
  return (
    <div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <Input className="h-8 text-xs"
        value={(row as any)[field] as string ?? ''}
        onChange={(e) => setLines((rs) => rs.map((r, i) => i === idx ? { ...r, [field]: e.target.value } : r))} />
    </div>
  );
}

function DetailNum({ row, idx, setLines, field, label, step }: {
  row: LineRow; idx: number;
  setLines: React.Dispatch<React.SetStateAction<LineRow[]>>;
  field: keyof LineRow; label: string; step?: string;
}) {
  return (
    <div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <Input className="h-8 text-right text-xs" type="number" step={step ?? '0.01'}
        value={(row as any)[field] as string ?? ''}
        onChange={(e) => setLines((rs) => rs.map((r, i) => i === idx ? { ...r, [field]: e.target.value } : r))} />
    </div>
  );
}
