/* eslint-disable no-console */
/**
 * One-shot SilverERP → Abhinandan ERP import.
 *
 * Reads the export folder at /SilverERP_Export and creates:
 *   - 17 Vendors (merged by name; types[] → VendorProcess junction; inhouse flag)
 *   - ~224 Materials + MaterialVariants (with opening stock from Quantity.xlsx)
 *   - 31 Items from designs.json (sampleDesignCode = "SJ-XXXX")
 *     - 23 of which also get itemNumber from finished_goods.json
 *     - 51 extra Items from orphan finished_goods (no design_id) where
 *       sampleDesignCode = itemNumber = SKU
 *   - ItemMaterials from finished_goods.bom (154 of 156 lines resolve)
 *   - Photos copied to backend/uploads/{items,materials}/ and imagePath wired
 *
 * USAGE
 *   ts-node scripts/import-silvererp.ts             # dry-run (no DB writes)
 *   ts-node scripts/import-silvererp.ts --apply     # actually insert
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import * as xlsx from 'xlsx';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const EXPORT_DIR = path.resolve(__dirname, '../../SilverERP_Export');
const UPLOADS_DIR = path.resolve(__dirname, '../uploads');

// ---------- Mappings ----------

// SilverERP vendor role → our Process.code. Tree Making + Assembling skipped
// per spec — those vendors still get a row, just no VendorProcess link.
const ROLE_TO_PROCESS: Record<string, string | null> = {
  'CAD': 'CAD',
  'CAM': 'CAM',
  'Casting': 'CASTING',
  'Filing': 'FILING',
  'Polishing': 'POLISH',
  'Plating': 'PLATING',
  'Raw Material': 'RAW_MATERIAL_SUPPLIER',
  'Tree Making': null,
  'Assembling': null,
};

// ---------- Helpers ----------

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(EXPORT_DIR, 'raw_json', file), 'utf8'));
}

/** Slug match used by SilverERP for raw-material photo filenames. */
function sanitizeForPhoto(name: string): string {
  return (name ?? '').replace(/[^A-Za-z0-9._-]+/g, '-');
}

function parseNum(v: any): number {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function num3(n: number) { return Math.round(n * 1000) / 1000; }

interface Report {
  vendors: { ok: number; merged: number };
  materials: { ok: number; withStock: number };
  items: { fromDesignsWithFG: number; fromDesignsOnly: number; fromOrphanFG: number };
  bomLines: { resolved: number; dropped: number };
  photos: { items: number; materials: number; missing: string[] };
  warnings: string[];
}

const report: Report = {
  vendors: { ok: 0, merged: 0 },
  materials: { ok: 0, withStock: 0 },
  items: { fromDesignsWithFG: 0, fromDesignsOnly: 0, fromOrphanFG: 0 },
  bomLines: { resolved: 0, dropped: 0 },
  photos: { items: 0, materials: 0, missing: [] },
  warnings: [],
};

/** Copy a photo from the source export folder to backend/uploads/<bucket>/<basename>. */
function copyPhoto(srcRelative: string, destBucket: 'items' | 'materials', basename: string): string | null {
  const src = path.join(EXPORT_DIR, srcRelative);
  if (!fs.existsSync(src)) return null;
  const ext = path.extname(src) || '.jpeg';
  const safe = sanitizeForPhoto(basename);
  const destDir = path.join(UPLOADS_DIR, destBucket);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, `${safe}${ext}`);
  if (APPLY) fs.copyFileSync(src, dest);
  // Stored as relative bucket path WITHOUT the "uploads/" prefix — the
  // frontend's fileUrl() helper prepends "/uploads/" itself, so storing
  // "uploads/..." would double the prefix.
  return `${destBucket}/${safe}${ext}`;
}

// ---------- Main ----------

