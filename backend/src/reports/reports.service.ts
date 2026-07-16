import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Reports — month-end aggregates for silver ERP.
 *
 * All time-bounded reports accept ISO `from` / `to` dates (inclusive of
 * from-midnight to to-end-of-day in DB-local time). Outputs are arrays of
 * plain rows + a totals object — friendly for CSV export and table render.
 */
@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  private dateRange(from?: string, to?: string) {
    const f = from ? new Date(from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const t = to   ? new Date(`${to}T23:59:59.999Z`) : new Date();
    return { gte: f, lte: t };
  }

  /**
   * Loss / gain by (process × vendor). For each batch-item × receipt-row pair
   * in the window: planned = stage.totalWeight (for KG processes) or planned
   * per-piece weight × qty; received = Σ recvWt. Loss = planned − received.
   * Group by (process, vendor) for the standard month-end view.
   */
  async lossGain(filter: { from?: string; to?: string; processId?: number; vendorId?: number }) {
    const dateRange = this.dateRange(filter.from, filter.to);
    const rows = await this.prisma.castingReceiptItem.findMany({
      where: {
        receipt: { receiptDate: dateRange },
        ...(filter.processId ? { batchItem: { processId: filter.processId } } : {}),
        ...(filter.vendorId  ? { batchItem: { vendorId:  filter.vendorId  } } : {}),
      },
      include: {
        batchItem: {
          include: {
            stageProcess: { select: { id: true, code: true, name: true } },
            vendor:       { select: { id: true, vendorCode: true, vendorName: true } },
            item:         { select: { sampleDesignCode: true, itemNumber: true, itemName: true } },
          },
        },
        receipt: { select: { receiptDate: true } },
      },
      take: 50_000,
    });

    type Agg = {
      processId: number | null; processCode: string; processName: string;
      vendorId: number; vendorCode: string; vendorName: string;
      issuedWeight: number; receivedWeight: number;
      receivedQty: number; acceptedQty: number; rejectedQty: number;
      receiptCount: number;
    };
    const map = new Map<string, Agg>();
    for (const r of rows) {
      const bi = r.batchItem;
      if (!bi || !bi.stageProcess || !bi.vendor) continue;
      const key = `${bi.stageProcess.id}|${bi.vendor.id}`;
      const acc = map.get(key) ?? {
        processId: bi.stageProcess.id,
        processCode: bi.stageProcess.code,
        processName: bi.stageProcess.name,
        vendorId: bi.vendor.id,
        vendorCode: bi.vendor.vendorCode,
        vendorName: bi.vendor.vendorName,
        issuedWeight: 0, receivedWeight: 0,
        receivedQty: 0, acceptedQty: 0, rejectedQty: 0,
        receiptCount: 0,
      };
      // Issue weight on each row: derive from stage planned weight × qty
      // shipped on this receipt (proportional share). Stage.totalWeight is
      // the entire stage's issue weight; we attribute it pro-rata by
      // received qty across all receipts (approximation; perfect would
      // re-balance against the actual issued weight at issue time).
      const stageQty = Math.max(1, bi.quantity);
      const proRataIssue = Number(bi.totalWeight) * (r.receivedQty / stageQty);
      acc.issuedWeight   += proRataIssue;
      acc.receivedWeight += Number(r.receivedWeight);
      acc.receivedQty    += r.receivedQty;
      acc.acceptedQty    += r.acceptedQty;
      acc.rejectedQty    += r.rejectedQty;
      acc.receiptCount   += 1;
      map.set(key, acc);
    }

    const result = Array.from(map.values()).map((a) => ({
      ...a,
      issuedWeight:   round3(a.issuedWeight),
      receivedWeight: round3(a.receivedWeight),
      lossWeight:     round3(a.issuedWeight - a.receivedWeight),
      lossPct: a.issuedWeight > 0 ? round3(((a.issuedWeight - a.receivedWeight) / a.issuedWeight) * 100) : 0,
    }));
    const totals = result.reduce(
      (t, r) => ({
        issuedWeight:   round3(t.issuedWeight   + r.issuedWeight),
        receivedWeight: round3(t.receivedWeight + r.receivedWeight),
        lossWeight:     round3(t.lossWeight     + r.lossWeight),
        receivedQty:  t.receivedQty  + r.receivedQty,
        acceptedQty:  t.acceptedQty  + r.acceptedQty,
        rejectedQty:  t.rejectedQty  + r.rejectedQty,
      }),
      { issuedWeight: 0, receivedWeight: 0, lossWeight: 0, receivedQty: 0, acceptedQty: 0, rejectedQty: 0 },
    );
    return {
      rows: result.sort((a, b) => b.lossWeight - a.lossWeight),
      totals,
    };
  }

  /**
   * Stones consumed in the window — looks at MaterialIssueLines whose
   * variant.material.category.name = 'Stone'. Reports total pcs + weight
   * issued per (variant × vendor × month).
   */
  async stones(filter: { from?: string; to?: string }) {
    const dateRange = this.dateRange(filter.from, filter.to);
    const lines = await this.prisma.materialIssueLine.findMany({
      where: {
        issue: { issueDate: dateRange },
        variant: { material: { category: { name: { in: ['Stone', 'Stones'] } } } },
      },
      include: {
        variant: { include: { material: { include: { category: true } } } },
        issue:   { include: { vendor: { select: { vendorCode: true, vendorName: true } } } },
      },
      take: 50_000,
    });

    type Row = {
      variantId: number; variantCode: string; variantName: string;
      vendorId: number; vendorCode: string; vendorName: string;
      issuedQty: number; issuedWeight: number; consumedQty: number; receivedQty: number;
    };
    const map = new Map<string, Row>();
    for (const l of lines) {
      const key = `${l.variantId}|${l.issue.vendorId}`;
      const acc = map.get(key) ?? {
        variantId: l.variantId,
        variantCode: l.variant.variantCode,
        variantName: l.variant.variantName,
        vendorId: l.issue.vendorId,
        vendorCode: l.issue.vendor.vendorCode,
        vendorName: l.issue.vendor.vendorName,
        issuedQty: 0, issuedWeight: 0, consumedQty: 0, receivedQty: 0,
      };
      acc.issuedQty    += l.issuedQty;
      acc.issuedWeight += Number((l as any).issuedWeight ?? 0);
      acc.consumedQty  += l.consumedQty;
      acc.receivedQty  += l.receivedQty;
      map.set(key, acc);
    }
    const rows = Array.from(map.values()).map((r) => ({
      ...r,
      issuedWeight: round3(r.issuedWeight),
      shortQty: r.issuedQty - (r.receivedQty + r.consumedQty),
    }));
    const totals = rows.reduce(
      (t, r) => ({
        issuedQty:    t.issuedQty    + r.issuedQty,
        issuedWeight: round3(t.issuedWeight + r.issuedWeight),
        consumedQty:  t.consumedQty  + r.consumedQty,
        receivedQty:  t.receivedQty  + r.receivedQty,
        shortQty:     t.shortQty     + r.shortQty,
      }),
      { issuedQty: 0, issuedWeight: 0, consumedQty: 0, receivedQty: 0, shortQty: 0 },
    );
    return { rows: rows.sort((a, b) => b.issuedWeight - a.issuedWeight), totals };
  }

  /** Current vendor metal advance snapshot (denormalised from VendorMetalBalance). */
  async vendorMetal() {
    const balances = await this.prisma.vendorMetalBalance.findMany({
      where: { balanceWeight: { gt: 0 } },
      include: {
        vendor:  { select: { vendorCode: true, vendorName: true, shortName: true } },
        variant: { include: { material: { select: { materialName: true } } } },
      },
      orderBy: [{ vendor: { vendorName: 'asc' } }, { variant: { variantName: 'asc' } }],
    });
    const rows = balances.map((b) => ({
      vendorId: b.vendorId, vendorCode: b.vendor.vendorCode, vendorName: b.vendor.vendorName,
      variantId: b.variantId, variantCode: b.variant.variantCode, variantName: b.variant.variantName,
      materialName: b.variant.material.materialName,
      balanceWeight: Number(b.balanceWeight),
      updatedAt: b.updatedAt,
    }));
    const totalAdvance = round3(rows.reduce((s, r) => s + r.balanceWeight, 0));
    return { rows, totalAdvance };
  }

  /** Per-design loss profile across all stages in window. */
  async perDesign(filter: { from?: string; to?: string }) {
    const dateRange = this.dateRange(filter.from, filter.to);
    const rows = await this.prisma.castingReceiptItem.findMany({
      where: { receipt: { receiptDate: dateRange } },
      include: {
        batchItem: {
          include: {
            item: { select: { id: true, sampleDesignCode: true, itemNumber: true, itemName: true } },
            stageProcess: { select: { code: true, name: true } },
          },
        },
      },
      take: 50_000,
    });
    type Row = {
      itemId: number; sampleDesignCode: string; itemNumber: string | null; itemName: string | null;
      stages: number; receivedQty: number;
      issuedWeight: number; receivedWeight: number;
    };
    const map = new Map<number, Row>();
    for (const r of rows) {
      const bi = r.batchItem;
      if (!bi || !bi.item) continue;
      const acc = map.get(bi.item.id) ?? {
        itemId: bi.item.id,
        sampleDesignCode: bi.item.sampleDesignCode,
        itemNumber: bi.item.itemNumber, itemName: bi.item.itemName,
        stages: 0, receivedQty: 0, issuedWeight: 0, receivedWeight: 0,
      };
      const stageQty = Math.max(1, bi.quantity);
      const proRataIssue = Number(bi.totalWeight) * (r.receivedQty / stageQty);
      acc.issuedWeight   += proRataIssue;
      acc.receivedWeight += Number(r.receivedWeight);
      acc.receivedQty    += r.receivedQty;
      acc.stages         += 1;
      map.set(bi.item.id, acc);
    }
    const out = Array.from(map.values()).map((r) => ({
      ...r,
      issuedWeight:   round3(r.issuedWeight),
      receivedWeight: round3(r.receivedWeight),
      lossWeight:     round3(r.issuedWeight - r.receivedWeight),
      lossPct: r.issuedWeight > 0 ? round3(((r.issuedWeight - r.receivedWeight) / r.issuedWeight) * 100) : 0,
    }));
    return { rows: out.sort((a, b) => b.lossWeight - a.lossWeight) };
  }
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}
