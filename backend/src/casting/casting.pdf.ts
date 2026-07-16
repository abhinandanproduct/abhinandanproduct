import PDFDocument from 'pdfkit';
import { Response } from 'express';
import { PassThrough } from 'stream';
import QRCode from 'qrcode';

interface VendorPdfData {
  batchNumber: string;
  processName: string;
  docType?: string; // "Issue Slip" (default) or "Receipt"
  batchDate: Date;
  vendor: { vendorCode: string; vendorName: string };
  // Numeric ids surfaced so the Order Details QR codes can encode a scan
  // URL like `/casting/scan?b=<batchId>&v=<vendorId>&s=<stageId>`. The
  // scan page then opens ReceiveForm pre-scoped to (batchId × vendorId)
  // so the karigar accepts the lot in one tap. Optional — receipt /
  // repair slips skip the order-details box anyway, so they don't need
  // these and old callers stay compatible.
  batchId?: number | null;
  vendorId?: number | null;
  isWeightProcess?: boolean;
  internal?: boolean;
  tax?: 'GST' | 'URD' | null;
  items: {
    itemNumber?: string | null;
    designCode?: string | null;
    salesItemNumber?: string | null;
    colorCode?: string | null;
    vendorDesignReference: string | null;
    color?: string | null;
    weight: number;
    quantity: number;
    totalWeight: number;
    price?: number | null;
    amount?: number | null;
    // Stage id of the CastingBatchItem row this slip line came from —
    // used by the per-card QR in the Order Details box. Multiple rows
    // can share a card (colour-split consolidation by design × purpose)
    // and we pick the first stage id of the group to encode.
    stageId?: number | null;
    // QC bifurcation for RECEIPT slips — set only by receiptPdfData().
    // Renders beneath the Qty value: "+N rep" (repair, vendor holds —
    // billed later) and "+N rej (NO PAY / FULL / ADJ)" (operator's
    // payment intent on the rejected pcs). Absent for issue / repair
    // slips, which don't carry this concept.
    qc?: {
      receivedQty: number;       // gross pcs vendor returned this trip
      accepted: number;          // payable now
      repair: number;            // with vendor for rework — pay later
      rejected: number;          // refused
      rejectMode: 'NO_PAY' | 'ADJUSTED' | 'FULL_PAY' | null;
      rejectAdjustment: number;  // ₹ amount when rejectMode = ADJUSTED
      repairWeight: number;
      rejectedWeight: number;
    } | null;
    // Costed snapshot of additional services chosen on this stage. Each
    // entry resolves to { name, costPerPc }; costPerPc may be null when
    // the service has no rate configured yet. Used to render the
    // "Additional Services" block below the items table (Sr | Design |
    // Qty | Service | Rate/pc | Amount with a TOTAL row).
    services?: { name: string; costPerPc: number | null }[] | null;
    remarks: string | null;
    // Customer / order purpose — surfaces in the Order Details box
    // below the Grand Total. Carried forward across every stage by
    // the backend's forwardStage logic so the slip always knows
    // who the work is for.
    purpose?: string | null;
    materials?: {
      name: string;
      variantCode?: string | null;
      required: number;
      unit: string | null;
      issuedQty?: number;
      deferredQty?: number;
    }[];
  }[];
}

// Layout — A4 PORTRAIT, plain black & white. The whole slip uses black
// borders/text on a white page — no fills, no colour highlights, so it
// prints cleanly on any office printer or carbon-copy form.
// 595 × 842pt is A4 portrait.
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 36;
const CONTENT_W = PAGE_W - MARGIN * 2;
const LEFT = MARGIN;
const RIGHT = PAGE_W - MARGIN;
const PAGE_BOTTOM = PAGE_H - MARGIN;
// Single greyscale palette — keep table borders crisp and labels slightly
// muted, but no colour anywhere.
const COLOR_BORDER = '#000000';
const COLOR_TEXT = '#000000';
const COLOR_LABEL = '#333333';
// Backgrounds are deliberately removed — every helper that accepts a bg
// arg is now called without one so rows render white.

// Minimal company identity at the top — trading name + one-line address.
// Kept lean for the half-A4 layout.
const COMPANY = {
  name: 'SHREE ABHINANDAN PRODUCT',
  subtitle: '(Pratik Product)',
  address: 'Jewellery made with emotions. · 92.5 Silver Manufacturing',
};

/**
 * Streams a compact "Karigar Order cum Material Issue Voucher" — A5 landscape
 * (half a vertical-A4 sheet). Company name at the top, then the voucher
 * title, then the body (party · process · items · reconciliation).
 */
