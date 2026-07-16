import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
(async () => {
  // Look at one item's stages grouped by lineKey to understand the structure
  const item = await p.item.findFirst({
    where: { castingBatchRows: { some: {} } },
    select: { id: true, itemNumber: true },
  });
  if (!item) return;
  console.log('Item:', item);
  const stages = await p.castingBatchItem.findMany({
    where: { itemId: item.id },
    include: { stageProcess: true },
    orderBy: [{ batchId: 'asc' }, { lineKey: 'asc' }, { sortOrder: 'asc' }],
    take: 50,
  });
  const grouped = new Map<string, any[]>();
  for (const s of stages) {
    const k = `${s.batchId}:${s.lineKey}`;
    const arr = grouped.get(k) ?? [];
    arr.push(s);
    grouped.set(k, arr);
  }
  for (const [k, arr] of grouped) {
    console.log(`\n[${k}] (${arr.length} stages):`);
    for (const s of arr) {
      console.log(`  #${s.id} ${s.stageProcess?.code ?? '?'} color=${s.color ?? '—'} parent=${s.parentItemId ?? '—'} colorModel=${s.colorModel ?? '—'}`);
    }
  }
  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
