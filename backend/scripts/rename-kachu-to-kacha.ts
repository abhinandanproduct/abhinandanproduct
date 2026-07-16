/**
 * One-shot rename: Process "Kachu Fitting" → "Kacha Fitting" + vendor
 * "Kachu Fitting Co" → "Kacha Fitting Co". The process CODE stays as
 * KACHU_FITTING (it's a programmatic key referenced in seed + code);
 * only the display name changes. Vendor name is the only place users
 * directly read it.
 *
 * Run once with:  npx ts-node scripts/rename-kachu-to-kacha.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Renaming Kachu → Kacha…');

  const proc = await prisma.process.updateMany({
    where: { code: 'KACHU_FITTING', name: 'Kachu Fitting' },
    data: { name: 'Kacha Fitting' },
  });
  console.log(`  Processes renamed: ${proc.count}`);

  const ven = await prisma.vendor.updateMany({
    where: { vendorName: 'Kachu Fitting Co' },
    data: { vendorName: 'Kacha Fitting Co' },
  });
  console.log(`  Vendors renamed: ${ven.count}`);

  console.log('Done.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
