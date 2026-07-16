/**
 * Seed 3 fully-detailed demo item masters so the new categorize / dispatch /
 * warehouse flow can be tested end-to-end.
 *
 * Each demo item has:
 *   - All taxonomy fields filled (category / subcategory / collection /
 *     designer / sample status / design + selling price / notes)
 *   - Every manufacturing process configured (CASTING through PACKING) with
 *     vendor rows and per-vendor rates
 *   - Multiple plating colours per item so categorize has interesting buckets
 *   - BOM rows for KACHU_FITTING / STICKING / FITTING / PACKING
 *   - Colour-model rows (a / b / c) tying each colour combo together
 *
 * Run:  npx ts-node prisma/seed-demo-items.ts
 *
 * Idempotent — re-running upserts the items in place.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function ensureVendor(name: string, short: string, codes: string[]) {
  let vendor = await prisma.vendor.findFirst({ where: { vendorName: name } });
  if (!vendor) {
    const seqRow = await prisma.vendor.findFirst({ orderBy: { id: 'desc' } });
    const nextCode = `V${String((seqRow?.id ?? 0) + 1).padStart(4, '0')}`;
    vendor = await prisma.vendor.create({
      data: { vendorCode: nextCode, vendorName: name, shortName: short },
    });
  }
  for (const code of codes) {
    const proc = await prisma.process.findUnique({ where: { code } });
    if (!proc) continue;
    await prisma.vendorProcess.upsert({
      where: { vendorId_processId: { vendorId: vendor.id, processId: proc.id } },
      update: {},
      create: { vendorId: vendor.id, processId: proc.id },
    });
  }
  return vendor;
}

async function ensureMaterialCategory(name: string) {
  let cat = await prisma.materialCategory.findFirst({ where: { name } });
  if (!cat) cat = await prisma.materialCategory.create({ data: { name } });
  return cat;
}

async function ensureMaterial(args: {
  categoryName: string;
  materialName: string;
  variantCode: string;
  variantName: string;
  unit?: string;
  pricePerUnit?: number;
}) {
  const category = await ensureMaterialCategory(args.categoryName);
  let mat = await prisma.material.findFirst({ where: { materialName: args.materialName, categoryId: category.id } });
  if (!mat) {
    // Auto-generate a materialCode from the name: "Cubic Zirconia" → "CZIRC"
    const code = args.materialName
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '')
      .slice(0, 8);
    let materialCode = code;
    let attempt = 0;
    while (await prisma.material.findUnique({ where: { materialCode } })) {
      attempt++;
      materialCode = `${code}${attempt}`;
    }
    mat = await prisma.material.create({
      data: { materialCode, materialName: args.materialName, categoryId: category.id, unit: args.unit ?? 'pc' },
    });
  }
  let variant = await prisma.materialVariant.findFirst({ where: { variantCode: args.variantCode } });
  if (!variant) {
    variant = await prisma.materialVariant.create({
      data: {
        materialId: mat.id,
        variantCode: args.variantCode,
        variantName: args.variantName,
        unit: args.unit ?? 'pc',
      },
    });
  }
  return variant;
}

async function getProcess(code: string) {
  const p = await prisma.process.findUnique({ where: { code } });
  if (!p) throw new Error(`Process ${code} not seeded. Run prisma/seed.ts first.`);
  return p;
}

type ProcVendorRow = {
  processCode: string;
  vendorId: number;
  color?: string;
  costPerPiece?: number;
  isPreferred?: boolean;
  vendorDesignReference?: string;
};

async function upsertItem(args: {
  sampleDesignCode: string;
  itemNumber: string;
  itemName: string;
  category: string;
  subcategory: string;
  collection: string;
  designerName: string;
  designerShortName: string;
  notes: string;
  designCost: number;
  sellingPrice: number;
  procVendors: ProcVendorRow[];
  attributes: Record<string, Record<string, string>>;
  materials: Array<{ processCode: string; variantId: number; quantity: number; rate?: number; color?: string }>;
  colorModels: Array<{ letter: string; name: string; price: number; processColors: Record<string, string> }>;
}) {
  // Upsert top-level Item row.
  const item = await prisma.item.upsert({
    where: { sampleDesignCode: args.sampleDesignCode },
    update: {
      itemNumber: args.itemNumber, itemName: args.itemName, category: args.category,
      subcategory: args.subcategory, collection: args.collection, notes: args.notes,
      designerName: args.designerName, designerShortName: args.designerShortName,
      designCost: args.designCost, sellingPrice: args.sellingPrice,
      designType: 'CAD',
      sampleStatus: 'PRODUCTION_READY',
    },
    create: {
      sampleDesignCode: args.sampleDesignCode,
      itemNumber: args.itemNumber, itemName: args.itemName, category: args.category,
      subcategory: args.subcategory, collection: args.collection, notes: args.notes,
      designerName: args.designerName, designerShortName: args.designerShortName,
      designCost: args.designCost, sellingPrice: args.sellingPrice,
      designType: 'CAD',
      sampleStatus: 'PRODUCTION_READY',
    },
  });

  // Wipe existing process/material/colorModel rows on rerun so the seed is
  // truly idempotent and changes to this script are picked up.
  await prisma.itemMaterial.deleteMany({ where: { itemId: item.id } });
  await prisma.itemColorModel.deleteMany({ where: { itemId: item.id } });
  // Cascade deletes ItemProcessVendor + ItemProcessAttribute when processes go.
  await prisma.itemProcess.deleteMany({ where: { itemId: item.id } });

  // Create ItemProcess rows, then vendor rows, then attributes.
  const processByCode = new Map<string, { id: number }>();
  const procs = await prisma.process.findMany({ where: { code: { in: Array.from(new Set(args.procVendors.map((p) => p.processCode))) } } });
  procs.forEach((p) => processByCode.set(p.code, p));

  // We need ONE ItemProcess per process; ItemProcessVendor rows attach to it.
  const ipIdByCode = new Map<string, number>();
  for (const [code, p] of processByCode) {
    const ip = await prisma.itemProcess.create({
      data: { itemId: item.id, processId: p.id, notes: `Demo seeded ${code}.` },
    });
    ipIdByCode.set(code, ip.id);
    // Attach EAV attributes if any.
    const attrs = args.attributes[code];
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        await prisma.itemProcessAttribute.create({
          data: { itemProcessId: ip.id, attrKey: k, attrValue: v },
        });
      }
    }
  }

  // Now create vendor rows (multi-colour where given).
  for (const pv of args.procVendors) {
    const ipId = ipIdByCode.get(pv.processCode);
    if (!ipId) continue;
    await prisma.itemProcessVendor.create({
      data: {
        itemProcessId: ipId,
        vendorId: pv.vendorId,
        color: pv.color ?? null,
        costPerPiece: pv.costPerPiece ?? null,
        isPreferred: pv.isPreferred ?? false,
        vendorDesignReference: pv.vendorDesignReference ?? null,
      },
    });
  }

  // BOM rows.
  for (const m of args.materials) {
    const p = processByCode.get(m.processCode);
    if (!p) continue;
    await prisma.itemMaterial.create({
      data: {
        itemId: item.id,
        variantId: m.variantId,
        processId: p.id,
        color: m.color ?? null,
        quantity: m.quantity,
        rate: m.rate ?? null,
      },
    });
  }

  // Colour models tying per-process colour choices to a sellable variant.
  for (const cm of args.colorModels) {
    const cmRow = await prisma.itemColorModel.create({
      data: {
        itemId: item.id,
        letter: cm.letter,
        name: cm.name,
        sellingPrice: cm.price,
      },
    });
    for (const [code, color] of Object.entries(cm.processColors)) {
      const p = processByCode.get(code);
      if (!p) continue;
      await prisma.itemColorModelProcess.create({
        data: { colorModelId: cmRow.id, processId: p.id, color },
      });
    }
  }

  console.log(`✓ ${args.sampleDesignCode} (${args.itemNumber}) — ${args.itemName}`);
  return item;
}

async function main() {
  // ── Vendors ───────────────────────────────────────────────────────────────
  const castingV = await ensureVendor('Demo Casting Co.', 'DCC', ['CASTING']);
  const platingV = await ensureVendor('Shine Plating Works', 'SPW', ['PLATING']);
  const antiqueV = await ensureVendor('Demo Antique Finishers', 'DAF', ['ANTIQUE']);
  const meenaV   = await ensureVendor('Color Meena Studio', 'CMS', ['MEENA']);
  const kachaV   = await ensureVendor('Kacha Fit Karigars', 'KFK', ['KACHU_FITTING']);
  const fittingV = await ensureVendor('Fitting Karigar Hub', 'FKH', ['FITTING']);
  const malaV    = await ensureVendor('Mala Stringing Co.', 'MSC', ['MALA']);
  const stickV   = await ensureVendor('Sticking Karigars', 'SKK', ['STICKING']);
  const packV    = await ensureVendor('Final Pack Hub', 'FPH', ['PACKING']);

  // ── Materials (BOM-friendly stones / jumprings / boxes) ───────────────────
  const stoneRuby   = await ensureMaterial({ categoryName: 'Stones',     materialName: 'Cubic Zirconia',   variantCode: 'CZ-RUBY-3',  variantName: 'Ruby red 3mm',   unit: 'pc', pricePerUnit: 0.08 });
  const stoneEmer   = await ensureMaterial({ categoryName: 'Stones',     materialName: 'Cubic Zirconia',   variantCode: 'CZ-EMER-3',  variantName: 'Emerald green 3mm', unit: 'pc', pricePerUnit: 0.09 });
  const stoneSapph  = await ensureMaterial({ categoryName: 'Stones',     materialName: 'Cubic Zirconia',   variantCode: 'CZ-SAPPH-3', variantName: 'Sapphire blue 3mm', unit: 'pc', pricePerUnit: 0.09 });
  const pearlWhite  = await ensureMaterial({ categoryName: 'Pearls',     materialName: 'Faux pearl',       variantCode: 'PEARL-W-5',  variantName: 'White 5mm',      unit: 'pc', pricePerUnit: 0.4 });
  const jumpring    = await ensureMaterial({ categoryName: 'Findings',   materialName: 'Jump ring',        variantCode: 'JR-BR-4',    variantName: 'Brass 4mm',      unit: 'pc', pricePerUnit: 0.2 });
  const earpost     = await ensureMaterial({ categoryName: 'Findings',   materialName: 'Ear post',         variantCode: 'EP-BR-12',   variantName: 'Brass 12mm',     unit: 'pc', pricePerUnit: 0.5 });
  const boxSmall    = await ensureMaterial({ categoryName: 'Packing',    materialName: 'Inner box',        variantCode: 'BOX-S',      variantName: 'Small velvet box', unit: 'pc', pricePerUnit: 4 });
  const tagPaper    = await ensureMaterial({ categoryName: 'Packing',    materialName: 'Hangtag',          variantCode: 'TAG-P',      variantName: 'Paper hangtag',  unit: 'pc', pricePerUnit: 0.3 });

  // ── Item 1: Necklace · multi-plating (Gold + Rhodium) ─────────────────────
  await upsertItem({
    sampleDesignCode: 'DEMO-NK-001',
    itemNumber: 'DEMO-N1',
    itemName: 'Royal Layered Necklace',
    category: 'Necklace',
    subcategory: 'Layered',
    collection: 'Demo Royal Collection',
    designerName: 'Tarun Mehta',
    designerShortName: 'TVM',
    notes: 'Demo necklace seeded for end-to-end dispatch testing — 2 plating colours so the categorize page shows two buckets.',
    designCost: 850,
    sellingPrice: 3200,
    procVendors: [
      { processCode: 'CASTING',       vendorId: castingV.id, costPerPiece: 950, isPreferred: true, vendorDesignReference: 'DCC-RYL-01' },
      { processCode: 'PLATING',       vendorId: platingV.id, color: 'Gold',     costPerPiece: 110, isPreferred: true },
      { processCode: 'PLATING',       vendorId: platingV.id, color: 'Rhodium',  costPerPiece: 130 },
      { processCode: 'ANTIQUE',       vendorId: antiqueV.id, costPerPiece: 80,  isPreferred: true },
      { processCode: 'MEENA',         vendorId: meenaV.id,   color: 'Red',      costPerPiece: 60,  isPreferred: true },
      { processCode: 'MEENA',         vendorId: meenaV.id,   color: 'Green',    costPerPiece: 60 },
      { processCode: 'KACHU_FITTING', vendorId: kachaV.id,   costPerPiece: 15,  isPreferred: true },
      { processCode: 'FITTING',       vendorId: fittingV.id, color: 'Gold',     costPerPiece: 22,  isPreferred: true },
      { processCode: 'FITTING',       vendorId: fittingV.id, color: 'Rhodium',  costPerPiece: 24 },
      { processCode: 'MALA',          vendorId: malaV.id,    color: 'Gold',     costPerPiece: 30,  isPreferred: true },
      { processCode: 'STICKING',      vendorId: stickV.id,   color: 'Gold',     costPerPiece: 0.08, isPreferred: true },
      { processCode: 'STICKING',      vendorId: stickV.id,   color: 'Rhodium',  costPerPiece: 0.08 },
      { processCode: 'PACKING',       vendorId: packV.id,    costPerPiece: 6,   isPreferred: true },
    ],
    attributes: {
      CASTING: { weight: '18', metal_type: 'Brass', solder: 'soldered', fitting: 'with kacha' },
      PLATING: { weight: '18.4' },
      ANTIQUE: { weight: '18.4' },
    },
    materials: [
      { processCode: 'KACHU_FITTING', variantId: jumpring.id, quantity: 4 },
      { processCode: 'STICKING',      variantId: stoneRuby.id,  quantity: 20, color: 'Gold' },
      { processCode: 'STICKING',      variantId: pearlWhite.id, quantity: 6,  color: 'Gold' },
      { processCode: 'STICKING',      variantId: stoneSapph.id, quantity: 22, color: 'Rhodium' },
      { processCode: 'FITTING',       variantId: jumpring.id,   quantity: 2 },
      { processCode: 'PACKING',       variantId: boxSmall.id,   quantity: 1 },
      { processCode: 'PACKING',       variantId: tagPaper.id,   quantity: 1 },
    ],
    colorModels: [
      { letter: 'a', name: 'Royal Gold',    price: 3200, processColors: { PLATING: 'Gold',    MEENA: 'Red',   FITTING: 'Gold',    MALA: 'Gold', STICKING: 'Gold' } },
      { letter: 'b', name: 'Royal Rhodium', price: 3400, processColors: { PLATING: 'Rhodium', MEENA: 'Green', FITTING: 'Rhodium', MALA: 'Gold', STICKING: 'Rhodium' } },
    ],
  });

  // ── Item 2: Earrings · single plating but 3 sticking colours ─────────────
  await upsertItem({
    sampleDesignCode: 'DEMO-ER-002',
    itemNumber: 'DEMO-E2',
    itemName: 'Festival Stud Earrings',
    category: 'Earring',
    subcategory: 'Stud',
    collection: 'Demo Festival Collection',
    designerName: 'Tarun Mehta',
    designerShortName: 'TVM',
    notes: 'Demo studs — single plating colour, three sticking colour variants. Useful for testing per-colour BOM in Sticking.',
    designCost: 320,
    sellingPrice: 1450,
    procVendors: [
      { processCode: 'CASTING',       vendorId: castingV.id, costPerPiece: 320, isPreferred: true },
      { processCode: 'PLATING',       vendorId: platingV.id, color: 'Gold',     costPerPiece: 50,  isPreferred: true },
      { processCode: 'KACHU_FITTING', vendorId: kachaV.id,   costPerPiece: 10,  isPreferred: true },
      { processCode: 'FITTING',       vendorId: fittingV.id, color: 'Gold',     costPerPiece: 14,  isPreferred: true },
      { processCode: 'STICKING',      vendorId: stickV.id,   color: 'Red',      costPerPiece: 0.08, isPreferred: true },
      { processCode: 'STICKING',      vendorId: stickV.id,   color: 'Green',    costPerPiece: 0.08 },
      { processCode: 'STICKING',      vendorId: stickV.id,   color: 'Blue',     costPerPiece: 0.08 },
      { processCode: 'PACKING',       vendorId: packV.id,    costPerPiece: 5,   isPreferred: true },
    ],
    attributes: {
      CASTING: { weight: '4', metal_type: 'Brass', solder: 'soldered', fitting: 'with kacha' },
      PLATING: { weight: '4.1' },
    },
    materials: [
      { processCode: 'KACHU_FITTING', variantId: earpost.id,    quantity: 2 },
      { processCode: 'STICKING',      variantId: stoneRuby.id,  quantity: 6, color: 'Red' },
      { processCode: 'STICKING',      variantId: stoneEmer.id,  quantity: 6, color: 'Green' },
      { processCode: 'STICKING',      variantId: stoneSapph.id, quantity: 6, color: 'Blue' },
      { processCode: 'FITTING',       variantId: jumpring.id,   quantity: 2 },
      { processCode: 'PACKING',       variantId: boxSmall.id,   quantity: 1 },
      { processCode: 'PACKING',       variantId: tagPaper.id,   quantity: 1 },
    ],
    colorModels: [
      { letter: 'a', name: 'Red Gold',   price: 1450, processColors: { PLATING: 'Gold', FITTING: 'Gold', STICKING: 'Red' } },
      { letter: 'b', name: 'Green Gold', price: 1450, processColors: { PLATING: 'Gold', FITTING: 'Gold', STICKING: 'Green' } },
      { letter: 'c', name: 'Blue Gold',  price: 1450, processColors: { PLATING: 'Gold', FITTING: 'Gold', STICKING: 'Blue' } },
    ],
  });

  // ── Item 3: Bangle Set · 3 plating colours, no sticking ───────────────────
  await upsertItem({
    sampleDesignCode: 'DEMO-BG-003',
    itemNumber: 'DEMO-B3',
    itemName: 'Classic Bangle Set',
    category: 'Bangle',
    subcategory: 'Set of 4',
    collection: 'Demo Classic Collection',
    designerName: 'Tarun Mehta',
    designerShortName: 'TVM',
    notes: 'Demo bangles — 3 plating colours (Gold / Rhodium / Antique-Gold). No sticking; tests the multi-bucket categorize without BOM noise.',
    designCost: 1200,
    sellingPrice: 4800,
    procVendors: [
      { processCode: 'CASTING',       vendorId: castingV.id, costPerPiece: 1100, isPreferred: true },
      { processCode: 'PLATING',       vendorId: platingV.id, color: 'Gold',          costPerPiece: 180, isPreferred: true },
      { processCode: 'PLATING',       vendorId: platingV.id, color: 'Rhodium',       costPerPiece: 210 },
      { processCode: 'PLATING',       vendorId: platingV.id, color: 'Antique Gold',  costPerPiece: 200 },
      { processCode: 'ANTIQUE',       vendorId: antiqueV.id, costPerPiece: 120, isPreferred: true },
      { processCode: 'KACHU_FITTING', vendorId: kachaV.id,   costPerPiece: 20,  isPreferred: true },
      { processCode: 'FITTING',       vendorId: fittingV.id, color: 'Gold',          costPerPiece: 28, isPreferred: true },
      { processCode: 'FITTING',       vendorId: fittingV.id, color: 'Rhodium',       costPerPiece: 30 },
      { processCode: 'FITTING',       vendorId: fittingV.id, color: 'Antique Gold',  costPerPiece: 30 },
      { processCode: 'PACKING',       vendorId: packV.id,    costPerPiece: 9,   isPreferred: true },
    ],
    attributes: {
      CASTING: { weight: '24', metal_type: 'Brass', solder: 'soldered', fitting: 'with kacha' },
      PLATING: { weight: '24.5' },
      ANTIQUE: { weight: '24.5' },
    },
    materials: [
      { processCode: 'KACHU_FITTING', variantId: jumpring.id, quantity: 8 },
      { processCode: 'FITTING',       variantId: jumpring.id, quantity: 4 },
      { processCode: 'PACKING',       variantId: boxSmall.id, quantity: 1 },
      { processCode: 'PACKING',       variantId: tagPaper.id, quantity: 1 },
    ],
    colorModels: [
      { letter: 'a', name: 'Classic Gold',         price: 4800, processColors: { PLATING: 'Gold',         FITTING: 'Gold' } },
      { letter: 'b', name: 'Classic Rhodium',      price: 4900, processColors: { PLATING: 'Rhodium',      FITTING: 'Rhodium' } },
      { letter: 'c', name: 'Classic Antique Gold', price: 4850, processColors: { PLATING: 'Antique Gold', FITTING: 'Antique Gold' } },
    ],
  });

  console.log('\nDemo seed complete. Three items created/updated:');
  console.log('  • DEMO-NK-001 (DEMO-N1) — Royal Layered Necklace · 2 plating colours');
  console.log('  • DEMO-ER-002 (DEMO-E2) — Festival Stud Earrings · 3 sticking colours');
  console.log('  • DEMO-BG-003 (DEMO-B3) — Classic Bangle Set · 3 plating colours\n');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
