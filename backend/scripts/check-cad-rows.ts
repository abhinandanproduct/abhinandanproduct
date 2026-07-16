import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const rows = await prisma.process.findMany({
    where: {
      OR: [
        { name: { equals: 'CAD', mode: 'insensitive' } },
        { code: { contains: 'CAD', mode: 'insensitive' } },
      ],
    },
    select: { id: true, code: true, name: true, status: true, sortOrder: true },
  });
  console.log(`Rows matching name/code CAD:`);
  for (const r of rows) console.log(`  #${r.id}  code="${r.code}"  name="${r.name}"  status=${r.status}  sortOrder=${r.sortOrder}`);

  const active = await prisma.process.findMany({
    where: { status: 'ACTIVE', code: { not: 'CAM' } },
    orderBy: { sortOrder: 'asc' },
    select: { code: true, name: true },
  });
  console.log(`\nDashboard-visible active processes (code != CAM):`);
  const names = new Map<string, number>();
  for (const p of active) {
    names.set(p.name, (names.get(p.name) ?? 0) + 1);
    console.log(`  code=${p.code}  name=${p.name}`);
  }
  const dupes = [...names.entries()].filter(([, n]) => n > 1);
  console.log(dupes.length ? `\n⚠ Duplicate NAMES: ${dupes.map(([n, c]) => `"${n}"×${c}`).join(', ')}` : `\n✓ All names unique.`);
}
main().finally(() => prisma.$disconnect());
