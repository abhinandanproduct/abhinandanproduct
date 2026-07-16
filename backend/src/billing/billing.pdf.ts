import PDFDocument from 'pdfkit';
import { Response } from 'express';

const COMPANY = {
  name: 'SHREE ABHINANDAN PRODUCT',
  tagline: 'Jewellery made with emotions. · 92.5 Silver Manufacturing',
  address: '210 Ashish Udyog Bhawan, Liberty Garden, Malad West, opp SNDT Mahila College, Mumbai, Maharashtra 400064, India',
  gstin: '27AAMPG4486C1ZN',
  phone: '8976302848',
  email: 'smitgandhi251@gmail.com',
  state: 'Maharashtra',
  stateCode: '27',
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
// PDFKit's built-in Helvetica has no glyph for U+20B9 (Indian Rupee sign)
// so it falls back to a superscript "1"-like glyph. Use the ASCII-safe
// "Rs." prefix everywhere so amounts read cleanly in the exported PDF.
const inr = (n: number) =>
  'Rs. ' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface InvoiceData {
  id: number;
  invoiceNumber: string;
  type: 'QUOTE' | 'SALES_ORDER' | 'TAX_INVOICE' | 'DELIVERY_CHALLAN' | 'CREDIT_NOTE' | 'ESTIMATE' | 'TEMP_INVOICE';
  status: string;
  invoiceDate: Date;
  dueDate?: Date | null;
  billToName: string;
  billToAddress: string | null;
  billToGstin: string | null;
  placeOfSupply: string | null;
  silverRatePerG: any;
  makingRatePerG: any;
  gstPercent: any;
  isInterState: boolean;
  subtotal: any;
  cgstAmount: any;
  sgstAmount: any;
  igstAmount: any;
  roundOff: any;
  totalAmount: any;
  paidAmount: any;
  balanceAmount: any;
  totalWeightG?: any;
  purpose?: string | null;
  notes: string | null;
  customer?: {
    customerName: string;
    phone: string | null;
    email?: string | null;
    gstin?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    city?: string | null;
    state?: string | null;
    stateCode?: string | null;
    pincode?: string | null;
  };
  items: Array<{
    itemId?: number | null;
    description: string;
    itemNumber: string | null;
    hsnCode: string | null;
    quantity: number;
    weightG: any;
    // Snapshot of the operator-typed total weight — when set, use this
    // directly instead of computing weightG × quantity (which can drift
    // by 0.02+ due to per-piece rounding at 3 decimals).
    totalWeightG?: any;
    silverRatePerG: any;
    makingRatePerG: any;
    silverAmount: any;
    makingAmount: any;
    lineAmount: any;
    // Detailed breakdown — all optional.
    lessWeightG?: any; netWeightG?: any; purity?: any; fineWeightG?: any;
    wastagePercent?: any; wastageFineG?: any;
    boxWeightG?: any; bagWeightG?: any; tagWeightG?: any; padWeightG?: any;
    totalGrossWeightG?: any;
    size?: string | null;
    category?: string | null;
    plating?: string | null;
    laborOn?: string | null;
    laborRateWithTax?: any;
    laborRateWithoutTax?: any;
    laborAmount?: any;
    extraAmount?: any;
    extraDescription?: string | null;
    fineAmount?: any;
    packetNo?: number | null;
    productionOrderRef?: string | null;
    boxRef?: string | null;
    barcode?: string | null;
  }>;
}

export function streamInvoicePdf(res: Response, inv: InvoiceData) {
  // Page orientation per doc type:
  //   DELIVERY_CHALLAN → portrait (dedicated compact renderer)
  //   TAX_INVOICE / TEMP_INVOICE → portrait (single consolidated line)
  //   ESTIMATE / QUOTE / SALES_ORDER / CREDIT_NOTE → landscape
  //     (multi-column per-design breakdown needs the wider page)
  const isChallan = inv.type === 'DELIVERY_CHALLAN';
  const isPortraitInvoice =
    inv.type === 'TAX_INVOICE' || inv.type === 'TEMP_INVOICE';
  const doc = new PDFDocument({
    size: 'A4',
    margin: 24,
    layout: isChallan || isPortraitInvoice ? 'portrait' : 'landscape',
  });
  doc.pipe(res);
  // Delivery Challan = goods-movement doc, totals-by-weight, no rates needed.
  // Renders against a dedicated layout that matches Shree Abhinandan
  // Product's physical challan book (DELIVERY CHALLAN banner + From/To
  // boxes + Quantity-by-weight | Particulars | Rate | Amount table +
  // signed-receipt footer). All other types fall through to the regular
  // invoice layout in `draw()`.
  if (inv.type === 'DELIVERY_CHALLAN') {
    drawChallan(doc, inv);
  } else {
    draw(doc, inv);
  }
  doc.end();
}

// ─────────────────────────────────────────────────────────────────────────
// Indian-notation amount-in-words — used for the "Total In Words" line
// under the totals box on tax invoices. Handles up to crore accurately.
// Format matches the Zoho reference: "Indian Rupee One Lakh …-… Only"
// (hyphenated compound tens like "Seventy-Nine").
// ─────────────────────────────────────────────────────────────────────────
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function twoDigit(n: number): string {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o ? `${TENS[t]}-${ONES[o]}` : TENS[t];
}
function threeDigit(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest) parts.push(twoDigit(rest));
  return parts.join(' ');
}
function amountInWords(rupees: number): string {
  const n = Math.round(Math.abs(rupees));
  if (n === 0) return 'Indian Rupee Zero Only';
  const parts: string[] = [];
  const crore = Math.floor(n / 10000000);
  const lakh  = Math.floor((n % 10000000) / 100000);
  const thou  = Math.floor((n % 100000) / 1000);
  const rest  = n % 1000;
  if (crore) parts.push(`${twoDigit(crore)} Crore`);
  if (lakh)  parts.push(`${twoDigit(lakh)} Lakh`);
  if (thou)  parts.push(`${twoDigit(thou)} Thousand`);
  if (rest)  parts.push(threeDigit(rest));
  return `Indian Rupee ${parts.join(' ')} Only`;
}