export async function streamVendorPdf(res: Response, data: VendorPdfData): Promise<void> {
  // IMPORTANT bottom-margin = 2pt (not 24) — we manage pagination ourselves
  // via ensureSpace(); PDFKit's auto-pagination check (`y + lineHeight >
  // pageHeight - bottomMargin`) was firing on the page-number footer at
  // y=408 with bottom=24 (cutoff 396), spawning one extra blank page per
  // existing page. Dropping the bottom margin to 2pt lifts the cutoff to
  // 418 so the footer fits without triggering auto-page. Top/left/right
  // margins stay at MARGIN — we still center content within MARGIN.
  const doc = new PDFDocument({
    size: [PAGE_W, PAGE_H],
    margins: { top: MARGIN, bottom: 2, left: MARGIN, right: MARGIN },
    bufferPages: true,
  });

  // Filename mirrors the UI slip label so the saved/printed file
  // self-identifies: <batchNumber>-<vendorName>-<DDMMMYYYY>-<qty>pcs.pdf.
  // Falls back gracefully when any field is missing. Vendor name is
  // sanitised (spaces → underscores, special chars stripped) so the file
  // system accepts it on every OS. Names prefixed with `fn` to avoid the
  // existing `totalQty` / `dateStr` further down in the render code.
  const fnTotalQty = (data.items ?? []).reduce((s, i) => s + (i.quantity ?? 0), 0);
  const fnDocDate = new Date(data.batchDate);
  const fnDateStr = Number.isNaN(fnDocDate.getTime())
    ? ''
    : fnDocDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/\s+/g, '');
  const fnSanitize = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  const fnVendorPart = fnSanitize(data.vendor?.vendorName ?? data.vendor?.vendorCode ?? 'vendor');
  // Batch number can include a slip suffix (e.g. "B0036 · ISS-3371" or
  // "B0036 · R03001") — keep the whole thing, just sanitise.
  const fnBatchPart  = fnSanitize(data.batchNumber ?? 'batch');
  const fnParts = [fnBatchPart, fnVendorPart, fnDateStr, `${fnTotalQty}pcs`].filter(Boolean);
  const fileName = `${fnParts.join('-')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  doc.pipe(res);

  // `internal` is accepted for backward compat but no longer changes the
  // layout — issue and receipt slips now share the same column set; the
  // Colour column auto-appears for colour processes (see below).
  const weightMode = data.isWeightProcess !== false;
  // Snap-to-integer when the value is within ±0.02 of a whole number —
  // covers the recurring-decimal scenario where operator typed a clean
  // 1200g for 36 pcs and per-pc cascaded as 33.333… × 36 = 1199.988
  // becoming "Rs. 779.99" instead of "Rs. 780" on the slip. Same snap is
  // applied in weightFmt() below so Total Wt and amount stay consistent.
  const money = (n: number) => {
    const nearestInt = Math.round(n);
    if (Math.abs(n - nearestInt) < 0.02) {
      return `Rs. ${nearestInt.toLocaleString('en-IN')}`;
    }
    return `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };
  let y = MARGIN;

  // Reserve 12pt at bottom for page-number footer.
  const SAFE_BOTTOM = PAGE_BOTTOM - 12;
  const ensureSpace = (needed: number, onNewPage?: () => void) => {
    if (y + needed > SAFE_BOTTOM) {
      doc.addPage();
      y = MARGIN;
      if (onNewPage) onNewPage();
    }
  };

  // -----------------------------------------------------------------------
  // 1. HEADER — company name + one-line address + voucher title. Tightly
  // packed so the items table has maximum room on the A5 page.
  // -----------------------------------------------------------------------
  doc.fillColor(COLOR_TEXT).font('Helvetica-Bold').fontSize(16)
    .text(COMPANY.name, LEFT, y, { width: CONTENT_W, align: 'center', lineBreak: false });
  y += 18;
  // Trading-name subtitle sits between the legal name and the tagline
  // so vendors match invoices to the name they know us by day-to-day.
  doc.fillColor(COLOR_LABEL).font('Helvetica').fontSize(9)
    .text(COMPANY.subtitle, LEFT, y, { width: CONTENT_W, align: 'center', lineBreak: false });
  y += 11;
  doc.fillColor(COLOR_LABEL).font('Helvetica').fontSize(8)
    .text(COMPANY.address, LEFT, y, { width: CONTENT_W, align: 'center', lineBreak: false });
  y += 12;
  const titleText =
    data.docType === 'Receipt'
      ? `Karigar Order cum Material Receipt Voucher`
      : data.docType === 'Repair'
        ? `🔧 REPAIR ORDER — NO CHARGE`
        : `Karigar Order cum Material Issue Voucher`;
  doc.fillColor(COLOR_TEXT).font('Helvetica-Bold').fontSize(12)
    .text(titleText, LEFT, y, { width: CONTENT_W, align: 'center', lineBreak: false });
  y += 16;
  doc.strokeColor(COLOR_BORDER).lineWidth(0.8);
  doc.moveTo(LEFT, y).lineTo(RIGHT, y).stroke();
  doc.lineWidth(0.6);
  y += 6;

  // -----------------------------------------------------------------------
  // 2. PARTY · PROCESS · DATE · VOUCHER — proper 4-cell grid (no more
  // overlapping right-aligned text boxes that smushed Vchr No into the
  // batch number). Line 1: Party | Date. Line 2: Process | Vchr No.
  // -----------------------------------------------------------------------
  const dateStr = new Date(data.batchDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const colA_x = LEFT;                       // left column x
  const colA_labelW = 46;                    // "Party:" / "Process:" label width
  const colA_valueX = LEFT + colA_labelW;    // value text starts here
  const colA_valueW = CONTENT_W / 2 - colA_labelW - 12;
  const colB_x = LEFT + CONTENT_W / 2;       // right column x
  const colB_labelW = 60;                    // "Date:" / "Vchr No.:" label width
  const colB_valueX = colB_x + colB_labelW;
  const colB_valueW = CONTENT_W / 2 - colB_labelW;

  const drawField = (labelX: number, labelW: number, valueX: number, valueW: number,
                     label: string, value: string,
                     opts: { valueBold?: boolean; valueSize?: number } = {}) => {
    doc.fillColor(COLOR_LABEL).font('Helvetica').fontSize(9)
      .text(label, labelX, y, { width: labelW, lineBreak: false });
    doc.fillColor(COLOR_TEXT).font(opts.valueBold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.valueSize ?? 10)
      .text(value, valueX, y - 1, { width: valueW, lineBreak: false, ellipsis: true });
  };
  // Line 1
  drawField(colA_x, colA_labelW, colA_valueX, colA_valueW, 'Party:', data.vendor.vendorName, { valueBold: true, valueSize: 11 });
  drawField(colB_x, colB_labelW, colB_valueX, colB_valueW, 'Date:', dateStr, { valueBold: true });
  y += 14;
  // Line 2
  drawField(colA_x, colA_labelW, colA_valueX, colA_valueW, 'Process:', data.processName, { valueBold: true, valueSize: 11 });
  drawField(colB_x, colB_labelW, colB_valueX, colB_valueW, 'Vchr No.:', data.batchNumber, { valueBold: true });
  y += 16;
  doc.fillColor(COLOR_TEXT);

  // -----------------------------------------------------------------------
  // 3. ITEMS table — columns adapt to:
  //    • Whether the PROCESS uses colour (Plating/Meena/Fitting/Mala/
  //      Sticking) — derived from whether any item has a colour set. If
  //      yes, show Colour column; otherwise skip it.
  //    • Pricing mode (weight slip → Wt/pc + Total Wt; piece slip → Price/pc).
  //    • Whether per-row Total Amount is known — added in BOTH modes when
  //      amount data is present so the slip has a real "Total" column for
  //      Subtotal/Tax/Grand Total to align under.
  //    Internal (receipt) mode uses the same columns as the matching issue
  //    slip — no separate "Colour Code" sub-column.
  // -----------------------------------------------------------------------
  const processUsesColour = data.items.some((it) => !!(it.color && it.color.trim()));
  const hasAmounts = data.items.some((it) => (it.amount ?? 0) > 0);
  const hasRates = data.items.some((it) => (it.price ?? 0) > 0);
  type Col = { label: string; width: number; align: 'left' | 'center' | 'right' };
  const cols: Col[] = [];
  // Widths re-tuned for A4 portrait (CONTENT_W ≈ 523). Worst case is still
  // weight + colour + rates + total = 10 columns; remaining width feeds
  // Remarks.
  if (weightMode) {
    cols.push({ label: 'Sr', width: 22, align: 'center' });
    // Colour widened (52 → 78) and Vendor Design Ref narrowed (100 → 74)
    // so multi-word colour names like "Matte High Gold" (~70pt at 9pt
    // Helvetica) sit on one line instead of wrapping into the next row.
    cols.push({ label: 'Vendor Design Ref', width: processUsesColour ? 74 : 124, align: 'left' });
    if (processUsesColour) cols.push({ label: 'Colour', width: 78, align: 'left' });
    cols.push({ label: 'Qty', width: 32, align: 'right' });
    cols.push({ label: 'Wt/pc', width: 42, align: 'right' });
    cols.push({ label: 'Total Wt', width: 54, align: 'right' });
    if (hasRates) {
      cols.push({ label: 'Rate /g', width: 48, align: 'right' });
      cols.push({ label: 'Rate /pc', width: 48, align: 'right' });
    }
    // Total bumped 64 → 82 so the TOTAL row's grand total ("Rs. 2,52,677.20")
    // fits on a single line without truncation at the typical 9pt font.
    if (hasAmounts) cols.push({ label: 'Total', width: 82, align: 'right' });
  } else {
    cols.push({ label: 'Sr', width: 22, align: 'center' });
    // Same Colour-widen rebalance for piece-priced slips: 66 → 92, ref 130 → 104.
    cols.push({ label: 'Vendor Design Ref', width: processUsesColour ? 104 : 170, align: 'left' });
    if (processUsesColour) cols.push({ label: 'Colour', width: 92, align: 'left' });
    cols.push({ label: 'Qty', width: 40, align: 'right' });
    if (hasRates) cols.push({ label: 'Rate /pc', width: 66, align: 'right' });
    if (hasAmounts) cols.push({ label: 'Total', width: 74, align: 'right' });
  }
  // Remarks fills whatever width is left.
  const usedW = cols.reduce((s, c) => s + c.width, 0);
  cols.push({ label: 'Remarks', width: Math.max(60, CONTENT_W - usedW), align: 'left' });

  const drawTableRow = (cells: string[], opts: { bold?: boolean; rowH?: number } = {}) => {
    const rowH = opts.rowH ?? 16;
    let x = LEFT;
    doc.fontSize(9).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(COLOR_TEXT);
    // Measurement-based manual truncation — PDFKit's `ellipsis` + lineBreak
    // combo still wraps borderline-fit strings into a second visible line
    // when the cell is right at the boundary, which then bleeds into the
    // next row. Measuring widthOfString and chopping until it fits leaves
    // a single line every time, regardless of cell width or font kerning.
    cells.forEach((c, i) => {
      const availW = cols[i].width - 6;
      let text = c ?? '';
      if (text && doc.widthOfString(text) > availW) {
        while (text.length > 1 && doc.widthOfString(text + '…') > availW) {
          text = text.slice(0, -1);
        }
        text = text + '…';
      }
      doc.text(text, x + 3, y + 4, { width: availW, align: cols[i].align, lineBreak: false });
      x += cols[i].width;
    });
    let bx = LEFT;
    cols.forEach((c) => {
      doc.rect(bx, y, c.width, rowH).strokeColor(COLOR_BORDER).stroke();
      bx += c.width;
    });
    y += rowH;
  };

  const drawItemsHeader = () => drawTableRow(cols.map((c) => c.label), { bold: true });
  drawItemsHeader();

  let totalQty = 0;
  let totalWeight = 0;
  let totalAmount = 0;
  // Vendor Design Ref fallback chain: the vendor's own design code (best),
  // then our internal item number (vendor may recognise from past orders),
  // then a dash. We do NOT fall back to the vendor's NAME — that's already
  // at the top of the slip and reading it twice in two adjacent cells is
  // just noise.
  const refOrItem = (it: any) =>
    (it.vendorDesignReference ?? '').trim()
    || (it.itemNumber ?? '').toString().trim()
    || '—';
  // Format a weight value for display — two decimals max, trailing zeros
  // stripped, AND snap-to-integer when the value is within ±0.02g of a
  // whole number. The snap covers a real recurring-decimal scenario:
  // operator types 1200g total for 36 pcs, system stores per-pc as
  // 33.333… (Decimal 12,3), then on forward / slip render we recompute
  // totalWeight = perPc × qty = 33.333 × 36 = 1199.988 — which the
  // old formatter printed as "1199.99" even though operator intent
  // was 1200. Same snap is applied to rupee amounts (money()) so the
  // line total reads "Rs. 780" instead of "Rs. 779.99".
  const NEAR_INTEGER_TOL = 0.02;
  const weightFmt = (n: number) => {
    if (n == null || isNaN(n)) return '—';
    const nearestInt = Math.round(n);
    if (Math.abs(n - nearestInt) < NEAR_INTEGER_TOL) return String(nearestInt);
    const r = Math.round(n * 100) / 100;
    return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/\.?0+$/, '');
  };

  // Resolve the cell content for a column LABEL — drives both per-item rows
  // and the in-table TOTAL row. Lets us add/remove columns (Colour, Total,
  // Wt/pc, Price/pc) without re-doing the row builders.
  // Format a bare rupee value WITHOUT the "Rs. " prefix — used inside the
  // narrow Rate columns so it doesn't overflow on narrow A5 slips. Same
  // ±0.02 snap as money() / weightFmt() so Rate /pc stays consistent with
  // Rate /g × Wt/pc (the silver-ERP per-gram pricing) when the upstream
  // weight has float noise.
  const inr = (n: number) => {
    const nearestInt = Math.round(n);
    if (Math.abs(n - nearestInt) < NEAR_INTEGER_TOL) {
      return nearestInt.toLocaleString('en-IN');
    }
    return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const cellFor = (label: string, it: VendorPdfData['items'][number], idx: number): string => {
    switch (label) {
      case 'Sr': return String(idx + 1);
      case 'Vendor Design Ref': return refOrItem(it);
      case 'Colour': return it.color ?? '—';
      case 'Qty': return String(it.quantity);
      case 'Wt/pc': return weightFmt(it.weight);
      case 'Total Wt': return weightFmt(it.totalWeight);
      case 'Rate /g':  return it.price != null ? inr(it.price) : '—';
      // Per-piece rate for weight slips = Wt/pc grams × Rate/g.
      // For piece-priced slips the price IS the per-piece rate.
      case 'Rate /pc': return it.price != null
        ? (weightMode ? inr(it.weight * it.price) : inr(it.price))
        : '—';
      case 'Total': return it.amount != null ? money(it.amount) : '—';
      case 'Remarks': {
        // Operator's own remarks ONLY. The QC bifurcation used to be
        // appended here too, but it's already itemised in full in the
        // dedicated "QC bifurcation — pcs not in the bill above" block
        // at the bottom of the receipt — duplicating it in the row
        // remarks just made the column noisy and the line wrap ugly.
        return it.remarks ?? '';
      }
      default: return '';
    }
  };
  data.items.forEach((it, idx) => {
    totalQty += it.quantity;
    totalWeight += it.totalWeight;
    totalAmount += it.amount ?? 0;
    ensureSpace(16, drawItemsHeader);
    const cells = cols.map((c) => cellFor(c.label, it, idx));
    drawTableRow(cells);

    // Per-item service sub-rows — fold the "Additional Services" block
    // INTO the items table so it stays one continuous costing table. Each
    // service draws as an indented row immediately under its parent
    // design, with only Vendor Design Ref / Qty / Rate /pc / Total cells
    // populated. Service amounts roll into totalAmount so Subtotal / GST /
    // Grand Total below reflect the full bill.
    const svcs = Array.isArray(it.services) ? it.services : [];
    for (const s of svcs) {
      const amt = s.costPerPc != null ? s.costPerPc * it.quantity : null;
      if (amt != null) totalAmount += amt;
      ensureSpace(14, drawItemsHeader);
      const svcCells = cols.map((c) => {
        switch (c.label) {
          case 'Sr': return '';
          case 'Vendor Design Ref': return `   ↳ Service: ${s.name}`;
          case 'Qty': return String(it.quantity);
          case 'Rate /pc': return s.costPerPc != null ? inr(s.costPerPc) : '—';
          case 'Total': return amt != null ? money(amt) : '—';
          default: return '';
        }
      });
      drawTableRow(svcCells, { rowH: 14 });
    }
  });

  // In-table TOTAL row — drop totals under their matching column.
  ensureSpace(18);
  const totalCells = cols.map((c) => {
    switch (c.label) {
      case 'Vendor Design Ref': return 'TOTAL';
      case 'Qty': return String(totalQty);
      case 'Total Wt': return weightFmt(totalWeight);
      case 'Total': return money(totalAmount);
      default: return '';
    }
  });
  drawTableRow(totalCells, { bold: true, rowH: 18 });

  // -----------------------------------------------------------------------
  // 4. SUBTOTAL / TAX / GRAND TOTAL — appended rows of the items table.
  // Value lands under the "Total" amount column when present (always now,
  // since hasAmounts adds it). Trailing Remarks column stays blank.
  // -----------------------------------------------------------------------
  const tax = data.tax ?? null;
  if (totalAmount > 0) {
    const rate = tax === 'GST' ? 0.03 : tax === 'URD' ? 0 : 0;
    const taxAmount = Math.round(totalAmount * rate * 100) / 100;
    const grand = Math.round((totalAmount + taxAmount) * 100) / 100;
    // Find the "money" column — the Total amount column if present, else
    // fall back to Total Wt for weight-only slips with no pricing.
    const valueColIdx = (() => {
      const ti = cols.findIndex((c) => c.label === 'Total');
      if (ti >= 0) return ti;
      const wi = cols.findIndex((c) => c.label === 'Total Wt');
      return wi >= 0 ? wi : cols.length - 2;
    })();
    const labelW = cols.slice(0, valueColIdx).reduce((s, c) => s + c.width, 0);
    const valueW = cols[valueColIdx].width;
    const trailingCols = cols.slice(valueColIdx + 1);
    const trailingW = trailingCols.reduce((s, c) => s + c.width, 0);

    const drawAppendedRow = (label: string, value: string, opts: { bold?: boolean; rowH?: number } = {}) => {
      const rowH = opts.rowH ?? 16;
      ensureSpace(rowH);
      doc.fillColor(COLOR_TEXT).fontSize(9).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica');
      doc.text(label, LEFT + 6, y + 4, { width: labelW - 12, align: 'right', lineBreak: false });
      doc.text(value, LEFT + labelW, y + 4, { width: valueW - 6, align: 'right', lineBreak: false });
      doc.rect(LEFT, y, labelW, rowH).strokeColor(COLOR_BORDER).stroke();
      doc.rect(LEFT + labelW, y, valueW, rowH).strokeColor(COLOR_BORDER).stroke();
      if (trailingW > 0) {
        doc.rect(LEFT + labelW + valueW, y, trailingW, rowH).strokeColor(COLOR_BORDER).stroke();
      }
      y += rowH;
    };
    drawAppendedRow('Subtotal', money(totalAmount));
    if (tax) {
      drawAppendedRow(tax === 'GST' ? 'GST (3%)' : 'URD (0% — un-registered)', money(taxAmount));
      drawAppendedRow('GRAND TOTAL', money(grand), { bold: true, rowH: 20 });
    }
  }
  y += 6;

  // -----------------------------------------------------------------------
  // ORDER DETAILS box — appears right under Grand Total. Lists each item's
  // Design No · Purpose · Qty so the karigar floor sees who the work is
  // for at a glance. Rendered only when at least one row carries an item
  // number OR a purpose (older slips without the field stay clean).
  // -----------------------------------------------------------------------
  const orderDetailRows = data.items.filter(
    (it) => (it.itemNumber && String(it.itemNumber).trim()) || (it.purpose && String(it.purpose).trim()),
  );
  // (Order-detail boxes were previously rendered here, ABOVE the
  // signature footer. Per the operator's spec they now render AFTER
  // the signature instead — see below the SIGNATURE FOOTER section.)

  // (The standalone "Additional Services" block was removed — services
  // now render as indented sub-rows under their parent design inside the
  // main items table, and their amounts roll into totalAmount so the
  // Subtotal / GST / Grand Total above already include the service bill.)

  // -----------------------------------------------------------------------
  // 5. MATERIAL RECONCILIATION — sticking only. Required vs With Party vs
  // Difference, matching the old ERP voucher layout. "With Party" = qty the
  // vendor already holds (issued - received - consumed across open vouchers);
  // populated upstream as material.issuedQty - any received/consumed. For now
  // we show "issued - deferred" as a simple proxy.
  // -----------------------------------------------------------------------
  const withMaterials = data.items.filter((it) => Array.isArray(it.materials) && it.materials!.length > 0);
  if (withMaterials.length) {
    ensureSpace(48);
    y += 6;
    doc.fillColor(COLOR_TEXT).font('Helvetica-Bold').fontSize(11)
      .text('Material Reconciliation', LEFT, y, { width: CONTENT_W, lineBreak: false });
    y += 16;

    const recCols = [
      { label: 'Material', width: 200, align: 'left' as const },
      { label: 'Code', width: 90, align: 'left' as const },
      { label: 'Required', width: 70, align: 'right' as const },
      { label: 'With Party', width: 75, align: 'right' as const },
      { label: 'Difference', width: CONTENT_W - 200 - 90 - 70 - 75, align: 'right' as const },
    ];
    const drawRecRow = (cells: string[], opts: { bold?: boolean } = {}) => {
      const rowH = 16;
      let x = LEFT;
      doc.fontSize(9).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(COLOR_TEXT);
      cells.forEach((c, i) => {
        doc.text(c, x + 3, y + 4, { width: recCols[i].width - 6, align: recCols[i].align, ellipsis: true, lineBreak: false });
        x += recCols[i].width;
      });
      let bx = LEFT;
      recCols.forEach((c) => {
        doc.rect(bx, y, c.width, rowH).strokeColor(COLOR_BORDER).stroke();
        bx += c.width;
      });
      y += rowH;
    };
    const drawRecHeader = () => drawRecRow(recCols.map((c) => c.label), { bold: true });
    drawRecHeader();

    // Aggregate materials across all sticking items (same variant rolls up).
    const agg = new Map<string, { name: string; code: string; unit: string | null; required: number; issued: number; deferred: number }>();
    for (const it of withMaterials) {
      for (const m of it.materials ?? []) {
        const key = m.variantCode ?? m.name;
        const cur = agg.get(key) ?? {
          name: m.name,
          code: m.variantCode ?? '—',
          unit: m.unit ?? null,
          required: 0, issued: 0, deferred: 0,
        };
        cur.required += m.required;
        cur.issued += m.issuedQty ?? 0;
        cur.deferred += m.deferredQty ?? 0;
        agg.set(key, cur);
      }
    }
    for (const m of agg.values()) {
      ensureSpace(16, drawRecHeader);
      const withParty = m.issued; // pcs the vendor holds (issued, not yet returned/consumed)
      const diff = withParty - m.required; // positive = excess at vendor; negative = need to send
      const unit = m.unit ? ' ' + m.unit : '';
      drawRecRow([
        m.name,
        m.code,
        `${m.required}${unit}`,
        `${withParty}${unit}`,
        `${diff >= 0 ? '+' : ''}${diff}${unit}`,
      ]);
    }
    y += 6;
  }

  // -----------------------------------------------------------------------
  // 5b. QC NOTES (receipt slips only). When the operator split returned
  // pcs into repair / rejected buckets, surface a clear summary block
  // BEFORE the signature footer so the karigar and the books reconcile
  // at a glance:
  //   • Repair pcs — vendor still holds them; NOT billed on this receipt
  //   • Rejected NO_PAY — operator refused; vendor absorbs the cost
  //   • Rejected ADJUSTED — operator paid a negotiated reduced amount
  //   • Rejected FULL_PAY — paid in full (already in the bill above)
  // Skipped entirely when every row is purely accepted.
  // -----------------------------------------------------------------------
  if (data.docType === 'Receipt') {
    const heldRows: { label: string; pcs: number; note: string }[] = [];
    for (const it of data.items) {
      const qc = it.qc;
      if (!qc) continue;
      const tag = refOrItem(it);
      if (qc.repair > 0) {
        heldRows.push({
          label: `#${tag}${it.color ? ' · ' + it.color : ''}`,
          pcs: qc.repair,
          note: 'repair — vendor will return, billed on that receipt',
        });
      }
      if (qc.rejected > 0) {
        const m = qc.rejectMode;
        const note = m === 'FULL_PAY'
          ? 'rejected (FULL PAY — already in bill)'
          : m === 'ADJUSTED'
            ? `rejected (ADJUSTED — ₹${qc.rejectAdjustment} added to bill)`
            : 'rejected (NO PAY — vendor absorbs)';
        heldRows.push({
          label: `#${tag}${it.color ? ' · ' + it.color : ''}`,
          pcs: qc.rejected,
          note,
        });
      }
    }
    if (heldRows.length) {
      ensureSpace(16 + heldRows.length * 12);
      y += 8;
      doc.fontSize(8).font('Helvetica-Bold').fillColor(COLOR_LABEL)
        .text('QC bifurcation — pcs not in the bill above', LEFT, y, { width: CONTENT_W, lineBreak: false });
      y += 12;
      doc.fontSize(8.5).font('Helvetica').fillColor(COLOR_TEXT);
      for (const r of heldRows) {
        doc.text(`• ${r.label}: ${r.pcs} pc${r.pcs === 1 ? '' : 's'} — ${r.note}`, LEFT + 4, y, {
          width: CONTENT_W - 8, lineBreak: false,
        });
        y += 11;
      }
    }
  }

  // -----------------------------------------------------------------------
  // 6. SIGNATURE FOOTER — bottom of the slip. Plain black signature lines.
  // -----------------------------------------------------------------------
  ensureSpace(44);
  y += 16;
  const sigW = (CONTENT_W - 24) / 2;
  doc.strokeColor(COLOR_BORDER).lineWidth(0.6);
  doc.moveTo(LEFT, y).lineTo(LEFT + sigW, y).stroke();
  doc.moveTo(LEFT + sigW + 24, y).lineTo(RIGHT, y).stroke();
  doc.fontSize(9).fillColor(COLOR_TEXT).font('Helvetica-Bold');
  doc.text('Authorised Signature', LEFT, y + 4, { width: sigW, lineBreak: false });
  doc.text(
    data.docType === 'Receipt'
      ? `Received by ${data.vendor.vendorName}`
      : data.docType === 'Repair'
        ? `Acknowledged by ${data.vendor.vendorName} — will repair at no charge`
        : `Acknowledged by ${data.vendor.vendorName}`,
    LEFT + sigW + 24,
    y + 4,
    { width: sigW, lineBreak: false },
  );

  // -----------------------------------------------------------------------
  // 6b. ORDER DETAILS — grid of boxed cards BELOW the signature footer.
  // No heading text — just the boxes. Up to 4 per row so a slip with
  // many lines reads at a glance. DESIGN NO. value is rendered bold +
  // ~15pt so it's the dominant element of each card; PURPOSE and QTY
  // sit smaller beneath. Hidden entirely when no item carries a
  // purpose or item number (legacy slips stay clean).
  //
  // ISSUE SLIPS ONLY — receipt slips don't carry order details (the
  // operator is recording what came BACK, not who the work is for; the
  // receipt slip is meant to be a clean tally). Repair slips also skip
  // it for the same reason. Per operator: "this design box will be only
  // in issue slip and not in receipt slip".
  // -----------------------------------------------------------------------
  const isIssueSlip = data.docType !== 'Receipt' && data.docType !== 'Repair';
  if (isIssueSlip && orderDetailRows.length) {
    // Consolidate slip lines that share (itemNumber × purpose). Colour-
    // step slips often have ONE line per colour for the same design
    // (e.g. design 3705 with Ruby Green qty 12 + PAL White qty 24).
    // Instead of printing a separate card per colour we group by
    // design+purpose, sum qty, and break out a COLORS line inside the
    // card that lists "Ruby Green (12), PAL White (24)". One card per
    // physical design = exactly what the karigar floor needs.
    //
    // Card layout per operator:
    //   DESIGN NO       — vendor reference (their own item code) or em-dash
    //   Item No (ours)  — our internal item number, always shown
    //   BATCH NO        — batch number (with optional slip suffix)
    //   PURPOSE         — customer / Stock / Sample / etc, wraps if long
    //   COLORS          — comma-separated per-colour qty, wraps if long
    //   QTY             — consolidated total across this design's colours
    // Two separate rows for design number vs item number so the karigar
    // can tell at a glance whose number they're looking at.
    type CardRow = {
      itemNumber: string | null;
      designCode: string | null;
      salesItemNumber: string | null;
      vendorDesignReference: string | null;
      purpose: string | null;
      quantity: number;
      colours: { color: string; qty: number }[];
      // Stage id captured from the FIRST source row of the group — used
      // to encode a scan URL on the card's QR code so the karigar's
      // phone can land on the right design's receive flow.
      stageId: number | null;
    };
    const cardMap = new Map<string, CardRow>();
    for (const it of orderDetailRows) {
      const key = `${it.itemNumber ?? ''}::${it.purpose ?? ''}::${it.vendorDesignReference ?? ''}`;
      const cur: CardRow = cardMap.get(key) ?? {
        itemNumber: it.itemNumber ?? null,
        designCode: (it as any).designCode ?? it.itemNumber ?? null,
        salesItemNumber: (it as any).salesItemNumber ?? null,
        vendorDesignReference: it.vendorDesignReference ?? null,
        purpose: it.purpose ?? null,
        quantity: 0,
        colours: [],
        stageId: it.stageId ?? null,
      };
      cur.quantity += it.quantity;
      const colour = (it.color ?? '').trim();
      if (colour) cur.colours.push({ color: colour, qty: it.quantity });
      cardMap.set(key, cur);
    }
    const cards = Array.from(cardMap.values());

    // Per-card QR codes — encoded URL points the karigar's phone at the
    // frontend's scan page, which validates and offers a one-tap Accept
    // Receipt button that opens the existing ReceiveForm pre-scoped to
    // (batchId × vendorId). Pre-generated in parallel BEFORE drawing so
    // doc.image() calls below stay synchronous. Failures fall through to
    // a null buffer; drawCard skips the QR slot rather than crashing the
    // slip.
    //
    // URL precedence:
    //   1. FRONTEND_URL (explicit env var — set this on prod to be safe)
    //   2. First origin of CORS_ORIGIN — that var can be comma-separated
    //      to allow multiple origins (e.g. apex + www variant). Taking
    //      the whole string raw would encode a literal comma into the
    //      QR (real bug we hit: "https://caliberset.com,https://www…"
    //      — unscannable). First entry wins.
    //   3. http://localhost:3000 for dev.
    const frontendBase = (() => {
      const explicit = process.env.FRONTEND_URL?.trim();
      if (explicit) return explicit.replace(/\/+$/, '');
      const corsList = process.env.CORS_ORIGIN?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
      const first = corsList[0];
      if (first) return first.replace(/\/+$/, '');
      return 'http://localhost:3000';
    })();
    const qrFor = async (card: CardRow): Promise<Buffer | null> => {
      if (!data.batchId || !data.vendorId) return null;
      const params = new URLSearchParams();
      params.set('b', String(data.batchId));
      params.set('v', String(data.vendorId));
      if (card.stageId) params.set('s', String(card.stageId));
      if (card.itemNumber) params.set('i', String(card.itemNumber));
      const url = `${frontendBase}/casting/scan?${params.toString()}`;
      try {
        return await QRCode.toBuffer(url, {
          margin: 1,
          errorCorrectionLevel: 'M',
          // 320px source — sized down to ~60pt on render, still crisp.
          width: 320,
          color: { dark: '#000000', light: '#FFFFFF' },
        });
      } catch {
        return null;
      }
    };
    const qrBuffers: (Buffer | null)[] = await Promise.all(cards.map(qrFor));

    ensureSpace(70);
    y += 18; // breathing space below the signature lines

    const boxesPerRow = 4;
    const gap = 8;
    const boxW = Math.floor((CONTENT_W - gap * (boxesPerRow - 1)) / boxesPerRow);
    const boxPad = 5;
    const labelW = 60;
    const designLineH = 19; // taller for the 15pt design no value
    const otherLineH = 12;
    const valueW = boxW - boxPad * 2 - labelW;

    const fmtColours = (cs: CardRow['colours']) =>
      cs.length === 0
        ? '—'
        : cs.map((c) => `${c.color} (${c.qty})`).join(', ');

    // Pre-measure every wrapping value's height so PURPOSE, COLORS and
    // BATCH NO all get the room they need. Even though batch numbers
    // are usually short ("B0042"), the issue-slip flow appends a suffix
    // ("B0007 · ISS-94") and PDFKit's `lineBreak: false` quietly fails
    // to clip when the value runs wider than the cell — so the second
    // line bled into PURPOSE. Same dynamic-height treatment as PURPOSE
    // / COLORS applied to BATCH NO too.
    doc.fontSize(9).font('Helvetica');
    const measurePurposeH = (card: CardRow) =>
      Math.max(
        otherLineH,
        doc.heightOfString(String(card.purpose ?? '—'), { width: valueW }) + 2,
      );
    const measureColoursH = (card: CardRow) =>
      Math.max(
        otherLineH,
        doc.heightOfString(fmtColours(card.colours), { width: valueW }) + 2,
      );
    const measureBatchH = () =>
      Math.max(
        otherLineH,
        doc.heightOfString(String(data.batchNumber ?? '—'), { width: valueW }) + 2,
      );

    // QR code dimensions — 60pt square is large enough to scan from a
    // printed slip with a regular phone camera while staying within a
    // 124pt-wide card. Padding below QTY keeps the QR visually separate
    // from the data block above it.
    const qrSize = 60;
    const qrGap = 6;
    const drawCard = (x: number, card: CardRow, qr: Buffer | null, batchH: number, purposeH: number, coloursH: number, boxH: number) => {
      doc.rect(x, y, boxW, boxH).strokeColor(COLOR_BORDER).lineWidth(0.6).stroke();

      // Row 1 — DESIGN NO. The internal design code (auto from CAD vendor
      // short: TVM-001, ARYAN-007). Karigar-facing identity used end-to-end.
      // Larger / bold than the others — it's the dominant identifier on the card.
      const designValue = (card.designCode ?? card.itemNumber ?? '').trim() || '—';
      const dFontSize = designValue.length > 10 ? 12 : 15;
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(COLOR_TEXT)
        .text('DESIGN NO', x + boxPad, y + boxPad + 5, { width: labelW, lineBreak: false });
      doc.fontSize(dFontSize).font('Helvetica-Bold').fillColor(COLOR_TEXT)
        .text(designValue, x + boxPad + labelW, y + boxPad, {
          width: valueW, lineBreak: false, ellipsis: true,
        });

      // Row 2 — ITEM NO (sales SKU, ABN-XXXX). Allocated post-Packing; em-
      // dash for in-progress designs that haven't been packed yet.
      const itemY = y + boxPad + designLineH;
      const itemValue = (card.salesItemNumber ?? '').toString().trim() || '—';
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(COLOR_TEXT)
        .text('ITEM NO', x + boxPad, itemY + 2, { width: labelW, lineBreak: false });
      doc.fontSize(9).font('Helvetica').fillColor(COLOR_TEXT)
        .text(itemValue, x + boxPad + labelW, itemY + 1, {
          width: valueW, lineBreak: false, ellipsis: true,
        });

      // Row 3 — BATCH NO. Wraps inside its own measured band so the
      // slip suffix ("B0036 · ISS-3371") doesn't bleed onto PURPOSE.
      const batchY = itemY + otherLineH;
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(COLOR_TEXT)
        .text('BATCH NO', x + boxPad, batchY + 2, { width: labelW, lineBreak: false });
      doc.fontSize(9).font('Helvetica').fillColor(COLOR_TEXT)
        .text(String(data.batchNumber ?? '—'), x + boxPad + labelW, batchY + 1, {
          width: valueW, height: batchH,
        });

      // Row 4 — PURPOSE. Wraps inside its own measured band so multi-word
      // values (e.g. "MSB - Bibhasbhai") don't crash into COLORS.
      const purposeY = batchY + batchH;
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(COLOR_TEXT)
        .text('PURPOSE', x + boxPad, purposeY + 2, { width: labelW, lineBreak: false });
      doc.fontSize(9).font('Helvetica').fillColor(COLOR_TEXT)
        .text(String(card.purpose ?? '—'), x + boxPad + labelW, purposeY + 1, {
          width: valueW, height: purposeH,
        });

      // Row 5 — COLORS. Comma-separated list with per-colour qty in
      // brackets, wrapping freely inside coloursH so multi-colour cards
      // don't collide with the QTY row below.
      const coloursY = purposeY + purposeH;
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(COLOR_TEXT)
        .text('COLORS', x + boxPad, coloursY + 2, { width: labelW, lineBreak: false });
      doc.fontSize(9).font('Helvetica').fillColor(COLOR_TEXT)
        .text(fmtColours(card.colours), x + boxPad + labelW, coloursY + 1, {
          width: valueW, height: coloursH,
        });

      // Row 6 — QTY (consolidated total across this design's colours).
      const qtyY = coloursY + coloursH;
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(COLOR_TEXT)
        .text('QTY', x + boxPad, qtyY + 2, { width: labelW, lineBreak: false });
      doc.fontSize(9).font('Helvetica').fillColor(COLOR_TEXT)
        .text(String(card.quantity), x + boxPad + labelW, qtyY + 1, {
          width: valueW, lineBreak: false,
        });

      // Row 7 — QR code, centred horizontally. Scanning opens the scan
      // page on the operator's phone with batchId + vendorId pre-filled;
      // they confirm and the existing ReceiveForm opens scoped to the
      // right lot. Skipped when QR couldn't be generated (e.g. missing
      // batchId / vendorId / network on the qrcode lib's side).
      if (qr) {
        const qrY = qtyY + otherLineH + qrGap;
        const qrX = x + (boxW - qrSize) / 2;
        try {
          doc.image(qr, qrX, qrY, { width: qrSize, height: qrSize });
        } catch {
          /* ignore — slip still renders without the QR */
        }
        // Small caption under the QR so the karigar knows what it's for
        // (some print quality / camera combinations need a hint).
        doc.fontSize(6).font('Helvetica').fillColor(COLOR_LABEL)
          .text('Scan to receive', x + boxPad, qrY + qrSize + 1, {
            width: boxW - boxPad * 2, align: 'center', lineBreak: false,
          });
      }
    };

    // Whether THIS slip can show QRs — needs ids on the data and at
    // least one card got a buffer back. Drives the per-card height
    // extension and the "Scan to receive" caption block.
    const anyQR = qrBuffers.some((b) => b != null);
    for (let i = 0; i < cards.length; i += boxesPerRow) {
      const rowItems = cards.slice(i, i + boxesPerRow);
      const rowQrs = qrBuffers.slice(i, i + boxesPerRow);
      // All cards in a row share the same height = max across the row, so
      // borders align cleanly. Computed per row, not once for the whole
      // grid, so a single multi-line card doesn't bloat the rest of the
      // slip's footprint. BATCH NO is constant across the slip but we
      // still funnel it through the same per-row machinery for symmetry.
      const rowBatchH = measureBatchH();
      const rowPurposeH = Math.max(...rowItems.map(measurePurposeH));
      const rowColoursH = Math.max(...rowItems.map(measureColoursH));
      // ~8pt below the QR for the "Scan to receive" caption.
      const qrBlockH = anyQR ? (qrGap + qrSize + 8) : 0;
      const rowBoxH = designLineH
        + otherLineH /* Item No (ours) */
        + rowBatchH
        + rowPurposeH
        + rowColoursH
        + otherLineH /* QTY */
        + qrBlockH
        + boxPad * 2;
      ensureSpace(rowBoxH + gap);
      let x = LEFT;
      rowItems.forEach((card, j) => {
        drawCard(x, card, rowQrs[j] ?? null, rowBatchH, rowPurposeH, rowColoursH, rowBoxH);
        x += boxW + gap;
      });
      y += rowBoxH + gap;
    }
  }

  // -----------------------------------------------------------------------
  // 7. PAGE FOOTER — page numbers only (no company contact bloat).
  // -----------------------------------------------------------------------
  const range = doc.bufferedPageRange();
  const footerY = PAGE_H - 18;
  for (let pi = range.start; pi < range.start + range.count; pi++) {
    doc.switchToPage(pi);
    doc.fontSize(8).fillColor(COLOR_LABEL).font('Helvetica')
      .text(
        `Page ${pi - range.start + 1} of ${range.count}`,
        LEFT, footerY, { width: CONTENT_W, align: 'right', lineBreak: false },
      );
  }

  doc.end();
}

/**
 * Render a single vendor PDF into a Buffer instead of streaming to an
 * HTTP response. Reuses streamVendorPdf via a PassThrough + setHeader
 * shim so we don't have to refactor 600 lines of render logic. Used by
 * the bulk-download ZIP endpoint — collects each slip as a buffer and
 * appends to the archive in order.
 *
 * Returns a Promise<Buffer> that resolves with the complete PDF bytes
 * once PDFKit ends the document.
 */
export function renderVendorPdfToBuffer(data: VendorPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = new PassThrough();
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    // Fake res that satisfies the streamVendorPdf contract: setHeader is
    // a no-op (we're not sending HTTP headers, we just want bytes), and
    // the rest of the Writable surface delegates to the PassThrough.
    const fakeRes = Object.assign(stream, {
      setHeader: () => {},
    }) as unknown as Response;
    // streamVendorPdf is async now (QR generation lives inside) — kick
    // off the promise and let the underlying PassThrough's 'end' event
    // resolve the outer promise once doc.end() flushes. Errors before
    // doc.end() runs propagate via .catch().
    streamVendorPdf(fakeRes, data).catch(reject);
  });
}
