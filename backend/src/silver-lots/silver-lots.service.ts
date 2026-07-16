import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { nextCode } from '../common/code-generator';

/**
 * Silver lot manager — the FIFO metal-inventory system that feeds
 * invoicing rates. Every kg of silver we hold, whether purchased from
 * a bullion supplier or received as customer advance, becomes ONE lot.
 * Invoices for that customer (or general sale for BULLION lots) consume
 * lots in receipt-order; when a bill crosses a lot boundary, the billing
 * service auto-splits at the boundary line.
 *
 * See `project_erp_roadmap_2026-07.md` for the design.
 */
@Injectable()
export class SilverLotsService {
  constructor(private prisma: PrismaService) {}

  private r3(n: number) { return Math.round(n * 1000) / 1000; }

  /**
   * Create a new lot. `source=BULLION` requires `vendorId`;
   * `source=CUSTOMER_ADVANCE` requires `customerId`.
   */
  async createLot(dto: {
    source: 'BULLION' | 'CUSTOMER_ADVANCE';
    rateType: 'FIX' | 'UNFIX';
    variantId: number;
    vendorId?: number;
    customerId?: number;
    receivedAt?: string;
    receivedWeightG: number;
    ratePerG: number;
    billNumber?: string;
    notes?: string;
  }, userId?: number) {
    if (dto.source === 'BULLION' && !dto.vendorId) {
      throw new BadRequestException('BULLION lots require vendorId.');
    }
    if (dto.source === 'CUSTOMER_ADVANCE' && !dto.customerId) {
      throw new BadRequestException('CUSTOMER_ADVANCE lots require customerId.');
    }
    if (!(dto.receivedWeightG > 0)) {
      throw new BadRequestException('receivedWeightG must be positive.');
    }
    if (!(dto.ratePerG > 0)) {
      throw new BadRequestException('ratePerG must be positive.');
    }
    const variant = await this.prisma.materialVariant.findUnique({ where: { id: dto.variantId } });
    if (!variant) throw new NotFoundException('Material variant not found.');

    const lotNumber = await nextCode(this.prisma, 'materialVariant' /* placeholder */, 'variantCode', 'LOT', 5);
    // (nextCode signature is limited to specific model keys, so we use
    // a stable local counter instead.)
    const count = await this.prisma.silverLot.count();
    const paddedLot = 'LOT' + String(count + 1).padStart(5, '0');

    const weight = this.r3(dto.receivedWeightG);
    const lot = await this.prisma.$transaction(async (tx) => {
      const created = await tx.silverLot.create({
        data: {
          lotNumber: paddedLot,
          source: dto.source as any,
          rateType: dto.rateType as any,
          variantId: dto.variantId,
          vendorId: dto.vendorId ?? null,
          customerId: dto.customerId ?? null,
          receivedAt: dto.receivedAt ? new Date(dto.receivedAt) : new Date(),
          receivedWeightG: weight,
          remainingWeightG: weight,
          ratePerG: dto.ratePerG,
          billNumber: dto.billNumber ?? null,
          notes: dto.notes ?? null,
          createdById: userId ?? null,
        },
      });
      // Bump the underlying MaterialVariant stock so the receive counts
      // toward the global silver-999 or silver-93.5 pool.
      await tx.materialVariant.update({
        where: { id: dto.variantId },
        data: { stockWeight: { increment: weight } },
      });
      await tx.stockMovement.create({
        data: {
          variantId: dto.variantId,
          type: 'IN',
          quantity: 0,
          balanceAfter: Number(variant.stockQty),
          weight,
          balanceWeightAfter: this.r3(Number(variant.stockWeight) + weight),
          refType: dto.source === 'BULLION' ? 'bullion_purchase' : 'customer_advance',
          refId: created.id,
          note: `Lot ${paddedLot} · ${dto.rateType} @ ₹${dto.ratePerG}/g`,
          createdById: userId ?? null,
        } as any,
      });
      return created;
    });
    return lot;
  }

