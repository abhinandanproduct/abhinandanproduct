import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { nextCode } from '../common/code-generator';
import {
  CloseIssueDto,
  CreateMaterialIssueDto,
  RecordReturnDto,
} from './dto/material-issue.dto';

/**
 * Material Issue / Return — the formal record of raw materials going to a vendor
 * (e.g. stones to a sticking karigar) and coming back.
 *
 *   Issued qty:   stock OUT  (deducted from variant stockQty, StockMovement OUT)
 *   Received qty: stock IN   (added back to variant stockQty, StockMovement IN)
 *   Short qty:    closed with a balance the vendor owes us (recorded but no stock change)
 *
 * Vendor holdings = Σ (issuedQty − receivedQty) per (vendor, variant) across open issues.
 */
@Injectable()
export class MaterialIssuesService {
  constructor(private prisma: PrismaService) {}

  /** Voucher number generator — MIV-0001, MIV-0002, … */
  async nextVoucherNumber() {
    const num = await nextCode(this.prisma, 'materialIssue', 'voucherNumber', 'MIV', 4);
    return { voucherNumber: num };
  }

  /** Compute the running status of an issue based on its line totals. */
  private deriveStatus(issued: number, received: number, closed: boolean) {
    if (closed) return 'CLOSED' as const;
    if (received === 0) return 'OPEN' as const;
    if (received >= issued) return 'COMPLETED' as const;
    return 'PARTIAL' as const;
  }

  /** Adjust variant stock + log a StockMovement. Both qty and balance are
   *  forced to WHOLE NUMBERS — no fractional materials anywhere. */
  private async moveStock(
    variantId: number,
    delta: number,
    refType: string,
    refId: number,
    note: string,
    userId?: number,
    weightDelta: number = 0,
  ) {
    const v = await this.prisma.materialVariant.findUnique({ where: { id: variantId } });
    if (!v) throw new NotFoundException(`Variant ${variantId} not found.`);
    const intDelta = Math.trunc(delta);
    const after = Math.max(0, Math.round(Number(v.stockQty)) + intDelta);
    const wDelta = Math.round(Number(weightDelta) * 1000) / 1000;
    const afterWt = Math.max(0, Math.round((Number(v.stockWeight) + wDelta) * 1000) / 1000);
    await this.prisma.$transaction([
      this.prisma.materialVariant.update({
        where: { id: variantId },
        data: { stockQty: after, stockWeight: afterWt },
      }),
      this.prisma.stockMovement.create({
        data: {
          variantId,
          type: intDelta >= 0 && wDelta >= 0 ? 'IN' : 'OUT',
          quantity: intDelta,
          balanceAfter: after,
          weight: wDelta,
          balanceWeightAfter: afterWt,
          refType, refId, note,
          createdById: userId ?? null,
        } as any,
      }),
    ]);
  }

  /**
   * Variant of create() that allows specifying deferredQty per line — used by
   * the casting forward → sticking auto-issue when raw-material stock is short
   * at issue time. Lines are written with `issuedQty + deferredQty = wanted`;
   * only the issuedQty hits stock. When stock arrives later, issueDeferred()
   * tops up the line, decrementing deferredQty and recording the OUT movement.
   */
  async createWithDeferred(
    dto: {
      vendorId: number; batchId?: number; stageId?: number;
      notes?: string; issueDate?: string;
      lines: { variantId: number; issuedQty: number; deferredQty: number; issuedWeight?: number; notes?: string }[];
    },
    userId?: number,
  ) {
    const lines = dto.lines.filter(
      (l) => l.issuedQty > 0 || l.deferredQty > 0 || Number(l.issuedWeight ?? 0) > 0,
    );
    if (!lines.length) return null;

    const voucherNumber = await nextCode(this.prisma, 'materialIssue', 'voucherNumber', 'MIV', 4);
    const issue = await this.prisma.materialIssue.create({
      data: {
        voucherNumber,
        vendorId: dto.vendorId,
        batchId: dto.batchId ?? null,
        stageId: dto.stageId ?? null,
        issueDate: dto.issueDate ? new Date(dto.issueDate) : new Date(),
        notes: dto.notes ?? null,
        createdById: userId ?? null,
        lines: {
          create: lines.map((l) => ({
            variantId: l.variantId,
            issuedQty: l.issuedQty,
            issuedWeight: Math.max(0, Number(l.issuedWeight ?? 0)),
            // Cast through any so the call compiles before `prisma generate`
            // picks up the new deferredQty column. After generate it's a real field.
            ...({ deferredQty: l.deferredQty } as any),
            notes: l.notes ?? null,
          })),
        },
      },
      include: { lines: true },
    });

    // Stock-OUT only for the actually-issued qty + weight. Deferred amount
    // stays on the line until issueDeferred() fires.
    for (const line of issue.lines) {
      const w = Number((line as any).issuedWeight ?? 0);
      if (line.issuedQty > 0 || w > 0) {
        await this.moveStock(
          line.variantId,
          -line.issuedQty,
          'material_issue',
          issue.id,
          `Issued via ${issue.voucherNumber}`,
          userId,
          -w,
        );
      }
    }
    return { id: issue.id, voucherNumber: issue.voucherNumber };
  }

