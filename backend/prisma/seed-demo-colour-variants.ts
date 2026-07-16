/**
 * Seed 5 demo material variants — one "Demo Round Stone 3mm" stone in
 * White / Ruby / Green / Pink / Blue. Lets you test the Sticking-BOM
 * "Copy from another colour" feature end-to-end:
 *
 *   1. Open an item, configure Sticking with vendors for two colours
 *      (say "White" and "Ruby"). Add a BOM row under White picking
 *      the "Demo Round Stone 3mm — White" variant.
 *   2. Switch to Ruby's BOM panel → click "Copy BOM from White".
 *      Phase 1 fires: the White row clones into Ruby with the
 *      "Demo Round Stone 3mm — Ruby" variant auto-resolved via the
 *      structural match (same materialId × size × shape × finish).
 *   3. Add a third sticking colour "Pink Blue" (combo). Add a BOM row
 *      under it picking the Pink variant + another row picking the
 *      Blue variant. Add a fourth sticking colour "Green White" →
 *      Copy-from → Pink Blue → mapping dialog opens with the
 *      Pink→Green / Blue→White defaults; click Apply.
 *
 * Run:  npx ts-node prisma/seed-demo-colour-variants.ts
 *
 * Idempotent — re-running upserts in place; existing variant rows are
 * not duplicated. Safe to run on a populated DB.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const MATERIAL_NAME = 'Demo Round Stone';
const MATERIAL_CODE = 'DEMOSTONE';
const VARIANT_SIZE = '3mm';
const VARIANT_SHAPE = 'Round';
const VARIANT_FINISH = 'Polished';
const VARIANT_UNIT = 'pc';

const COLOURS: Array<{ color: string; code: string; price: number }> = [
  { color: 'White', code: 'WHT', price: 0.08 },
  { color: 'Ruby',  code: 'RBY', price: 0.10 },
  { color: 'Green', code: 'GRN', price: 0.10 },
  { color: 'Pink',  code: 'PNK', price: 0.12 },
  { color: 'Blue',  code: 'BLU', price: 0.12 },
];

async function ensureMaterialCategory(name: string) {
  let cat = await prisma.materialCategory.findFirst({ where: { name } });
  if (!cat) cat = await prisma.materialCategory.create({ data: { name } });
  return cat;
}

async function findDefaultSupplier() {
  // Pick any active vendor — these demo variants just need a supplier
  // attached so the variant form's "preferred vendor" lookup succeeds.
  // The user can re-point vendors per variant later.
  const v = await prisma.vendor.findFirst({ where: { status: 'ACTIVE' } });
  if (!v) throw new Error('No active vendor found. Run prisma/seed-demo-items.ts first.');
  return v;
}

async function main() {
  const category = await ensureMaterialCategory('Stones');
  const supplier = await findDefaultSupplier();

  // Upsert the parent Material row.
  let material = await prisma.material.findFirst({ where: { materialName: MATERIAL_NAME } });
  if (!material) {
    material = await prisma.material.create({
      data: {
        materialCode: MATERIAL_CODE,
        materialName: MATERIAL_NAME,
        categoryId: category.id,
        unit: VARIANT_UNIT,
      },
    });
  }
  console.log(`Material: ${material.materialName} (${material.materialCode})`);

  // Upsert one variant per colour with its vendor + price.
  for (const c of COLOURS) {
    const variantCode = `${MATERIAL_CODE}-${VARIANT_SIZE}-${c.code}`;
    // Auto-name pattern: "{Size} {Shape} {Material} {Colour}" — matches
    // what the bulk-create form / backend service produce.
    const variantName = [VARIANT_SIZE, VARIANT_SHAPE, MATERIAL_NAME, c.color]
      .map((s) => (s ?? '').toString().trim())
      .filter(Boolean)
      .join(' ');

    let variant = await prisma.materialVariant.findFirst({ where: { variantCode } });
    if (!variant) {
      variant = await prisma.materialVariant.create({
        data: {
          materialId: material.id,
          variantCode,
          variantName,
          size: VARIANT_SIZE,
          color: c.color,
          shape: VARIANT_SHAPE,
          finish: VARIANT_FINISH,
          unit: VARIANT_UNIT,
          stockQty: 0,
          vendors: {
            create: [{
              vendorId: supplier.id,
              price: c.price,
              isPreferred: true,
            }],
          },
        },
      });
    } else {
      // Ensure the structural fields match in case an older row exists with
      // different shape/finish — this keeps the matcher from missing it.
      await prisma.materialVariant.update({
        where: { id: variant.id },
        data: {
          size: VARIANT_SIZE,
          color: c.color,
          shape: VARIANT_SHAPE,
          finish: VARIANT_FINISH,
          unit: VARIANT_UNIT,
        },
      });
      // Make sure the supplier link exists.
      const link = await prisma.materialVariantVendor.findFirst({
        where: { variantId: variant.id, vendorId: supplier.id },
      });
      if (!link) {
        await prisma.materialVariantVendor.create({
          data: {
            variantId: variant.id,
            vendorId: supplier.id,
            price: c.price,
            isPreferred: true,
          },
        });
      }
    }
    console.log(`  ✓ ${variantCode} — ${variantName} @ ₹${c.price}/pc`);
  }

  console.log('\nDone. Open Item Master, configure Sticking with two colour vendor rows,');
  console.log('add the White variant to one, and test "Copy BOM from White" on the other.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
