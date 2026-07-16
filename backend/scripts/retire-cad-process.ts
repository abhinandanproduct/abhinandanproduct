/**
 * One-off: mark any live CAD-flavoured Process row INACTIVE so it stops
 * showing up in the processes list. The correct first process is CAM
 * (per-gram) — CAD is now design-file metadata, not a costed stage.
 *
 * Run:  npx tsx scripts/retire-cad-process.ts
 *
 * Safe to re-run — idempotent.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Any row whose CODE or NAME matches the CAD family gets retired.
  const CAD_CODES = ['CAD', 'DESIGN_CAD', 'CAD_DESIGN'];
  const targets = await prisma.process.findMany({
    where: {
      OR: [
        { code: { in: CAD_CODES } },
        { name: { equals: 'CAD', mode: 'insensitive' } },
      ],
    },
  });
  if (targets.length === 0) {
    console.log('✓ No CAD-style process rows found. Nothing to do.');
  } else {
    for (const t of targets) {
      await prisma.process.update({
        where: { id: t.id },
        data: { status: 'INACTIVE' },
      });
      console.log(`✓ Retired process #${t.id} — code="${t.code}" name="${t.name}"`);
    }
  }

  // Confirm CAM is present + active so the ops list has its expected first row.
  const cam = await prisma.process.findUnique({ where: { code: 'CAM' } });
  if (!cam) {
    console.log('⚠  CAM row is missing. Run `npx prisma db seed` to reseed the process master.');
  } else if (cam.status !== 'ACTIVE') {
    await prisma.process.update({ where: { id: cam.id }, data: { status: 'ACTIVE' } });
    console.log('✓ CAM row re-activated.');
  } else {
    console.log(`✓ CAM present · sortOrder=${cam.sortOrder} · ACTIVE.`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
