// Backfill ItemColorModel + ItemColorModelProcess for every item that has
// production data but no defined colour models, then snapshot the matching
// "letter — name" tag onto every existing stage's `colorModel` field.
//
// Strategy:
//   1. For each item, scan its stages across all batches.
//   2. Group stages by (batchId, lineKey) — that's one colour branch.
//   3. The colours used at COLOR_MODEL_PROCESSES in that branch form a
//      "variant signature". Distinct signatures = distinct ItemColorModels.
//   4. Letter a, b, c… assigned in first-seen order; name = the most
//      identifying colour (Meena > Sticking > Plating > first available).
//   5. Stage.colorModel is set to "letter — name" so the new "Our Code"
//      column in the production tracker actually shows something.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const COLOR_PROCESSES = ['PLATING', 'MEENA', 'FITTING', 'MALA', 'STICKING'];

async function main() {
  const processes = await prisma.process.findMany();
  const procByCode = new Map(processes.map((p) => [p.code, p.id]));

  const items = await prisma.item.findMany({
    where: { castingBatchRows: { some: {} } },
    select: { id: true, itemNumber: true, itemName: true },
  });
  console.log(`Found ${items.length} items with production rows.`);

  let totalVariantsCreated = 0;
  let totalStagesBackfilled = 0;

  for (const item of items) {
    const stages = await prisma.castingBatchItem.findMany({
      where: { itemId: item.id },
      include: { stageProcess: true },
    });
    if (stages.length === 0) continue;

    // Group stages by (batchId, lineKey) — one colour branch.
    const branches = new Map<string, { batchId: number; lineKey: string; colours: Map<string, string> }>();
    for (const s of stages) {
      if (!s.lineKey || !s.stageProcess) continue;
      const key = `${s.batchId}:${s.lineKey}`;
      const branch = branches.get(key) ?? { batchId: s.batchId, lineKey: s.lineKey, colours: new Map() };
      if (s.color && COLOR_PROCESSES.includes(s.stageProcess.code)) {
        branch.colours.set(s.stageProcess.code, s.color);
      }
      branches.set(key, branch);
    }

    // Distinct colour signatures → distinct variants.
    const signatures = new Map<string, { colours: Record<string, string>; branches: string[] }>();
    for (const [bk, b] of branches) {
      const obj: Record<string, string> = {};
      for (const code of COLOR_PROCESSES) {
        const c = b.colours.get(code);
        if (c) obj[code] = c;
      }
      const sig = Object.entries(obj).sort(([a], [c]) => a.localeCompare(c)).map(([p, c]) => `${p}:${c}`).join('|');
      if (!sig) continue; // branch with no colour info — skip
      const entry = signatures.get(sig) ?? { colours: obj, branches: [] };
      entry.branches.push(bk);
      signatures.set(sig, entry);
    }
    if (signatures.size === 0) continue;

    // Wipe and rebuild colour models for this item (idempotent).
    await prisma.itemColorModel.deleteMany({ where: { itemId: item.id } });

    let order = 0;
    const branchToVariant = new Map<string, { letter: string; name: string }>();
    for (const [, entry] of signatures) {
      const letter = String.fromCharCode(97 + (order % 26));
      const namePick = entry.colours['MEENA'] || entry.colours['STICKING'] || entry.colours['PLATING'] || entry.colours['FITTING'] || entry.colours['MALA'] || Object.values(entry.colours)[0];
      const variantName = namePick || 'Default';
      const cm = await prisma.itemColorModel.create({
        data: {
          itemId: item.id,
          letter,
          name: variantName,
          sortOrder: order,
          processColors: {
            create: Object.entries(entry.colours).map(([procCode, color]) => ({
              processId: procByCode.get(procCode)!,
              color,
            })),
          },
        },
      });
      for (const bk of entry.branches) {
        branchToVariant.set(bk, { letter: cm.letter, name: cm.name });
      }
      order++;
      totalVariantsCreated++;
    }

    // Snapshot colorModel on every stage in each branch.
    for (const s of stages) {
      if (!s.lineKey) continue;
      const bk = `${s.batchId}:${s.lineKey}`;
      const v = branchToVariant.get(bk);
      if (!v) continue;
      await prisma.castingBatchItem.update({
        where: { id: s.id },
        data: { colorModel: `${v.letter} — ${v.name}` },
      });
      totalStagesBackfilled++;
    }

    if (signatures.size > 0) {
      console.log(`  ${item.itemNumber ?? '#?'} (${item.itemName ?? '—'}): ${signatures.size} variant(s), ${stages.length} stages backfilled`);
    }
  }

  // Items WITHOUT any production data — give them ONE default variant
  // ("a — Standard") so the item master form has something to show. The
  // owner can edit later to add real colour info.
  const itemsNoProduction = await prisma.item.findMany({
    where: { castingBatchRows: { none: {} }, colorModels: { none: {} } },
    select: { id: true, itemNumber: true },
  });
  for (const item of itemsNoProduction) {
    await prisma.itemColorModel.create({
      data: { itemId: item.id, letter: 'a', name: 'Standard', sortOrder: 0 },
    });
    totalVariantsCreated++;
  }
  if (itemsNoProduction.length > 0) {
    console.log(`Created default "a — Standard" variant for ${itemsNoProduction.length} item(s) without production data.`);
  }

  console.log(`\nDone. ${totalVariantsCreated} variants created, ${totalStagesBackfilled} stages backfilled.`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
