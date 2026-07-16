/**
 * Find and clean up duplicate CAD Process rows so React stops complaining
 * about non-unique keys. Keeps the oldest (lowest id) as the canonical
 * CAD row, deactivates the rest — vendor-links get merged into the keeper.
 *
 * Idempotent. Safe to re-run.
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const cads = await prisma.process.findMany({
    where: {
      OR: [
        { code: 'CAD' },
        { name: { equals: 'CAD', mode: 'insensitive' } },
        { code: 'DESIGN_CAD' },
        { code: 'CAD_DESIGN' },
      ],
    },
    include: { vendorLinks: true },
    orderBy: { id: 'asc' },
  });
  console.log(`Found ${cads.length} CAD-like rows.`);
  if (cads.length === 0) return;
  for (const c of cads) console.log(`  #${c.id}  code="${c.code}"  name="${c.name}"  status=${c.status}  vendorLinks=${c.vendorLinks.length}`);

  const keeper = cads[0];
  const duplicates = cads.slice(1);
  if (duplicates.length === 0) {
    // Just ensure the single row is canonical (code='CAD', ACTIVE, sortOrder=0).
    await prisma.process.update({
      where: { id: keeper.id },
      data: { code: 'CAD', name: 'CAD', status: 'ACTIVE', sortOrder: 0 },
    });
    console.log(`\n✓ Single canonical row (#${keeper.id}) normalized.`);
    return;
  }

  // Merge vendor links from dupes into the keeper (skipping any already present).
  const keeperVendorIds = new Set(keeper.vendorLinks.map((vl) => vl.vendorId));
  for (const dup of duplicates) {
    for (const vl of dup.vendorLinks) {
      if (keeperVendorIds.has(vl.vendorId)) continue;
      await prisma.vendorProcess.create({
        data: { vendorId: vl.vendorId, processId: keeper.id },
      });
      keeperVendorIds.add(vl.vendorId);
    }
    // Delete the duplicate row's vendor links.
    await prisma.vendorProcess.deleteMany({ where: { processId: dup.id } });
    // Rename dup so it can't collide on `code` unique constraint if we
    // later re-seed, then deactivate.
    await prisma.process.update({
      where: { id: dup.id },
      data: { code: `RETIRED_${dup.code}_${dup.id}`, status: 'INACTIVE' },
    });
    console.log(`  ✗ Merged & retired duplicate #${dup.id}.`);
  }

  await prisma.process.update({
    where: { id: keeper.id },
    data: { code: 'CAD', name: 'CAD', status: 'ACTIVE', sortOrder: 0 },
  });
  console.log(`\n✓ Kept #${keeper.id} as canonical CAD, retired ${duplicates.length} duplicate(s).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
