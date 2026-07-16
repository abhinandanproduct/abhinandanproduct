/**
 * Demo seed — full silver-flow sample data so a fresh DB has something to
 * click around immediately after `npm run prisma:seed`. Idempotent on every
 * lookup so re-runs don't duplicate. Designed to mirror what an operator
 * would set up by hand on day one.
 *
 * Creates:
 *   - 1 designer vendor (TVM / Tribhuwan, supports CAM)
 *   - 1 casting vendor                     (V0002, supports Casting)
 *   - 1 filing vendor                       (supports Filing)
 *   - 1 polish vendor                       (supports Polish)
 *   - 1 plating vendor                      (supports Plating)
 *   - 1 fitting+mala vendor                 (supports Fitting + Mala)
 *   - 1 raw-material supplier               (RAW_MATERIAL_SUPPLIER)
 *   - Material variants: Silver Bar, Kadi, Pan, Tachni, Chaki, Stone Round 3mm, Moti White
 *   - Process eligibility tagged on each variant
 *   - One design TVM-001 with parts + processes + sticking BOM
 *   - Opening stock on every variant
 *
 * Run: `ts-node prisma/seed-demo-silver.ts`
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function nextCode(model: keyof typeof prisma, field: string, prefix: string, pad: number) {
  const m: any = (prisma as any)[model];
  const last = await m.findFirst({
    where: { [field]: { startsWith: prefix } },
    orderBy: { [field]: 'desc' },
    select: { [field]: true },
  });
  const seq = last ? parseInt(String(last[field]).replace(/\D/g, ''), 10) || 0 : 0;
  return `${prefix}${String(seq + 1).padStart(pad, '0')}`;
}

async function upsertVendor(spec: {
  vendorName: string;
  shortName: string;
  processCodes: string[];
}) {
  const existing = await prisma.vendor.findFirst({ where: { vendorName: spec.vendorName } });
  const vendor = existing ?? await prisma.vendor.create({
    data: {
      vendorCode: await nextCode('vendor', 'vendorCode', 'V', 4),
      vendorName: spec.vendorName,
      shortName: spec.shortName,
      status: 'ACTIVE',
    },
  });
  // Attach process roles (idempotent).
  for (const code of spec.processCodes) {
    const p = await prisma.process.findUnique({ where: { code } });
    if (!p) continue;
    await prisma.vendorProcess.upsert({
      where: { vendorId_processId: { vendorId: vendor.id, processId: p.id } },
      update: {},
      create: { vendorId: vendor.id, processId: p.id },
    });
  }
  return vendor;
}

async function upsertVariant(spec: {
  materialName: string;
  variantName: string;
  categoryName: string;
  trackByQty: boolean;
  trackByWeight: boolean;
  openingQty: number;
  openingWeight: number;
  size?: string;
  color?: string;
  unit?: string;
  vendorId: number;
  processCodes: string[]; // eligibility
  price?: number;
}) {
  const category = await prisma.materialCategory.findFirst({ where: { name: spec.categoryName } });
  const existingMat = await prisma.material.findFirst({ where: { materialName: spec.materialName } });
  const material = existingMat ?? await prisma.material.create({
    data: {
      materialCode: await nextCode('material', 'materialCode', 'M', 4),
      materialName: spec.materialName,
      categoryId: category?.id ?? null,
      unit: spec.unit ?? null,
    },
  });
  const existingVariant = await prisma.materialVariant.findFirst({
    where: { materialId: material.id, variantName: spec.variantName },
  });
  if (existingVariant) {
    // Refresh process eligibility on re-runs.
    await prisma.materialVariantProcess.deleteMany({ where: { variantId: existingVariant.id } });
    for (const code of spec.processCodes) {
      const p = await prisma.process.findUnique({ where: { code } });
      if (p) await prisma.materialVariantProcess.create({ data: { variantId: existingVariant.id, processId: p.id } });
    }
    return existingVariant;
  }
  const variantCode = await nextCode('materialVariant', 'variantCode', 'MV', 5);
  const variant = await prisma.materialVariant.create({
    data: {
      materialId: material.id,
      variantCode,
      variantName: spec.variantName,
      size: spec.size ?? null,
      color: spec.color ?? null,
      unit: spec.unit ?? null,
      trackByQty: spec.trackByQty,
      trackByWeight: spec.trackByWeight,
      stockQty: spec.openingQty,
      stockWeight: spec.openingWeight,
      status: 'ACTIVE',
      vendors: {
        create: [{
          vendorId: spec.vendorId,
          price: spec.price ?? null,
          isPreferred: true,
        }],
      },
      processes: {
        create: await Promise.all(spec.processCodes.map(async (code) => {
          const p = await prisma.process.findUnique({ where: { code } });
          return p ? { processId: p.id } : null;
        })).then((arr) => arr.filter((x): x is { processId: number } => x != null)),
      },
    },
  });
  if (spec.openingQty > 0 || spec.openingWeight > 0) {
    await prisma.stockMovement.create({
      data: {
        variantId: variant.id, type: 'IN',
        quantity: spec.openingQty, balanceAfter: spec.openingQty,
        weight: spec.openingWeight, balanceWeightAfter: spec.openingWeight,
        refType: 'opening_stock', refId: variant.id,
        note: 'Opening stock — demo seed',
      } as any,
    });
  }
  return variant;
}

async function main() {
  console.log('— demo silver seed —');

  // Vendors
  const tvm = await upsertVendor({
    vendorName: 'Tribhuwan Designs',
    shortName: 'TVM',
    processCodes: ['CAM'],
  });
  const casting = await upsertVendor({
    vendorName: 'Krishna Casting Works',
    shortName: 'KCW',
    processCodes: ['CASTING'],
  });
  const filing = await upsertVendor({
    vendorName: 'Rama Filing',
    shortName: 'RFL',
    processCodes: ['FILING', 'DIE_NUMBER'],
  });
  const polish = await upsertVendor({
    vendorName: 'Bright Polish',
    shortName: 'BPL',
    processCodes: ['POLISH', 'MAGNET', 'SAND_BLAST'],
  });
  const plating = await upsertVendor({
    vendorName: 'Silver Coat Plating',
    shortName: 'SCP',
    processCodes: ['PLATING', 'MEENA'],
  });
  const fitting = await upsertVendor({
    vendorName: 'Mala Fit Works',
    shortName: 'MFW',
    processCodes: ['KACHA_FITTING', 'FITTING_MALA', 'STICKING', 'PACKING'],
  });
  const supplier = await upsertVendor({
    vendorName: 'Mumbai Silver Supply',
    shortName: 'MSS',
    processCodes: ['RAW_MATERIAL_SUPPLIER'],
  });
  console.log('vendors ok');

  // Material variants
  const silverBar = await upsertVariant({
    materialName: 'Silver 92.5', variantName: 'Silver 92.5 Bar', categoryName: 'Silver / Metal',
    trackByQty: false, trackByWeight: true,
    openingQty: 0, openingWeight: 5000,
    unit: 'g',
    vendorId: supplier.id, price: 75,
    processCodes: ['CASTING'],
  });
  const kadi = await upsertVariant({
    materialName: 'Kadi', variantName: 'Kadi (small)', categoryName: 'Silver / Metal',
    trackByQty: true, trackByWeight: true,
    openingQty: 100, openingWeight: 50,
    unit: 'pcs',
    vendorId: supplier.id, price: 5,
    processCodes: ['FILING'],
  });
  const pan = await upsertVariant({
    materialName: 'Pan (Cadmium sheet)', variantName: 'Pan std', categoryName: 'Silver / Metal',
    trackByQty: true, trackByWeight: true,
    openingQty: 50, openingWeight: 200,
    unit: 'pcs',
    vendorId: supplier.id, price: 8,
    processCodes: ['FILING'],
  });
  const tachni = await upsertVariant({
    materialName: 'Tachni', variantName: 'Tachni std', categoryName: 'Metal Parts',
    trackByQty: true, trackByWeight: true,
    openingQty: 30, openingWeight: 60,
    unit: 'pcs',
    vendorId: supplier.id, price: 12,
    processCodes: ['FILING'],
  });
  const chaki = await upsertVariant({
    materialName: 'Chaki', variantName: 'Chaki disc', categoryName: 'Metal Parts',
    trackByQty: true, trackByWeight: true,
    openingQty: 30, openingWeight: 45,
    unit: 'pcs',
    vendorId: supplier.id, price: 10,
    processCodes: ['FILING'],
  });
  const stoneRound3 = await upsertVariant({
    materialName: 'Stone Round', variantName: 'Round 3mm White', categoryName: 'Stone',
    trackByQty: true, trackByWeight: true,
    openingQty: 500, openingWeight: 25,
    size: '3mm', color: 'White', unit: 'pcs',
    vendorId: supplier.id, price: 0.50,
    processCodes: ['KACHA_FITTING', 'STICKING', 'FITTING_MALA'],
  });
  const motiWhite = await upsertVariant({
    materialName: 'Moti', variantName: 'Pearl 4mm White', categoryName: 'Moti',
    trackByQty: true, trackByWeight: true,
    openingQty: 200, openingWeight: 8,
    size: '4mm', color: 'White', unit: 'pcs',
    vendorId: supplier.id, price: 2,
    processCodes: ['FITTING_MALA'],
  });
  console.log('variants ok');

  // Sample design TVM-001
  const existingItem = await prisma.item.findFirst({ where: { sampleDesignCode: 'TVM-001' } });
  const item = existingItem ?? await prisma.item.create({
    data: {
      sampleDesignCode: 'TVM-001',
      itemName: 'Demo Pendant Set',
      category: 'Pendant Set',
      collection: 'Demo Collection',
      designType: 'CAD',
      designerName: 'Tribhuwan',
      designerShortName: 'TVM',
      sampleStatus: 'PRODUCTION_READY',
      designCost: 200,
      sellingPrice: 2500,
      bifurcationEnabled: true,
    },
  });
  // Design parts — pendant + 2 earrings
  await prisma.itemDesignPart.deleteMany({ where: { itemId: item.id } });
  await prisma.itemDesignPart.createMany({
    data: [
      { itemId: item.id, partName: 'Pendant',  qtyPerSet: 1, weightPerPc: 5,   sortOrder: 0 },
      { itemId: item.id, partName: 'Earring',  qtyPerSet: 2, weightPerPc: 3,   sortOrder: 1 },
      { itemId: item.id, partName: 'Patti',    qtyPerSet: 1, weightPerPc: 2,   sortOrder: 2 },
    ],
  });
  // Item processes — every silver stage with the matching vendor preferred.
  await prisma.itemProcess.deleteMany({ where: { itemId: item.id } });
  const procMap: Record<string, number> = {};
  const procs = await prisma.process.findMany({ where: { status: 'ACTIVE' } });
  for (const p of procs) procMap[p.code] = p.id;

  const itemProcSpec = [
    { code: 'CAM',           vendorId: tvm.id,      cost: 200 },
    { code: 'CASTING',       vendorId: casting.id,  cost: 0.80 },
    { code: 'DIE_NUMBER',    vendorId: filing.id,   cost: 1 },
    { code: 'FILING',        vendorId: filing.id,   cost: 4 },
    { code: 'POLISH',        vendorId: polish.id,   cost: 3 },
    { code: 'KACHA_FITTING', vendorId: fitting.id,  cost: 5 },
    { code: 'MAGNET',        vendorId: polish.id,   cost: 2 },
    { code: 'SAND_BLAST',    vendorId: polish.id,   cost: 2 },
    { code: 'PLATING',       vendorId: plating.id,  cost: 0.90 },
    { code: 'MEENA',         vendorId: plating.id,  cost: 6 },
    { code: 'FITTING_MALA',  vendorId: fitting.id,  cost: 7 },
    { code: 'STICKING',      vendorId: fitting.id,  cost: 0.5 },
    { code: 'PACKING',       vendorId: fitting.id,  cost: 2 },
  ];
  let sequence = 1;
  for (const spec of itemProcSpec) {
    if (!procMap[spec.code]) continue;
    const ip = await prisma.itemProcess.create({
      data: {
        itemId: item.id,
        processId: procMap[spec.code],
        sequence: sequence++,
        vendors: {
          create: [{
            vendorId: spec.vendorId,
            costPerPiece: spec.cost,
            isPreferred: true,
          }],
        },
      },
    });
    if (spec.code === 'CASTING') {
      await prisma.itemProcessAttribute.create({
        data: { itemProcessId: ip.id, attrKey: 'weight', attrValue: '13' },
      });
    }
  }

  // Sticking BOM — 4 stones per piece, white colour.
  await prisma.itemMaterial.deleteMany({ where: { itemId: item.id } });
  const stickingProcId = procMap['STICKING'];
  if (stickingProcId) {
    await prisma.itemMaterial.create({
      data: {
        itemId: item.id,
        processId: stickingProcId,
        variantId: stoneRound3.id,
        color: 'White',
        quantity: 4,
        weight: 0.2,
      },
    });
  }

  console.log('design TVM-001 ok');
  console.log('— demo seed complete —');
  console.log('Login admin / admin123 to play with TVM-001 + the configured vendors.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
