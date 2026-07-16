import PDFDocument from 'pdfkit';
import { Response } from 'express';

export interface MaterialIssuePdfData {
  mode: 'ISSUE' | 'STATUS'; // ISSUE = original voucher; STATUS = current state with returns
  voucherNumber: string;
  issueDate: Date;
  vendor: { vendorCode: string; vendorName: string };
  batchNumber?: string | null;
  notes?: string | null;
  status: string;
  usage?: {
    batchNumber?: string | null;
    processName?: string | null;
    itemNumber?: number | null;
    designCode?: string | null;
    color?: string | null;
    stageQty?: number | null;
  } | null;
  lines: {
    variantCode: string;
    variantName: string;
    unit?: string | null;
    issuedQty: number;
    usedQty?: number;
    receivedQty?: number;
    pendingQty?: number;
    shortQty?: number | null;
    notes?: string | null;
  }[];
}

/** Streams a material-issue PDF voucher (issue or return-status). */
export function streamMaterialIssuePdf(res: Response, data: MaterialIssuePdfData) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const fileName = `${data.mode.toLowerCase()}-${data.voucherNumber}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
  doc.pipe(res);

  const title = data.mode === 'ISSUE' ? 'Material Issue Voucher' : 'Material Return / Status Slip';
  doc.fontSize(18).fillColor('#1d4ed8').text(title, { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#111');
  doc.text(`Voucher: ${data.voucherNumber}`);
  doc.text(`Date: ${new Date(data.issueDate).toLocaleDateString('en-IN')}`);
  doc.text(`Vendor: ${data.vendor.vendorCode} - ${data.vendor.vendorName}`);
  if (data.batchNumber) doc.text(`Linked batch: ${data.batchNumber}`);
  doc.text(`Status: ${data.status}`);
  if (data.usage) {
    doc.fillColor('#1e40af');
    const u = data.usage;
    const usageLine = [
      u.processName ? `For ${u.processName}` : '',
      u.designCode ? `Design ${u.designCode}${u.itemNumber ? ` (#${u.itemNumber})` : ''}` : '',
      u.color ? `Colour ${u.color}` : '',
      u.stageQty != null ? `${u.stageQty} pcs in production` : '',
    ].filter(Boolean).join(' · ');
    if (usageLine) doc.text(`Use: ${usageLine}`);
    doc.fillColor('#111');
  }
  doc.moveDown(0.6);

  // Choose column set per mode.
  const isStatus = data.mode === 'STATUS';
  const cols = isStatus
    ? [
        { label: '#', width: 26 },
        { label: 'Material', width: 175 },
        { label: 'Code', width: 80 },
        { label: 'Issued', width: 50 },
        { label: 'Used', width: 50 },
        { label: 'Returned', width: 60 },
        { label: 'Pending', width: 60 },
        { label: 'Short', width: 50 },
      ]
    : [
        { label: '#', width: 26 },
        { label: 'Material', width: 240 },
        { label: 'Code', width: 95 },
        { label: 'Issued Qty', width: 80 },
        { label: 'Unit', width: 60 },
      ];
  const tableWidth = cols.reduce((s, c) => s + c.width, 0);
  const startX = 40;
  let y = doc.y;

  const drawRow = (cells: string[], opts: { bold?: boolean; shade?: boolean } = {}) => {
    const rowH = 18;
    if (opts.shade) doc.rect(startX, y, tableWidth, rowH).fillColor('#eef2ff').fill();
    let x = startX;
    doc.fontSize(9).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor('#111');
    cells.forEach((c, i) => {
      doc.text(c ?? '', x + 2, y + 4, { width: cols[i].width - 4, ellipsis: true });
      x += cols[i].width;
    });
    doc.rect(startX, y, tableWidth, rowH).strokeColor('#ddd').stroke();
    y += rowH;
  };

  drawRow(cols.map((c) => c.label), { bold: true, shade: true });

  let totIssued = 0, totUsed = 0, totReturned = 0, totPending = 0, totShort = 0;
  data.lines.forEach((l, idx) => {
    if (y + 18 > 800) { doc.addPage(); y = 40; drawRow(cols.map((c) => c.label), { bold: true, shade: true }); }
    totIssued += l.issuedQty;
    totUsed += l.usedQty ?? 0;
    totReturned += l.receivedQty ?? 0;
    totPending += l.pendingQty ?? 0;
    totShort += l.shortQty ?? 0;
    const cells = isStatus
      ? [
          String(idx + 1),
          l.variantName,
          l.variantCode,
          String(l.issuedQty),
          String(l.usedQty ?? 0),
          String(l.receivedQty ?? 0),
          String(l.pendingQty ?? 0),
          l.shortQty != null ? String(l.shortQty) : '—',
        ]
      : [String(idx + 1), l.variantName, l.variantCode, String(l.issuedQty), l.unit ?? '—'];
    drawRow(cells);
  });

  // Totals row
  if (isStatus) {
    drawRow(['', 'Total', '', String(totIssued), String(totUsed), String(totReturned), String(totPending), String(totShort)], { bold: true });
  } else {
    drawRow(['', 'Total', '', String(totIssued), ''], { bold: true });
  }

  if (data.notes) {
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111').text('Notes', startX, y + 8);
    doc.font('Helvetica').text(data.notes, { width: tableWidth });
  }

  doc.end();
}
