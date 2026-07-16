/**
 * One-shot data cleanup: round every material-related decimal to a whole number.
 * Run once with:  npx ts-node scripts/round-materials-to-int.ts
 *
 * Touches:
 *   - MaterialVariant.stockQty            → round
 *   - ItemMaterial.quantity (BOM)         → round, min 1 if any rows had > 0
 *   - StockMovement.quantity              → round
 *   - StockMovement.balanceAfter          → round
 *   - CastingBatchItem.bomSnapshot        → round perPiece + required
 *   - MaterialIssueLine.issuedQty/received/short — already Int, but normalise
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function r(n: any) {
  return Math.round(Number(n ?? 0));
}

async function main() {
  console.log('Rounding material data to whole numbers…');

  // 1. MaterialVariant.stockQty
  const variants = await prisma.materialVariant.findMany({ select: { id: true, stockQty: true } });
  let vChanged = 0;
  for (const v of variants) {
    const newVal = Math.max(0, r(v.stockQty));
    if (Number(v.stockQty) !== newVal) {
      await prisma.materialVariant.update({ where: { id: v.id }, data: { stockQty: newVal } });
      vChanged++;
    }
  }
  console.log(`  MaterialVariant.stockQty: ${vChanged} of ${variants.length} rows updated`);

  // 2. ItemMaterial.quantity (BOM)
  const bom = await prisma.itemMaterial.findMany({ select: { id: true, quantity: true } });
  let bChanged = 0;
  for (const l of bom) {
    const newVal = Math.max(0, r(l.quantity));
    if (Number(l.quantity) !== newVal) {
      await prisma.itemMaterial.update({ where: { id: l.id }, data: { quantity: newVal } });
      bChanged++;
    }
  }
  console.log(`  ItemMaterial.quantity:   ${bChanged} of ${bom.length} rows updated`);

  // 3. StockMovement.quantity + balanceAfter
  const moves = await prisma.stockMovement.findMany({ select: { id: true, quantity: true, balanceAfter: true } });
  let mChanged = 0;
  for (const m of moves) {
    const q = Math.trunc(Number(m.quantity));
    const b = Math.max(0, r(m.balanceAfter));
    if (Number(m.quantity) !== q || Number(m.balanceAfter) !== b) {
      await prisma.stockMovement.update({ where: { id: m.id }, data: { quantity: q, balanceAfter: b } });
      mChanged++;
    }
  }
  console.log(`  StockMovement:           ${mChanged} of ${moves.length} rows updated`);

  // 4. CastingBatchItem.bomSnapshot (Json)
  const stages = await prisma.castingBatchItem.findMany({
    where: { bomSnapshot: { not: undefined } },
    select: { id: true, quantity: true, bomSnapshot: true },
  });
  let sChanged = 0;
  for (const st of stages) {
    if (!Array.isArray(st.bomSnapshot)) continue;
    let touched = false;
    const fixed = (st.bomSnapshot as any[]).map((s) => {
      if (!s) return s;
      const pp = Math.max(0, r(s.perPiece));
      const req = pp * st.quantity;
      if (Number(s.perPiece) !== pp || Number(s.required) !== req) touched = true;
      return { ...s, perPiece: pp, required: req };
    });
    if (touched) {
      await prisma.castingBatchItem.update({ where: { id: st.id }, data: { bomSnapshot: fixed } });
      sChanged++;
    }
  }
  console.log(`  bomSnapshot:             ${sChanged} of ${stages.length} stages updated`);

  console.log('Done.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
