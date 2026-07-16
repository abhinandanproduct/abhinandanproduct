import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async summary() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const DAY = 1000 * 60 * 60 * 24;

    const [
      productionReady, totalItems, batches, receiptAgg, shortClosed,
      lossItems, recentReceipts, activeProcesses,
      // New: material-issue + raw-material visibility on the dashboard so the
      // user sees outstanding work and stock health at a glance, not just
      // casting/receipt counts.
      openMaterialIssues, materialIssueLines, materialVariants,
    ] = await Promise.all([
      this.prisma.item.count({ where: { sampleStatus: 'PRODUCTION_READY' } }),
      this.prisma.item.count(),
      this.prisma.castingBatch.findMany({
        include: {
          process: true,
          items: { include: { vendor: true, receiptRows: true, stageProcess: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.castingReceiptItem.aggregate({ _sum: { receivedWeight: true } }),
      this.prisma.castingBatchItem.aggregate({
        where: { closed: true, shortQty: { gt: 0 } },
        _sum: { shortQty: true, shortWeight: true },
        _count: true,
      }),
      // Loss-making: selling price set and ≤ cost price.
      // Postgres folds unquoted identifiers to lowercase — double-quote
      // each alias so camelCase keys survive into the JS layer.
      this.prisma.$queryRawUnsafe<any[]>(
        `SELECT id, internal_design_code AS "sampleDesignCode", item_number AS "itemNumber",
                cost_price AS "costPrice", selling_price AS "sellingPrice"
         FROM items
         WHERE selling_price IS NOT NULL AND cost_price IS NOT NULL AND selling_price <= cost_price
         ORDER BY (cost_price - selling_price) DESC LIMIT 10`,
      ),
      this.prisma.castingReceipt.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: { vendor: true, batch: true, _count: { select: { items: true } } },
      }),
      // Only PRODUCTION processes for workload — CAM is the design/sample
      // phase, not actual factory floor work, so it shouldn't show up in a
      // "what's currently being made" panel.
      this.prisma.process.findMany({
        where: { status: 'ACTIVE', code: { not: 'CAM' } },
        orderBy: { sortOrder: 'asc' },
        select: { name: true },
      }),
      this.prisma.materialIssue.count({ where: { status: { not: 'CLOSED' } } }),
      this.prisma.materialIssueLine.findMany({
        where: { issue: { status: { not: 'CLOSED' } } },
        include: { issue: { include: { vendor: true } }, variant: true },
      }),
      this.prisma.materialVariant.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, variantCode: true, variantName: true, unit: true, stockQty: true },
      }),
    ]);

    let pendingBatches = 0;
    let partialBatches = 0;
    let completedBatches = 0;
    let closedBatches = 0; // batch-level short-closed
    let totalWeightSent = 0;
    let finishedPieces = 0; // packed & ready in our hands
    let inHousePieces = 0;  // half-done, idle, with us
    let atVendorPieces = 0; // currently with a vendor

    const processCounts: Record<string, number> = {};
    const processWorkload: Record<string, number> = {}; // pending pcs per process (WIP)
    const vendorPending: Record<number, { name: string; pendingQty: number }> = {};
    const metalWithVendors: Record<number, { name: string; weightOut: number }> = {};
    const payableByVendor: Record<number, { name: string; amount: number }> = {};
    const aging: any[] = [];

    // We need the cross-batch forward counts to know what's "in-house" idle vs
    // forwarded onward — done in a single pass over all stages.
    const allStageIds = batches.flatMap((b) => b.items.map((i) => i.id));
    const allChildren = allStageIds.length
      ? await this.prisma.castingBatchItem.findMany({
          where: { parentItemId: { in: allStageIds } },
          select: { parentItemId: true, quantity: true },
        })
      : [];
    const forwardedByParent = new Map<number, number>();
    for (const c of allChildren) {
      if (c.parentItemId != null) {
        forwardedByParent.set(c.parentItemId, (forwardedByParent.get(c.parentItemId) ?? 0) + c.quantity);
      }
    }

    for (const b of batches) {
      // Batch-level short-close trumps the lifecycle status — it's a separate
      // operational state ("manually closed even though work was incomplete").
      if (b.closed) closedBatches++;
      else if (b.status === 'OPEN') pendingBatches++;
      else if (b.status === 'PARTIAL') partialBatches++;
      else if (b.status === 'COMPLETED') completedBatches++;

      const pname = b.process?.name ?? 'Unassigned';
      processCounts[pname] = (processCounts[pname] ?? 0) + 1;

      const inMonth = b.batchDate >= monthStart && b.batchDate <= now;
      let batchPending = 0;
      const batchVendorNames = new Set<string>();

      for (const it of b.items) {
        totalWeightSent += Number(it.totalWeight);
        const recQty = it.receiptRows.reduce((s, r) => s + r.receivedQty, 0);
        const recWt = it.receiptRows.reduce((s, r) => s + Number(r.receivedWeight), 0);
        const pending = it.closed ? 0 : Math.max(it.quantity - recQty, 0);
        const forwarded = forwardedByParent.get(it.id) ?? 0;
        const idle = Math.max(0, recQty - forwarded);

        // Production-inventory rollup (powers the headline tiles):
        //   FINISHED = packed & ready  · IN_HOUSE = idle mid-chain  · AT_VENDOR = pending
        if (idle > 0) {
          // Stages at the PACKING step are finished goods; everything else
          // idle is in-house ready for the next step.
          if (it.stageProcess?.code === 'PACKING') {
            finishedPieces += idle;
          } else {
            inHousePieces += idle;
          }
        }
        // At-vendor = issued − received on still-open stages (closed stages
        // were written off, no longer with the vendor in practice).
        if (!it.closed) atVendorPieces += Math.max(0, it.quantity - recQty);

        if (pending > 0) {
          batchPending += pending;
          batchVendorNames.add(it.vendor.vendorName);
          vendorPending[it.vendorId] = vendorPending[it.vendorId] ?? { name: it.vendor.vendorName, pendingQty: 0 };
          vendorPending[it.vendorId].pendingQty += pending;
          // Attribute pending pcs to THIS stage's process (Plating/Meena/...),
          // NOT the batch's initial process. Otherwise everything piles onto
          // Casting and the workload view is wrong.
          const stageName = it.stageProcess?.name ?? 'Unassigned';
          processWorkload[stageName] = (processWorkload[stageName] ?? 0) + pending;
        }
        // ALSO surface idle in-house pieces in the workload — those pcs are
        // ready for the NEXT step and need to be issued. Treating them as
        // "workload" gives the floor a complete picture of "what's queued up".
        if (idle > 0 && it.stageProcess?.code !== 'PACKING') {
          const stageName = it.stageProcess?.name ?? 'Unassigned';
          processWorkload[stageName] = (processWorkload[stageName] ?? 0) + idle;
        }

        // Metal still out with vendor = issued − received on non-closed lines.
        if (!it.closed) {
          const out = Number(it.totalWeight) - recWt;
          if (out > 0) {
            metalWithVendors[it.vendorId] = metalWithVendors[it.vendorId] ?? { name: it.vendor.vendorName, weightOut: 0 };
            metalWithVendors[it.vendorId].weightOut += out;
          }
        }

        // Job-work value issued this month (estimated payable to vendor).
        if (inMonth && it.totalCost != null) {
          payableByVendor[it.vendorId] = payableByVendor[it.vendorId] ?? { name: it.vendor.vendorName, amount: 0 };
          payableByVendor[it.vendorId].amount += Number(it.totalCost);
        }
      }

      // Skip legacy batches with no process assigned (they clutter the operational view).
      if (b.processId != null && (b.status === 'OPEN' || b.status === 'PARTIAL') && batchPending > 0) {
        aging.push({
          batchNumber: b.batchNumber,
          processName: pname,
          days: Math.floor((now.getTime() - b.batchDate.getTime()) / DAY),
          pendingQty: batchPending,
          vendors: Array.from(batchVendorNames),
        });
      }
    }

    // Recent activity feed (issues + receipts + short-closes), newest first.
    const recentClosed = await this.prisma.castingBatchItem.findMany({
      where: { closed: true },
      orderBy: { closedAt: 'desc' },
      take: 8,
      include: { vendor: true, batch: true },
    });
    const activity = [
      ...batches.slice(0, 8).map((b) => ({
        type: 'issue', date: b.createdAt,
        text: `Batch ${b.batchNumber} issued · ${b.process?.name ?? '—'} · ${b.items.length} item(s)`,
      })),
      ...recentReceipts.map((r) => ({
        type: 'receipt', date: r.createdAt,
        text: `Receipt ${r.receiptNumber} · ${r.vendor.vendorName} · batch ${r.batch.batchNumber}`,
      })),
      ...recentClosed.map((c) => ({
        type: 'close', date: c.closedAt ?? c.createdAt,
        text: `Short-closed item #${c.itemNumber} · ${c.vendor.vendorName} · short ${c.shortQty ?? 0}`,
      })),
    ]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 14);

    const totalWeightReceived = Number(receiptAgg._sum.receivedWeight ?? 0);
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const byDescNum = (k: string) => (a: any, b: any) => b[k] - a[k];

    // Material-issue rollups. "Vendor holdings total" = sum of (issued −
    // received − consumed) across all open vouchers. Tells the user at a
    // glance how much raw material is still sitting at karigars.
    let totalMaterialIssued = 0;
    let totalMaterialReturned = 0;
    let totalMaterialConsumed = 0;
    let totalMaterialPending = 0;
    const holdingsByVendor: Record<number, { name: string; qty: number; voucherCount: Set<number> }> = {};
    for (const l of materialIssueLines) {
      const cons = (l as any).consumedQty ?? 0;
      const pending = Math.max(0, l.issuedQty - l.receivedQty - cons);
      totalMaterialIssued += l.issuedQty;
      totalMaterialReturned += l.receivedQty;
      totalMaterialConsumed += cons;
      totalMaterialPending += pending;
      if (pending > 0) {
        const vId = l.issue.vendorId;
        const v = holdingsByVendor[vId] ?? { name: l.issue.vendor.vendorName, qty: 0, voucherCount: new Set<number>() };
        v.qty += pending;
        v.voucherCount.add(l.issueId);
        holdingsByVendor[vId] = v;
      }
    }
    const topVendorHoldings = Object.entries(holdingsByVendor)
      .map(([id, v]) => ({ vendorId: Number(id), name: v.name, qty: v.qty, vouchers: v.voucherCount.size }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5);

    // Low-stock raw materials — flag the ones at risk so the user can order
    // more before a sticking job blocks. Threshold = 100 pcs (configurable
    // later) since stock is now integer everywhere.
    const LOW_STOCK_THRESHOLD = 100;
    const lowStockMaterials = materialVariants
      .map((v) => ({
        id: v.id, variantCode: v.variantCode, variantName: v.variantName,
        unit: v.unit, stockQty: Math.round(Number(v.stockQty)),
      }))
      .filter((v) => v.stockQty < LOW_STOCK_THRESHOLD)
      .sort((a, b) => a.stockQty - b.stockQty)
      .slice(0, 8);

    return {
      productionReadyItems: productionReady,
      totalItems,
      pendingBatches: pendingBatches + partialBatches,
      openBatches: pendingBatches,
      partialBatches,
      completedBatches,
      closedBatches,
      // Production inventory roll-up — used by the headline "Production
      // Inventory" tile + breakdown panel.
      productionInventory: {
        finished: finishedPieces,
        inHouse: inHousePieces,
        atVendor: atVendorPieces,
        total: finishedPieces + inHousePieces + atVendorPieces,
      },
      // Material-issue / raw-material summary — surfaces the new vouchers,
      // returns, vendor holdings, and low-stock alerts on the dashboard.
      materialsSummary: {
        openVouchers: openMaterialIssues,
        totalIssued: totalMaterialIssued,
        totalReturned: totalMaterialReturned,
        totalConsumed: totalMaterialConsumed,
        totalPending: totalMaterialPending,
      },
      topVendorHoldings,
      lowStockMaterials,
      totalWeightSent: r3(totalWeightSent),
      totalWeightReceived: r3(totalWeightReceived),
      metalWithVendorsTotal: r3(totalWeightSent - totalWeightReceived),
      processCounts: Object.entries(processCounts).map(([name, count]) => ({ name, count })),
      // Every active process in the standard sequence (0 when nothing in process).
      // Legacy process-less ("Unassigned") work is intentionally excluded.
      // Each row now carries the process `code` too so the silvira-style
      // dashboard can map to its per-process icon.
      processWorkload: (await this.prisma.process.findMany({
        where: {
          status: 'ACTIVE',
          // CAM is the entry (no queue pcs land here). CAD is a designer
          // vendor-category, not a production stage. RAW_MATERIAL_SUPPLIER
          // is a supplier role. Exclude all three from the dashboard tiles.
          code: { notIn: ['CAM', 'CAD', 'RAW_MATERIAL_SUPPLIER'] },
        },
        orderBy: { sortOrder: 'asc' },
        select: { code: true, name: true },
      })).map((p) => ({ code: p.code, name: p.name, pendingQty: processWorkload[p.name] ?? 0 })),
      vendorPending: Object.values(vendorPending).sort(byDescNum('pendingQty')),
      metalWithVendors: Object.values(metalWithVendors).map((v) => ({ ...v, weightOut: r3(v.weightOut) })).sort(byDescNum('weightOut')),
      payableByVendor: Object.values(payableByVendor).map((v) => ({ ...v, amount: r2(v.amount) })).sort(byDescNum('amount')),
      payableThisMonthTotal: r2(Object.values(payableByVendor).reduce((s, v) => s + v.amount, 0)),
      agingPending: aging.sort(byDescNum('days')).slice(0, 8),
      lossItems: lossItems.map((i) => ({
        id: Number(i.id), sampleDesignCode: i.sampleDesignCode, itemNumber: i.itemNumber,
        costPrice: i.costPrice != null ? Number(i.costPrice) : null,
        sellingPrice: i.sellingPrice != null ? Number(i.sellingPrice) : null,
      })),
      outstandingLines: shortClosed._count ?? 0,
      outstandingShortQty: shortClosed._sum.shortQty ?? 0,
      outstandingShortWeight: r3(Number(shortClosed._sum.shortWeight ?? 0)),
      recentActivity: activity,
    };
  }
}
