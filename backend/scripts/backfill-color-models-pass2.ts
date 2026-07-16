// Pass 2: propagate colorModel along the parent-child tree.
//
// Pass 1 (backfill-color-models.ts) tagged every colour-bearing stage with
// its variant. But the colourless intermediates — Antique, Kachu Fitting,
// Packing, and untagged trunks (Casting before split) — were left with NULL
// colorModel.
//
// Rules for propagation:
//   1. CHILD INHERITS FROM PARENT: a colourless stage whose parent has a
//      colorModel takes the parent's variant. (Antique → inherits from
//      the Plating colour it came from.)
//   2. PARENT INHERITS FROM SINGLE CHILD: a colourless trunk whose only
//      direct child has a colorModel takes that child's variant. (Casting
//      with one Plating child inherits.)
//   3. AMBIGUOUS TRUNK: a Casting that splits into multiple variants stays
//      NULL — there's no single right answer. The UI shows "—".
//
// Iterates to a fixed point so multi-step chains (Casting → Plating → Antique
// → Kachu) all propagate even if only ONE link has the colour.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const stages = await prisma.castingBatchItem.findMany({
    select: { id: true, batchId: true, parentItemId: true, colorModel: true, processId: true },
    orderBy: { id: 'asc' },
  });
  const byId = new Map(stages.map((s) => [s.id, s]));
  const childrenByParent = new Map<number, typeof stages>();
  for (const s of stages) {
    if (s.parentItemId == null) continue;
    const arr = childrenByParent.get(s.parentItemId) ?? [];
    arr.push(s);
    childrenByParent.set(s.parentItemId, arr);
  }

  let total = 0;
  let pass = 0;
  while (true) {
    pass++;
    let updated = 0;
    for (const s of stages) {
      if (s.colorModel) continue;
      // Rule 1: inherit from parent if parent has colorModel.
      if (s.parentItemId != null) {
        const parent = byId.get(s.parentItemId);
        if (parent?.colorModel) {
          s.colorModel = parent.colorModel;
          updated++;
          continue;
        }
      }
      // Rule 2: inherit from single child with a colorModel.
      const kids = childrenByParent.get(s.id) ?? [];
      const tagged = kids.filter((k) => k.colorModel);
      const uniqueModels = new Set(tagged.map((k) => k.colorModel!));
      if (uniqueModels.size === 1 && kids.length === tagged.length) {
        s.colorModel = tagged[0].colorModel;
        updated++;
      }
    }
    if (updated === 0) break;
    total += updated;
    console.log(`pass ${pass}: ${updated} stage(s) tagged`);
  }

  // Write back to DB in chunks.
  const dirty = stages.filter((s) => s.colorModel);
  console.log(`Writing ${total} updated stages...`);
  for (let i = 0; i < dirty.length; i += 200) {
    const chunk = dirty.slice(i, i + 200);
    await prisma.$transaction(
      chunk.map((s) =>
        prisma.castingBatchItem.update({
          where: { id: s.id },
          data: { colorModel: s.colorModel },
        }),
      ),
    );
  }
  console.log('Done.');
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
