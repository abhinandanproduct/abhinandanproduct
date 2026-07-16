import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
(async () => {
  const batch = await p.castingBatch.findFirst({ where: { batchNumber: { contains: '0019' } } });
  if (!batch) { console.log('No B0019 batch'); return; }
  console.log('Batch:', batch.id, batch.batchNumber);

  const stickingStages = await p.castingBatchItem.findMany({
    where: { batchId: batch.id, stageProcess: { code: 'STICKING' } },
    include: { stageProcess: true },
  });
  console.log(`Sticking stages: ${stickingStages.length}`);
  for (const s of stickingStages.slice(0, 5)) {
    console.log(`  #${s.id} qty=${s.quantity} color=${s.color} bomSnapshot=${s.bomSnapshot ? 'present' : 'MISSING'}`);
    if (s.bomSnapshot) {
      console.log(`    snapshot lines:`, JSON.stringify(s.bomSnapshot).slice(0, 200));
    }
    const issues = await p.materialIssue.findMany({ where: { stageId: s.id }, include: { lines: true } });
    console.log(`    Linked material issues: ${issues.length}`);
    for (const iss of issues) {
      console.log(`      #${iss.id} ${iss.voucherNumber} status=${iss.status} lines=${iss.lines.length}`);
      for (const ln of iss.lines.slice(0, 3)) {
        console.log(`        variant=${ln.variantId} issued=${ln.issuedQty} deferred=${ln.deferredQty} recd=${ln.receivedQty}`);
      }
    }
  }
  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
