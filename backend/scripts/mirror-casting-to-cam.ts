/**
 * Legacy Items still declare only a CASTING ItemProcess row — the batch
 * form now looks for CAM as the entry process, so those designs appear
 * empty in the "Design (Production Ready)" dropdown.
 *
 * Fix: for every item that has a CASTING ItemProcess but no CAM
 * ItemProcess, mirror the row (vendors, attributes, rates) onto CAM so
 * the batch form can find defaults.
 *
 * Idempotent — skips items that already have a CAM row.
 * Non-destructive — the CASTING row stays intact.
 *
 * Run:  npx tsx scripts/mirror-casting-to-cam.ts
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const cam = await prisma.process.findFirst({ where: { code: 'CAM' } });
  if (!cam) throw new Error('CAM process not found — run npx prisma db seed first.');
  const casting = await prisma.process.findFirst({ where: { code: 'CASTING' } });
  if (!casting) throw new Error('CASTING process not found.');

  const withCasting = await prisma.itemProcess.findMany({
    where: { processId: casting.id },
    include: {
      services: true,
      attributes: true,
      vendors: true,
      item: { select: { id: true, sampleDesignCode: true } },
    },
  });
  console.log(`Found ${withCasting.length} items with CASTING ItemProcess rows.`);

  let created = 0, skipped = 0;
  for (const ip of withCasting) {
    const already = await prisma.itemProcess.findUnique({
      where: { itemId_processId: { itemId: ip.itemId, processId: cam.id } },
    });
    if (already) { skipped++; continue; }

    await prisma.itemProcess.create({
      data: {
        itemId: ip.itemId,
        processId: cam.id,
        notes: ip.notes,
        attributes: {
          create: ip.attributes.map((a) => ({
            attrKey: a.attrKey,
            attrValue: a.attrValue,
          })),
        },
        vendors: {
          create: ip.vendors.map((v) => ({
            vendorId: v.vendorId,
            vendorDesignReference: v.vendorDesignReference,
            costPerPiece: v.costPerPiece,
            isPreferred: v.isPreferred,
          })),
        },
      },
    });
    created++;
    console.log(`  ✓ Mirrored ${ip.item.sampleDesignCode} → CAM`);
  }
  console.log(`\nDone. Created ${created} CAM rows, skipped ${skipped} (already had CAM).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
