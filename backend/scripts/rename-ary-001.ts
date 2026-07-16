import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const item = await prisma.item.findUnique({
    where: { sampleDesignCode: 'ARY-001' },
    select: { id: true, sampleDesignCode: true, itemNumber: true, designerShortName: true },
  });
  if (!item) { console.log('No item with sampleDesignCode "ARY-001".'); return; }
  console.log('Before:', item);

  const target = item.itemNumber ?? 'ABN-1562';
  const clash = await prisma.item.findUnique({ where: { sampleDesignCode: target } });
  if (clash && clash.id !== item.id) {
    console.log(`Cannot rename — another item already uses sampleDesignCode "${target}" (#${clash.id}).`);
    return;
  }
  await prisma.item.update({
    where: { id: item.id },
    data: { sampleDesignCode: target },
  });
  console.log(`✓ Renamed #${item.id}: ARY-001 → ${target}`);
}
main().finally(() => prisma.$disconnect());
