import PDFDocument from 'pdfkit';
import { Response } from 'express';

/**
 * A4 PORTRAIT, black & white, printable on any office printer. Same visual
 * language as the karigar slip PDFs — Pratik Products header, black borders,
 * single greyscale palette, no fills. The report is one continuous statement
 * across N pages; PDFKit auto-paginates inside `tableRows()` when the row
 * cursor crosses the safe bottom.
 */
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 36;
const CONTENT_W = PAGE_W - MARGIN * 2;
const LEFT = MARGIN;
const RIGHT = PAGE_W - MARGIN;
const PAGE_BOTTOM = PAGE_H - MARGIN;
const COLOR_BORDER = '#000000';
const COLOR_TEXT = '#000000';
const COLOR_LABEL = '#333333';

const COMPANY = {
  name: 'PRATIK PRODUCTS',
  address: '210, Ashish Udhyog Bhavan, Opp SNDT College, Malad (West), Mumbai - 400064',
};

export interface VendorLedgerReportData {
  vendor: { vendorCode: string; vendorName: string };
  from: Date;
  to: Date;
  sections: {
    workDone: Array<{
      itemNumber: string | null;
      designCode: string | null;
      vendorDesignReference: string | null;
      batchNumber: string;
      processName: string;
      qty: number;
      rate: number;
      total: number;
    }>;
    underProcess: Array<{
      itemNumber: string | null;
      designCode: string | null;
      batchNumber: string;
      processName: string;
      qty: number;
      rate: number;
      total: number;
    }>;
    rejected: Array<{
      itemNumber: string | null;
      designCode: string | null;
      batchNumber: string;
      processName: string;
      qty: number;
      rate: number;
      paymentMode: string | null;
      deduction: number;
      reason: string | null;
    }>;
    shortClosed: Array<{
      itemNumber: string | null;
      designCode: string | null;
      batchNumber: string;
      processName: string;
      shortQty: number;
      rate: number;
      amount: number;
      reason: string | null;
    }>;
    repair: Array<{
      repairId: number;
      itemNumber: string | null;
      designCode: string | null;
      batchNumber: string | null;
      processName: string;
      qty: number;
      cycle: number;
      reason: string | null;
    }>;
    // Materials section — per-variant aggregation of every issue line in
    // the period. `owed` is what the vendor still owes us (net), valued
    // at master price and fed into the grand-total deduction.
    materialsOwed: Array<{
      variantCode: string;
      variantName: string;
      materialName: string;
      unit: string | null;
      issued: number;
      received: number;
      consumed: number;
      owed: number;
      masterPrice: number;
      amount: number;
    }>;
  };
  totals: {
    workDone: number;
    underProcessInfo: number;
    rejectedDeduction: number;
    shortClosedAmount: number;
    repairQty: number;
    materialsOwedAmount: number;
    grandTotalPayable: number;
  };
}