  /**
   * Top up a previously short-issued line — moves the requested qty from the
   * line's deferredQty bucket into its issuedQty bucket, deducting stock now.
   * Called by the "Issue Now" prompt that fires when raw-material stock arrives.
   */
  async issueDeferred(lineId: number, qty: number, userId?: number) {
    const line = await this.prisma.materialIssueLine.findUnique({
      where: { id: lineId },
      include: { issue: true, variant: true },
    });
    if (!line) throw new NotFoundException('Material-issue line not found.');
    const deferred = (line as any).deferredQty ?? 0;
    if (deferred <= 0) throw new BadRequestException('Nothing to issue — no deferred qty on this line.');
    const q = Math.max(0, Math.trunc(qty));
    if (q === 0) throw new BadRequestException('Issue qty must be > 0.');
    if (q > deferred) throw new BadRequestException(`Can issue at most ${deferred} (deferred amount).`);
    // Check available stock.
    const v = await this.prisma.materialVariant.findUnique({ where: { id: line.variantId } });
    const have = Math.round(Number(v?.stockQty ?? 0));
    if (q > have) throw new BadRequestException(`Only ${have} in stock — can't issue ${q}.`);

    await this.prisma.materialIssueLine.update({
      where: { id: lineId },
      data: {
        issuedQty: { increment: q },
        ...({ deferredQty: { decrement: q } } as any),
      },
    });
    await this.moveStock(line.variantId, -q, 'material_issue_deferred', line.issue.id,
      `Deferred issue via ${line.issue.voucherNumber}`, userId);
    return { id: lineId, issued: q, deferredRemaining: deferred - q };
  }

  /**
   * List all material-issue lines that still have unmet demand (deferredQty > 0).
   * Optional `variantId` filter for "after stock IN, who needs this variant now?".
   * The frontend uses this to render the "Issue now to vendor X?" prompt.
   */
  async pendingDemand(variantId?: number) {
    const lines = await this.prisma.materialIssueLine.findMany({
      where: {
        ...({ deferredQty: { gt: 0 } } as any),
        issue: { status: { not: 'CLOSED' } },
        ...(variantId ? { variantId } : {}),
      },
      include: {
        variant: true,
        issue: {
          include: { vendor: true, batch: true, stage: { include: { item: true } } },
        },
      },
    });
    const variantIds = Array.from(new Set(lines.map((l) => l.variantId)));
    const variants = variantIds.length
      ? await this.prisma.materialVariant.findMany({ where: { id: { in: variantIds } } })
      : [];
    const stockById = new Map(variants.map((v) => [v.id, Math.round(Number(v.stockQty))]));
    return lines.map((l) => ({
      lineId: l.id,
      variantId: l.variantId,
      variantCode: l.variant.variantCode,
      variantName: l.variant.variantName,
      unit: l.variant.unit,
      deferredQty: (l as any).deferredQty ?? 0,
      availableStock: stockById.get(l.variantId) ?? 0,
      voucherNumber: l.issue.voucherNumber,
      voucherId: l.issue.id,
      vendorId: l.issue.vendorId,
      vendorCode: l.issue.vendor.vendorCode,
      vendorName: l.issue.vendor.vendorName,
      batchNumber: l.issue.batch?.batchNumber ?? null,
      itemNumber: l.issue.stage?.item?.itemNumber ?? null,
    }));
  }

