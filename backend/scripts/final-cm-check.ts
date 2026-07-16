import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
(async () => {
  const nullCount = await p.castingBatchItem.count({ where: { colorModel: null } });
  const total = await p.castingBatchItem.count();
  console.log(`Null colorModel: ${nullCount} / ${total} (${((nullCount / total) * 100).toFixed(1)}% — most should be ambiguous trunks)`);
  const variants = await p.itemColorModel.count();
  const itemsWithCM = await p.item.count({ where: { colorModels: { some: {} } } });
  console.log(`Total variants: ${variants}, items with variants: ${itemsWithCM}`);
  await p.$disconnect();
})();
