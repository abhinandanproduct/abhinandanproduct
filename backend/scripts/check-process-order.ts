import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.process.findMany({
    orderBy: { sortOrder: 'asc' },
    select: { id: true, code: true, name: true, sortOrder: true, status: true },
  });
  console.log('All process rows in DB:');
  for (const r of rows) {
    const flag = r.status === 'ACTIVE' ? '✓' : '·';
    console.log(`  ${flag} #${r.id.toString().padStart(3)}  sortOrder=${String(r.sortOrder).padStart(3)}  ${r.code.padEnd(28)} ${r.name} [${r.status}]`);
  }
  console.log('\nOnly ACTIVE (what the UI sees):');
  const active = rows.filter((r) => r.status === 'ACTIVE');
  for (const r of active) {
    console.log(`  #${r.id}  sortOrder=${r.sortOrder}  ${r.code} — ${r.name}`);
  }
}
main().finally(() => prisma.$disconnect());