  /** Create a new material-issue voucher; deducts stock for each line. */
  async create(dto: CreateMaterialIssueDto, userId?: number) {
    if (!dto.lines?.length) throw new BadRequestException('Add at least one material line.');
    const variantIds = Array.from(new Set(dto.lines.map((l) => l.variantId)));
    const variants = await this.prisma.materialVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, trackByQty: true, trackByWeight: true, variantName: true },
    });
    const vById = new Map(variants.map((v) => [v.id, v]));
    for (const l of dto.lines) {
      const v = vById.get(l.variantId);
      if (!v) throw new BadRequestException(`Variant ${l.variantId} not found.`);
      if (v.trackByQty && (!Number.isInteger(l.issuedQty) || l.issuedQty <= 0)) {
        throw new BadRequestException('Issued qty must be a positive whole number.');
      }
      if (v.trackByWeight && (!Number.isFinite(Number(l.issuedWeight)) || Number(l.issuedWeight) <= 0)) {
        throw new BadRequestException(
          `${v.variantName}: weight (g) is required (and must be > 0) for this material.`,
        );
      }
    }

    const voucherNumber = await nextCode(this.prisma, 'materialIssue', 'voucherNumber', 'MIV', 4);
    const issue = await this.prisma.materialIssue.create({
      data: {
        voucherNumber,
        vendorId: dto.vendorId,
        batchId: dto.batchId ?? null,
        stageId: dto.stageId ?? null,
        issueDate: dto.issueDate ? new Date(dto.issueDate) : new Date(),
        notes: dto.notes ?? null,
        createdById: userId ?? null,
        lines: {
          create: dto.lines.map((l) => ({
            variantId: l.variantId,
            issuedQty: l.issuedQty,
            issuedWeight: Math.max(0, Number(l.issuedWeight ?? 0)),
            notes: l.notes ?? null,
          })),
        },
      },
      include: { lines: true },
    });

    // Deduct stock (qty AND weight) for each line.
    for (const line of issue.lines) {
      await this.moveStock(
        line.variantId,
        -line.issuedQty,
        'material_issue',
        issue.id,
        `Issued via ${issue.voucherNumber}`,
        userId,
        -Number(line.issuedWeight ?? 0),
      );
    }
    return { id: issue.id, voucherNumber: issue.voucherNumber };
  }

  /**
   * Record a return / "all used" from the vendor.
   *
   * Per line, two distinct things can happen at receive time:
   *   - returnedQty: vendor physically returned this many — adds back to stock.
   *   - consumedQty: vendor used it but didn't return (waste / extra usage) —
   *                  written off, no stock movement.
   * Both subtract from pending. The voucher's pendingQty = issued − received
   * − consumed.
   */
  async recordReturn(issueId: number, dto: RecordReturnDto, userId?: number) {
    const issue = await this.prisma.materialIssue.findUnique({
      where: { id: issueId },
      include: { lines: true },
    });
    if (!issue) throw new NotFoundException('Material issue not found.');
    if (issue.status === 'CLOSED') throw new BadRequestException('This voucher is closed.');

    // Pull each line's variant tracking flags so weight-tracked materials
    // (filing kadi / pan / tachni / chaki) are validated and posted by both
    // qty AND weight on return.
    const variantIds = Array.from(new Set(issue.lines.map((l) => l.variantId)));
    const variants = await this.prisma.materialVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, trackByQty: true, trackByWeight: true, variantName: true },
    });
    const vById = new Map(variants.map((v) => [v.id, v]));

    // Accumulators across all lines — same idea as the design-side loss /
    // runners on CastingReceiptItem. One IN movement per receipt against the
    // tracker variants instead of per line, so the StockMovement ledger
    // mirrors the voucher / receipt at receive time.
    let totalLoss = 0;
    let totalRunners = 0;

    for (const upd of dto.lines) {
      const line = issue.lines.find((l) => l.id === upd.lineId);
      if (!line) throw new NotFoundException(`Line ${upd.lineId} not on this voucher.`);
      const v = vById.get(line.variantId);
      const ret  = upd.returnedQty ?? 0;
      const cons = upd.consumedQty ?? 0;
      const retW  = Math.max(0, Math.round(Number(upd.returnedWeight ?? 0) * 1000) / 1000);
      const consW = Math.max(0, Math.round(Number(upd.consumedWeight ?? 0) * 1000) / 1000);
      const lostW = Math.round(Number(upd.lostWeight ?? 0) * 1000) / 1000; // signed
      const runW  = Math.max(0, Math.round(Number(upd.runnersWeight ?? 0) * 1000) / 1000);
      if (!Number.isInteger(ret) || ret < 0) {
        throw new BadRequestException('Returned qty must be a non-negative whole number.');
      }
      if (!Number.isInteger(cons) || cons < 0) {
        throw new BadRequestException('Consumed qty must be a non-negative whole number.');
      }
      if (ret === 0 && cons === 0 && retW === 0 && consW === 0 && lostW === 0 && runW === 0) continue;
      const remaining = line.issuedQty - line.receivedQty - ((line as any).consumedQty ?? 0);
      if (ret + cons > remaining) {
        throw new BadRequestException(`Line ${upd.lineId}: only ${remaining} pcs pending — cannot return+use ${ret + cons}.`);
      }
      const issuedW   = Number((line as any).issuedWeight ?? 0);
      const receivedW = Number((line as any).receivedWeight ?? 0);
      const consumedW = Number((line as any).consumedWeight ?? 0);
      const remainingW = Math.round((issuedW - receivedW - consumedW) * 1000) / 1000;
      // received + consumed + loss + runners must reconcile against the
      // weight still pending with the vendor. Loss + runners account for the
      // grams that don't physically come back as either returned material or
      // consumed (used in the design).
      const accountedW = retW + consW + Math.max(0, lostW) + runW;
      if (accountedW > remainingW + 0.0005) {
        throw new BadRequestException(
          `${v?.variantName ?? `Line ${upd.lineId}`}: weights total ${accountedW} g but only ${remainingW} g pending with vendor.`,
        );
      }
      // Weight-tracked variants → user MUST account for the weight too (a
      // piece of kadi can come back light from filing — loss + runners
      // close the gap).
      if (v?.trackByWeight && (ret > 0 || cons > 0) && accountedW === 0) {
        throw new BadRequestException(
          `${v.variantName}: weight (g) is required — fill in used/back/runners/loss.`,
        );
      }
      const data: any = {};
      if (ret  > 0) data.receivedQty = { increment: ret };
      if (cons > 0) data.consumedQty = { increment: cons };
      if (retW  > 0) data.receivedWeight = { increment: retW };
      if (consW > 0) data.consumedWeight = { increment: consW };
      if (lostW !== 0) data.lostWeight    = { increment: lostW };
      if (runW   > 0)  data.runnersWeight = { increment: runW };
      await this.prisma.materialIssueLine.update({ where: { id: line.id }, data });
      if (ret > 0 || retW > 0) {
        await this.moveStock(line.variantId, ret, 'material_issue_return', issue.id,
          `Returned via ${issue.voucherNumber}`, userId, retW);
      }
      totalLoss += lostW;
      totalRunners += runW;
      // consumedQty / consumedWeight have NO stock movement — the vendor used
      // these in production, so they're not coming back into our raw-material
      // inventory.
    }

    // Post the aggregated loss / runners into the dedicated tracker
    // variants. Same pattern as createReceipt's design-side loss/runners
    // posting in casting.service.ts: silent-skip when the tracker variant
    // hasn't been seeded (admin deleted it / pre-silver-seed DB).
    if (totalLoss !== 0) {
      const lossVariant = await this.prisma.materialVariant.findUnique({
        where: { variantCode: 'LOSS-SILVER' },
      });
      if (lossVariant) {
        const newBal = Math.round((Number(lossVariant.stockWeight) + totalLoss) * 1000) / 1000;
        await this.prisma.$transaction([
          this.prisma.materialVariant.update({
            where: { id: lossVariant.id },
            data: { stockWeight: newBal },
          }),
          this.prisma.stockMovement.create({
            data: {
              variantId: lossVariant.id,
              type: totalLoss >= 0 ? 'IN' : 'OUT',
              quantity: 0,
              balanceAfter: Number(lossVariant.stockQty),
              weight: Math.round(totalLoss * 1000) / 1000,
              balanceWeightAfter: newBal,
              refType: 'material_loss_return',
              refId: issue.id,
              note: `Material loss on return ${issue.voucherNumber}`,
              createdById: userId ?? null,
            } as any,
          }),
        ]);
      }
    }
    if (totalRunners > 0) {
      const runnersVariant = await this.prisma.materialVariant.findUnique({
        where: { variantCode: 'RUNNERS-SILVER' },
      });
      if (runnersVariant) {
        const newBal = Math.round((Number(runnersVariant.stockWeight) + totalRunners) * 1000) / 1000;
        await this.prisma.$transaction([
          this.prisma.materialVariant.update({
            where: { id: runnersVariant.id },
            data: { stockWeight: newBal },
          }),
          this.prisma.stockMovement.create({
            data: {
              variantId: runnersVariant.id,
              type: 'IN',
              quantity: 0,
              balanceAfter: Number(runnersVariant.stockQty),
              weight: Math.round(totalRunners * 1000) / 1000,
              balanceWeightAfter: newBal,
              refType: 'material_runners_return',
              refId: issue.id,
              note: `Material runners on return ${issue.voucherNumber}`,
              createdById: userId ?? null,
            } as any,
          }),
        ]);
      }
    }

    // Recompute issue-level status. "Completed" now means received + consumed
    // accounts for everything issued — nothing left pending with the vendor.
    const lines = await this.prisma.materialIssueLine.findMany({ where: { issueId: issue.id } });
    const totalIssued = lines.reduce((s, l) => s + l.issuedQty, 0);
    const totalAccounted = lines.reduce((s, l) => s + l.receivedQty + ((l as any).consumedQty ?? 0), 0);
    await this.prisma.materialIssue.update({
      where: { id: issue.id },
      data: { status: this.deriveStatus(totalIssued, totalAccounted, false) },
    });
    if (dto.notes) {
      await this.prisma.materialIssue.update({ where: { id: issue.id }, data: { notes: dto.notes } });
    }
    return { id: issue.id };
  }

  /**
   * Close the issue — for stage-linked vouchers, the expected consumption (BOM × stage
   * qty) is the legitimate "used" amount; only the qty NEITHER returned NOR consumed
   * is short. For manual issues we treat anything unreturned as short.
   */
  async close(issueId: number, dto: CloseIssueDto) {
    const issue = await this.prisma.materialIssue.findUnique({
      where: { id: issueId },
      include: { lines: true, stage: true },
    });
    if (!issue) throw new NotFoundException('Material issue not found.');
    if (issue.status === 'CLOSED') return { id: issue.id };

    const snap: any[] = Array.isArray(issue.stage?.bomSnapshot) ? (issue.stage!.bomSnapshot as any[]) : [];
    const expectedByVariant = new Map<number, number>();
    for (const s of snap) if (s?.variantId) expectedByVariant.set(s.variantId, Number(s.required ?? 0));

    for (const l of issue.lines) {
      const expected = expectedByVariant.get(l.variantId) ?? 0;
      const short = expected > 0
        ? Math.max(l.issuedQty - l.receivedQty - expected, 0)  // sticking: short = excess unreturned beyond consumption
        : Math.max(l.issuedQty - l.receivedQty, 0);            // manual: everything unreturned is short
      await this.prisma.materialIssueLine.update({ where: { id: l.id }, data: { shortQty: short } });
    }
    await this.prisma.materialIssue.update({
      where: { id: issue.id },
      data: { status: 'CLOSED', closedAt: new Date(), notes: dto?.reason ?? issue.notes },
    });
    return { id: issue.id };
  }

  /** Delete an issue — reverses the stock movements (only allowed for OPEN issues). */
  async remove(issueId: number, userId?: number) {
    const issue = await this.prisma.materialIssue.findUnique({
      where: { id: issueId },
      include: { lines: true },
    });
    if (!issue) throw new NotFoundException('Material issue not found.');
    if (issue.status === 'CLOSED') throw new BadRequestException('Cannot delete a closed voucher.');
    if (issue.lines.some((l) => l.receivedQty > 0)) {
      throw new BadRequestException('Cannot delete a voucher with returns recorded; close it instead.');
    }
    // Reverse the original OUT for each line.
    for (const l of issue.lines) {
      await this.moveStock(l.variantId, l.issuedQty, 'material_issue_delete', issue.id,
        `Reversed delete of ${issue.voucherNumber}`, userId);
    }
    await this.prisma.materialIssue.delete({ where: { id: issue.id } });
    return { id: issue.id };
  }

  async list(params?: { vendorId?: number; status?: string }) {
    const where: any = {};
    if (params?.vendorId) where.vendorId = Number(params.vendorId);
    if (params?.status) where.status = params.status;
    const rows = await this.prisma.materialIssue.findMany({
      where,
      include: { vendor: true, lines: { include: { variant: true } }, batch: true },
      orderBy: { id: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      voucherNumber: r.voucherNumber,
      vendorId: r.vendorId,
      vendorCode: r.vendor.vendorCode,
      vendorName: r.vendor.vendorName,
      batchNumber: r.batch?.batchNumber ?? null,
      stageId: r.stageId,
      issueDate: r.issueDate,
      status: r.status,
      notes: r.notes,
      totalIssued: r.lines.reduce((s, l) => s + l.issuedQty, 0),
      totalReceived: r.lines.reduce((s, l) => s + l.receivedQty, 0),
      // New (slips folder): total qty the vendor consumed in production
      // (written off — they used it, didn't return). Used by the page's
      // "Used" column and to compute the per-vendor "Owed/Short" total
      // (= issued − received − consumed).
      totalConsumed: r.lines.reduce((s, l) => s + ((l as any).consumedQty ?? 0), 0),
      totalShort: r.lines.reduce((s, l) => s + (l.shortQty ?? 0), 0),
      lineCount: r.lines.length,
    }));
  }

  async get(id: number) {
    const r = await this.prisma.materialIssue.findUnique({
      where: { id },
      include: {
        vendor: true,
        batch: true,
        lines: { include: { variant: true } },
        // receiptRows needed so we know how many sticking pcs have actually
        // been received — "used" materials are gated on that, not on the
        // stage's ordered qty (vendor hasn't consumed anything until they
        // actually finish the work and we receive it back).
        stage: { include: { item: true, stageProcess: true, receiptRows: true } },
      },
    });
    if (!r) throw new NotFoundException('Material issue not found.');

    // For stage-linked vouchers (sticking auto-issue) we know the BOM per
    // piece from the immutable snapshot. Per-piece is rounded to a whole
    // number — no fractional stones/bits.
    const snap: any[] = Array.isArray(r.stage?.bomSnapshot) ? (r.stage!.bomSnapshot as any[]) : [];
    const perPieceByVariant = new Map<number, number>();
    for (const s of snap) {
      if (!s?.variantId) continue;
      // Prefer perPiece; fall back to required ÷ stageQty for older snapshots.
      const pp = s.perPiece != null
        ? Number(s.perPiece)
        : (r.stage?.quantity ? Number(s.required ?? 0) / r.stage.quantity : 0);
      perPieceByVariant.set(s.variantId, Math.round(pp));
    }

    // How many sticking pieces from this stage have actually been received
    // back? Until that's > 0, no materials are considered "used" — they're
    // sitting with the vendor (the vendor hasn't built anything yet).
    const stickingReceived = (r.stage?.receiptRows ?? []).reduce((s, x) => s + x.receivedQty, 0);

    const usage = r.stage
      ? {
          stageId: r.stage.id,
          batchNumber: r.batch?.batchNumber ?? null,
          itemNumber: r.stage.item?.itemNumber ?? null,
          designCode: r.stage.item?.sampleDesignCode ?? null,
          processName: r.stage.stageProcess?.name ?? null,
          color: r.stage.color ?? null,
          stageQty: r.stage.quantity,
          stickingReceived,
        }
      : null;

    return {
      id: r.id,
      voucherNumber: r.voucherNumber,
      vendor: { id: r.vendor.id, vendorCode: r.vendor.vendorCode, vendorName: r.vendor.vendorName },
      batchId: r.batchId,
      batchNumber: r.batch?.batchNumber ?? null,
      stageId: r.stageId,
      issueDate: r.issueDate,
      status: r.status,
      notes: r.notes,
      usage,
      lines: r.lines.map((l) => {
        const perPiece = perPieceByVariant.get(l.variantId) ?? 0;
        const explicitlyConsumed = (l as any).consumedQty ?? 0;
        // Implicit "used" = BOM-per-piece × sticking pcs received back. The
        // EXPLICIT consumedQty (user marked "all used" at receive time) is
        // separately tracked; together they cap at issued − received so total
        // accounted never exceeds outstanding.
        const implicitUsed = Math.max(0, perPiece * stickingReceived);
        const used = Math.min(implicitUsed + explicitlyConsumed, l.issuedQty - l.receivedQty);
        // Pending = still with the vendor (not received, not consumed).
        const pending = Math.max(l.issuedQty - l.receivedQty - explicitlyConsumed, 0);
        // Total expected consumption (for the "Close Short" math).
        const expected = perPiece * (r.stage?.quantity ?? 0);
        return {
          id: l.id,
          variantId: l.variantId,
          variantCode: l.variant.variantCode,
          variantName: l.variant.variantName,
          unit: l.variant.unit,
          issuedQty: l.issuedQty,
          receivedQty: l.receivedQty,
          consumedQty: explicitlyConsumed,
          expectedConsumed: Math.round(expected),
          usedQty: Math.round(used),
          pendingQty: Math.round(pending),
          shortQty: l.shortQty ?? null,
          notes: l.notes,
        };
      }),
    };
  }

  /** PDF data — either the initial issue voucher or a current status / return slip. */
  async pdfData(id: number, mode: 'ISSUE' | 'STATUS' = 'STATUS') {
    const detail: any = await this.get(id);
    return {
      mode,
      voucherNumber: detail.voucherNumber,
      issueDate: detail.issueDate,
      vendor: { vendorCode: detail.vendor.vendorCode, vendorName: detail.vendor.vendorName },
      batchNumber: detail.batchNumber,
      notes: detail.notes,
      status: detail.status,
      usage: detail.usage,
      lines: detail.lines.map((l: any) => ({
        variantCode: l.variantCode,
        variantName: l.variantName,
        unit: l.unit,
        issuedQty: l.issuedQty,
        usedQty: l.usedQty,
        receivedQty: l.receivedQty,
        pendingQty: l.pendingQty,
        shortQty: l.shortQty,
        notes: l.notes,
      })),
    };
  }

  /**
   * Record a vendor return across ALL their open vouchers in one shot — the
   * holdings card calls this so the user doesn't have to open each voucher
   * one by one when a vendor returns leftover stones from several jobs at once.
   *
   * Distribution: FIFO by issue date. If the vendor holds 200 of variant X
   * across two vouchers (150 from MIV0003 and 50 from MIV0007), returning
   * 180 fills MIV0003 completely and clears 30 of MIV0007. Stock goes back
   * in proportionally, status on each voucher is recomputed.
   */
  async returnFromVendor(
    vendorId: number,
    items: { variantId: number; returnedQty: number }[],
    userId?: number,
  ) {
    if (!items?.length) throw new BadRequestException('Nothing to return.');
    for (const i of items) {
      if (!Number.isInteger(i.returnedQty) || i.returnedQty <= 0) {
        throw new BadRequestException('Returned qty must be a positive whole number.');
      }
    }

    const affectedIssueIds = new Set<number>();
    const summary: { variantId: number; returned: number; allocations: { voucherNumber: string; qty: number }[] }[] = [];

    for (const item of items) {
      // FIFO across ALL the vendor's vouchers (OPEN, PARTIAL, AND short-closed
      // CLOSED) for this variant. Short-closed vouchers were excluded before,
      // which meant once the user force-closed a voucher with shortQty > 0
      // and the vendor LATER returned the missing pcs, there was nowhere to
      // record the late return. Including closed vouchers lets returns flow
      // in; their CLOSED status is preserved (user's close decision stands)
      // but the line's receivedQty + shortQty are reconciled.
      const issues = await this.prisma.materialIssue.findMany({
        where: {
          vendorId,
          lines: { some: { variantId: item.variantId } },
        },
        include: { lines: { where: { variantId: item.variantId } } },
        orderBy: { issueDate: 'asc' },
      });
      const eligibleLines: { issue: typeof issues[number]; line: typeof issues[number]['lines'][number]; pending: number }[] = [];
      for (const issue of issues) {
        for (const line of issue.lines) {
          // Pending excludes consumed (vendor used and wrote off) — they're
          // gone, can't be returned. Short-closed lines still have pending
          // = issued − received − consumed > 0; that's the qty vendor owes.
          const pending = line.issuedQty - line.receivedQty - ((line as any).consumedQty ?? 0);
          if (pending > 0) eligibleLines.push({ issue, line, pending });
        }
      }
      const totalHeld = eligibleLines.reduce((s, x) => s + x.pending, 0);
      if (item.returnedQty > totalHeld) {
        throw new BadRequestException(
          `Cannot return ${item.returnedQty} — vendor only holds ${totalHeld} of this material.`,
        );
      }

      let remaining = item.returnedQty;
      const allocations: { voucherNumber: string; qty: number }[] = [];
      for (const { issue, line, pending } of eligibleLines) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, pending);
        // For short-closed vouchers, also decrement shortQty by the same
        // amount so the "owed" total reduces in step with the return.
        // For OPEN/PARTIAL vouchers shortQty is null/0 → no-op.
        const lineUpdate: any = { receivedQty: { increment: take } };
        if ((line.shortQty ?? 0) > 0) {
          lineUpdate.shortQty = { decrement: Math.min(take, line.shortQty ?? 0) };
        }
        await this.prisma.materialIssueLine.update({
          where: { id: line.id },
          data: lineUpdate,
        });
        await this.moveStock(
          line.variantId, take, 'material_issue_return', issue.id,
          `Vendor return → ${issue.voucherNumber} (bulk vendor-return)`, userId,
        );
        affectedIssueIds.add(issue.id);
        allocations.push({ voucherNumber: issue.voucherNumber, qty: take });
        remaining -= take;
      }
      summary.push({ variantId: item.variantId, returned: item.returnedQty, allocations });
    }

    // Recompute status on every affected voucher.
    if (affectedIssueIds.size) {
      const allIssues = await this.prisma.materialIssue.findMany({
        where: { id: { in: Array.from(affectedIssueIds) } },
        include: { lines: true },
      });
      for (const i of allIssues) {
        const totalIssued = i.lines.reduce((s, l) => s + l.issuedQty, 0);
        const totalReceived = i.lines.reduce((s, l) => s + l.receivedQty, 0);
        await this.prisma.materialIssue.update({
          where: { id: i.id },
          data: { status: this.deriveStatus(totalIssued, totalReceived, i.status === 'CLOSED') },
        });
      }
    }

    return { items: summary };
  }

  /**
   * What raw materials each vendor is currently owed/holding. INCLUDES
   * short-closed vouchers so the vendor still appears with the qty they
   * never returned — without this, force-closing a short voucher made
   * the vendor disappear from holdings even though they physically owed
   * us material. Pending = issuedQty − receivedQty − consumedQty regardless
   * of status; short-closed vouchers contribute their short qty here so
   * the user can still hit "Return Materials" if pcs turn up later.
   */
  async vendorHoldings(vendorId?: number) {
    const issues = await this.prisma.materialIssue.findMany({
      where: vendorId ? { vendorId } : {},
      include: { vendor: true, lines: { include: { variant: true } } },
    });
    type Holding = {
      vendorId: number; vendorCode: string; vendorName: string;
      variantId: number; variantCode: string; variantName: string;
      unit: string | null; qty: number; vouchers: string[];
    };
    const map = new Map<string, Holding>();
    for (const i of issues) {
      for (const l of i.lines) {
        // Holdings only count what the vendor PHYSICALLY still has — explicit
        // consumed (vendor used and wrote off) is no longer holding.
        const pending = l.issuedQty - l.receivedQty - ((l as any).consumedQty ?? 0);
        if (pending <= 0) continue;
        const key = `${i.vendorId}:${l.variantId}`;
        const h = map.get(key) ?? {
          vendorId: i.vendorId, vendorCode: i.vendor.vendorCode, vendorName: i.vendor.vendorName,
          variantId: l.variantId, variantCode: l.variant.variantCode, variantName: l.variant.variantName,
          unit: l.variant.unit, qty: 0, vouchers: [] as string[],
        };
        h.qty += pending;
        if (!h.vouchers.includes(i.voucherNumber)) h.vouchers.push(i.voucherNumber);
        map.set(key, h);
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      a.vendorName.localeCompare(b.vendorName) || a.variantName.localeCompare(b.variantName),
    );
  }
}
