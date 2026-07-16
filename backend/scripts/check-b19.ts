import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
(async () => {
  const batch = await p.castingBatch.findFirst({
    where: { batchNumber: { contains: 'B0019' } },
    include: {
      items: {
        where: { stageProcess: { code: 'STICKING' } },
        include: { stageProcess: true },
      },
    },
  });
  if (!batch) { console.log('B0019 not found'); return; }
  console.log(`B0019 (id=${batch.id}): ${batch.items.length} sticking stages`);
  for (const it of batch.items) {
    console.log(`\nStage #${it.id} qty=${it.quantity} color=${it.color} bomSnapshot=${it.bomSnapshot ? 'YES' : 'NULL'}`);
    if (it.bomSnapshot) {
      console.log('  BOM:', JSON.stringify(it.bomSnapshot, null, 2));
    }
    // Check material issues for this stage
    const issues = await p.materialIssue.findMany({
      where: { stageId: it.id },
      include: { lines: { include: { variant: { include: { material: true } } } } },
    });
    if (issues.length === 0) {
      console.log('  NO material issues linked to this stage');
    } else {
      for (const iss of issues) {
        console.log(`  Issue ${iss.voucherNumber}:`);
        for (const ln of iss.lines) {
          console.log(`    ${ln.variant.material?.materialName ?? '?'} (${ln.variant.variantName}): issued=${ln.issuedQty} deferred=${ln.deferredQty} received=${ln.receivedQty}`);
        }
      }
    }
  }
  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