function draw(doc: PDFKit.PDFDocument, inv: InvoiceData) {
  // Page geometry read from the created page so we honour whichever
  // orientation streamInvoicePdf picked (portrait for TAX/TEMP,
  // landscape for ESTIMATE/QUOTE/SO/CN). Portrait A4 = 595×842pt,
  // landscape = 842×595pt.
  const M = 24;
  const W = doc.page.width;
  const H = doc.page.height;
  const isPortrait = H > W;
  const innerW = W - 2 * M;
  // Consolidated portrait invoices (TAX/TEMP) collapse Silver / Making /
  // Addl Chrg into the S+M+A subtotal so a coherent column set fits at
  // 547pt. The full landscape layout keeps the per-component breakdown.
  const compactMoneyCols = isPortrait;
  const title =
    inv.type === 'TAX_INVOICE'      ? 'TAX INVOICE' :
    // TEMP_INVOICE prints identically to a real tax invoice by design —
    // the "temp" marker lives only in the software (list badge) so the
    // customer sees a normal bill.
    inv.type === 'TEMP_INVOICE'     ? 'TAX INVOICE' :
    inv.type === 'QUOTE'            ? 'ESTIMATE' :
    inv.type === 'ESTIMATE'         ? 'ESTIMATE' :
    inv.type === 'SALES_ORDER'      ? 'SALES ORDER' :
    inv.type === 'CREDIT_NOTE'      ? 'CREDIT NOTE' :
    inv.type === 'DELIVERY_CHALLAN' ? 'DELIVERY CHALLAN' :
                                      'INVOICE';

  // ── COMPANY HEADER — corporate-style, all black, compact ─────────
  // Portrait A4 is only 547pt wide — "SHREE ABHINANDAN PRODUCT" at 18pt
  // bold overflows innerW/2 there. Scale the company name font down and
  // widen its allocation for portrait; landscape keeps the roomy 18pt.
  const BLACK = '#000000';
  const nameFontSize = isPortrait ? 15 : 18;
  const nameW = isPortrait ? innerW * 0.62 : innerW / 2;
  const addrLineChars = isPortrait ? 55 : 80;
  const addrW = nameW - 10;
  let y = M;
  doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(nameFontSize)
     .text(COMPANY.name, M, y, { width: nameW, lineBreak: false });
  // Trading-name subtitle — the company operates under "Pratik Product"
  // day-to-day; print it just below the legal name so vendors can match
  // the invoice to the name they know us by.
  const subY = y + nameFontSize + 2;
  doc.font('Helvetica').fontSize(10).fillColor(BLACK)
     .text('(Pratik Product)', M, subY, { width: nameW, lineBreak: false });
  const addrY = subY + 14;
  doc.font('Helvetica').fontSize(10).fillColor(BLACK)
     .text(COMPANY.address, M, addrY, { width: addrW });
  const addrLines = Math.min(3, Math.ceil(COMPANY.address.length / addrLineChars));
  let cy = addrY + addrLines * 11 + 4;
  doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(10)
     .text(`GSTIN ${COMPANY.gstin}`, M, cy, { lineBreak: false });
  cy += 13;
  doc.font('Helvetica').fontSize(10).fillColor(BLACK)
     .text(`Ph: ${COMPANY.phone}  ·  ${COMPANY.email}`, M, cy, { lineBreak: false });
  cy += 12;
  doc.y = cy;

  // Title (right, black). Smaller size + subtitle "Packing Slip" below
  // for estimates so the doc reads as an estimate cum packing slip.
  const isEstimateLike = inv.type === 'QUOTE' || inv.type === 'ESTIMATE';
  const titleFontSize = isPortrait ? 18 : 20;
  doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(titleFontSize)
     .text(title, M, y + 4, { width: innerW, align: 'right', lineBreak: false });
  if (isEstimateLike) {
    doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(11)
       .text('Packing Slip', M, y + 28, { width: innerW, align: 'right', lineBreak: false });
  }

  // ── METADATA GRID — # / Invoice Date / Terms / Due Date · Place OS ──
  y = Math.max(cy + 8, M + 88);
  const metaLabelW = 90;
  const metaValueW = 160;
  const metaLine = 13;
  // Date label mirrors the doc's real-world name — an estimate is dated
  // by "Estimate Date", a challan by "Delivery Date". Keeping them the
  // same "Invoice Date" as tax invoices confused customers.
  const dateLabel =
    inv.type === 'QUOTE' || inv.type === 'ESTIMATE' ? 'Estimate Date'
      : inv.type === 'DELIVERY_CHALLAN'             ? 'Delivery Date'
      :                                               'Invoice Date';
  const metaRows: Array<[string, string]> = [
    ['#', `: ${inv.invoiceNumber}`],
    [dateLabel, `: ${fmtDateSlash(inv.invoiceDate)}`],
    ['Terms', ': Due on Receipt'],
    ['Due Date', `: ${fmtDateSlash(inv.dueDate ?? inv.invoiceDate)}`],
  ];
  const RED = '#c62828';
  doc.fontSize(10);
  for (let i = 0; i < metaRows.length; i++) {
    const [k, v] = metaRows[i];
    doc.font('Helvetica-Bold').fillColor(RED).text(k, M, y + i * metaLine, { lineBreak: false });
    doc.font('Helvetica').fillColor(RED).text(v, M + metaLabelW, y + i * metaLine, { width: metaValueW, lineBreak: false });
  }
  // Place Of Supply (right side, highlighted band — soft yellow accent)
  const posX = M + innerW / 2 + 40;
  doc.rect(posX, y - 2, 115, 18).fill('#fef3c7');
  doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(10)
     .text('Place Of Supply', posX + 6, y + 3, { width: 110, lineBreak: false });
  doc.font('Helvetica-Bold').fillColor(BLACK).fontSize(10)
     .text(`: ${inv.placeOfSupply ?? '—'}`, posX + 120, y + 3, { width: innerW - (posX + 120 - M) - 4, lineBreak: false });

  // ── BILL TO / SHIP TO SIDE-BY-SIDE ────────────────────────────────
  // Tight gap between metadata and boxes to reclaim vertical space.
  y += metaRows.length * metaLine + 6;
  const boxGap = 12;
  const boxW = (innerW - boxGap) / 2;
  const box2X = M + boxW + boxGap;
  // Header bar (dark solid — corporate feel)
  doc.rect(M, y, boxW, 20).fillAndStroke(BLACK, BLACK);
  doc.rect(box2X, y, boxW, 20).fillAndStroke(BLACK, BLACK);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11)
     .text('BILL TO', M, y + 5, { width: boxW, align: 'center', lineBreak: false })
     .text('SHIP TO', box2X, y + 5, { width: boxW, align: 'center', lineBreak: false });
  y += 22;

  // Build the address from the FRESH customer record.
  const c = (inv.customer ?? {}) as NonNullable<InvoiceData['customer']>;
  const addressLines: string[] = [
    ...(c.addressLine1 ? [c.addressLine1] : []),
    ...(c.addressLine2 ? [c.addressLine2] : []),
    [c.city, c.state, c.pincode].filter(Boolean).join(', '),
  ].filter((s) => s && s.trim().length > 0);
  const gstin = c.gstin ?? inv.billToGstin ?? null;

  // Reserved height sized to the ACTUAL address lines — no extra padding
  // for imaginary lines that never render.
  const boxContentH = 14 + addressLines.length * 11 + 18;
  doc.strokeColor(BLACK).lineWidth(0.75)
     .rect(M, y - 4, boxW, boxContentH).stroke()
     .rect(box2X, y - 4, boxW, boxContentH).stroke();

  const padX = 10;
  const drawAddress = (boxX: number) => {
    doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(11)
       .text(inv.billToName, boxX + padX, y, { width: boxW - padX * 2, align: 'left', lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor(BLACK)
       .text(addressLines.join('\n') || (inv.billToAddress ?? ''), boxX + padX, y + 14, { width: boxW - padX * 2, align: 'left' });
    if (gstin) {
      doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(9)
         .text(`GSTIN ${gstin}`, boxX + padX, y + 14 + addressLines.length * 11 + 2, { width: boxW - padX * 2, align: 'left', lineBreak: false });
    }
  };
  drawAddress(M);
  drawAddress(box2X);
  y += boxContentH;
  doc.y = y;

  // Subject block removed — separate Silver/Making columns per line
  // carry that information directly.

  // ── ITEMS TABLE — with nested GST-group column ────────────────────
  // Interstate → single IGST group (2 nested: % + Amt).
  // Intra-state → CGST + SGST groups (4 nested: %, Amt, %, Amt).
  const gstPct = Number(inv.gstPercent);
  const halfPct = gstPct / 2;
  const showTaxCols = inv.type !== 'DELIVERY_CHALLAN' && gstPct > 0;
  const isInter = inv.isInterState;
  // Portrait invoices (TAX/TEMP) drop the inline GST band from the table
  // per operator spec — Silver /g + Making /g rates take those slots,
  // and the GST breakdown lives only in the totals-box below the table.
  // Landscape (Estimate) keeps the full inline GST columns.
  const showTaxInTable = showTaxCols && !compactMoneyCols;

  // Landscape A4 innerW ≈ 793. Expanded columns per operator's spec:
  //   # · Item · HSN · Qty · Wt/pc · Gross · Less · Net · Fine · Purity
  //   · Wastage · Silver · Making · S+M · [GST cols] · Amount
  // Tax cols swap between interstate (2 nested) and intra-state (4 nested).
  // Landscape A4 innerW ≈ 794. Column widths sum exactly to innerW so
  // there's no empty strip after the Amount column. 10pt body font is
  // comfortable for all values; header labels stay at 8pt so long labels
  // fit their cells without wrap.
  // Column set updated per operator spec:
  //   • Purity + Wastage columns dropped (info lives on the item master).
  //   • Additional Charges (Addl Chrg) inserted AFTER Making — per-piece rate.
  //   • S + M renamed to S + M + A (silver + making + additional).
  const cols: Array<{ label: string; w: number; align: 'left' | 'right' | 'center' }> =
    showTaxCols
      ? isInter
        ? compactMoneyCols
          ? [
              // Portrait tax invoice (8 cols · 547pt) — same for interstate
              // and intra-state. GST columns dropped per operator spec:
              // Silver /g + Making /g rate columns fill those slots, and
              // the GST breakdown lives only in the totals-box below.
              // Widths sized for CRORE-scale totals so future big-ticket
              // bills print cleanly:
              //   Addl total "Rs. 99,99,999.99" (~63pt @ 9pt bold) → 74pt col (headroom)
              //   Amount total "Rs. 9,99,99,999.99" (~80pt) → 95pt col
              // Silver /g + Making /g are 2-decimal RATES only (no sums
              // across lines), so their body values ("238.11", "80.00")
              // fit comfortably at 54pt.
              { label: '#',                  w: 18,  align: 'center' },
              { label: 'Item & Description', w: 118, align: 'left'   },
              { label: 'HSN',                w: 40,  align: 'center' },
              { label: 'Qty',                w: 28,  align: 'right'  },
              { label: 'Net Wt',             w: 56,  align: 'right'  },
              { label: 'Silver /g',          w: 54,  align: 'right'  },
              { label: 'Making /g',          w: 54,  align: 'right'  },
              { label: 'Addl /pc',           w: 82,  align: 'right'  },
              { label: 'Amount',             w: 97,  align: 'right'  },
              // sum: 18+118+40+28+56+54+54+82+97 = 547
            ]
          : [
              // Landscape interstate (15 cols · 794pt). Money widths sized
              // to fit CRORE-scale totals ("Rs. 9,99,99,999.99" ≈ 80pt @
              // 9pt bold) without ellipsis clipping. Item column narrows
              // to make room; multi-line label wrap handles the descent.
              { label: '#',                  w: 20,  align: 'center' },
              { label: 'Item & Description', w: 82,  align: 'left'   },
              { label: 'HSN/SAC',            w: 50,  align: 'center' },
              { label: 'Qty',                w: 26,  align: 'right'  },
              { label: 'Wt/pc',              w: 36,  align: 'right'  },
              { label: 'Gross Wt',           w: 48,  align: 'right'  },
              { label: 'Less Wt',            w: 42,  align: 'right'  },
              { label: 'Net Wt',             w: 48,  align: 'right'  },
              { label: 'Silver',             w: 72,  align: 'right'  },
              { label: 'Making',             w: 68,  align: 'right'  },
              { label: 'Addl Chrg',          w: 58,  align: 'right'  },
              { label: 'S + M + A',          w: 74,  align: 'right'  },
              { label: 'IGST %',             w: 34,  align: 'right'  },
              { label: 'IGST Amt',           w: 60,  align: 'right'  },
              { label: 'Amount',             w: 76,  align: 'right'  },
              // sum: 20+82+50+26+36+48+42+48+72+68+58+74+34+60+76 = 794
            ]
        : compactMoneyCols
          ? [
              // Portrait tax invoice — intra-state layout (same 8 cols as
              // interstate). GST columns dropped; Silver /g + Making /g
              // rate cols added between Qty and Amount per operator spec.
              // Widths sized for CRORE-scale totals so future big-ticket
              // bills print cleanly:
              //   Addl total "Rs. 99,99,999.99" (~63pt @ 9pt bold) → 74pt col (headroom)
              //   Amount total "Rs. 9,99,99,999.99" (~80pt) → 95pt col
              // Silver /g + Making /g are 2-decimal RATES only (no sums
              // across lines), so their body values ("238.11", "80.00")
              // fit comfortably at 54pt.
              { label: '#',                  w: 18,  align: 'center' },
              { label: 'Item & Description', w: 118, align: 'left'   },
              { label: 'HSN',                w: 40,  align: 'center' },
              { label: 'Qty',                w: 28,  align: 'right'  },
              { label: 'Net Wt',             w: 56,  align: 'right'  },
              { label: 'Silver /g',          w: 54,  align: 'right'  },
              { label: 'Making /g',          w: 54,  align: 'right'  },
              { label: 'Addl /pc',           w: 82,  align: 'right'  },
              { label: 'Amount',             w: 97,  align: 'right'  },
              // sum: 18+118+40+28+56+54+54+82+97 = 547
            ]
          : [
              // Landscape intra-state (17 cols · 794pt). Money widths
              // sized to fit CRORE-scale line totals ("Rs. 99,99,999.99"
              // ~63pt @ 9pt bold) so a 1-2 crore grand total prints
              // without ellipsis. Item narrows to release space.
              { label: '#',                  w: 18, align: 'center' },
              { label: 'Item & Description', w: 56, align: 'left'   },
              { label: 'HSN/SAC',            w: 38, align: 'center' },
              { label: 'Qty',                w: 22, align: 'right'  },
              { label: 'Wt/pc',              w: 32, align: 'right'  },
              { label: 'Gross Wt',           w: 44, align: 'right'  },
              { label: 'Less Wt',            w: 40, align: 'right'  },
              { label: 'Net Wt',             w: 44, align: 'right'  },
              { label: 'Silver',             w: 62, align: 'right'  },
              { label: 'Making',             w: 62, align: 'right'  },
              { label: 'Addl Chrg',          w: 58, align: 'right'  },
              { label: 'S + M + A',          w: 68, align: 'right'  },
              { label: 'CGST %',             w: 32, align: 'right'  },
              { label: 'CGST Amt',           w: 56, align: 'right'  },
              { label: 'SGST %',             w: 32, align: 'right'  },
              { label: 'SGST Amt',           w: 56, align: 'right'  },
              { label: 'Amount',             w: 74, align: 'right'  },
              // sum: 18+56+38+22+32+44+40+44+62+62+58+68+32+56+32+56+74 = 794
            ]
      : [
          // No-tax layout (13 cols · 794pt). Extra headroom on money
          // cols since no GST band consumes width — safely handles
          // crore-scale grand totals.
          { label: '#',                  w: 22,  align: 'center' },
          { label: 'Item & Description', w: 126, align: 'left'   },
          { label: 'HSN/SAC',            w: 54,  align: 'center' },
          { label: 'Qty',                w: 32,  align: 'right'  },
          { label: 'Wt/pc',              w: 40,  align: 'right'  },
          { label: 'Gross Wt',           w: 56,  align: 'right'  },
          { label: 'Less Wt',            w: 48,  align: 'right'  },
          { label: 'Net Wt',             w: 56,  align: 'right'  },
          { label: 'Silver',             w: 74,  align: 'right'  },
          { label: 'Making',             w: 68,  align: 'right'  },
          { label: 'Addl Chrg',          w: 60,  align: 'right'  },
          { label: 'S + M + A',          w: 78,  align: 'right'  },
          { label: 'Amount',             w: 80,  align: 'right'  },
          // sum: 22+126+54+32+40+56+48+56+74+68+60+78+80 = 794
        ];

  // Solid black grid — matches the corporate look the user asked for.
  const gridColor = '#000000';
  const drawVerticals = (topY: number, botY: number, skipRange?: [number, number]) => {
    doc.strokeColor(gridColor).lineWidth(0.5);
    // Left edge
    doc.moveTo(M, topY).lineTo(M, botY).stroke();
    // Between columns
    let x = M;
    for (let i = 0; i < cols.length; i++) {
      x += cols[i].w;
      // Skip verticals inside the parent tax-group cell for the top
      // half of the header (only used by drawTableHeader).
      if (skipRange && i >= skipRange[0] && i < skipRange[1]) continue;
      doc.moveTo(x, topY).lineTo(x, botY).stroke();
    }
    // Right edge already drawn by the last vertical above (x = M+innerW).
  };

  const drawTableHeader = (startY: number): number => {
    // Interstate: 2-row header (IGST super over % + Amt).
    // Intra-state: 3-row header — proper Indian invoice hierarchy:
    //   Row 1: GST (super, spans 4 nested cols)
    //   Row 2: CGST (spans %+Amt) | SGST (spans %+Amt)
    //   Row 3: % | Amt | % | Amt
    // No-tax: single-line header.
    const headerH = showTaxInTable ? (isInter ? 36 : 44) : 22;
    // Light grey header band + black text — cleaner corporate look.
    doc.rect(M, startY, innerW, headerH).fill('#e5e7eb');
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9);
    // Top and bottom borders of the header block.
    doc.strokeColor(gridColor).lineWidth(0.5)
       .moveTo(M, startY).lineTo(M + innerW, startY).stroke()
       .moveTo(M, startY + headerH).lineTo(M + innerW, startY + headerH).stroke();
    if (showTaxInTable) {
      // Column index of the first tax column depends on layout:
      //   Landscape (full breakdown): S+M+A is at 11, tax cols start at 12.
      //   Portrait  (compact):        S+M+A is at  5, tax cols start at  6.
      // The GST group spans 4 leaves for intra-state, 2 for interstate.
      // The Amount column always sits OUTSIDE the group at the end.
      const taxColsStart = compactMoneyCols ? 6 : 12;
      const taxColsEnd = compactMoneyCols
        ? (isInter ? 7 : 9)
        : (isInter ? 13 : 15);
      // Non-tax columns fill the full header height and center vertically.
      // Detect wrap so multi-word labels ("Item & Description", "Gross Wt")
      // land on two rows at the top instead of one big line at the bottom.
      const lineH = 11;
      const singleLineY = startY + (headerH - lineH) / 2;
      const twoLineY = startY + (headerH - 2 * lineH) / 2;
      let x = M;
      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        if (i >= taxColsStart && i <= taxColsEnd) {
          x += c.w;
          continue;
        }
        const willWrap = doc.widthOfString(c.label) > c.w - 4;
        doc.text(c.label, x + 2, willWrap ? twoLineY : singleLineY, {
          width: c.w - 4,
          align: 'center',
        });
        x += c.w;
      }

      // Coordinates of the GST group as a whole.
      const groupX = M + cols.slice(0, taxColsStart).reduce((s, c) => s + c.w, 0);
      const groupW = cols.slice(taxColsStart, taxColsEnd + 1).reduce((s, c) => s + c.w, 0);

      if (isInter) {
        // 2-row header — IGST super (top half) + %/Amt leaves (bottom half).
        const midY = startY + 18;
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(11)
           .text('IGST', groupX, startY + 3, { width: groupW, align: 'center', lineBreak: false });
        doc.strokeColor('#000000').lineWidth(0.5)
           .moveTo(groupX, midY).lineTo(groupX + groupW, midY).stroke();
        // Leaf labels: "%" and "Amt"
        let lx = groupX;
        for (let i = taxColsStart; i <= taxColsEnd; i++) {
          const leaf = cols[i].label.split(' ').pop() ?? '';
          doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9)
             .text(leaf, lx + 2, startY + 22, { width: cols[i].w - 4, align: 'center', lineBreak: false });
          lx += cols[i].w;
        }
        // Verticals: top half skips internal splits so IGST spans clean;
        // bottom half draws every column line to separate % from Amt.
        drawVerticals(startY, midY, [taxColsStart, taxColsEnd]);
        drawVerticals(midY, startY + headerH);
      } else {
        // 3-row hierarchy — GST → CGST | SGST → % | Amt | % | Amt.
        const row1H = 13;   // GST super label
        const row2H = 14;   // CGST | SGST mid labels
        const midY1 = startY + row1H;
        const midY2 = midY1 + row2H;

        // Row 1: GST spanning the whole 4-col group.
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(11)
           .text('GST', groupX, startY + 2, { width: groupW, align: 'center', lineBreak: false });
        doc.strokeColor('#000000').lineWidth(0.5)
           .moveTo(groupX, midY1).lineTo(groupX + groupW, midY1).stroke();

        // Row 2: CGST (first pair of tax cols: %+Amt) and SGST (second
        // pair). Indices are taxColsStart..+1 and +2..+3 regardless of
        // layout — landscape has them at 12/13/14/15, portrait at 6/7/8/9.
        const cgstX = groupX;
        const cgstW = cols[taxColsStart].w + cols[taxColsStart + 1].w;
        const sgstX = cgstX + cgstW;
        const sgstW = cols[taxColsStart + 2].w + cols[taxColsStart + 3].w;
        doc.font('Helvetica-Bold').fontSize(10)
           .text('CGST', cgstX, midY1 + 2, { width: cgstW, align: 'center', lineBreak: false });
        doc.text('SGST', sgstX, midY1 + 2, { width: sgstW, align: 'center', lineBreak: false });
        // Divider between CGST and SGST (vertical, only between row2 and bottom)
        doc.strokeColor('#000000').lineWidth(0.5)
           .moveTo(sgstX, midY1).lineTo(sgstX, startY + headerH).stroke();
        // Horizontal divider under CGST/SGST row
        doc.strokeColor('#000000').lineWidth(0.5)
           .moveTo(groupX, midY2).lineTo(groupX + groupW, midY2).stroke();

        // Row 3: leaf labels (%, Amt, %, Amt)
        let lx = groupX;
        for (let i = taxColsStart; i <= taxColsEnd; i++) {
          const leaf = cols[i].label.split(' ').pop() ?? '';
          doc.font('Helvetica-Bold').fontSize(9)
             .text(leaf, lx + 2, midY2 + 2, { width: cols[i].w - 4, align: 'center', lineBreak: false });
          lx += cols[i].w;
        }
        // Verticals inside the group:
        //   • Row 1 (GST super): no internal splits — GST spans clean.
        //   • Row 2 (CGST | SGST): only the CGST↔SGST split, drawn above.
        //   • Row 3 (leaves): every column line.
        drawVerticals(startY, midY2, [taxColsStart, taxColsEnd]);
        drawVerticals(midY2, startY + headerH);
      }
    } else {
      let x = M;
      for (const c of cols) {
        doc.text(c.label, x + 2, startY + 6, { width: c.w - 4, align: 'center' });
        x += c.w;
      }
      drawVerticals(startY, startY + headerH);
    }
    return startY + headerH;
  };

  y = drawTableHeader(y);

  // Per-item render — each InvoiceItem prints up to two visual rows
  // (silver row + optional making row) so the table reads like the
  // Zoho reference. Weight rows print qty as "38.88 g"; making rows
  // print "1.00 pcs".
  doc.font('Helvetica').fontSize(10).fillColor('#111827');
  let idx = 1;
  // Row height — portrait has more vertical room per page (842pt vs
  // landscape 595pt) so we use taller rows for readability. Landscape
  // stays tight because 17+ columns need to fit horizontally.
  const rowH = isPortrait ? 22 : 18;
  // Truncate any cell value that would overflow its column. PDFKit's
  // lineBreak:false doesn't always prevent wrap for narrow left-aligned
  // cells, so we manually clip with an ellipsis before rendering.
  const fitCell = (v: string, maxW: number): string => {
    if (!v) return '';
    if (doc.widthOfString(v) <= maxW) return v;
    let s = v;
    while (s.length > 0) {
      s = s.slice(0, -1);
      if (doc.widthOfString(s + '…') <= maxW) return s + '…';
    }
    return '…';
  };
  // Break the row BEFORE drawing when it wouldn't fit. Reserve ~65pt at
  // the bottom for the TOTAL row + closing block (totals-box + signatory).
  // Portrait A4 is 842pt tall vs landscape 595pt, so this scales with H.
  const PAGE_BREAK_Y = H - M - 40;
  // Cells that can wrap to multiple lines: the Item cell (always) plus,
  // for portrait tax invoices, the Addl cell (renders "240 /pc\n7,200.00"
  // — per-piece rate stacked over the line total).
  const addlColIdx = compactMoneyCols ? 7 : -1;
  const drawRow = (cells: Array<{ v: string; align?: 'left' | 'right' | 'center' }>) => {
    // Measure first so we can page-break BEFORE any draw call.
    doc.font('Helvetica').fontSize(10);
    const itemCell = cells[1] ?? { v: '' };
    const itemW = cols[1].w - 4;
    const itemH = itemCell.v ? doc.heightOfString(itemCell.v, { width: itemW }) : 10;
    // Addl cell may render two lines for portrait — measure it and let
    // the row height grow to the max of any multi-line cell.
    let addlH = 10;
    if (addlColIdx >= 0) {
      const addlCellRef = cells[addlColIdx] ?? { v: '' };
      const addlW = cols[addlColIdx].w - 4;
      if (addlCellRef.v && addlCellRef.v.includes('\n')) {
        addlH = doc.heightOfString(addlCellRef.v, { width: addlW });
      }
    }
    const contentH = Math.max(itemH, addlH);
    const actualRowH = Math.max(rowH, Math.ceil(contentH) + 8);

    // Page-break check — must include actualRowH so a tall row does not
    // split across the page edge.
    if (y + actualRowH > PAGE_BREAK_Y) {
      doc.addPage({ size: 'A4', margin: M, layout: isPortrait ? 'portrait' : 'landscape' });
      y = M;
      y = drawTableHeader(y);
      doc.font('Helvetica').fontSize(10).fillColor('#111827');
      doc.y = y;
    }
    // Pin PDFKit's internal cursor at the row's top BEFORE any draw.
    doc.y = y;

    let x = M;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const cell = cells[i] ?? { v: '' };
      const align = (cell.align ?? c.align) as 'left' | 'right' | 'center';
      if (i === 1) {
        // Item column — wraps to multiple lines, but the block of text
        // should sit VERTICALLY CENTERED inside the row (matching the
        // numeric cells to the right). We already measured itemH for
        // page-break math above; reuse it to compute the top offset.
        const topOffset = Math.max(2, (actualRowH - itemH) / 2);
        doc.text(cell.v, x + 2, y + topOffset, { width: c.w - 4, align, lineBreak: true });
      } else if (i === addlColIdx && cell.v.includes('\n')) {
        // Addl column with per-pc / total stack — respect the \n, center
        // the two-line block vertically like the Item column does.
        const topOffset = Math.max(2, (actualRowH - addlH) / 2);
        doc.text(cell.v, x + 2, y + topOffset, { width: c.w - 4, align, lineBreak: true });
      } else {
        // Other columns — truncate to fit and centre vertically within
        // the (possibly grown) row.
        const text = fitCell(cell.v, c.w - 4);
        doc.text(text, x + 2, y + (actualRowH - 10) / 2, { width: c.w - 4, align, lineBreak: false });
      }
      x += c.w;
    }
    // Row grid — vertical column separators + bottom horizontal.
    drawVerticals(y, y + actualRowH);
    doc.strokeColor(gridColor).lineWidth(0.5)
       .moveTo(M, y + actualRowH).lineTo(M + innerW, y + actualRowH).stroke();
    y += actualRowH;
    doc.y = y;
  };

  // One row per invoice line with the full weight-breakdown columns.
  // Running totals for the closing totals row (every numeric column).
  const totals = {
    qty: 0, grossWt: 0, lessWt: 0, netWt: 0,
    silver: 0, making: 0, extra: 0, sPlusM: 0, taxAmt: 0, halfTax: 0, amount: 0,
  };
  for (const it of inv.items) {
    const qty = Number(it.quantity);
    const perPcWt = Number(it.weightG);
    const totalWt = r3(perPcWt * qty);
    const silverAmt = Number(it.silverAmount ?? 0);
    // Making + additional charges are now displayed in separate columns
    // (Making · Addl Chrg · S+M+A) so we keep them apart at the source.
    const makingAmt = Number(it.makingAmount ?? 0);
    const extraAmt  = Number(it.extraAmount ?? 0);
    const extraDesc = ((it as any).extraDescription ?? '').trim();
    const hsn = it.hsnCode ?? '7113';
    const code = (it.itemNumber ?? '').trim();
    const desc = (it.description ?? '').trim();
    // Show BOTH the code and the description in the Item column. The row
    // height auto-grows via heightOfString on the wrapped Item cell, so
    // long descriptions no longer clip — they push the whole row taller.
    // Code goes on line 1, description on line 2. When one is missing or
    // they duplicate each other, collapse to a single line so short rows
    // stay compact.
    const label = (() => {
      // Base label: code + description (when distinct) or whichever's set.
      const base =
        (code && desc && code.toLowerCase() !== desc.toLowerCase())
          ? `${code}\n${desc}`
          : (code || desc || '—');
      // When the operator captured a reason for the Addl Chrg, print it on
      // an extra caption line so the customer knows what the additional
      // amount was for (the narrow Addl Chrg column can only show the
      // number itself).
      if (extraAmt > 0 && extraDesc) {
        return `${base}\nAddl: ${extraDesc}`;
      }
      return base;
    })();
    // Weight breakdown — schema stores per-piece; totals are per-piece × qty.
    // Fine Wt mirrors Net Wt per operator's spec: "no calculation, all wts
    // must come same". If a future workflow needs a distinct Fine Wt we
    // can bring back a stored-only display.
    const lessPerPc = it.lessWeightG != null ? Number(it.lessWeightG) : 0;
    const grossPerPc = it.totalGrossWeightG != null ? Number(it.totalGrossWeightG) : perPcWt;
    const netPerPc = it.netWeightG != null ? Number(it.netWeightG) : r3(grossPerPc - lessPerPc);
    // Use the operator's typed total weight when present — sidesteps the
    // 33.333 × 60 = 1999.98 drift caused by 3-decimal per-piece rounding.
    // Falls back to per-piece × qty when the operator only typed Wt/pc.
    const typedTotal = (it as any).totalWeightG != null ? Number((it as any).totalWeightG) : null;
    const grossTot = typedTotal != null ? r3(typedTotal) : r3(grossPerPc * qty);
    const lessTot  = r3(lessPerPc * qty);
    const netTot   = typedTotal != null ? r3(typedTotal - lessTot) : r3(netPerPc * qty);
    // Fine Wt column removed per operator spec — was previously mirrored
    // from Net Wt (no distinct purity derivation). Downstream Silver
    // amount calc still uses netTot × rate; no math changes.
    // Additional Charges display as PER PIECE (extraAmt is stored as a
    // whole-line total on the invoice item; divide by qty for display).
    const addlPerPc = qty > 0 ? extraAmt / qty : 0;
    const sPlusMA = silverAmt + makingAmt + extraAmt;
    const taxAmt = r2(sPlusMA * (gstPct / 100));
    const halfTax = r2(sPlusMA * (halfPct / 100));
    // Row's "Amount" cell: for LANDSCAPE tax invoices it includes GST
    // (matches the inline tax breakdown). For PORTRAIT it stays pre-tax
    // because the GST band was removed from the table — the totals-box
    // below adds GST and shows the grand total, so putting +GST inline
    // would double-count.
    const finalAmt = showTaxInTable ? r2(sPlusMA + taxAmt) : sPlusMA;

    // Accumulate every numeric column for the totals row.
    totals.qty += qty;
    totals.grossWt += grossTot;
    totals.lessWt += lessTot;
    totals.netWt += netTot;
    totals.silver += silverAmt;
    totals.making += makingAmt;
    totals.extra += extraAmt;
    totals.sPlusM += sPlusMA;
    totals.taxAmt += taxAmt;
    totals.halfTax += halfTax;
    totals.amount += finalAmt;

    // Common cells shape depends on layout:
    //   Landscape (12 cells): # · Item · HSN · Qty · Wt/pc · Gross · Less
    //     · Net · Silver · Making · Addl Chrg · S+M+A
    //   Portrait  (8 cells): # · Item · HSN · Qty · Net · Silver /g · Making /g · Addl
    //     (Amount appended at the end by the outer row builder).
    // Weights render at 3 decimals per operator spec, money at 2 decimals.
    // Addl column shows the PER-PIECE RATE, matching Silver /g and
    // Making /g. Print "0.00" (not "—") when the operator hasn't set an
    // additional charge — matches how the rate columns render zero and
    // keeps the row visually consistent.
    const addlCell = addlPerPc > 0 ? addlPerPc.toFixed(2) : '0.00';
    const commonCells = compactMoneyCols
      ? [
          { v: String(idx), align: 'center' as const },
          { v: label, align: 'left' as const },
          { v: hsn, align: 'center' as const },
          { v: String(qty), align: 'right' as const },
          { v: netTot.toFixed(3), align: 'right' as const },
          { v: Number(it.silverRatePerG ?? 0).toFixed(2), align: 'right' as const },
          { v: Number(it.makingRatePerG ?? 0).toFixed(2), align: 'right' as const },
          { v: addlCell, align: 'right' as const },
        ]
      : [
          { v: String(idx), align: 'center' as const },
          { v: label, align: 'left' as const },
          { v: hsn, align: 'center' as const },
          { v: String(qty), align: 'right' as const },
          { v: perPcWt.toFixed(3), align: 'right' as const },
          { v: grossTot.toFixed(3), align: 'right' as const },
          { v: lessTot > 0 ? lessTot.toFixed(3) : '—', align: 'right' as const },
          { v: netTot.toFixed(3), align: 'right' as const },
          { v: silverAmt.toFixed(2), align: 'right' as const },
          { v: makingAmt.toFixed(2), align: 'right' as const },
          { v: addlPerPc > 0 ? addlPerPc.toFixed(2) : '0.00', align: 'right' as const },
          { v: sPlusMA.toFixed(2), align: 'right' as const },
        ];
    // Row Amount — plain number (no "Rs." prefix). Only the closing
    // TOTAL row and the bottom totals-box carry the currency prefix.
    const rowAmount = Number(finalAmt).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const row = showTaxInTable
      ? isInter
        ? [
            ...commonCells,
            { v: `${gstPct.toFixed(1)}%`, align: 'right' as const },
            { v: taxAmt.toFixed(2), align: 'right' as const },
            { v: rowAmount, align: 'right' as const },
          ]
        : [
            ...commonCells,
            { v: `${halfPct.toFixed(1)}%`, align: 'right' as const },
            { v: halfTax.toFixed(2), align: 'right' as const },
            { v: `${halfPct.toFixed(1)}%`, align: 'right' as const },
            { v: halfTax.toFixed(2), align: 'right' as const },
            { v: rowAmount, align: 'right' as const },
          ]
      : [
          ...commonCells,
          { v: rowAmount, align: 'right' as const },
        ];
    drawRow(row);
    idx++;
  }

  // ── TOTALS ROW — light grey band matching the table header ───────
  // Only meaningful when the table has data; skipped otherwise.
  if (inv.items.length > 0) {
    doc.rect(M, y, innerW, rowH).fill('#e5e7eb');
    doc.strokeColor('#000000').lineWidth(0.5)
       .moveTo(M, y).lineTo(M + innerW, y).stroke()
       .moveTo(M, y + rowH).lineTo(M + innerW, y + rowH).stroke();
    // TOTAL row font is 1pt smaller than data rows — buys enough horizontal
    // room to fit 8-char 3-decimal weight sums ("2906.455") and 6-digit
    // rupee sums ("244675.75") in their columns without ellipsis.
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9);
    // Build totals cells — same shape as data rows so vertical alignment
    // stays perfect. Every numeric column carries a sum. Per-piece / rate
    // / % columns stay blank because summing them is not meaningful.
    const blank = { v: '', align: 'right' as const };
    const totalsCells: Array<{ v: string; align: 'left' | 'right' | 'center' }> =
      Array(cols.length).fill(0).map(() => ({ ...blank }));
    // Index map — differs between landscape and portrait column sets.
    //   Landscape: 0=# 1=Item 2=HSN 3=Qty 4=Wt/pc 5=Gross 6=Less 7=Net
    //     8=Silver 9=Making 10=Addl 11=S+M+A · then tax cols · Amount
    //   Portrait: 0=# 1=Item 2=HSN 3=Qty 4=Net 5=S+M+A · then tax cols · Amount
    // Weight totals get " g" suffix; money totals get "Rs. " prefix via inr().
    totalsCells[1] = { v: 'TOTAL', align: 'left' };
    totalsCells[3] = { v: String(totals.qty), align: 'right' };
    if (compactMoneyCols) {
      // Portrait indices: 0=# 1=Item 2=HSN 3=Qty 4=Net 5=Silver/g
      //   6=Making/g 7=Addl/pc 8=Amount
      // Silver /g, Making /g, Addl /pc are RATE columns — a sum across
      // lines isn't meaningful, so those totals cells stay blank. Only
      // Net Wt and Amount get filled in.
      totalsCells[4] = { v: `${totals.netWt.toFixed(3)} g`, align: 'right' };
      totalsCells[8] = { v: inr(totals.sPlusM), align: 'right' };
    } else {
      // Landscape: full breakdown row.
      totalsCells[5]  = { v: `${totals.grossWt.toFixed(3)} g`, align: 'right' };
      totalsCells[6]  = { v: totals.lessWt > 0 ? `${totals.lessWt.toFixed(3)} g` : '—', align: 'right' };
      totalsCells[7]  = { v: `${totals.netWt.toFixed(3)} g`, align: 'right' };
      totalsCells[8]  = { v: inr(totals.silver), align: 'right' };
      totalsCells[9]  = { v: inr(totals.making), align: 'right' };
      totalsCells[10] = { v: totals.extra > 0 ? inr(totals.extra) : '—', align: 'right' };
      totalsCells[11] = { v: inr(totals.sPlusM), align: 'right' };
      if (showTaxCols) {
        if (isInter) {
          totalsCells[13] = { v: inr(totals.taxAmt), align: 'right' };
        } else {
          totalsCells[13] = { v: inr(totals.halfTax), align: 'right' };
          totalsCells[15] = { v: inr(totals.halfTax), align: 'right' };
        }
      }
    }
    // Amount is always the last column regardless of tax layout.
    totalsCells[cols.length - 1] = { v: inr(totals.amount), align: 'right' };
    let tx = M;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const cell = totalsCells[i];
      // Hard-clip so a wide numeric total never wraps mid-digit onto a
      // second visual line. fitCell measures against the current font.
      const clipped = fitCell(cell.v, c.w - 4);
      doc.text(clipped, tx + 2, y + 7, { width: c.w - 4, align: cell.align, lineBreak: false });
      tx += c.w;
    }
    drawVerticals(y, y + rowH);
    y += rowH;
  }

  // ── BOTTOM — Total In Words + Notes (left) · Totals box (right) ───
  // Tight gap so the signatory block below fits on the same page.
  y += 8;

  // Landscape page height ≈ 595. The closing block (totals rows + Total +
  // Balance Due + signatory) measures ~160pt vertically — the totals box
  // on the right and the Total-in-Words / Notes on the left occupy the
  // same vertical range so we don't add them. Threshold set so content
  // can extend to ~585pt (leaving a 10pt bottom margin). If the table
  // truly pushed us past that, add a fresh page and continue there.
  const closingBlockH = 165;
  const pageBreakBottom = H - M - 10;
  if (y + closingBlockH > pageBreakBottom) {
    doc.addPage({ size: 'A4', margin: M, layout: isPortrait ? 'portrait' : 'landscape' });
    y = M;
  }
  // Pin PDFKit's internal cursor to y so subsequent doc.text() calls
  // don't trigger implicit page-adds when the cursor has drifted past
  // the current page's bottom edge.
  doc.y = y;

  // Totals box (right). Portrait has less horizontal room so the box
  // sits at ~45% of the width for balance; landscape uses fixed 210pt.
  const tboxW = isPortrait ? Math.floor(innerW * 0.46) : 210;
  const tboxX = M + innerW - tboxW;
  const lineH = isPortrait ? 18 : 16;
  const cgst = Number(inv.cgstAmount);
  const sgst = Number(inv.sgstAmount);
  const igst = Number(inv.igstAmount);
  const round = Number(inv.roundOff);

  const totalRows: Array<[string, string, boolean]> = [
    ['Sub Total', inr(Number(inv.subtotal)), false],
  ];
  if (inv.type !== 'DELIVERY_CHALLAN' && gstPct > 0) {
    if (isInter) {
      totalRows.push([`IGST (${gstPct.toFixed(0)}%)`, inr(igst), false]);
    } else {
      totalRows.push([`CGST (${halfPct.toFixed(2)}%)`, inr(cgst), false]);
      totalRows.push([`SGST (${halfPct.toFixed(2)}%)`, inr(sgst), false]);
    }
  }
  if (Math.abs(round) > 0.005) {
    totalRows.push(['Adjustment', `(${round < 0 ? '-' : '+'}) ${Math.abs(round).toFixed(2)}`, false]);
  }

  let ty = y;
  for (const [k, v] of totalRows) {
    doc.fillColor('#000000').font('Helvetica').fontSize(10)
       .text(k, tboxX + 8, ty + 5, { width: tboxW / 2 - 8, lineBreak: false });
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10)
       .text(v, tboxX + tboxW / 2, ty + 5, { width: tboxW / 2 - 8, align: 'right', lineBreak: false });
    ty += lineH;
  }
  // Grand total — bold, larger. Dark rule above.
  doc.strokeColor('#000000').lineWidth(1).moveTo(tboxX, ty).lineTo(tboxX + tboxW, ty).stroke();
  doc.fillColor('#000000').font('Helvetica-Bold').fontSize(12)
     .text('Total', tboxX + 8, ty + 7, { width: tboxW / 2 - 8, lineBreak: false });
  doc.text(inr(Number(inv.totalAmount)),
           tboxX + tboxW / 2, ty + 7, { width: tboxW / 2 - 8, align: 'right', lineBreak: false });
  ty += 24;
  // Balance due
  if (inv.type !== 'DELIVERY_CHALLAN') {
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(11)
       .text('Balance Due', tboxX + 8, ty + 5, { width: tboxW / 2 - 8, lineBreak: false });
    doc.text(inr(Number(inv.balanceAmount)),
             tboxX + tboxW / 2, ty + 5, { width: tboxW / 2 - 8, align: 'right', lineBreak: false });
    ty += 20;
  }

  // Left column: Total In Words + Notes (all black)
  if (inv.type !== 'DELIVERY_CHALLAN') {
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10)
       .text('Total In Words', M, y, { lineBreak: false });
    doc.fillColor('#000000').font('Helvetica-Oblique').fontSize(11)
       .text(amountInWords(Number(inv.totalAmount)), M, y + 16, { width: innerW - tboxW - 20 });
  }
  if (inv.notes) {
    const notesY = y + 52;
    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10)
       .text('Notes', M, notesY, { lineBreak: false });
    doc.fillColor('#000000').font('Helvetica').fontSize(10)
       .text(inv.notes, M, notesY + 16, { width: innerW - tboxW - 20 });
  }

  // ── AUTHORIZED SIGNATORY — bottom-right, aligned with totals box ──
  // Sits below the balance-due row inside the same right column so it
  // reads as the closing "For <company> — signatory" block that
  // customers expect on a corporate tax invoice.
  // Signature block layout:
  //   (blank ~40pt space for the physical signature)
  //   For <Company>          ← immediately above the line
  //   ─────────────
  //   Authorized Signatory   ← below the line
  // Tight offsets so the signatory fits under the totals box on the
  // same landscape page (~595pt total height).
  // Layout: [blank sig space] · For <Legal name> · rule · Authorized Signatory.
  // The trading name "(Pratik Product)" is deliberately NOT repeated here
  // — it's already shown under the address at the top of the doc, and
  // duplicating it here was pushing the page height past A4-landscape
  // (595pt) which auto-flowed the signatory onto pages 2 and 3.
  const sigY = ty + 20;
  const signSpace = 22;
  const forY = sigY + signSpace;
  const ruleY = forY + 14;
  const labelY = ruleY + 4;
  // Pin cursor before each signatory draw so PDFKit doesn't auto-flow.
  doc.y = forY;
  doc.fillColor('#000000').font('Helvetica-Bold').fontSize(10)
     .text(`For ${COMPANY.name}`, tboxX, forY, { width: tboxW, align: 'center', lineBreak: false });
  doc.strokeColor('#000000').lineWidth(0.75)
     .moveTo(tboxX + 20, ruleY).lineTo(tboxX + tboxW - 20, ruleY).stroke();
  doc.y = labelY;
  doc.fillColor('#000000').font('Helvetica').fontSize(10)
     .text('Authorized Signatory', tboxX, labelY, { width: tboxW, align: 'center', lineBreak: false });

  // Detailed weight + labor breakdown page — disabled per user request.
  // The Zoho-style single-page layout above is enough for now; the
  // drawBreakdownPage renderer is still present below in case we want to
  // re-enable it later.
}

