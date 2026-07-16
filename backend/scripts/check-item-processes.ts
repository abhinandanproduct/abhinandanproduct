import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const items = await prisma.item.findMany({
    select: {
      id: true, sampleDesignCode: true, itemName: true, sampleStatus: true, status: true,
      processes: {
        include: { process: { select: { code: true, status: true } } },
      },
    },
  });
  console.log(`Total items: ${items.length}`);
  for (const it of items) {
    console.log(`\n#${it.id} · ${it.sampleDesignCode} · ${it.itemName ?? '(no name)'} · sample=${it.sampleStatus} · status=${it.status}`);
    if (it.processes.length === 0) {
      console.log('  (no ItemProcess rows)');
    } else {
      for (const ip of it.processes) {
        console.log(`  → ${ip.process.code.padEnd(28)} process.status=${ip.process.status}`);
      }
    }
  }
  const prReady = items.filter((i) => i.sampleStatus === 'PRODUCTION_READY');
  console.log(`\nProduction-Ready items: ${prReady.length}`);
}
main().finally(() => prisma.$disconnect());
