/**
 * CAD was earlier retired (INACTIVE) as a "process". It's now restored
 * as a vendor-only CATEGORY (designer role) — not a production step.
 * This script:
 *   1. Reactivates the existing CAD row (or creates one if missing).
 *   2. Sets its sortOrder to 0 so it precedes CAM in accidental UI
 *      iterations but is filtered out of production dropdowns by
 *      DESIGNER_PROCESSES anyway.
 *
 * Idempotent. Safe to re-run.
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.process.findUnique({ where: { code: 'CAD' } });
  if (existing) {
    await prisma.process.update({
      where: { id: existing.id },
      data: { status: 'ACTIVE', sortOrder: 0, name: 'CAD' },
    });
    console.log(`✓ Reactivated CAD (#${existing.id}) — sortOrder=0, status=ACTIVE.`);
  } else {
    const created = await prisma.process.create({
      data: {
        code: 'CAD',
        name: 'CAD',
        sortOrder: 0,
        bomCapable: false,
        bifurcates: false,
        status: 'ACTIVE',
      },
    });
    console.log(`✓ Created CAD (#${created.id}) — sortOrder=0, ACTIVE.`);
  }
  console.log('CAD is now available as a designer vendor-category.');
  console.log('  · Item Master → Designer picker will show CAD-tagged vendors.');
  console.log('  · Production/batch dropdowns filter it out via DESIGNER_PROCESSES.');
}
main().finally(() => prisma.$disconnect());
