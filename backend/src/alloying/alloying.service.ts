import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { nextCode } from '../common/code-generator';

/**
 * Alloying — the 999 → 93.5 silver conversion. One batch = one melt.
 *
 * On MELTED status:
 *   inputs   → decrement each input variant's stockWeight (999 + copper)
 *   outputs  → increment ALLOY + RUNNERS variants; LOSS has no stock impact
 *
 * Weight balance:
 *   sum(inputs) = sum(outputs including LOSS)
 * If the operator's numbers don't balance we accept the discrepancy and
 * post the difference as LOSS silently (jewellers' rule: "the scale is
 * always right"). We do NOT block on imbalance — melting is imprecise
 * by nature. See project_erp_roadmap_2026-07 for background.
 */
@Injectable()
export class AlloyingService {
  constructor(private prisma: PrismaService) {}

  private r3(n: number) { return Math.round(n * 1000) / 1000; }

  async list() {
    return this.prisma.alloyingBatch.findMany({
      include: {
        inputs:  { include: { variant: { select: { variantCode: true, variantName: true } } } },
        outputs: { include: { variant: { select: { variantCode: true, variantName: true } } } },
      },
      orderBy: { batchDate: 'desc' },
      take: 200,
    });
  }

  async findOne(id: number) {
    const b = await this.prisma.alloyingBatch.findUnique({
      where: { id },
      include: {
        inputs:  { include: { variant: true } },
        outputs: { include: { variant: true } },
      },
    });
    if (!b) throw new NotFoundException('Alloying batch not found.');
    return b;
  }

  async createDraft(
    dto: { batchDate: string; notes?: string },
    userId?: number,
  ) {
    const count = await this.prisma.alloyingBatch.count();
    const batchNumber = 'ALY' + String(count + 1).padStart(4, '0');
    return this.prisma.alloyingBatch.create({
      data: {
        batchNumber,
        batchDate: new Date(dto.batchDate),
        notes: dto.notes ?? null,
        createdById: userId ?? null,
      },
    });
  }

  /**
   * Save inputs / outputs on a DRAFT batch. Idempotent — replaces prior
   * rows. Balance is NOT enforced; the "melted" step is where stock moves.
   */
  async saveLines(
    id: number,
    dto: {
      inputs:  Array<{ variantId: number; weightG: number; notes?: string }>;
      outputs: Array<{ kind: 'ALLOY' | 'RUNNERS' | 'LOSS'; variantId?: number; weightG: number; notes?: string }>;
    },
  ) {
    const batch = await this.findOne(id);
    if (batch.status !== 'DRAFT') {
      throw new BadRequestException('Only DRAFT batches can be edited. Melted batches are final.');
    }
    await this.prisma.$transaction([
      this.prisma.alloyingBatchInput.deleteMany({ where: { batchId: id } }),
      this.prisma.alloyingBatchOutput.deleteMany({ where: { batchId: id } }),
      this.prisma.alloyingBatchInput.createMany({
        data: dto.inputs
          .filter((r) => r.variantId && Number(r.weightG) > 0)
          .map((r) => ({
            batchId: id,
            variantId: r.variantId,
            weightG: this.r3(r.weightG),
            notes: r.notes ?? null,
          })),
      }),
      this.prisma.alloyingBatchOutput.createMany({
        data: dto.outputs
          .filter((r) => Number(r.weightG) > 0)
          .map((r) => ({
            batchId: id,
            kind: r.kind as any,
            // LOSS has no variant (nothing to stock); ALLOY/RUNNERS require one.
            variantId: r.kind === 'LOSS' ? null : (r.variantId ?? null),
            weightG: this.r3(r.weightG),
            notes: r.notes ?? null,
          })),
      }),
    ]);
    return this.findOne(id);
  }

