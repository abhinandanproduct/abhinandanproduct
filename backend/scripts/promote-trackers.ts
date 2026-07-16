/* eslint-disable no-console */
/**
 * 1) Fold Silver Metal Powder's stockWeight into RUNNERS-SILVER, then delete
 *    the Silver Metal Powder variant + its parent material. A stock-movement
 *    on RUNNERS-SILVER records the transfer for the audit ledger.
 * 2) Promote "To be melt Metal" to a tracker variant — variantCode +
 *    materialName flipped to UPPER-CASE-HYPHEN style ('TO-BE-MELT-METAL'),
 *    matching the LOSS-SILVER / RUNNERS-SILVER convention.
 *
 * USAGE
 *   ts-node scripts/promote-trackers.ts             # dry-run
 *   ts-node scripts/promote-trackers.ts --apply     # write
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(`\n=== promote-trackers ${APPLY ? '[APPLY]' : '[DRY-RUN]'} ===\n`);

  // -----------------------------------------------------------------
  // 1. Silver Metal Powder → RUNNERS-SILVER
  // -----------------------------------------------------------------
  const runners = await prisma.materialVariant.findUnique({ where: { variantCode: 'RUNNERS-SILVER' } });
  if (!runners) throw new Error('RUNNERS-SILVER tracker variant missing — abort.');

  const powder = await prisma.materialVariant.findFirst({
    where: { variantName: { contains: 'Silver Metal Powder', mode: 'insensitive' } },
    include: { material: true },
  });
  if (!powder) {
    console.log('Silver Metal Powder variant not found — skipping step 1.');
  } else {
    const movePow = Number(powder.stockWeight);
    const moveQty = Number(powder.stockQty);
    const newRunnersWt = Math.round((Number(runners.stockWeight) + movePow) * 1000) / 1000;
    const newRunnersQty = Math.round(Number(runners.stockQty) + moveQty);
    console.log(`Silver Metal Powder → RUNNERS-SILVER: +${movePow}g / +${moveQty}pc`);
    console.log(`  RUNNERS-SILVER before: ${runners.stockWeight}g / ${runners.stockQty}pc`);
    console.log(`  RUNNERS-SILVER after:  ${newRunnersWt}g / ${newRunnersQty}pc`);

    if (APPLY) {
      // Move stock onto RUNNERS-SILVER + audit movement.
      await prisma.materialVariant.update({
        where: { id: runners.id },
        data: { stockWeight: newRunnersWt, stockQty: newRunnersQty },
      });
      await prisma.stockMovement.create({
        data: {
          variantId: runners.id,
          type: 'IN',
          quantity: moveQty,
          balanceAfter: newRunnersQty,
          weight: movePow,
          balanceWeightAfter: newRunnersWt,
          refType: 'merge_silver_powder',
          refId: powder.id,
          note: 'Folded Silver Metal Powder into RUNNERS-SILVER pool',
        },
      });
      // Delete the variant (cascades movements + linkages) and the parent
      // material if no sibling variants remain.
      const movsAtPowder = await prisma.stockMovement.count({ where: { variantId: powder.id } });
      console.log(`  Powder had ${movsAtPowder} stock movement(s) — cascade delete.`);
      await prisma.stockMovement.deleteMany({ where: { variantId: powder.id } });
      await prisma.materialVariantProcess.deleteMany({ where: { variantId: powder.id } });
      await prisma.materialVariantVendor.deleteMany({ where: { variantId: powder.id } });
      await prisma.materialVariant.delete({ where: { id: powder.id } });
      const siblingCount = await prisma.materialVariant.count({ where: { materialId: powder.materialId } });
      if (siblingCount === 0) {
        await prisma.material.delete({ where: { id: powder.materialId } });
        console.log('  Parent Material (orphan) deleted.');
      } else {
        console.log(`  Parent Material kept — ${siblingCount} sibling variant(s) remain.`);
      }
    }
  }

  // -----------------------------------------------------------------
  // 2. To be melt Metal → TO-BE-MELT-METAL tracker
  // -----------------------------------------------------------------
  const melt = await prisma.materialVariant.findFirst({
    where: {
      OR: [
        { variantName: { contains: 'To be melt Metal', mode: 'insensitive' } },
        { variantCode: 'TO-BE-MELT-METAL' },
      ],
    },
    include: { material: true },
  });
  if (!melt) {
    console.log('"To be melt Metal" variant not found — skipping step 2.');
  } else if (melt.variantCode === 'TO-BE-MELT-METAL') {
    console.log('TO-BE-MELT-METAL already promoted — no change.');
  } else {
    console.log(`\nPromoting variant ${melt.variantCode} "${melt.variantName}" → TO-BE-MELT-METAL`);
    console.log(`  Material parent: "${melt.material.materialName}" → "TO BE MELT METAL"`);
    if (APPLY) {
      await prisma.materialVariant.update({
        where: { id: melt.id },
        data: { variantCode: 'TO-BE-MELT-METAL', variantName: 'TO BE MELT METAL' },
      });
      await prisma.material.update({
        where: { id: melt.materialId },
        data: { materialName: 'TO BE MELT METAL' },
      });
    }
  }

  if (!APPLY) console.log('\nDRY-RUN — pass --apply to write.');
  else console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
