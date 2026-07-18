import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Customer-side metal + labour ledger. Mirrors the vendor pattern but with
 * two extra event types (LABOUR_GIVEN / LABOUR_RECEIVED) that carry rupees
 * instead of grams and have no variant.
 *
 * Metal events (variantId required, weight in grams, signed):
 *   ALLOCATE_ADVANCE   + weight → customer balance +   (customer hands us silver)
 *   DRAW_INTO_INVOICE  − weight → customer balance −   (we bill from their advance)
 *   RETURN_TO_CUSTOMER − weight → customer balance −   (we return silver)
 *   ADJUST             ± weight → signed correction
 *
 * Labour events (variantId null, "weight" carries rupees):
 *   LABOUR_GIVEN       amount   → labour we invoiced them for
 *   LABOUR_RECEIVED    amount   → payment received against labour
 */
@Injectable()
export class CustomerAdvancesService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  // ------------------------------------------------------------ list / read

  /** Metal balances — one row per (customer × variant). */
  async balances(customerId?: number) {
    const rows = await this.prisma.customerMetalBalance.findMany({
      where: customerId ? { customerId } : {},
      include: {
        customer: { select: { id: true, customerCode: true, customerName: true } },
        variant:  { include: { material: { select: { materialName: true } } } },
      },
      orderBy: [{ customer: { customerName: 'asc' } }, { variant: { variantName: 'asc' } }],
    });
    return rows.map((r) => ({
      customerId: r.customerId,
      customerCode: r.customer.customerCode,
      customerName: r.customer.customerName,
      variantId: r.variantId,
      variantCode: r.variant.variantCode,
      variantName: r.variant.variantName,
      materialName: r.variant.material.materialName,
      balanceWeight: Number(r.balanceWeight),
      updatedAt: r.updatedAt,
    }));
  }

  /** Full ledger feed — filtered, most recent first. */
  async ledger(filter: { customerId?: number; variantId?: number; eventType?: string; limit?: number } = {}) {
    const rows = await this.prisma.customerMetalLedger.findMany({
      where: {
        ...(filter.customerId ? { customerId: filter.customerId } : {}),
        ...(filter.variantId  ? { variantId:  filter.variantId  } : {}),
        ...(filter.eventType  ? { eventType:  filter.eventType as any } : {}),
      },
      include: {
        customer:  { select: { customerCode: true, customerName: true } },
        variant:   { select: { variantCode: true, variantName: true } },
        createdBy: { select: { username: true, fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter.limit ?? 200, 1000),
    });
    return rows.map((r) => ({
      id: r.id,
      customerId: r.customerId,
      customerCode: r.customer.customerCode,
      customerName: r.customer.customerName,
      variantId: r.variantId,
      variantCode: r.variant?.variantCode ?? null,
      variantName: r.variant?.variantName ?? null,
      eventType: r.eventType,
      weight: Number(r.weight),
      balanceAfter: r.balanceAfter != null ? Number(r.balanceAfter) : null,
      refType: r.refType,
      refId: r.refId,
      note: r.note,
      createdAt: r.createdAt,
      createdBy: r.createdBy?.fullName ?? r.createdBy?.username ?? null,
    }));
  }

  /**
   * Per-customer summary. Produces the four tiles the customer detail page
   * needs, plus the metal balances by variant.
   *
   *   totalMetalGiven    — Σ RETURN_TO_CUSTOMER  (silver we handed back)
   *   totalMetalReceived — Σ ALLOCATE_ADVANCE    (silver they handed us)
   *   totalLabourGiven   — Σ LABOUR_GIVEN        (we invoiced them for making)
   *   totalLabourReceived— Σ LABOUR_RECEIVED     (they paid us for making)
   */
  async summary(customerId: number) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new NotFoundException('Customer not found.');

    const grouped = await this.prisma.customerMetalLedger.groupBy({
      by: ['eventType'],
      where: { customerId },
      _sum: { weight: true },
    });
    const sumOf = (t: string) => {
      const row = grouped.find((g) => g.eventType === t);
      return row?._sum.weight != null ? Number(row._sum.weight) : 0;
    };
    // Metal amounts are stored signed (draw / return / labour-received are
    // stored as negative deltas). We surface them as positive rolled totals.
    const totalMetalReceived = r3(sumOf('ALLOCATE_ADVANCE'));       // + weight
    const totalMetalGiven    = r3(Math.abs(sumOf('RETURN_TO_CUSTOMER'))); // − weight
    const totalLabourGiven   = r2(sumOf('LABOUR_GIVEN'));           // + rupees
    const totalLabourReceived = r2(Math.abs(sumOf('LABOUR_RECEIVED'))); // − rupees
    const labourBalance = r2(totalLabourGiven - totalLabourReceived);

    const balances = await this.balances(customerId);
    return {
      customer: {
        id: customer.id,
        customerCode: customer.customerCode,
        customerName: customer.customerName,
      },
      totals: {
        totalMetalReceived,
        totalMetalGiven,
        totalLabourGiven,
        totalLabourReceived,
        labourBalance,
      },
      metalBalances: balances,
    };
  }

  /**
   * The comprehensive metal ledger — end-to-end per-customer view of every
   * gram from the moment it entered the building to the moment it was
   * either sold back to the customer, returned as-is, or is still being
   * held (with us, or at a vendor). Powers the customer-detail page's
   * "metal timeline" strip.
   *
   * Sections:
   *   • lots         — every SilverLot from this customer (advance)
   *   • issuances    — VendorMetalLedger rows sourced from those lots
   *   • holdings     — VendorLotHolding rows still open (vendor is holding X of L)
   *   • draws        — SilverLotDraw rows against invoices (metal sold back)
   *   • consistency  — advance in vs (sold + still-at-vendor + remaining lot balance)
   */
  async metalLedgerFull(customerId: number) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new NotFoundException('Customer not found.');

    const lots = await this.prisma.silverLot.findMany({
      where: { customerId, source: 'CUSTOMER_ADVANCE' },
      include: {
        variant:  { select: { variantCode: true, variantName: true } },
        draws:    { include: { invoice: { select: { invoiceNumber: true, invoiceDate: true } } } },
      },
      orderBy: { receivedAt: 'asc' },
    });

    const lotIds = lots.map((l) => l.id);
    const issuances = lotIds.length ? await this.prisma.vendorMetalLedger.findMany({
      where: { sourceLotId: { in: lotIds } },
      include: {
        vendor:    { select: { vendorCode: true, vendorName: true } },
        variant:   { select: { variantCode: true, variantName: true } },
        sourceLot: { select: { lotNumber: true } },
      },
      orderBy: { createdAt: 'asc' },
    }) : [];

    const holdings = lotIds.length ? await this.prisma.vendorLotHolding.findMany({
      where: { lotId: { in: lotIds }, weightG: { gt: 0 } },
      include: {
        vendor: { select: { vendorCode: true, vendorName: true } },
        lot:    { select: { lotNumber: true, receivedAt: true } },
      },
    }) : [];

    // Consistency roll-up
    const totals = {
      lotsIn:            r3(lots.reduce((s, l) => s + Number(l.receivedWeightG), 0)),
      remainingInLots:   r3(lots.reduce((s, l) => s + Number(l.remainingWeightG), 0)),
      atVendors:         r3(holdings.reduce((s, h) => s + Number(h.weightG), 0)),
      soldToCustomer:    r3(lots.reduce((s, l) => s + l.draws.reduce((ss, d) => ss + Number(d.weightG), 0), 0)),
    };
    // Whatever's not remaining, not at a vendor, and not sold is either
    // legitimate loss (accepted in-flight), runners in a downstream pool,
    // OR unaccounted. Surface as "unreconciled" so the operator sees it.
    (totals as any).unreconciled = r3(
      totals.lotsIn - totals.remainingInLots - totals.atVendors - totals.soldToCustomer,
    );

    return {
      customer: {
        id: customer.id,
        customerCode: customer.customerCode,
        customerName: customer.customerName,
      },
      lots: lots.map((l) => ({
        id: l.id,
        lotNumber: l.lotNumber,
        rateType: l.rateType,
        variant: `${l.variant.variantCode} · ${l.variant.variantName}`,
        receivedAt: l.receivedAt,
        receivedWeightG: Number(l.receivedWeightG),
        remainingWeightG: Number(l.remainingWeightG),
        ratePerG: Number(l.ratePerG),
        drawsCount: l.draws.length,
        soldWeightG: r3(l.draws.reduce((s, d) => s + Number(d.weightG), 0)),
      })),
      issuances: issuances.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        eventType: r.eventType,
        weight: Number(r.weight),
        vendor: r.vendor ? `${r.vendor.vendorCode} · ${r.vendor.vendorName}` : null,
        lotNumber: r.sourceLot?.lotNumber ?? null,
        variant: `${r.variant.variantCode} · ${r.variant.variantName}`,
        note: r.note,
      })),
      holdings: holdings.map((h) => ({
        vendorId: h.vendorId,
        vendor: h.vendor ? `${h.vendor.vendorCode} · ${h.vendor.vendorName}` : '?',
        lotNumber: h.lot.lotNumber,
        weightG: Number(h.weightG),
      })),
      draws: lots.flatMap((l) =>
        l.draws.map((d) => ({
          id: d.id,
          drawnAt: d.drawnAt,
          weightG: Number(d.weightG),
          ratePerG: Number(d.ratePerG),
          lotNumber: l.lotNumber,
          invoiceNumber: d.invoice?.invoiceNumber ?? null,
          invoiceDate: d.invoice?.invoiceDate ?? null,
          note: d.note,
        })),
      ),
      totals,
    };
  }

  // ------------------------------------------------------------- mutations

  /** Customer hands us silver. Their balance +, no impact on our main stock
   *  (it's their material — we're just holding it). */
  async allocate(
    dto: { customerId: number; variantId: number; weight: number; note?: string },
    userId?: number,
  ) {
    const weight = r3(Number(dto.weight ?? 0));
    if (weight <= 0) throw new BadRequestException('Allocation weight must be positive.');

    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException('Customer not found.');
    const variant = await this.prisma.materialVariant.findUnique({ where: { id: dto.variantId } });
    if (!variant) throw new NotFoundException('Material variant not found.');
    if (!variant.trackByWeight) {
      throw new BadRequestException(
        `Variant "${variant.variantName}" is not weight-tracked. Advance metal needs a weight-tracked variant.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Atomic upsert-with-increment — see vendor-advances.allocate for
      // the race this avoids.
      const bal = await tx.customerMetalBalance.upsert({
        where: { customerId_variantId: { customerId: dto.customerId, variantId: dto.variantId } },
        update: { balanceWeight: { increment: weight } },
        create: { customerId: dto.customerId, variantId: dto.variantId, balanceWeight: weight },
      });
      const newBal = r3(Number(bal.balanceWeight));
      const ledger = await tx.customerMetalLedger.create({
        data: {
          customerId: dto.customerId, variantId: dto.variantId,
          eventType: 'ALLOCATE_ADVANCE',
          weight, balanceAfter: newBal,
          refType: 'allocate', refId: bal.id,
          note: dto.note ?? null, createdById: userId ?? null,
        },
      });
      await this.audit.log(userId, {
        action: 'customer-advances.allocate',
        targetType: 'CustomerMetalBalance',
        targetId: bal.id,
        description: `Received ${weight} g of ${variant.variantName} from ${customer.customerName}`,
        snapshotAfter: { customerId: dto.customerId, variantId: dto.variantId, weight, balanceAfter: newBal },
      });
      return { id: bal.id, ledgerId: ledger.id, balanceWeight: newBal };
    });
  }

  /** We return silver to the customer. Balance −. */
  async returnToCustomer(
    dto: { customerId: number; variantId: number; weight: number; note?: string },
    userId?: number,
  ) {
    const weight = r3(Number(dto.weight ?? 0));
    if (weight <= 0) throw new BadRequestException('Return weight must be positive.');

    const balance = await this.prisma.customerMetalBalance.findUnique({
      where: { customerId_variantId: { customerId: dto.customerId, variantId: dto.variantId } },
      include: { customer: true, variant: true },
    });
    if (!balance) throw new NotFoundException('No metal balance exists for this customer + variant.');
    const cur = Number(balance.balanceWeight);
    if (cur < weight) {
      throw new BadRequestException(
        `Return exceeds balance. Balance: ${cur.toFixed(3)} g · Returning: ${weight.toFixed(3)} g.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.customerMetalBalance.update({
        where: { id: balance.id },
        data: { balanceWeight: { decrement: weight } },
      });
      const newBal = r3(Number(updated.balanceWeight));
      if (newBal < 0) {
        throw new BadRequestException(
          `Return exceeds balance under concurrent activity (final balance ${newBal.toFixed(3)} g).`,
        );
      }
      const ledger = await tx.customerMetalLedger.create({
        data: {
          customerId: dto.customerId, variantId: dto.variantId,
          eventType: 'RETURN_TO_CUSTOMER',
          weight: -weight, balanceAfter: newBal,
          refType: 'return', refId: balance.id,
          note: dto.note ?? null, createdById: userId ?? null,
        },
      });
      return { ledgerId: ledger.id, balanceWeight: newBal };
    });
  }

  /** Labour given — invoiced to customer (rupees). Standalone record so the
   *  customer-detail summary can roll it up without walking invoices. */
  async recordLabourGiven(
    dto: { customerId: number; amount: number; refType?: string; refId?: number; note?: string },
    userId?: number,
  ) {
    const amount = r2(Number(dto.amount ?? 0));
    if (amount <= 0) throw new BadRequestException('Labour amount must be positive.');
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException('Customer not found.');
    return this.prisma.customerMetalLedger.create({
      data: {
        customerId: dto.customerId,
        variantId: null,
        eventType: 'LABOUR_GIVEN',
        weight: amount,
        balanceAfter: null,
        refType: dto.refType ?? null,
        refId: dto.refId ?? null,
        note: dto.note ?? null,
        createdById: userId ?? null,
      },
    });
  }

  /** Labour received — payment collected (rupees, stored negative). */
  async recordLabourReceived(
    dto: { customerId: number; amount: number; refType?: string; refId?: number; note?: string },
    userId?: number,
  ) {
    const amount = r2(Number(dto.amount ?? 0));
    if (amount <= 0) throw new BadRequestException('Payment amount must be positive.');
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException('Customer not found.');
    return this.prisma.customerMetalLedger.create({
      data: {
        customerId: dto.customerId,
        variantId: null,
        eventType: 'LABOUR_RECEIVED',
        weight: -amount,
        balanceAfter: null,
        refType: dto.refType ?? null,
        refId: dto.refId ?? null,
        note: dto.note ?? null,
        createdById: userId ?? null,
      },
    });
  }

  /** Manual signed adjustment with mandatory note. */
  async adjust(
    dto: { customerId: number; variantId: number; weight: number; note: string },
    userId?: number,
  ) {
    const weight = r3(Number(dto.weight ?? 0));
    if (weight === 0) throw new BadRequestException('Adjustment weight must be non-zero.');
    if (!dto.note?.trim()) throw new BadRequestException('Adjustments require a note (audit trail).');

    return this.prisma.$transaction(async (tx) => {
      const bal = await tx.customerMetalBalance.upsert({
        where: { customerId_variantId: { customerId: dto.customerId, variantId: dto.variantId } },
        update: { balanceWeight: { increment: weight } },
        create: { customerId: dto.customerId, variantId: dto.variantId, balanceWeight: weight },
      });
      const newBal = r3(Number(bal.balanceWeight));
      if (newBal < 0) throw new BadRequestException('Adjustment would push balance below zero.');
      const ledger = await tx.customerMetalLedger.create({
        data: {
          customerId: dto.customerId, variantId: dto.variantId,
          eventType: 'ADJUST',
          weight, balanceAfter: newBal,
          refType: 'adjust', refId: bal.id,
          note: dto.note.trim(), createdById: userId ?? null,
        },
      });
      return { ledgerId: ledger.id, balanceWeight: newBal };
    });
  }

  /**
   * Hard-delete a customer ledger entry + unwind its balance impact. Same
   * rules as vendor-advances.deleteLedger: DRAW_INTO_INVOICE / any entry
   * carrying an invoiceId is off-limits (delete the invoice instead).
   * Labour entries (LABOUR_GIVEN / LABOUR_RECEIVED) DON'T touch the metal
   * balance — they're rupee-only — so those unwind cleanly with no
   * balance write.
   */
  async deleteLedger(id: number, userId?: number) {
    const entry = await this.prisma.customerMetalLedger.findUnique({ where: { id } });
    if (!entry) throw new NotFoundException('Ledger entry not found.');
    if (entry.eventType === 'DRAW_INTO_INVOICE') {
      throw new BadRequestException('Invoice draws are linked to a bill — delete the source invoice instead.');
    }
    const isMetal = entry.eventType !== 'LABOUR_GIVEN' && entry.eventType !== 'LABOUR_RECEIVED';
    const signed = Number(entry.weight);

    return this.prisma.$transaction(async (tx) => {
      if (isMetal) {
        const bal = await tx.customerMetalBalance.update({
          where: { customerId_variantId: { customerId: entry.customerId, variantId: entry.variantId! } },
          data: { balanceWeight: { decrement: signed } },
        });
        const newBal = r3(Number(bal.balanceWeight));
        if (newBal < 0) throw new BadRequestException('Cannot delete — remaining ledger would go negative.');
      }
      await tx.customerMetalLedger.delete({ where: { id } });
      await this.audit.log(userId, {
        action: 'customer-advances.deleteLedger',
        targetType: 'CustomerMetalLedger',
        targetId: id,
        description: `Deleted ledger #${id}: ${signed} (${entry.eventType})`,
      });
      return { id };
    });
  }

  /** Helper for the billing flow — draw `weight` g from a customer advance
   *  onto an invoice. Called inside the invoice transaction. */
  async drawIntoInvoice(
    tx: any,
    args: { customerId: number; variantId: number; weight: number; invoiceId: number; userId?: number },
  ) {
    const weight = r3(args.weight);
    if (weight <= 0) return null;
    // Atomic decrement — if the row doesn't exist or the balance goes
    // negative, throw so the outer $transaction rolls back cleanly.
    const current = await tx.customerMetalBalance.findUnique({
      where: { customerId_variantId: { customerId: args.customerId, variantId: args.variantId } },
    });
    if (!current) {
      throw new BadRequestException(
        `Customer has no metal advance for this variant — cannot draw ${weight.toFixed(3)} g.`,
      );
    }
    const updated = await tx.customerMetalBalance.update({
      where: { id: current.id },
      data: { balanceWeight: { decrement: weight } },
    });
    const newBal = r3(Number(updated.balanceWeight));
    if (newBal < 0) {
      throw new BadRequestException(
        `Customer advance would go negative under concurrent draw (final ${newBal.toFixed(3)} g).`,
      );
    }
    return tx.customerMetalLedger.create({
      data: {
        customerId: args.customerId, variantId: args.variantId,
        eventType: 'DRAW_INTO_INVOICE',
        weight: -weight, balanceAfter: newBal,
        refType: 'invoice', refId: args.invoiceId,
        note: `Draw into invoice #${args.invoiceId}`,
        createdById: args.userId ?? null,
      },
    });
  }
}
