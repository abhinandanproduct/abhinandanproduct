/* eslint-disable no-console */
/**
 * Apply opening stock from quantity-update.tsv to the imported materials.
 *
 * Improvements over v1:
 *  • When only qty is given, stockWeight is computed as qty × per-unit weight
 *    (per-unit weight comes from raw_materials.json — the original import).
 *    Previously stockWeight got zeroed out for qty-only rows. v2 is the
 *    truthful one — re-run on top of v1 corrects it.
 *  • Fuzzy match: normalises whitespace + punctuation before comparing names,
 *    so "Pati No. 7 (Flower Shape)" matches "Pati No. 7(Flower Shape)".
 *  • Creates NEW variants when the row maps to a parent material that exists
 *    but the size/qualifier is new (Kadi 5mm, Kadi 4mm, Tar 0.95 gage,
 *    Kadi Tar 0.77 gage).
 *  • Creates brand-new Material + Variant for the Group A items the operator
 *    confirmed (Ball nos 39-43, Casting Surojitbhai batches, To-be-melt Metal,
 *    etc.).
 *
 * USAGE
 *   ts-node scripts/update-stock.ts             # dry-run
 *   ts-node scripts/update-stock.ts --apply     # actually update
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

// Spelling aliases for cases where the live DB has a typo'd material name
// (we don't want to rename the live row — it's referenced by BOMs etc. — but
// we do want the TSV row to find its target). The KEY is what's typed in
// the TSV; the VALUE is the canonical DB name to match against.
const NAME_ALIASES: Record<string, string> = {
  'ball no. 28 para ball small (tilak shape)': 'Ball no. 28 Para Ball Small (Tilok Shape)',
};

// Parent materials that gain new variants (existing material, new size/variant).
const NEW_VARIANTS_OF_EXISTING: Array<{
  parentMaterialName: string;
  variantName: string;
  size?: string;
  qty: number;
  weight?: number; // grams total override
}> = [
  { parentMaterialName: 'Kadi (Jada)', variantName: 'Kadi 5mm', size: '5mm', qty: 1430 },
  { parentMaterialName: 'Kadi (Jada)', variantName: 'Kadi 4mm', size: '4mm', qty: 1875 },
  { parentMaterialName: 'Tar', variantName: 'Tar 0.95 gage', size: '0.95 gage', qty: 0, weight: 121.1 },
  { parentMaterialName: 'Kadi Tar', variantName: 'Kadi Tar 0.77 gage', size: '0.77 gage', qty: 16, weight: 0 },
];

// Group A — brand-new Materials + Variants not in the original DB at all.
const NEW_MATERIALS: Array<{
  materialName: string;
  size?: string;
  qty: number;
  weight: number; // total grams in stock
  notes?: string;
}> = [
  { materialName: 'Ball no. 39 (Round Shape)',        qty: 111, weight: 0 },
  { materialName: 'Ball no. 40 (Round Chapta Shape)', qty: 122, weight: 0 },
  { materialName: 'Ball no. 41 (Pati Chapta Shape)',  qty: 156, weight: 0 },
  { materialName: 'Ball no. 42 (Flower Shape)',       qty: 49,  weight: 0 },
  { materialName: 'Ball no. 43 (Flower Ring Shape)',  qty: 41,  weight: 0 },
  { materialName: 'Ball no. 20 (Design Rd Para New)', qty: 395, weight: 200.28 },
  { materialName: '1514 Casting Surojitbhai',         qty: 0,   weight: 448.50, notes: 'Includes 28.34g + 420.16g' },
  { materialName: '1531 Casting Surojitbhai',         qty: 0,   weight: 64.17 },
  { materialName: '1551 Casting Surojitbhai',         qty: 0,   weight: 135.31 },
  { materialName: '1509 Casting Surojitbhai',         qty: 0,   weight: 130.07 },
  { materialName: '1519 Casting Surojitbhai',         qty: 0,   weight: 46.83 },
  { materialName: '1510 Casting Surojitbhai',         qty: 0,   weight: 15.44 },
  { materialName: 'To be melt Metal',                 qty: 0,   weight: 1906.29 },
  { materialName: 'Old Ready Designs',                qty: 17,  weight: 762.93 },
  { materialName: 'Para Ball Patti',                  qty: 0,   weight: 29.07 },
  { materialName: 'Silver Metal Powder',              qty: 0,   weight: 247.31 },
  { materialName: '1552 Rejection Pc',                qty: 1,   weight: 51.31 },
  { materialName: 'Plain Chain Patla',                qty: 0,   weight: 41.25 },
  { materialName: 'extra patti',                      qty: 0,   weight: 7.85 },
  { materialName: '10*15mm Tilak Foil Glass Vilandi', size: '10*15mm', qty: 98, weight: 0 },
  { materialName: 'Pati No. 7 (Flower Shape)', qty: 553, weight: 0 },
];

interface ParsedRow {
  raw: string;
  name: string;
  qty: number;
  weight: number; // total grams parsed from TSV (0 = not provided)
}

/** Strict normaliser used for the main lookup. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Fuzzy normaliser — strips all whitespace + non-alphanumeric for match
 *  cases where the source data has missing/extra spaces. */
