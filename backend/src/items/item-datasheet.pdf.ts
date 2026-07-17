import PDFDocument from 'pdfkit';
import { Response } from 'express';
import { join, resolve } from 'path';
import { existsSync } from 'fs';

/**
 * Item Datasheet PDF — A4 portrait. Top ~30% is the design photo centered;
 * the rest is a blank-form layout with one section per manufacturing
 * process (Casting, Plating, Antique, Meena, Kacha Fitting, Sticking,
 * Fitting, Mala, Packing). Fields are blank LINES the employee fills in
 * by hand while inspecting the design / discussing with karigars. The
 * data they collect on this sheet then gets transcribed into the system
 * via Item Master.
 *
 * Layout mirrors the system's input fields exactly so transcription is
 * straightforward: e.g. Casting has Weight / Solder / Fitting / Vendor;
 * Sticking has Colour / Material / Rate per Stone / Vendor; etc.
 *
 * Colour-using processes (Plating, Meena, Sticking, Fitting, Mala) render
 * a multi-row TABLE so multiple colour variants of one design can be
 * captured on separate rows. Non-colour processes keep the single inline
 * blank-line format.
 */

export interface ItemDatasheetData {
  itemNumber: string | null;
  sampleDesignCode: string;
  designerName: string | null;
  category: string | null;
  subcategory: string | null;
  collection: string | null;
  imagePath: string | null;   // relative path under /uploads
}

// Page constants. Margins tightened from 36→24pt to give the form 24
// extra pts of vertical room — the whole sheet has to fit on ONE A4
// page so an employee can print + carry it without dealing with a
// second sheet.
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 24;
const CONTENT_W = PAGE_W - MARGIN * 2;
const LEFT = MARGIN;
const RIGHT = PAGE_W - MARGIN;
const BOTTOM = PAGE_H - MARGIN;

const COLOR_TEXT = '#000000';
const COLOR_LABEL = '#444444';
const COLOR_LINE = '#000000';
const COLOR_LIGHT = '#bbbbbb';

