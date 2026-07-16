/**
 * Diagnose B0002: user reports "rcving from 6 it has become 96 & 48"
 * — clear sign of a double-post pattern. Dump the batch, its items,
 * receipts, and receipt rows so we can see exactly what happened.
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const batch = await prisma.castingBatch.findFirst({ where: { batchNumber: 'B0002' } });
  if (!batch) { console.log('B0002 not found.'); return; }
  console.log(`Batch #${batch.id} — B0002 · date ${batch.batchDate.toISOString().slice(0,10)} · status ${batch.status}`);

  const items = await prisma.castingBatchItem.findMany({
    where: { batchId: batch.id },
    orderBy: { sortOrder: 'asc' },
    include: {
      stageProcess: { select: { code: true, name: true } },
      vendor:       { select: { vendorCode: true, vendorName: true } },
    },
  });
  console.log(`\nStages (${items.length}):`);
  for (const it of items) {
    const p = it.stageProcess?.code ?? '?';
    console.log(
      `  #${String(it.id).padStart(4)}  ${p.padEnd(14)}  ` +
      `qty=${it.quantity}  wt=${Number(it.totalWeight).toFixed(3)}  ` +
      `vendor=${it.vendor.vendorCode}  parent=${it.parentItemId ?? '—'}  ` +
      `lineKey=${it.lineKey ?? '—'}  ` +
      `closed=${it.closed}`
    );
  }

  const receipts = await prisma.castingReceipt.findMany({
    where: { batchId: batch.id },
    orderBy: { receiptDate: 'asc' },
    include: {
      items: {
        include: { batchItem: { select: { id: true, itemNumber: true } } },
      },
      vendor: { select: { vendorCode: true } },
    },
  });
  console.log(`\nReceipts (${receipts.length}):`);
  for (const r of receipts) {
    console.log(
      `  ${r.receiptNumber} · ${r.receiptDate.toISOString().slice(0,10)} · vendor ${r.vendor.vendorCode} · rows ${r.items.length} · createdAt ${r.createdAt.toISOString()}`
    );
    for (const ri of r.items) {
      console.log(
        `    → batchItem #${ri.batchItemId} (${ri.batchItem.itemNumber}) · recvQty=${ri.receivedQty} recvWt=${Number(ri.receivedWeight).toFixed(3)}`
      );
    }
  }

  // Group receipt rows by batchItemId and sum — this is what the receive form
  // uses to compute "rawReceivedQty" and "rawReceivedWeight".
  console.log(`\nPer-stage receipt totals (raw sums):`);
  const perStage = new Map<number, { qty: number; wt: number; count: number }>();
  for (const r of receipts) {
    for (const ri of r.items) {
      const cur = perStage.get(ri.batchItemId) ?? { qty: 0, wt: 0, count: 0 };
      cur.qty += ri.receivedQty;
      cur.wt += Number(ri.receivedWeight);
      cur.count += 1;
      perStage.set(ri.batchItemId, cur);
    }
  }
  for (const [stageId, sums] of perStage) {
    const stage = items.find((i) => i.id === stageId);
    console.log(
      `  #${stageId} (${stage?.stageProcess?.code ?? '?'} · ordered ${stage?.quantity ?? '?'}) — ` +
      `rawRecvQty=${sums.qty} rawRecvWt=${sums.wt.toFixed(3)} across ${sums.count} receipt row(s)`
    );
  }

  // Flag stages where rawRecvQty > ordered qty (i.e. over-received).
  console.log(`\nOver-received stages:`);
  let flagged = 0;
  for (const [stageId, sums] of perStage) {
    const stage = items.find((i) => i.id === stageId);
    if (!stage) continue;
    if (sums.qty > stage.quantity) {
      console.log(
        `  ⚠  #${stageId} ${stage.stageProcess?.code ?? '?'}: ordered ${stage.quantity}, received ${sums.qty} (over by ${sums.qty - stage.quantity})`
      );
      flagged++;
    }
  }
  if (flagged === 0) console.log('  (none)');
}
main().finally(() => prisma.$disconnect());
