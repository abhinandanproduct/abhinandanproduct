/**
 * Ensure the two silver variants exist with the right fineness so the
 * cross-pool FIFO in billing can compute fair fine-metal deductions.
 *
 *   Silver 999  — fineness 0.999
 *   Silver 93.5 — fineness 0.935
 *
 * Idempotent — updates fineness on existing rows, creates missing ones.
 * Parent Material row "Silver" is created if missing.
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // Parent Material — one row for silver family
  let silver = await prisma.material.findFirst({ where: { materialName: 'Silver' } });
  if (!silver) {
    // Need a category — pick the first one that exists (or create one)
    let cat = await prisma.materialCategory.findFirst({ where: { name: { contains: 'Silver', mode: 'insensitive' } } });
    if (!cat) cat = await prisma.materialCategory.findFirst();
    if (!cat) cat = await prisma.materialCategory.create({ data: { name: 'Silver' } });
    silver = await prisma.material.create({
      data: {
        materialCode: 'SILVER',
        materialName: 'Silver',
        categoryId: cat.id,
        unit: 'g',
      },
    });
    console.log(`✓ Created Material "Silver" #${silver.id}`);
  } else {
    console.log(`· Material "Silver" #${silver.id} already exists.`);
  }

  const variants = [
    { code: 'SILV-999',   name: 'Silver 999',   fineness: 0.999 },
    { code: 'SILV-935',   name: 'Silver 93.5',  fineness: 0.935 },
  ];
  for (const v of variants) {
    const existing = await prisma.materialVariant.findUnique({ where: { variantCode: v.code } });
    if (existing) {
      await prisma.materialVariant.update({
        where: { id: existing.id },
        data: { fineness: v.fineness },
      });
      console.log(`· Updated ${v.code} · fineness=${v.fineness}`);
    } else {
      const created = await prisma.materialVariant.create({
        data: {
          materialId: silver.id,
          variantCode: v.code,
          variantName: v.name,
          trackByQty: false,
          trackByWeight: true,
          fineness: v.fineness,
        },
      });
      console.log(`✓ Created ${v.code} #${created.id}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
