// Simulate slipItem() output for the test stage to verify the sticking BOM
// is correctly attached to the slip data — which is what the PDF render
// reads to draw the "Material Reconciliation" block.
//
// If `materials` comes back populated, the slip WILL include the BOM block.

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  // The test batch + stage from the previous runthrough
  const TEST_STAGE_ID = 4009;

  // Set colour on the stage so the colour filter in buildStickingBom matches.
  // In a real workflow the stage's colour is set when forwarding from
  // Casting to Sticking (the forward dialog asks for it).
  await p.castingBatchItem.update({
    where: { id: TEST_STAGE_ID },
    data: { color: 'Green', processId: 7 /* STICKING */ },
  });
  console.log('Set test stage colour to Green, process to STICKING');

  // Fetch the stage like vendorPdfData / stagePdfData would
  const stage = await p.castingBatchItem.findUnique({
    where: { id: TEST_STAGE_ID },
    include: { vendor: true, stageProcess: true, batch: true },
  });
  console.log('Stage:', { id: stage.id, qty: stage.quantity, color: stage.color, procCode: stage.stageProcess?.code, itemId: stage.itemId });

  // ── Simulate slipItem's BOM path ──
  const BOM_PROCESS_CODES = ['STICKING', 'KACHU_FITTING', 'FITTING', 'PACKING'];
  const procCode = stage.stageProcess?.code;
  let materials;
  if (procCode && BOM_PROCESS_CODES.includes(procCode) && stage.itemId) {
    let src = [];
    if (procCode === 'STICKING') {
      // Use the snapshot if present, otherwise live build
      const snap = Array.isArray(stage.bomSnapshot) ? stage.bomSnapshot : null;
      if (snap) {
        console.log('  Using BOM snapshot from issue time (' + snap.length + ' lines)');
        src = snap;
      } else {
        console.log('  No snapshot — building BOM live from itemMaterial');
        const all = await p.itemMaterial.findMany({
          where: { itemId: stage.itemId, process: { code: 'STICKING' } },
          include: { variant: true },
        });
        console.log('    Raw STICKING rows for item: ' + all.length);
        const sc = (stage.color ?? '').trim().toLowerCase();
        const bom = all.filter((l) => !l.color || (sc && l.color.trim().toLowerCase() === sc));
        console.log('    After colour filter (' + (sc || '(none)') + '): ' + bom.length);
        src = bom.map((line) => ({
          variantId: line.variantId,
          variantCode: line.variant.variantCode,
          variantName: line.variant.variantName,
          unit: line.variant.unit ?? null,
          perPiece: Math.max(1, Math.round(Number(line.quantity))),
          required: Math.max(1, Math.round(Number(line.quantity))) * stage.quantity,
        }));
      }
    } else {
      // Shared BOM for Kacha / Fitting / Packing
      const bomLines = await p.itemMaterial.findMany({
        where: { itemId: stage.itemId, process: { code: procCode } },
        include: { variant: { include: { material: true } } },
      });
      src = bomLines.map((m) => ({
        variantId: m.variantId,
        variantName: m.variant.variantName ?? m.variant.material?.materialName ?? '—',
        variantCode: m.variant.variantCode ?? null,
        required: Math.ceil(Number(m.quantity) * stage.quantity * (1 + (Number(m.wastagePercent) || 0) / 100)),
        unit: m.unit ?? m.variant.unit ?? null,
      }));
    }
    materials = src.map((line) => ({
      name: line.variantName,
      variantCode: line.variantCode ?? null,
      required: line.required,
      unit: line.unit ?? null,
      issuedQty: 0,
      deferredQty: 0,
    }));
  }

  console.log('\n────────────────────────────────────────');
  console.log('SLIP DATA — materials field:');
  if (!materials || materials.length === 0) {
    console.log('  ✗ EMPTY — slip will NOT show a Materials block.');
  } else {
    console.log('  ✓ ' + materials.length + ' material rows — slip WILL render the "Material Reconciliation" block.');
    for (const m of materials) {
      console.log('    ' + (m.variantCode ?? '—').padEnd(10) + (m.name ?? '').padEnd(30) + ' required=' + m.required + (m.unit ? ' ' + m.unit : ''));
    }
  }

  // Now try the OTHER processes (Kacha/Fitting/Packing) too — using
  // the same item but a hypothetical stage of those types.
  console.log('\n────────────────────────────────────────');
  for (const code of ['KACHU_FITTING', 'FITTING', 'PACKING']) {
    const bomLines = await p.itemMaterial.findMany({
      where: { itemId: stage.itemId, process: { code } },
      include: { variant: { include: { material: true } } },
    });
    console.log(code + ': ' + bomLines.length + ' BOM rows (would render on slip)');
    for (const m of bomLines) {
      const req = Math.ceil(Number(m.quantity) * 43);
      console.log('    ' + (m.variant.variantCode ?? '—').padEnd(10) + (m.variant.variantName ?? '').padEnd(30) + ' required=' + req);
    }
  }

  await p.$disconnect();
})();
