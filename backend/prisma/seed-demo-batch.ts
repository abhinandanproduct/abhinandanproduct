/**
 * Seed a fully-walked-through CastingBatch for DEMO-NK-001 (the Royal
 * Layered Necklace, which has 2 plating colours — Gold + Rhodium).
 *
 * After running this script, the batch will be sitting at PACKING with all
 * 100 pcs accepted and ready for the new Categorize → Dispatch → Warehouse
 * flow. The user opens the batch in the UI, clicks the "Send to Categorize"
 * button on the packing row, and immediately sees the two plating buckets
 * (60 pcs Gold + 40 pcs Rhodium) waiting to be split into collections.
 *
 * Why a 60 / 40 split? Multi-bucket categorization is the interesting test —
 * a 50/50 split would also work; 60/40 is just more realistic.
 *
 * Run:  npx ts-node prisma/seed-demo-batch.ts
 *
 * Idempotent — re-running deletes the previous demo batch (by batch number)
 * and re-seeds. Safe to re-run after schema/seed-script changes.
 *
 * NOTE: This writes the state DIRECTLY via Prisma rather than going through
 * the casting service. That means side effects (material issue vouchers,
 * cost roll-ups, vendor-ledger rows) are SKIPPED. The categorize / dispatch
 * flow doesn't care about any of those — it reads stageProcess + color +
 * acceptedQty + parentItemId only — so this is the simplest possible state
 * setup that lets the new flow be tested end-to-end.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const BATCH_NUMBER = 'DEMO-BATCH-NK-001';
const GOLD_QTY = 60;
const RHODIUM_QTY = 40;
const TOTAL_QTY = GOLD_QTY + RHODIUM_QTY;
const PER_PIECE_WEIGHT = 18; // grams — matches DEMO-NK-001's Casting attributes

async function findOneVendor(name: string) {
  const v = await prisma.vendor.findFirst({ where: { vendorName: name } });
  if (!v) throw new Error(`Vendor "${name}" not found. Run prisma/seed-demo-items.ts first.`);
  return v;
}

async function getProcess(code: string) {
  const p = await prisma.process.findUnique({ where: { code } });
  if (!p) throw new Error(`Process ${code} missing. Run prisma/seed.ts first.`);
  return p;
}

async function main() {
  // Cleanup: drop any prior DEMO batch so the seed is idempotent.
  const prior = await prisma.castingBatch.findUnique({ where: { batchNumber: BATCH_NUMBER } });
  if (prior) {
    // FinishedGoodVariants for this batch ARE cascade-deleted (schema has
    // onDelete: Cascade on the batch FK), so a single delete cleans up
    // variants + box groups + box movements too. Stage rows + receipts
    // are also cascade-deleted via the batch FK.
    await prisma.castingBatch.delete({ where: { id: prior.id } });
    console.log(`Cleaned up prior batch ${BATCH_NUMBER}.`);
  }

  // Look up the item + vendors + processes.
  const item = await prisma.item.findUnique({ where: { sampleDesignCode: 'DEMO-NK-001' } });
  if (!item) throw new Error('DEMO-NK-001 not found. Run prisma/seed-demo-items.ts first.');

  const vendors = {
    CASTING:       await findOneVendor('Demo Casting Co.'),
    PLATING:       await findOneVendor('Shine Plating Works'),
    ANTIQUE:       await findOneVendor('Demo Antique Finishers'),
    MEENA:         await findOneVendor('Color Meena Studio'),
    KACHU_FITTING: await findOneVendor('Kacha Fit Karigars'),
    FITTING:       await findOneVendor('Fitting Karigar Hub'),
    MALA:          await findOneVendor('Mala Stringing Co.'),
    STICKING:      await findOneVendor('Sticking Karigars'),
    PACKING:       await findOneVendor('Final Pack Hub'),
  } as const;

  const processes = {
    CASTING:       await getProcess('CASTING'),
    PLATING:       await getProcess('PLATING'),
    ANTIQUE:       await getProcess('ANTIQUE'),
    MEENA:         await getProcess('MEENA'),
    KACHU_FITTING: await getProcess('KACHU_FITTING'),
    FITTING:       await getProcess('FITTING'),
    MALA:          await getProcess('MALA'),
    STICKING:      await getProcess('STICKING'),
    PACKING:       await getProcess('PACKING'),
  } as const;

  // ── Create the batch row itself (the manufacturing journey lives in
  // CastingBatchItem rows + their lineKey chain). ────────────────────────
  const batch = await prisma.castingBatch.create({
    data: {
      batchNumber: BATCH_NUMBER,
      processId: processes.CASTING.id,
      batchDate: new Date(),
      status: 'OPEN',
      notes: 'Demo end-to-end batch. Walked through every process for DEMO-NK-001 — 60 Gold + 40 Rhodium pcs at Packing, ready to categorize.',
    },
  });

  // Helper: create one stage row + its accompanying receipt that marks all
  // pcs accepted. Each stage is one CastingBatchItem; the receipt-item
  // attaches acceptedQty so the dispatch service sees idle=accepted on
  // PACKING rows (no further forwarding from packing).
  let receiptCounter = 1;
  async function createStage(opts: {
    parentItemId: number | null;
    processCode: keyof typeof processes;
    qty: number;
    lineKey: string;
    color?: string | null;
  }) {
    const proc = processes[opts.processCode];
    const vendor = vendors[opts.processCode];
    const stage = await prisma.castingBatchItem.create({
      data: {
        batchId: batch.id,
        itemId: item!.id,
        itemNumber: item!.itemNumber ?? item!.sampleDesignCode,
        itemName: item!.itemName,
        vendorId: vendor.id,
        quantity: opts.qty,
        weight: PER_PIECE_WEIGHT,
        totalWeight: PER_PIECE_WEIGHT * opts.qty,
        processId: proc.id,
        parentItemId: opts.parentItemId,
        lineKey: opts.lineKey,
        color: opts.color ?? null,
      },
    });
    const receiptNumber = `${BATCH_NUMBER}-R${String(receiptCounter++).padStart(3, '0')}`;
    const receipt = await prisma.castingReceipt.create({
      data: {
        batchId: batch.id,
        vendorId: vendor.id,
        receiptNumber,
        receiptDate: new Date(),
      },
    });
    await prisma.castingReceiptItem.create({
      data: {
        receiptId: receipt.id,
        batchItemId: stage.id,
        receivedQty: opts.qty,
        receivedWeight: PER_PIECE_WEIGHT * opts.qty,
        acceptedQty: opts.qty,
        repairQty: 0,
        rejectedQty: 0,
      },
    });
    return stage;
  }

  // ── Stage 1: CASTING (parent = null) ─────────────────────────────────────
  const castingStage = await createStage({
    parentItemId: null,
    processCode: 'CASTING',
    qty: TOTAL_QTY,
    lineKey: 'L1',
    color: null,
  });
  console.log(`✓ CASTING — ${TOTAL_QTY} pcs accepted.`);

  // ── Stage 2: split into 2 PLATING colour chains ──────────────────────────
  // Each chain runs through every downstream process on its own lineKey so
  // categorize sees TWO buckets (60 Gold + 40 Rhodium). The parentItemId
  // chain lets the dispatch service walk packing → plating to recover the
  // colour at categorize time.
  async function walkChain(args: { colour: 'Gold' | 'Rhodium'; qty: number; lineKey: string }) {
    const plating = await createStage({
      parentItemId: castingStage.id,
      processCode: 'PLATING',
      qty: args.qty,
      lineKey: args.lineKey,
      color: args.colour,
    });
    console.log(`  ✓ PLATING (${args.colour}) — ${args.qty} pcs accepted.`);

    // Meena colour mirrors the plating choice (Red for Gold, Green for Rhodium).
    const meenaColour = args.colour === 'Gold' ? 'Red' : 'Green';

    let parent: typeof plating = plating;
    const downstream: Array<{ code: keyof typeof processes; color?: string }> = [
      { code: 'ANTIQUE' },
      { code: 'MEENA',         color: meenaColour },
      { code: 'KACHU_FITTING' },
      { code: 'FITTING',       color: args.colour },
      { code: 'MALA',          color: args.colour },
      { code: 'STICKING',      color: args.colour },
      { code: 'PACKING' },
    ];
    for (const stage of downstream) {
      parent = await createStage({
        parentItemId: parent.id,
        processCode: stage.code,
        qty: args.qty,
        lineKey: args.lineKey,
        color: stage.color,
      });
      console.log(`  ✓ ${stage.code}${stage.color ? ` (${stage.color})` : ''} — ${args.qty} pcs accepted.`);
    }
  }

  await walkChain({ colour: 'Gold',    qty: GOLD_QTY,    lineKey: 'L-GOLD' });
  await walkChain({ colour: 'Rhodium', qty: RHODIUM_QTY, lineKey: 'L-RHOD' });

  console.log(`\n🏭 Batch ${BATCH_NUMBER} is fully walked through every process.`);
  console.log(`   ${GOLD_QTY} Gold pcs + ${RHODIUM_QTY} Rhodium pcs are sitting at PACKING.`);
  console.log(`   Open the batch in the UI — the "Send to Categorize" button is on each PACKING stage row.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
