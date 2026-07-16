const { PrismaClient } = require('@prisma/client');

(async () => {
  const p = new PrismaClient();

  console.log('============================================================');
  console.log('  REPAIR-BUCKET ↔ REPAIRORDER LINKAGE AUDIT');
  console.log('============================================================');

  // Every receipt-item with repairQty > 0 should have spawned a RepairOrder
  // pointing back at it (RepairOrder.receiptItemId = receiptItem.id).
  const rcptWithRepair = await p.castingReceiptItem.findMany({
    where: { repairQty: { gt: 0 } },
    include: { spawnedRepair: true, batchItem: { include: { batch: true, stageProcess: true } } },
  });
  console.log('Receipt-items with repairQty > 0: ' + rcptWithRepair.length);
  let missing = 0;
  for (const r of rcptWithRepair) {
    if (!r.spawnedRepair) {
      console.log('  ! rcptItem ' + r.id + ' (' + r.batchItem.batch.batchNumber + ' ' + r.batchItem.stageProcess.name + ') has repairQty=' + r.repairQty + ' but no RepairOrder spawned');
      missing++;
    } else if (r.spawnedRepair.qty > r.repairQty) {
      console.log('  ! rcptItem ' + r.id + ' has repairQty=' + r.repairQty + ' but spawned REP-' + r.spawnedRepair.id + ' qty=' + r.spawnedRepair.qty + ' (decremented?)');
    }
  }
  if (missing === 0) console.log('  OK -- every repair-bucket has a corresponding RepairOrder.');
  console.log('');

  console.log('============================================================');
  console.log('  LIVE OPEN REPAIRS');
  console.log('============================================================');
  const openRepairs = await p.repairOrder.findMany({
    where: { status: 'OPEN' },
    include: {
      stage: { include: { batch: true, stageProcess: true, item: true } },
      vendor: true,
      parentRepair: true,
    },
    orderBy: { id: 'asc' },
  });
  for (const r of openRepairs) {
    console.log('  REP-' + r.id + '  cycle=' + r.cycle + '  qty=' + r.qty + '  vendor=' + r.vendor.vendorCode + '  batch=' + r.stage.batch.batchNumber + '  process=' + r.stage.stageProcess.name + '  item=#' + r.stage.itemNumber + '  reason="' + (r.reason || '-') + '"' + (r.parentRepair ? '  parent=REP-' + r.parentRepair.id : ''));
  }
  console.log('');

  console.log('============================================================');
  console.log('  BATCH LIFECYCLE STATUS DISTRIBUTION');
  console.log('============================================================');
  const byStatus = await p.castingBatch.groupBy({ by: ['status'], _count: { _all: true } });
  for (const r of byStatus) console.log('  ' + r.status + ': ' + r._count._all);
  console.log('');

  console.log('============================================================');
  console.log('  DUPLICATE-RECEIPT SUSPICION (B0002)');
  console.log('============================================================');
  const r18 = await p.castingReceipt.findFirst({ where: { receiptNumber: 'R00018' }, include: { items: true, vendor: true } });
  const r19 = await p.castingReceipt.findFirst({ where: { receiptNumber: 'R00019' }, include: { items: true, vendor: true } });
  if (r18 && r19) {
    console.log('R00018 ' + r18.receiptDate.toISOString().slice(0,10) + ' vendor=' + r18.vendor.vendorCode + ' items=' + r18.items.length);
    for (const it of r18.items) console.log('  stage=' + it.batchItemId + ' recd=' + it.receivedQty + ' acc=' + it.acceptedQty);
    console.log('R00019 ' + r19.receiptDate.toISOString().slice(0,10) + ' vendor=' + r19.vendor.vendorCode + ' items=' + r19.items.length);
    for (const it of r19.items) console.log('  stage=' + it.batchItemId + ' recd=' + it.receivedQty + ' acc=' + it.acceptedQty);
  }

  await p.$disconnect();
})();
