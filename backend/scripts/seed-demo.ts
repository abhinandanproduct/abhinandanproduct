/**
 * Demo data + full-workflow runner.
 *
 * What it creates (idempotent — safe to re-run):
 *   • 10 designer vendors (tagged DESIGN_CAD).
 *   • 8 raw-material variants with opening stock.
 *   • 65 production-ready item designs with random pipelines (Casting → Plating
 *     → Meena → Fitting → Sticking → Packing) and per-colour vendors.
 *
 * What it executes:
 *   • ONE end-to-end production batch (5 designs) walked from Casting all the
 *     way to Packing, with colour splits at Plating + Meena, sticking material
 *     consumption, and final receipts. Console output shows each step.
 *
 * Usage:
 *   cd backend
 *   npx ts-node scripts/seed-demo.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ---------- helpers ----------
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const pickN = <T,>(arr: T[], n: number): T[] => {
  const copy = [...arr]; const out: T[] = [];
  for (let i = 0; i < n && copy.length; i++) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  return out;
};
const rint = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const log = (msg: string) => console.log(msg);
const step = (n: string, msg: string) => console.log(`\n[${n}] ${msg}`);

// ---------- main ----------
async function main() {
  step('SETUP', 'Reading existing processes, categories, vendors, materials…');

  const processes = await prisma.process.findMany({ where: { status: 'ACTIVE' } });
  const procByCode = new Map(processes.map((p) => [p.code, p]));
  const need = ['DESIGN_CAD', 'CASTING', 'PLATING', 'MEENA', 'FITTING', 'STICKING', 'PACKING'];
  for (const c of need) if (!procByCode.has(c)) throw new Error(`Missing process: ${c}. Run prisma seed first.`);

  const supplierProc = procByCode.get('RAW_MATERIAL_SUPPLIER')!;
  const designProc = procByCode.get('DESIGN_CAD')!;
  const castingProc = procByCode.get('CASTING')!;
  const platingProc = procByCode.get('PLATING')!;
  const meenaProc = procByCode.get('MEENA')!;
  const fittingProc = procByCode.get('FITTING')!;
  const stickingProc = procByCode.get('STICKING')!;
  const packingProc = procByCode.get('PACKING')!;

  // ---------- 1. Designer vendors ----------
  step('1', 'Ensuring 10 designer vendors exist…');
  const designerNames = [
    { name: 'Sapna Designs', short: 'SD' },
    { name: 'Aarav Creations', short: 'AC' },
    { name: 'Mehak Designs', short: 'MD' },
    { name: 'Nikita Studio', short: 'NS' },
    { name: 'Yash Designs', short: 'YD' },
    { name: 'Riddhi Creations', short: 'RC' },
    { name: 'Tanvi Designs', short: 'TD' },
    { name: 'Krish Studio', short: 'KS' },
    { name: 'Disha Creations', short: 'DC' },
    { name: 'Vivek Designs', short: 'VD' },
  ];
  // Get next vendor seq.
  const lastVendor = await prisma.vendor.findFirst({ orderBy: { vendorCode: 'desc' } });
  let vseq = lastVendor ? parseInt(lastVendor.vendorCode.replace(/\D/g, ''), 10) || 0 : 0;
  const designers: any[] = [];
  for (const d of designerNames) {
    let v = await prisma.vendor.findFirst({ where: { vendorName: d.name } });
    if (!v) {
      vseq++;
      v = await prisma.vendor.create({
        data: {
          vendorCode: 'V' + String(vseq).padStart(4, '0'),
          vendorName: d.name, shortName: d.short, status: 'ACTIVE',
          processes: { create: [{ processId: designProc.id }] },
        },
      });
      log(`  + designer ${v.vendorCode} ${v.vendorName}`);
    }
    designers.push(v);
  }

  // ---------- 2. Material variants with stock ----------
  step('2', 'Ensuring raw-material variants exist with stock…');
  const supplier = await prisma.vendor.findFirst({
    where: { processes: { some: { processId: supplierProc.id } } },
  });
  if (!supplier) throw new Error('No raw-material supplier vendor found. Run prisma seed first.');

  const matCat = await prisma.materialCategory.findFirst({ where: { name: 'Stones' } });
  const materialDefs = [
    { name: 'Pearl', variants: [{ name: 'Pearl White 4mm', size: '4mm', color: 'White', stock: 50000 }, { name: 'Pearl Cream 5mm', size: '5mm', color: 'Cream', stock: 35000 }] },
    { name: 'Stone', variants: [{ name: 'Stone Ruby 5mm', size: '5mm', color: 'Ruby', stock: 40000 }, { name: 'Stone Emerald 5mm', size: '5mm', color: 'Emerald', stock: 30000 }, { name: 'Stone Diamond 3mm', size: '3mm', color: 'Diamond', stock: 60000 }] },
    { name: 'JumpRing', variants: [{ name: 'JumpRing Gold 8mm', size: '8mm', color: 'Gold', stock: 25000 }] },
    { name: 'Chain', variants: [{ name: 'Chain Gold 1mm', size: '1mm', color: 'Gold', stock: 5000 }] },
    { name: 'Hook', variants: [{ name: 'Hook Standard', size: 'std', color: 'Gold', stock: 10000 }] },
  ];
  const variants: any[] = [];
  for (const md of materialDefs) {
    let mat = await prisma.material.findFirst({ where: { materialName: md.name } });
    if (!mat) {
      const matCount = await prisma.material.count();
      mat = await prisma.material.create({
        data: {
          materialCode: 'M' + String(matCount + 1).padStart(4, '0'),
          materialName: md.name,
          categoryId: matCat?.id ?? null,
        },
      });
    }
    for (const vDef of md.variants) {
      let v = await prisma.materialVariant.findFirst({ where: { variantName: vDef.name } });
      if (!v) {
        const vCount = await prisma.materialVariant.count();
        v = await prisma.materialVariant.create({
          data: {
            materialId: mat.id,
            variantCode: 'MV' + String(vCount + 1).padStart(5, '0'),
            variantName: vDef.name,
            size: vDef.size, color: vDef.color, unit: 'pcs',
            stockQty: vDef.stock,
            vendors: { create: [{ vendorId: supplier.id, price: rint(2, 15), isPreferred: true }] },
          },
        });
        await prisma.stockMovement.create({
          data: {
            variantId: v.id, type: 'IN', quantity: vDef.stock, balanceAfter: vDef.stock,
            refType: 'opening_stock', refId: v.id, note: 'Opening stock at seed',
          },
        });
        log(`  + ${v.variantCode} ${v.variantName} · stock ${vDef.stock}`);
      }
      variants.push(v);
    }
  }

  // ---------- 3. Production-ready designs ----------
  step('3', 'Creating production-ready item designs (target: 65 total)…');
  const categories = ['Necklace', 'Earring', 'Bangle', 'Ring', 'Pendant', 'Bracelet', 'Anklet', 'Set', 'Choker'];
  const collections = ['Royal', 'Classic', 'Modern', 'Heritage', 'Wedding', 'Casual', 'Festive'];
  const platingColours = ['Gold', 'Bhari Gold', 'Rose Gold', 'Silver'];
  const meenaColours = ['Ruby', 'Pink', 'Green', 'Blue', 'Red'];

  // Get vendors for each process.
  const vendorsByProc: Record<string, any[]> = {};
  for (const code of ['CASTING', 'PLATING', 'MEENA', 'FITTING', 'STICKING', 'PACKING']) {
    const p = procByCode.get(code)!;
    vendorsByProc[code] = await prisma.vendor.findMany({
      where: { status: 'ACTIVE', processes: { some: { processId: p.id } } },
    });
    if (vendorsByProc[code].length === 0) throw new Error(`No vendors for process ${code}`);
  }

  const existingDesigns = await prisma.item.findMany();
  const existingByItemNumber = new Map(existingDesigns.map((d) => [d.itemNumber, d]));
  const TARGET = 65;
  let created = 0;
  let nextItemNum = 5000; // start high to avoid clashes
  while (await prisma.item.count({ where: { sampleStatus: 'PRODUCTION_READY' } }) < TARGET) {
    while (existingByItemNumber.has(String(nextItemNum))) nextItemNum++;
    const itemNumber = String(nextItemNum);
    const designer = pick(designers);
    const category = pick(categories);
    const collection = pick(collections);
    const sampleDesignCode = `${designer.shortName}-${itemNumber}`;
    const castingWeight = rint(5, 45);
    const sellPrice = rint(500, 5000);

    // Pick 1-2 plating colours and 1-3 meena colours.
    const platCols = pickN(platingColours, rint(1, 2));
    const meenaCols = pickN(meenaColours, rint(1, 3));

    const castingVendor = pick(vendorsByProc.CASTING);
    const fittingVendor = pick(vendorsByProc.FITTING);
    const stickingVendor = pick(vendorsByProc.STICKING);
    const packingVendor = pick(vendorsByProc.PACKING);

    // Random pick of materials for sticking BOM (per colour).
    const bomVariants = pickN(variants, rint(2, 4));

    try {
      const item = await prisma.item.create({
        data: {
          sampleDesignCode,
          itemNumber,
          itemName: `${collection} ${category}`,
          category, collection,
          designerName: designer.vendorName, designerShortName: designer.shortName,
          designCost: rint(50, 300),
          sellingPrice: sellPrice,
          sampleStatus: 'PRODUCTION_READY',
          processes: {
            create: [
              // Casting
              {
                processId: castingProc.id,
                vendors: { create: [{ vendorId: castingVendor.id, isPreferred: true, costPerPiece: rint(80, 250) }] },
                attributes: { create: [{ attrKey: 'weight', attrValue: String(castingWeight) }] },
              },
              // Plating — per colour
              {
                processId: platingProc.id,
                vendors: {
                  create: platCols.map((col, i) => ({
                    vendorId: pick(vendorsByProc.PLATING).id,
                    color: col,
                    isPreferred: i === 0,
                    costPerPiece: rint(20, 80),
                  })),
                },
              },
              // Meena — per colour
              {
                processId: meenaProc.id,
                vendors: {
                  create: meenaCols.map((col, i) => ({
                    vendorId: pick(vendorsByProc.MEENA).id,
                    color: col,
                    isPreferred: i === 0,
                    costPerPiece: rint(10, 40),
                  })),
                },
              },
              // Fitting (no colour)
              {
                processId: fittingProc.id,
                vendors: { create: [{ vendorId: fittingVendor.id, isPreferred: true, costPerPiece: rint(15, 50) }] },
              },
              // Sticking — per colour matching Meena (BOM only for first colour for brevity)
              {
                processId: stickingProc.id,
                vendors: {
                  create: meenaCols.map((col, i) => ({
                    vendorId: stickingVendor.id, color: col, isPreferred: i === 0,
                    costPerPiece: rint(8, 35),
                    bringsOwnMaterials: i % 5 === 0, // ~20% bring own
                  })),
                },
              },
              // Packing
              {
                processId: packingProc.id,
                vendors: { create: [{ vendorId: packingVendor.id, isPreferred: true, costPerPiece: rint(5, 20) }] },
              },
            ],
          },
          // BOM — first BOM variant maps to first meena colour (rest are 0-colour common lines).
          materials: {
            create: bomVariants.map((bv, i) => ({
              variantId: bv.id,
              quantity: rint(2, 8),
              color: i === 0 ? meenaCols[0] : null,
            })),
          },
        },
      });
      created++;
      if (created % 10 === 0) log(`  created ${created} designs so far…`);
      nextItemNum++;
    } catch (e: any) {
      log(`  skip #${itemNumber}: ${e.message?.slice(0, 80) ?? e}`);
      nextItemNum++;
    }
  }
  const totalReady = await prisma.item.count({ where: { sampleStatus: 'PRODUCTION_READY' } });
  log(`  total production-ready designs now: ${totalReady} (added ${created})`);

  // ---------- 4. Run a full workflow batch ----------
  step('4', 'Creating ONE demo batch (5 designs) and walking it to Packing…');

  // Normalise sticking vendor brings-own flags on EXISTING designs — only ~15%
  // truly bring own materials. Without this the seed put every "first" sticking
  // vendor as brings-own, which short-circuits the material-voucher flow.
  log('  normalising sticking-vendor brings-own flags…');
  const stickingProcessId = stickingProc.id;
  const allStickingLinks = await prisma.itemProcessVendor.findMany({
    where: { itemProcess: { processId: stickingProcessId } },
    include: { itemProcess: true },
  });
  // Group by itemId — for each item, only the FIRST entry (by id) keeps potential
  // brings-own; randomly clear it on ~85% of items so we see material vouchers.
  const byItem = new Map<number, any[]>();
  for (const link of allStickingLinks) {
    const arr = byItem.get(link.itemProcess.itemId) ?? [];
    arr.push(link);
    byItem.set(link.itemProcess.itemId, arr);
  }
  let normCount = 0;
  for (const [itemId, links] of byItem) {
    const keepBringsOwn = Math.random() < 0.15; // 15% retain
    for (const link of links) {
      const desired = keepBringsOwn && links.indexOf(link) === 0;
      if (link.bringsOwnMaterials !== desired) {
        await prisma.itemProcessVendor.update({
          where: { id: link.id }, data: { bringsOwnMaterials: desired },
        });
        normCount++;
      }
    }
  }
  log(`  normalised brings-own on ${normCount} sticking links across ${byItem.size} items.`);

  // Pick 54 fresh designs for the demo batch — but only those whose process
  // pipeline is FULLY configured (a vendor entry for every required step).
  // Old legacy items from prior seeds may be missing some, so we filter them
  // out and skip past them — keeps the script idempotent and crash-free.
  const candidateItemsRaw = await prisma.item.findMany({
    where: { sampleStatus: 'PRODUCTION_READY' },
    include: { processes: { include: { process: true, vendors: true, attributes: true } } },
    orderBy: { id: 'desc' },
    take: 120,
  });
  const requiredCodes = ['CASTING', 'PLATING', 'MEENA', 'FITTING', 'STICKING', 'PACKING'];
  const candidateItems = candidateItemsRaw.filter((it: any) =>
    requiredCodes.every((c) => {
      const proc = it.processes.find((p: any) => p.process.code === c);
      return proc && proc.vendors.length > 0;
    }),
  );
  const demoItems = candidateItems.slice(0, 54);
  if (demoItems.length === 0) throw new Error('No production-ready items to demo with.');

  // Helper for next batch number.
  async function nextBatchNumber() {
    const last = await prisma.castingBatch.findFirst({ orderBy: { batchNumber: 'desc' } });
    const seq = last ? parseInt(last.batchNumber.replace(/\D/g, ''), 10) || 0 : 0;
    return 'B' + String(seq + 1).padStart(4, '0');
  }
  async function nextReceiptNumber() {
    const last = await prisma.castingReceipt.findFirst({ orderBy: { receiptNumber: 'desc' } });
    const seq = last ? parseInt(last.receiptNumber.replace(/\D/g, ''), 10) || 0 : 0;
    return 'R' + String(seq + 1).padStart(5, '0');
  }
  async function nextVoucherNumber() {
    const last = await prisma.materialIssue.findFirst({ orderBy: { voucherNumber: 'desc' } });
    const seq = last ? parseInt(last.voucherNumber.replace(/\D/g, ''), 10) || 0 : 0;
    return 'MIV' + String(seq + 1).padStart(4, '0');
  }

  const batchNumber = await nextBatchNumber();
  const batch = await prisma.castingBatch.create({
    data: {
      batchNumber,
      processId: castingProc.id,
      batchDate: new Date(),
      notes: 'Demo workflow batch — auto-run by seed-demo.ts',
    },
  });
  log(`  + batch ${batch.batchNumber}`);

  // Helper: create one casting stage (root of a design line).
  async function createCastingStage(item: any, qty: number, sortOrder: number) {
    const casting = item.processes.find((p: any) => p.process.code === 'CASTING')!;
    const cv = casting.vendors[0];
    const weight = Number(casting.attributes.find((a: any) => a.attrKey === 'weight')?.attrValue ?? 10);
    const totalWeight = weight * qty;
    const totalCost = (totalWeight / 1000) * Number(cv.costPerPiece ?? 100);
    const stage = await prisma.castingBatchItem.create({
      data: {
        batchId: batch.id, itemId: item.id, itemNumber: item.itemNumber, itemName: item.itemName,
        vendorId: cv.vendorId, weight, quantity: qty, totalWeight,
        costPerKg: cv.costPerPiece, totalCost,
        processId: castingProc.id, sortOrder,
      },
    });
    await prisma.castingBatchItem.update({
      where: { id: stage.id }, data: { lineKey: String(stage.id), issueSlipId: stage.id, issueSlipAt: new Date() },
    });
    return { stage, weight };
  }

  // Helper: create a receipt for a single stage receiving all qty back.
  async function receiveAll(stage: any, weight: number) {
    const recNum = await nextReceiptNumber();
    const totalRecvWt = weight * stage.quantity;
    await prisma.castingReceipt.create({
      data: {
        batchId: batch.id, vendorId: stage.vendorId, receiptNumber: recNum,
        receiptDate: new Date(),
        items: { create: [{ batchItemId: stage.id, receivedQty: stage.quantity, receivedWeight: totalRecvWt }] },
      },
    });
    return recNum;
  }

  // Helper: forward a stage to next process. crossBatch=false here.
  async function forwardStageRaw(parent: any, targetProc: any, qty: number, color: string | null, vendorId: number, weight: number, costPerPiece: number) {
    const isColourSplit = !parent.color && !!color;
    const lineKey = isColourSplit ? null : parent.lineKey;
    const child = await prisma.castingBatchItem.create({
      data: {
        batchId: batch.id, itemId: parent.itemId, itemNumber: parent.itemNumber, itemName: parent.itemName,
        vendorId, weight, quantity: qty, totalWeight: weight * qty,
        costPerKg: costPerPiece,
        totalCost: costPerPiece * qty,
        processId: targetProc.id, parentItemId: parent.id,
        lineKey: lineKey ?? '',
        color: color, colorModel: parent.colorModel,
        issueSlipAt: new Date(),
      },
    });
    if (isColourSplit) {
      await prisma.castingBatchItem.update({ where: { id: child.id }, data: { lineKey: String(child.id), issueSlipId: child.id } });
    } else {
      await prisma.castingBatchItem.update({ where: { id: child.id }, data: { issueSlipId: child.id } });
    }
    return child;
  }

  // ---- WORKFLOW ----
  // For each design: Casting → Plating (one colour) → Meena (one colour) → Fitting → Sticking → Packing
  // One compact log line per design (54 designs would otherwise scroll for ever).
  let sortOrder = 0, totalPcs = 0, totalVouchers = 0, brOwnCount = 0;
  for (let dIdx = 0; dIdx < demoItems.length; dIdx++) {
    const item = demoItems[dIdx];
    const qty = pick([50, 75, 100, 120, 150]);
    totalPcs += qty;
    const stepNotes: string[] = [];

    // CASTING
    const { stage: castStage, weight } = await createCastingStage(item, qty, sortOrder++);
    await receiveAll(castStage, weight);
    stepNotes.push('Casting');

    // PLATING — use first plating vendor's colour
    const plating = item.processes.find((p: any) => p.process.code === 'PLATING');
    const platVendor = plating?.vendors[0]!;
    const platColour = platVendor!.color ?? 'Gold';
    const platStage = await forwardStageRaw(castStage, platingProc, qty, platColour, platVendor.vendorId, weight, Number(platVendor.costPerPiece ?? 30));
    await receiveAll(platStage, weight);
    stepNotes.push(`Plating(${platColour})`);

    // MEENA — use first meena vendor's colour
    const meena = item.processes.find((p: any) => p.process.code === 'MEENA');
    const meenaVendor = meena?.vendors[0]!;
    const meenaColour = meenaVendor?.color ?? 'Ruby';
    const meenaStage = await forwardStageRaw(platStage, meenaProc, qty, meenaColour, meenaVendor.vendorId, weight, Number(meenaVendor.costPerPiece ?? 20));
    await receiveAll(meenaStage, weight);
    stepNotes.push(`Meena(${meenaColour})`);

    // FITTING
    const fitting = item.processes.find((p: any) => p.process.code === 'FITTING');
    const fitVendor = fitting?.vendors[0]!;
    const fitStage = await forwardStageRaw(meenaStage, fittingProc, qty, null, fitVendor.vendorId, weight, Number(fitVendor.costPerPiece ?? 25));
    await receiveAll(fitStage, weight);
    stepNotes.push('Fitting');

    // STICKING — match the meena colour for BOM snapshot
    const sticking = item.processes.find((p: any) => p.process.code === 'STICKING');
    const stickVendor = (sticking?.vendors.find((v: any) => v.color === meenaColour) ?? sticking?.vendors[0])!;
    const stickStage = await forwardStageRaw(fitStage, stickingProc, qty, meenaColour, stickVendor.vendorId, weight, Number(stickVendor.costPerPiece ?? 15));

    // BOM snapshot for this stage.
    const bom = await prisma.itemMaterial.findMany({ where: { itemId: item.id }, include: { variant: true } });
    const matchingBom = bom.filter((b) => !b.color || b.color.trim().toLowerCase() === meenaColour.trim().toLowerCase());
    const snap = matchingBom.map((b) => {
      const perPiece = Math.max(1, Math.round(Number(b.quantity)));
      return { variantId: b.variantId, variantCode: b.variant.variantCode, variantName: b.variant.variantName, unit: b.variant.unit ?? null, perPiece, required: perPiece * qty };
    });
    await prisma.castingBatchItem.update({ where: { id: stickStage.id }, data: { bomSnapshot: snap } });

    // Issue materials (skip if vendor brings own).
    if (!stickVendor?.bringsOwnMaterials && matchingBom.length) {
      const vno = await nextVoucherNumber();
      const lines = matchingBom.map((b) => ({
        variantId: b.variantId,
        issuedQty: Math.max(1, Math.round(Number(b.quantity))) * qty,
      }));
      const issue = await prisma.materialIssue.create({
        data: {
          voucherNumber: vno, vendorId: stickVendor.vendorId, batchId: batch.id, stageId: stickStage.id,
          issueDate: new Date(),
          notes: `Auto-issued for sticking stage ${stickStage.id}`,
          lines: { create: lines },
        },
        include: { lines: true },
      });
      // Adjust stock and movements.
      for (const ln of issue.lines) {
        const v = await prisma.materialVariant.findUnique({ where: { id: ln.variantId } });
        if (!v) continue;
        const after = Math.max(0, Math.round(Number(v.stockQty)) - ln.issuedQty);
        await prisma.materialVariant.update({ where: { id: ln.variantId }, data: { stockQty: after } });
        await prisma.stockMovement.create({
          data: {
            variantId: ln.variantId, type: 'OUT', quantity: -ln.issuedQty, balanceAfter: after,
            refType: 'material_issue', refId: issue.id, note: `Issued via ${vno}`,
          },
        });
      }
      totalVouchers++;
      stepNotes.push(`Sticking(${meenaColour}) · ${vno}`);
    } else {
      brOwnCount++;
      stepNotes.push(`Sticking(${meenaColour}) · brings-own`);
    }
    await receiveAll(stickStage, weight);

    // PACKING
    const packing = item.processes.find((p: any) => p.process.code === 'PACKING');
    const packVendor = packing?.vendors[0]!;
    const packStage = await forwardStageRaw(stickStage, packingProc, qty, null, packVendor.vendorId, weight, Number(packVendor.costPerPiece ?? 10));
    await receiveAll(packStage, weight);
    stepNotes.push('Packing');

    const idxStr = String(dIdx + 1).padStart(2, '0');
    log(`  [${idxStr}/${demoItems.length}] #${item.itemNumber} ${(item.itemName ?? '').padEnd(20)} · ${String(qty).padStart(3)} pcs · ${stepNotes.join(' → ')}`);
  }

  // Update batch status.
  await prisma.castingBatch.update({ where: { id: batch.id }, data: { status: 'COMPLETED' } });
  log(`\n  Batch ${batch.batchNumber} marked COMPLETED.`);

  // ---------- 5. Summary ----------
  step('5', 'Summary');
  const finalReady = await prisma.item.count({ where: { sampleStatus: 'PRODUCTION_READY' } });
  const totalBatches = await prisma.castingBatch.count();
  const totalStages = await prisma.castingBatchItem.count({ where: { batchId: batch.id } });
  const totalReceipts = await prisma.castingReceipt.count({ where: { batchId: batch.id } });
  const totalVouchersDB = await prisma.materialIssue.count({ where: { batchId: batch.id } });
  console.log(`
  ✓ Production-ready designs total: ${finalReady}
  ✓ Total batches in DB:           ${totalBatches}
  ✓ Designs in ${batch.batchNumber}:              ${demoItems.length}
  ✓ Total pcs in ${batch.batchNumber}:            ${totalPcs}
  ✓ Stages in ${batch.batchNumber}:               ${totalStages}
  ✓ Receipts in ${batch.batchNumber}:            ${totalReceipts}
  ✓ Material vouchers issued:      ${totalVouchersDB}  (designs whose sticker brings own: ${brOwnCount})

  Demo batch number: ${batch.batchNumber}
  Open it in Production Management → click ${batch.batchNumber} to inspect the full traveler.
  `);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
