// Simulate what pendingForVendor returns for B0019's sticking vendor —
// helps confirm materialStatus is actually being attached to the response.
import { PrismaClient } from '@prisma/client';
import { CastingService } from '../src/casting/casting.service';
import { MaterialIssuesService } from '../src/material-issues/material-issues.service';

(async () => {
  const prisma = new PrismaClient();
  const ms = new MaterialIssuesService(prisma as any);
  const cs = new CastingService(prisma as any, ms as any);
  const batch = await prisma.castingBatch.findFirst({ where: { batchNumber: { contains: 'B0019' } } });
  if (!batch) { console.log('B0019 not found'); return; }
  const stage = await prisma.castingBatchItem.findFirst({
    where: { batchId: batch.id, stageProcess: { code: 'STICKING' } },
    include: { vendor: true },
  });
  if (!stage) { console.log('No sticking stage'); return; }
  console.log(`B0019 sticking stage #${stage.id} vendor=${stage.vendor.vendorCode}`);
  const out = await cs.pendingForVendor(batch.id, stage.vendorId);
  for (const it of out.items) {
    if (it.processCode !== 'STICKING') continue;
    console.log(`Stage ${it.id} qty=${it.quantity} recd=${it.receivedQty}`);
    console.log('  materialStatus:', it.materialStatus ? JSON.stringify({
      stageQty: it.materialStatus.stageQty,
      maxProducible: it.materialStatus.maxProducible,
      materialsShort: it.materialStatus.materialsShort,
      pendingPiecesAwaitingMaterial: it.materialStatus.pendingPiecesAwaitingMaterial,
      lineCount: it.materialStatus.lines.length,
    }, null, 2) : 'NULL');
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
