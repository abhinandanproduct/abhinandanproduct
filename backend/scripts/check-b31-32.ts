import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
(async () => {
  for (const num of ['B0031', 'B0032', 'B0025', 'B0026']) {
    const batch = await p.castingBatch.findFirst({
      where: { batchNumber: num },
      include: {
        items: { include: { receiptRows: true, stageProcess: true } },
      },
    });
    if (!batch) { console.log(`${num} not found`); continue; }
    console.log(`\n=== ${num} (id=${batch.id}) closed=${batch.closed} ===`);
    console.log(`  total items: ${batch.items.length}`);
    // Reproduce the NEW leaf-based logic
    const parentIds = new Set(batch.items.map((i) => i.parentItemId).filter((p): p is number => p != null));
    const leaves = batch.items.filter((i) => !parentIds.has(i.id));
    console.log(`  leaf stages: ${leaves.length}`);
    for (const leaf of leaves) {
      const recd = leaf.receiptRows.reduce((s, r) => s + r.receivedQty, 0);
      console.log(`    leaf #${leaf.id}: ${leaf.stageProcess?.code ?? '?'} qty=${leaf.quantity} recd=${recd} closed=${leaf.closed}`);
    }
    const anyReceived = batch.items.some((i) => i.receiptRows.reduce((rs, r) => rs + r.receivedQty, 0) > 0);
    const allLeavesPacked = leaves.length > 0 && leaves.every((it) => {
      if (it.closed) return true;
      if (it.stageProcess?.code !== 'PACKING') return false;
      if (it.quantity <= 0) return true;
      const recd = it.receiptRows.reduce((rs, r) => rs + r.receivedQty, 0);
      return recd >= it.quantity;
    });
    const displayStatus = (anyReceived && allLeavesPacked) ? 'Completed' : anyReceived ? 'In Process' : 'Issued';
    console.log(`  → displayStatus = ${displayStatus}`);
  }
  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
