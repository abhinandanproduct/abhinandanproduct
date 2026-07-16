import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
(async () => {
  // Replicate the exact maxProducible computation from casting.service.ts getBatch
  const batch = await p.castingBatch.findFirst({ where: { batchNumber: { contains: 'B0019' } } });
  if (!batch) { console.log('B0019 not found'); return; }
  const stages = await p.castingBatchItem.findMany({
    where: { batchId: batch.id, stageProcess: { code: 'STICKING' } },
    include: { stageProcess: true },
  });
  for (const stage of stages) {
    const snap: any[] = Array.isArray(stage.bomSnapshot) ? (stage.bomSnapshot as any[]) : [];
    const issues = await p.materialIssue.findMany({
      where: { stageId: stage.id },
      include: { lines: { include: { variant: true } } },
    });
    const perVariant = new Map<number, { issued: number; deferred: number }>();
    for (const iss of issues) {
      for (const ln of iss.lines) {
        const cur = perVariant.get(ln.variantId) ?? { issued: 0, deferred: 0 };
        cur.issued += ln.issuedQty ?? 0;
        cur.deferred += ln.deferredQty ?? 0;
        perVariant.set(ln.variantId, cur);
      }
    }
    const stageQty = stage.quantity;
    let maxProducible = stageQty;
    console.log(`\nStage #${stage.id} qty=${stageQty}`);
    for (const b of snap) {
      const variantId = Number(b.variantId);
      const perPiece = Number(b.perPiece ?? b.quantity ?? b.qtyPerPiece ?? 0);
      const required = b.required != null ? Number(b.required) : Math.ceil(perPiece * stageQty);
      const agg = perVariant.get(variantId);
      const issued = agg?.issued ?? 0;
      const producibleFromThis = perPiece > 0 ? Math.floor(issued / perPiece) : stageQty;
      if (producibleFromThis < maxProducible) maxProducible = producibleFromThis;
      console.log(`  ${b.variantName}: perPiece=${perPiece}, required=${required}, issued=${issued}, producibleFromThis=${producibleFromThis}`);
    }
    console.log(`  → maxProducible = ${Math.min(maxProducible, stageQty)}`);
    console.log(`  → materialsShort = ${maxProducible < stageQty}`);
  }
  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
