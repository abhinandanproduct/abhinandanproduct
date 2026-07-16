// Generates a one-page CAD Design Goal tracking sheet for Pintu + Aryan.
// Outputs a printable A4 PDF the operators can pin up and fill in by hand.
//
//   npx tsx scripts/generate-cad-goal-template.ts
//
// The PDF lands next to the script as `cad-goal-template.pdf`. Layout is
// tuned so all 31 daily rows + header + goal card + footer land on ONE
// A4 sheet (previously spilled to multiple pages).
import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';

const OUT = path.resolve(__dirname, 'cad-goal-template.pdf');

const doc = new PDFDocument({ size: 'A4', margin: 24, layout: 'portrait' });
doc.pipe(fs.createWriteStream(OUT));

const W = 595.28;
const M = 24;
const innerW = W - 2 * M;
const BLACK = '#000000';
const GREY  = '#e5e7eb';
const NAVY  = '#1f2937';

// ── Header banner ──────────────────────────────────────────────────
doc.rect(M, M, innerW, 32).fill(NAVY);
doc.fillColor('#fbbf24').font('Helvetica-Bold').fontSize(15)
   .text('CAD DESIGN GOAL SHEET', M, M + 5, { width: innerW, align: 'center', lineBreak: false });
doc.fillColor('#e5e7eb').font('Helvetica').fontSize(8)
   .text('Shree Abhinandan Product · Monthly CAD Production Tracker', M, M + 20, { width: innerW, align: 'center', lineBreak: false });

// ── Month / Year fill-in ───────────────────────────────────────────
let y = M + 40;
doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(10)
   .text('Month :', M, y, { lineBreak: false });
doc.strokeColor(BLACK).lineWidth(0.6)
   .moveTo(M + 45, y + 11).lineTo(M + 175, y + 11).stroke();
doc.text('Year :', M + 200, y, { lineBreak: false });
doc.moveTo(M + 235, y + 11).lineTo(M + 335, y + 11).stroke();
y += 18;

// ── Monthly goal summary card — compact single-line format ─────────
const cardH = 46;
doc.strokeColor(BLACK).lineWidth(0.75).rect(M, y, innerW, cardH).stroke();
doc.rect(M, y, innerW, 16).fill(GREY);
doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(9)
   .text('MONTHLY GOAL', M, y + 4, { width: innerW, align: 'center', lineBreak: false });

// Three columns: Pintu · Aryan · Total
const cellW = innerW / 3;
const rowY = y + 20;
doc.font('Helvetica-Bold').fontSize(10).fillColor(BLACK);
doc.text('Pintu',        M + 8,             rowY, { width: cellW - 16, lineBreak: false });
doc.text('Aryan',        M + cellW + 8,     rowY, { width: cellW - 16, lineBreak: false });
doc.text('Team Total',   M + 2 * cellW + 8, rowY, { width: cellW - 16, lineBreak: false });

doc.font('Helvetica').fontSize(8).fillColor(BLACK);
doc.text('Daily 1 · Monthly 25', M + 8,             rowY + 14, { lineBreak: false });
doc.text('Daily 2 · Monthly 50', M + cellW + 8,     rowY + 14, { lineBreak: false });
doc.text('Daily 3 · Monthly 75', M + 2 * cellW + 8, rowY + 14, { lineBreak: false });

// Column dividers inside the card body
doc.strokeColor(BLACK).lineWidth(0.5);
doc.moveTo(M + cellW,     y + 16).lineTo(M + cellW,     y + cardH).stroke();
doc.moveTo(M + 2 * cellW, y + 16).lineTo(M + 2 * cellW, y + cardH).stroke();

y += cardH + 6;

// ── Daily tracker table ────────────────────────────────────────────
// Compact column labels so the header row fits in a single line at 18pt.
const cols = [
  { label: 'Date',       w: 44, align: 'center' as const },
  { label: 'Pintu (1)',  w: 68, align: 'center' as const },
  { label: 'Aryan (2)',  w: 68, align: 'center' as const },
  { label: 'Total (3)',  w: 68, align: 'center' as const },
  { label: 'Notes / Design Codes', w: 0, align: 'left' as const },
];
const fixedW = cols.slice(0, -1).reduce((s, c) => s + c.w, 0);
cols[cols.length - 1].w = innerW - fixedW;

const HDR_H = 18;
doc.rect(M, y, innerW, HDR_H).fill(GREY);
doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(9);
let cx = M;
for (const c of cols) {
  doc.text(c.label, cx + 3, y + 5, {
    width: c.w - 6, align: c.align, lineBreak: false,
  });
  cx += c.w;
}
doc.strokeColor(BLACK).lineWidth(0.6).rect(M, y, innerW, HDR_H).stroke();
doc.lineWidth(0.4);
let dx = M;
for (let i = 0; i < cols.length - 1; i++) {
  dx += cols[i].w;
  doc.moveTo(dx, y).lineTo(dx, y + HDR_H).stroke();
}
y += HDR_H;

// 31 daily rows — sized to consume the remaining vertical space on the
// page so operators have generous cells to write in. Number is vertically
// centred within the taller row.
const ROW_H = 20;
doc.font('Helvetica').fontSize(10).fillColor(BLACK);
for (let d = 1; d <= 31; d++) {
  doc.strokeColor(BLACK).lineWidth(0.35).rect(M, y, innerW, ROW_H).stroke();
  let vdx = M;
  for (let i = 0; i < cols.length - 1; i++) {
    vdx += cols[i].w;
    doc.moveTo(vdx, y).lineTo(vdx, y + ROW_H).stroke();
  }
  doc.fillColor(BLACK).font('Helvetica').fontSize(10)
     .text(String(d), M + 3, y + (ROW_H - 10) / 2, {
       width: cols[0].w - 6, align: 'center', lineBreak: false,
     });
  y += ROW_H;
}

// ── TOTAL row — grey band ──────────────────────────────────────────
const TOT_H = 20;
doc.rect(M, y, innerW, TOT_H).fill(GREY);
doc.strokeColor(BLACK).lineWidth(0.6).rect(M, y, innerW, TOT_H).stroke();
doc.lineWidth(0.4);
let tdx = M;
for (let i = 0; i < cols.length - 1; i++) {
  tdx += cols[i].w;
  doc.moveTo(tdx, y).lineTo(tdx, y + TOT_H).stroke();
}
doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(10)
   .text('TOTAL', M + 3, y + 5, { width: cols[0].w - 6, align: 'center', lineBreak: false });
// Target reminders /25 /50 /75 tucked at the right edge of each cell.
doc.font('Helvetica').fontSize(8);
doc.text('/ 25', M + cols[0].w + cols[1].w - 22, y + 6, { lineBreak: false });
doc.text('/ 50', M + cols[0].w + cols[1].w + cols[2].w - 22, y + 6, { lineBreak: false });
doc.text('/ 75', M + cols[0].w + cols[1].w + cols[2].w + cols[3].w - 22, y + 6, { lineBreak: false });
y += TOT_H;

// ── Footer signature line ──────────────────────────────────────────
y += 12;
doc.strokeColor(BLACK).lineWidth(0.5);
doc.moveTo(M, y).lineTo(M + 160, y).stroke();
doc.moveTo(M + innerW - 160, y).lineTo(M + innerW, y).stroke();
doc.fillColor(BLACK).font('Helvetica').fontSize(8)
   .text('Pintu — Signature', M, y + 3, { width: 160, align: 'center', lineBreak: false });
doc.text('Aryan — Signature', M + innerW - 160, y + 3, { width: 160, align: 'center', lineBreak: false });

doc.end();
console.log('Wrote', OUT);