const money = (n: number) =>
  `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatDate = (d: Date) =>
  d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');

export function streamVendorLedgerReport(res: Response, data: VendorLedgerReportData) {
  const doc = new PDFDocument({
    size: [PAGE_W, PAGE_H],
    margins: { top: MARGIN, bottom: 2, left: MARGIN, right: MARGIN },
    bufferPages: true,
  });

  const fnVendor = sanitize(data.vendor.vendorName ?? data.vendor.vendorCode ?? 'vendor');
  const fnFrom = data.from.toISOString().slice(0, 10);
  const fnTo = data.to.toISOString().slice(0, 10);
  const fileName = `Vendor-Ledger-${fnVendor}-${fnFrom}-to-${fnTo}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  doc.pipe(res);

  let y = MARGIN;
  const SAFE_BOTTOM = PAGE_BOTTOM - 14;
  const ensureSpace = (needed: number, onNewPage?: () => void) => {
    if (y + needed > SAFE_BOTTOM) {
      doc.addPage();
      y = MARGIN;
      if (onNewPage) onNewPage();
    }
  };

  // --- HEADER ---
  doc.fillColor(COLOR_TEXT).font('Helvetica-Bold').fontSize(16)
    .text(COMPANY.name, LEFT, y, { width: CONTENT_W, align: 'center', lineBreak: false });
  y += 18;
  doc.fillColor(COLOR_LABEL).font('Helvetica').fontSize(8)
    .text(COMPANY.address, LEFT, y, { width: CONTENT_W, align: 'center', lineBreak: false });
  y += 12;
  doc.fillColor(COLOR_TEXT).font('Helvetica-Bold').fontSize(13)
    .text('VENDOR LEDGER REPORT', LEFT, y, { width: CONTENT_W, align: 'center', lineBreak: false });
  y += 16;
  doc.strokeColor(COLOR_BORDER).lineWidth(0.8).moveTo(LEFT, y).lineTo(RIGHT, y).stroke();
  doc.lineWidth(0.6);
  y += 8;

  // --- VENDOR + PERIOD ---
  doc.font('Helvetica-Bold').fontSize(11)
    .text(`${data.vendor.vendorCode} · ${data.vendor.vendorName}`, LEFT, y);
  doc.font('Helvetica').fontSize(9).fillColor(COLOR_LABEL)
    .text(
      `Period: ${formatDate(data.from)} — ${formatDate(data.to)}`,
      LEFT, y, { width: CONTENT_W, align: 'right', lineBreak: false },
    );
  doc.fillColor(COLOR_TEXT);
  y += 18;

  // Section renderer — generic header/table with auto-pagination.
  const sectionHeader = (label: string) => {
    ensureSpace(20);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR_TEXT)
      .text(label, LEFT, y, { width: CONTENT_W, lineBreak: false });
    y += 12;
    doc.strokeColor(COLOR_BORDER).lineWidth(0.5).moveTo(LEFT, y).lineTo(RIGHT, y).stroke();
    y += 2;
  };

  const tableRows = (
    columns: { title: string; w: number; align?: 'left' | 'right' | 'center' }[],
    rows: string[][],
    opts?: { footer?: string[] },
  ) => {
    const rowH = 14;
    // Header row
    ensureSpace(rowH + 2);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR_TEXT);
    let x = LEFT;
    for (const c of columns) {
      doc.text(c.title, x + 2, y + 3, { width: c.w - 4, align: c.align ?? 'left', lineBreak: false });
      x += c.w;
    }
    doc.rect(LEFT, y, CONTENT_W, rowH).strokeColor(COLOR_BORDER).lineWidth(0.4).stroke();
    y += rowH;

    // Body rows
    doc.font('Helvetica').fontSize(8);
    for (const r of rows) {
      ensureSpace(rowH + 2);
      x = LEFT;
      for (let i = 0; i < columns.length; i++) {
        const c = columns[i];
        doc.text(r[i] ?? '', x + 2, y + 3, {
          width: c.w - 4, align: c.align ?? 'left', lineBreak: false, ellipsis: true,
        });
        x += c.w;
      }
      doc.rect(LEFT, y, CONTENT_W, rowH).strokeColor(COLOR_BORDER).lineWidth(0.3).stroke();
      y += rowH;
    }

    // Footer (subtotal) row
    if (opts?.footer) {
      ensureSpace(rowH + 2);
      doc.font('Helvetica-Bold').fontSize(8);
      x = LEFT;
      for (let i = 0; i < columns.length; i++) {
        const c = columns[i];
        doc.text(opts.footer[i] ?? '', x + 2, y + 3, {
          width: c.w - 4, align: c.align ?? 'left', lineBreak: false,
        });
        x += c.w;
      }
      doc.rect(LEFT, y, CONTENT_W, rowH).strokeColor(COLOR_BORDER).lineWidth(0.6).stroke();
      y += rowH;
    }
    y += 8;
  };

  const emptyRow = (label: string) => {
    ensureSpace(14);
    doc.font('Helvetica-Oblique').fontSize(8).fillColor(COLOR_LABEL)
      .text(label, LEFT + 4, y);
    doc.fillColor(COLOR_TEXT);
    y += 16;
  };

  // ---------------------------------------------------------------------
  // SECTION 1 — WORK DONE
  // ---------------------------------------------------------------------
  sectionHeader('1. WORK DONE  (accepted pcs — billable)');
  const wdCols = [
    { title: 'Item #',   w: 50 },
    { title: 'Vendor Ref', w: 70 },
    { title: 'Batch #',  w: 55 },
    { title: 'Process',  w: 75 },
    { title: 'Qty',      w: 40, align: 'right' as const },
    { title: 'Rate',     w: 60, align: 'right' as const },
    { title: 'Total',    w: 73, align: 'right' as const },
  ];
  if (data.sections.workDone.length === 0) emptyRow('No accepted pcs in this period.');
  else {
    tableRows(
      wdCols,
      data.sections.workDone.map((r) => [
        r.itemNumber ?? '—',
        r.vendorDesignReference ?? '—',
        r.batchNumber,
        r.processName,
        String(r.qty),
        money(r.rate),
        money(r.total),
      ]),
      { footer: ['', '', '', '', '', 'Subtotal', money(data.totals.workDone)] },
    );
  }

  // ---------------------------------------------------------------------
  // SECTION 2 — UNDER PROCESS  (info only)
  // ---------------------------------------------------------------------
  sectionHeader('2. UNDER PROCESS  (issued, not yet returned — info only)');
  const upCols = [
    { title: 'Item #',  w: 60 },
    { title: 'Batch #', w: 60 },
    { title: 'Process', w: 95 },
    { title: 'Pending Qty', w: 70, align: 'right' as const },
    { title: 'Rate',    w: 60, align: 'right' as const },
    { title: 'Value (info)', w: 78, align: 'right' as const },
  ];
  if (data.sections.underProcess.length === 0) emptyRow('Nothing pending with this vendor in this period.');
  else {
    tableRows(
      upCols,
      data.sections.underProcess.map((r) => [
        r.itemNumber ?? '—',
        r.batchNumber,
        r.processName,
        String(r.qty),
        money(r.rate),
        money(r.total),
      ]),
      { footer: ['', '', '', '', 'Info-only subtotal', money(data.totals.underProcessInfo)] },
    );
  }

  // ---------------------------------------------------------------------
  // SECTION 3 — REJECTED  (deductions from billing)
  // ---------------------------------------------------------------------
  sectionHeader('3. REJECTED  (failed QC — deducted from billing)');
  const rjCols = [
    { title: 'Item #', w: 50 },
    { title: 'Batch #', w: 55 },
    { title: 'Process', w: 75 },
    { title: 'Qty', w: 35, align: 'right' as const },
    { title: 'Rate', w: 55, align: 'right' as const },
    { title: 'Payment Mode', w: 75 },
    { title: 'Deduction', w: 78, align: 'right' as const },
  ];
  if (data.sections.rejected.length === 0) emptyRow('No rejections in this period.');
  else {
    tableRows(
      rjCols,
      data.sections.rejected.map((r) => [
        r.itemNumber ?? '—',
        r.batchNumber,
        r.processName,
        String(r.qty),
        money(r.rate),
        r.paymentMode ?? '—',
        r.deduction > 0 ? `- ${money(r.deduction)}` : money(0),
      ]),
      { footer: ['', '', '', '', '', 'Total deduction', `- ${money(data.totals.rejectedDeduction)}`] },
    );
  }

  // ---------------------------------------------------------------------
  // SECTION 4 — SHORT-CLOSED  (vendor owes — deducted from billing)
  // ---------------------------------------------------------------------
  sectionHeader('4. SHORT-CLOSED  (vendor never delivered — owed to us)');
  const scCols = [
    { title: 'Item #', w: 50 },
    { title: 'Batch #', w: 55 },
    { title: 'Process', w: 75 },
    { title: 'Short Qty', w: 55, align: 'right' as const },
    { title: 'Rate', w: 60, align: 'right' as const },
    { title: 'Amount Owed', w: 73, align: 'right' as const },
    { title: 'Reason', w: 55 },
  ];
  if (data.sections.shortClosed.length === 0) emptyRow('No short-closed stages in this period.');
  else {
    tableRows(
      scCols,
      data.sections.shortClosed.map((r) => [
        r.itemNumber ?? '—',
        r.batchNumber,
        r.processName,
        String(r.shortQty),
        money(r.rate),
        `- ${money(r.amount)}`,
        (r.reason ?? '—').slice(0, 24),
      ]),
      { footer: ['', '', '', '', '', `- ${money(data.totals.shortClosedAmount)}`, ''] },
    );
  }

  // ---------------------------------------------------------------------
  // SECTION 5 — REPAIR  (info only — vendor fixes own defects, no charge)
  // ---------------------------------------------------------------------
  sectionHeader('5. REPAIR  (currently at vendor — vendor fixes own defects, no charge)');
  const rpCols = [
    { title: 'Repair', w: 50 },
    { title: 'Item #', w: 55 },
    { title: 'Batch #', w: 60 },
    { title: 'Process', w: 95 },
    { title: 'Qty', w: 40, align: 'right' as const },
    { title: 'Cycle', w: 40, align: 'center' as const },
    { title: 'Reason', w: 83 },
  ];
  if (data.sections.repair.length === 0) emptyRow('Nothing at repair from this vendor in this period.');
  else {
    tableRows(
      rpCols,
      data.sections.repair.map((r) => [
        `REP-${r.repairId}`,
        r.itemNumber ?? '—',
        r.batchNumber ?? '—',
        r.processName,
        String(r.qty),
        String(r.cycle),
        (r.reason ?? '—').slice(0, 36),
      ]),
      { footer: ['', '', '', '', String(data.totals.repairQty), 'pcs', 'no charge'] },
    );
  }

  // ---------------------------------------------------------------------
  // SECTION 6 — MATERIALS OWED  (issued − returned − used, valued at master price)
  // ---------------------------------------------------------------------
  sectionHeader('6. MATERIALS OWED  (issued − returned − used · valued at master price)');
  const moCols = [
    { title: 'Code', w: 45 },
    { title: 'Material / Variant', w: 130 },
    { title: 'Issued', w: 48, align: 'right' as const },
    { title: 'Returned', w: 56, align: 'right' as const },
    { title: 'Used', w: 48, align: 'right' as const },
    { title: 'Owed', w: 48, align: 'right' as const },
    { title: 'Rate', w: 50, align: 'right' as const },
    { title: 'Amount Owed', w: 0, align: 'right' as const },
  ];
  // Flex last column to fill remaining width
  const usedW = moCols.slice(0, -1).reduce((s, c) => s + c.w, 0);
  moCols[moCols.length - 1].w = Math.max(60, 523 - usedW);
  if (data.sections.materialsOwed.length === 0) emptyRow('No materials issued to this vendor in this period.');
  else {
    tableRows(
      moCols,
      data.sections.materialsOwed.map((m) => [
        m.variantCode,
        m.variantName,
        `${m.issued}${m.unit ? ' ' + m.unit : ''}`,
        `${m.received}${m.unit ? ' ' + m.unit : ''}`,
        `${m.consumed}${m.unit ? ' ' + m.unit : ''}`,
        m.owed > 0 ? `${m.owed}${m.unit ? ' ' + m.unit : ''}` : '0',
        money(m.masterPrice),
        m.amount > 0 ? `- ${money(m.amount)}` : money(0),
      ]),
      { footer: ['', '', '', '', '', '', 'Total owed', `- ${money(data.totals.materialsOwedAmount)}`] },
    );
  }

  // ---------------------------------------------------------------------
  // GRAND TOTAL — boxed, bold
  // ---------------------------------------------------------------------
  // Box height grows to fit the new "Materials owed" line.
  ensureSpace(76);
  doc.strokeColor(COLOR_BORDER).lineWidth(1).rect(LEFT, y, CONTENT_W, 68).stroke();
  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR_TEXT)
    .text('GRAND TOTAL PAYABLE', LEFT + 8, y + 8, { width: CONTENT_W - 16, lineBreak: false });
  doc.font('Helvetica').fontSize(9).fillColor(COLOR_LABEL)
    .text(`Work Done                           +${money(data.totals.workDone)}`,
      LEFT + 8, y + 22, { width: CONTENT_W - 16, lineBreak: false });
  doc.text(`Rejected deduction                  -${money(data.totals.rejectedDeduction)}`,
    LEFT + 8, y + 32, { width: CONTENT_W - 16, lineBreak: false });
  doc.text(`Short-closed (vendor owes)          -${money(data.totals.shortClosedAmount)}`,
    LEFT + 8, y + 42, { width: CONTENT_W - 16, lineBreak: false });
  doc.text(`Materials owed (vendor owes)        -${money(data.totals.materialsOwedAmount)}`,
    LEFT + 8, y + 52, { width: CONTENT_W - 16, lineBreak: false });
  // Right-aligned big total
  doc.font('Helvetica-Bold').fontSize(16).fillColor(COLOR_TEXT)
    .text(money(data.totals.grandTotalPayable),
      LEFT, y + 22, { width: CONTENT_W - 8, align: 'right', lineBreak: false });

  y += 76;

  // Footer note
  ensureSpace(20);
  doc.font('Helvetica-Oblique').fontSize(7).fillColor(COLOR_LABEL)
    .text('Generated by the Pratik Products ERP. Repair work is included for information only; vendors are not charged for fixing their own defects.',
      LEFT, y, { width: CONTENT_W, align: 'center' });

  // Page numbers
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.font('Helvetica').fontSize(7).fillColor(COLOR_LABEL)
      .text(`Page ${i + 1} of ${range.count}`,
        LEFT, PAGE_H - 14, { width: CONTENT_W, align: 'right', lineBreak: false });
  }

  doc.end();
}
