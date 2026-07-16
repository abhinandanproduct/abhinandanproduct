const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const items = await p.item.findMany({ select: { id: true, itemNumber: true, sampleDesignCode: true } });
  console.log('Items:', items);
  // Detect duplicates
  const map = new Map();
  items.forEach(i => { if (i.itemNumber != null) { const k = String(i.itemNumber); map.set(k, (map.get(k) ?? 0) + 1); } });
  console.log('Duplicates:', [...map.entries()].filter(([, n]) => n > 1));
  await p.$disconnect();
})();