  /**
   * Edit meta-fields on a lot (rate, rate type, notes, bill number,
   * receivedAt). Weight fields (receivedWeightG / remainingWeightG) are
   * off-limits because they'd de-sync draws that already touched this
   * lot — the operator should void + recreate instead in that rare case.
   * Blocks when any draws exist on the lot AND ratePerG is being changed
   * (past draws locked in the old rate at invoice time).
   */
  async updateLot(
    id: number,
    dto: {
      rateType?: 'FIX' | 'UNFIX';
      receivedAt?: string;
      ratePerG?: number;
      billNumber?: string;
      notes?: string;
    },
    userId?: number,
  ) {
    const lot = await this.prisma.silverLot.findUnique({
      where: { id },
      include: { _count: { select: { draws: true } } },
    });
    if (!lot) throw new NotFoundException('Silver lot not found.');
    const rateChanging = dto.ratePerG != null && Number(dto.ratePerG) !== Number(lot.ratePerG);
    if (rateChanging && lot._count.draws > 0) {
      throw new BadRequestException(
        `Lot ${lot.lotNumber} already has ${lot._count.draws} draw(s). Its rate is locked. Void the lot instead if the rate was wrong.`,
      );
    }
    const updated = await this.prisma.silverLot.update({
      where: { id },
      data: {
        ...(dto.rateType ? { rateType: dto.rateType as any } : {}),
        ...(dto.receivedAt ? { receivedAt: new Date(dto.receivedAt) } : {}),
        ...(dto.ratePerG != null ? { ratePerG: dto.ratePerG } : {}),
        ...(dto.billNumber !== undefined ? { billNumber: dto.billNumber || null } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes || null } : {}),
      },
    });
    return updated;
  }

  /**
   * Hard-delete a lot. Blocked when any draws or vendor-holdings reference
   * it — those consuming rows would go dangling. Delete the receipt / undo
   * the vendor allocation first to free the lot.
   */
  async deleteLot(id: number, userId?: number) {
    const lot = await this.prisma.silverLot.findUnique({
      where: { id },
      include: { _count: { select: { draws: true, vendorHoldings: true } } },
    });
    if (!lot) throw new NotFoundException('Silver lot not found.');
    if (lot._count.draws > 0 || lot._count.vendorHoldings > 0) {
      throw new BadRequestException(
        `Lot ${lot.lotNumber} is referenced by ${lot._count.draws} draw(s) and ${lot._count.vendorHoldings} vendor holding(s). Unwind those first.`,
      );
    }
    await this.prisma.silverLot.delete({ where: { id } });
    return { id, lotNumber: lot.lotNumber };
  }

  /**
   * List lots. Filters: customerId (advance lots for that customer),
   * source, variantId, hasRemaining (only lots with balance > 0).
   */
  async list(q: {
    customerId?: number;
    source?: 'BULLION' | 'CUSTOMER_ADVANCE';
    variantId?: number;
    hasRemaining?: boolean;
  }) {
    return this.prisma.silverLot.findMany({
      where: {
        ...(q.customerId ? { customerId: q.customerId } : {}),
        ...(q.source ? { source: q.source as any } : {}),
        ...(q.variantId ? { variantId: q.variantId } : {}),
        ...(q.hasRemaining ? { remainingWeightG: { gt: 0 } } : {}),
      },
      include: {
        variant:  { select: { variantCode: true, variantName: true } },
        vendor:   { select: { vendorCode: true, vendorName: true } },
        customer: { select: { customerCode: true, customerName: true } },
      },
      orderBy: { receivedAt: 'asc' }, // FIFO by default
    });
  }

  /**
   * FIFO draw — consume metal for an invoice, working across the two
   * silver pools (999 and 93.5). We accept the OUTWARD variant (usually
   * 93.5, the finished jewellery) and consume ANY of the customer's
   * silver lots — 999 OR 93.5 — in receipt order, converting the draw
   * to the lot's fine-metal equivalent so the customer's raw silver
   * contribution comes out fairly.
   *
   *   Example: invoice needs 200 g of Silver 93.5.
   *     • 93.5 lot: draw 200 g at lot rate.
   *     • 999 lot: draw 200 × 0.935 = 187 g at lot rate.
   *
   * Eligibility:
   *   • customerId given → prefer that customer's CUSTOMER_ADVANCE lots.
   *   • customerId absent → BULLION lots only.
   *   • FIX lots only (UNFIX callers should invoke list() themselves).
   *   • Cross-pool: ALL silver variants (identified by fineness > 0)
   *     are eligible, not just the exact match.
   */
  async computeFifoDraw(args: {
    customerId?: number;
    variantId: number;
    weightG: number;
  }) {
    const wanted = this.r3(args.weightG);
    if (wanted <= 0) return { draws: [], remainingUnfilled: 0 };

    // The outward variant's fineness = how much fine metal per gram of
    // finished jewellery. When drawing from a lot of the SAME variant,
    // the ratio is 1 (direct). When drawing from a lot of DIFFERENT
    // variant, we scale to preserve fine-metal equivalence.
    const outVariant = await this.prisma.materialVariant.findUnique({
      where: { id: args.variantId },
    });
    const outFineness = outVariant?.fineness ? Number(outVariant.fineness) : 1;

    // Discover every silver variant so we can walk all lots regardless of
    // pool. "Silver" identified by name for now — good enough since only
    // silver has fineness set in seed.
    const silverVariants = await this.prisma.materialVariant.findMany({
      where: { fineness: { not: null } },
      select: { id: true, variantCode: true, variantName: true, fineness: true },
    });
    const finenessById = new Map<number, number>(
      silverVariants.map((v) => [v.id, Number(v.fineness ?? 1)]),
    );

    // Aggregate across pools, then order FIFO by receivedAt.
    const eligibleLots: any[] = [];
    if (args.customerId) {
      const advance = await this.list({
        customerId: args.customerId,
        source: 'CUSTOMER_ADVANCE',
        hasRemaining: true,
      });
      eligibleLots.push(...advance.filter((l) => l.rateType === 'FIX' && finenessById.has(l.variantId)));
    }
    const bullion = await this.list({
      source: 'BULLION',
      hasRemaining: true,
    });
    eligibleLots.push(...bullion.filter((l) => l.rateType === 'FIX' && finenessById.has(l.variantId)));
    eligibleLots.sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());

    type Draw = {
      lotId: number; lotNumber: string;
      // How much of the OUTWARD variant this draw covers (invoice-facing).
      weightG: number;
      // What actually got decremented from the LOT (lot-variant grams).
      lotWeightG: number;
      ratePerG: number;
      source: string;
      lotVariantCode: string;
      conversionRatio: number; // outward-per-lot ratio, for the note field
    };
    const draws: Draw[] = [];
    let needOutward = wanted;
    for (const lot of eligibleLots) {
      if (needOutward <= 0) break;
      const lotFineness = finenessById.get(lot.variantId) ?? 1;
      // Grams of the lot's variant needed to cover 1 g of the outward
      // variant, fine-metal preserved.
      //   fineMetal(outward × 1 g) = fineMetal(lot × X g)
      //   outFineness = lotFineness × X → X = outFineness / lotFineness
      const ratio = outFineness / lotFineness; // grams of lot per gram of outward
      const availLot = Number(lot.remainingWeightG);
      const availOutward = availLot / ratio;
      const takeOutward = this.r3(Math.min(needOutward, availOutward));
      const takeLot = this.r3(takeOutward * ratio);
      if (takeOutward <= 0 || takeLot <= 0) continue;
      draws.push({
        lotId: lot.id,
        lotNumber: lot.lotNumber,
        weightG: takeOutward,
        lotWeightG: takeLot,
        ratePerG: Number(lot.ratePerG),
        source: lot.source,
        lotVariantCode: lot.variant?.variantCode ?? '?',
        conversionRatio: ratio,
      });
      needOutward = this.r3(needOutward - takeOutward);
    }
    return { draws, remainingUnfilled: Math.max(0, this.r3(needOutward)) };
  }

  /**
   * Persist a draw against a lot. Called by the billing service when an
   * invoice line consumes metal. Decrements `remainingWeightG` and writes
   * a SilverLotDraw ledger row.
   *
   * Auto-residual-close: after the draw, if this lot's remainingWeightG
   * drops below `RESIDUAL_THRESHOLD_G` (default 10 g), we consume the
   * remaining dust automatically at the SAME rate as this draw and roll
   * it into the current invoice as an additional silent draw. Keeps the
   * customer from ever paying a mixed rate on a scrap balance AND
   * prevents micro-lot dregs from cluttering the FIFO ledger.
   */
  async applyDraw(
    tx: any,
    args: {
      lotId: number;
      invoiceId?: number;
      invoiceItemId?: number;
      // Weight to actually deduct from the LOT's remaining balance. When
      // the lot's variant matches the invoice's outward variant, this
      // equals the invoice-facing quantity. When they differ (999 lot
      // fed to a 93.5 invoice), the caller passes the fine-metal-
      // equivalent lot grams (usually via computeFifoDraw's lotWeightG).
      weightG: number;
      ratePerG: number;
      note?: string;
    },
  ) {
    const RESIDUAL_THRESHOLD_G = 10;
    const weight = this.r3(args.weightG);
    if (weight <= 0) return null;
    const lot = await tx.silverLot.findUnique({ where: { id: args.lotId } });
    if (!lot) throw new NotFoundException(`Lot #${args.lotId} not found.`);
    if (Number(lot.remainingWeightG) < weight - 0.0005) {
      throw new BadRequestException(
        `Lot ${lot.lotNumber} has ${lot.remainingWeightG} g — cannot draw ${weight} g.`,
      );
    }
    await tx.silverLot.update({
      where: { id: args.lotId },
      data: { remainingWeightG: { decrement: weight } },
    });
    const primaryDraw = await tx.silverLotDraw.create({
      data: {
        lotId: args.lotId,
        invoiceId: args.invoiceId ?? null,
        invoiceItemId: args.invoiceItemId ?? null,
        weightG: weight,
        ratePerG: args.ratePerG,
        note: args.note ?? null,
      },
    });
    // Residual cleanup — sweep the last <10 g into this same invoice at
    // this lot's rate. Silent by design; audit trail on the SilverLotDraw
    // row shows "residual close" so it can be reconciled later.
    const after = await tx.silverLot.findUnique({ where: { id: args.lotId } });
    const remaining = Number(after?.remainingWeightG ?? 0);
    if (remaining > 0 && remaining < RESIDUAL_THRESHOLD_G) {
      const residual = this.r3(remaining);
      await tx.silverLot.update({
        where: { id: args.lotId },
        data: { remainingWeightG: 0 },
      });
      await tx.silverLotDraw.create({
        data: {
          lotId: args.lotId,
          invoiceId: args.invoiceId ?? null,
          invoiceItemId: args.invoiceItemId ?? null,
          weightG: residual,
          ratePerG: args.ratePerG, // ← same rate; the customer never pays a mixed price on dust
          note: `Residual auto-close (<${RESIDUAL_THRESHOLD_G} g threshold)`,
        },
      });
    }
    return primaryDraw;
  }
}