  /**
   * Melt — commit the batch. Decrements input variants' stockWeight,
   * increments output variants' stockWeight, writes StockMovement rows
   * for auditability. Idempotent guard: only DRAFT can be melted.
   */
  async melt(id: number, userId?: number) {
    const batch = await this.findOne(id);
    if (batch.status !== 'DRAFT') {
      throw new BadRequestException('Batch already melted or cancelled.');
    }
    if (batch.inputs.length === 0) throw new BadRequestException('Add at least one input before melting.');
    if (batch.outputs.filter((o) => o.kind !== 'LOSS').length === 0) {
      throw new BadRequestException('Add at least one non-LOSS output before melting.');
    }

    // Check input stock — reject if any input is short of what we claim
    // to melt (the scale is right, but stock can't go negative).
    for (const inp of batch.inputs) {
      const v = await this.prisma.materialVariant.findUnique({ where: { id: inp.variantId } });
      if (!v) throw new NotFoundException(`Input variant #${inp.variantId} not found.`);
      const need = this.r3(Number(inp.weightG));
      const have = Number(v.stockWeight);
      if (have < need - 0.0005) {
        throw new BadRequestException(
          `Not enough stock for ${v.variantName}: need ${need.toFixed(3)} g, have ${have.toFixed(3)} g.`,
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      // Consume inputs
      for (const inp of batch.inputs) {
        const w = this.r3(Number(inp.weightG));
        const updated = await tx.materialVariant.update({
          where: { id: inp.variantId },
          data: { stockWeight: { decrement: w } },
        });
        await tx.stockMovement.create({
          data: {
            variantId: inp.variantId,
            type: 'OUT',
            quantity: 0,
            balanceAfter: Number(updated.stockQty),
            weight: -w,
            balanceWeightAfter: this.r3(Number(updated.stockWeight)),
            refType: 'alloying_input',
            refId: batch.id,
            note: `Alloying ${batch.batchNumber} · input`,
            createdById: userId ?? null,
          } as any,
        });
      }
      // Produce outputs (ALLOY + RUNNERS; LOSS is bookkeeping only)
      for (const out of batch.outputs) {
        if (out.kind === 'LOSS' || !out.variantId) continue;
        const w = this.r3(Number(out.weightG));
        const updated = await tx.materialVariant.update({
          where: { id: out.variantId },
          data: { stockWeight: { increment: w } },
        });
        await tx.stockMovement.create({
          data: {
            variantId: out.variantId,
            type: 'IN',
            quantity: 0,
            balanceAfter: Number(updated.stockQty),
            weight: w,
            balanceWeightAfter: this.r3(Number(updated.stockWeight)),
            refType: 'alloying_output',
            refId: batch.id,
            note: `Alloying ${batch.batchNumber} · ${out.kind.toLowerCase()}`,
            createdById: userId ?? null,
          } as any,
        });
      }
      await tx.alloyingBatch.update({
        where: { id: batch.id },
        data: { status: 'MELTED' },
      });
    });
    return this.findOne(batch.id);
  }

  async cancel(id: number) {
    const batch = await this.findOne(id);
    if (batch.status !== 'DRAFT') {
      throw new BadRequestException('Only DRAFT batches can be cancelled. Melted batches are final.');
    }
    return this.prisma.alloyingBatch.update({
      where: { id: batch.id },
      data: { status: 'CANCELLED' },
    });
  }

  /**
   * Hard-delete a DRAFT or CANCELLED batch — removes the row plus every
   * input / output line. Never permitted for MELTED batches because the
   * melt already touched stock movements; erasing the row would leave
   * ghost credits/debits. Draft state has no stock impact yet, so a hard
   * delete is safe.
   */
  async hardDelete(id: number) {
    const batch = await this.prisma.alloyingBatch.findUnique({ where: { id } });
    if (!batch) throw new NotFoundException('Alloying batch not found.');
    if (batch.status === 'MELTED') {
      throw new BadRequestException('Melted batches are final — stock movements have been posted.');
    }
    await this.prisma.$transaction([
      this.prisma.alloyingBatchInput.deleteMany({ where: { batchId: id } }),
      this.prisma.alloyingBatchOutput.deleteMany({ where: { batchId: id } }),
      this.prisma.alloyingBatch.delete({ where: { id } }),
    ]);
    return { id, batchNumber: batch.batchNumber };
  }
}
