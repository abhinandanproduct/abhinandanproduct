/**
 * Undo the duplicate KACHA_FITTING receipts on B0002.
 *
 * Investigation found R00011..R00017 were 7 identical posts of R00010's
 * payload (12 pcs #46 + 6 pcs #47) — clearly spam-clicks on Save. Deleting
 * these + cascading receipt items restores the stage totals.
 *
 * Also FILING #42: R00006 and R00007 both posted 6 pcs 7 seconds apart —
 * R00007 is a duplicate. R00006 is the real one.
 *
 * IMPORTANT — run once, verify with investigate-b0002 afterwards.
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const TO_DELETE = ['R00007', 'R00011', 'R00012', 'R00013', 'R00014', 'R00015', 'R00016', 'R00017'];

async function main() {
  for (const receiptNumber of TO_DELETE) {
    const r = await prisma.castingReceipt.findFirst({ where: { receiptNumber } });
    if (!r) { console.log(`  · ${receiptNumber} not found — skipped.`); continue; }
    await prisma.$transaction([
      // Cascade would work via schema, but be explicit for the log.
      prisma.castingReceiptItem.deleteMany({ where: { receiptId: r.id } }),
      prisma.castingReceipt.delete({ where: { id: r.id } }),
    ]);
    console.log(`  ✗ Deleted ${receiptNumber} (id #${r.id})`);
  }
  console.log('\nDone. Run investigate-b0002.ts again to verify totals are back to sane values.');
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