function fuzzy(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseValue(v: string): { qty: number; weight: number } {
  const s = (v ?? '').trim();
  if (!s) return { qty: 0, weight: 0 };
  const gMatch = s.match(/^([\d.]+)\s*g\s*$/i);
  if (gMatch) return { qty: 0, weight: parseFloat(gMatch[1]) };
  const setMatch = s.match(/^([\d.]+)\s*sets?\s*$/i);
  if (setMatch) return { qty: parseFloat(setMatch[1]), weight: 0 };
  const n = parseFloat(s);
  if (Number.isFinite(n)) return { qty: n, weight: 0 };
  return { qty: 0, weight: 0 };
}

async function main() {
  console.log(`\n=== update-stock v2 ${APPLY ? '[APPLY]' : '[DRY-RUN]'} ===\n`);

  const tsvPath = path.join(__dirname, 'quantity-update.tsv');
  const tsv = fs.readFileSync(tsvPath, 'utf8');
  const rows: ParsedRow[] = [];
  for (const raw of tsv.split('\n')) {
    if (!raw.trim()) continue;
    const parts = raw.split('\t');
    const name = (parts[0] ?? '').trim();
    if (!name) continue;
    const qv = parseValue(parts[1] ?? '');
    const wv = parseValue(parts[2] ?? '');
    rows.push({ raw, name, qty: qv.qty, weight: qv.weight + wv.weight });
  }
  console.log(`Parsed ${rows.length} rows`);

  // Per-unit weight lookup from raw_materials.json so qty-only rows get
  // their stockWeight back instead of being zeroed.
  const rawMatJ = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../SilverERP_Export/raw_json/raw_materials.json'), 'utf8'),
  ) as any[];
  const perUnitByName = new Map<string, number>();
  for (const r of rawMatJ) {
    const k = fuzzy(r.material_name ?? '');
    if (!k) continue;
    perUnitByName.set(k, Number(r.weight ?? 0));
  }

  const allMats = await prisma.material.findMany({
    select: {
      id: true,
      materialName: true,
      variants: { select: { id: true, variantCode: true, variantName: true, size: true, stockQty: true, stockWeight: true } },
    },
  });

  // Two indexes — strict + fuzzy — both pointing to (material, single-variant id).
  const strictIdx = new Map<string, { mat: typeof allMats[0]; variantId: number }>();
  const fuzzyIdx = new Map<string, { mat: typeof allMats[0]; variantId: number }>();
  for (const m of allMats) {
    if (m.variants.length === 1) {
      strictIdx.set(normalize(m.materialName), { mat: m, variantId: m.variants[0].id });
      fuzzyIdx.set(fuzzy(m.materialName), { mat: m, variantId: m.variants[0].id });
    } else {
      for (const v of m.variants) {
        const k = normalize(`${m.materialName} ${v.size ?? ''}`);
        strictIdx.set(k, { mat: m, variantId: v.id });
        fuzzyIdx.set(fuzzy(`${m.materialName} ${v.size ?? ''}`), { mat: m, variantId: v.id });
      }
    }
  }

  type Update = { variantId: number; name: string; newQty: number; newWt: number; perUnit: number };
  const updates: Update[] = [];
  const unmatched: ParsedRow[] = [];

  for (const row of rows) {
    // Apply spelling alias (TSV name → canonical DB name) before matching.
    const aliasKey = normalize(row.name);
    const aliasedName = NAME_ALIASES[aliasKey] ?? row.name;
    let hit = strictIdx.get(normalize(aliasedName)) ?? fuzzyIdx.get(fuzzy(aliasedName));
    // Last-resort: tail-match (variant name starts with material name + size).
    if (!hit) {
      const fk = fuzzy(row.name);
      for (const m of allMats) {
        const base = fuzzy(m.materialName);
        if (fk.startsWith(base)) {
          const tail = fk.slice(base.length);
          for (const v of m.variants) {
            if (!tail) { hit = { mat: m, variantId: m.variants[0].id }; break; }
            if (fuzzy(v.size ?? '') === tail || fuzzy(v.variantName ?? '') === fk) {
              hit = { mat: m, variantId: v.id };
              break;
            }
          }
          if (hit) break;
        }
      }
    }
    if (!hit) { unmatched.push(row); continue; }

    const perUnit = perUnitByName.get(fuzzy(hit.mat.materialName)) ?? 0;
    // Weight rule: if user typed a weight, use that as the TOTAL. Otherwise
    // compute total = qty × per-unit. This is the fix for v1's zeroing bug.
    const computedWt = row.weight > 0
      ? row.weight
      : (perUnit > 0 ? Math.round(row.qty * perUnit * 1000) / 1000 : 0);

    updates.push({
      variantId: hit.variantId,
      name: hit.mat.materialName,
      newQty: Math.round(row.qty),
      newWt: computedWt,
      perUnit,
    });
  }

  console.log(`Matched ${updates.length} | Unmatched ${unmatched.length}`);
  if (unmatched.length) {
    console.log('\nUNMATCHED (treating as new materials only if in NEW_MATERIALS list):');
    for (const u of unmatched) console.log(`  ? "${u.name}" — qty=${u.qty}, weight=${u.weight}g`);
  }

  if (!APPLY) {
    console.log('\nDRY-RUN — pass --apply to write.');
    return;
  }

  // ---- Apply matched updates ----
  let updateCount = 0;
  for (const u of updates) {
    await prisma.materialVariant.update({
      where: { id: u.variantId },
      data: { stockQty: u.newQty, stockWeight: u.newWt },
    });
    await prisma.stockMovement.create({
      data: {
        variantId: u.variantId,
        type: 'IN',
        quantity: u.newQty,
        balanceAfter: u.newQty,
        weight: u.newWt,
        balanceWeightAfter: u.newWt,
        refType: 'opening_stock_v2',
        refId: u.variantId,
        note: `Stock set from quantity-update.tsv v2`,
      },
    });
    updateCount++;
  }
  console.log(`\nUpdated ${updateCount} existing variants.`);

  // ---- Create new variants under existing materials ----
  let nextMVN = (await prisma.materialVariant.count()) + 1;
  for (const nv of NEW_VARIANTS_OF_EXISTING) {
    let parent = allMats.find((m) => fuzzy(m.materialName) === fuzzy(nv.parentMaterialName));
    if (!parent) {
      // Parent doesn't exist — create it on the fly so we have a home for the variant.
      const code = 'M' + String((await prisma.material.count()) + 1).padStart(4, '0');
      const created = await prisma.material.create({
        data: { materialCode: code, materialName: nv.parentMaterialName, status: 'ACTIVE' },
      });
      parent = { id: created.id, materialName: nv.parentMaterialName, variants: [] };
    }
    const variantCode = 'MV' + String(nextMVN++).padStart(5, '0');
    const newWt = nv.weight ?? 0;
    const newQty = Math.round(nv.qty);
    const v = await prisma.materialVariant.create({
      data: {
        materialId: parent.id,
        variantCode,
        variantName: nv.variantName,
        size: nv.size ?? null,
        unit: 'pcs',
        status: 'ACTIVE',
        trackByQty: true,
        trackByWeight: true,
        stockQty: newQty,
        stockWeight: newWt,
      },
    });
    if (newQty > 0 || newWt > 0) {
      await prisma.stockMovement.create({
        data: {
          variantId: v.id, type: 'IN',
          quantity: newQty, balanceAfter: newQty,
          weight: newWt, balanceWeightAfter: newWt,
          refType: 'opening_stock_v2', refId: v.id,
          note: 'New variant via update-stock v2',
        },
      });
    }
    console.log(`+ new variant under "${parent.materialName}": ${variantCode} ${nv.variantName} (${newQty}pc, ${newWt}g)`);
  }

  // ---- Create brand-new materials (Group A) ----
  let nextMatN = (await prisma.material.count()) + 1;
  for (const nm of NEW_MATERIALS) {
    const code = 'M' + String(nextMatN++).padStart(4, '0');
    const material = await prisma.material.create({
      data: { materialCode: code, materialName: nm.materialName, notes: nm.notes ?? null, status: 'ACTIVE' },
    });
    const variantCode = 'MV' + String(nextMVN++).padStart(5, '0');
    const v = await prisma.materialVariant.create({
      data: {
        materialId: material.id,
        variantCode,
        variantName: nm.materialName,
        size: nm.size ?? null,
        unit: 'pcs',
        status: 'ACTIVE',
        trackByQty: true,
        trackByWeight: true,
        stockQty: Math.round(nm.qty),
        stockWeight: nm.weight,
      },
    });
    if (nm.qty > 0 || nm.weight > 0) {
      await prisma.stockMovement.create({
        data: {
          variantId: v.id, type: 'IN',
          quantity: Math.round(nm.qty), balanceAfter: Math.round(nm.qty),
          weight: nm.weight, balanceWeightAfter: nm.weight,
          refType: 'opening_stock_v2', refId: v.id,
          note: 'New material via update-stock v2',
        },
      });
    }
    console.log(`+ new material ${code}/${variantCode} "${nm.materialName}" (${nm.qty}pc, ${nm.weight}g)`);
  }

  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