export function streamItemDatasheetPdf(res: Response, data: ItemDatasheetData) {
  const doc = new PDFDocument({
    size: [PAGE_W, PAGE_H],
    margins: { top: MARGIN, bottom: 4, left: MARGIN, right: MARGIN },
    bufferPages: true,
  });

  // Filename per user spec: <itemNumber>_details.pdf. Falls back to the
  // sample design code if the item has no item number yet (draft state).
  const sanitize = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  const baseName = sanitize(data.itemNumber ?? data.sampleDesignCode ?? 'item');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${baseName}_details.pdf"`);
  doc.pipe(res);

  let y = MARGIN;

  // Item identifier row jumps straight to the top — the previous company
  // header (PRATIK PRODUCTS / address / DESIGN DATASHEET title) was
  // wasted vertical real estate on a handwritten form; sheet goes
  // directly to the identifying row so employees see immediately what
  // design they're filling in.
  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR_TEXT)
    .text(`Item #: ${data.itemNumber ?? '—'}`, LEFT, y, { width: CONTENT_W / 3, lineBreak: false });
  doc.text(`Design Code: ${data.sampleDesignCode ?? '—'}`, LEFT + CONTENT_W / 3, y, { width: CONTENT_W / 3, lineBreak: false });
  // Date blank line so employees can stamp the sheet when they fill it in
  doc.font('Helvetica').fontSize(9).fillColor(COLOR_LABEL)
    .text('Date: ___________________', LEFT + (2 * CONTENT_W) / 3, y, { width: CONTENT_W / 3, lineBreak: false, align: 'right' });
  y += 14;

  // ── PHOTO BLOCK ──────────────────────────────────────────────────────
  // Photo is the dominant element at the top of the sheet so the karigar
  // floor can identify the design at a glance. 150×360 — shorter and
  // wider (landscape-ish); the freed ~30pt vertical room is reinvested
  // into the colour tables for the colour-using processes below.
  const photoH = 150;
  const photoW = 360;
  const photoX = LEFT + (CONTENT_W - photoW) / 2;
  doc.strokeColor(COLOR_LIGHT).lineWidth(0.5).rect(photoX, y, photoW, photoH).stroke();
  if (data.imagePath) {
    const uploadDir = process.env.UPLOAD_DIR ?? 'uploads';
    // `resolve` so an absolute UPLOAD_DIR (e.g. `/data/uploads`) is honored.
    const absPath = join(resolve(process.cwd(), uploadDir), data.imagePath);
    if (existsSync(absPath)) {
      try {
        // `fit` scales to fit inside the box preserving aspect ratio, with
        // `align: center, valign: center` centering both dims.
        doc.image(absPath, photoX, y, { fit: [photoW, photoH], align: 'center', valign: 'center' });
      } catch {
        // PDFKit fails on some image formats (e.g. WEBP). Fall through to
        // the placeholder label so the sheet still renders.
        doc.fillColor(COLOR_LABEL).fontSize(9).font('Helvetica-Oblique')
          .text('(image could not be rendered — paste a printout here)', photoX, y + photoH / 2 - 6, { width: photoW, align: 'center', lineBreak: false });
      }
    } else {
      doc.fillColor(COLOR_LABEL).fontSize(9).font('Helvetica-Oblique')
        .text('(no design image on file — paste a printout here)', photoX, y + photoH / 2 - 6, { width: photoW, align: 'center', lineBreak: false });
    }
  } else {
    doc.fillColor(COLOR_LABEL).fontSize(9).font('Helvetica-Oblique')
      .text('(no design image on file — paste a printout here)', photoX, y + photoH / 2 - 6, { width: photoW, align: 'center', lineBreak: false });
  }
  y += photoH + 8;

  // ── PROCESS-WISE BLANK FORM ──────────────────────────────────────────
  // Non-colour processes (Casting, Antique, Kacha Fitting, Packing) use
  // ONE ROW: process name in bold at the left + all fields flowing inline
  // to the right on the SAME line.
  //
  // Colour-using processes (Plating, Meena, Sticking, Fitting, Mala) use
  // a multi-row colour TABLE so multiple colour variants of one design
  // (e.g. Gold/Rhodium plating; Red/Green/Blue meena) can each be filled
  // on their own row. Same column-only style as BOM tables.
  //
  // BOM-having processes get a column-only table beneath for handwritten
  // material entries.
  type Field = { label: string; width: number };
  type TableCol = { label: string; w: number };
  // BOM layout per section:
  //  - 'sideBySide' — two mini-tables next to each other (Kacha Fitting,
  //    Fitting, Packing). Drops the noisy Notes column so the three
  //    useful columns (Material / Qty / Rate) get more breathing room.
  //  - 'colourMatrix' — ONE joined Excel-style matrix used by Sticking.
  //    Material names go down the left; the rest of the width splits
  //    into 4 colour groups, each with Qty / Rate sub-columns. The TOP
  //    row of each colour group is a blank "Colour: ___" slot the
  //    karigar fills in by hand. Reads as a single coherent block —
  //    much cleaner than 4 disconnected mini-tables.
  type BomLayout = 'sideBySide' | 'colourMatrix';
  type Section = {
    title: string;
    fields?: Field[];       // inline blank lines on the same row as title
    colorTable?: {          // multi-row colour table (replaces inline fields)
      cols: TableCol[];
      rows: number;         // number of body rows (not counting header)
    };
    bomRows?: number;       // rows PER mini-table for the BOM block
    bomLayout?: BomLayout;
  };

  // Layout budget. The process-name slot at the left is fixed-width
  // (90pt); the remaining width splits across the fields per section.
  const NAME_W = 90;
  const FIELDS_W = CONTENT_W - NAME_W;
  // Helper: evenly divide remaining width across N fields.
  const eq = (n: number) => FIELDS_W / n;

  // Section order: Casting → Plating → Antique → Meena → Kacha Fitting →
  // Fitting → Mala → Sticking → Packing. Sticking sits LATE in the
  // sequence because its joined colour-matrix is the biggest BOM block
  // on the page; placing it just before Packing keeps the eye flowing
  // top-to-bottom without surprise BOMs in the middle.
  const sections: Section[] = [
    {
      title: 'CASTING',
      fields: [
        { label: 'Weight (g)', width: eq(5) },
        { label: 'Solder', width: eq(5) },
        { label: 'Fitting', width: eq(5) },
        { label: 'Vendor', width: eq(5) },
        { label: 'Rate / kg', width: eq(5) },
      ],
    },
    {
      // Plating colour table: 2 rows × Colour · Weight · Rate · Vendor.
      // Weight here is the piece weight AFTER plating (each colour can
      // settle at a slightly different weight). Trimmed to 2 rows to
      // keep vertical room for the joined Sticking matrix below; most
      // designs use a single plating colour anyway.
      title: 'PLATING',
      colorTable: {
        cols: [
          { label: 'Colour',     w: FIELDS_W / 4 },
          { label: 'Weight (g)', w: FIELDS_W / 4 },
          { label: 'Rate',       w: FIELDS_W / 4 },
          { label: 'Vendor',     w: FIELDS_W / 4 },
        ],
        rows: 2,
      },
    },
    {
      title: 'ANTIQUE',
      fields: [
        { label: 'Weight (g)', width: FIELDS_W / 3 },
        { label: 'Rate',       width: FIELDS_W / 3 },
        { label: 'Vendor',     width: FIELDS_W / 3 },
      ],
    },
    {
      // Meena colour table: 3 rows × Colour · Rate · Vendor
      title: 'MEENA',
      colorTable: {
        cols: [
          { label: 'Colour', w: FIELDS_W / 3 },
          { label: 'Rate',   w: FIELDS_W / 3 },
          { label: 'Vendor', w: FIELDS_W / 3 },
        ],
        rows: 3,
      },
    },
    {
      // Side-by-side BOM (no Notes col) — 2 mini-tables × 2 rows = 4 slots
      title: 'KACHA FITTING',
      fields: [
        { label: 'Vendor',   width: FIELDS_W / 2 },
        { label: 'Rate / pc', width: FIELDS_W / 2 },
      ],
      bomRows: 2,
      bomLayout: 'sideBySide',
    },
    {
      // Fitting colour table + side-by-side BOM (no Notes col)
      title: 'FITTING',
      colorTable: {
        cols: [
          { label: 'Colour', w: FIELDS_W / 3 },
          { label: 'Rate',   w: FIELDS_W / 3 },
          { label: 'Vendor', w: FIELDS_W / 3 },
        ],
        rows: 3,
      },
      bomRows: 2,
      bomLayout: 'sideBySide',
    },
    {
      // Mala colour table: 3 rows × Colour · Vendor · Rate / pc
      title: 'MALA',
      colorTable: {
        cols: [
          { label: 'Colour',   w: FIELDS_W / 3 },
          { label: 'Vendor',   w: FIELDS_W / 3 },
          { label: 'Rate / pc', w: FIELDS_W / 3 },
        ],
        rows: 3,
      },
    },
    {
      // Sticking colour table (Colour / Vendor / Rate per stone) on top
      // for the per-colour meta info, joined Excel-style colour matrix
      // below for the per-colour material lists. Both trimmed from
      // earlier sizes to claw back vertical room for taller inline rows
      // and bigger inter-section gaps:
      //   colour table 3 → 2 rows (matches Plating's row count)
      //   matrix bodyRows 8 → 6 → 24 stone slots across 4 colours
      title: 'STICKING',
      colorTable: {
        cols: [
          { label: 'Colour',      w: FIELDS_W / 3 },
          { label: 'Vendor',      w: FIELDS_W / 3 },
          { label: 'Rate / stone', w: FIELDS_W / 3 },
        ],
        rows: 2,
      },
      bomRows: 6,
      bomLayout: 'colourMatrix',
    },
    {
      title: 'PACKING',
      fields: [
        { label: 'Vendor',   width: FIELDS_W / 2 },
        { label: 'Rate / pc', width: FIELDS_W / 2 },
      ],
      bomRows: 2,
      bomLayout: 'sideBySide',
    },
  ];

  // Inline field — label tucked high at the top of the row (yRow+2),
  // underline parked low at yRow+22. That leaves ~13pt of clean white
  // space between the label and the underline so the employee can
  // actually write the value above the line without the label crowding
  // their pen. Row is 24pt total (was 20pt previously).
  const drawField = (label: string, x: number, w: number, yRow: number) => {
    doc.font('Helvetica').fontSize(6.5).fillColor(COLOR_LABEL)
      .text(label, x, yRow + 2, { width: w - 4, lineBreak: false });
    doc.strokeColor(COLOR_LINE).lineWidth(0.5)
      .moveTo(x, yRow + 22).lineTo(x + w - 6, yRow + 22).stroke();
  };

  // Column-only table renderer — shared by both BOM tables and colour
  // tables. Draws a header row + N empty body rows; separators are
  // VERTICAL ONLY (column dividers + outer rect + header underline) so
  // the inside is open whitespace for handwritten entries.
  // xOrigin defaults to LEFT (full-width BOM tables); colour tables pass
  // LEFT + NAME_W and a narrower width.
  const drawColumnTable = (
    cols: TableCol[],
    rows: number,
    xOrigin: number = LEFT,
    totalW: number = CONTENT_W,
  ) => {
    const rowH = 11;
    const tableTop = y;
    let x = xOrigin;
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(COLOR_TEXT);
    for (const c of cols) {
      doc.text(c.label, x + 2, y + 2, { width: c.w - 4, lineBreak: false });
      x += c.w;
    }
    y += rowH;
    y += rowH * rows;
    doc.strokeColor(COLOR_LINE).lineWidth(0.5);
    doc.moveTo(xOrigin, tableTop).lineTo(xOrigin + totalW, tableTop).stroke();
    doc.moveTo(xOrigin, y).lineTo(xOrigin + totalW, y).stroke();
    doc.moveTo(xOrigin, tableTop + rowH).lineTo(xOrigin + totalW, tableTop + rowH).stroke();
    let cx = xOrigin;
    for (let i = 0; i < cols.length; i++) {
      doc.moveTo(cx, tableTop).lineTo(cx, y).stroke();
      cx += cols[i].w;
    }
    doc.moveTo(cx, tableTop).lineTo(cx, y).stroke();
  };

  // ── BOM layouts ──────────────────────────────────────────────────────
  // Notes column dropped per user spec — three useful cols only.
  const TABLE_GAP = 8;
  const smallBomCols = (tableW: number): TableCol[] => [
    { label: 'Material', w: tableW * 0.50 },
    { label: 'Qty / pc', w: tableW * 0.25 },
    { label: 'Rate',     w: tableW * 0.25 },
  ];

  // Two BOM tables side-by-side, each `rowsPerTable` rows. Used by Kacha
  // Fitting, Fitting, Packing.
  const drawSideBySideBomTable = (rowsPerTable: number) => {
    const tableW = (CONTENT_W - TABLE_GAP) / 2;
    const cols = smallBomCols(tableW);
    const startY = y;
    drawColumnTable(cols, rowsPerTable, LEFT, tableW);
    const leftEndY = y;
    y = startY;
    drawColumnTable(cols, rowsPerTable, LEFT + tableW + TABLE_GAP, tableW);
    y = Math.max(y, leftEndY);
  };

  // Sticking material table — ONE joined Excel-style matrix. Material
  // names go down the left; the rest of the width splits into 4 colour
  // groups, each with Qty / Rate sub-columns. The TOP row of each
  // colour group is a blank "Colour: ___" slot the karigar fills in
  // by hand. Reads as one coherent block — eye scans it like a normal
  // spreadsheet rather than as four disconnected mini-tables.
  const drawColourMatrixBomTable = (bodyRows: number) => {
    const GROUPS = 4;
    const rowH = 11;
    const materialW = CONTENT_W * 0.30;              // ~164pt — fits long stone names
    const groupW = (CONTENT_W - materialW) / GROUPS; // ~96pt per colour group
    const subW = groupW / 2;                         // ~48pt — Qty col / Rate col

    const tableTop = y;
    const subHeaderTop = tableTop + rowH;            // Material | Qty | Rate row
    const bodyTop = subHeaderTop + rowH;
    const tableBottom = bodyTop + rowH * bodyRows;

    // Row 0 — colour-name row. Material col is intentionally blank
    // here (the "Material" label goes in the sub-header row beneath).
    // Each colour group gets a tiny "Colour" label + underline so the
    // karigar can write the colour the group represents.
    doc.font('Helvetica').fontSize(6.5).fillColor(COLOR_LABEL);
    let cx = LEFT + materialW;
    for (let g = 0; g < GROUPS; g++) {
      doc.text('Colour', cx + 3, tableTop + 3, { width: 22, lineBreak: false });
      doc.strokeColor(COLOR_LINE).lineWidth(0.5)
        .moveTo(cx + 26, tableTop + 9).lineTo(cx + groupW - 4, tableTop + 9).stroke();
      cx += groupW;
    }

    // Row 1 — sub-header. "Material" on the left, then Qty / Rate
    // for each colour group.
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(COLOR_TEXT)
      .text('Material', LEFT + 2, subHeaderTop + 2, { width: materialW - 4, lineBreak: false });
    cx = LEFT + materialW;
    for (let g = 0; g < GROUPS; g++) {
      doc.text('Qty / pc', cx + 2, subHeaderTop + 2, { width: subW - 4, lineBreak: false });
      doc.text('Rate', cx + subW + 2, subHeaderTop + 2, { width: subW - 4, lineBreak: false });
      cx += groupW;
    }

    // Strokes — outer rect first, then internal grid.
    doc.strokeColor(COLOR_LINE).lineWidth(0.5);
    doc.rect(LEFT, tableTop, CONTENT_W, tableBottom - tableTop).stroke();

    // Horizontals: under the colour-name row (only over the colour
    // groups, NOT over the Material col so Material reads as a single
    // tall left column), and under the sub-header.
    doc.moveTo(LEFT + materialW, subHeaderTop).lineTo(LEFT + CONTENT_W, subHeaderTop).stroke();
    doc.moveTo(LEFT, bodyTop).lineTo(LEFT + CONTENT_W, bodyTop).stroke();

    // Verticals: Material col separator (full height), then one
    // separator between each pair of colour groups (full height too).
    doc.moveTo(LEFT + materialW, tableTop).lineTo(LEFT + materialW, tableBottom).stroke();
    cx = LEFT + materialW;
    for (let g = 0; g < GROUPS - 1; g++) {
      cx += groupW;
      doc.moveTo(cx, tableTop).lineTo(cx, tableBottom).stroke();
    }
    // Sub-column dividers (Qty | Rate) inside each colour group. Only
    // descend from the sub-header row — NOT through the colour-name
    // row above, so each colour group's top cell reads as one merged
    // slot for the colour name.
    cx = LEFT + materialW;
    for (let g = 0; g < GROUPS; g++) {
      doc.moveTo(cx + subW, subHeaderTop).lineTo(cx + subW, tableBottom).stroke();
      cx += groupW;
    }

    y = tableBottom;
  };

  for (const section of sections) {
    if (section.colorTable) {
      // ── COLOUR-TABLE SECTION ─────────────────────────────────────────
      // Process name appears bold on the LEFT of the content area;
      // the colour table fills the RIGHT side (FIELDS_W wide).
      // Title is vertically centred over the table height.
      const { cols, rows } = section.colorTable;
      const rowH = 11;
      const tableH = rowH * (rows + 1); // header + body rows
      const titleMidY = y + tableH / 2 - 5;

      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR_TEXT)
        .text(section.title, LEFT, titleMidY, { width: NAME_W - 4, lineBreak: false });

      // Draw colour table offset to start at LEFT + NAME_W
      drawColumnTable(cols, rows, LEFT + NAME_W, FIELDS_W);

      y += 4; // small gap after colour table
    } else if (section.fields) {
      // ── INLINE FIELD SECTION (non-colour processes) ──────────────────
      // Row height bumped 20 → 24pt so the employee has real writing
      // space between the (high-tucked) field label and the underline.
      // Title sits ~mid-row to stay visually balanced with the taller row.
      const rowTop = y;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR_TEXT)
        .text(section.title, LEFT, rowTop + 8, { width: NAME_W - 4, lineBreak: false });
      let x = LEFT + NAME_W;
      for (const field of section.fields) {
        drawField(field.label, x, field.width, rowTop);
        x += field.width;
      }
      y = rowTop + 24;
      y += 2; // small gap before optional BOM / divider (trimmed from 4)
    }

    // Optional BOM beneath the section. 2pt gap above, 6pt below.
    if (section.bomRows && section.bomRows > 0) {
      y += 2;
      if (section.bomLayout === 'colourMatrix') {
        drawColourMatrixBomTable(section.bomRows);
      } else {
        drawSideBySideBomTable(section.bomRows);
      }
      y += 6;
    } else {
      y += 2;
    }

    // Faint divider between processes. 6pt gap below (was 4) so adjacent
    // sections don't visually crowd each other — the bottom half of the
    // page (Kacha Fitting → Fitting → Mala → Sticking → Packing) was
    // reading congested with only 4pt of breathing room.
    doc.strokeColor(COLOR_LIGHT).lineWidth(0.4)
      .moveTo(LEFT, y).lineTo(RIGHT, y).stroke();
    y += 6;
  }

  // Notes block REMOVED — page ends at the Packing section.

  // Footer
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.font('Helvetica-Oblique').fontSize(7).fillColor(COLOR_LABEL)
      .text(`Generated by Pratik Products ERP · ${data.itemNumber ?? data.sampleDesignCode}   ·   Page ${i + 1} of ${range.count}`,
        LEFT, PAGE_H - 16, { width: CONTENT_W, align: 'center', lineBreak: false });
  }

  doc.end();
}
