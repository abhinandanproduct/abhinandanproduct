/**
 * Phase 2 demo: upgrades existing designs to have the FULL process pipeline
 * (adds Antique + Kachu Fitting + Mala where missing, configures multi-colour
 * vendors at Plating/Meena/Fitting/Mala), then runs:
 *
 *   • Batch B0024 — 50 designs · multi-colour splits at Plating/Meena/Fitting/Mala
 *                   · all the way through Packing · COMPLETED
 *   • Batch B0025 — 50 designs · same shape · COMPLETED
 *   • Batch B0026 — 30 designs · half receipt + line short-closes
 *                   · batch itself short-closed
 *   • Deferred-materials demo — drains a variant's stock, then issues a
 *                   sticking forward that DEFERS the shortfall (so the
 *                   Pending Demand banner shows up on the Inventory page).
 *
 * Usage: cd backend && npx ts-node scripts/seed-demo-v2.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const pickN = <T,>(arr: T[], n: number): T[] => {
  const copy = [...arr]; const out: T[] = [];
  for (let i = 0; i < n && copy.length; i++) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  return out;
};
const rint = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const step = (n: string, msg: string) => console.log(`\n[${n}] ${msg}`);
const log = (msg: string) => console.log(msg);

async function main() {
  // ---- Process map ----
  const processes = await prisma.process.findMany({ where: { status: 'ACTIVE' } });
  const procByCode = new Map(processes.map((p) => [p.code, p]));
  const codes = ['CASTING', 'PLATING', 'ANTIQUE', 'MEENA', 'KACHU_FITTING', 'FITTING', 'MALA', 'STICKING', 'PACKING'];
  for (const c of codes) if (!procByCode.has(c)) throw new Error(`Process ${c} missing — run prisma seed first.`);

  // ---- Vendor pools per process ----
  const vendorsByProc: Record<string, any[]> = {};
  for (const c of codes) {
    const p = procByCode.get(c)!;
    vendorsByProc[c] = await prisma.vendor.findMany({
      where: { status: 'ACTIVE', processes: { some: { processId: p.id } } },
    });
    if (!vendorsByProc[c].length) throw new Error(`No vendors for process ${c}`);
  }

  // ---- Phase 1: upgrade designs to have ALL processes ----
  step('1', 'Upgrading designs to have Antique + Kachu Fitting + Mala (where missing) with vendors…');

  const platingColours = ['Gold', 'Bhari Gold', 'Rose Gold', 'Silver'];
  const meenaColours = ['Ruby', 'Pink', 'Green', 'Blue', 'Red'];

  const designs = await prisma.item.findMany({
    where: { sampleStatus: 'PRODUCTION_READY' },
    include: { processes: { include: { process: true, vendors: true } } },
  });

  let added = 0;
  for (const item of designs) {
    const have = new Set(item.processes.map((p: any) => p.process.code));

    // Antique — no colour split (it's a finish applied to all pieces).
    if (!have.has('ANTIQUE')) {
      await prisma.itemProcess.create({
        data: {
          itemId: item.id, processId: procByCode.get('ANTIQUE')!.id,
          vendors: { create: [{ vendorId: pick(vendorsByProc.ANTIQUE).id, isPreferred: true, costPerPiece: rint(30, 80) }] },
        },
      });
      added++;
    }
    // Kachu Fitting — no colour split.
    if (!have.has('KACHU_FITTING')) {
      await prisma.itemProcess.create({
        data: {
          itemId: item.id, processId: procByCode.get('KACHU_FITTING')!.id,
          vendors: { create: [{ vendorId: pick(vendorsByProc.KACHU_FITTING).id, isPreferred: true, costPerPiece: rint(15, 40) }] },
        },
      });
      added++;
    }
    // Mala — colour-using; 2-3 colours.
    if (!have.has('MALA')) {
      const malaCols = pickN(['Gold', 'Silver', 'Antique', 'Rose Gold'], rint(2, 3));
      await prisma.itemProcess.create({
        data: {
          itemId: item.id, processId: procByCode.get('MALA')!.id,
          vendors: {
            create: malaCols.map((c, i) => ({
              vendorId: pick(vendorsByProc.MALA).id, color: c, isPreferred: i === 0,
              costPerPiece: rint(20, 50),
            })),
          },
        },
      });
      added++;
    }
    // Fitting — top up to multi-colour if it's currently single.
    const fittingP = item.processes.find((p: any) => p.process.code === 'FITTING');
    if (fittingP && fittingP.vendors.length === 1 && !fittingP.vendors[0].color) {
      // Replace with 2 colour-assigned vendors (Gold + Silver).
      await prisma.itemProcessVendor.deleteMany({ where: { itemProcessId: fittingP.id } });
      const fitCols = ['Gold', 'Silver'];
      for (let i = 0; i < fitCols.length; i++) {
        await prisma.itemProcessVendor.create({
          data: {
            itemProcessId: fittingP.id, vendorId: pick(vendorsByProc.FITTING).id, color: fitCols[i], isPreferred: i === 0,
            costPerPiece: rint(20, 60),
          },
        });
      }
      added++;
    }
    // Plating — top up to >=2 colours if currently single.
    const platingP = item.processes.find((p: any) => p.process.code === 'PLATING');
    if (platingP && platingP.vendors.length === 1) {
      const existingCol = platingP.vendors[0].color || 'Gold';
      const newCol = pick(platingColours.filter((c) => c !== existingCol));
      await prisma.itemProcessVendor.create({
        data: {
          itemProcessId: platingP.id, vendorId: pick(vendorsByProc.PLATING).id, color: newCol, isPreferred: false,
          costPerPiece: rint(20, 80),
        },
      });
      added++;
    }
  }
  log(`  upgrades applied: ${added}`);

  // Re-fetch with full include after upgrade.
  const fullDesigns = await prisma.item.findMany({
    where: { sampleStatus: 'PRODUCTION_READY' },
    include: { processes: { include: { process: true, vendors: true, attributes: true } } },
  });
  const goodDesigns = fullDesigns.filter((it: any) =>
    codes.every((c) => {
      const proc = it.processes.find((p: any) => p.process.code === c);
      return proc && proc.vendors.length > 0;
    }),
  );
  log(`  designs ready for full workflow: ${goodDesigns.length}`);

  // ---- Helpers for batch creation ----
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

  async function createCastingStage(batch: any, item: any, qty: number, sortOrder: number) {
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
        processId: casting.processId, sortOrder,
      },
    });
    await prisma.castingBatchItem.update({
      where: { id: stage.id }, data: { lineKey: String(stage.id), issueSlipId: stage.id, issueSlipAt: new Date() },
    });
    return { stage, weight };
  }
  async function receiveAll(batch: any, stage: any, weight: number, qty?: number) {
    const recvQty = qty ?? stage.quantity;
    const recNum = await nextReceiptNumber();
    await prisma.castingReceipt.create({
      data: {
        batchId: batch.id, vendorId: stage.vendorId, receiptNumber: recNum,
        receiptDate: new Date(),
        items: { create: [{ batchItemId: stage.id, receivedQty: recvQty, receivedWeight: weight * recvQty }] },
      },
    });
    return recNum;
  }
  async function forwardStageRaw(batch: any, parent: any, processId: number, qty: number, color: string | null, vendorId: number, weight: number, costPerPiece: number) {
    const isColourSplit = !parent.color && !!color;
    const lineKey = isColourSplit ? null : parent.lineKey;
    const child = await prisma.castingBatchItem.create({
      data: {
        batchId: batch.id, itemId: parent.itemId, itemNumber: parent.itemNumber, itemName: parent.itemName,
        vendorId, weight, quantity: qty, totalWeight: weight * qty,
        costPerKg: costPerPiece,
        totalCost: costPerPiece * qty,
        processId, parentItemId: parent.id,
        lineKey: lineKey ?? '',
        color, colorModel: parent.colorModel,
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
  // Issue materials for a sticking stage (mimics autoIssueStickingMaterials).
  // Supports deferred behavior when stock is short.
  async function issueStickingMaterials(item: any, stage: any, qty: number, color: string, vendorId: number, batchId: number) {
    const bom = await prisma.itemMaterial.findMany({ where: { itemId: item.id }, include: { variant: true } });
    const matchingBom = bom.filter((b) => !b.color || b.color.trim().toLowerCase() === color.trim().toLowerCase());
    if (!matchingBom.length) return null;
    const snap = matchingBom.map((b) => {
      const perPiece = Math.max(1, Math.round(Number(b.quantity)));
      return { variantId: b.variantId, variantCode: b.variant.variantCode, variantName: b.variant.variantName, unit: b.variant.unit ?? null, perPiece, required: perPiece * qty };
    });
    await prisma.castingBatchItem.update({ where: { id: stage.id }, data: { bomSnapshot: snap } });

    const variants = await prisma.materialVariant.findMany({
      where: { id: { in: matchingBom.map((b) => b.variantId) } },
    });
    const stockById = new Map(variants.map((v) => [v.id, Math.round(Number(v.stockQty))]));

    const linesData = matchingBom.map((b) => {
      const wanted = Math.max(1, Math.round(Number(b.quantity))) * qty;
      const have = stockById.get(b.variantId) ?? 0;
      const issueNow = Math.min(wanted, have);
      const defer = wanted - issueNow;
      return { variantId: b.variantId, issuedQty: issueNow, deferredQty: defer };
    });

    const vno = await nextVoucherNumber();
    const issue = await prisma.materialIssue.create({
      data: {
        voucherNumber: vno, vendorId, batchId, stageId: stage.id,
        issueDate: new Date(),
        notes: `Auto-issued for sticking stage ${stage.id}`,
        lines: { create: linesData.map((l) => ({
          variantId: l.variantId, issuedQty: l.issuedQty,
          ...({ deferredQty: l.deferredQty } as any),
        })) },
      },
      include: { lines: true },
    });

    let totalDeferred = 0;
    for (const ln of issue.lines) {
      if (ln.issuedQty > 0) {
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
      totalDeferred += (ln as any).deferredQty ?? 0;
    }
    return { voucherNumber: vno, deferred: totalDeferred };
  }
  async function recomputeBatchStatus(batchId: number) {
    const items = await prisma.castingBatchItem.findMany({ where: { batchId }, include: { receiptRows: true } });
    let anyReceived = false, allDone = true;
    for (const it of items) {
      const rec = it.receiptRows.reduce((s, r) => s + r.receivedQty, 0);
      if (rec > 0) anyReceived = true;
      if (!it.closed && rec < it.quantity) allDone = false;
    }
    const status = allDone && items.length ? 'COMPLETED' : anyReceived ? 'PARTIAL' : 'OPEN';
    await prisma.castingBatch.update({ where: { id: batchId }, data: { status: status as any } });
  }

  // ---- Full multi-colour walk for one design ----
  // Pipeline: Casting → Plating(2 colours split) → Antique → Meena → Kachu → Fitting → Mala → Sticking → Packing
  // For each Plating colour, the chain runs independently down to Packing.
  async function walkDesignFull(batch: any, item: any, qty: number, sortOrder: number, opts: { partialReceive?: boolean; shortClose?: boolean } = {}) {
    let issuedThisDesign = 0, deferredThisDesign = 0, vouchersThisDesign = 0;
    const { stage: castStage, weight } = await createCastingStage(batch, item, qty, sortOrder);
    await receiveAll(batch, castStage, weight);

    // Plating: 2 colours, half-half (or roughly).
    const platingP = item.processes.find((p: any) => p.process.code === 'PLATING');
    const platCols: any[] = platingP.vendors.slice(0, 2);
    const half = Math.floor(qty / 2);
    const splits = [half, qty - half];
    const subSummary: string[] = [];
    for (let bi = 0; bi < platCols.length; bi++) {
      const platVendor = platCols[bi];
      const platColour = platVendor.color ?? 'Gold';
      const platQty = splits[bi];
      const platStage = await forwardStageRaw(batch, castStage, procByCode.get('PLATING')!.id, platQty, platColour, platVendor.vendorId, weight, Number(platVendor.costPerPiece ?? 30));
      await receiveAll(batch, platStage, weight);

      // Antique
      const antiqueP = item.processes.find((p: any) => p.process.code === 'ANTIQUE');
      const antVendor = antiqueP.vendors[0];
      const antStage = await forwardStageRaw(batch, platStage, procByCode.get('ANTIQUE')!.id, platQty, null, antVendor.vendorId, weight, Number(antVendor.costPerPiece ?? 50));
      await receiveAll(batch, antStage, weight);

      // Meena — pick a vendor matching... or just pick first.
      const meenaP = item.processes.find((p: any) => p.process.code === 'MEENA')!;
      const meenaVendor: any = pick(meenaP.vendors);
      const meenaColour = meenaVendor.color ?? 'Ruby';
      const meenaStage = await forwardStageRaw(batch, antStage, procByCode.get('MEENA')!.id, platQty, meenaColour, meenaVendor.vendorId, weight, Number(meenaVendor.costPerPiece ?? 20));
      await receiveAll(batch, meenaStage, weight);

      // Kachu Fitting
      const kachuP = item.processes.find((p: any) => p.process.code === 'KACHU_FITTING');
      const kachuVendor = kachuP.vendors[0];
      const kachuStage = await forwardStageRaw(batch, meenaStage, procByCode.get('KACHU_FITTING')!.id, platQty, null, kachuVendor.vendorId, weight, Number(kachuVendor.costPerPiece ?? 25));
      await receiveAll(batch, kachuStage, weight);

      // Fitting — pick vendor matching plating colour or first
      const fittingP = item.processes.find((p: any) => p.process.code === 'FITTING');
      const fitVendor = fittingP.vendors.find((v: any) => v.color === platColour) ?? fittingP.vendors[0];
      const fitColour = fitVendor.color ?? platColour;
      const fitStage = await forwardStageRaw(batch, kachuStage, procByCode.get('FITTING')!.id, platQty, fitColour, fitVendor.vendorId, weight, Number(fitVendor.costPerPiece ?? 30));
      await receiveAll(batch, fitStage, weight);

      // Mala
      const malaP = item.processes.find((p: any) => p.process.code === 'MALA');
      const malaVendor = malaP.vendors.find((v: any) => v.color === platColour) ?? malaP.vendors[0];
      const malaColour = malaVendor.color ?? platColour;
      const malaStage = await forwardStageRaw(batch, fitStage, procByCode.get('MALA')!.id, platQty, malaColour, malaVendor.vendorId, weight, Number(malaVendor.costPerPiece ?? 35));
      await receiveAll(batch, malaStage, weight);

      // Sticking
      const stickingP = item.processes.find((p: any) => p.process.code === 'STICKING');
      const stickVendor = stickingP.vendors.find((v: any) => v.color === meenaColour) ?? stickingP.vendors[0];
      const stickStage = await forwardStageRaw(batch, malaStage, procByCode.get('STICKING')!.id, platQty, meenaColour, stickVendor.vendorId, weight, Number(stickVendor.costPerPiece ?? 15));
      if (!stickVendor.bringsOwnMaterials) {
        const res = await issueStickingMaterials(item, stickStage, platQty, meenaColour, stickVendor.vendorId, batch.id);
        if (res) { vouchersThisDesign++; deferredThisDesign += res.deferred; }
      }
      // Maybe partial receive or short-close for some.
      if (opts.shortClose && bi === 0) {
        // Short close this sticking stage
        const recv = Math.floor(platQty * 0.6);
        if (recv > 0) await receiveAll(batch, stickStage, weight, recv);
        const short = platQty - recv;
        const shortWt = weight * short;
        await prisma.castingBatchItem.update({
          where: { id: stickStage.id },
          data: { closed: true, closedAt: new Date(), closedReason: 'Demo short-close', shortQty: short, shortWeight: shortWt },
        });
        subSummary.push(`Stick ${meenaColour}: ${recv}/${platQty} (SHORT-CLOSED ${short})`);
        // Skip packing for this branch since closed.
        continue;
      }
      if (opts.partialReceive && bi === 1) {
        // Partial receipt — receive 60% only, don't forward to packing
        const recv = Math.floor(platQty * 0.6);
        if (recv > 0) await receiveAll(batch, stickStage, weight, recv);
        subSummary.push(`Stick ${meenaColour}: ${recv}/${platQty} (partial)`);
        continue;
      }
      await receiveAll(batch, stickStage, weight);

      // Packing
      const packingP = item.processes.find((p: any) => p.process.code === 'PACKING');
      const packVendor = packingP.vendors[0];
      const packStage = await forwardStageRaw(batch, stickStage, procByCode.get('PACKING')!.id, platQty, null, packVendor.vendorId, weight, Number(packVendor.costPerPiece ?? 10));
      await receiveAll(batch, packStage, weight);
      issuedThisDesign += platQty;
      subSummary.push(`${platColour}/${meenaColour} ✓ ${platQty}`);
    }
    return { issuedThisDesign, deferredThisDesign, vouchersThisDesign, branches: subSummary };
  }

  // ---- Batch B0024 — full COMPLETED ----
  step('2', 'Building Batch B0024 (50 designs · full multi-colour pipeline · Completed)…');
  let bnum = await nextBatchNumber();
  let demoItems = goodDesigns.slice(0, 50);
  let batch = await prisma.castingBatch.create({
    data: { batchNumber: bnum, processId: procByCode.get('CASTING')!.id, batchDate: new Date(), notes: 'Demo full-pipeline batch 1' },
  });
  log(`  + ${bnum}`);
  let sortOrder = 0;
  let totalVouchers = 0, totalDeferred = 0;
  for (let i = 0; i < demoItems.length; i++) {
    const item = demoItems[i];
    const qty = pick([50, 80, 100, 120]);
    const r = await walkDesignFull(batch, item, qty, sortOrder++);
    totalVouchers += r.vouchersThisDesign; totalDeferred += r.deferredThisDesign;
    if (i % 10 === 9) log(`    [${String(i + 1).padStart(2, '0')}/${demoItems.length}] #${item.itemNumber} done · ${r.branches.join(' · ')}`);
  }
  await recomputeBatchStatus(batch.id);
  await prisma.castingBatch.update({ where: { id: batch.id }, data: { status: 'COMPLETED' } });
  const b24Stages = await prisma.castingBatchItem.count({ where: { batchId: batch.id } });
  log(`  ${bnum}: ${demoItems.length} designs · ${b24Stages} stages · ${totalVouchers} vouchers · ${totalDeferred} deferred · COMPLETED`);

  // ---- Batch B0025 — full COMPLETED ----
  step('3', 'Building Batch B0025 (50 designs · same shape)…');
  bnum = await nextBatchNumber();
  demoItems = goodDesigns.slice(0, 50);
  batch = await prisma.castingBatch.create({
    data: { batchNumber: bnum, processId: procByCode.get('CASTING')!.id, batchDate: new Date(), notes: 'Demo full-pipeline batch 2' },
  });
  log(`  + ${bnum}`);
  sortOrder = 0;
  totalVouchers = 0; totalDeferred = 0;
  for (let i = 0; i < demoItems.length; i++) {
    const item = demoItems[i];
    const qty = pick([50, 75, 100, 120, 150]);
    const r = await walkDesignFull(batch, item, qty, sortOrder++);
    totalVouchers += r.vouchersThisDesign; totalDeferred += r.deferredThisDesign;
    if (i % 10 === 9) log(`    [${String(i + 1).padStart(2, '0')}/${demoItems.length}] #${item.itemNumber} done`);
  }
  await recomputeBatchStatus(batch.id);
  await prisma.castingBatch.update({ where: { id: batch.id }, data: { status: 'COMPLETED' } });
  const b25Stages = await prisma.castingBatchItem.count({ where: { batchId: batch.id } });
  log(`  ${bnum}: ${demoItems.length} designs · ${b25Stages} stages · ${totalVouchers} vouchers · COMPLETED`);

  // ---- Batch B0026 — partial / short-close demo ----
  step('4', 'Building Batch B0026 (30 designs · partial + line short-closes + batch short-closed)…');
  bnum = await nextBatchNumber();
  demoItems = goodDesigns.slice(0, 30);
  batch = await prisma.castingBatch.create({
    data: { batchNumber: bnum, processId: procByCode.get('CASTING')!.id, batchDate: new Date(), notes: 'Demo partial + short-close batch' },
  });
  log(`  + ${bnum}`);
  sortOrder = 0;
  let lineShorts = 0, partialReceives = 0;
  for (let i = 0; i < demoItems.length; i++) {
    const item = demoItems[i];
    const qty = pick([50, 80, 100]);
    const partialReceive = i % 4 === 1;   // ~25% partial
    const shortClose = i % 4 === 2;       // ~25% short-closed
    const r = await walkDesignFull(batch, item, qty, sortOrder++, { partialReceive, shortClose });
    if (shortClose) lineShorts++;
    if (partialReceive) partialReceives++;
  }
  await recomputeBatchStatus(batch.id);
  // Batch-level short-close.
  await prisma.castingBatch.update({
    where: { id: batch.id },
    data: { closed: true, closedAt: new Date(), closedReason: 'Demo batch short-closed for testing' },
  });
  const b26Stages = await prisma.castingBatchItem.count({ where: { batchId: batch.id } });
  const b26ShortStages = await prisma.castingBatchItem.count({ where: { batchId: batch.id, closed: true } });
  log(`  ${bnum}: ${demoItems.length} designs · ${b26Stages} stages · ${partialReceives} partials · ${b26ShortStages} short-closed stages · BATCH SHORT-CLOSED`);

  // ---- Deferred materials demo ----
  step('5', 'Setting up DEFERRED-MATERIALS scenario…');
  // Drain one variant's stock to a small number so a new sticking forward defers.
  const someVariant = await prisma.materialVariant.findFirst({ where: { stockQty: { gt: 1000 } } });
  if (someVariant) {
    const before = Number(someVariant.stockQty);
    const reduceTo = 50; // leave just 50 in stock
    const delta = Math.round(before) - reduceTo;
    if (delta > 0) {
      await prisma.materialVariant.update({ where: { id: someVariant.id }, data: { stockQty: reduceTo } });
      await prisma.stockMovement.create({
        data: {
          variantId: someVariant.id, type: 'OUT', quantity: -delta, balanceAfter: reduceTo,
          refType: 'manual_adjustment', refId: 0, note: 'Demo: drain stock for deferred-materials scenario',
        },
      });
      log(`  ${someVariant.variantCode} ${someVariant.variantName}: ${before} → ${reduceTo} (drained ${delta})`);
    }
  }
  // Create a small batch with one sticking forward to trigger deferral.
  bnum = await nextBatchNumber();
  const deferItem = goodDesigns.find((it: any) =>
    prisma.itemMaterial.count({ where: { itemId: it.id, variantId: someVariant?.id } }).then((c: any) => c > 0)
  ) || goodDesigns[0];
  const deferBatch = await prisma.castingBatch.create({
    data: { batchNumber: bnum, processId: procByCode.get('CASTING')!.id, batchDate: new Date(), notes: 'Demo: deferred-materials scenario' },
  });
  log(`  + ${bnum} (deferred demo)`);
  const { stage: dcastStage, weight: dweight } = await createCastingStage(deferBatch, deferItem, 200, 0);
  await receiveAll(deferBatch, dcastStage, dweight);
  const dplatP = deferItem.processes.find((p: any) => p.process.code === 'PLATING')!;
  const dplatV = dplatP.vendors[0];
  const dplatStage = await forwardStageRaw(deferBatch, dcastStage, procByCode.get('PLATING')!.id, 200, dplatV.color, dplatV.vendorId, dweight, Number(dplatV.costPerPiece));
  await receiveAll(deferBatch, dplatStage, dweight);
  const dantP = deferItem.processes.find((p: any) => p.process.code === 'ANTIQUE')!;
  const dantStage = await forwardStageRaw(deferBatch, dplatStage, procByCode.get('ANTIQUE')!.id, 200, null, dantP.vendors[0].vendorId, dweight, Number(dantP.vendors[0].costPerPiece));
  await receiveAll(deferBatch, dantStage, dweight);
  const dmeenaP = deferItem.processes.find((p: any) => p.process.code === 'MEENA')!;
  const dmeenaV = dmeenaP.vendors[0];
  const dmeenaStage = await forwardStageRaw(deferBatch, dantStage, procByCode.get('MEENA')!.id, 200, dmeenaV.color, dmeenaV.vendorId, dweight, Number(dmeenaV.costPerPiece));
  await receiveAll(deferBatch, dmeenaStage, dweight);
  const dkachuP = deferItem.processes.find((p: any) => p.process.code === 'KACHU_FITTING')!;
  const dkachuStage = await forwardStageRaw(deferBatch, dmeenaStage, procByCode.get('KACHU_FITTING')!.id, 200, null, dkachuP.vendors[0].vendorId, dweight, Number(dkachuP.vendors[0].costPerPiece));
  await receiveAll(deferBatch, dkachuStage, dweight);
  const dfitP = deferItem.processes.find((p: any) => p.process.code === 'FITTING')!;
  const dfitStage = await forwardStageRaw(deferBatch, dkachuStage, procByCode.get('FITTING')!.id, 200, dfitP.vendors[0].color, dfitP.vendors[0].vendorId, dweight, Number(dfitP.vendors[0].costPerPiece));
  await receiveAll(deferBatch, dfitStage, dweight);
  const dmalaP = deferItem.processes.find((p: any) => p.process.code === 'MALA')!;
  const dmalaStage = await forwardStageRaw(deferBatch, dfitStage, procByCode.get('MALA')!.id, 200, dmalaP.vendors[0].color, dmalaP.vendors[0].vendorId, dweight, Number(dmalaP.vendors[0].costPerPiece));
  await receiveAll(deferBatch, dmalaStage, dweight);
  const dstickP = deferItem.processes.find((p: any) => p.process.code === 'STICKING')!;
  const dstickV = dstickP.vendors.find((v: any) => v.color === dmeenaV.color) ?? dstickP.vendors[0];
  const dstickStage = await forwardStageRaw(deferBatch, dmalaStage, procByCode.get('STICKING')!.id, 200, dmeenaV.color, dstickV.vendorId, dweight, Number(dstickV.costPerPiece));
  if (!dstickV.bringsOwnMaterials) {
    const res = await issueStickingMaterials(deferItem, dstickStage, 200, dmeenaV.color ?? 'Ruby', dstickV.vendorId, deferBatch.id);
    if (res) log(`  Issued voucher ${res.voucherNumber} · deferred ${res.deferred} pcs (waiting on stock)`);
  }
  // Don't receive sticking yet — leave it open with deferred materials.
  await recomputeBatchStatus(deferBatch.id);

  // ---- Summary ----
  step('6', 'Final state');
  const totalBatches = await prisma.castingBatch.count();
  const totalCompleted = await prisma.castingBatch.count({ where: { status: 'COMPLETED' } });
  const totalShortClosed = await prisma.castingBatch.count({ where: { closed: true } });
  const totalVouchersIssued = await prisma.materialIssue.count();
  const pendingDemandRows = await prisma.materialIssueLine.findMany({ where: ({ deferredQty: { gt: 0 } } as any) });
  const totalDeferredPcs = pendingDemandRows.reduce((s: number, l: any) => s + ((l as any).deferredQty ?? 0), 0);
  console.log(`
  ✓ Total batches:                  ${totalBatches}
  ✓ Batches marked Completed:       ${totalCompleted}
  ✓ Batches short-closed:           ${totalShortClosed}
  ✓ Total material vouchers in DB:  ${totalVouchersIssued}
  ✓ Pending material demand lines:  ${pendingDemandRows.length}  (${totalDeferredPcs} pcs deferred)

  Batches created in this run:
    B0024 — full multi-colour walk · COMPLETED
    B0025 — full multi-colour walk · COMPLETED
    B0026 — partial + per-line shorts · BATCH SHORT-CLOSED
    Plus a small deferred-materials demo batch.

  Try in the UI:
    • Production Management → click each new batch → tree expands the full path
    • Batch Inventory → Short-closed folder should show B0026
    • Raw Materials Inventory → "Pending material demand" banner with Review & issue
    • Material Issues → vendor holdings card should be loaded
  `);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