async function main() {
  console.log(`\n=== import-silvererp ${APPLY ? '[APPLY]' : '[DRY-RUN]'} ===\n`);

  // Load sources
  const vendorsJ = readJson<any[]>('vendors.json');
  const designsJ = readJson<any[]>('designs.json');
  const rawMatJ = readJson<any[]>('raw_materials.json');
  const fgJ = readJson<any[]>('finished_goods.json');
  console.log('Loaded:', vendorsJ.length, 'vendors |', designsJ.length, 'designs |',
              rawMatJ.length, 'raw_materials |', fgJ.length, 'finished_goods');

  // Quantity.xlsx — opening stock per material_name → qty
  const wb = xlsx.readFile(path.join(EXPORT_DIR, 'Quantity.xlsx'));
  const ws = wb.Sheets[wb.SheetNames[0]];
  const qtyRows = xlsx.utils.sheet_to_json<any>(ws, { defval: null });
  const qtyByName = new Map<string, number>();
  for (const r of qtyRows) {
    const name = (r.NAME ?? '').toString().trim().toLowerCase();
    const q = parseNum(r.QTY);
    if (name && q > 0) qtyByName.set(name, q);
  }
  console.log('Loaded Quantity.xlsx —', qtyByName.size, 'materials with non-zero stock');

  // Processes lookup
  const processes = await prisma.process.findMany();
  const procByCode = new Map(processes.map((p) => [p.code, p]));
  for (const code of Object.values(ROLE_TO_PROCESS).filter(Boolean) as string[]) {
    if (!procByCode.has(code)) {
      throw new Error(`Process ${code} missing — seed it first.`);
    }
  }

  // Existing tracker variants — preserve, don't recreate.
  const trackerVariants = await prisma.materialVariant.findMany({
    where: { variantCode: { in: ['LOSS-SILVER', 'RUNNERS-SILVER'] } },
  });
  console.log('Tracker variants:', trackerVariants.map((t) => t.variantCode).join(', '));

  // ============================================================
  // 1. Vendors — merge by name (case-insensitive), union types[]
  // ============================================================
  const vendorByName = new Map<string, { row: any; types: Set<string>; ids: string[]; isOutsource: boolean }>();
  for (const v of vendorsJ) {
    const key = (v.name ?? '').trim().toLowerCase();
    if (!key) continue;
    const cur = vendorByName.get(key);
    if (cur) {
      report.vendors.merged++;
      for (const t of (v.types ?? [])) cur.types.add(t);
      cur.ids.push(v.id);
      // Prefer the outsource=true row's flag if any of the merged rows say so.
      if (v.is_outsource_vendor) cur.isOutsource = true;
    } else {
      vendorByName.set(key, {
        row: v,
        types: new Set(v.types ?? []),
        ids: [v.id],
        isOutsource: !!v.is_outsource_vendor,
      });
    }
  }
  console.log(`\nVendors: ${vendorsJ.length} source rows → ${vendorByName.size} unique (after merging ${report.vendors.merged} duplicates)`);

  // SilverERP UUID → our new vendor id (one merged row can answer multiple UUIDs)
  const vendorIdByOldUUID = new Map<string, number>();

  // Vendor code generator — sequential V0001+ since we just wiped.
  let nextVendorN = 1;
  for (const [key, entry] of vendorByName.entries()) {
    const row = entry.row;
    const code = 'V' + String(nextVendorN++).padStart(4, '0');
    const types = [...entry.types];
    const procIds = types
      .map((t) => ROLE_TO_PROCESS[t])
      .filter(Boolean)
      .map((c) => procByCode.get(c as string)!.id);
    // shortName — required only when one of the linked processes flags it.
    // We don't have shortName in the source; auto-fill from name initials so
    // CAD vendors still satisfy the requiresShortName guard.
    const needsShort = procIds.some((id) => processes.find((p) => p.id === id)?.requiresShortName);
    const initials = row.name.split(/\s+/).map((w: string) => w[0]).join('').toUpperCase().slice(0, 4) || 'X';
    const shortName = needsShort ? initials : null;
    console.log(`  + ${code} ${row.name.padEnd(20)} types=[${types.join(',')}] short=${shortName ?? '—'} inhouse=${!entry.isOutsource}`);
    let createdId = 0;
    if (APPLY) {
      const created = await prisma.vendor.create({
        data: {
          vendorCode: code,
          vendorName: row.name,
          shortName,
          isInhouse: !entry.isOutsource,
          mobile: row.phone ?? null,
          email: row.email ?? null,
          address: row.address ?? null,
          status: 'ACTIVE',
          processes: { create: procIds.map((processId) => ({ processId })) },
        },
      });
      createdId = created.id;
    } else {
      createdId = nextVendorN; // fake id for dry-run map
    }
    for (const oldId of entry.ids) vendorIdByOldUUID.set(oldId, createdId);
    report.vendors.ok++;
  }

  // ============================================================
  // 2. Materials + Variants — one Material per raw_material row
  // ============================================================
  console.log(`\nMaterials: importing ${rawMatJ.length} rows`);
  const variantIdByMaterialUUID = new Map<string, number>();
  let nextMatN = 1;
  let nextMVN = trackerVariants.length + 1;
  const rawMaterialPhotosDir = path.join(EXPORT_DIR, 'raw_material_photos');
  const rawPhotoFiles = fs.existsSync(rawMaterialPhotosDir) ? fs.readdirSync(rawMaterialPhotosDir) : [];

  for (const r of rawMatJ) {
    const name = (r.material_name ?? '').trim();
    if (!name) continue;
    const code = 'M' + String(nextMatN++).padStart(4, '0');
    const vendorId = r.vendor_id ? vendorIdByOldUUID.get(r.vendor_id) ?? null : null;
    const weightPerUnit = parseNum(r.weight); // grams/unit
    const stockQty = qtyByName.get(name.toLowerCase()) ?? 0;
    const stockWeight = num3(stockQty * weightPerUnit);
    if (stockQty > 0) report.materials.withStock++;

    // Photo — first match starting with sanitized name in raw_material_photos/
    const sanitized = sanitizeForPhoto(name);
    const photoFile = rawPhotoFiles.find((f) => f.startsWith(`${sanitized}_photo`));
    const imagePath = photoFile ? copyPhoto(`raw_material_photos/${photoFile}`, 'materials', name) : null;
    if (photoFile) report.photos.materials++;

    const variantCode = 'MV' + String(nextMVN++).padStart(5, '0');
    // Do NOT auto-generate variantName by concatenating size + material name —
    // operator wants to set this explicitly. Use the raw material name as-is
    // and let them rename in the variant form when needed.
    const variantName = name;
    console.log(`  + ${code}/${variantCode} ${name.padEnd(28)} ${r.size ?? '—'} | stock=${stockQty}pc × ${weightPerUnit}g = ${stockWeight}g | photo=${photoFile ?? '—'}`);

    if (APPLY) {
      const material = await prisma.material.create({
        data: {
          materialCode: code,
          materialName: name,
          unit: r.unit ?? null,
          notes: r.remarks ?? null,
          status: 'ACTIVE',
        },
      });
      const variant = await prisma.materialVariant.create({
        data: {
          materialId: material.id,
          variantCode,
          variantName: variantName || name,
          size: r.size ?? null,
          unit: r.unit ?? 'pcs',
          status: 'ACTIVE',
          trackByQty: true,
          trackByWeight: true,
          stockQty,
          stockWeight,
          imagePath,
          vendors: vendorId ? { create: [{ vendorId, price: parseNum(r.price) || null, isPreferred: true }] } : undefined,
        },
      });
      variantIdByMaterialUUID.set(r.id, variant.id);
      if (stockQty > 0 || stockWeight > 0) {
        await prisma.stockMovement.create({
          data: {
            variantId: variant.id,
            type: 'IN',
            quantity: stockQty,
            balanceAfter: stockQty,
            weight: stockWeight,
            balanceWeightAfter: stockWeight,
            refType: 'opening_stock',
            refId: variant.id,
            note: 'Opening stock at SilverERP import',
          },
        });
      }
    } else {
      variantIdByMaterialUUID.set(r.id, nextMVN);
    }
    report.materials.ok++;
  }

  // ============================================================
  // 3. Items — designs (with optional FG link) + orphan FGs
  // ============================================================
  console.log(`\nItems: importing 31 designs + 51 orphan FGs`);

  const fgByDesignId = new Map<string, any>();
  const orphanFGs: any[] = [];
  for (const fg of fgJ) {
    if (fg.design_id) fgByDesignId.set(fg.design_id, fg);
    else orphanFGs.push(fg);
  }

  const designPhotosDir = path.join(EXPORT_DIR, 'design_photos');
  const designPhotoFiles = fs.existsSync(designPhotosDir) ? fs.readdirSync(designPhotosDir) : [];
  const fgPhotosDir = path.join(EXPORT_DIR, 'finished_goods_photos');
  const fgPhotoFiles = fs.existsSync(fgPhotosDir) ? fs.readdirSync(fgPhotosDir) : [];

  // Helper — pick best image for a design + FG combo
  function pickPhoto(designNum: string | null, sku: string | null): { src: string; basename: string } | null {
    // 1. FG-specific photo wins if SKU provided
    if (sku) {
      const fgMatch = fgPhotoFiles.find((f) => f.startsWith(`${sku}_`));
      if (fgMatch) return { src: `finished_goods_photos/${fgMatch}`, basename: sku };
    }
    // 2. Design photo
    if (designNum) {
      const dMatch = designPhotoFiles.find((f) => f.startsWith(`${designNum}_`));
      if (dMatch) return { src: `design_photos/${dMatch}`, basename: designNum };
    }
    return null;
  }

  // Helper — find CAD vendor of a design for ItemProcessVendor linkage
  function cadVendorForDesign(d: any): number | null {
    if (!d.cad_vendor_id) return null;
    return vendorIdByOldUUID.get(d.cad_vendor_id) ?? null;
  }

  // Walk designs first, then orphan FGs
  const itemIdByDesignUUID = new Map<string, number>();
  const itemIdByFGUUID = new Map<string, number>();
  let nextItemAbnN = 1; // for orphans without ABN-style SKU we'll fall through

  const cadProcId = procByCode.get('CAD')?.id ?? null;

  for (const d of designsJ) {
    const fg = fgByDesignId.get(d.id);
    const sku = fg?.sku ?? null;
    const designCode = d.num; // "SJ-0023"

    // Weight per piece — prefer FG's gross_weight; fall back to design's est_weight.
    const grossWeight = parseNum(fg?.gross_weight) || parseNum(d.est_weight);
    const photo = pickPhoto(designCode, sku);
    const imagePath = photo ? copyPhoto(photo.src, 'items', photo.basename) : null;
    if (photo) report.photos.items++;

    console.log(`  + ${designCode} ${sku ? '→ ' + sku : '(no FG)'} | gross=${grossWeight}g | photo=${photo?.src ?? '—'}`);

    if (APPLY) {
      const cadVid = cadVendorForDesign(d);
      const item = await prisma.item.create({
        data: {
          sampleDesignCode: designCode,
          itemName: fg?.name ?? d.name ?? designCode,
          itemNumber: sku,
          itemNumberAllocatedAt: sku ? new Date() : null,
          sampleStatus: 'PRODUCTION_READY',
          notes: buildNotesForItem(d, fg),
        },
      });
      itemIdByDesignUUID.set(d.id, item.id);
      if (fg) itemIdByFGUUID.set(fg.id, item.id);

      // ItemDesignPart — capture per-piece weight as the single "Main" part.
      // Photo lives on the part — our existing Item Master UI reads
      // ItemDesignPart.photoPath for the design's photo grid.
      if (grossWeight > 0 || imagePath) {
        await prisma.itemDesignPart.create({
          data: {
            itemId: item.id,
            partName: 'Main',
            qtyPerSet: 1,
            weightPerPc: grossWeight,
            sortOrder: 0,
            photoPath: imagePath,
          },
        });
      }

      // Also write to ItemImage so the Item Master gallery picks it up.
      if (imagePath) {
        await prisma.itemImage.create({
          data: { itemId: item.id, filePath: imagePath, isPrimary: true, sortOrder: 0 },
        });
      }

      // Wire CAD vendor → CAD process so the design's "designer" surfaces in
      // the Item Master process matrix. Per Q9 — design code stays SJ-XXXX
      // for now; later rename based on shortName uses this linkage.
      if (cadVid && cadProcId) {
        const ip = await prisma.itemProcess.create({
          data: { itemId: item.id, processId: cadProcId },
        });
        await prisma.itemProcessVendor.create({
          data: { itemProcessId: ip.id, vendorId: cadVid, isPreferred: true },
        });
      }
    }

    if (fg) report.items.fromDesignsWithFG++;
    else report.items.fromDesignsOnly++;
  }

  // Orphan FGs — sampleDesignCode = itemNumber = SKU (self-referencing code).
  for (const fg of orphanFGs) {
    const sku = fg.sku;
    const grossWeight = parseNum(fg.gross_weight);
    const photo = pickPhoto(null, sku);
    const imagePath = photo ? copyPhoto(photo.src, 'items', photo.basename) : null;
    if (photo) report.photos.items++;
    console.log(`  + ${sku} (orphan) | gross=${grossWeight}g | photo=${photo?.src ?? '—'}`);

    if (APPLY) {
      const item = await prisma.item.create({
        data: {
          sampleDesignCode: sku, // self-ref since no design linkage
          itemName: fg.name ?? sku,
          itemNumber: sku,
          itemNumberAllocatedAt: new Date(),
          sampleStatus: 'PRODUCTION_READY',
          notes: buildNotesForItem(null, fg),
        },
      });
      itemIdByFGUUID.set(fg.id, item.id);
      if (grossWeight > 0 || imagePath) {
        await prisma.itemDesignPart.create({
          data: { itemId: item.id, partName: 'Main', qtyPerSet: 1, weightPerPc: grossWeight, sortOrder: 0, photoPath: imagePath },
        });
      }
      if (imagePath) {
        await prisma.itemImage.create({
          data: { itemId: item.id, filePath: imagePath, isPrimary: true, sortOrder: 0 },
        });
      }
    }
    report.items.fromOrphanFG++;
  }

  // ============================================================
  // 4. BOM → ItemMaterial — per-FG bom array
  // ============================================================
  console.log(`\nBOM: walking ${fgJ.length} finished_goods`);
  const fallbackProcId = procByCode.get('STICKING')?.id ?? null;
  const droppedBOMRows: Array<{ sku: string; entry: any }> = [];

  for (const fg of fgJ) {
    const itemId = itemIdByFGUUID.get(fg.id);
    if (!itemId && APPLY) {
      report.warnings.push(`No Item created for FG ${fg.sku} — skipping BOM`);
      continue;
    }
    if (!Array.isArray(fg.bom)) continue;
    for (const b of fg.bom) {
      const variantId = b.materialId ? variantIdByMaterialUUID.get(b.materialId) : null;
      if (!variantId) {
        report.bomLines.dropped++;
        droppedBOMRows.push({ sku: fg.sku, entry: b });
        continue;
      }
      report.bomLines.resolved++;
      if (APPLY && fallbackProcId && itemId) {
        await prisma.itemMaterial.create({
          data: {
            itemId,
            variantId,
            processId: fallbackProcId,
            quantity: parseNum(b.qty) || 1,
            wastagePercent: 0,
            unit: 'pcs',
          },
        });
      }
    }
  }

  // ============================================================
  // 5. Report
  // ============================================================
  const reportPath = path.join(__dirname, '..', 'import-report.csv');
  const lines: string[] = [];
  lines.push('section,key,value');
  lines.push(`summary,vendors_imported,${report.vendors.ok}`);
  lines.push(`summary,vendors_merged_duplicates,${report.vendors.merged}`);
  lines.push(`summary,materials_imported,${report.materials.ok}`);
  lines.push(`summary,materials_with_opening_stock,${report.materials.withStock}`);
  lines.push(`summary,items_design_with_fg,${report.items.fromDesignsWithFG}`);
  lines.push(`summary,items_design_only,${report.items.fromDesignsOnly}`);
  lines.push(`summary,items_orphan_fg,${report.items.fromOrphanFG}`);
  lines.push(`summary,bom_lines_resolved,${report.bomLines.resolved}`);
  lines.push(`summary,bom_lines_dropped,${report.bomLines.dropped}`);
  lines.push(`summary,item_photos_attached,${report.photos.items}`);
  lines.push(`summary,material_photos_attached,${report.photos.materials}`);
  for (const w of report.warnings) lines.push(`warning,,"${w.replace(/"/g, '""')}"`);
  for (const d of droppedBOMRows) {
    lines.push(`bom_dropped,${d.sku},"${JSON.stringify(d.entry).replace(/"/g, '""')}"`);
  }
  if (APPLY) fs.writeFileSync(reportPath, lines.join('\n'));
  console.log(`\n=== Summary ===`);
  console.log(lines.slice(1, 12).map((l) => '  ' + l).join('\n'));
  console.log(`\nWarnings: ${report.warnings.length}`);
  if (APPLY) console.log(`Report: ${reportPath}`);
  else console.log(`(DRY-RUN — no DB writes, no photos copied. Pass --apply to run.)`);
}

function buildNotesForItem(d: any, fg: any): string | null {
  const notes: string[] = [];
  if (d?.specs) notes.push(`Specs: ${d.specs}`);
  if (d?.pinterest_link) notes.push(`Pinterest: ${d.pinterest_link}`);
  if (d?.mode) notes.push(`Mode: ${d.mode}`);
  if (fg?.dye_number) notes.push(`Dye No: ${fg.dye_number}`);
  if (fg?.labour_charge != null) notes.push(`Labour: ₹${fg.labour_charge}`);
  if (fg?.description) notes.push(`Desc: ${fg.description}`);
  if (fg?.net_weight) notes.push(`Net weight (legacy): ${fg.net_weight}g`);
  return notes.length ? notes.join(' · ') : null;
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