function drawBreakdownPage(doc: PDFKit.PDFDocument, inv: InvoiceData) {
  // A4 landscape would fit more columns; keep portrait + smaller font so
  // every row lives on one line.
  doc.addPage({ size: 'A4', margin: 24, layout: 'landscape' });
  const W = 841.89;
  const H = 595.28;
  const M = 24;
  const innerW = W - 2 * M;

  // Header band
  doc.rect(M, M, innerW, 38).fillAndStroke('#1f2937', '#1f2937');
  doc.fillColor('#fbbf24').font('Helvetica-Bold').fontSize(13)
     .text(`${inv.invoiceNumber} — Detailed Weight & Labor Breakdown`, M + 12, M + 11, { width: innerW - 24 });
  doc.fillColor('#e5e7eb').font('Helvetica').fontSize(9)
     .text(`${inv.billToName} · ${fmtDate(inv.invoiceDate)}`, M + 12, M + 11, { width: innerW - 24, align: 'right' });

  // Column definitions — widths sum to innerW (≈ 793).
  const cols = [
    { label: '#',         w: 24,  align: 'left' },
    { label: 'Prod Order', w: 60, align: 'left' },
    { label: 'Box',       w: 60,  align: 'left' },
    { label: 'Item',      w: 88,  align: 'left' },
    { label: 'Plating',   w: 50,  align: 'left' },
    { label: 'Size',      w: 32,  align: 'right' },
    { label: 'Qty',       w: 26,  align: 'right' },
    { label: 'Gross g',   w: 44,  align: 'right' },
    { label: 'Less g',    w: 36,  align: 'right' },
    { label: 'Net g',     w: 42,  align: 'right' },
    { label: 'Purity',    w: 36,  align: 'right' },
    { label: 'Fine g',    w: 42,  align: 'right' },
    { label: 'Wst %',     w: 30,  align: 'right' },
    { label: 'Wst Fine',  w: 42,  align: 'right' },
    { label: 'Box g',     w: 36,  align: 'right' },
    { label: 'Bag g',     w: 36,  align: 'right' },
    { label: 'Tag g',     w: 32,  align: 'right' },
    { label: 'Pad g',     w: 32,  align: 'right' },
    { label: 'Total Gross', w: 50, align: 'right' },
    { label: 'Labor Rate', w: 44, align: 'right' },
    { label: 'Labor Amt', w: 44,  align: 'right' },
  ];

  let y = M + 46;
  // Column header
  doc.rect(M, y, innerW, 16).fillAndStroke('#374151', '#374151');
  doc.fillColor('#fbbf24').font('Helvetica-Bold').fontSize(7);
  let cx = M + 4;
  for (const c of cols) {
    doc.text(c.label, cx, y + 5, { width: c.w - 4, align: c.align as any, lineBreak: false });
    cx += c.w;
  }
  y += 16;

  // Data rows
  doc.font('Helvetica').fontSize(10).fillColor('#111827');
  const totals = {
    qty: 0, gross: 0, less: 0, net: 0, fine: 0, wastageFine: 0,
    box: 0, bag: 0, tag: 0, pad: 0, totalGross: 0, laborAmt: 0,
  };
  let idx = 1;
  for (const it of inv.items) {
    const rowH = 16;
    if (y + rowH > H - M - 24) {
      // New page on overflow.
      doc.addPage({ size: 'A4', margin: 24, layout: 'landscape' });
      y = M + 4;
    }
    cx = M + 4;
    const cells: Array<{ v: string; align?: 'left' | 'right' }> = [
      { v: String(idx) },
      { v: it.productionOrderRef ?? '—' },
      { v: it.boxRef ?? '—' },
      { v: it.itemNumber ?? '—' },
      { v: it.plating ?? '—' },
      { v: it.size ?? '—', align: 'right' },
      { v: String(it.quantity), align: 'right' },
      { v: fmt3(it.weightG), align: 'right' },
      { v: fmt3(it.lessWeightG ?? 0), align: 'right' },
      { v: fmt3(it.netWeightG), align: 'right' },
      { v: it.purity != null ? Number(it.purity).toFixed(2) : '—', align: 'right' },
      { v: fmt3(it.fineWeightG), align: 'right' },
      { v: it.wastagePercent != null ? Number(it.wastagePercent).toFixed(2) : '—', align: 'right' },
      { v: fmt3(it.wastageFineG), align: 'right' },
      { v: fmt3(it.boxWeightG ?? 0), align: 'right' },
      { v: fmt3(it.bagWeightG ?? 0), align: 'right' },
      { v: fmt3(it.tagWeightG ?? 0), align: 'right' },
      { v: fmt3(it.padWeightG ?? 0), align: 'right' },
      { v: fmt3(it.totalGrossWeightG), align: 'right' },
      {
        v: it.laborRateWithoutTax != null
          ? Number(it.laborRateWithoutTax).toFixed(2)
          : (it.laborRateWithTax != null ? Number(it.laborRateWithTax).toFixed(2) : '—'),
        align: 'right',
      },
      { v: inrShort(it.laborAmount ?? it.makingAmount ?? 0), align: 'right' },
    ];
    for (let i = 0; i < cells.length; i++) {
      doc.text(cells[i].v, cx, y + 4, { width: cols[i].w - 4, align: cells[i].align ?? cols[i].align as any, lineBreak: false });
      cx += cols[i].w;
    }
    // Faint row separator.
    doc.strokeColor('#e5e7eb').moveTo(M, y + rowH).lineTo(M + innerW, y + rowH).stroke();
    // Accumulate totals.
    totals.qty += Number(it.quantity);
    totals.gross += Number(it.weightG ?? 0) * Number(it.quantity);
    totals.less  += Number(it.lessWeightG ?? 0);
    totals.net   += Number(it.netWeightG ?? 0);
    totals.fine  += Number(it.fineWeightG ?? 0);
    totals.wastageFine += Number(it.wastageFineG ?? 0);
    totals.box   += Number(it.boxWeightG ?? 0);
    totals.bag   += Number(it.bagWeightG ?? 0);
    totals.tag   += Number(it.tagWeightG ?? 0);
    totals.pad   += Number(it.padWeightG ?? 0);
    totals.totalGross += Number(it.totalGrossWeightG ?? 0);
    totals.laborAmt += Number(it.laborAmount ?? it.makingAmount ?? 0);
    y += rowH;
    idx++;
  }

  // Totals row.
  if (y + 18 > H - M - 24) {
    doc.addPage({ size: 'A4', margin: 24, layout: 'landscape' });
    y = M + 4;
  }
  doc.rect(M, y, innerW, 18).fillAndStroke('#1f2937', '#1f2937');
  doc.fillColor('#fbbf24').font('Helvetica-Bold').fontSize(7.5);
  cx = M + 4;
  const totalCells: string[] = [
    '', '', '', 'TOTAL', '', '',
    String(totals.qty),
    fmt3(totals.gross),
    fmt3(totals.less),
    fmt3(totals.net),
    '',
    fmt3(totals.fine),
    '',
    fmt3(totals.wastageFine),
    fmt3(totals.box),
    fmt3(totals.bag),
    fmt3(totals.tag),
    fmt3(totals.pad),
    fmt3(totals.totalGross),
    '',
    inrShort(totals.laborAmt),
  ];
  for (let i = 0; i < totalCells.length; i++) {
    doc.text(totalCells[i], cx, y + 5, { width: cols[i].w - 4, align: cols[i].align as any, lineBreak: false });
    cx += cols[i].w;
  }
}

