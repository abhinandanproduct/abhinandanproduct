import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Vendor advance metal — pre-allocated silver / metal lump-sum given to a
 * karigar before they start a job, drawn down on each batch issue.
 *
 * Ledger model (append-only):
 *   ALLOCATE_ADVANCE  + weight  | main stock −  vendor balance +
 *   DRAW_INTO_BATCH   − weight  |               vendor balance −  (batch issue)
 *   RETURN_TO_ADVANCE + weight  |               vendor balance +  (vendor returns
 *                                                                    leftover metal)
 *   ADJUST            ± weight  | manual correction with a note
 *
 * VendorMetalBalance row mirrors the running balance per (vendor × variant)
 * so we don't recompute it for every page render.
 */
@Injectable()
export class VendorAdvancesService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** List balances — one row per (vendor × variant) with positive balance. */
  async balances(vendorId?: number) {
    const rows = await this.prisma.vendorMetalBalance.findMany({
      where: vendorId ? { vendorId } : {},
      include: {
        vendor:  { select: { id: true, vendorCode: true, vendorName: true, shortName: true } },
        variant: { include: { material: { select: { materialName: true } } } },
      },
      orderBy: [{ vendor: { vendorName: 'asc' } }, { variant: { variantName: 'asc' } }],
    });
    return rows.map((r) => ({
      vendorId: r.vendorId,
      vendorCode: r.vendor.vendorCode,
      vendorName: r.vendor.vendorName,
      vendorShortName: r.vendor.shortName,
      variantId: r.variantId,
      variantCode: r.variant.variantCode,
      variantName: r.variant.variantName,
      materialName: r.variant.material.materialName,
      balanceWeight: Number(r.balanceWeight),
      updatedAt: r.updatedAt,
    }));
  }

  /** Ledger feed — most recent first, optionally filtered by vendor / variant. */
  async ledger(filter: { vendorId?: number; variantId?: number; limit?: number } = {}) {
    const rows = await this.prisma.vendorMetalLedger.findMany({
      where: {
        ...(filter.vendorId  ? { vendorId:  filter.vendorId  } : {}),
        ...(filter.variantId ? { variantId: filter.variantId } : {}),
      },
      include: {
        vendor:    { select: { vendorCode: true, vendorName: true } },
        variant:   { select: { variantCode: true, variantName: true } },
        createdBy: { select: { username: true, fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filter.limit ?? 200, 1000),
    });
    return rows.map((r) => ({
      id: r.id,
      vendorId: r.vendorId,
      vendorCode: r.vendor.vendorCode,
      vendorName: r.vendor.vendorName,
      variantId: r.variantId,
      variantCode: r.variant.variantCode,
      variantName: r.variant.variantName,
      eventType: r.eventType,
      weight: Number(r.weight),
      balanceAfter: Number(r.balanceAfter),
      refType: r.refType,
      refId: r.refId,
      note: r.note,
      createdAt: r.createdAt,
      createdBy: r.createdBy?.fullName ?? r.createdBy?.username ?? null,
    }));
  }

  /**
   * Allocate fresh advance to a vendor — debits main stock (the variant's
   * stockWeight) and credits the vendor's metal balance. Used for the
   * initial lump-sum + any top-ups thereafter.
   */
  async allocate(
    dto: { vendorId: number; variantId: number; weight: number; note?: string; sourceLotId?: number },
    userId?: number,
  ) {
    const weight = r3(Number(dto.weight ?? 0));
    if (weight <= 0) throw new BadRequestException('Allocation weight must be positive.');

    const vendor  = await this.prisma.vendor.findUnique({ where: { id: dto.vendorId } });
    if (!vendor)  throw new NotFoundException('Vendor not found.');
    const variant = await this.prisma.materialVariant.findUnique({ where: { id: dto.variantId } });
    if (!variant) throw new NotFoundException('Material variant not found.');
    if (!variant.trackByWeight) {
      throw new BadRequestException(
        `Variant "${variant.variantName}" is not weight-tracked. Advance metal needs a weight-tracked variant (e.g. silver).`,
      );
    }
    const stockWt = Number(variant.stockWeight);
    if (stockWt < weight) {
      throw new BadRequestException(
        `Not enough stock to allocate. Available: ${stockWt.toFixed(3)} g · Requested: ${weight.toFixed(3)} g.`,
      );
    }

    // Optional source-lot binding — when the caller specifies a SilverLot,
    // we decrement it (customer's advance stays consistent) and record a
    // VendorLotHolding so we can trace "V holds 1.5 kg of C's L001". The
    // lot MUST have enough remaining and match the variant; mismatches
    // are rejected here.
    let sourceLot: any = null;
    if (dto.sourceLotId) {
      sourceLot = await this.prisma.silverLot.findUnique({ where: { id: dto.sourceLotId } });
      if (!sourceLot) throw new NotFoundException(`Source lot #${dto.sourceLotId} not found.`);
      if (sourceLot.variantId !== dto.variantId) {
        throw new BadRequestException(
          `Source lot ${sourceLot.lotNumber} carries a different variant than the requested issue.`,
        );
      }
      if (Number(sourceLot.remainingWeightG) < weight - 0.0005) {
        throw new BadRequestException(
          `Source lot ${sourceLot.lotNumber} has only ${Number(sourceLot.remainingWeightG).toFixed(3)} g remaining; requested ${weight.toFixed(3)} g.`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const newStockWt = r3(stockWt - weight);
      await tx.materialVariant.update({
        where: { id: dto.variantId },
        data: { stockWeight: newStockWt },
      });
      await tx.stockMovement.create({
        data: {
          variantId: dto.variantId, type: 'OUT',
          quantity: 0, balanceAfter: Number(variant.stockQty),
          weight: -weight, balanceWeightAfter: newStockWt,
          refType: 'vendor_advance', refId: dto.vendorId,
          note: `Advance to vendor ${vendor.vendorCode}${sourceLot ? ' · from ' + sourceLot.lotNumber : ''}${dto.note ? ' · ' + dto.note : ''}`,
          createdById: userId ?? null,
        } as any,
      });

      // Atomic upsert-with-increment on the aggregate balance.
      const bal = await tx.vendorMetalBalance.upsert({
        where: { vendorId_variantId: { vendorId: dto.vendorId, variantId: dto.variantId } },
        update: { balanceWeight: { increment: weight } },
        create: { vendorId: dto.vendorId, variantId: dto.variantId, balanceWeight: weight },
      });
      const newBal = r3(Number(bal.balanceWeight));

      // If a source lot is bound, drop its remaining balance AND bump the
      // per-lot vendor holding so we can reconstruct "V holds X of L".
      if (sourceLot) {
        await tx.silverLot.update({
          where: { id: sourceLot.id },
          data: { remainingWeightG: { decrement: weight } },
        });
        await tx.vendorLotHolding.upsert({
          where: { vendorId_lotId: { vendorId: dto.vendorId, lotId: sourceLot.id } },
          update: { weightG: { increment: weight } },
          create: { vendorId: dto.vendorId, lotId: sourceLot.id, weightG: weight },
        });
      }

      const ledger = await tx.vendorMetalLedger.create({
        data: {
          vendorId: dto.vendorId, variantId: dto.variantId,
          eventType: 'ALLOCATE_ADVANCE',
          weight, balanceAfter: newBal,
          refType: 'allocate', refId: bal.id,
          sourceLotId: sourceLot?.id ?? null,
          note: dto.note ?? null, createdById: userId ?? null,
        } as any,
      });

      await this.audit.log(userId, {
        action: 'vendor-advances.allocate',
        targetType: 'VendorMetalBalance',
        targetId: bal.id,
        description: `Allocated ${weight} g of ${variant.variantName} to ${vendor.vendorName}${sourceLot ? ` from lot ${sourceLot.lotNumber}` : ''}`,
        snapshotAfter: { vendorId: dto.vendorId, variantId: dto.variantId, weight, balanceAfter: newBal, sourceLotId: sourceLot?.id ?? null },
      });

      return { id: bal.id, ledgerId: ledger.id, balanceWeight: newBal, sourceLotId: sourceLot?.id ?? null };
    });
  }

  /**
   * Vendor returns leftover metal — credits both the vendor's balance and
   * main stock. Used when a job ends with leftover advance that the
   * vendor physically hands back.
   */
  async returnFromVendor(
    dto: { vendorId: number; variantId: number; weight: number; note?: string; sourceLotId?: number },
    userId?: number,
  ) {
    const weight = r3(Number(dto.weight ?? 0));
    if (weight <= 0) throw new BadRequestException('Return weight must be positive.');

    const balance = await this.prisma.vendorMetalBalance.findUnique({
      where: { vendorId_variantId: { vendorId: dto.vendorId, variantId: dto.variantId } },
      include: { vendor: true, variant: true },
    });
    if (!balance) throw new NotFoundException('No advance balance exists for this vendor + variant.');
    const cur = Number(balance.balanceWeight);
    if (cur < weight) {
      throw new BadRequestException(
        `Return exceeds advance balance. Balance: ${cur.toFixed(3)} g · Returning: ${weight.toFixed(3)} g.`,
      );
    }

    // Optional lot binding — when the return should be credited back to a
    // specific lot (the customer's advance is being reconstituted), we
    // decrement the vendor's per-lot holding and increment the lot's
    // remaining balance so consistency across (given → issued → returned)
    // holds. Explicit for now — the auto-tag path lives in the receipt
    // flow (Task #13).
    let sourceLot: any = null;
    if (dto.sourceLotId) {
      sourceLot = await this.prisma.silverLot.findUnique({ where: { id: dto.sourceLotId } });
      if (!sourceLot) throw new NotFoundException(`Source lot #${dto.sourceLotId} not found.`);
      const holding = await this.prisma.vendorLotHolding.findUnique({
        where: { vendorId_lotId: { vendorId: dto.vendorId, lotId: sourceLot.id } },
      });
      if (!holding || Number(holding.weightG) < weight - 0.0005) {
        throw new BadRequestException(
          `Vendor doesn't hold ${weight.toFixed(3)} g of lot ${sourceLot.lotNumber} to return.`,
        );
      }
    }

    return this.prisma.$transaction(async (tx) => {
      // Atomic decrement — under concurrent returns for the same
      // (vendor × variant), each caller subtracts its own weight; if the
      // running balance goes negative, the guard below throws and rolls
      // back. This closes the read-then-write race where two returns
      // could each pass the pre-check and jointly overdraw.
      const updated = await tx.vendorMetalBalance.update({
        where: { id: balance.id },
        data: { balanceWeight: { decrement: weight } },
      });
      const newBal = r3(Number(updated.balanceWeight));
      if (newBal < 0) {
        throw new BadRequestException(
          `Return exceeds advance balance under concurrent activity (final balance ${newBal.toFixed(3)} g).`,
        );
      }
      // Lot roll-back: reduce vendor's per-lot holding + credit the lot's
      // remaining balance. Only when a lot is explicitly bound.
      if (sourceLot) {
        await tx.vendorLotHolding.update({
          where: { vendorId_lotId: { vendorId: dto.vendorId, lotId: sourceLot.id } },
          data: { weightG: { decrement: weight } },
        });
        await tx.silverLot.update({
          where: { id: sourceLot.id },
          data: { remainingWeightG: { increment: weight } },
        });
      }
      const ledger = await tx.vendorMetalLedger.create({
        data: {
          vendorId: dto.vendorId, variantId: dto.variantId,
          eventType: 'RETURN_TO_ADVANCE',
          weight: -weight, balanceAfter: newBal,
          refType: 'return', refId: balance.id,
          sourceLotId: sourceLot?.id ?? null,
          note: dto.note ?? null, createdById: userId ?? null,
        } as any,
      });

      const variant = await tx.materialVariant.update({
        where: { id: dto.variantId },
        data: { stockWeight: { increment: weight } },
      });
      const newStockWt = r3(Number(variant.stockWeight));
      await tx.stockMovement.create({
        data: {
          variantId: dto.variantId, type: 'IN',
          quantity: 0, balanceAfter: Number(variant.stockQty),
          weight: weight, balanceWeightAfter: newStockWt,
          refType: 'vendor_advance_return', refId: dto.vendorId,
          note: `Return from vendor ${balance.vendor.vendorCode}${dto.note ? ' · ' + dto.note : ''}`,
          createdById: userId ?? null,
        } as any,
      });

      return { ledgerId: ledger.id, balanceWeight: newBal };
    });
  }

  /** Manual adjust — signed delta with a mandatory note. */
  async adjust(
    dto: { vendorId: number; variantId: number; weight: number; note: string },
    userId?: number,
  ) {
    const weight = r3(Number(dto.weight ?? 0));
    if (weight === 0) throw new BadRequestException('Adjustment weight must be non-zero.');
    if (!dto.note?.trim()) throw new BadRequestException('Adjustments require a note (audit trail).');

    return this.prisma.$transaction(async (tx) => {
      // Atomic increment (positive OR negative delta) — race-safe. Post-
      // update balance is read from the returned row; a negative result
      // throws to roll the whole transaction back.
      const bal = await tx.vendorMetalBalance.upsert({
        where: { vendorId_variantId: { vendorId: dto.vendorId, variantId: dto.variantId } },
        update: { balanceWeight: { increment: weight } },
        create: { vendorId: dto.vendorId, variantId: dto.variantId, balanceWeight: weight },
      });
      const newBal = r3(Number(bal.balanceWeight));
      if (newBal < 0) {
        throw new BadRequestException('Adjustment would push balance below zero.');
      }
      const ledger = await tx.vendorMetalLedger.create({
        data: {
          vendorId: dto.vendorId, variantId: dto.variantId,
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
   * Edit a ledger entry's weight + note. Allowed only for entries the
   * operator entered by hand (ALLOCATE_ADVANCE, RETURN_TO_ADVANCE,
   * ADJUST). Production-linked entries (DRAW_INTO_BATCH) require editing
   * the source receipt because they touch stock movements + lot draws
   * too — unwinding them here would leave orphaned effects.
   *
   * Applies the DELTA (new - old) to both the vendor balance and (for
   * allocate/return) the main-stock weight so books stay in sync. Ledger
   * balanceAfter is NOT retroactively recomputed for earlier rows — it's
   * a historical snapshot; a new "adjust" row can be posted instead if
   * a strict reconciled trail is needed later.
   */
  async updateLedger(id: number, dto: { weight: number; note?: string }, userId?: number) {
    const entry = await this.prisma.vendorMetalLedger.findUnique({
      where: { id },
      include: { variant: true, vendor: true },
    });
    if (!entry) throw new NotFoundException('Ledger entry not found.');
    if (entry.eventType === 'DRAW_INTO_BATCH') {
      throw new BadRequestException('Production draws are linked to receipts — edit the source receipt instead.');
    }
    const newWeight = r3(Number(dto.weight ?? 0));
    if (newWeight === 0) throw new BadRequestException('Weight cannot be zero.');
    // Keep the SIGN of the original entry (allocate = +, return = -).
    // Operators shouldn't accidentally flip a return into an allocation
    // just by typing a positive number.
    const oldSigned = Number(entry.weight);
    const newSigned = oldSigned >= 0 ? Math.abs(newWeight) : -Math.abs(newWeight);
    const delta = r3(newSigned - oldSigned);

    return this.prisma.$transaction(async (tx) => {
      // Balance shifts by the delta (positive delta credits the vendor).
      const bal = await tx.vendorMetalBalance.update({
        where: { vendorId_variantId: { vendorId: entry.vendorId, variantId: entry.variantId } },
        data: { balanceWeight: { increment: delta } },
      });
      const newBal = r3(Number(bal.balanceWeight));
      if (newBal < 0) throw new BadRequestException('Edit would push vendor balance below zero.');

      // For allocate / return, the main-stock ledger also has a mirror
      // movement. Keeping the audit stock-movement in sync would need us
      // to find that row + update it — for now we post a corrective
      // movement so the ledger stays honest instead of silently drifting.
      if (entry.eventType === 'ALLOCATE_ADVANCE' || entry.eventType === 'RETURN_TO_ADVANCE') {
        const variant = entry.variant;
        // Allocate delta: main stock moves DOWN by delta (more given out).
        // Return delta: main stock moves UP by delta (more coming back).
        const stockDelta = entry.eventType === 'ALLOCATE_ADVANCE' ? -delta : delta;
        if (Math.abs(stockDelta) > 0.0005) {
          const nextStock = r3(Number(variant.stockWeight) + stockDelta);
          if (nextStock < 0) throw new BadRequestException('Edit would push main stock below zero.');
          await tx.materialVariant.update({ where: { id: variant.id }, data: { stockWeight: nextStock } });
          await tx.stockMovement.create({
            data: {
              variantId: variant.id, type: stockDelta > 0 ? 'IN' : 'OUT',
              quantity: 0, balanceAfter: Number(variant.stockQty),
              weight: stockDelta, balanceWeightAfter: nextStock,
              refType: 'vendor_advance_edit', refId: entry.id,
              note: `Edit of ledger #${entry.id}`,
              createdById: userId ?? null,
            } as any,
          });
        }
      }

      const updated = await tx.vendorMetalLedger.update({
        where: { id },
        data: {
          weight: newSigned,
          balanceAfter: newBal,
          note: dto.note?.trim() ?? entry.note,
        },
      });
      await this.audit.log(userId, {
        action: 'vendor-advances.updateLedger',
        targetType: 'VendorMetalLedger',
        targetId: id,
        description: `Edited ledger #${id}: ${oldSigned} g → ${newSigned} g`,
      });
      return updated;
    });
  }

  /**
   * Hard-delete a ledger entry + unwind its balance effect. Same rules
   * as updateLedger — production draws are off-limits (edit the source
   * receipt). The row is removed rather than negated so the ledger stays
   * clean for manually-entered mistakes (typo, wrong vendor, etc.).
   */
  async deleteLedger(id: number, userId?: number) {
    const entry = await this.prisma.vendorMetalLedger.findUnique({
      where: { id },
      include: { variant: true },
    });
    if (!entry) throw new NotFoundException('Ledger entry not found.');
    if (entry.eventType === 'DRAW_INTO_BATCH') {
      throw new BadRequestException('Production draws are linked to receipts — delete via the source receipt.');
    }
    const signed = Number(entry.weight); // + for allocate, − for return

    return this.prisma.$transaction(async (tx) => {
      // Unwind the balance impact.
      const bal = await tx.vendorMetalBalance.update({
        where: { vendorId_variantId: { vendorId: entry.vendorId, variantId: entry.variantId } },
        data: { balanceWeight: { decrement: signed } },
      });
      const newBal = r3(Number(bal.balanceWeight));
      if (newBal < 0) throw new BadRequestException('Cannot delete — remaining ledger would go negative.');

      // Mirror unwind on main stock for allocate / return entries.
      if (entry.eventType === 'ALLOCATE_ADVANCE' || entry.eventType === 'RETURN_TO_ADVANCE') {
        const variant = entry.variant;
        // Allocate deleted: metal comes BACK to main stock (+).
        // Return deleted: metal LEAVES main stock again (−).
        const stockDelta = entry.eventType === 'ALLOCATE_ADVANCE' ? Math.abs(signed) : -Math.abs(signed);
        const nextStock = r3(Number(variant.stockWeight) + stockDelta);
        if (nextStock < 0) throw new BadRequestException('Unwind would push main stock below zero.');
        await tx.materialVariant.update({ where: { id: variant.id }, data: { stockWeight: nextStock } });
        await tx.stockMovement.create({
          data: {
            variantId: variant.id, type: stockDelta > 0 ? 'IN' : 'OUT',
            quantity: 0, balanceAfter: Number(variant.stockQty),
            weight: stockDelta, balanceWeightAfter: nextStock,
            refType: 'vendor_advance_delete', refId: entry.id,
            note: `Deletion of ledger #${entry.id}`,
            createdById: userId ?? null,
          } as any,
        });
      }

      // If a lot was tagged, credit its remaining balance back + decrement
      // the vendor's holding on that lot (both mirror what allocate did).
      if (entry.sourceLotId && entry.eventType === 'ALLOCATE_ADVANCE') {
        await tx.silverLot.update({
          where: { id: entry.sourceLotId },
          data: { remainingWeightG: { increment: Math.abs(signed) } },
        });
        await tx.vendorLotHolding.updateMany({
          where: { vendorId: entry.vendorId, lotId: entry.sourceLotId },
          data: { weightG: { decrement: Math.abs(signed) } },
        });
      }

      await tx.vendorMetalLedger.delete({ where: { id } });
      await this.audit.log(userId, {
        action: 'vendor-advances.deleteLedger',
        targetType: 'VendorMetalLedger',
        targetId: id,
        description: `Deleted ledger #${id}: ${signed} g (${entry.eventType})`,
      });
      return { id, balanceAfter: newBal };
    });
  }

  /**
   * Helper used by batch-issue (Phase 4 wiring into casting.service):
   * draw `weight` g from a vendor's advance into a batch stage. Caller
   * must already have validated balance >= weight.
   */
  async drawIntoBatch(
    tx: any,
    args: { vendorId: number; variantId: number; weight: number; stageId: number; batchId?: number; userId?: number },
  ) {
    const weight = r3(args.weight);
    if (weight <= 0) return null;
    // Atomic decrement — final balance is what actually ended up in the
    // row after the UPDATE; negative means we lost a race and must roll
    // the outer transaction back.
    const current = await tx.vendorMetalBalance.findUnique({
      where: { vendorId_variantId: { vendorId: args.vendorId, variantId: args.variantId } },
    });
    if (!current) {
      throw new BadRequestException(
        `Vendor has no metal advance for this variant — cannot draw ${weight.toFixed(3)} g for stage ${args.stageId}.`,
      );
    }
    const updated = await tx.vendorMetalBalance.update({
      where: { id: current.id },
      data: { balanceWeight: { decrement: weight } },
    });
    const newBal = r3(Number(updated.balanceWeight));
    if (newBal < 0) {
      throw new BadRequestException(
        `Vendor advance would go negative under concurrent draw (final ${newBal.toFixed(3)} g).`,
      );
    }
    return tx.vendorMetalLedger.create({
      data: {
        vendorId: args.vendorId, variantId: args.variantId,
        eventType: 'DRAW_INTO_BATCH',
        weight: -weight, balanceAfter: newBal,
        refType: 'casting_batch_item', refId: args.stageId,
        note: `Draw into batch ${args.batchId ?? ''} stage ${args.stageId}`.trim(),
        createdById: args.userId ?? null,
      },
    });
  }
}
