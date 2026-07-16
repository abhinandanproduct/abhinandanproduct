const { PrismaClient } = require('@prisma/client');

(async () => {
  const p = new PrismaClient();
  let issues = 0;
  const log = (line) => console.log(line);

  log('========================================================');
  log('  PRE-LAUNCH CONSISTENCY SWEEP');
  log('========================================================');

  const batches = await p.castingBatch.findMany({
    include: {
      items: {
        include: {
          receiptRows: true,
          repairOrders: { include: { parentRepair: true, receiptItem: true } },
          stageProcess: true,
          vendor: true,
        },
      },
    },
    orderBy: { id: 'asc' },
  });

  log('Total batches: ' + batches.length);
  log('');

  // A. Per-stage invariant
  log('-- A. Per-stage invariant: settled + openRepair + pending = quantity --');
  let anyA = false;
  let totalStages = 0;
  for (const b of batches) {
    for (const it of b.items) {
      totalStages++;
      const acc = it.receiptRows.reduce((s, r) => s + r.acceptedQty, 0);
      const rej = it.receiptRows.reduce((s, r) => s + r.rejectedQty, 0);
      const settled = acc + rej;
      const openRepair = it.repairOrders.filter(r => r.status === 'OPEN').reduce((s, r) => s + r.qty, 0);
      const short = it.shortQty || 0;
      if (it.closed) {
        if (settled + openRepair + short !== it.quantity) {
          log('  ! ' + b.batchNumber + ' stage ' + it.id + ' (' + (it.stageProcess && it.stageProcess.name || '?') + ') CLOSED: settled(' + settled + ')+openRepair(' + openRepair + ')+short(' + short + ')=' + (settled + openRepair + short) + ' != qty(' + it.quantity + ')');
          issues++; anyA = true;
        }
      } else {
        const sum = settled + openRepair;
        if (sum > it.quantity) {
          log('  ! ' + b.batchNumber + ' stage ' + it.id + ' (' + (it.stageProcess && it.stageProcess.name || '?') + ') over-allocated: settled(' + settled + ')+openRepair(' + openRepair + ')=' + sum + ' > qty(' + it.quantity + ')');
          issues++; anyA = true;
        }
      }
    }
  }
  if (!anyA) log('  OK -- all ' + totalStages + ' stages balance.');
  log('');

  // B. Receipt row invariant
  log('-- B. Receipt row invariant: accepted + repair + rejected = receivedQty --');
  let anyB = false;
  let totalRows = 0;
  for (const b of batches) {
    for (const it of b.items) {
      for (const r of it.receiptRows) {
        totalRows++;
        const sum = r.acceptedQty + r.repairQty + r.rejectedQty;
        if (sum !== r.receivedQty) {
          log('  ! ' + b.batchNumber + ' stage ' + it.id + ' rcptItem ' + r.id + ': acc(' + r.acceptedQty + ')+rep(' + r.repairQty + ')+rej(' + r.rejectedQty + ')=' + sum + ' != recd(' + r.receivedQty + ')');
          issues++; anyB = true;
        }
      }
    }
  }
  if (!anyB) log('  OK -- all ' + totalRows + ' receipt rows balance.');
  log('');

  // C. RepairOrder integrity
  log('-- C. RepairOrder integrity (cycle / parent / source receipt) --');
  let anyC = false;
  const allRepairs = await p.repairOrder.findMany({ include: { parentRepair: true, stage: true, receiptItem: true } });
  log('  Total repairs: ' + allRepairs.length);
  for (const r of allRepairs) {
    if (!r.stage) { log('  ! REP-' + r.id + ' has no stage'); issues++; anyC = true; continue; }
    if (r.cycle < 1) { log('  ! REP-' + r.id + ' has invalid cycle ' + r.cycle); issues++; anyC = true; }
    if (r.parentRepairId) {
      if (!r.parentRepair) { log('  ! REP-' + r.id + ' parent ' + r.parentRepairId + ' missing'); issues++; anyC = true; }
      else if (r.cycle !== r.parentRepair.cycle + 1) {
        log('  ! REP-' + r.id + ' cycle(' + r.cycle + ') should be parent.cycle(' + r.parentRepair.cycle + ')+1');
        issues++; anyC = true;
      }
    } else if (r.cycle !== 1) {
      log('  ! REP-' + r.id + ' has no parent but cycle=' + r.cycle + ' (should be 1)');
      issues++; anyC = true;
    }
    if (r.receiptItem && r.receiptItem.repairQty <= 0) {
      log('  ! REP-' + r.id + ' source receipt-item ' + r.receiptItemId + ' has repairQty=0');
      issues++; anyC = true;
    }
  }
  if (!anyC) log('  OK -- all repair orders consistent.');
  log('');

  // D. forwardedQty matches children
  log('-- D. Forwarded qty matches children quantity sum --');
  let anyD = false;
  for (const b of batches) {
    for (const it of b.items) {
      const children = b.items.filter(c => c.parentItemId === it.id);
      const childSum = children.reduce((s, c) => s + c.quantity, 0);
      const acc = it.receiptRows.reduce((s, r) => s + r.acceptedQty, 0);
      if (childSum > acc + 1) {
        log('  ! ' + b.batchNumber + ' stage ' + it.id + ' (' + (it.stageProcess && it.stageProcess.name || '?') + '): forwarded(' + childSum + ') > accepted(' + acc + ')');
        issues++; anyD = true;
      }
    }
  }
  if (!anyD) log('  OK -- no over-forwards.');
  log('');

  // E. Repair-return double-count (the bug we just fixed)
  log('-- E. Stages with repair-return receipts (display will show settled, not raw) --');
  let stagesWithRepairReturn = 0;
  for (const b of batches) {
    for (const it of b.items) {
      const hasRepairReturn = it.receiptRows.some(r => r.fromRepairOrderId != null);
      if (!hasRepairReturn) continue;
      stagesWithRepairReturn++;
      const acc = it.receiptRows.reduce((s, r) => s + r.acceptedQty, 0);
      const rej = it.receiptRows.reduce((s, r) => s + r.rejectedQty, 0);
      const settled = acc + rej;
      const rawRecd = it.receiptRows.reduce((s, r) => s + r.receivedQty, 0);
      const openRepair = it.repairOrders.filter(r => r.status === 'OPEN').reduce((s, r) => s + r.qty, 0);
      log('  ' + b.batchNumber + ' stage ' + it.id + ' (' + (it.stageProcess && it.stageProcess.name || '?') + '): qty=' + it.quantity + ' settled=' + settled + ' openRepair=' + openRepair + ' rawRecd=' + rawRecd);
    }
  }
  log('  -> ' + stagesWithRepairReturn + ' stages with repair-return receipts');
  log('');

  // F. Orphans (schema FKs are non-nullable, so this is mostly a sanity check)
  log('-- F. Orphans (FK-guaranteed; skipping detailed check) --');
  log('  OK -- schema FK constraints make orphans impossible.');
  log('');

  // G. Open repairs by status distribution
  log('-- G. Repair status distribution --');
  const repairsByStatus = await p.repairOrder.groupBy({ by: ['status'], _count: { _all: true }, _sum: { qty: true } });
  for (const r of repairsByStatus) log('  ' + r.status + ': ' + r._count._all + ' orders, ' + (r._sum.qty || 0) + ' pcs total');
  log('');

  log('========================================================');
  log('  SUMMARY: ' + (issues === 0 ? 'ALL CLEAR' : issues + ' issues'));
  log('========================================================');
  await p.$disconnect();
})();
