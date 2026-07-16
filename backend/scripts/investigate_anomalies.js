const { PrismaClient } = require('@prisma/client');

(async () => {
  const p = new PrismaClient();

  const stagesToCheck = [317, 318, 319, 413];
  for (const stageId of stagesToCheck) {
    const s = await p.castingBatchItem.findUnique({
      where: { id: stageId },
      include: {
        batch: true,
        stageProcess: true,
        vendor: true,
        receiptRows: {
          include: { receipt: { select: { receiptNumber: true, receiptDate: true } } },
          orderBy: { id: 'asc' },
        },
        repairOrders: true,
      },
    });
    if (!s) continue;
    console.log('============================================================');
    console.log('STAGE ' + s.id + ' :: ' + s.batch.batchNumber + ' / ' + s.stageProcess.name + ' / ' + s.vendor.vendorCode);
    console.log('  qty=' + s.quantity + '  totalCost=' + s.totalCost + '  closed=' + s.closed + '  shortQty=' + (s.shortQty || 0));
    console.log('  parentItemId=' + s.parentItemId + '  itemId=' + s.itemId + '  itemNumber=' + s.itemNumber);
    console.log('  Receipt rows: ' + s.receiptRows.length);
    let recAcc=0, recRep=0, recRej=0, recRecd=0;
    for (const r of s.receiptRows) {
      console.log('    rcptItem ' + r.id + ' ' + r.receipt.receiptNumber + ' on ' + r.receipt.receiptDate.toISOString().slice(0,10) + ' recd=' + r.receivedQty + ' acc=' + r.acceptedQty + ' rep=' + r.repairQty + ' rej=' + r.rejectedQty + ' fromRep=' + r.fromRepairOrderId);
      recAcc += r.acceptedQty; recRep += r.repairQty; recRej += r.rejectedQty; recRecd += r.receivedQty;
    }
    console.log('  Sum: acc=' + recAcc + ' rep=' + recRep + ' rej=' + recRej + ' rawRecd=' + recRecd + '  settled=' + (recAcc+recRej));
    console.log('  Repair orders: ' + s.repairOrders.length);
    for (const r of s.repairOrders) {
      console.log('    REP-' + r.id + ' qty=' + r.qty + ' cycle=' + r.cycle + ' status=' + r.status + ' parent=' + r.parentRepairId);
    }
  }

  await p.$disconnect();
})();