function fmt3(v: any): string {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(3);
}
function inrShort(v: any): string {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d: Date | string) {
  const dt = new Date(d);
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Short DD/MM/YY for the challan header — matches the handwritten book. */
function fmtDateShort(d: Date | string) {
  const dt = new Date(d);
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yy = String(dt.getFullYear()).slice(2);
  return `${dd}/${mm}/${yy}`;
}

/** DD/MM/YYYY — matches the Zoho-style invoice metadata line. */
function fmtDateSlash(d: Date | string) {
  const dt = new Date(d);
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// ============================================================================
// Delivery Challan template — replicates Shree Abhinandan Product's physical
// duplicate-book challan. Goods-movement doc; rates + amounts are blank by
// default and only rendered when the operator filled them in. Body has fixed
// vertical row slots (form-style) so the printed page mirrors the book.
// ============================================================================
function drawChallan(doc: PDFKit.PDFDocument, inv: InvoiceData) {
  // Portrait A4 — one challan per page, grey/black theme.
  const W = 595.28;
  const H = 841.89;
  const M = 24;
  drawChallanPanel(doc, inv, M, M, W - 2 * M, H - 2 * M);
}

function drawChallanPanel(
  doc: PDFKit.PDFDocument, inv: InvoiceData,
  X: number, Y: number, W: number, H: number,
) {
  const innerW = W;

  // -------- Top banner — "DELIVERY CHALLAN" in a rounded red pill --------
  doc.roundedRect(X + innerW * 0.18, Y, innerW * 0.64, 26, 13)
     .lineWidth(1.2).strokeColor('#dc2626').stroke();
  doc.fillColor('#dc2626').font('Helvetica-Bold').fontSize(15)
     .text('DELIVERY CHALLAN', X, Y + 6, { width: innerW, align: 'center', lineBreak: false });

  // 50-50 column split across all three rows so the middle divider is
  // vertically continuous from FROM/TO down through CHALLAN/PURPOSE.
  const leftW  = innerW / 2;
  const rightW = innerW - leftW;

  // -------- From / To boxes (with addresses) --------
  let y = Y + 34;
  const fromAddr = [
    COMPANY.address,
    `GSTIN ${COMPANY.gstin}`,
  ].filter(Boolean).join('\n');
  // Prefer live customer address; fall back to the snapshot on the invoice.
  const cu = (inv.customer ?? {}) as NonNullable<InvoiceData['customer']>;
  const toAddrLines: string[] = [
    ...(cu.addressLine1 ? [cu.addressLine1] : []),
    ...(cu.addressLine2 ? [cu.addressLine2] : []),
    [cu.city, cu.state, cu.pincode].filter(Boolean).join(', '),
    cu.gstin ? `GSTIN ${cu.gstin}` : (inv.billToGstin ? `GSTIN ${inv.billToGstin}` : ''),
  ].filter((s) => s && s.trim().length > 0);
  const toAddr = toAddrLines.length > 0 ? toAddrLines.join('\n') : (inv.billToAddress ?? '');
  // Header bar (20pt) + name (14pt) + up to 3 address lines (11pt each)
  // + GSTIN line (11pt) + a bit of bottom padding.
  const partyBoxH = 20 + 14 + 4 * 11 + 10;
  drawPartyBox(doc, X,          y, leftW,  partyBoxH, 'From :', `${COMPANY.name} (Pratik Product)`, fromAddr);
  drawPartyBox(doc, X + leftW,  y, rightW, partyBoxH, 'To :',   inv.billToName ?? '', toAddr);
  y += partyBoxH;

  // -------- Order No / Date · Challan No / Purpose (2×2 grid) --------
  // Left column has ORDER No. + CHALLAN No.; right column has DATE +
  // PURPOSE — vertically aligned with the middle divider above.
  drawInlineBox(doc, X,          y, leftW,  20, 'ORDER No.',   '');
  drawInlineBox(doc, X + leftW,  y, rightW, 20, 'DELIVERY DATE :', fmtDateShort(inv.invoiceDate));
  y += 20;
  drawInlineBox(doc, X,          y, leftW,  20, 'CHALLAN No.', inv.invoiceNumber);
  drawInlineBox(doc, X + leftW,  y, rightW, 20, 'PURPOSE :',   inv.purpose ?? '');
  // Extra breathing room between the metadata block and the "Please
  // receive…" subhead so the section reads cleanly.
  y += 20 + 12;

  // -------- "Please receive…" subhead --------
  doc.fillColor('#374151').font('Helvetica').fontSize(8.5)
     .text('Please receive the following items in good condition and sign the duplicate attached.',
           X, y, { width: innerW, lineBreak: false });
  // Gap before the items table so the subhead doesn't crowd the header.
  y += 22;

  // -------- Items table (grey/black theme, dynamic rows) --------
  // Columns: # | Item & Description | Qty | Total Wt | Wt/pc
  // Material rows: description bold (primary), MV code regular above it.
  // Item rows: itemNumber bold, description regular.
  const cols = [
    { label: '#',                  w: 26,  align: 'center' },
    { label: 'Item & Description', w: 258, align: 'left'   },
    { label: 'Qty',                w: 45,  align: 'right'  },
    { label: 'Total Wt',           w: 75,  align: 'right'  },
    { label: 'Wt/pc',              w: 75,  align: 'right'  },
  ];
  // Normalise widths to fill innerW exactly.
  const colsW = cols.reduce((s, c) => s + c.w, 0);
  const scale = innerW / colsW;
  for (const c of cols) c.w = c.w * scale;

  const BLACK = '#000000';
  const GREY = '#e5e7eb';
  const HEADER_H = 22;

  // Helper — draws the grey table-header band at a given y and returns
  // the y just below it. Reused when a row page-break re-opens a fresh
  // page so the new page starts with the same column headers.
  const drawTableHeaderBand = (startY: number): number => {
    doc.rect(X, startY, innerW, HEADER_H).fill(GREY);
    doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(10);
    let hcx = X;
    for (const c of cols) {
      doc.text(c.label, hcx + 3, startY + 7, { width: c.w - 6, align: c.align as any, lineBreak: false });
      hcx += c.w;
    }
    doc.strokeColor(BLACK).lineWidth(0.4);
    let hdx = X;
    for (let k = 0; k < cols.length - 1; k++) {
      hdx += cols[k].w;
      doc.moveTo(hdx, startY).lineTo(hdx, startY + HEADER_H).stroke();
    }
    doc.strokeColor(BLACK).lineWidth(0.6).rect(X, startY, innerW, HEADER_H).stroke();
    return startY + HEADER_H;
  };
  y = drawTableHeaderBand(y);

  // Portrait A4 page height ≈ 842. Break before the row would land past
  // 780 so the TOTAL row + footer still fit on the current page.
  const PAGE_BREAK_Y = 780;

  // Body — one row per InvoiceItem, no fixed blank padding.
  let sumWt = 0;
  let sumQty = 0;
  let idx = 1;
  for (const it of inv.items) {
    const qty = Number(it.quantity ?? 0);
    const perPc = Number(it.weightG ?? 0);
    const wt = perPc * qty;
    sumWt += wt;
    sumQty += qty;

    const itemNo = (it.itemNumber ?? '').trim();
    const desc = (it.description ?? '').trim();
    // Material rows are the ones with no itemId FK (variantId doesn't
    // persist, so we detect via item having no linked Item). itemNo
    // starting with "MV" is a strong signal even without the FK.
    const isMaterial = it.itemId == null && /^mv/i.test(itemNo);
    // Row height fits itemNo + desc on two lines when both are present;
    // one-line rows collapse.
    const hasTwoLines = !!(itemNo && desc && itemNo.toLowerCase() !== desc.toLowerCase());
    const rowH = hasTwoLines ? 30 : 20;

    // Explicit page-break — without this, when y exceeds page height
    // PDFKit auto-adds pages and splits the row across sheets. Bumping
    // to a fresh page + re-drawing the table header keeps each row
    // whole and every page column-headed.
    if (y + rowH > PAGE_BREAK_Y) {
      doc.addPage({ size: 'A4', margin: 24, layout: 'portrait' });
      y = 24;
      y = drawTableHeaderBand(y);
      doc.y = y;
    }

    // Pin cursor so subsequent draws don't trigger implicit page-adds.
    doc.y = y;

    // Row border + column dividers.
    doc.strokeColor(BLACK).lineWidth(0.4).rect(X, y, innerW, rowH).stroke();
    let vdx = X;
    for (let k = 0; k < cols.length - 1; k++) {
      vdx += cols[k].w;
      doc.moveTo(vdx, y).lineTo(vdx, y + rowH).stroke();
    }

    // # column
    let cx = X;
    doc.fillColor(BLACK).font('Helvetica').fontSize(10)
       .text(String(idx), cx + 3, y + (rowH - 10) / 2, {
         width: cols[0].w - 6, align: 'center', lineBreak: false,
       });
    cx += cols[0].w;

    // Item & Description column
    if (hasTwoLines) {
      if (isMaterial) {
        // Material: MV code regular on top, material name BOLD below.
        doc.font('Helvetica').fontSize(9).fillColor(BLACK)
           .text(itemNo, cx + 4, y + 3, { width: cols[1].w - 8, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(10)
           .text(desc, cx + 4, y + 15, { width: cols[1].w - 8, lineBreak: false });
      } else {
        // Item: ABN code BOLD on top, description regular below.
        doc.font('Helvetica-Bold').fontSize(10).fillColor(BLACK)
           .text(itemNo, cx + 4, y + 3, { width: cols[1].w - 8, lineBreak: false });
        doc.font('Helvetica').fontSize(9)
           .text(desc, cx + 4, y + 17, { width: cols[1].w - 8, lineBreak: false });
      }
    } else {
      // Single-line row — bold whichever we have.
      const single = desc || itemNo;
      const bold = isMaterial ? !!desc : !!itemNo;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(BLACK)
         .text(single, cx + 4, y + (rowH - 10) / 2, { width: cols[1].w - 8, lineBreak: false });
    }
    cx += cols[1].w;

    // Qty | Total Wt | Wt/pc
    doc.font('Helvetica').fontSize(10).fillColor(BLACK);
    doc.text(String(qty), cx + 3, y + (rowH - 10) / 2, {
      width: cols[2].w - 6, align: 'right', lineBreak: false,
    });
    cx += cols[2].w;
    doc.text(wt > 0 ? `${wt.toFixed(3)}g` : '', cx + 3, y + (rowH - 10) / 2, {
      width: cols[3].w - 6, align: 'right', lineBreak: false,
    });
    cx += cols[3].w;
    doc.text(perPc > 0 ? perPc.toFixed(3) : '', cx + 3, y + (rowH - 10) / 2, {
      width: cols[4].w - 6, align: 'right', lineBreak: false,
    });

    y += rowH;
    idx++;
    doc.y = y; // pin between iterations too
  }

  // Operator override for the total weight — physical dispatch weigh-in
  // (may include tare / dust). Falls back to computed sum when null.
  const totalWt = inv.totalWeightG != null && Number(inv.totalWeightG) > 0
    ? Number(inv.totalWeightG)
    : sumWt;

  // -------- Total row (light grey band, black text — matches header) --
  const TOTAL_H = 24;
  // Page-break check for the TOTAL row itself, in case the last data
  // row filled the page.
  if (y + TOTAL_H + 40 > 800) {
    doc.addPage({ size: 'A4', margin: 24, layout: 'portrait' });
    y = 24;
    y = drawTableHeaderBand(y);
    doc.y = y;
  }
  doc.rect(X, y, innerW, TOTAL_H).fill(GREY);
  doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(11);
  let cx = X;
  cx += cols[0].w; // skip # column
  doc.text('TOTAL', cx + 4, y + 7, {
    width: cols[1].w - 8, align: 'right', lineBreak: false,
  });
  cx += cols[1].w;
  doc.text(String(sumQty), cx + 3, y + 7, {
    width: cols[2].w - 6, align: 'right', lineBreak: false,
  });
  cx += cols[2].w;
  doc.text(`${totalWt.toFixed(3)}g`, cx + 3, y + 7, {
    width: cols[3].w - 6, align: 'right', lineBreak: false,
  });
  // Wt/pc column stays blank on the total row (per-piece isn't meaningful
  // across mixed lines).
  // Column dividers on the total band (black on grey).
  doc.strokeColor(BLACK).lineWidth(0.4);
  let tdx = X;
  for (let k = 0; k < cols.length - 1; k++) {
    tdx += cols[k].w;
    doc.moveTo(tdx, y).lineTo(tdx, y + TOTAL_H).stroke();
  }
  doc.strokeColor(BLACK).lineWidth(0.6).rect(X, y, innerW, TOTAL_H).stroke();
  y += TOTAL_H + 8;

  // -------- Footer — Gate Pass No + Received by + NOTE --------
  doc.fillColor('#1f2937').font('Helvetica-Bold').fontSize(8);
  doc.text('Gate Pass No. :', X, y, { lineBreak: false });
  doc.font('Helvetica').fillColor('#374151');
  doc.text('Received by', X + innerW - 80, y, { width: 80, align: 'right', lineBreak: false });
  y += 11;

  doc.fillColor('#374151').font('Helvetica-Bold').fontSize(7);
  doc.text('NOTE :', X, y, { lineBreak: false });
  doc.font('Helvetica').fontSize(7).fillColor('#374151')
     .text('If any difference is found in Quantity, Rate etc. the same should be notified in writing within 24 hours otherwise no claim will be entertained thereafter.',
           X + 30, y, { width: innerW - 30 });
}

function drawHeaderBox(
  doc: PDFKit.PDFDocument,
  x: number, y: number, w: number, h: number,
  label: string, value: string,
) {
  doc.strokeColor('#9ca3af').lineWidth(0.6).rect(x, y, w, h).stroke();
  doc.fillColor('#374151').font('Helvetica-Bold').fontSize(8.5)
     .text(label, x + 6, y + 4, { width: w - 12 });
  doc.fillColor('#1f2937').font('Helvetica-Bold').fontSize(11)
     .text(value, x + 6, y + 18, { width: w - 12, lineBreak: false });
}

/** From / To box — party name on the same line as the label, address
 *  below in smaller regular text. Used on the delivery challan panel. */
function drawPartyBox(
  doc: PDFKit.PDFDocument,
  x: number, y: number, w: number, h: number,
  label: string, name: string, address: string,
) {
  // Grey header band with black text (matches operator's preference —
  // no dark bands, only text stays black).
  const BLACK = '#000000';
  const GREY  = '#e5e7eb';
  const BAR_H = 20;
  // Header bar
  doc.rect(x, y, w, BAR_H).fill(GREY);
  // Cleaned label ("From :" → "FROM", "To :" → "TO" uppercase).
  const uppercase = label.replace(/[^A-Za-z]/g, '').toUpperCase();
  doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(11)
     .text(uppercase, x, y + 5, { width: w, align: 'center', lineBreak: false });
  // Outer border wraps both the header bar and the content area.
  doc.strokeColor(BLACK).lineWidth(0.75).rect(x, y, w, h).stroke();
  // Content area — company name bold, address regular below.
  doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(11)
     .text(name, x + 8, y + BAR_H + 6, { width: w - 16, lineBreak: false });
  if (address) {
    doc.fillColor(BLACK).font('Helvetica').fontSize(9)
       .text(address, x + 8, y + BAR_H + 20, { width: w - 16 });
  }
}

/** Inline label + value box — label on the left, value beside it on the
 *  same baseline. Used for Order No / Challan No / Date rows so those
 *  read as "CHALLAN No.  DC0001" instead of stacked. */
function drawInlineBox(
  doc: PDFKit.PDFDocument,
  x: number, y: number, w: number, h: number,
  label: string, value: string,
) {
  doc.strokeColor('#9ca3af').lineWidth(0.6).rect(x, y, w, h).stroke();
  doc.fillColor('#374151').font('Helvetica-Bold').fontSize(8.5)
     .text(label, x + 6, y + (h - 8.5) / 2, { width: w - 12, lineBreak: false });
  const labelW = doc.widthOfString(label) + 12;
  doc.fillColor('#111827').font('Helvetica-Bold').fontSize(11)
     .text(value, x + 6 + labelW, y + (h - 11) / 2, { width: w - 12 - labelW, lineBreak: false });
}
