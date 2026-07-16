import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { nextCode } from '../common/code-generator';
import { KG_PROCESSES, COLOUR_PROCESSES } from '../processes/processes.service';
import { MaterialIssuesService } from '../material-issues/material-issues.service';
import { AuditService } from '../audit/audit.service';
import {
  BatchQueryDto,
  CastingBatchItemDto,
  CreateBatchDto,
  CreateReceiptDto,
  ForwardStageDto,
  UpdateStageDto,
  ReceiptQueryDto,
} from './dto/casting.dto';

@Injectable()
export class CastingService {
  private readonly logger = new Logger(CastingService.name);

  constructor(
    private prisma: PrismaService,
    private materialIssues: MaterialIssuesService,
    private audit: AuditService,
  ) {
    // Register casting-specific undo handlers — each reuses an existing
    // service method that already implements safe reversal with all the
    // right guards (no receipts, no children, etc.). Audit log layer
    // dispatches via `undoStrategy` name; we wire the names → methods
    // here.
    this.audit.registerUndo('casting.stage.update', async (log, actorUserId, actorRole) => {
      // Edit-Stage undo — revert vendor/qty/weight/rate/colour/purpose/remarks
      // to whatever they were before. Skips fields a child stage isn't
      // allowed to edit (qty when parentItemId != null) the same way
      // updateStage does — by trusting the snapshot. actorRole is
      // forwarded so an admin reversing past the 3h window isn't blocked
      // by the same lock that gates everyone else.
      const before: any = log.snapshotBefore ?? {};
      if (!log.targetId) throw new BadRequestException('Cannot undo — missing stage id.');
      await this.updateStage(log.targetId, {
        vendorId: before.vendorId,
        vendorDesignReference: before.vendorDesignReference ?? undefined,
        quantity: before.quantity,
        weight: before.weight != null ? Number(before.weight) : undefined,
        totalWeight: before.totalWeight != null ? Number(before.totalWeight) : undefined,
        costPerKg: before.costPerKg != null ? Number(before.costPerKg) : undefined,
        color: before.color ?? undefined,
        remarks: before.remarks ?? undefined,
        purpose: before.purpose ?? undefined,
        itemId: before.itemId ?? undefined,
      }, actorUserId ?? undefined, actorRole);
    });
    this.audit.registerUndo('casting.forward', async (log, actorUserId, actorRole) => {
      // Forward undo — remove the child stage. deleteForwardedStage
      // already enforces "no receipts, no children below it, not
      // short-closed". If those fail it throws a friendly message and
      // the audit layer surfaces it to the user.
      if (!log.targetId) throw new BadRequestException('Cannot undo — missing stage id.');
      await this.deleteForwardedStage(log.targetId, actorUserId ?? undefined, actorRole);
    });
    this.audit.registerUndo('casting.receipt.create', async (log) => {
      // Receipt undo — delete the receipt. Existing deleteReceipt
      // already blocks when downstream pieces were forwarded out of
      // the received qty; that protection stays in force here.
      if (!log.targetId) throw new BadRequestException('Cannot undo — missing receipt id.');
      await this.deleteReceipt(log.targetId);
    });
    this.audit.registerUndo('casting.batch.item.close', async (log) => {
      if (!log.targetId) throw new BadRequestException('Cannot undo — missing stage id.');
      await this.reopenBatchItem(log.targetId);
    });
    this.audit.registerUndo('casting.batch.close', async (log) => {
      if (!log.targetId) throw new BadRequestException('Cannot undo — missing batch id.');
      await this.reopenBatch(log.targetId);
    });
    this.audit.registerUndo('casting.batch.addDesign', async (log, actorUserId, actorRole) => {
      // Adding a design back-to-back is just creating a root stage —
      // undo by deleting that stage. The same guards apply (no receipts,
      // no children).
      if (!log.targetId) throw new BadRequestException('Cannot undo — missing stage id.');
      await this.deleteForwardedStage(log.targetId, actorUserId ?? undefined, actorRole);
    });
  }

  /**
   * Auto-sync a typed rate (from batch creation or forward) back into the
   * item's process-vendor master record so the next batch picks it up
   * pre-filled. Two behaviours:
   *
   *   • Master rate is null/0  → fill SILENTLY (no toast). `silent: true`.
   *   • Master rate exists and differs from `newRate` → apply the update
   *     and return the change so the frontend can toast with Undo.
   *     `silent: false, oldRate`.
   *   • Master rate equals newRate → no-op, returns null.
   *
   * Targets the EXPLICIT vendor when provided (the vendor on the batch row /
   * the forward dialog); falls back to the preferred vendor on the
   * itemProcess. Returns null whenever the sync can't apply (no item,
   * no process linkage, no vendor, rate invalid).
   */
  /**
   * Auto-capture batch decisions back to Item Master when the master is
   * blank. Workflow: with 8-10K designs, operators mark items
   * PRODUCTION_READY with bare-minimum data and rely on production work
   * (vendor picks, colour adds, rates, weights) to fill the master
   * progressively. This helper handles the (item × process × vendor × colour)
   * combination — finds or creates ItemProcess, then finds matching
   * vendor row OR adds it. Silent: when master is blank there's nothing
   * to "undo", so no toast — unlike syncProcessRateToItem which surfaces
   * a toast+undo for RATE-only changes against existing rows.
   */
  private async ensureProcessVendor(opts: {
    itemId: number;
    processId: number;
    vendorId: number;
    color?: string | null;
    costPerPiece?: number | null;
    vendorDesignReference?: string | null;
    bringsOwnMaterials?: boolean;
  }): Promise<{ created: boolean; itemProcessVendorId: number } | null> {
    if (!opts.itemId || !opts.processId || !opts.vendorId) return null;
    // Find or create the ItemProcess parent row first — without it the
    // vendor row has no anchor.
    let ip = await this.prisma.itemProcess.findUnique({
      where: { itemId_processId: { itemId: opts.itemId, processId: opts.processId } },
    });
    if (!ip) {
      ip = await this.prisma.itemProcess.create({
        data: { itemId: opts.itemId, processId: opts.processId },
      });
    }
    // Lookup by (vendorId, normalised colour) — null colour matches null
    // colour, "Gold" matches "gold " etc.
    const colorNorm = (opts.color ?? '').trim().toLowerCase();
    const existing = await this.prisma.itemProcessVendor.findMany({
      where: { itemProcessId: ip.id, vendorId: opts.vendorId },
    });
    const match = existing.find(
      (v) => (v.color ?? '').trim().toLowerCase() === colorNorm,
    );
    if (match) {
      // Row exists — rate/ref overwrite is syncProcessRateToItem's job.
      return { created: false, itemProcessVendorId: match.id };
    }
    // First time this (vendor × colour) combo is seen for this item-process
    // — silently CREATE the row. First-ever vendor on a process becomes
    // preferred so the item's cost-resolver has a default to pick.
    const isFirstOnProcess = (
      await this.prisma.itemProcessVendor.count({ where: { itemProcessId: ip.id } })
    ) === 0;
    const created = await this.prisma.itemProcessVendor.create({
      data: {
        itemProcessId: ip.id,
        vendorId: opts.vendorId,
        color: opts.color?.trim() || null,
        vendorDesignReference: opts.vendorDesignReference?.trim() || null,
        costPerPiece: opts.costPerPiece ?? null,
        isPreferred: isFirstOnProcess,
        bringsOwnMaterials: opts.bringsOwnMaterials ?? false,
      },
    });
    return { created: true, itemProcessVendorId: created.id };
  }

  /** Marker text appended to the Casting ItemProcess.notes when the
   *  operator ticks "Casting weight temporary" on a New Batch row. Lives
   *  on the per-process notes (NOT the item-level notes) so it stays
   *  scoped to the Casting step where the weight matters. Drives the
   *  receipt-side "enter final per-pc weight" popup and gets stripped
   *  by finalizeCastingWeight. */
  static readonly TEMP_WEIGHT_MARKER = 'casting weight temporary';

  /** Grace window for batch CONTENT edits (add design, edit stage, delete
   *  stage, edit batch, remove batch). Operator can fix mistakes within
   *  this window without anyone's help. After it expires, only ADMIN can
   *  edit — STAFF / MANAGER get a friendly "ask an admin" error. */
  static readonly BATCH_EDIT_GRACE_HOURS = 3;

  /**
   * Throw a friendly BadRequest when the operator is trying to edit a
   * batch's content past the grace window AND they're not ADMIN. Called
   * from every batch-content mutation that should respect the lock
   * (addBatchDesign, updateBatch, removeBatch, updateStage on a stage
   * belonging to a batch, deleteForwardedStage). Production-flow methods
   * (forwardStage, createReceipt, closeBatchItem, etc.) deliberately
   * skip the check — those are not "edits", they're normal operation.
   *
   * The check window: `now - batch.createdAt > BATCH_EDIT_GRACE_HOURS`.
   * Using createdAt over batchDate because batchDate is the operator-
   * typed "date this batch refers to" (sometimes backdated to the day
   * the work physically started); createdAt is when the slip actually
   * went out to the vendor — the only timestamp where the grace
   * window's clock starts.
   */
  private async assertBatchEditable(batchId: number, role?: string | null) {
    if (role === 'ADMIN') return; // admins bypass the lock entirely
    const batch = await this.prisma.castingBatch.findUnique({
      where: { id: batchId },
      select: { id: true, batchNumber: true, createdAt: true },
    });
    if (!batch) return; // let the caller's own findUnique throw if missing
    const ageMs = Date.now() - new Date(batch.createdAt).getTime();
    const cutoffMs = CastingService.BATCH_EDIT_GRACE_HOURS * 60 * 60 * 1000;
    if (ageMs <= cutoffMs) return;
    // Format a human-readable "X hours Y minutes" so the operator knows
    // exactly when the window expired.
    const elapsedMin = Math.floor(ageMs / 60000);
    const h = Math.floor(elapsedMin / 60);
    const m = elapsedMin % 60;
    throw new BadRequestException(
      `Batch ${batch.batchNumber} was issued ${h}h ${m}m ago — beyond the ${CastingService.BATCH_EDIT_GRACE_HOURS}-hour edit window. Ask an admin to make this change.`,
    );
  }

  /**
   * Entry process for every production batch. Historically the batch
   * flow started at CASTING; per the CAD-vs-CAM restructure it now
   * starts at CAM (design → mould → cast → …). This helper resolves the
   * entry process, preferring CAM but falling back to CASTING so older
   * installs whose Item Master rows still declare only a CASTING config
   * keep working.
   */
  private async getEntryProcess() {
    const cam = await this.prisma.process.findFirst({
      where: { code: 'CAM', status: 'ACTIVE' },
    });
    if (cam) return cam;
    return this.prisma.process.findFirst({
      where: { code: 'CASTING', status: 'ACTIVE' },
    });
  }

  /** Mark an item's Casting weight as "temporary" by appending the marker
   *  text to the Casting ItemProcess.notes (per-process, not the
   *  item-level notes). Idempotent — no-op when the marker is already
   *  present. Creates the ItemProcess row if missing (rare; only happens
   *  on Quick-Add'd items that haven't gone through Casting yet).
   *  Returns true when the marker was added on THIS call. */
  private async markCastingWeightTemporary(itemId: number): Promise<boolean> {
    if (!itemId) return false;
    const casting = await this.prisma.process.findFirst({ where: { code: 'CASTING' }, select: { id: true } });
    if (!casting) return false;
    let ip = await this.prisma.itemProcess.findUnique({
      where: { itemId_processId: { itemId, processId: casting.id } },
      select: { id: true, notes: true },
    });
    if (!ip) {
      const created = await this.prisma.itemProcess.create({
        data: { itemId, processId: casting.id },
        select: { id: true, notes: true },
      });
      ip = created;
    }
    const existing = (ip.notes ?? '').toLowerCase();
    if (existing.includes(CastingService.TEMP_WEIGHT_MARKER)) return false;
    const sep = ip.notes && ip.notes.trim() ? '\n' : '';
    await this.prisma.itemProcess.update({
      where: { id: ip.id },
      data: { notes: `${ip.notes ?? ''}${sep}${CastingService.TEMP_WEIGHT_MARKER}` },
    });
    return true;
  }

  /**
   * Auto-capture per-process attribute (e.g. Casting weight) to Item
   * Master when it's blank. Same auto-capture rationale as ensureProcessVendor
   * — operator types the value during batch creation; system mirrors it
   * to the master so the next batch defaults from it.
   */
  private async ensureProcessAttribute(
    itemId: number,
    processId: number,
    attrKey: string,
    attrValue: string | number,
  ): Promise<{ created: boolean }> {
    if (!itemId || !processId || attrValue == null || attrValue === '') return { created: false };
    let ip = await this.prisma.itemProcess.findUnique({
      where: { itemId_processId: { itemId, processId } },
    });
    if (!ip) {
      ip = await this.prisma.itemProcess.create({
        data: { itemId, processId },
      });
    }
    const existing = await this.prisma.itemProcessAttribute.findUnique({
      where: { itemProcessId_attrKey: { itemProcessId: ip.id, attrKey } },
    });
    // Don't overwrite — auto-capture only fills BLANK fields. Edits to
    // existing attrs need to go through the Item Master form so the
    // operator sees what they're changing.
    if (existing && existing.attrValue && existing.attrValue.trim() !== '') {
      return { created: false };
    }
    await this.prisma.itemProcessAttribute.upsert({
      where: { itemProcessId_attrKey: { itemProcessId: ip.id, attrKey } },
      create: { itemProcessId: ip.id, attrKey, attrValue: String(attrValue) },
      update: { attrValue: String(attrValue) },
    });
    return { created: true };
  }

  private async syncProcessRateToItem(
    itemId: number | null | undefined,
    processId: number,
    newRate: number | null | undefined,
    vendorId?: number | null,
  ): Promise<{
    itemProcessVendorId: number;
    itemId: number;
    processId: number;
    processName: string;
    vendorId: number;
    vendorName: string;
    oldRate: number | null;
    newRate: number;
    silent: boolean;
  } | null> {
    if (!itemId || !processId || newRate == null || !(Number(newRate) > 0)) return null;
    const ip = await this.prisma.itemProcess.findUnique({
      where: { itemId_processId: { itemId, processId } },
      include: { process: true, vendors: { include: { vendor: true } } },
    });
    if (!ip) return null;
    let target =
      (vendorId ? ip.vendors.find((v) => v.vendorId === vendorId) : null) ??
      ip.vendors.find((v) => v.isPreferred) ??
      ip.vendors[0];
    if (!target) return null;
    const oldRate = target.costPerPiece != null ? Number(target.costPerPiece) : null;
    const next = Number(newRate);
    // No-op when value is identical to master.
    if (oldRate != null && oldRate === next) return null;
    await this.prisma.itemProcessVendor.update({
      where: { id: target.id },
      data: { costPerPiece: next },
    });
    return {
      itemProcessVendorId: target.id,
      itemId,
      processId,
      processName: ip.process.name,
      vendorId: target.vendorId,
      vendorName: target.vendor.vendorName,
      oldRate,
      newRate: next,
      // Silent when master was blank — there's nothing visible to "undo"
      // because the user is filling in something that didn't exist.
      silent: oldRate == null || oldRate === 0,
    };
  }

  /**
   * Look up a vendor's MOST RECENT rate for a process across ALL items —
   * used as a fallback when the chosen (item × vendor) combo has no
   * specific rate in Item Master. Operator's mental model: "Krishna does
   * casting at ₹760/kg everywhere; that's the default". Once they set it
   * on the first design, every subsequent design picked for Krishna
   * pre-fills with 760 unless this specific design's master overrides.
   *
   * Lookup order:
   *   1. ItemProcessVendor rows for (vendorId × processId), ordered by
   *      updatedAt DESC — most recently touched master row wins.
   *   2. Fallback to CastingBatchItem rows (vendorId × processId)
   *      ordered by createdAt DESC — picks the actual rate used in the
   *      last batch even if no master row exists yet.
   * Returns null when no history exists.
   */
  async getVendorLastRate(vendorId: number, processId: number): Promise<number | null> {
    if (!vendorId || !processId) return null;
    const ipv = await this.prisma.itemProcessVendor.findFirst({
      where: {
        vendorId,
        itemProcess: { processId },
        costPerPiece: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
      select: { costPerPiece: true },
    });
    if (ipv?.costPerPiece != null) return Number(ipv.costPerPiece);
    const stage = await this.prisma.castingBatchItem.findFirst({
      where: { vendorId, processId, costPerKg: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { costPerKg: true },
    });
    if (stage?.costPerKg != null) return Number(stage.costPerKg);
    return null;
  }

  /**
   * Resolve a batch-item row. When `itemId` is supplied, the vendor (preferred),
   * vendor design reference, per-piece weight, cost/kg and services are auto-fetched
   * from the item's process data; explicit fields override. Only Production-Ready
   * items may enter a batch. Totals are computed (KG processes use weight × cost/kg).
   */
  private async resolveRow(processId: number, processCode: string, row: CastingBatchItemDto) {
    let {
      itemId, quantity, vendorId, itemNumber, itemName,
      vendorDesignReference, weight, totalWeight, costPerKg, remarks, purpose,
    } = row;
    let services: string | null = null;

    if (itemId) {
      const item = await this.prisma.item.findUnique({
        where: { id: itemId },
        include: {
          processes: {
            include: { process: true, vendors: true, attributes: true, services: { include: { service: true } } },
          },
        },
      });
      if (!item) throw new NotFoundException('Item not found.');
      if (item.sampleStatus !== 'PRODUCTION_READY') {
        throw new BadRequestException(
          `${item.sampleDesignCode} is not Production Ready and cannot enter a batch.`,
        );
      }
      // Production identifier — silver ERP rule: ALWAYS the design code
      // (auto-generated from the CAD vendor's short name, e.g. TVM-001).
      // The sales item number (ABN-NNNN) is allocated post-packing and
      // doesn't exist for in-progress designs, so using it here left
      // batch rows reading as "—". Design code is the karigar-facing
      // identity throughout production.
      itemNumber = itemNumber ?? item.sampleDesignCode ?? '';
      itemName = itemName ?? item.itemName ?? undefined;

      // Per-piece weight comes from the Casting process (grams).
      const casting = item.processes.find((p) => p.process.code === 'CASTING');
      const weightAttr = casting?.attributes.find((a) => a.attrKey === 'weight')?.attrValue;
      if (weight == null) weight = weightAttr ? Number(weightAttr) : 0;

      // Vendor/cost from the entry of the batch's own process. If a vendor was
      // explicitly chosen, use that vendor's entry; otherwise the preferred/first.
      const proc = item.processes.find((p) => p.processId === processId);
      const entries = proc?.vendors ?? [];
      const chosen =
        (vendorId ? entries.find((e) => e.vendorId === vendorId) : undefined) ??
        entries.find((e) => e.isPreferred) ??
        entries[0];
      if (chosen) {
        vendorId = vendorId ?? chosen.vendorId;
        vendorDesignReference = vendorDesignReference ?? (chosen.vendorDesignReference ?? undefined);
        if (costPerKg == null && chosen.costPerPiece != null) costPerKg = Number(chosen.costPerPiece);
      }
      if (proc?.services?.length) services = proc.services.map((s) => s.service.name).join(', ');
    }

    if (!vendorId) {
      throw new BadRequestException('Vendor is required (no preferred vendor found for this item/process).');
    }

    // Vendor-level rate fallback — when the item × vendor master had no
    // rate AND the operator didn't type one, use the vendor's most recent
    // rate across any item for this process. Reflects the operator's
    // mental model: "Krishna does casting at ₹760/kg for everything; only
    // override for the rare design that's different". Skipped silently if
    // no history exists for this vendor on this process.
    if (costPerKg == null && vendorId) {
      const fallback = await this.getVendorLastRate(vendorId, processId);
      if (fallback != null && fallback > 0) costPerKg = fallback;
    }

    const w = Number(weight ?? 0);
    // Total weight is editable; fall back to weight × quantity when not supplied.
    const finalTotalWeight =
      totalWeight != null && !Number.isNaN(Number(totalWeight)) ? Number(totalWeight) : w * quantity;
    // Silver ERP: weight-priced processes (Casting, Plating) charge rate
    // per GRAM. costPerKg is the historical column name kept to avoid a
    // migration, but the VALUE stored is now ₹/g and the math treats it
    // as such — total = rate × weight_in_grams (no /1000 anywhere).
    const isWeightPriced = KG_PROCESSES.includes(processCode);
    const totalCost =
      costPerKg != null
        ? isWeightPriced
          ? finalTotalWeight * Number(costPerKg)
          : Number(costPerKg) * quantity
        : null;

    return {
      itemId: itemId ?? null,
      itemNumber: itemNumber ?? '',
      itemName: itemName ?? null,
      vendorId,
      vendorDesignReference: vendorDesignReference ?? null,
      weight: w,
      quantity,
      totalWeight: finalTotalWeight,
      costPerKg: costPerKg ?? null,
      totalCost,
      services,
      remarks: remarks ?? null,
      purpose: purpose ?? null,
    };
  }

  // ---------------- Batches (Casting Issue) ----------------
  /** Peek the next batch number (shown in the create form) without creating. */
  async nextBatchNumber() {
    return {
      batchNumber: await nextCode(this.prisma, 'castingBatch', 'batchNumber', 'B', 4),
    };
  }

  /**
   * Create a production batch. Production ALWAYS starts at Casting: each design
   * line becomes a Casting stage (lineKey = its own id). From there, received
   * pieces are forwarded to any next process, in any order (see forwardStage).
   */
  async createBatch(dto: CreateBatchDto, userId?: number) {
    const casting = await this.getEntryProcess();
    if (!casting) throw new NotFoundException('Entry process (CAM / Casting) is not configured.');

    const batchNumber =
      dto.batchNumber?.trim() ||
      (await nextCode(this.prisma, 'castingBatch', 'batchNumber', 'B', 4));

    // Resolve every row FIRST (validation + lookup). Throws cleanly with a
    // friendly message if anything's off — and crucially BEFORE we create
    // the batch row, so a bad row doesn't leave an empty orphan batch like
    // B0046/B0047/B0048 (which is exactly how those got created today).
    // Each row can override its entry process (CAM, CASTING, or any other
    // production step) via dto.items[i].entryProcessId; when omitted we
    // fall back to the batch-wide entry (`casting`, which is CAM today).
    const rowProcessCache = new Map<number, { id: number; code: string }>();
    rowProcessCache.set(casting.id, { id: casting.id, code: casting.code });
    const rowProcesses: Array<{ id: number; code: string }> = [];
    const resolved: Awaited<ReturnType<typeof this.resolveRow>>[] = [];
    for (let idx = 0; idx < dto.items.length; idx++) {
      try {
        const overrideId = (dto.items[idx] as any).entryProcessId as number | undefined;
        let rp: { id: number; code: string } = { id: casting.id, code: casting.code };
        if (overrideId && overrideId !== casting.id) {
          if (!rowProcessCache.has(overrideId)) {
            const p = await this.prisma.process.findUnique({ where: { id: overrideId } });
            if (!p) throw new BadRequestException(`Row ${idx + 1}: entryProcessId ${overrideId} not found.`);
            if (p.status !== 'ACTIVE') throw new BadRequestException(`Row ${idx + 1}: process "${p.name}" is inactive.`);
            rowProcessCache.set(overrideId, { id: p.id, code: p.code });
          }
          rp = rowProcessCache.get(overrideId)!;
        }
        rowProcesses.push(rp);
        resolved.push(await this.resolveRow(rp.id, rp.code, dto.items[idx]));
      } catch (e) {
        if (e instanceof BadRequestException || e instanceof NotFoundException) throw e;
        const msg = e instanceof Error ? e.message : 'unknown error';
        throw new BadRequestException(`Row ${idx + 1}: ${msg}`);
      }
    }

    // Now write the batch + every stage in ONE transaction. If anything
    // fails Prisma rolls back — no orphan batch row left behind.
    let batchId = 0;
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const batch = await tx.castingBatch.create({
          data: {
            batchNumber,
            processId: casting.id,
            batchDate: new Date(dto.batchDate),
            notes: dto.notes ?? null,
            createdById: userId ?? null,
          },
        });
        let order = 0;
        const createdIds: number[] = [];
        for (let i = 0; i < resolved.length; i++) {
          const data = resolved[i];
          const row = dto.items[i];
          const rp = rowProcesses[i] ?? casting;
          const created = await tx.castingBatchItem.create({
            data: {
              batchId: batch.id,
              ...data,
              processId: rp.id,
              colorModel: row.colorModel ?? null,
              color: row.color ?? null,
              sortOrder: order++,
            },
          });
          // lineKey groups all future stages of this design line.
          await tx.castingBatchItem.update({
            where: { id: created.id },
            data: { lineKey: String(created.id) },
          });
          createdIds.push(created.id);
        }
        return { batch, createdIds };
      });
      batchId = result.batch.id;
      // Issue-slip grouping needs a SEPARATE transaction (or none) because it
      // queries sibling stages by time, which works once the items are committed.
      for (const id of result.createdIds) await this.assignIssueSlip(id);
      await this.recomputeBatchStatus(batchId);

      // Auto-sync the casting RATE back to the item's Item Master so the
      // next batch picks it up pre-filled. Two behaviours, per user spec:
      //   (b) silent fill if master rate is blank/null
      //   (c) update + flag for toast+undo if master had a different rate
      // No-op when rates match. Frontend reads rateUpdates[] and renders
      // toasts (with Undo) for the non-silent entries. Item.costPrice
      // will recompute the next time the item is opened + saved; not
      // racing the batch response on it for snappiness.
      const rateUpdates: NonNullable<Awaited<ReturnType<typeof this.syncProcessRateToItem>>>[] = [];
      // Items whose Casting weight got captured FOR THE FIRST TIME on this
      // batch (master was blank → operator's guess is now in the master and
      // notes carry the "casting weight temporary" marker). Surfaced to the
      // frontend so it can toast a heads-up; cleared one item at a time
      // when receipts arrive and the operator confirms the final per-pc.
      const tempWeightFlagged: number[] = [];
      for (const row of dto.items) {
        if (!row.itemId) continue;
        // (1) Rate sync — toast+undo when overwriting existing.
        if (row.costPerKg != null) {
          const sync = await this.syncProcessRateToItem(
            row.itemId,
            casting.id,
            Number(row.costPerKg),
            row.vendorId ?? null,
          );
          if (sync) rateUpdates.push(sync);
        }
        // (2) Vendor auto-add to Item Master (silent if blank).
        if (row.vendorId) {
          await this.ensureProcessVendor({
            itemId: row.itemId,
            processId: casting.id,
            vendorId: row.vendorId,
            color: null,                                  // Casting has no colour
            costPerPiece: row.costPerKg ?? null,
            vendorDesignReference: row.vendorDesignReference,
          });
        }
        // (3) Casting weight attribute auto-fill (silent if blank).
        // Weight ALWAYS mirrors to master when one's typed — operator
        // ticks the "Casting weight temporary" box on the row only when
        // it's a best-guess, in which case we ALSO append the marker to
        // the Casting ItemProcess.notes. Receive form picks the marker
        // up and prompts for the final per-pc weight; finalize clears
        // both the temp value and the marker. Un-ticked → no marker,
        // even if the master was blank (operator confirms the weight
        // they typed is accurate enough).
        if (row.weight != null && Number(row.weight) > 0) {
          await this.ensureProcessAttribute(
            row.itemId,
            casting.id,
            'weight',
            String(row.weight),
          );
          if (row.castingWeightTemporary) {
            const flagged = await this.markCastingWeightTemporary(row.itemId);
            if (flagged) tempWeightFlagged.push(row.itemId);
          }
        }
      }
      // Audit — log creation. Not auto-undoable in this phase: removing
      // a brand-new batch is doable via removeBatch, but the batch may
      // already have downstream forwards if the operator was fast; that's
      // a domain-specific guard we don't want the audit layer to bypass.
      // Logged for traceability; operator can manually delete via the
      // batch detail's existing button if appropriate.
      await this.audit.log(userId, {
        action: 'casting.batch.create',
        targetType: 'CastingBatch',
        targetId: batchId,
        description: `Created batch ${result.batch.batchNumber} (${dto.items.length} design line${dto.items.length === 1 ? '' : 's'})`,
        snapshotAfter: { id: batchId, batchNumber: result.batch.batchNumber, items: dto.items },
      });
      return {
        id: batchId,
        batchNumber: result.batch.batchNumber,
        rateUpdates,
        // Items whose Casting weight was just auto-captured as temporary —
        // frontend uses this to surface a heads-up toast ("Will prompt for
        // final weight on receive"). Empty for batches against fully-set-up
        // Item Masters (the usual case).
        tempWeightFlagged,
      };
    } catch (e) {
      // Prisma error codes —
      //   P2002 = unique-constraint violation (duplicate batch_number, etc.)
      //   P2003 = foreign-key violation (vendor/item/process doesn't exist)
      const code = (e as any)?.code as string | undefined;
      if (code === 'P2002') {
        throw new BadRequestException(
          `Batch number "${batchNumber}" already exists. Clear the Batch Number field and resubmit to auto-generate the next one.`,
        );
      }
      if (code === 'P2003') {
        const field = (e as any)?.meta?.field_name ?? 'a referenced record';
        throw new BadRequestException(
          `Could not create batch — ${field} does not exist. ` +
          `This usually means a vendor or item picked in the form was deleted between page-load and submit. ` +
          `Refresh the form, re-pick the design + vendor, and try again.`,
        );
      }
      if (e instanceof BadRequestException || e instanceof NotFoundException) throw e;
      const msg = e instanceof Error ? e.message : 'unknown error';
      // Log the full error so the actual cause is visible in the backend
      // console (the HttpExceptionFilter only logs non-HttpException).
      this.logger.error(`createBatch failed: ${msg}`, e instanceof Error ? e.stack : undefined);
      throw new BadRequestException(`Could not create batch — ${msg}`);
    }
  }

  /**
   * Group a freshly-created stage onto an issue slip. Stages issued to the same
   * batch + process + vendor within 15 minutes share one slip (so a piece added
   * within the window joins the same slip); after 15 minutes a new slip starts.
   */
  private async assignIssueSlip(stageId: number) {
    const stage = await this.prisma.castingBatchItem.findUnique({ where: { id: stageId } });
    if (!stage) return;
    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    const sibling = await this.prisma.castingBatchItem.findFirst({
      where: {
        batchId: stage.batchId,
        processId: stage.processId,
        vendorId: stage.vendorId,
        id: { not: stage.id },
        issueSlipAt: { gte: cutoff },
      },
      orderBy: { issueSlipAt: 'desc' },
    });
    await this.prisma.castingBatchItem.update({
      where: { id: stage.id },
      data: {
        issueSlipId: sibling?.issueSlipId ?? stage.id,
        issueSlipAt: sibling?.issueSlipAt ?? new Date(),
      },
    });
  }

  /**
   * Forward received pieces of a stage to the next process (any order, partial).
   * Creates a child stage (same lineKey) with the target process's preferred
   * vendor/cost auto-fetched. Sticking stages consume BOM stock for their qty.
   *
   * `opts.targetBatchId` (optional, internal): when supplied, the new child
   * stage lives in a DIFFERENT batch — used by the new-batch flow to absorb
   * settled pieces from old (often short-closed) batches into the fresh batch.
   * The parentItemId still points back to the source for ancestry, but the
   * child gets a brand-new lineKey rooted in itself so it appears as a new
   * line in the target batch.
   */
  async forwardStage(
    batchItemId: number,
    dto: ForwardStageDto,
    userId?: number,
    opts: { targetBatchId?: number } = {},
  ) {
    const source = await this.prisma.castingBatchItem.findUnique({
      where: { id: batchItemId },
      include: { receiptRows: true, stageProcess: true },
    });
    if (!source) throw new NotFoundException('Stage not found.');
    if (source.stageProcess?.code === 'PACKING') {
      throw new BadRequestException('Packing is the final step — these pieces are finished and cannot be forwarded further.');
    }
    if (dto.quantity <= 0) throw new BadRequestException('Quantity must be greater than zero.');
    // Initial accepted/forwarded check — surfaces a friendly error before we
    // hit the lock. The authoritative check happens inside the transaction
    // below so concurrent forward attempts on the same source can't both pass.
    const accepted = source.receiptRows.reduce((s, r) => s + r.acceptedQty, 0);
    const children = await this.prisma.castingBatchItem.findMany({ where: { parentItemId: source.id } });
    const forwarded = children.reduce((s, c) => s + c.quantity, 0);

    // Open MissingPart records are surfaced as a non-blocking warning now —
    // operator confirms recast (same batch / new batch) via the receive-form
    // popup or the dashboard "Pending Recasts" card. Forward is no longer
    // blocked because the lost pcs are tracked independently and the design
    // can proceed with the pieces that DID arrive.
    const available = accepted - forwarded;
    if (dto.quantity > available) {
      throw new BadRequestException(`Only ${available} accepted piece(s) are available to forward.`);
    }

    const target = await this.prisma.process.findUnique({ where: { id: dto.processId } });
    if (!target) throw new NotFoundException('Next process not found.');

    // Auto-pick the vendor whose colour matches the colour CHOSEN for this next
    // step (when no vendor was explicitly chosen). The colour is selected per
    // step, so the vendor must be matched on dto.color — the colour for the
    // target process — never the source stage's colour.
    let vendorId = dto.vendorId;
    let vendorDesignReference = dto.vendorDesignReference;
    let costPerKg = dto.costPerKg;
    const matchColor = dto.color ?? null;
    if (!vendorId && source.itemId && matchColor) {
      const item = await this.prisma.item.findUnique({
        where: { id: source.itemId },
        include: { processes: { include: { vendors: true } } },
      });
      const proc = item?.processes.find((p) => p.processId === dto.processId);
      const match = proc?.vendors.find(
        (v) => (v.color ?? '').trim().toLowerCase() === matchColor.trim().toLowerCase(),
      );
      if (match) {
        vendorId = match.vendorId;
        if (vendorDesignReference == null) vendorDesignReference = match.vendorDesignReference ?? undefined;
        if (costPerKg == null && match.costPerPiece != null) costPerKg = Number(match.costPerPiece);
      }
    }

    // Per-piece weight carry-forward — when the caller (auto-forward on
    // receipt, continue-stages bulk forward) doesn't supply dto.weight,
    // derive it from the SOURCE stage's actual receipts: sum of physical
    // receivedWeight ÷ sum of physical receivedQty. This makes every
    // stage's planned weight reflect what was actually weighed at the
    // previous receive, so casting-loss / plating-gain cascade through
    // every process. Without this, resolveRow's fallback would use the
    // item-master's ORIGINAL Casting weight attribute on every auto-
    // forward — ignoring everything measured along the way.
    let effectiveWeight = dto.weight;
    if (effectiveWeight == null) {
      const rawWt = source.receiptRows.reduce((s, r) => s + Number(r.receivedWeight), 0);
      const rawQty = source.receiptRows.reduce((s, r) => s + r.receivedQty, 0);
      if (rawQty > 0 && rawWt > 0) effectiveWeight = rawWt / rawQty;
    }

    const data = await this.resolveRow(target.id, target.code, {
      itemId: source.itemId ?? undefined,
      quantity: dto.quantity,
      vendorId,
      weight: effectiveWeight,
      totalWeight: dto.totalWeight,
      costPerKg,
      vendorDesignReference,
      remarks: dto.remarks,
      // Purpose carry-forward: the child stage inherits the source's
      // purpose by default so the order context (e.g. "Customer ABC")
      // flows through every step of the design line. Operator overrides
      // it explicitly when re-targeting (rare).
      purpose: dto.purpose ?? source.purpose ?? undefined,
    });

    // When absorbing into a different batch (e.g. settling old stock into a new
    // batch), the child gets a fresh lineKey rooted in itself — within the new
    // batch it's a new line. parentItemId still points to the source for trace.
    //
    // ALSO: when forwarding from a COLOURLESS source (Casting) into a coloured
    // step, each colour becomes its OWN line. Otherwise all colours share one
    // lineKey and the "process done in this line" filter blocks the second
    // colour from doing the same step (e.g. Ruby finishes Sticking, then Green
    // can't go to Sticking because the line says "Sticking done").
    const destBatchId = opts.targetBatchId ?? source.batchId;
    const crossBatch = destBatchId !== source.batchId;
    const colourSplit = !source.color && !!dto.color; // colourless → coloured
    const freshLineKey = crossBatch || colourSplit;
    const lineKey = freshLineKey ? null : (source.lineKey ?? String(source.id));

    // Atomic check + create — MySQL SELECT FOR UPDATE on the source row
    // holds the lock until the transaction commits, serialising any
    // concurrent forward calls on the same stage. This is the real fix for
    // the B0046 "108 → 216" race: even if the frontend somehow fires twice
    // (different tabs, retried request, programmatic caller), the second
    // transaction blocks on the row lock, re-reads the now-updated children
    // count, and bails out with "Only 0 accepted piece(s) available".
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'SELECT id FROM casting_batch_items WHERE id = $1 FOR UPDATE',
        batchItemId,
      );
      // Re-read under the lock — these numbers are authoritative.
      const lockedReceipts = await tx.castingReceiptItem.findMany({
        where: { batchItemId },
        select: { acceptedQty: true },
      });
      const lockedAccepted = lockedReceipts.reduce((s, r) => s + r.acceptedQty, 0);
      const lockedChildren = await tx.castingBatchItem.findMany({
        where: { parentItemId: batchItemId },
        select: { quantity: true },
      });
      const lockedForwarded = lockedChildren.reduce((s, c) => s + c.quantity, 0);
      const lockedAvailable = lockedAccepted - lockedForwarded;
      if (dto.quantity > lockedAvailable) {
        throw new BadRequestException(`Only ${lockedAvailable} accepted piece(s) are available to forward.`);
      }
      const maxOrder = await tx.castingBatchItem.aggregate({
        where: { batchId: destBatchId, ...(lineKey ? { lineKey } : {}) },
        _max: { sortOrder: true },
      });
      // Parse the operator-typed forward date (if any). Falls back to "now"
      // when blank/invalid so existing slips that don't send the field
      // keep their current behaviour. Forcing the parsed value through
      // Date isolates bad input from corrupting createdAt.
      const parsedForwardDate = (() => {
        if (!dto.forwardDate) return undefined;
        const d = new Date(dto.forwardDate);
        return isNaN(d.getTime()) ? undefined : d;
      })();
      return tx.castingBatchItem.create({
        data: {
          batchId: destBatchId,
          ...data,
          processId: target.id,
          parentItemId: source.id,
          // Will be backfilled to created.id when crossing batches (below).
          lineKey: lineKey ?? '',
          colorModel: source.colorModel ?? null,
          // Colour is chosen per step — never carried to a non-colour step.
          color: dto.color ?? null,
          sortOrder: (maxOrder._max.sortOrder ?? 0) + 1,
          // Override createdAt when the operator backdated the issue —
          // batch-detail's per-stage date strip reads this as the
          // "forwardedAt" date. Without this, the strip would always
          // show "today" even for issues that happened earlier.
          ...(parsedForwardDate ? { createdAt: parsedForwardDate } : {}),
        },
      });
    });
    if (freshLineKey) {
      await this.prisma.castingBatchItem.update({
        where: { id: created.id },
        data: { lineKey: String(created.id) },
      });
    }

    // BOM AUTO-ISSUE — fires for every BOM-capable process (Filing, Kacha
    // Fitting, Fitting + Mala, Sticking in the silver chain). Each one:
    //   1. Persists any inline-captured BOM rows (Forward dialog allows
    //      ad-hoc adds when the master BOM is blank for this combo).
    //   2. Freezes the BOM onto the stage as a snapshot so the slip is
    //      immune to later item-master edits.
    //   3. Auto-creates a MaterialIssue voucher to the karigar — unless
    //      the operator ticked "brings own materials" (rate covers
    //      materials, no issue).
    // Color filter is Sticking-only; other BOM processes share one BOM
    // across colours so `targetColor` collapses to null for them.
    if (target.bomCapable && source.itemId) {
      const isSticking = target.code === 'STICKING';
      const targetColor = isSticking ? (dto.color ?? created.color ?? null) : null;

      if (dto.bomCapture && dto.bomCapture.length > 0 && !dto.bringsOwnMaterials) {
        for (const cap of dto.bomCapture) {
          if (!cap.variantId) continue;
          const perPieceQty = Math.max(0, Math.round(cap.perPiece ?? 0));
          if (perPieceQty <= 0) continue;
          const exists = await this.prisma.itemMaterial.findFirst({
            where: {
              itemId: source.itemId,
              processId: target.id,
              variantId: cap.variantId,
              color: targetColor,
            },
            select: { id: true },
          });
          if (exists) continue;
          await this.prisma.itemMaterial.create({
            data: {
              itemId: source.itemId,
              processId: target.id,
              variantId: cap.variantId,
              color: targetColor,
              quantity: perPieceQty,
            },
          });
        }
      }
      await this.snapshotStageBom(created.id, source.itemId, dto.quantity, targetColor);
      if (!dto.bringsOwnMaterials) {
        await this.autoIssueStickingMaterials(
          created.id, source.itemId, dto.quantity, targetColor,
          (vendorId ?? created.vendorId), source.batchId,
          dto.materialBufferPercent ?? 0,
          dto.materialIssueOverride, userId,
        );
      }
    }
    // Ad-hoc material issue with this forward — operator-picked materials
    // sent ALONGSIDE the work to non-BOM processes (primarily Filing /
    // Polish). One MaterialIssue voucher per forward, linked to the new
    // stage. The /material-issues page lets the operator issue more later
    // if work is still pending and additional materials are needed.
    if (Array.isArray(dto.extraMaterials) && dto.extraMaterials.length > 0) {
      const variantIds = Array.from(new Set(dto.extraMaterials.map((l) => l.variantId).filter(Boolean)));
      const variants = await this.prisma.materialVariant.findMany({
        where: { id: { in: variantIds } },
        select: { id: true, variantName: true, trackByQty: true, trackByWeight: true, processes: { select: { processId: true } } },
      });
      const vById = new Map(variants.map((v) => [v.id, v]));
      // Filing-process target → each ad-hoc material variant MUST come in
      // with BOTH qty and weight. Surface a clear error so the operator
      // knows which row needs the missing input.
      const isFilingTarget = target?.code === 'FILING';
      const cleanLines = dto.extraMaterials
        .filter((l) => l.variantId && ((l.issuedQty ?? 0) > 0 || (l.issuedWeight ?? 0) > 0))
        .map((l) => {
          const v = vById.get(l.variantId);
          const qty = Math.max(0, Math.trunc(Number(l.issuedQty ?? 0)));
          const wt  = Math.max(0, Math.round(Number(l.issuedWeight ?? 0) * 1000) / 1000);
          if (isFilingTarget && (qty <= 0 || wt <= 0)) {
            throw new BadRequestException(
              `${v?.variantName ?? 'Material'}: filing materials need qty AND weight.`,
            );
          }
          if (v?.trackByWeight && wt <= 0) {
            throw new BadRequestException(`${v.variantName}: weight (g) is required.`);
          }
          return {
            variantId: l.variantId,
            issuedQty: qty,
            issuedWeight: wt,
            deferredQty: 0,
            notes: l.notes,
          };
        });
      if (cleanLines.length > 0) {
        await this.materialIssues.createWithDeferred(
          {
            vendorId: vendorId ?? created.vendorId,
            batchId: source.batchId,
            stageId: created.id,
            notes: `Ad-hoc issue with forward ${created.id}`,
            lines: cleanLines,
          },
          userId,
        );
      }
    }

    await this.assignIssueSlip(created.id);
    await this.recomputeBatchStatus(source.batchId);
    if (crossBatch) await this.recomputeBatchStatus(destBatchId);

    // Auto-sync the NEXT-process rate back into the item's Item Master so
    // future batches pre-fill from it. Two behaviours:
    //   (b) silent fill if master was blank/null
    //   (c) flag for toast+undo if master had a different rate
    // The dto.costPerKg holds the rate the user typed in the forward dialog
    // (per kg for KG processes, per piece for piece-priced processes).
    const rateUpdates: NonNullable<Awaited<ReturnType<typeof this.syncProcessRateToItem>>>[] = [];
    if (source.itemId && dto.costPerKg != null) {
      const sync = await this.syncProcessRateToItem(
        source.itemId,
        target.id,
        Number(dto.costPerKg),
        vendorId ?? created.vendorId,
      );
      if (sync) rateUpdates.push(sync);
    }
    // Auto-add the (vendor × colour) row to Item Master if it's not there
    // yet. Silent — first-ever vendor on this process becomes preferred
    // so future cost-resolves pick it up by default. ItemProcessVendor
    // also stores the colour, so when operator forwards Plating to a
    // new "Rajwadi" colour for the first time, the colour is captured
    // here and shows up in the Item Master's colour list next time.
    const effectiveVendorId = vendorId ?? created.vendorId;
    if (source.itemId && effectiveVendorId) {
      await this.ensureProcessVendor({
        itemId: source.itemId,
        processId: target.id,
        vendorId: effectiveVendorId,
        color: dto.color ?? created.color,
        costPerPiece: dto.costPerKg != null ? Number(dto.costPerKg) : null,
        vendorDesignReference,
        bringsOwnMaterials: dto.bringsOwnMaterials,
      });
    }
    // Audit — undoable via casting.forward (reuses deleteForwardedStage
    // which blocks if the child stage already has receipts/children).
    await this.audit.log(userId, {
      action: 'casting.forward',
      targetType: 'CastingBatchItem',
      targetId: created.id,
      description: `Forwarded ${dto.quantity} pcs of #${source.itemNumber ?? '?'} to ${target.name}${dto.color ? ' · ' + dto.color : ''}`,
      snapshotAfter: { id: created.id, sourceStageId: source.id, processId: target.id, vendorId: created.vendorId, color: created.color, quantity: dto.quantity },
      undoStrategy: 'casting.forward',
    });
    return { id: created.id, rateUpdates };
  }

  /** Edit a stage's vendor / qty / weight / rate / colour / remarks (history preserved). */
  async updateStage(id: number, dto: UpdateStageDto, userId?: number, role?: string | null) {
    const stage = await this.prisma.castingBatchItem.findUnique({
      where: { id },
      include: { stageProcess: true, receiptRows: { select: { id: true } } },
    });
    if (!stage) throw new NotFoundException('Stage not found.');
    // Batch edit-window check — gates the edit when the parent batch's
    // 3h grace window has expired AND the operator isn't ADMIN.
    await this.assertBatchEditable(stage.batchId, role);
    // Snapshot every field that updateStage touches, so the undo handler
    // (registered in the constructor) can revert them exactly.
    const beforeSnap = {
      id: stage.id,
      vendorId: stage.vendorId,
      vendorDesignReference: stage.vendorDesignReference,
      quantity: stage.quantity,
      weight: stage.weight,
      totalWeight: stage.totalWeight,
      costPerKg: stage.costPerKg,
      color: stage.color,
      remarks: stage.remarks,
      purpose: stage.purpose,
      itemId: stage.itemId,
      itemNumber: stage.itemNumber,
      itemName: stage.itemName,
      issueDate: stage.issueDate,
    };
    const code = stage.stageProcess?.code ?? 'CASTING';
    const isKg = KG_PROCESSES.includes(code);
    const isForwardedStage = stage.parentItemId != null;

    // Design SWAP — the order-giver typed the wrong design number; operator
    // catches it before anything else happens. Allowed ONLY when the stage
    // is fresh: no receipts, no children forwarded, no material-issue
    // voucher (Sticking). Once any of those exist, history is tied to the
    // OLD design and a swap would silently misattribute weight/QC/stock —
    // fix path becomes short-close + re-enter on a new line.
    // We also auto-pull itemNumber/itemName from the new item so the
    // stage's display + slip stays consistent.
    let newItemNumber: string | null = stage.itemNumber;
    let newItemName: string | null = stage.itemName;
    if (dto.itemId != null && dto.itemId !== stage.itemId) {
      if ((stage.receiptRows?.length ?? 0) > 0) {
        throw new BadRequestException(
          'Cannot change the design on this stage — receipts have already been booked. Short-close this stage and add a new line with the correct design.',
        );
      }
      const childCount = await this.prisma.castingBatchItem.count({
        where: { parentItemId: stage.id },
      });
      if (childCount > 0) {
        throw new BadRequestException(
          `Cannot change the design on this stage — ${childCount} piece(s) were already forwarded to the next process. Short-close + re-enter is the fix path.`,
        );
      }
      const matIssueCount = await this.prisma.materialIssue.count({
        where: { stageId: stage.id },
      });
      if (matIssueCount > 0) {
        throw new BadRequestException(
          'Cannot change the design — a material-issue voucher exists for this stage. Reverse it first via Material Issues.',
        );
      }
      const newItem = await this.prisma.item.findUnique({
        where: { id: dto.itemId },
        select: { id: true, itemNumber: true, itemName: true, sampleStatus: true, sampleDesignCode: true },
      });
      if (!newItem) throw new NotFoundException('New design not found.');
      if (newItem.sampleStatus !== 'PRODUCTION_READY') {
        throw new BadRequestException(`${newItem.sampleDesignCode} is not Production Ready and cannot be assigned to a stage.`);
      }
      newItemNumber = newItem.itemNumber != null ? String(newItem.itemNumber) : '';
      newItemName = newItem.itemName ?? null;
    }

    // Quantity of a forwarded (downstream) step is governed by the Send amount,
    // never hand-edited — editing it would break piece-conservation with its parent.
    // Only the root Casting issue qty is directly editable (with the forwarded guard).
    if (dto.quantity != null && !isForwardedStage) {
      const children = await this.prisma.castingBatchItem.findMany({ where: { parentItemId: stage.id } });
      const forwarded = children.reduce((s, c) => s + c.quantity, 0);
      if (dto.quantity < forwarded) {
        throw new BadRequestException(`Cannot set quantity to ${dto.quantity} — ${forwarded} piece(s) were already forwarded to the next process.`);
      }
    }

    const quantity = isForwardedStage ? stage.quantity : (dto.quantity ?? stage.quantity);
    const weight = dto.weight ?? Number(stage.weight);
    const totalWeight = dto.totalWeight ?? Math.round(weight * quantity * 1000) / 1000;
    const costPerKg = dto.costPerKg ?? (stage.costPerKg != null ? Number(stage.costPerKg) : null);
    const totalCost =
      costPerKg != null ? (isKg ? totalWeight * costPerKg : costPerKg * quantity) : null;

    await this.prisma.castingBatchItem.update({
      where: { id },
      data: {
        // Swap design when supplied + different + guards passed. itemNumber
        // / itemName come from the new item's master so the row display
        // and slip render the new design's identity immediately.
        ...(dto.itemId != null && dto.itemId !== stage.itemId
          ? { itemId: dto.itemId, itemNumber: newItemNumber ?? '', itemName: newItemName }
          : {}),
        vendorId: dto.vendorId ?? stage.vendorId,
        vendorDesignReference: dto.vendorDesignReference ?? stage.vendorDesignReference,
        quantity,
        weight,
        totalWeight,
        costPerKg,
        totalCost: totalCost != null ? Math.round(totalCost * 100) / 100 : null,
        color: dto.color ?? stage.color,
        remarks: dto.remarks ?? stage.remarks,
        purpose: dto.purpose ?? stage.purpose,
        // YYYY-MM-DD → Date. Empty string / explicit null clears the override
        // (slip falls back to createdAt). Omitted = keep current.
        ...(dto.issueDate !== undefined
          ? { issueDate: dto.issueDate ? new Date(dto.issueDate) : null }
          : {}),
      },
    });

    // Cascade per-pc weight change to downstream child stages so the
    // receive forms on the NEXT process(es) show the corrected per-pc.
    // Without this, fixing a typo on the casting weight would leave the
    // plating row's totalWeight referring to the old per-pc — the
    // receive form computes perPcWt = totalWeight / quantity and the
    // user would still see the old value when receiving Plating.
    //
    // Safety: stop at any stage that has its own receipts — those rows
    // are authoritative (someone re-measured and entered actuals), we
    // don't overwrite them. Recursive so a casting edit propagates
    // through Plating → Antique → Meena chain as long as nothing's
    // been received yet downstream.
    if (Number(stage.weight) !== weight) {
      const cascadeWeight = async (parentId: number, newPerPcWeight: number) => {
        const children = await this.prisma.castingBatchItem.findMany({
          where: { parentItemId: parentId },
          include: { receiptRows: { select: { id: true } } },
        });
        for (const child of children) {
          if (child.receiptRows.length > 0) continue; // authoritative — skip
          const childTotalWeight = Math.round(newPerPcWeight * child.quantity * 1000) / 1000;
          await this.prisma.castingBatchItem.update({
            where: { id: child.id },
            data: { weight: newPerPcWeight, totalWeight: childTotalWeight },
          });
          await cascadeWeight(child.id, newPerPcWeight);
        }
      };
      await cascadeWeight(id, weight);
    }

    // Sync the rate change back to the Item Master so future batches /
    // forwards for the same (item × process × vendor) pre-fill with this
    // new rate. Mirrors the same sync that createBatch and forwardStage
    // already perform — Edit Stage was the missing third path. Without
    // this, the user could edit a stage's rate to 780 today but the next
    // batch would still default to 760 from the unchanged master.
    //
    // On a DESIGN SWAP, the auto-sync targets the NEW item (operator's
    // intent is "this stage is now design X" — the old design shouldn't
    // gain rate/vendor data based on this edit). effectiveItemId picks
    // the new id when swapped, the old one otherwise.
    const effectiveItemId = (dto.itemId != null && dto.itemId !== stage.itemId) ? dto.itemId : stage.itemId;
    const rateUpdates: NonNullable<Awaited<ReturnType<typeof this.syncProcessRateToItem>>>[] = [];
    if (effectiveItemId && stage.processId && costPerKg != null) {
      const sync = await this.syncProcessRateToItem(
        effectiveItemId,
        stage.processId,
        costPerKg,
        dto.vendorId ?? stage.vendorId,
      );
      if (sync) rateUpdates.push(sync);
    }
    // Edit Stage can also CHANGE the vendor or colour on a stage — when
    // operator picks a new combo, mirror it to Item Master if absent.
    // (When the master already has the (vendor × colour) row, this is
    // a no-op; rate updates above already handle the rate diff with toast.)
    const effectiveVendorId = dto.vendorId ?? stage.vendorId;
    if (effectiveItemId && stage.processId && effectiveVendorId) {
      await this.ensureProcessVendor({
        itemId: effectiveItemId,
        processId: stage.processId,
        vendorId: effectiveVendorId,
        color: dto.color ?? stage.color,
        costPerPiece: costPerKg ?? null,
        vendorDesignReference: dto.vendorDesignReference ?? stage.vendorDesignReference,
      });
    }
    // Casting weight attribute mirror (only on the Casting stage —
    // downstream stages' totalWeight reflects per-process weight gain,
    // not the design's planned weight).
    if (effectiveItemId && stage.processId && stage.stageProcess?.code === 'CASTING' && weight > 0) {
      await this.ensureProcessAttribute(effectiveItemId, stage.processId, 'weight', String(weight));
    }
    await this.recomputeBatchStatus(stage.batchId);
    // Audit — capture the after-state with the same shape as before so
    // the timeline diff renders field-by-field. Undoable via the
    // casting.stage.update strategy (registered in constructor).
    await this.audit.log(userId, {
      action: 'casting.stage.update',
      targetType: 'CastingBatchItem',
      targetId: id,
      description: `Edited stage #${id}${stage.itemNumber ? ' (#' + stage.itemNumber + ')' : ''} on ${stage.stageProcess?.name ?? 'process'}`,
      snapshotBefore: beforeSnap,
      snapshotAfter: {
        id,
        vendorId: dto.vendorId ?? stage.vendorId,
        vendorDesignReference: dto.vendorDesignReference ?? stage.vendorDesignReference,
        quantity,
        weight,
        totalWeight,
        costPerKg,
        color: dto.color ?? stage.color,
        remarks: dto.remarks ?? stage.remarks,
        purpose: dto.purpose ?? stage.purpose,
        itemId: effectiveItemId,
        itemNumber: newItemNumber,
        itemName: newItemName,
      },
      undoStrategy: 'casting.stage.update',
    });
    return { id, rateUpdates };
  }

  /**
   * Delete a fresh stage — handles BOTH the "undo a mistaken forward"
   * (child stage) and the "remove a wrong-design line from this batch"
   * (root stage) cases. Allowed only when:
   *   • No receipts have been booked against the stage.
   *   • No children below it (i.e. nothing was forwarded onward).
   *   • Stage is not short-closed (already settled — short-close is the way
   *     to undo a closed stage's "owed by vendor" entry).
   *
   * For Sticking stages we delete the auto-created MaterialIssue too, which
   * reverses the OUT stock movements so issued material goes back on the
   * shelf. Child-stage deletion frees up forwardable pcs at the parent
   * (since forwardedByParent drops). Root-stage deletion just removes the
   * line — the batch keeps any other unaffected lines.
   */
  async deleteForwardedStage(id: number, userId?: number, role?: string | null) {
    const stage = await this.prisma.castingBatchItem.findUnique({
      where: { id },
      include: { receiptRows: true, stageProcess: true },
    });
    if (!stage) throw new NotFoundException('Stage not found.');
    // Batch edit-window check — same gate as updateStage; "remove a
    // design from the batch" is a content edit, blocked past 3h for
    // non-admins.
    await this.assertBatchEditable(stage.batchId, role);
    if (stage.closed) {
      throw new BadRequestException('Cannot delete a short-closed stage — reopen it first.');
    }
    if ((stage.receiptRows?.length ?? 0) > 0) {
      throw new BadRequestException('Cannot delete a stage with receipts. Delete the receipts first, or short-close instead.');
    }
    const children = await this.prisma.castingBatchItem.findMany({
      where: { parentItemId: id },
      select: { id: true },
    });
    if (children.length > 0) {
      throw new BadRequestException(
        `Cannot delete — ${children.length} child stage(s) were forwarded from this one. Delete those first.`,
      );
    }

    // Reverse any OPEN MaterialIssues attached to this stage. We reuse the
    // material-issues service's `remove()` so the OUT stock movements are
    // properly reversed (it adds an "Reversed delete of <voucher>" IN
    // movement and removes the lines + issue header). CLOSED issues are
    // skipped — those represent material that's been received/consumed and
    // can't be undone here.
    const issues = await this.prisma.materialIssue.findMany({
      where: { stageId: id },
      select: { id: true, status: true },
    });
    for (const iss of issues) {
      if (iss.status === 'CLOSED') continue;
      try {
        await this.materialIssues.remove(iss.id, userId);
      } catch {
        // If the issue has receipts on it (mat returned by vendor), the
        // service refuses — surface that to the user clearly.
        throw new BadRequestException(
          `Cannot delete — the auto-issued material voucher for this stage has return entries. Resolve the material returns first.`,
        );
      }
    }

    // Now safe to remove the stage. CASCADE on FKs cleans receiptRows (none)
    // and self-ref children (none — guarded above).
    await this.prisma.castingBatchItem.delete({ where: { id } });
    await this.recomputeBatchStatus(stage.batchId);
    // Audit only — restoring the deleted stage row is non-trivial (FKs,
    // lineKey graph, slip grouping). Not auto-undoable. The operator
    // can re-add via "+ Add design" or by forwarding from the parent.
    await this.audit.log(userId, {
      action: 'casting.stage.delete',
      targetType: 'CastingBatchItem',
      targetId: id,
      description: `Deleted stage #${id}${stage.itemNumber ? ' (#' + stage.itemNumber + ')' : ''} from batch #${stage.batchId}`,
      snapshotBefore: { id: stage.id, batchId: stage.batchId, itemId: stage.itemId, itemNumber: stage.itemNumber, vendorId: stage.vendorId, quantity: stage.quantity, color: stage.color, processId: stage.processId, parentItemId: stage.parentItemId },
    });
    return { id, batchId: stage.batchId };
  }

  /**
   * Public preview of the sticking BOM × qty × (1 + buffer%) — used by the
   * Forward dialog to show the user the editable default issue qty per material
   * variant BEFORE the forward fires. Returns a flat list aggregated across
   * multiple colours (when forwarding several colour-lots in one go) plus the
   * default issue qty (which may then be overridden via materialIssueOverride).
   */
  async previewStickingIssue(
    itemId: number,
    splits: { color?: string | null; quantity: number }[],
    bufferPercent = 0,
  ) {
    if (!splits?.length) return { lines: [] };
    const agg = new Map<number, any>();
    for (const s of splits) {
      if (!s.quantity || s.quantity <= 0) continue;
      const bom = await this.buildStickingBom(itemId, s.quantity, s.color ?? null);
      for (const b of bom) {
        const cur = agg.get(b.variantId) ?? {
          variantId: b.variantId,
          variantCode: b.variantCode,
          variantName: b.variantName,
          unit: b.unit,
          required: 0,
          // Breakdown so the UI can show "qty × perPiece = required" per
          // colour split — matches the old-ERP voucher format the user
          // expects ("101 × 48 = 4848").
          breakdown: [] as { color: string | null; qty: number; perPiece: number; subtotal: number }[],
        };
        const perPiece = Number((b as any).perPiece ?? 0);
        const subtotal = Number(b.required);
        cur.required += subtotal;
        cur.breakdown.push({
          color: s.color ?? null,
          qty: s.quantity,
          perPiece,
          subtotal,
        });
        agg.set(b.variantId, cur);
      }
    }
    // Pull current stock for context (so the dialog can flag shortages).
    const variantIds = Array.from(agg.keys());
    const variants = variantIds.length
      ? await this.prisma.materialVariant.findMany({ where: { id: { in: variantIds } } })
      : [];
    const stockById = new Map(variants.map((v) => [v.id, Number(v.stockQty)]));
    const lines = Array.from(agg.values()).map((r) => {
      const required = Math.round(r.required * 1000) / 1000;
      const defaultIssue = Math.max(0, Math.ceil(required * (1 + (bufferPercent || 0) / 100)));
      // Collapse breakdown by unique perPiece — if every split has the same
      // perPiece (the common single-colour case) the row shows one neat
      // "totalPcs × perPiece = required" instead of a wall of split rows.
      const totalPcs = r.breakdown.reduce((s: number, b: any) => s + b.qty, 0);
      const distinctPerPieces = new Set(r.breakdown.map((b: any) => b.perPiece));
      const perPiece = distinctPerPieces.size === 1 ? r.breakdown[0].perPiece : null;
      return {
        variantId: r.variantId,
        variantCode: r.variantCode,
        variantName: r.variantName,
        unit: r.unit,
        required,
        defaultIssue,
        stockQty: stockById.get(r.variantId) ?? 0,
        // Per-row calc surface for the UI:
        //   perPiece + totalPcs  → if same across splits → show "N × P = R"
        //   breakdown[]           → if mixed → show each split line
        perPiece,
        totalPcs,
        breakdown: r.breakdown,
      };
    });
    return { lines };
  }

  /**
   * Build the sticking BOM (stage colour + colourless common lines) for an item.
   * Both perPiece and required are forced to WHOLE NUMBERS — you can't issue
   * 0.95 of a stone. Any historical decimal BOM rows get rounded up here too.
   */
  private async buildStickingBom(
    itemId: number, stageQty: number, stageColor?: string | null,
    processCode: string = 'STICKING',
  ) {
    // Pull BOM rows for THIS process from ItemMaterial. The same table holds
    // BOM for every bomCapable process (Filing, Kacha Fitting, Fitting+Mala,
    // Sticking); the process FK filters to just the rows that apply here.
    // Sticking is per-colour; the others share one BOM across colours, so
    // stageColor is only used to filter when it's actually meaningful.
    const all = await this.prisma.itemMaterial.findMany({
      where: { itemId, process: { code: processCode } },
      include: { variant: true },
    });
    const sc = (stageColor ?? '').trim().toLowerCase();
    const bom = all.filter((l) => !l.color || (sc && l.color.trim().toLowerCase() === sc));
    return bom.map((line) => {
      const perPiece = Math.max(1, Math.round(Number(line.quantity)));
      const perPieceWeight = Number(line.weight ?? 0); // grams per piece (silver ERP — stones, silver)
      return {
        variantId: line.variantId,
        variantCode: line.variant.variantCode,
        variantName: line.variant.variantName,
        unit: line.variant.unit ?? null,
        perPiece,
        perPieceWeight,
        required: perPiece * stageQty,
        requiredWeight: Math.round(perPieceWeight * stageQty * 1000) / 1000,
      };
    });
  }

  /** Persist an immutable BOM snapshot onto a BOM-capable stage at issue time. */
  private async snapshotStageBom(
    stageId: number, itemId: number, stageQty: number, stageColor?: string | null,
  ) {
    const stage = await this.prisma.castingBatchItem.findUnique({
      where: { id: stageId },
      select: { stageProcess: { select: { code: true } } },
    });
    const code = stage?.stageProcess?.code ?? 'STICKING';
    const snapshot = await this.buildStickingBom(itemId, stageQty, stageColor, code);
    await this.prisma.castingBatchItem.update({ where: { id: stageId }, data: { bomSnapshot: snapshot } });
  }

  /**
   * Auto-create a material-issue voucher when forwarding to Sticking — replaces
   * the old "silent stock consumption" with a real, trackable vendor movement.
   * Qty per line = ceil(BOM × stageQty × (1 + buffer%)), always a whole number.
   * If `override` is supplied (user explicitly typed qty per variant at issue time),
   * those numbers WIN — we still merge with any BOM-derived variant that wasn't
   * overridden so the user can omit a line and keep the BOM default for the rest.
   */
  private async autoIssueStickingMaterials(
    stageId: number, itemId: number, stageQty: number, stageColor: string | null | undefined,
    vendorId: number, batchId: number,
    bufferPercent: number,
    override?: { variantId: number; issuedQty: number }[],
    userId?: number,
  ) {
    // Look up the stage's process code so we BOM-filter correctly. For non-
    // Sticking BOM processes this returns BOM lines keyed by that process
    // (Filing / Kacha Fitting / Fitting+Mala) instead of always Sticking.
    const stage = await this.prisma.castingBatchItem.findUnique({
      where: { id: stageId },
      select: { stageProcess: { select: { code: true } } },
    });
    const stageProcessCode = stage?.stageProcess?.code ?? 'STICKING';
    const bom = await this.buildStickingBom(itemId, stageQty, stageColor, stageProcessCode);
    const overrideMap = new Map<number, number>();
    for (const o of override ?? []) {
      const q = Math.max(0, Math.trunc(Number(o.issuedQty) || 0));
      overrideMap.set(o.variantId, q);
    }
    // Vendor-holdings net-out: when no override is given for a variant, we
    // must subtract what this vendor ALREADY physically holds from previous
    // open material-issues, otherwise auto-routes (plan-forward on receipt,
    // settle-on-batch-create) re-issue the full BOM and pile material on
    // top of what's already at the karigar. The Forward Dialog does this on
    // the client; this is the equivalent guard for server-only flows.
    const heldByVariant = new Map<number, number>();
    const openIssues = await this.prisma.materialIssue.findMany({
      where: { vendorId, status: { not: 'CLOSED' } },
      include: { lines: true },
    });
    for (const iss of openIssues) {
      for (const ln of iss.lines) {
        const held = Math.max(0, ln.issuedQty - ln.receivedQty - ((ln as any).consumedQty ?? 0));
        if (held <= 0) continue;
        heldByVariant.set(ln.variantId, (heldByVariant.get(ln.variantId) ?? 0) + held);
      }
    }
    const lines = bom
      .map((b) => {
        if (overrideMap.has(b.variantId)) {
          return { variantId: b.variantId, issuedQty: overrideMap.get(b.variantId)! };
        }
        // Net out what vendor already holds, then add the buffer back on top.
        const needNet = Math.max(0, Number(b.required) - (heldByVariant.get(b.variantId) ?? 0));
        const withBuffer = Math.ceil(needNet * (1 + (bufferPercent || 0) / 100));
        return { variantId: b.variantId, issuedQty: Math.max(0, withBuffer) };
      })
      .filter((l) => l.issuedQty > 0);
    // Allow user-added variants that aren't in the item's BOM at all (rare, but
    // supports "I want to also send these extra studs not in BOM").
    const bomVariantIds = new Set(bom.map((b) => b.variantId));
    for (const [variantId, issuedQty] of overrideMap) {
      if (!bomVariantIds.has(variantId) && issuedQty > 0) {
        lines.push({ variantId, issuedQty });
      }
    }
    if (!lines.length) return null;
    // STOCK SOFT-GUARD — issue what we HAVE, defer the rest. This mirrors the
    // real-world scenario where the karigar's batch is started today but some
    // materials only arrive tomorrow. When stock IN later happens, the user is
    // prompted to issue the deferred qty (see issueDeferred + pendingDemand).
    const variants = await this.prisma.materialVariant.findMany({
      where: { id: { in: lines.map((l) => l.variantId) } },
    });
    const stockById = new Map(variants.map((v) => [v.id, Math.round(Number(v.stockQty))]));
    const adjustedLines: { variantId: number; issuedQty: number; deferredQty: number }[] = [];
    for (const l of lines) {
      const have = stockById.get(l.variantId) ?? 0;
      const willIssue = Math.min(l.issuedQty, have);
      const willDefer = l.issuedQty - willIssue;
      adjustedLines.push({ variantId: l.variantId, issuedQty: willIssue, deferredQty: willDefer });
    }
    return this.materialIssues.createWithDeferred(
      { vendorId, batchId, stageId, lines: adjustedLines, notes: `Auto-issued for sticking stage ${stageId}` },
      userId,
    );
  }

  /** Consume BOM stock for one Sticking stage — WHOLE NUMBERS only. */
  private async consumeStageStickingMaterials(stageId: number, itemId: number, stageQty: number, stageColor?: string | null, userId?: number) {
    const all = await this.prisma.itemMaterial.findMany({ where: { itemId } });
    const sc = (stageColor ?? '').trim().toLowerCase();
    const bom = all.filter((l) => !l.color || (sc && l.color.trim().toLowerCase() === sc));
    for (const line of bom) {
      const qty = Math.round(Number(line.quantity)) * stageQty;
      if (qty <= 0) continue;
      const v = await this.prisma.materialVariant.findUnique({ where: { id: line.variantId } });
      if (!v) continue;
      const balanceAfter = Math.max(0, Math.round(Number(v.stockQty)) - qty);
      await this.prisma.$transaction([
        this.prisma.materialVariant.update({ where: { id: line.variantId }, data: { stockQty: balanceAfter } }),
        this.prisma.stockMovement.create({
          data: {
            variantId: line.variantId, type: 'OUT', quantity: -qty, balanceAfter,
            refType: 'sticking_stage', refId: stageId,
            note: `Sticking stage ${stageId} consumption`, createdById: userId ?? null,
          },
        }),
      ]);
    }
  }

  /** Reverse a single stage's sticking consumption (used when a batch is deleted). */
  private async reverseStageSticking(stageId: number) {
    const moves = await this.prisma.stockMovement.findMany({ where: { refType: 'sticking_stage', refId: stageId } });
    for (const mv of moves) {
      const v = await this.prisma.materialVariant.findUnique({ where: { id: mv.variantId } });
      if (!v) continue;
      const balanceAfter = Math.round((Number(v.stockQty) - Number(mv.quantity)) * 1000) / 1000;
      await this.prisma.materialVariant.update({ where: { id: mv.variantId }, data: { stockQty: balanceAfter } });
    }
    await this.prisma.stockMovement.deleteMany({ where: { refType: 'sticking_stage', refId: stageId } });
  }

  /**
   * Consume material-variant stock for a Sticking batch: for each item line,
   * required = Σ (BOM qty × batch qty × (1 + wastage%)). Records OUT movements
   * referencing the batch; stock may go negative (shortage) and is flagged elsewhere.
   */
  private async consumeStickingMaterials(batchId: number, processCode: string, userId?: number) {
    if (processCode !== 'STICKING') return;
    const items = await this.prisma.castingBatchItem.findMany({
      where: { batchId, itemId: { not: null } },
    });
    const need = new Map<number, number>(); // variantId -> total qty
    for (const bi of items) {
      const bom = await this.prisma.itemMaterial.findMany({ where: { itemId: bi.itemId! } });
      for (const line of bom) {
        const qty = Number(line.quantity) * bi.quantity;
        if (qty > 0) need.set(line.variantId, (need.get(line.variantId) ?? 0) + qty);
      }
    }
    for (const [variantId, qtyRaw] of need) {
      const qty = Math.round(qtyRaw);
      const v = await this.prisma.materialVariant.findUnique({ where: { id: variantId } });
      if (!v) continue;
      const balanceAfter = Math.max(0, Math.round(Number(v.stockQty)) - qty);
      await this.prisma.$transaction([
        this.prisma.materialVariant.update({ where: { id: variantId }, data: { stockQty: balanceAfter } }),
        this.prisma.stockMovement.create({
          data: {
            variantId, type: 'OUT', quantity: -qty, balanceAfter,
            refType: 'sticking_batch', refId: batchId,
            note: `Sticking batch ${batchId} consumption`, createdById: userId ?? null,
          },
        }),
      ]);
    }
  }

  /** Reverse a batch's sticking consumption (on edit/delete). */
  private async reverseStickingMaterials(batchId: number) {
    const moves = await this.prisma.stockMovement.findMany({
      where: { refType: 'sticking_batch', refId: batchId },
    });
    for (const mv of moves) {
      const v = await this.prisma.materialVariant.findUnique({ where: { id: mv.variantId } });
      if (!v) continue;
      // mv.quantity is negative (OUT); subtracting it adds the stock back.
      const balanceAfter = Math.round((Number(v.stockQty) - Number(mv.quantity)) * 1000) / 1000;
      await this.prisma.materialVariant.update({ where: { id: mv.variantId }, data: { stockQty: balanceAfter } });
    }
    await this.prisma.stockMovement.deleteMany({ where: { refType: 'sticking_batch', refId: batchId } });
  }

  /**
   * Edit a batch. Items are reconciled by id: existing ids are updated,
   * missing ids are deleted (cascading their receipts), new rows created.
   */
  async updateBatch(id: number, dto: CreateBatchDto, role?: string | null) {
    await this.assertBatchEditable(id, role);
    const batch = await this.prisma.castingBatch.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!batch) throw new NotFoundException('Batch not found.');

    const processId = dto.processId ?? batch.processId;
    const process = processId ? await this.prisma.process.findUnique({ where: { id: processId } }) : null;
    const processCode = process?.code ?? 'CASTING';

    await this.prisma.castingBatch.update({
      where: { id },
      data: { processId: processId ?? undefined, batchDate: new Date(dto.batchDate), notes: dto.notes ?? null },
    });

    const keepIds = dto.items.filter((i) => i.id).map((i) => i.id!) as number[];
    await this.prisma.castingBatchItem.deleteMany({
      where: { batchId: id, id: { notIn: keepIds.length ? keepIds : [0] } },
    });

    for (const it of dto.items) {
      const data = await this.resolveRow(processId!, processCode, it);
      if (it.id) {
        await this.prisma.castingBatchItem.update({ where: { id: it.id }, data });
      } else {
        await this.prisma.castingBatchItem.create({ data: { batchId: id, ...data } });
      }
    }

    // Re-sync sticking consumption to the new item set.
    await this.reverseStickingMaterials(id);
    await this.consumeStickingMaterials(id, processCode);
    await this.recomputeBatchStatus(id);
    return { id, batchNumber: batch.batchNumber };
  }

  /**
   * Append a single design row to an EXISTING batch — used when the
   * operator realises (mid-batch) that one more design needs to enter
   * production alongside the others. Creates a root Casting stage in
   * the target batch, runs the same auto-sync helpers as createBatch
   * (vendor + rate + weight mirror to Item Master). Bypasses the full
   * updateBatch reconcile path so the existing rows + their receipts
   * stay untouched.
   *
   * Only allowed on OPEN batches (not short-closed) — closed batches are
   * a settled state; adding to one would create a phantom open line on
   * a "closed" batch. Operator can reopen first, then add.
   */
  async addBatchDesign(batchId: number, row: CastingBatchItemDto, userId?: number, role?: string | null) {
    await this.assertBatchEditable(batchId, role);
    const batch = await this.prisma.castingBatch.findUnique({
      where: { id: batchId },
      select: { id: true, closed: true, processId: true },
    });
    if (!batch) throw new NotFoundException('Batch not found.');
    if (batch.closed) {
      throw new BadRequestException('Cannot add a design — batch is short-closed. Reopen it first.');
    }
    const casting = await this.getEntryProcess();
    if (!casting) throw new NotFoundException('Entry process (CAM / Casting) is not configured.');

    // Resolve like createBatch does — validates Production-Ready, fills
    // defaults from item-master, throws cleanly on bad input.
    const data = await this.resolveRow(casting.id, casting.code, row);

    // sortOrder = max + 1 within this batch so the new line lands at the end.
    const maxOrder = await this.prisma.castingBatchItem.aggregate({
      where: { batchId },
      _max: { sortOrder: true },
    });

    const created = await this.prisma.castingBatchItem.create({
      data: {
        batchId,
        ...data,
        processId: casting.id,
        colorModel: row.colorModel ?? null,
        color: row.color ?? null,
        sortOrder: (maxOrder._max.sortOrder ?? 0) + 1,
      },
    });
    // lineKey roots at itself — every future forwarded child carries this.
    await this.prisma.castingBatchItem.update({
      where: { id: created.id },
      data: { lineKey: String(created.id) },
    });
    await this.assignIssueSlip(created.id);
    await this.recomputeBatchStatus(batchId);

    // Auto-sync rate, vendor, weight to Item Master — same three steps the
    // createBatch loop runs, kept consistent so a "added later" line gets
    // the same master-fill behaviour as a "added at creation" line.
    const rateUpdates: NonNullable<Awaited<ReturnType<typeof this.syncProcessRateToItem>>>[] = [];
    const tempWeightFlagged: number[] = [];
    if (row.itemId) {
      if (row.costPerKg != null) {
        const sync = await this.syncProcessRateToItem(
          row.itemId,
          casting.id,
          Number(row.costPerKg),
          row.vendorId ?? null,
        );
        if (sync) rateUpdates.push(sync);
      }
      if (row.vendorId) {
        await this.ensureProcessVendor({
          itemId: row.itemId,
          processId: casting.id,
          vendorId: row.vendorId,
          color: null,
          costPerPiece: row.costPerKg ?? null,
          vendorDesignReference: row.vendorDesignReference,
        });
      }
      if (row.weight != null && Number(row.weight) > 0) {
        await this.ensureProcessAttribute(row.itemId, casting.id, 'weight', String(row.weight));
        if (row.castingWeightTemporary) {
          const flagged = await this.markCastingWeightTemporary(row.itemId);
          if (flagged) tempWeightFlagged.push(row.itemId);
        }
      }
    }
    // `userId` is currently unused — the audit trail for stage creation
    // lives in the batch's createdBy + the issue-slip grouping. Reserved
    // for future per-line audit if needed.
    void userId;
    // Audit — undoable via casting.batch.addDesign (deleteForwardedStage
    // works on root stages too as of the batch-CRUD changes).
    await this.audit.log(userId, {
      action: 'casting.batch.addDesign',
      targetType: 'CastingBatchItem',
      targetId: created.id,
      description: `Added design #${row.itemNumber ?? row.itemId ?? '?'} (${row.quantity} pcs) to batch #${batchId}`,
      snapshotAfter: { id: created.id, batchId, itemId: row.itemId, quantity: row.quantity, vendorId: row.vendorId },
      undoStrategy: 'casting.batch.addDesign',
    });
    return { id: created.id, batchId, rateUpdates, tempWeightFlagged };
  }

  async listBatches(query: BatchQueryDto) {
    const where: Prisma.CastingBatchWhereInput = {};
    if (query.status) where.status = query.status as any;
    if (query.search) {
      // Global search across the batches grid — operator types ANY of:
      //   • batch number   ("B0042")
      //   • vendor name    ("Krishna Casting Works")
      //   • our item code  ("6094")
      //   • vendor design ref ("8748")  ← vendor's own item code on the slip
      //   • item name      ("Royal Earrings")
      // Each hit lights up the batch. The frontend surfaces WHICH design /
      // ref matched alongside the batch row so the operator can see why
      // a particular batch came up.
      const q = query.search;
      // Deep search — hits every text column an operator might remember,
      // all the way down to notes on the item, per-process, per-vendor,
      // and BOM lines. Case-insensitive so "Krishna" and "krishna" match.
      // Batch notes are last because they're the least-structured field.
      const insensitive = { contains: q, mode: 'insensitive' as const };
      where.OR = [
        { batchNumber: insensitive },
        { notes: insensitive },
        { items: { some: { vendor: { vendorName: insensitive } } } },
        { items: { some: { vendor: { shortName: insensitive } } } },
        { items: { some: { vendor: { notes: insensitive } } } },
        { items: { some: { itemNumber: insensitive } } },
        { items: { some: { itemName: insensitive } } },
        { items: { some: { vendorDesignReference: insensitive } } },
        { items: { some: { remarks: insensitive } } },
        { items: { some: { purpose: insensitive } } },
        // Item Master — live matches for snapshot-less older rows and
        // deeper text: name, notes, per-process notes, per-vendor notes,
        // per-BOM-line notes.
        { items: { some: { item: { sampleDesignCode: insensitive } } } },
        { items: { some: { item: { itemName: insensitive } } } },
        { items: { some: { item: { notes: insensitive } } } },
        { items: { some: { item: { processes: { some: { notes: insensitive } } } } } },
        { items: { some: { item: { processes: { some: { vendors: { some: { notes: insensitive } } } } } } } },
        { items: { some: { item: { materials: { some: { notes: insensitive } } } } } },
      ];
    }
    const batches = await this.prisma.castingBatch.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        // repairOrders included so completion logic can detect pending
        // repairs (a stage with an OPEN repair is NOT done — vendor still
        // has pcs we're waiting on).
        items: { include: { vendor: true, receiptRows: true, stageProcess: true, repairOrders: true } },
        // finishedVariants + box movements drive the post-packing dispatch
        // lifecycle: a batch is only TRULY "Completed" once every box has
        // left the Dispatch Center for a Warehouse. Until then the batch
        // stays active so it's visible on Production Management.
        finishedVariants: { include: { boxGroups: { include: { movements: { select: { fromLocationId: true, toLocationId: true, boxCount: true } } } } } },
      },
    });

    // Dispatch Center id is constant per install — look it up once and
    // reuse across all batches in this list.
    const dispatchCenter = await this.prisma.warehouse.findFirst({ where: { kind: 'DISPATCH' } });

    return batches.map((b) => {
      const vendors = Array.from(
        new Map(b.items.map((i) => [i.vendorId, i.vendor.vendorName])).entries(),
      ).map(([id, name]) => ({ id, name }));

      // Traveler metrics: distinct DESIGNS in this batch + pieces ordered
      // into production (root casting stages only), and how many stages are
      // still awaiting receipt.
      //
      // designCount counts DISTINCT itemNumbers (the user-facing design code).
      // The old `lineKeys.size` overcounted because each colour split + each
      // settle-absorb gets its own lineKey — so one design with 5 colour
      // splits looked like 5 designs. We count itemNumber (with itemId as
      // tiebreaker for ad-hoc rows that have no number), which matches the
      // user's mental model: "how many products went into this batch?".
      const designKeys = new Set<string>();
      for (const it of b.items) {
        // Empty-string snapshot was failing the truthy guard below, leaving
        // batches with un-snapshotted rows reading "0 designs". Treat empty
        // as null and fall through to itemId so we count one distinct
        // design per linked item regardless of snapshot state.
        const trimmed = (it.itemNumber ?? '').trim();
        const k = trimmed || (it.itemId != null ? `id:${it.itemId}` : null);
        if (k) designKeys.add(k);
      }
      // A "root" stage for THIS batch is one whose parent is NOT in this
      // batch. That covers:
      //   • Fresh Casting roots (parentItemId == null), AND
      //   • Cross-batch absorbs / excess routing where the parent stage
      //     lives in a different batch (so within THIS batch's scope, the
      //     absorbed stage IS the starting point).
      // The old strict "parentItemId == null" rule missed absorb-only batches
      // entirely, making "pcs ordered" come out as 0.
      const stageIdSet = new Set(b.items.map((i) => i.id));
      const rootStages = b.items.filter((i) => i.parentItemId == null || !stageIdSet.has(i.parentItemId));
      const piecesOrdered = rootStages.reduce((s, i) => s + i.quantity, 0);
      let openStages = 0;
      for (const it of b.items) {
        if (it.closed) continue;
        // Settled qty = accepted + rejected (rejected is written off,
        // accepted is in our hands). Open repair pcs are with the vendor,
        // so the stage is NOT settled if any pending repair exists.
        const accepted = it.receiptRows.reduce((rs, r) => rs + r.acceptedQty, 0);
        const rejected = it.receiptRows.reduce((rs, r) => rs + r.rejectedQty, 0);
        const openRepairs = it.repairOrders.filter((r) => r.status === 'OPEN').reduce((s, r) => s + r.qty, 0);
        if (it.quantity - accepted - rejected > 0 || openRepairs > 0) openStages++;
      }
      // Distinct processes reached so far in this batch (in display order).
      const processNames = Array.from(
        new Map(b.items.filter((i) => i.stageProcess).map((i) => [i.stageProcess!.sortOrder, i.stageProcess!.name])).entries(),
      ).sort((a, c) => a[0] - c[0]).map(([, n]) => n);

      // Lifecycle: a batch is Completed when every NON-CLOSED stage has been
      // fully received. With colour-split chains, intermediate lineKeys (e.g.
      // the colourless Casting root) never have a Packing stage — they fork
      // into multiple colour lines that each terminate at Packing. So the
      // old "every lineKey must have a packed stage" check wrongly kept
      // multi-colour batches stuck at In Process forever. Now we simply
      // verify nothing's still pending across the whole batch.
      const anyReceived = b.items.some((i) => i.receiptRows.reduce((rs, r) => rs + r.acceptedQty + r.rejectedQty, 0) > 0);
      // Completion check — EVERY stage must require no further action:
      //   • closed (short-closed = settled), OR
      //   • received >= quantity AND
      //     (Packing → final step, no forward needed) OR
      //     (intermediate → forwarded >= received, i.e. no idle pcs
      //                     sitting here waiting to be moved on)
      //
      // The earlier "leaves only" logic missed the idle-pcs case: a Casting
      // stage with received=144, forwarded=108 has 36 idle pcs that still
      // need a forward, but it isn't a leaf (it has children), so the old
      // check skipped it — batch read as Completed. Now every stage is
      // evaluated; intermediate stages with leftover idle pcs keep the
      // batch In Process.
      const forwardedByBatchStage = new Map<number, number>();
      for (const it of b.items) {
        if (it.parentItemId != null) {
          forwardedByBatchStage.set(it.parentItemId, (forwardedByBatchStage.get(it.parentItemId) ?? 0) + it.quantity);
        }
      }
      // Has any stage been short-closed? Used to surface the batch under "Short-Closed".
      // Computed BEFORE displayStatus so a short-bearing batch reads as
      // "Closed (shorts)" instead of plain "Completed" — otherwise the
      // Production Management filter (which drops "Completed") would hide
      // the batch entirely and the short-closed qty would silently
      // disappear from view, even though it's still owed on the ledger.
      const hasShorts = b.items.some((it) => it.closed && (it.shortQty ?? 0) > 0);

      const allComplete = anyReceived && b.items.length > 0 && b.items.every((it) => {
        if (it.closed) return true;
        // Vendor's debt = quantity - accepted - rejected - openRepairs.
        // Stage is "done" when debt is zero (no pending repairs, fully settled).
        const accepted = it.receiptRows.reduce((rs, r) => rs + r.acceptedQty, 0);
        const rejected = it.receiptRows.reduce((rs, r) => rs + r.rejectedQty, 0);
        const openRepairs = it.repairOrders.filter((r) => r.status === 'OPEN').reduce((s, r) => s + r.qty, 0);
        if (accepted + rejected < it.quantity) return false;
        if (openRepairs > 0) return false;
        if (it.stageProcess?.code === 'PACKING') return true;
        const fwd = forwardedByBatchStage.get(it.id) ?? 0;
        return fwd >= accepted;
      });
      let displayStatus = !allComplete
        ? (anyReceived ? 'In Process' : 'Issued')
        : hasShorts
          ? 'Closed (shorts)'
          : 'Completed';

      // Post-packing dispatch lifecycle: once manufacturing is "done" but
      // before all pcs have left the Dispatch Center for a warehouse, the
      // batch is still active work. Keep it on Production Management with
      // a clearer label so the user knows what's needed next.
      //   • Awaiting Categorization → packed pcs not yet split into
      //     collections (no FinishedGoodVariants created yet, or partially
      //     categorized).
      //   • At Dispatch Center → categorized but some boxes still sitting
      //     at DC awaiting shipment to a warehouse.
      //   • Completed (the existing label) → every box has left DC.
      if (displayStatus === 'Completed') {
        const totalPackedSystem = b.items
          .filter((i) => i.stageProcess?.code === 'PACKING')
          .reduce((s, i) => s + i.receiptRows.reduce((rs, r) => rs + r.acceptedQty, 0), 0);
        if (totalPackedSystem > 0) {
          const totalCategorized = b.finishedVariants.reduce((s, v) => s + v.totalPcs + v.lossPcs, 0);
          let anyAtDc = false;
          if (dispatchCenter) {
            outer: for (const v of b.finishedVariants) {
              for (const bg of v.boxGroups) {
                let n = 0;
                for (const m of bg.movements) {
                  if (m.toLocationId === dispatchCenter.id) n += m.boxCount;
                  if (m.fromLocationId === dispatchCenter.id) n -= m.boxCount;
                }
                if (n > 0) { anyAtDc = true; break outer; }
              }
            }
          }
          if (totalCategorized < totalPackedSystem) displayStatus = 'Awaiting Categorization';
          else if (anyAtDc) displayStatus = 'At Dispatch Center';
          // else: fully dispatched — keep 'Completed' (graduates to Batch Inventory).
        }
      }
      // Short-closed pcs + stage counts — surfaced as badges on the batch
      // row in Production Management + on the per-design header inside the
      // batch detail so the user sees "lost to short-close" at a glance.
      const shortClosedStages = b.items.filter((it) => it.closed).length;
      const shortClosedQty = b.items.reduce((s, it) => s + (it.closed ? (it.shortQty ?? 0) : 0), 0);
      // Slip count — distinct issueSlipId values across this batch. >1 means
      // partial issuances split into multiple slips; user gets a clear badge
      // so they know to look at the per-stage slip picker.
      const slipCount = new Set(b.items.map((it) => it.issueSlipId ?? it.id)).size;
      // Item numbers in this batch (for design-number search in Batch Inventory).
      const designNumbers = Array.from(
        new Set(
          b.items
            .map((it) => it.itemNumber)
            .filter((n): n is string => !!n && n !== ''),
        ),
      );
      // When the operator typed a search term, surface the stages that
      // matched so the frontend can show "matched on #6094 · Royal
      // Earrings · vendor ref 8748". Distinct by (itemNumber × vendor
      // design ref) so we don't list the same design five times once per
      // colour. Empty when there's no search query.
      let matchedItems: Array<{ itemNumber: string | null; itemName: string | null; vendorDesignReference: string | null }> = [];
      if (query.search) {
        const q = query.search.toLowerCase();
        const seen = new Set<string>();
        for (const it of b.items) {
          const itemNum = (it.itemNumber ?? '').toLowerCase();
          const ref = (it.vendorDesignReference ?? '').toLowerCase();
          const name = (it.itemName ?? '').toLowerCase();
          const vendName = (it.vendor.vendorName ?? '').toLowerCase();
          const hits = itemNum.includes(q) || ref.includes(q) || name.includes(q) || vendName.includes(q);
          if (!hits) continue;
          const key = `${it.itemNumber ?? ''}::${it.vendorDesignReference ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          matchedItems.push({
            itemNumber: it.itemNumber ?? null,
            itemName: it.itemName ?? null,
            vendorDesignReference: it.vendorDesignReference ?? null,
          });
        }
      }
      // 3-hour batch-edit window — used by the frontend to disable Edit /
      // Add Design / Delete buttons once the grace period expires (admins
      // can still edit). The lock timestamp is when the grace ENDS, not
      // when it started — frontend just compares against Date.now().
      const editLockedAt = new Date(
        new Date(b.createdAt).getTime() + CastingService.BATCH_EDIT_GRACE_HOURS * 60 * 60 * 1000,
      );
      return {
        id: b.id,
        batchNumber: b.batchNumber,
        batchDate: b.batchDate,
        createdAt: b.createdAt,
        editLockedAt,
        status: b.status,
        displayStatus,
        notes: b.notes,
        // Batch-level short-close — drives the Batch Inventory "Short-Closed" folder.
        closed: b.closed,
        closedAt: b.closedAt,
        closedReason: b.closedReason,
        designCount: designKeys.size,
        piecesOrdered,
        openStages,
        stageCount: b.items.length,
        processNames,
        vendors,
        hasShorts,
        shortClosedStages,
        shortClosedQty,
        slipCount,
        designNumbers,
        matchedItems,
      };
    });
  }

  async getBatch(id: number) {
    const batch = await this.prisma.castingBatch.findUnique({
      where: { id },
      include: {
        process: true,
        items: {
          include: {
            vendor: true,
            stageProcess: true,
            repairOrders: true,
            // Live join — falls back here when the stage's snapshot
            // `itemNumber` is empty (older rows from before the design-
            // code-as-snapshot change). New rows write sampleDesignCode
            // directly into itemNumber so the join is just a safety net.
            item: { select: { sampleDesignCode: true, itemNumber: true } },
          },
          orderBy: [{ lineKey: 'asc' }, { sortOrder: 'asc' }],
        },
        receipts: {
          include: { vendor: true, items: { include: { batchItem: { include: { stageProcess: true } } } } },
          orderBy: { receiptDate: 'asc' },
        },
      },
    });
    if (!batch) throw new NotFoundException('Batch not found.');

    // received totals per batch item — plus the LATEST receipt date so the
    // stage row can show "work date" instead of just stage createdAt. If a
    // process was actually done yesterday and recorded today, the receipt
    // carries yesterday's date (user-entered on the receive form). That's
    // the date users mean when they ask "when was this process done?".
    const receivedByItem = new Map<number, {
      qty: number; weight: number; accepted: number; repair: number; rejected: number;
      latestReceiptDate: Date | null;
    }>();
    for (const r of batch.receipts) {
      for (const ri of r.items) {
        const cur = receivedByItem.get(ri.batchItemId) ??
          { qty: 0, weight: 0, accepted: 0, repair: 0, rejected: 0, latestReceiptDate: null };
        cur.qty += ri.receivedQty;
        cur.weight += Number(ri.receivedWeight);
        cur.accepted += ri.acceptedQty;
        cur.repair += ri.repairQty;
        cur.rejected += ri.rejectedQty;
        const d = r.receiptDate;
        if (d && (!cur.latestReceiptDate || d > cur.latestReceiptDate)) cur.latestReceiptDate = d;
        receivedByItem.set(ri.batchItemId, cur);
      }
    }

    // Forwarded-out totals per stage (sum of child stages' qty) — counted ACROSS
    // batches because settled pieces can land in a different (new) batch.
    const stageIds = batch.items.map((i) => i.id);
    const externalChildren = stageIds.length
      ? await this.prisma.castingBatchItem.findMany({
          where: { parentItemId: { in: stageIds } },
          select: { parentItemId: true, quantity: true },
        })
      : [];
    const forwardedByParent = new Map<number, number>();
    for (const c of externalChildren) {
      if (c.parentItemId != null) {
        forwardedByParent.set(c.parentItemId, (forwardedByParent.get(c.parentItemId) ?? 0) + c.quantity);
      }
    }

    // Colour-model counts for the designs used in this batch.
    const itemIds = Array.from(new Set(batch.items.map((i) => i.itemId).filter((x): x is number => x != null)));
    const cmCounts = new Map<number, number>();
    if (itemIds.length) {
      const grouped = await this.prisma.itemColorModel.groupBy({ by: ['itemId'], where: { itemId: { in: itemIds } }, _count: { _all: true } });
      for (const g of grouped) cmCounts.set(g.itemId, g._count._all);
    }

    // Material status for STICKING stages — sums issued/deferred per material
    // so the UI can show "max producible = N pcs" based on actually-issued
    // raw material vs. what the BOM needs for the full stage quantity.
    //
    // Why only sticking? It's the only process whose stage carries a real BOM
    // (other steps are just labour). When raw material is short-issued (less
    // than full BOM) the karigar can only produce min(issued / perPiece) pcs.
    // Receive form will cap recd at that floor; the rest needs a follow-up
    // material issuance before vendor can complete the order.
    const stickingStageIds = batch.items
      .filter((it) => it.stageProcess?.code === 'STICKING')
      .map((it) => it.id);
    const materialStatusByStage = new Map<number, any>();
    if (stickingStageIds.length) {
      const issueRows = await this.prisma.materialIssue.findMany({
        where: { stageId: { in: stickingStageIds } },
        include: { lines: { include: { variant: { include: { material: true } } } } },
      });
      for (const sid of stickingStageIds) {
        const stage = batch.items.find((i) => i.id === sid);
        if (!stage) continue;
        const snap: any[] = Array.isArray(stage.bomSnapshot) ? (stage.bomSnapshot as any[]) : [];
        // Sum issued/deferred across all issues tied to THIS sticking stage.
        const perVariant = new Map<number, { issued: number; deferred: number; received: number; consumed: number; variantName: string; materialName: string; unit: string }>();
        for (const iss of issueRows) {
          if (iss.stageId !== sid) continue;
          for (const ln of iss.lines) {
            const cur = perVariant.get(ln.variantId) ?? {
              issued: 0, deferred: 0, received: 0, consumed: 0,
              variantName: ln.variant.variantName ?? '',
              materialName: ln.variant.material?.materialName ?? '',
              unit: ln.variant.material?.unit ?? 'pcs',
            };
            cur.issued += ln.issuedQty ?? 0;
            cur.deferred += ln.deferredQty ?? 0;
            cur.received += ln.receivedQty ?? 0;
            cur.consumed += ln.consumedQty ?? 0;
            perVariant.set(ln.variantId, cur);
          }
        }
        const stageQty = stage.quantity;
        const lines: any[] = [];
        let maxProducible = stageQty; // unconstrained if no BOM
        let totalDeferredCount = 0;
        for (const b of snap) {
          const variantId = Number(b.variantId);
          // BOM snapshot key is `perPiece` (set in buildStickingBom). Fall back
          // to legacy names for old snapshots.
          const perPiece = Number(b.perPiece ?? b.quantity ?? b.qtyPerPiece ?? 0);
          const required = b.required != null ? Number(b.required) : Math.ceil(perPiece * stageQty);
          const agg = perVariant.get(variantId);
          const issued = agg?.issued ?? 0;
          const deferred = agg?.deferred ?? 0;
          const stillToIssue = Math.max(0, required - issued);
          // How many finished pieces this material can actually support.
          const producibleFromThis = perPiece > 0 ? Math.floor(issued / perPiece) : stageQty;
          if (producibleFromThis < maxProducible) maxProducible = producibleFromThis;
          totalDeferredCount += deferred;
          lines.push({
            variantId,
            variantName: agg?.variantName ?? b.variantName ?? '',
            materialName: agg?.materialName ?? b.materialName ?? '',
            unit: agg?.unit ?? b.unit ?? 'pcs',
            perPiece,
            required,
            issued,
            deferred,
            stillToIssue,
            producibleFromThis,
          });
        }
        // If no BOM lines at all, leave maxProducible = stageQty (no constraint).
        // If BOM lines exist but materials cover the full qty, maxProducible = stageQty.
        materialStatusByStage.set(sid, {
          stageQty,
          maxProducible: Math.min(maxProducible, stageQty),
          materialsShort: maxProducible < stageQty,
          pendingMaterialCount: totalDeferredCount,
          pendingPiecesAwaitingMaterial: Math.max(0, stageQty - Math.min(maxProducible, stageQty)),
          lines,
        });
      }
    }

    const items = batch.items.map((it) => {
      const rec = receivedByItem.get(it.id) ?? { qty: 0, weight: 0, accepted: 0, repair: 0, rejected: 0, latestReceiptDate: null as Date | null };
      // Open repair qty = pcs currently at the vendor for re-repair (cycle 1, 2…).
      const openRepairQty = it.repairOrders
        .filter((r) => r.status === 'OPEN')
        .reduce((s, r) => s + r.qty, 0);
      const settledQty = rec.accepted + rec.rejected;
      // pendingQty = "vendor still owes us this much" — includes anything
      // out for repair as well as never-received pcs.
      const pendingQty = it.quantity - settledQty - openRepairQty;
      const forwardedQty = forwardedByParent.get(it.id) ?? 0;
      // ─────────────────────────────────────────────────────────────────
      // "Received" semantics — the display number the user expects to see
      // is "pcs the vendor has handed back AND are accounted for", i.e.
      // SETTLED (accepted + rejected). The raw sum of every receipt row
      // (`rec.qty`) double-counts repair-return rounds: when a repair
      // returns, its receivedQty is added on top of the original receipt
      // that already booked those pcs in its repairQty bucket. That made
      // displays like "Recd 110" on a 108-qty stage. We now expose:
      //   • receivedQty / receivedWeight = SETTLED (no double-count)
      //   • rawReceivedQty / rawReceivedWeight = sum of receipt rows
      //     (kept for receipt-deletion checks etc. that need the raw)
      // ─────────────────────────────────────────────────────────────────
      const perPcWt = it.quantity > 0 ? Number(it.totalWeight) / it.quantity : 0;
      const settledWeight = Math.round(perPcWt * settledQty * 1000) / 1000;
      // Design code = the karigar-facing identity. Prefer the row snapshot;
      // when empty (older rows), fall back to the linked design's
      // sampleDesignCode (TVM-001 etc.). Sales itemNumber surfaces as a
      // separate field for UIs that want both ("TVM-001 · ABN-0042").
      const designCode = (it.itemNumber && it.itemNumber.trim())
        || ((it as any).item?.sampleDesignCode ?? '')
        || '';
      return {
        id: it.id,
        itemId: it.itemId,
        itemNumber: designCode,
        designCode,
        salesItemNumber: (it as any).item?.itemNumber ?? null,
        itemName: it.itemName,
        processId: it.processId,
        processName: it.stageProcess?.name ?? batch.process?.name ?? '—',
        processCode: it.stageProcess?.code ?? null,
        parentItemId: it.parentItemId,
        lineKey: it.lineKey ?? String(it.id),
        issueSlipId: it.issueSlipId ?? it.id,
        issueSlipAt: it.issueSlipAt,
        colorModel: it.colorModel,
        color: it.color,
        colorModelsAvailable: it.itemId ? (cmCounts.get(it.itemId) ?? 0) : 0,
        vendorId: it.vendorId,
        vendorName: it.vendor.vendorName,
        vendorCode: it.vendor.vendorCode,
        vendorDesignReference: it.vendorDesignReference,
        weight: Number(it.weight),
        quantity: it.quantity,
        totalWeight: Number(it.totalWeight),
        costPerKg: it.costPerKg != null ? Number(it.costPerKg) : null,
        totalCost: it.totalCost != null ? Number(it.totalCost) : null,
        remarks: it.remarks,
        purpose: it.purpose,
        issueDate: it.issueDate ?? null,
        receivedQty: settledQty,
        receivedWeight: settledWeight,
        rawReceivedQty: rec.qty,
        rawReceivedWeight: rec.weight,
        // QC breakdown — surface accepted / repair / rejected counters
        // alongside receivedQty so the UI can show "100 received → 80
        // accepted · 15 in repair · 5 rejected".
        acceptedQty: rec.accepted,
        repairQty: rec.repair,
        rejectedQty: rec.rejected,
        openRepairQty,
        pendingQty,
        pendingWeight: Math.max(0, Math.round((Number(it.totalWeight) - settledWeight) * 1000) / 1000),
        excessShortQty: settledQty - it.quantity, // +excess / -short — based on SETTLED
        forwardedQty,
        // Forwardable pcs = accepted-and-not-yet-forwarded. Repair/rejected
        // pcs cannot move forward. Packing = terminal, never forwards.
        availableToForward: it.stageProcess?.code === 'PACKING' ? 0 : Math.max(rec.accepted - forwardedQty, 0),
        closed: it.closed,
        closedReason: it.closedReason,
        shortQty: it.shortQty,
        shortWeight: it.shortWeight != null ? Number(it.shortWeight) : null,
        done: it.closed || pendingQty <= 0,
        // Per-stage lifecycle status — uses SETTLED (so a stage with all
        // pcs accepted, none in flight for repair, shows Completed).
        status: it.closed ? 'Closed' : settledQty >= it.quantity ? 'Completed' : settledQty > 0 || openRepairQty > 0 ? 'Partial' : 'Pending',
        // Sticking-only: how many pieces can actually be produced given
        // raw materials issued so far. If less than `quantity`, the receive
        // form will cap recd at this and surface the pending-material gap.
        materialStatus: materialStatusByStage.get(it.id) ?? null,
        // Two dates the UI surfaces per stage:
        //  • forwardedAt  — when this stage was created (= forwarded onto)
        //  • workDate     — when the work actually happened (= latest
        //    receipt date entered by the operator). Falls back to
        //    forwardedAt if nothing has been received yet.
        forwardedAt: it.createdAt,
        workDate: rec.latestReceiptDate ?? it.createdAt,
      };
    });

    // Group stages into design lines (by lineKey) for the traveler view.
    const lineMap = new Map<string, any>();
    for (const it of items) {
      const key = it.lineKey;
      const line = lineMap.get(key) ?? {
        lineKey: key,
        itemId: it.itemId,
        itemNumber: it.itemNumber,
        itemName: it.itemName,
        colorModel: it.colorModel,
        colorModelsAvailable: it.colorModelsAvailable,
        stages: [] as any[],
      };
      line.stages.push(it);
      lineMap.set(key, line);
    }
    const lines = Array.from(lineMap.values());

    // Mark each line's completion + the batch lifecycle status.
    for (const line of lines) {
      const packed = line.stages.find((s: any) => s.processCode === 'PACKING' && s.receivedQty >= s.quantity && s.quantity > 0);
      line.completed = !!packed;
    }
    const anyReceived = items.some((it) => (it.acceptedQty + it.rejectedQty) > 0);
    // Completion check — EVERY stage must require no further action:
    //   • closed (short-closed = settled), OR
    //   • received >= quantity AND
    //     (Packing → final step, no forward needed) OR
    //     (intermediate → forwardedQty >= receivedQty, i.e. no idle pcs
    //                     sitting here waiting to move on)
    //
    // Old logic checked only LEAVES (stages with no children), which
    // missed the idle-pcs case: a Casting stage with received=144,
    // forwarded=108 has 36 idle pcs that still need a forward, but
    // wasn't a leaf so the old check skipped it — batch read Completed.
    const allLinesComplete = anyReceived && items.length > 0 && items.every((it: any) => {
      if (it.closed) return true;
      // Settled = accepted + rejected. Pending repairs disqualify.
      const settled = it.acceptedQty + it.rejectedQty;
      if (settled < it.quantity) return false;
      if ((it.openRepairQty ?? 0) > 0) return false;
      if (it.processCode === 'PACKING') return true;
      // Only accepted pcs are forwarded onward.
      return (it.forwardedQty ?? 0) >= it.acceptedQty;
    });
    // Mirror listBatches: distinguish "Closed (shorts)" from clean "Completed"
    // so the badge + filters downstream surface the short-closed pcs.
    const hasShorts = items.some((it: any) => it.closed && (it.shortQty ?? 0) > 0);
    const displayStatus = !allLinesComplete
      ? (anyReceived ? 'In Process' : 'Issued')
      : hasShorts
        ? 'Closed (shorts)'
        : 'Completed';

    // vendor grouping (for PDFs) + per-vendor completion (for the receive flow).
    // A vendor is "completed" ONLY when every stage is done AND no repair
    // orders against them are still open. Without the repair check, a
    // vendor whose entire qty was flagged for repair would have pendingQty=0
    // on every stage and so disappear from the receive form's vendor
    // dropdown — even though we're literally waiting for those repair pcs
    // to come back. The /repairs "Receive back" deep-link breaks in that
    // case (vendor not in options → can't pre-select).
    const repairStageIds = batch.items.map((i) => i.id);
    const openRepairs = repairStageIds.length
      ? await this.prisma.repairOrder.findMany({
          where: { stageId: { in: repairStageIds }, status: 'OPEN' },
          select: { vendorId: true, qty: true, stageId: true },
        })
      : [];
    const openRepairByVendor = new Map<number, { qty: number; orders: number }>();
    for (const r of openRepairs) {
      const cur = openRepairByVendor.get(r.vendorId) ?? { qty: 0, orders: 0 };
      cur.qty += r.qty;
      cur.orders += 1;
      openRepairByVendor.set(r.vendorId, cur);
    }
    const vendors = Array.from(
      new Map(batch.items.map((i) => [i.vendorId, i.vendor])).values(),
    ).map((v) => {
      const vendorItems = items.filter((it) => it.vendorId === v.id);
      const repairInfo = openRepairByVendor.get(v.id);
      const completed =
        vendorItems.length > 0 &&
        vendorItems.every((it) => it.done) &&
        !repairInfo; // any open repair from this vendor blocks "completed"
      return {
        id: v.id,
        vendorCode: v.vendorCode,
        vendorName: v.vendorName,
        completed,
        // Counts surfaced so the UI can show "(2 repair lots · 36 pcs)" next
        // to the vendor name and the new in-batch repair card knows what to
        // render. Zero/undefined when nothing's at repair from this vendor.
        openRepairQty: repairInfo?.qty ?? 0,
        openRepairOrders: repairInfo?.orders ?? 0,
      };
    });

    // Sticking batches: aggregate BOM material requirement vs current stock,
    // both overall (for inventory check) and grouped by vendor + design
    // (so the floor knows which materials go to whom for sticking).
    let materialRequirement: any[] = [];
    let materialByVendor: any[] = [];
    const stickingStages = batch.items.filter((bi) => bi.stageProcess?.code === 'STICKING');
    if (stickingStages.length) {
      const reqMap = new Map<number, any>();
      const vendorMap = new Map<number, any>();
      for (const bi of stickingStages) {
        if (!bi.itemId) continue;
        const allBom = await this.prisma.itemMaterial.findMany({
          where: { itemId: bi.itemId },
          include: { variant: true },
        });
        // Only this stage colour's BOM (+ colour-less common lines).
        const sc = (bi.color ?? '').trim().toLowerCase();
        const bom = allBom.filter((l) => !l.color || (sc && l.color.trim().toLowerCase() === sc));
        if (!bom.length) continue;

        // Per-vendor grouping
        const vg =
          vendorMap.get(bi.vendorId) ??
          {
            vendorId: bi.vendorId,
            vendorCode: bi.vendor.vendorCode,
            vendorName: bi.vendor.vendorName,
            items: [] as any[],
          };
        const itemMaterials = bom.map((line) => ({
          variantId: line.variantId,
          variantCode: line.variant.variantCode,
          variantName: line.variant.variantName,
          unit: line.variant.unit,
          perPiece: Number(line.quantity),
          required:
            Math.round(
              Number(line.quantity) * bi.quantity * 1000,
            ) / 1000,
        }));
        vg.items.push({
          batchItemId: bi.id,
          itemNumber: bi.itemNumber,
          vendorDesignReference: bi.vendorDesignReference,
          itemName: bi.itemName,
          color: bi.color,
          quantity: bi.quantity,
          materials: itemMaterials,
        });
        vendorMap.set(bi.vendorId, vg);

        // Overall stock requirement with per-design breakdown — so "Inventory
        // Consumption" can show how the 1000 stones split across designs.
        const designKey = bi.itemNumber || '—';
        for (const line of bom) {
          const need = Number(line.quantity) * bi.quantity;
          const cur = reqMap.get(line.variantId) ?? {
            variantId: line.variantId,
            variantCode: line.variant.variantCode,
            variantName: line.variant.variantName,
            unit: line.variant.unit,
            required: 0,
            stockQty: Number(line.variant.stockQty),
            byDesignMap: new Map<string, number>(),
          };
          cur.required += need;
          cur.byDesignMap.set(designKey, (cur.byDesignMap.get(designKey) ?? 0) + need);
          reqMap.set(line.variantId, cur);
        }
      }
      materialRequirement = Array.from(reqMap.values()).map((r) => ({
        variantId: r.variantId,
        variantCode: r.variantCode,
        variantName: r.variantName,
        unit: r.unit,
        required: Math.round(r.required * 1000) / 1000,
        stockQty: r.stockQty,
        short: r.required > r.stockQty,
        byDesign: Array.from(r.byDesignMap.entries()).map(([itemNumber, qty]: any) => ({
          itemNumber, qty: Math.round((qty as number) * 1000) / 1000,
        })),
      }));
      materialByVendor = Array.from(vendorMap.values());
    }

    return {
      id: batch.id,
      batchNumber: batch.batchNumber,
      processId: batch.processId,
      processName: batch.process?.name ?? '—',
      batchDate: batch.batchDate,
      createdAt: batch.createdAt,
      // 3h grace window cutoff — frontend disables edit buttons once
      // Date.now() crosses this AND the user isn't ADMIN.
      editLockedAt: new Date(
        new Date(batch.createdAt).getTime() + CastingService.BATCH_EDIT_GRACE_HOURS * 60 * 60 * 1000,
      ),
      notes: batch.notes,
      status: batch.status,
      displayStatus,
      closed: batch.closed,
      closedAt: batch.closedAt,
      closedReason: batch.closedReason,
      vendors,
      materialRequirement,
      materialByVendor,
      items,
      lines,
      summary: this.buildBatchSummary(items),
      receipts: batch.receipts.map((r) => ({
        id: r.id,
        receiptNumber: r.receiptNumber,
        receiptDate: r.receiptDate,
        vendorId: r.vendorId,
        vendorName: r.vendor.vendorName,
        vendorCode: r.vendor.vendorCode,
        processName: r.items[0]?.batchItem.stageProcess?.name ?? '—',
        processCode: r.items[0]?.batchItem.stageProcess?.code ?? null,
        qty: r.items.reduce((s, ri) => s + ri.receivedQty, 0),
        weight: Math.round(r.items.reduce((s, ri) => s + Number(ri.receivedWeight), 0) * 1000) / 1000,
        itemCount: r.items.length,
        // Per-stage breakdown — lets the frontend show this receipt's PDF
        // link on every stage row it touched (no scrolling needed for the
        // "open receipt slip" action that used to live in the bottom
        // Slips section).
        items: r.items.map((ri) => ({
          batchItemId: ri.batchItemId,
          receivedQty: ri.receivedQty,
          receivedWeight: Number(ri.receivedWeight),
        })),
      })),
    };
  }

  /** Live batch verification totals across all stages (qty + weight). */
  private buildBatchSummary(items: any[]) {
    const r = (n: number) => Math.round(n * 1000) / 1000;
    // Only ROOT stages contribute to the issued/received totals. A "root"
    // is a stage whose parent is NOT in this batch — i.e. fresh casting
    // lines (parentItemId == null) PLUS cross-batch absorbs (parent lives
    // in a different batch). Downstream forwarded stages within the same
    // batch are just the same pcs walking the pipeline; counting their
    // quantity again would multiply the total by the number of process
    // steps. B0046 showed "1080 pcs · 34.56g" for a 108-pc order because
    // a single design's 9 stages each contributed their own quantity to
    // the sum. With this filter the totals reflect the actual order line.
    const stageIdSet = new Set(items.map((it) => it.id));
    const rootItems = items.filter((it) => it.parentItemId == null || !stageIdSet.has(it.parentItemId));

    let issuedQty = 0, receivedQty = 0, pendingQty = 0, excessQty = 0, shortQty = 0;
    let acceptedQty = 0, repairQty = 0, rejectedQty = 0, openRepairQty = 0;
    let issuedWeight = 0, receivedWeight = 0;
    for (const it of rootItems) {
      issuedQty += it.quantity;
      receivedQty += it.receivedQty;
      acceptedQty += it.acceptedQty ?? 0;
      repairQty += it.repairQty ?? 0;
      rejectedQty += it.rejectedQty ?? 0;
      openRepairQty += it.openRepairQty ?? 0;
      issuedWeight += it.totalWeight;
      receivedWeight += it.receivedWeight;
      if (it.closed) shortQty += it.shortQty ?? 0;
      else {
        // Pending = what the vendor STILL owes us on the root line:
        //   quantity - accepted - rejected - openRepair
        // (lifetime repair cycles total stays in repairQty for info)
        const settled = (it.acceptedQty ?? 0) + (it.rejectedQty ?? 0);
        const open = it.openRepairQty ?? 0;
        pendingQty += Math.max(it.quantity - settled - open, 0);
      }
      excessQty += Math.max(((it.acceptedQty ?? 0) + (it.rejectedQty ?? 0)) - it.quantity, 0);
    }
    return {
      issuedQty, receivedQty, pendingQty, excessQty, shortQty,
      acceptedQty, repairQty, rejectedQty, openRepairQty,
      issuedWeight: r(issuedWeight), receivedWeight: r(receivedWeight),
      balanceWeight: r(issuedWeight - receivedWeight),
    };
  }

  async removeBatch(id: number, role?: string | null) {
    await this.assertBatchEditable(id, role);
    // Return any consumed sticking material to stock before deleting.
    await this.reverseStickingMaterials(id); // legacy batch-level
    const stages = await this.prisma.castingBatchItem.findMany({ where: { batchId: id }, select: { id: true } });
    for (const s of stages) await this.reverseStageSticking(s.id);
    await this.prisma.castingBatch.delete({ where: { id } }).catch(() => {
      throw new NotFoundException('Batch not found.');
    });
    return { id };
  }

  /** Distinct vendors in a batch — used to render per-vendor PDF buttons. */
  async batchVendors(id: number) {
    const items = await this.prisma.castingBatchItem.findMany({
      where: { batchId: id },
      include: { vendor: true },
    });
    return Array.from(new Map(items.map((i) => [i.vendorId, i.vendor])).values()).map(
      (v) => ({ id: v.id, vendorCode: v.vendorCode, vendorName: v.vendorName }),
    );
  }

  // ---------------- Receipts (Casting Receipt) ----------------
  /**
   * Flag pieces missing from a multi-part design at receive time.
   * Operator at the receive form picks one or more part names + qty;
   * each entry becomes a MissingPart row keyed on the stage where the
   * shortfall was noticed. Later, the design's detail page surfaces a
   * "Recast missing parts" CTA that bundles these into a new batch.
   *
   * Idempotent-ish: if the operator re-reports the same (stage, part),
   * a NEW row is created (we don't merge) so they can revise counts and
   * leave the prior one as audit history. The recast flow only picks
   * rows where recastBatchItemId is null.
   */
  async reportMissingParts(
    stageId: number,
    parts: { partName: string; qtyMissing: number; notes?: string }[],
    userId?: number,
  ) {
    const stage = await this.prisma.castingBatchItem.findUnique({
      where: { id: stageId },
      select: { id: true, itemId: true, item: { select: { sampleDesignCode: true, designParts: true } } },
    });
    if (!stage) throw new NotFoundException('Stage not found.');
    if (!stage.itemId) throw new BadRequestException('Stage is not linked to a design.');
    const designParts = (stage as any).item?.designParts ?? [];
    const cleanParts = parts
      .filter((p) => p.partName?.trim() && Number(p.qtyMissing) > 0)
      .map((p) => {
        const meta = designParts.find(
          (d: any) => d.partName?.trim().toLowerCase() === p.partName.trim().toLowerCase(),
        );
        const qty = Math.max(1, Math.trunc(Number(p.qtyMissing)));
        const weightMissing = meta?.weightPerPc != null
          ? Math.round(Number(meta.weightPerPc) * qty * 1000) / 1000
          : null;
        return {
          stageId,
          itemId: stage.itemId!,
          partName: p.partName.trim(),
          qtyMissing: qty,
          weightMissing,
          notes: p.notes?.trim() || null,
          reportedById: userId ?? null,
        };
      });
    if (!cleanParts.length) {
      throw new BadRequestException('Provide at least one part with qty > 0.');
    }
    const created = await this.prisma.$transaction(
      cleanParts.map((p) => this.prisma.missingPart.create({ data: p })),
    );
    await this.audit.log(userId, {
      action: 'casting.missing-parts.report',
      targetType: 'CastingBatchItem',
      targetId: stageId,
      description: `Flagged ${cleanParts.length} missing-part record${cleanParts.length === 1 ? '' : 's'} on ${(stage as any).item?.sampleDesignCode ?? `stage ${stageId}`}`,
      snapshotAfter: { missingParts: cleanParts },
    });
    return { created: created.map((m) => ({ id: m.id, partName: m.partName, qtyMissing: m.qtyMissing })) };
  }

  /** Pending recasts — open MissingPart rows that haven't been turned into a
   *  fresh CASTING line yet. Used by the dashboard card + receive popup. */
  async pendingRecasts() {
    const rows = await this.prisma.missingPart.findMany({
      where: { recastBatchItemId: null },
      orderBy: { reportedAt: 'desc' },
    });
    const itemIds = Array.from(new Set(rows.map((r) => r.itemId)));
    const stageIds = Array.from(new Set(rows.map((r) => r.stageId)));
    const [items, stages] = await Promise.all([
      this.prisma.item.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, sampleDesignCode: true, itemNumber: true, itemName: true },
      }),
      this.prisma.castingBatchItem.findMany({
        where: { id: { in: stageIds } },
        select: { id: true, batchId: true, batch: { select: { batchNumber: true } }, stageProcess: { select: { code: true, name: true } } },
      }),
    ]);
    const itemById = new Map(items.map((i) => [i.id, i]));
    const stageById = new Map(stages.map((s) => [s.id, s]));
    return rows.map((r) => {
      const item = itemById.get(r.itemId);
      const stage = stageById.get(r.stageId);
      return {
        id: r.id,
        itemId: r.itemId,
        itemNumber: item?.itemNumber ?? null,
        designCode: item?.sampleDesignCode ?? null,
        itemName: item?.itemName ?? null,
        partName: r.partName,
        qtyMissing: r.qtyMissing,
        weightMissing: r.weightMissing != null ? Number(r.weightMissing) : null,
        stageId: r.stageId,
        batchId: stage?.batchId ?? null,
        batchNumber: stage?.batch?.batchNumber ?? null,
        stageProcessCode: stage?.stageProcess?.code ?? null,
        stageProcessName: stage?.stageProcess?.name ?? null,
        notes: r.notes,
        createdAt: r.reportedAt,
      };
    });
  }

  /** Recast a single MissingPart row. SAME_BATCH adds a fresh CASTING line
   *  to the original batch for the missing qty; NEW_BATCH spins up a new
   *  CastingBatch with that single design × qty. In both cases the new line
   *  is linked back via MissingPart.recastBatchItemId so the row drops off
   *  the pending list automatically. */
  async recastMissingPart(id: number, where: 'SAME_BATCH' | 'NEW_BATCH', userId?: number) {
    const mp = await this.prisma.missingPart.findUnique({ where: { id } });
    if (!mp) throw new NotFoundException('Missing part not found.');
    if (mp.recastBatchItemId) throw new BadRequestException('Already recast.');
    if (!mp.itemId) throw new BadRequestException('Linked item missing.');

    const casting = await this.prisma.process.findFirst({ where: { code: 'CASTING' } });
    if (!casting) throw new BadRequestException('CASTING process not configured.');

    const item = await this.prisma.item.findUnique({
      where: { id: mp.itemId },
      include: { designParts: true },
    });
    if (!item) throw new BadRequestException('Item not found.');

    const sourceStage = await this.prisma.castingBatchItem.findUnique({
      where: { id: mp.stageId },
      select: { batchId: true },
    });

    // Find an existing CASTING line for this design to inherit vendor / cost /
    // colour. Prefer one from the source batch.
    const castingLine = await this.prisma.castingBatchItem.findFirst({
      where: {
        itemId: mp.itemId,
        processId: casting.id,
        ...(sourceStage?.batchId ? { batchId: sourceStage.batchId } : {}),
      },
      orderBy: { id: 'desc' },
    }) ?? await this.prisma.castingBatchItem.findFirst({
      where: { itemId: mp.itemId, processId: casting.id },
      orderBy: { id: 'desc' },
    });
    if (!castingLine) {
      throw new BadRequestException(`${item.sampleDesignCode} has no prior Casting line — recast needs a vendor reference.`);
    }

    const qty = mp.qtyMissing;
    const perPc = item.designParts.reduce(
      (s, p) => s + Number(p.weightPerPc ?? 0) * (p.qtyPerSet ?? 1),
      0,
    );
    const totalWeight = perPc > 0 ? Math.round(perPc * qty * 1000) / 1000 : 0;

    let targetBatchId: number;
    if (where === 'SAME_BATCH') {
      if (!sourceStage?.batchId) throw new BadRequestException('Source batch missing — pick "new batch" instead.');
      targetBatchId = sourceStage.batchId;
    } else {
      const batchNumber = await nextCode(this.prisma, 'castingBatch', 'batchNumber', 'B', 4);
      const newBatch = await this.prisma.castingBatch.create({
        data: {
          batchNumber,
          batchDate: new Date(),
          processId: casting.id,
          notes: `Recast for ${item.sampleDesignCode} (missing-part ${mp.id})`,
          createdById: userId ?? null,
        },
      });
      targetBatchId = newBatch.id;
    }

    const next = await this.prisma.castingBatchItem.aggregate({
      where: { batchId: targetBatchId },
      _max: { sortOrder: true },
    });

    const newLine = await this.prisma.castingBatchItem.create({
      data: {
        batchId: targetBatchId,
        sortOrder: Number(next._max.sortOrder ?? 0) + 1,
        processId: casting.id,
        itemId: mp.itemId,
        itemNumber: item.sampleDesignCode,
        vendorId: castingLine.vendorId,
        vendorDesignReference: castingLine.vendorDesignReference,
        costPerKg: castingLine.costPerKg,
        quantity: qty,
        weight: perPc,
        totalWeight,
        remarks: `Recast of ${mp.partName} (missing-part ${mp.id})`,
      },
    });

    await this.prisma.missingPart.update({
      where: { id: mp.id },
      data: { recastBatchItemId: newLine.id, recastAt: new Date() },
    });

    await this.audit.log(userId, {
      action: 'casting.missing-part.recast',
      targetType: 'MissingPart',
      targetId: mp.id,
      description: `Recast ${qty} pc${qty === 1 ? '' : 's'} of ${mp.partName} (${item.sampleDesignCode}) in ${where === 'SAME_BATCH' ? 'same' : 'new'} batch`,
      snapshotAfter: { newLineId: newLine.id, targetBatchId },
    });

    return { id: mp.id, newLineId: newLine.id, targetBatchId };
  }

  async createReceipt(dto: CreateReceiptDto, userId?: number) {
    const batch = await this.prisma.castingBatch.findUnique({ where: { id: dto.batchId } });
    if (!batch) throw new NotFoundException('Batch not found.');

    const receiptNumber = await nextCode(
      this.prisma,
      'castingReceipt',
      'receiptNumber',
      'R',
      5,
    );

    // Per-piece weight per batch item (for proportional weight auto-calc).
    // Closed lines cannot receive any more. Also pull stage.costPerKg +
    // itemId + processId so the receipt-rate override can compare against
    // the issue rate AND sync changes back to Item Master.
    // Bifurcation needs the process flag + the item's opt-in flag too.
    const batchItems = await this.prisma.castingBatchItem.findMany({
      where: { batchId: dto.batchId, vendorId: dto.vendorId, closed: false },
      select: {
        id: true, weight: true, costPerKg: true, itemId: true, processId: true,
        stageProcess: { select: { code: true, bifurcates: true } },
        item:         { select: { sampleDesignCode: true, bifurcationEnabled: true } },
      },
    });
    const weightById = new Map(batchItems.map((b) => [b.id, Number(b.weight)]));
    const stageById = new Map(batchItems.map((b) => [b.id, b]));
    const validIds = new Set(batchItems.map((b) => b.id));

    const rows = dto.items.filter(
      (i) => validIds.has(i.batchItemId) && ((i.receivedQty ?? 0) !== 0 || (i.receivedWeight ?? 0) !== 0),
    );

    // -------------------------------------------------------------------
    // Overshoot guard — every non-CASTING process must obey
    //   incomingQty + priorReceivedQty <= orderedQty.
    // Casting is the ONLY step where excess is expected (extra pcs cast
    // for margin, "extra 2 for wastage"). Everywhere downstream, more
    // pieces than issued is always operator error (spam-click on Save,
    // mis-typed qty). B0002 R00011..R00017 were 7 identical KACHA_FITTING
    // posts that should have failed at #2 — this is what stops that
    // pattern deterministically.
    // -------------------------------------------------------------------
    const _rowIds = rows.map((r) => r.batchItemId);
    const _prior = _rowIds.length ? await this.prisma.castingReceiptItem.groupBy({
      by: ['batchItemId'],
      where: { batchItemId: { in: _rowIds } },
      _sum: { receivedQty: true },
    }) : [];
    const priorQtyByItem = new Map<number, number>(
      _prior.map((g) => [g.batchItemId, g._sum.receivedQty ?? 0]),
    );

    // -------------------------------------------------------------------
    // QC bucket validation. Every row's accepted + repair + rejected must
    // equal receivedQty. Back-compat: if NO buckets are supplied, treat
    // receivedQty as fully accepted (matches the old single-bucket flow).
    // Reject rows must also carry a payment-mode pick — the user explicitly
    // decides per their own message: NO_PAY, ADJUSTED (with amount), or
    // FULL_PAY. No system default.
    // -------------------------------------------------------------------
    type NormalizedRow = (typeof rows)[number] & {
      _accepted: number; _repair: number; _rejected: number; _lost: number;
      _rejectMode: 'NO_PAY' | 'ADJUSTED' | 'FULL_PAY' | null;
      _rejectAdj: number | null;
    };
    const normalized: NormalizedRow[] = [];
    for (let idx = 0; idx < rows.length; idx++) {
      const i = rows[idx];
      const recv = i.receivedQty ?? 0;
      // Overshoot check — Casting is the ONLY process where excess is
      // allowed. `returnedAsIsQty` counts toward "physically came back"
      // (so it consumes the vendor's outstanding allocation) but NOT
      // toward `receivedQty`. Both together must still fit inside ordered.
      const _stg = stageById.get(i.batchItemId);
      const _isCasting = _stg?.stageProcess?.code === 'CASTING';
      if (!_isCasting) {
        const _ordered = (batchItems.find((b) => b.id === i.batchItemId) as any)?.quantity ?? 0;
        const _priorQty = priorQtyByItem.get(i.batchItemId) ?? 0;
        const _returnedAsIs = Math.max(0, Math.trunc(Number((i as any).returnedAsIsQty ?? 0)));
        const _incomingTotal = recv + _returnedAsIs;
        if (_ordered > 0 && _priorQty + _incomingTotal > _ordered) {
          throw new BadRequestException(
            `Row ${idx + 1}: ${_stg?.stageProcess?.code ?? 'stage'} #${i.batchItemId} — ordered ${_ordered}, already received ${_priorQty}, this receipt adds ${recv} completed + ${_returnedAsIs} returned-as-is. ` +
            `Total ${_priorQty + _incomingTotal} exceeds ordered qty.`,
          );
        }
      }
      const accSupplied = i.acceptedQty != null || i.repairQty != null || i.rejectedQty != null;
      const acc = accSupplied ? (i.acceptedQty ?? 0) : recv;
      const rep = i.repairQty ?? 0;
      const rej = i.rejectedQty ?? 0;
      if (acc < 0 || rep < 0 || rej < 0) {
        throw new BadRequestException(`Row ${idx + 1}: accept / repair / reject qty cannot be negative.`);
      }
      if (acc + rep + rej !== recv) {
        throw new BadRequestException(
          `Row ${idx + 1}: accepted (${acc}) + repair (${rep}) + rejected (${rej}) = ${acc + rep + rej}, must equal received (${recv}).`,
        );
      }
      if (rej > 0 && !i.rejectPaymentMode) {
        throw new BadRequestException(
          `Row ${idx + 1}: ${rej} pcs marked rejected — pick a payment mode (NO_PAY / ADJUSTED / FULL_PAY).`,
        );
      }
      if (i.rejectPaymentMode === 'ADJUSTED' && (i.rejectAdjustment == null || i.rejectAdjustment < 0)) {
        throw new BadRequestException(
          `Row ${idx + 1}: ADJUSTED reject requires a non-negative rejectAdjustment amount.`,
        );
      }
      normalized.push({
        ...i,
        _accepted: acc, _repair: rep, _rejected: rej,
        _lost: Math.max(0, Math.trunc(Number((i as any).lostQty ?? 0))),
        _rejectMode: (i.rejectPaymentMode as any) ?? null,
        _rejectAdj: i.rejectPaymentMode === 'ADJUSTED' ? (i.rejectAdjustment ?? 0) : null,
      });
    }

    // -------------------------------------------------------------------
    // Create receipt + receipt-items + RepairOrders + close prior repair
    // (when receiving a repair return) in ONE transaction so failures
    // don't leave half-written state.
    // -------------------------------------------------------------------
    const receipt = await this.prisma.$transaction(async (tx) => {
      const created = await tx.castingReceipt.create({
        data: {
          batchId: dto.batchId,
          vendorId: dto.vendorId,
          receiptNumber,
          receiptDate: new Date(dto.receiptDate),
          notes: dto.notes ?? null,
          // Per-vendor runners total — vendor weighs runners once on the
          // scale, not per design. Legacy per-line runnersWeight on the
          // item DTO still works for back-compat; new receipts should
          // route through this field.
          runnersWeight: Math.max(0, Number((dto as any).runnersWeight ?? 0)),
          // Per-receipt metal LOSS total — vendor reports one loss number
          // for the batch (not per design). Posted to LOSS-SILVER as a
          // signed movement after the transaction commits.
          lossWeight: Math.max(0, Number((dto as any).lossWeight ?? 0)),
          createdById: userId ?? null,
        } as any,
      });

      for (const i of normalized) {
        const qty = i.receivedQty ?? 0;
        const weight =
          i.receivedWeight != null && i.receivedWeight !== 0
            ? i.receivedWeight
            : qty * (weightById.get(i.batchItemId) ?? 0);
        // Persist the receipt's actual rate ONLY when the operator
        // typed a different value than the stage's issue rate. Storing
        // the differing rate keeps the receipt slip + vendor ledger
        // self-contained (uses receipt rate when present) AND leaves
        // the issue slip's stage.costPerKg untouched (immutable record
        // of what was issued at). Equal-or-omitted = NULL → readers
        // fall back to stage rate (zero migration overhead).
        const stageRate = stageById.get(i.batchItemId)?.costPerKg;
        const stageRateN = stageRate != null ? Number(stageRate) : null;
        const receiptRate =
          i.costPerKg != null && stageRateN !== null && Number(i.costPerKg) !== stageRateN
            ? Number(i.costPerKg)
            : i.costPerKg != null && stageRateN === null
              ? Number(i.costPerKg)
              : null;
        const item = await tx.castingReceiptItem.create({
          data: {
            receiptId: created.id,
            batchItemId: i.batchItemId,
            receivedQty: qty,
            receivedWeight: weight,
            acceptedQty: i._accepted,
            repairQty: i._repair,
            rejectedQty: i._rejected,
            rejectReason: i.rejectReason ?? null,
            rejectPaymentMode: i._rejectMode as any,
            rejectAdjustment: i._rejectAdj,
            fromRepairOrderId: i.fromRepairOrderId ?? null,
            remarks: i.remarks ?? null,
            costPerKg: receiptRate,
            // Operator-reported metal delta for this row in grams. SIGNED:
            // positive = loss (most processes), negative = gain (sand blast
            // can pick up sand/grit weight). Net posted into LOSS-SILVER
            // after the transaction.
            lossWeight: Number(i.lossWeight ?? 0),
            // Silver runners cut from the design at Filing / Polish — goes
            // into the RUNNERS-SILVER recovery pool. Always >= 0. LEGACY —
            // new receipts route through CastingReceipt.runnersWeight.
            runnersWeight: Math.max(0, Number((i as any).runnersWeight ?? 0)),
            // Pieces that went missing (didn't come back at all). Distinct
            // from rejected (came back, failed QC). MissingPart records
            // auto-spawn after the transaction so downstream forwards block.
            lostQty: i._lost,
            lostReason: i.lostReason?.trim() || null,
            // Pieces returned as-is (untouched). NOT counted as received;
            // vendor allocation decrements + pcs flow back to pending pool
            // for re-issue tomorrow (see stage.receivedQty invalidation
            // below).
            returnedAsIsQty: Math.max(0, Math.trunc(Number((i as any).returnedAsIsQty ?? 0))),
            // Vendor's claimed sent weight for this design (what they SAY
            // they sent). Compared vs actual receivedWeight for the
            // per-vendor drift accumulator. Null when operator didn't
            // capture it.
            claimedSentWeight:
              (i as any).claimedSentWeight === undefined || (i as any).claimedSentWeight === null
                ? null
                : Number((i as any).claimedSentWeight) || 0,
          } as any,
        });

        // -----------------------------------------------------------------
        // VARIANT BIFURCATION (per-piece receive)
        // -----------------------------------------------------------------
        // PLATING — CREATE one ProductionVariant per accepted piece. Each
        //   variant gets its own birth weight, identity (TVM-001(N)), and
        //   travels independently through every downstream stage to sale.
        //
        // POST-PLATING (Meena / Fitting+Mala / Sticking / Packing) — the
        //   variants already exist; the receive form sends perPieceWeights
        //   to record each piece's weight AT THIS STAGE. We write
        //   ProductionVariantStageStop rows so the per-stage weight ledger
        //   stays complete, and bump each variant's currentStageId so the
        //   next forward picks them up correctly.
        // -----------------------------------------------------------------
        const VARIANT_PROCESSES = ['PLATING', 'MEENA', 'FITTING_MALA', 'STICKING', 'PACKING'];
        const stage = stageById.get(i.batchItemId);
        const procCode = stage?.stageProcess?.code;
        const isVariantStage = procCode != null && VARIANT_PROCESSES.includes(procCode) && stage?.itemId != null && i._accepted > 0;

        // DIE_NUMBER receipt captures the die number the karigar stamped
        // on this design and writes it back to the Item Master (per-design
        // master field). One die per design — first receipt wins; later
        // receipts overwrite so a re-stamp / typo can be corrected. Skipped
        // silently when the field wasn't sent.
        if (procCode === 'DIE_NUMBER' && stage?.itemId && (i as any).dieNumber != null) {
          const dn = String((i as any).dieNumber).trim();
          if (dn) {
            await tx.item.update({
              where: { id: stage.itemId },
              data: { dieNumber: dn } as any,
            });
          }
        }

        if (isVariantStage && procCode === 'PLATING') {
          const itemId = stage!.itemId!;
          const sampleCode = stage!.item?.sampleDesignCode ?? `ITEM-${itemId}`;
          const last = await tx.productionVariant.findFirst({
            where: { itemId },
            orderBy: { variantIndex: 'desc' },
            select: { variantIndex: true },
          });
          let nextIndex = (last?.variantIndex ?? 0) + 1;

          const perPieceList: number[] = [];
          const supplied = Array.isArray(i.perPieceWeights) ? i.perPieceWeights : null;
          if (supplied && supplied.length === i._accepted) {
            perPieceList.push(...supplied.map((n) => Number(n)));
          } else {
            const each = i._accepted > 0 ? Number(weight) / i._accepted : 0;
            for (let k = 0; k < i._accepted; k++) perPieceList.push(each);
          }

          for (let k = 0; k < i._accepted; k++) {
            const idx = nextIndex++;
            const variantCode = `${sampleCode}(${idx})`;
            const birthWt = Math.round((perPieceList[k] ?? 0) * 1000) / 1000;
            const created = await tx.productionVariant.create({
              data: {
                itemId,
                variantCode,
                variantIndex: idx,
                birthReceiptItemId: item.id,
                birthWeight: birthWt,
                currentStageId: i.batchItemId,
                state: 'IN_PROGRESS',
              },
            });
            // Plating IS the first stage stop for each variant — record it
            // explicitly so per-stage reports include the birth weight.
            await tx.productionVariantStageStop.create({
              data: {
                productionVariantId: created.id,
                stageId: i.batchItemId,
                weightIn: birthWt,
              },
            });
          }
        } else if (isVariantStage && procCode !== 'PLATING') {
          // Post-Plating: pull traveling variants for this design, pair them
          // by index with the operator-typed weights, and write a stage stop
          // per (variant × this stage). Falls back to evenly splitting the
          // total Recv Wt when the per-piece array is missing (legacy path).
          const itemId = stage!.itemId!;
          const variants = await tx.productionVariant.findMany({
            where: { itemId, state: 'IN_PROGRESS' },
            orderBy: { variantIndex: 'asc' },
            take: i._accepted,
          });
          if (variants.length > 0) {
            const perPieceList: number[] = [];
            const supplied = Array.isArray(i.perPieceWeights) ? i.perPieceWeights : null;
            if (supplied && supplied.length === i._accepted) {
              perPieceList.push(...supplied.map((n) => Number(n)));
            } else {
              const each = i._accepted > 0 ? Number(weight) / i._accepted : 0;
              for (let k = 0; k < i._accepted; k++) perPieceList.push(each);
            }
            for (let k = 0; k < Math.min(variants.length, i._accepted); k++) {
              const v = variants[k];
              const wt = Math.round((perPieceList[k] ?? 0) * 1000) / 1000;
              await tx.productionVariantStageStop.upsert({
                where: {
                  productionVariantId_stageId: {
                    productionVariantId: v.id,
                    stageId: i.batchItemId,
                  },
                },
                update: { weightIn: wt },
                create: {
                  productionVariantId: v.id,
                  stageId: i.batchItemId,
                  weightIn: wt,
                },
              });
              await tx.productionVariant.update({
                where: { id: v.id },
                data: { currentStageId: i.batchItemId },
              });
            }
          }
        }

        // Source repair order — DECREMENT its qty by what came back on this
        // receipt-item. RepairOrder.qty is "how many pcs are still at vendor
        // for repair", so a partial return (e.g. vendor brings 2 of 4) leaves
        // the order OPEN with qty=2 instead of incorrectly closing it.
        // Only flip to RETURNED when qty drops to 0.
        let parentRepair: { id: number; cycle: number } | null = null;
        if (i.fromRepairOrderId != null) {
          const src = await tx.repairOrder.findUnique({
            where: { id: i.fromRepairOrderId },
            select: { id: true, cycle: true, status: true, qty: true },
          });
          if (src && src.status !== 'FINAL_REJECTED') {
            const returnedNow = i.receivedQty ?? 0;
            const remaining = Math.max(0, src.qty - returnedNow);
            await tx.repairOrder.update({
              where: { id: src.id },
              data: remaining <= 0
                ? { qty: 0, status: 'RETURNED', returnedAt: new Date() }
                : { qty: remaining },
            });
            parentRepair = { id: src.id, cycle: src.cycle };
          }
        }

        // Create a new RepairOrder for any pcs flagged for repair. Cycle
        // climbs when this is a re-repair (chained from a prior order).
        if (i._repair > 0) {
          await tx.repairOrder.create({
            data: {
              receiptItemId: item.id,
              stageId: i.batchItemId,
              vendorId: dto.vendorId,
              qty: i._repair,
              reason: i.repairReason ?? null,
              cycle: parentRepair ? parentRepair.cycle + 1 : 1,
              parentRepairId: parentRepair?.id ?? null,
              createdById: userId ?? null,
            },
          });
        }
      }
      return created;
    });

    await this.recomputeBatchStatus(dto.batchId);

    // -----------------------------------------------------------------
    // Auto-MissingPart spawn — for every row with lostQty > 0, create the
    // matching MissingPart records (one per piece). The design's primary
    // part name is used; for multi-part designs the operator can edit /
    // re-attribute via the Report Missing dialog. Downstream forwards are
    // blocked by the openMissingParts deduction in availableToForward.
    // -----------------------------------------------------------------
    for (const n of normalized) {
      if ((n._lost ?? 0) <= 0) continue;
      const stage = stageById.get(n.batchItemId);
      if (!stage?.itemId) continue;
      const designPart = await this.prisma.itemDesignPart.findFirst({
        where: { itemId: stage.itemId },
        orderBy: { sortOrder: 'asc' },
      });
      const partName = designPart?.partName ?? 'Piece';
      await this.prisma.missingPart.create({
        data: {
          stageId: n.batchItemId,
          itemId: stage.itemId,
          partName,
          qtyMissing: n._lost,
          weightMissing: designPart?.weightPerPc != null
            ? Math.round(Number(designPart.weightPerPc) * n._lost * 1000) / 1000
            : null,
          notes: n.lostReason ?? `Lost at ${stage.stageProcess?.code ?? 'stage'} receipt ${receiptNumber}`,
          reportedById: userId ?? null,
        },
      });
    }

    // -----------------------------------------------------------------
    // Loss accumulation — post the operator-reported losses into the
    // LOSS-SILVER tracker variant. One IN movement per receipt aggregates
    // the SIGNED sum across all rows (sand-blast can be net negative =
    // gain). Skipped silently when the variant doesn't exist (admin
    // deleted it) or net is zero.
    // -----------------------------------------------------------------
    // Sum of per-row losses + the receipt-level lossWeight (Casting-style
    // receipts often report ONE total for the whole batch instead of
    // per-design; we sum both so either shape posts correctly).
    const perRowLoss = normalized.reduce((s, n) => s + Number(n.lossWeight ?? 0), 0);
    const receiptLoss = Math.max(0, Number((dto as any).lossWeight ?? 0));
    const totalLoss = Math.round((perRowLoss + receiptLoss) * 1000) / 1000;
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
              refType: 'loss_receipt',
              refId: receipt.id,
              note: totalLoss >= 0
                ? `Loss reported on receipt ${receiptNumber}`
                : `Net GAIN reported on receipt ${receiptNumber}`,
              createdById: userId ?? null,
            } as any,
          }),
        ]);
      }
    }

    // -----------------------------------------------------------------
    // Runners pool — silver cut off the design at Filing / Polish gets
    // moved into the RUNNERS-SILVER recovery variant. Sum across all rows
    // of this receipt → one IN movement, similar pattern to the loss
    // accumulator above. Skipped silently if the variant is missing.
    // -----------------------------------------------------------------
    const totalRunners = normalized.reduce(
      (s, n) => s + Math.max(0, Number((n as any).runnersWeight ?? 0)),
      0,
    );
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
              refType: 'runners_receipt',
              refId: receipt.id,
              note: `Runners recovered on receipt ${receiptNumber}`,
              createdById: userId ?? null,
            } as any,
          }),
        ]);
      }
    }

    // Receipt rate-override sync — if the operator typed a NEW rate on
    // any receive row (different from the issue-slip stage.costPerKg),
    // push that new rate forward to the Item Master so future batches
    // default to it. Same syncProcessRateToItem helper that the New
    // Batch / Forward / Edit Stage flows use; same toast+undo semantics
    // surface here too.
    //
    // The persistent rate history is the receipts themselves — every
    // CastingReceiptItem.costPerKg row is a timestamped record of "what
    // the vendor charged on this day". A future Reports module can
    // graph rate changes across receipts without any extra audit table.
    const rateUpdates: NonNullable<Awaited<ReturnType<typeof this.syncProcessRateToItem>>>[] = [];
    for (const rec of normalized) {
      if (rec.costPerKg == null) continue;
      const stage = stageById.get(rec.batchItemId);
      if (!stage?.itemId || stage.processId == null) continue;
      const stageRateN = stage.costPerKg != null ? Number(stage.costPerKg) : null;
      const newRate = Number(rec.costPerKg);
      if (stageRateN !== null && stageRateN === newRate) continue;
      const sync = await this.syncProcessRateToItem(
        stage.itemId,
        stage.processId,
        newRate,
        dto.vendorId,
      );
      if (sync) rateUpdates.push(sync);
    }

    // Auto-forward: any stage in this receipt with a `plannedNextProcessId`
    // gets its newly-received pieces forwarded straight to the planned step,
    // landing in `plannedTargetBatchId` (the new production batch). This is
    // what makes the "at-vendor pieces flow into the new batch on receipt"
    // experience work end-to-end — the user planned it once in the New Batch
    // dialog and never has to remember to forward at receive time.
    for (const rec of normalized) {
      const stage = await this.prisma.castingBatchItem.findUnique({
        where: { id: rec.batchItemId },
        select: {
          id: true,
          plannedNextProcessId: true,
          plannedNextVendorId: true,
          plannedNextColor: true,
          plannedTargetBatchId: true,
        },
      });
      if (!stage?.plannedNextProcessId) continue;
      // Auto-forward uses ACCEPTED qty only — repair pcs are with vendor
      // again and rejected pcs are written off. Neither should advance
      // to the next process.
      const qty = rec._accepted;
      if (qty <= 0) continue;
      try {
        await this.forwardStage(
          stage.id,
          {
            processId: stage.plannedNextProcessId,
            quantity: qty,
            vendorId: stage.plannedNextVendorId ?? undefined,
            color: stage.plannedNextColor ?? undefined,
          },
          userId,
          { targetBatchId: stage.plannedTargetBatchId ?? undefined },
        );
      } catch {
        // If the auto-forward fails (e.g., target batch deleted, planned
        // vendor inactive), surface it in remarks but don't reject the
        // receipt — the user can forward manually.
        await this.prisma.castingBatchItem.update({
          where: { id: stage.id },
          data: { remarks: 'Planned auto-forward failed — forward manually.' },
        });
      }
    }

    // Final-weight prompt — when this receipt covers stages whose Item was
    // flagged "casting weight temporary" at batch creation, surface the
    // affected items so the receive form can pop a "what's the actual
    // per-pc weight?" dialog. Only triggers when the stage's process is
    // CASTING (downstream receipts measure a different weight that already
    // includes plating gain, etc.) and the marker is still in notes (so a
    // second Casting receipt for the same item won't keep nagging once
    // the operator has confirmed). Distinct by itemId — even if a batch
    // has the same design in multiple stages, the popup shows it once.
    const needsFinalWeight: Array<{
      itemId: number; itemNumber: string | null; sampleDesignCode: string;
      currentWeight: number;
    }> = [];
    {
      const stageIds = Array.from(new Set(normalized.map((n) => n.batchItemId)));
      const stages = await this.prisma.castingBatchItem.findMany({
        where: { id: { in: stageIds } },
        include: { stageProcess: true },
      });
      const itemIds = Array.from(new Set(
        stages
          .filter((s) => s.stageProcess?.code === 'CASTING' && s.itemId != null)
          .map((s) => s.itemId as number),
      ));
      if (itemIds.length) {
        const casting = await this.prisma.process.findFirst({ where: { code: 'CASTING' }, select: { id: true } });
        const items = await this.prisma.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, itemNumber: true, sampleDesignCode: true },
        });
        for (const it of items) {
          // Marker now lives on the Casting ItemProcess.notes (per-process)
          // — read from there, not the item-level notes. Same record holds
          // the current weight attribute, so one query covers both.
          const ip = casting ? await this.prisma.itemProcess.findUnique({
            where: { itemId_processId: { itemId: it.id, processId: casting.id } },
            include: { attributes: true },
          }) : null;
          const procNotes = (ip?.notes ?? '').toLowerCase();
          if (!procNotes.includes(CastingService.TEMP_WEIGHT_MARKER)) continue;
          const wAttr = ip?.attributes.find((a) => a.attrKey === 'weight');
          needsFinalWeight.push({
            itemId: it.id,
            itemNumber: it.itemNumber ?? null,
            sampleDesignCode: it.sampleDesignCode,
            currentWeight: wAttr?.attrValue ? Number(wAttr.attrValue) : 0,
          });
        }
      }
    }

    // Auto-balance colour-split shorts against sibling excesses on the
    // same (item × purpose) within this receipt. When operator-typed
    // counts have a short on one colour and matching excess on another
    // for the SAME design (sum across the colour-split stages equals
    // sum ordered), it's almost always a mislabel — vendor returned
    // the right total but tagged one piece as the wrong colour. Closing
    // the short side with shortQty=0 keeps the vendor ledger clean
    // (no false "you owe me 1 piece" line), while the excess side stays
    // OPEN so the operator can still forward those pcs to the next
    // process. Run AFTER auto-forward so this only touches whatever
    // wasn't already forwarded out.
    const autoBalanced = await this.autoBalanceColourShorts(dto.batchId, dto.vendorId, normalized);

    // ─────────────────────────────────────────────────────────────────
    // LOT EARMARK DRAIN (Task #13)
    // ─────────────────────────────────────────────────────────────────
    // If the vendor is currently holding metal earmarked to specific
    // SilverLots (from ISSUE_TO_VENDOR events with sourceLotId), drain
    // those holdings FIFO by the FINE-METAL EQUIVALENT of what came
    // back. The received weight is expressed in the receipt-item's
    // metal (usually 93.5 after casting/plating). We convert that to
    // "fine metal" using the OUTPUT variant's fineness, then decrement
    // each holding (and credit back the lot's remainingWeightG) in the
    // order the vendor received them.
    //
    // Runner-only receipts (0 pcs but runners > 0) contribute a fine-
    // metal credit too because runners are still customer/lot silver.
    try {
      const totalReceivedWeightG = normalized.reduce((s, r) => s + Number(r.receivedWeight ?? 0), 0);
      const runnerWeightG = Number((dto as any).runnersWeight ?? 0);
      // Aggregate physical return in grams (of whatever purity vendor
      // returned — typically 93.5). Convert to fine metal via SILV-935
      // fineness for the credit calc.
      const physicalReturnG = totalReceivedWeightG + runnerWeightG;
      if (physicalReturnG > 0) {
        // Look up SILV-935 fineness (default 0.935 if not seeded yet).
        const outward = await this.prisma.materialVariant.findFirst({
          where: { variantCode: 'SILV-935' },
        });
        const outFineness = outward?.fineness ? Number(outward.fineness) : 0.935;
        let fineMetalReturned = Math.round(physicalReturnG * outFineness * 1000) / 1000;

        const holdings = await this.prisma.vendorLotHolding.findMany({
          where: { vendorId: dto.vendorId, weightG: { gt: 0 } },
          include: {
            lot: { select: { lotNumber: true, receivedAt: true, variantId: true, remainingWeightG: true, receivedWeightG: true } },
          },
          orderBy: { updatedAt: 'asc' }, // approximate FIFO — order of first issue
        });
        for (const h of holdings) {
          if (fineMetalReturned <= 0.0005) break;
          const holdingG = Number(h.weightG);
          // The holding is IN THE LOT'S VARIANT (999 for a 999 lot).
          // Fine metal it represents:
          const lotVariant = await this.prisma.materialVariant.findUnique({ where: { id: h.lot.variantId } });
          const lotFineness = lotVariant?.fineness ? Number(lotVariant.fineness) : 1;
          const holdingFineMetal = holdingG * lotFineness;
          const takeFineMetal = Math.min(holdingFineMetal, fineMetalReturned);
          const takeLotG = Math.round((takeFineMetal / lotFineness) * 1000) / 1000;
          if (takeLotG <= 0) continue;
          await this.prisma.vendorLotHolding.update({
            where: { id: h.id },
            data: { weightG: { decrement: takeLotG } },
          });
          await this.prisma.silverLot.update({
            where: { id: h.lotId },
            data: { remainingWeightG: { increment: takeLotG } },
          });
          await this.prisma.vendorMetalLedger.create({
            data: {
              vendorId: dto.vendorId,
              variantId: h.lot.variantId,
              eventType: 'RETURN_TO_ADVANCE' as any,
              weight: -takeLotG,
              balanceAfter: 0, // aggregate balance recomputed elsewhere; per-lot ledger detail here
              refType: 'casting_receipt', refId: receipt.id,
              sourceLotId: h.lotId,
              note: `Return ${takeLotG.toFixed(3)} g to lot ${h.lot.lotNumber} via receipt ${receipt.receiptNumber}`,
              createdById: userId ?? null,
            } as any,
          });
          fineMetalReturned = Math.round((fineMetalReturned - takeFineMetal) * 1000) / 1000;
        }
      }
    } catch {
      // Non-blocking — earmark drain failure never rolls the receipt back.
      // Reconciliation script can rebuild holdings from the ledger later.
    }

    // Audit — undoable via casting.receipt.create (re-uses deleteReceipt
    // which already enforces the "no pieces forwarded out" guard).
    const totalQty = normalized.reduce((s, r) => s + (r.receivedQty ?? 0), 0);
    await this.audit.log(userId, {
      action: 'casting.receipt.create',
      targetType: 'CastingReceipt',
      targetId: receipt.id,
      description: `Receipt ${receiptNumber} — ${totalQty} pcs from vendor #${dto.vendorId}, batch #${dto.batchId}`,
      snapshotAfter: { id: receipt.id, receiptNumber, batchId: dto.batchId, vendorId: dto.vendorId, items: normalized },
      undoStrategy: 'casting.receipt.create',
    });
    // Auto item-number allocation on first Packing receipt — replaces the
    // old dispatch-center "categorize collection" flow. For every PACKING
    // receipt row, if the source Item still has no itemNumber, allocate the
    // next ABN-XXXX automatically. Silent on failure (the operator can
    // still allocate manually via /items if needed).
    // Track which items got item numbers this receipt so the frontend can
    // prompt for their per-variant post-packing details (additional charge,
    // gross/less/net wt) via the modal.
    const newlyAllocatedItemIds: number[] = [];
    try {
      const stageIds = normalized.map((n) => n.batchItemId);
      const packingStages = await this.prisma.castingBatchItem.findMany({
        where: { id: { in: stageIds }, stageProcess: { code: 'PACKING' } },
        select: { itemId: true, item: { select: { itemNumber: true } } },
      });
      const needAlloc = Array.from(new Set(
        packingStages
          .filter((s) => s.itemId && !s.item?.itemNumber)
          .map((s) => s.itemId as number),
      ));
      for (const itemId of needAlloc) {
        const next = await nextCode(this.prisma, 'item', 'itemNumber', 'ABN', 4);
        await this.prisma.item.update({
          where: { id: itemId },
          data: { itemNumber: next, itemNumberAllocatedAt: new Date(), itemNumberAllocatedById: userId ?? null },
        });
        newlyAllocatedItemIds.push(itemId);
      }
    } catch {
      // Non-blocking: receipt already saved. Operator can allocate manually.
    }
    // Post-packing details prompt payload — variants whose parent item was
    // just allocated AND that haven't already had their packing details
    // filled in. Frontend renders the modal from this array.
    const needsPackingDetails = newlyAllocatedItemIds.length > 0
      ? await this.prisma.productionVariant.findMany({
          where: { itemId: { in: newlyAllocatedItemIds }, packingDetailsFilled: false },
          select: {
            id: true, variantCode: true, birthWeight: true, itemId: true,
            item: { select: { itemNumber: true, itemName: true } },
          },
          orderBy: { variantIndex: 'asc' },
        })
      : [];
    // Auto-sync into the global "unassigned" draft estimate — designs
    // whose item numbers were just allocated flow into the current draft.
    // Best-effort: any failure is swallowed so the receipt still saves.
    try {
      if (newlyAllocatedItemIds.length > 0) {
        await this.syncAllocatedItemsIntoDraft(newlyAllocatedItemIds, userId);
      }
    } catch {
      // Non-blocking.
    }
    return {
      id: receipt.id,
      receiptNumber,
      rateUpdates,
      autoBalanced,
      needsFinalWeight,
      needsPackingDetails,
      newlyAllocatedItemIds,
    };
  }

  // ── Post-Packing details (per production variant) ─────────────────
  /**
   * Save the per-variant post-packing details (additional charge + weight
   * breakdown). Sets packingDetailsFilled=true so the modal doesn't re-prompt.
   * Also updates the current draft estimate's line for this variant when it
   * exists (so the operator sees the final numbers reflected in the draft).
   */
  async savePackingDetails(
    variantId: number,
    dto: { additionalCharge?: number | null; grossWt?: number | null; lessWt?: number | null; netWt?: number | null },
  ) {
    const v = await this.prisma.productionVariant.findUnique({ where: { id: variantId } });
    if (!v) throw new NotFoundException('Production variant not found.');
    const updated = await this.prisma.productionVariant.update({
      where: { id: variantId },
      data: {
        packingAdditionalCharge: dto.additionalCharge != null ? dto.additionalCharge : null,
        packingGrossWt:          dto.grossWt          != null ? dto.grossWt          : null,
        packingLessWt:           dto.lessWt           != null ? dto.lessWt           : null,
        packingNetWt:            dto.netWt            != null ? dto.netWt            : null,
        packingDetailsFilled:    true,
        packingDetailsSavedAt:   new Date(),
      },
    });
    // Mirror the finalised numbers onto the matching unassigned-draft
    // line, if any. Match by (itemId, itemNumber=variantCode) — the same
    // pairing syncAllocatedItemsIntoDraft used when it first created the
    // line. Best-effort; failure doesn't roll the packing-details save
    // back because the numbers still live on the variant itself.
    try {
      if (updated.itemId && updated.variantCode) {
        await this.prisma.invoiceItem.updateMany({
          where: {
            itemId: updated.itemId,
            itemNumber: updated.variantCode,
            invoice: { status: 'DRAFT' as any, customerId: null, type: 'QUOTE' as any },
          },
          data: {
            weightG: dto.netWt ?? dto.grossWt ?? undefined,
            extraAmount: dto.additionalCharge ?? undefined,
          },
        });
      }
    } catch {
      // Non-blocking — the variant's own record is authoritative.
    }
    return updated;
  }

  /**
   * List every production variant whose parent item's number has been
   * allocated but whose packing details are still pending — drives the
   * "post-packing details pending" badge and the /items page filter.
   */
  async listPendingPackingDetails() {
    return this.prisma.productionVariant.findMany({
      where: {
        packingDetailsFilled: false,
        item: { itemNumber: { not: null } },
      },
      select: {
        id: true, variantCode: true, birthWeight: true, itemId: true,
        item: { select: { itemNumber: true, itemName: true } },
      },
      orderBy: [{ item: { itemNumber: 'asc' } }, { variantIndex: 'asc' }],
      take: 200,
    });
  }

  /**
   * Sync freshly-allocated items into the global "unassigned" draft
   * Estimate. One draft can hold any customer's lines; the draft becomes
   * a real Estimate when its status flips out of DRAFT (READY / ISSUED).
   *
   * Behaviour rules from operator spec:
   *  - When a design gets its item number, add one line per production
   *    variant to the current unassigned DRAFT (customerId = null).
   *  - When the current draft ships (READY / ISSUED), a fresh unassigned
   *    DRAFT is auto-created on the next packing.
   *
   * Idempotent — if the same variant flows through twice (rare, but safe
   * to defend against), the second call is a no-op because the (itemId,
   * itemNumber) pair on the draft is already covered.
   */
  private async syncAllocatedItemsIntoDraft(itemIds: number[], userId?: number) {
    if (itemIds.length === 0) return;
    // Load each item + its production variants. One line per variant so
    // each per-piece bifurcation shows up separately (operator asked for
    // this — variants may carry different additional charges).
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: {
        id: true,
        itemNumber: true,
        itemName: true,
        productionVariants: {
          select: {
            id: true,
            variantCode: true,
            birthWeight: true,
            packingNetWt: true,
            packingAdditionalCharge: true,
            variantIndex: true,
          },
          orderBy: { variantIndex: 'asc' },
        },
      },
    });

    // Find (or create) the currently-open unassigned draft. Only one is
    // ever open at a time — once it flips to READY/ISSUED, the next
    // packing spawns a fresh one.
    let draft = await this.prisma.invoice.findFirst({
      where: { customerId: null, status: 'DRAFT', type: 'QUOTE' as any },
      orderBy: { createdAt: 'desc' },
    });
    if (!draft) {
      // Number retry mirrors createInvoice's — two packing receipts firing
      // near-simultaneously could otherwise both pick the same EST number.
      for (let attempt = 0; attempt < 5; attempt++) {
        const invoiceNumber = await nextCode(this.prisma, 'invoice', 'invoiceNumber', 'EST', 4);
        try {
          draft = await this.prisma.invoice.create({
            data: {
              invoiceNumber,
              type: 'QUOTE' as any,
              status: 'DRAFT' as any,
              invoiceDate: new Date(),
              customerId: null,
              billToName: '(unassigned)',
              billToAddress: '',
              billToGstin: null,
              placeOfSupply: null,
              silverRatePerG: 0,
              makingRatePerG: 0,
              gstPercent: 3,
              isInterState: false,
              chargesTotal: 0,
              subtotal: 0,
              cgstAmount: 0,
              sgstAmount: 0,
              igstAmount: 0,
              roundOff: 0,
              totalAmount: 0,
              paidAmount: 0,
              balanceAmount: 0,
              notes: 'Auto-generated from packing. Tag a customer + set status to READY to convert into a real Estimate.',
              createdById: userId ?? null,
            },
          });
          break;
        } catch (e: any) {
          const target = Array.isArray(e?.meta?.target) ? e.meta.target : [e?.meta?.target];
          const isNumberClash = e?.code === 'P2002'
            && target.some((t: string) => t?.includes('invoiceNumber'));
          if (!isNumberClash) throw e;
          // Retry with a fresh nextCode.
        }
      }
      if (!draft) return; // Retries exhausted; skip silently (best-effort).
    }

    // Dedupe against lines already on the draft — the receipt path may
    // fire twice on a retry, and a variant should never appear twice.
    const existingLines = await this.prisma.invoiceItem.findMany({
      where: { invoiceId: draft.id, itemId: { in: itemIds } },
      select: { itemId: true, itemNumber: true },
    });
    const existingKeys = new Set(
      existingLines.map((l) => `${l.itemId}:${l.itemNumber ?? ''}`),
    );

    const newLines: any[] = [];
    for (const it of items) {
      if (it.productionVariants.length === 0) {
        // No bifurcation — one line for the whole item.
        const key = `${it.id}:${it.itemNumber ?? ''}`;
        if (existingKeys.has(key)) continue;
        newLines.push({
          invoiceId: draft.id,
          itemId: it.id,
          itemNumber: it.itemNumber ?? null,
          description: it.itemName ?? 'Item',
          hsnCode: '71131110',
          quantity: 1,
          weightG: 0,
          silverRatePerG: 0,
          makingRatePerG: 0,
          silverAmount: 0,
          makingAmount: 0,
          lineAmount: 0,
          extraAmount: null,
          notes: 'Auto-added from packing. Fill in weight + rates before issuing.',
        });
      } else {
        // One line per variant — variant code becomes the "item number"
        // on the invoice line so the operator can tell them apart, even
        // when several variants of the same parent item share a draft.
        for (const v of it.productionVariants) {
          const key = `${it.id}:${v.variantCode ?? ''}`;
          if (existingKeys.has(key)) continue;
          // Prefer packing-time net weight (post-modal), fall back to
          // birthWeight (post-plating in-flight) or 0.
          const wt = v.packingNetWt != null
            ? Number(v.packingNetWt)
            : v.birthWeight != null
              ? Number(v.birthWeight)
              : 0;
          newLines.push({
            invoiceId: draft.id,
            itemId: it.id,
            itemNumber: v.variantCode ?? it.itemNumber ?? null,
            description: it.itemName
              ? `${it.itemName}${it.itemNumber ? ` · ${it.itemNumber}` : ''}`
              : (it.itemNumber ?? 'Item'),
            hsnCode: '71131110',
            quantity: 1,
            weightG: wt,
            silverRatePerG: 0,
            makingRatePerG: 0,
            silverAmount: 0,
            makingAmount: 0,
            lineAmount: 0,
            extraAmount: v.packingAdditionalCharge != null ? Number(v.packingAdditionalCharge) : null,
            notes: 'Auto-added from packing. Rates + customer tagging pending.',
          });
        }
      }
    }

    if (newLines.length > 0) {
      await this.prisma.invoiceItem.createMany({ data: newLines });
    }
  }

  /**
   * Save the FINAL per-piece Casting weight on an item — called from the
   * receive form's popup once the operator has weighed the actual returned
   * pieces. Writes the new value to ItemProcessAttribute (overwriting the
   * temporary guess) and STRIPS the "casting weight temporary" marker
   * from Item.notes so subsequent receipts of this item don't prompt again.
   *
   * The downstream stage weights (and any planned forwards) inherit the
   * actual physical receipt weight via the per-pc averaging in forwardStage,
   * so we don't need to retroactively rewrite open stages here — this
   * finalize only affects the MASTER value the NEXT batch will pre-fill from.
   */
  async finalizeCastingWeight(itemId: number, weight: number) {
    if (!itemId) throw new BadRequestException('itemId is required.');
    if (!(Number(weight) > 0)) throw new BadRequestException('weight must be greater than zero.');
    const casting = await this.prisma.process.findFirst({ where: { code: 'CASTING' } });
    if (!casting) throw new NotFoundException('Casting process is not configured.');
    // Upsert the weight attribute on the Casting ItemProcess. Unlike
    // ensureProcessAttribute, this path explicitly OVERWRITES — operator
    // is confirming the final value. Create the parent ItemProcess if
    // missing (rare; only on items that never went through Casting before).
    let ip = await this.prisma.itemProcess.findUnique({
      where: { itemId_processId: { itemId, processId: casting.id } },
      select: { id: true, notes: true },
    });
    if (!ip) {
      const created = await this.prisma.itemProcess.create({
        data: { itemId, processId: casting.id },
        select: { id: true, notes: true },
      });
      ip = created;
    }
    await this.prisma.itemProcessAttribute.upsert({
      where: { itemProcessId_attrKey: { itemProcessId: ip.id, attrKey: 'weight' } },
      create: { itemProcessId: ip.id, attrKey: 'weight', attrValue: String(weight) },
      update: { attrValue: String(weight) },
    });
    // Strip the temporary marker (case-insensitive) from the Casting
    // ItemProcess.notes. Filters out any line containing the marker,
    // collapses runs of blank lines, trims leading/trailing whitespace.
    // Leaves any OTHER per-process notes the operator may have typed
    // intact (the marker is just one line among potentially many).
    if (ip.notes && ip.notes.toLowerCase().includes(CastingService.TEMP_WEIGHT_MARKER)) {
      const stripped = ip.notes
        .split('\n')
        .filter((ln) => !ln.toLowerCase().includes(CastingService.TEMP_WEIGHT_MARKER))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      await this.prisma.itemProcess.update({
        where: { id: ip.id },
        data: { notes: stripped || null },
      });
    }
    return { itemId, weight: Number(weight), markerCleared: true };
  }

  /**
   * Close any colour-split stage that's short by an amount exactly covered
   * by sibling colours' excess on the same (item × purpose). Returns the
   * list of stages closed so the frontend can surface a toast.
   *
   * Group rule: stages share an (itemId, purpose, processId, vendorId)
   * combo AND belong to the same batch. Match condition: sum(quantity)
   * across the group equals sum(settled) (settled = accepted + rejected).
   * Skipped entirely for groups of just one stage — single-colour shorts
   * are real vendor debt and need an explicit short-close.
   */
  private async autoBalanceColourShorts(
    batchId: number,
    vendorId: number,
    normalized: Array<{ batchItemId: number }>,
  ): Promise<Array<{ stageId: number; itemNumber: string | null; color: string | null; shortBy: number }>> {
    const result: Array<{ stageId: number; itemNumber: string | null; color: string | null; shortBy: number }> = [];
    // Collect ALL stages touched by this receipt; we re-query each
    // group's full sibling set below.
    const touched = await this.prisma.castingBatchItem.findMany({
      where: { id: { in: Array.from(new Set(normalized.map((n) => n.batchItemId))) } },
      select: { itemId: true, purpose: true, processId: true, vendorId: true },
    });

    // Distinct (itemId × purpose × processId × vendorId) groups, scoped
    // to this batch + vendor. Walking by distinct keys avoids re-checking
    // the same group N times when several receipt-items share one design.
    const seen = new Set<string>();
    for (const t of touched) {
      const key = `${t.itemId ?? 'x'}::${t.purpose ?? ''}::${t.processId ?? 'x'}::${t.vendorId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const stages = await this.prisma.castingBatchItem.findMany({
        where: {
          batchId,
          vendorId,
          itemId: t.itemId,
          purpose: t.purpose,
          processId: t.processId,
          closed: false,
        },
        include: { receiptRows: { select: { acceptedQty: true, rejectedQty: true } } },
      });
      // Auto-balance only makes sense across a colour split — two or more
      // sibling stages. Single-stage groups can't have a sibling excess.
      if (stages.length < 2) continue;

      const sumOrdered = stages.reduce((s, st) => s + st.quantity, 0);
      const sumSettled = stages.reduce(
        (s, st) => s + st.receiptRows.reduce((rs, r) => rs + r.acceptedQty + r.rejectedQty, 0),
        0,
      );
      if (sumOrdered !== sumSettled) continue; // totals don't balance — leave each stage as-is

      // Group balances → close any stage where vendor settled less than
      // ordered (the short side). shortQty stays 0 because no money is
      // owed; the vendor delivered the total, just mislabeled colours.
      for (const st of stages) {
        const settled = st.receiptRows.reduce((rs, r) => rs + r.acceptedQty + r.rejectedQty, 0);
        const shortBy = st.quantity - settled;
        if (shortBy <= 0) continue; // not short — could be exact or excess; leave it
        const item = await this.prisma.item.findUnique({ where: { id: st.itemId ?? -1 }, select: { itemNumber: true } });
        await this.prisma.castingBatchItem.update({
          where: { id: st.id },
          data: {
            closed: true,
            shortQty: 0,
            closedReason: 'Auto-balanced: total received matches total ordered across colour split.',
            closedAt: new Date(),
          },
        });
        result.push({
          stageId: st.id,
          itemNumber: item?.itemNumber ?? null,
          color: st.color ?? null,
          shortBy,
        });
      }
    }
    return result;
  }

  /**
   * Read a single receipt with everything the frontend needs to render
   * the Edit Receipt form (header + per-row QC buckets + reject mode +
   * rate). Mirrors the createReceipt DTO shape so the form can map
   * directly onto inputs without translation.
   */
  async findReceipt(receiptId: number) {
    // Pull the receipt + items + the stage/process pair via batchItem so the
    // form can show the locked batch / vendor / process as friendly labels.
    // One receipt = one process is an invariant of the create flow, so we
    // can safely lift processId / processName from the first item.
    const receipt = await this.prisma.castingReceipt.findUnique({
      where: { id: receiptId },
      include: {
        vendor: true,
        batch: true,
        items: {
          include: {
            batchItem: { include: { stageProcess: true } },
          },
        },
      },
    });
    if (!receipt) throw new NotFoundException('Receipt not found.');
    // CastingBatchItem IS the stage; processId is on it directly via the
    // `stageProcess` relation. One receipt = one process, so lifting from
    // the first item gives the receipt's process.
    const firstBatchItem = receipt.items[0]?.batchItem;
    return {
      id: receipt.id,
      receiptNumber: receipt.receiptNumber,
      batchId: receipt.batchId,
      batchNumber: receipt.batch?.batchNumber ?? null,
      vendorId: receipt.vendorId,
      vendorCode: receipt.vendor?.vendorCode ?? null,
      vendorName: receipt.vendor?.vendorName ?? null,
      processId: firstBatchItem?.processId ?? null,
      processName: firstBatchItem?.stageProcess?.name ?? null,
      receiptDate: receipt.receiptDate,
      notes: receipt.notes,
      items: receipt.items.map((ri) => ({
        batchItemId: ri.batchItemId,
        receivedQty: ri.receivedQty,
        receivedWeight: Number(ri.receivedWeight),
        acceptedQty: ri.acceptedQty,
        repairQty: ri.repairQty,
        rejectedQty: ri.rejectedQty,
        rejectReason: ri.rejectReason,
        rejectPaymentMode: ri.rejectPaymentMode,
        rejectAdjustment: ri.rejectAdjustment != null ? Number(ri.rejectAdjustment) : null,
        fromRepairOrderId: ri.fromRepairOrderId,
        remarks: ri.remarks,
        costPerKg: ri.costPerKg != null ? Number(ri.costPerKg) : null,
      })),
    };
  }

  /**
   * Update an existing receipt in place — same receipt id + receiptNumber +
   * createdAt are preserved (so the slip's identity in the books / vendor
   * ledger doesn't change). Internally this is a destructive
   * delete-and-recreate of the receipt items inside one transaction.
   *
   * Guards (refused with friendly messages):
   *   • Forwarded-out: any pieces in this receipt have already been
   *     forwarded to a downstream stage. Operator must undo the forward
   *     first (mirrors deleteReceipt's existing guard).
   *   • Repair complexity: receipt has rows linked to a parent
   *     RepairOrder (fromRepairOrderId) OR rows that themselves flagged
   *     pieces for repair (repairQty > 0). Editing those cleanly would
   *     require unwinding the repair order chain — too risky for v1.
   *     Operator gets "delete this receipt and create a new one" as the
   *     fix path.
   *   • Batch / vendor change: the receipt's batch and vendor are
   *     locked. Changing those is a different receipt entirely.
   */
  async updateReceipt(receiptId: number, dto: CreateReceiptDto, userId?: number) {
    const receipt = await this.prisma.castingReceipt.findUnique({
      where: { id: receiptId },
      include: { items: true },
    });
    if (!receipt) throw new NotFoundException('Receipt not found.');

    // Guard 0 — batch + vendor are locked. Frontend should never let
    // these change, but the controller doesn't gate so we re-check.
    if (dto.batchId !== receipt.batchId || dto.vendorId !== receipt.vendorId) {
      throw new BadRequestException(
        'Batch and vendor cannot be changed on an edit. Delete this receipt and create a new one instead.',
      );
    }

    // Guard 1 — forwarded-out. For each row in the EXISTING receipt,
    // make sure removing its qty wouldn't leave the batch item with
    // fewer received pieces than have been forwarded onward.
    for (const ri of receipt.items) {
      const bi = await this.prisma.castingBatchItem.findUnique({
        where: { id: ri.batchItemId },
        include: { receiptRows: true },
      });
      if (!bi) continue;
      const currentReceived = bi.receiptRows.reduce((s, r) => s + r.receivedQty, 0);
      const children = await this.prisma.castingBatchItem.findMany({
        where: { parentItemId: bi.id },
        select: { quantity: true },
      });
      const forwarded = children.reduce((s, c) => s + c.quantity, 0);
      if (currentReceived - ri.receivedQty < forwarded) {
        throw new BadRequestException(
          `Cannot edit this receipt — ${forwarded} piece(s) of "${bi.vendorDesignReference ?? bi.itemNumber ?? bi.id}" were already forwarded to the next process. Reverse that forward first, then edit.`,
        );
      }
    }

    // Guard 2 — repair complexity.
    const hasRepairFrom = receipt.items.some((ri) => ri.fromRepairOrderId != null);
    const hasRepairOut = receipt.items.some((ri) => (ri.repairQty ?? 0) > 0);
    if (hasRepairFrom || hasRepairOut) {
      throw new BadRequestException(
        'Cannot edit receipts that include repair-related rows. Delete the receipt and re-create it instead — the deletion handler safely reverses the linked repair orders.',
      );
    }
    // Guard 3 — new payload mustn't introduce repair on the edit either
    // (same reason as Guard 2: keeps the edit path simple).
    if (dto.items.some((i) => (i.repairQty ?? 0) > 0 || i.fromRepairOrderId != null)) {
      throw new BadRequestException(
        'Cannot add repair rows on an edit. Save the basic correction first, then start a new receipt to mark pieces for repair.',
      );
    }

    // Re-run the same validation + normalisation that createReceipt uses,
    // against the new payload.
    const batchItems = await this.prisma.castingBatchItem.findMany({
      where: { batchId: dto.batchId, vendorId: dto.vendorId, closed: false },
      select: { id: true, weight: true, costPerKg: true, itemId: true, processId: true },
    });
    const weightById = new Map(batchItems.map((b) => [b.id, Number(b.weight)]));
    const stageById = new Map(batchItems.map((b) => [b.id, b]));
    const validIds = new Set(batchItems.map((b) => b.id));

    const rows = dto.items.filter(
      (i) => validIds.has(i.batchItemId) && ((i.receivedQty ?? 0) !== 0 || (i.receivedWeight ?? 0) !== 0),
    );

    type NormalizedRow = (typeof rows)[number] & {
      _accepted: number; _repair: number; _rejected: number; _lost: number;
      _rejectMode: 'NO_PAY' | 'ADJUSTED' | 'FULL_PAY' | null;
      _rejectAdj: number | null;
    };
    const normalized: NormalizedRow[] = [];
    for (let idx = 0; idx < rows.length; idx++) {
      const i = rows[idx];
      const recv = i.receivedQty ?? 0;
      const accSupplied = i.acceptedQty != null || i.repairQty != null || i.rejectedQty != null;
      const acc = accSupplied ? (i.acceptedQty ?? 0) : recv;
      const rep = i.repairQty ?? 0;
      const rej = i.rejectedQty ?? 0;
      if (acc < 0 || rep < 0 || rej < 0) {
        throw new BadRequestException(`Row ${idx + 1}: accept / repair / reject qty cannot be negative.`);
      }
      if (acc + rep + rej !== recv) {
        throw new BadRequestException(
          `Row ${idx + 1}: accepted (${acc}) + repair (${rep}) + rejected (${rej}) = ${acc + rep + rej}, must equal received (${recv}).`,
        );
      }
      if (rej > 0 && !i.rejectPaymentMode) {
        throw new BadRequestException(
          `Row ${idx + 1}: ${rej} pcs marked rejected — pick a payment mode (NO_PAY / ADJUSTED / FULL_PAY).`,
        );
      }
      if (i.rejectPaymentMode === 'ADJUSTED' && (i.rejectAdjustment == null || i.rejectAdjustment < 0)) {
        throw new BadRequestException(
          `Row ${idx + 1}: ADJUSTED reject requires a non-negative rejectAdjustment amount.`,
        );
      }
      normalized.push({
        ...i,
        _accepted: acc, _repair: rep, _rejected: rej,
        _lost: Math.max(0, Math.trunc(Number((i as any).lostQty ?? 0))),
        _rejectMode: (i.rejectPaymentMode as any) ?? null,
        _rejectAdj: i.rejectPaymentMode === 'ADJUSTED' ? (i.rejectAdjustment ?? 0) : null,
      });
    }

    // Snapshot the BEFORE state for the audit log / undo path.
    const beforeSnap = {
      id: receipt.id,
      receiptNumber: receipt.receiptNumber,
      batchId: receipt.batchId,
      vendorId: receipt.vendorId,
      receiptDate: receipt.receiptDate,
      notes: receipt.notes,
      items: receipt.items.map((ri) => ({
        batchItemId: ri.batchItemId,
        receivedQty: ri.receivedQty,
        receivedWeight: Number(ri.receivedWeight),
        acceptedQty: ri.acceptedQty,
        repairQty: ri.repairQty,
        rejectedQty: ri.rejectedQty,
        rejectPaymentMode: ri.rejectPaymentMode,
        rejectAdjustment: ri.rejectAdjustment != null ? Number(ri.rejectAdjustment) : null,
        costPerKg: ri.costPerKg != null ? Number(ri.costPerKg) : null,
        remarks: ri.remarks,
      })),
    };

    // ---- transaction: wipe + recreate items, update header. ----
    await this.prisma.$transaction(async (tx) => {
      await tx.castingReceiptItem.deleteMany({ where: { receiptId } });
      await tx.castingReceipt.update({
        where: { id: receiptId },
        data: {
          receiptDate: new Date(dto.receiptDate),
          notes: dto.notes ?? null,
        },
      });
      for (const i of normalized) {
        const qty = i.receivedQty ?? 0;
        const weight = i.receivedWeight != null && i.receivedWeight !== 0
          ? i.receivedWeight
          : qty * (weightById.get(i.batchItemId) ?? 0);
        const stageRate = stageById.get(i.batchItemId)?.costPerKg;
        const stageRateN = stageRate != null ? Number(stageRate) : null;
        const receiptRate =
          i.costPerKg != null && stageRateN !== null && Number(i.costPerKg) !== stageRateN
            ? Number(i.costPerKg)
            : i.costPerKg != null && stageRateN === null
              ? Number(i.costPerKg)
              : null;
        await tx.castingReceiptItem.create({
          data: {
            receiptId,
            batchItemId: i.batchItemId,
            receivedQty: qty,
            receivedWeight: weight,
            acceptedQty: i._accepted,
            repairQty: 0, // guard 2/3 ensures this is always 0 on edit
            rejectedQty: i._rejected,
            rejectReason: i.rejectReason ?? null,
            rejectPaymentMode: i._rejectMode as any,
            rejectAdjustment: i._rejectAdj,
            remarks: i.remarks ?? null,
            costPerKg: receiptRate,
          },
        });
      }
    });

    await this.recomputeBatchStatus(receipt.batchId);

    // Audit log — undoable in theory via "delete the new items + re-apply
    // the before snapshot", but we don't register an undo handler in v1
    // because reverting a rate change downstream (vendor ledger entries
    // etc.) needs more thought. Logged for traceability + manual revert.
    const afterSnap = await this.findReceipt(receiptId);
    await this.audit.log(userId, {
      action: 'casting.receipt.update',
      targetType: 'CastingReceipt',
      targetId: receiptId,
      description: `Edited receipt ${receipt.receiptNumber} on batch #${receipt.batchId}`,
      snapshotBefore: beforeSnap,
      snapshotAfter: afterSnap,
    });

    return { id: receiptId, receiptNumber: receipt.receiptNumber };
  }

  /**
   * Delete a receipt (correction handling) and restore all balances. Blocked if
   * any of its received pieces have already been forwarded to a next process —
   * those must be reversed first so quantities stay consistent.
   */
  async deleteReceipt(receiptId: number, userId?: number) {
    const receipt = await this.prisma.castingReceipt.findUnique({
      where: { id: receiptId },
      include: { items: true },
    });
    if (!receipt) throw new NotFoundException('Receipt not found.');

    for (const ri of receipt.items) {
      const bi = await this.prisma.castingBatchItem.findUnique({
        where: { id: ri.batchItemId },
        include: { receiptRows: true },
      });
      if (!bi) continue;
      const currentReceived = bi.receiptRows.reduce((s, r) => s + r.receivedQty, 0);
      const children = await this.prisma.castingBatchItem.findMany({ where: { parentItemId: bi.id } });
      const forwarded = children.reduce((s, c) => s + c.quantity, 0);
      if (currentReceived - ri.receivedQty < forwarded) {
        throw new BadRequestException(
          `Cannot delete this receipt — ${forwarded} piece(s) of "${bi.vendorDesignReference ?? bi.itemNumber}" were already forwarded to the next process. Reverse that first.`,
        );
      }
    }

    const batchId = receipt.batchId;
    // Snapshot for UNDO — lets the client recreate this exact receipt.
    const undo = {
      batchId,
      vendorId: receipt.vendorId,
      receiptDate: receipt.receiptDate,
      notes: receipt.notes ?? undefined,
      items: receipt.items.map((ri) => ({
        batchItemId: ri.batchItemId,
        receivedQty: ri.receivedQty,
        receivedWeight: Number(ri.receivedWeight),
        remarks: ri.remarks ?? undefined,
      })),
    };
    await this.prisma.castingReceipt.delete({ where: { id: receiptId } });
    await this.recomputeBatchStatus(batchId);
    // Audit — record the deletion + the FULL receipt snapshot. Not
    // auto-undoable from the activity log (the controller's existing
    // toast-undo path already lets the operator re-create immediately).
    await this.audit.log(userId, {
      action: 'casting.receipt.delete',
      targetType: 'CastingReceipt',
      targetId: receiptId,
      description: `Deleted receipt ${receipt.receiptNumber} from batch #${batchId}`,
      snapshotBefore: { receiptId, ...undo },
    });
    return { id: receiptId, undo };
  }

  async listReceipts(query: ReceiptQueryDto) {
    const where: Prisma.CastingReceiptWhereInput = {};
    if (query.search) {
      where.OR = [
        { receiptNumber: { contains: query.search } },
        { batch: { batchNumber: { contains: query.search } } },
        { vendor: { vendorName: { contains: query.search } } },
      ];
    }
    const receipts = await this.prisma.castingReceipt.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { batch: true, vendor: true, _count: { select: { items: true } } },
    });
    return receipts.map((r) => ({
      id: r.id,
      receiptNumber: r.receiptNumber,
      receiptDate: r.receiptDate,
      batchId: r.batchId,
      batchNumber: r.batch.batchNumber,
      // Delivery status of the parent batch:
      // COMPLETED -> Completely Delivered, PARTIAL -> Partial, OPEN -> Not Delivered.
      batchStatus: r.batch.status,
      vendorId: r.vendorId,
      vendorName: r.vendor.vendorName,
      itemCount: r._count.items,
    }));
  }

  /**
   * Pending sheet for a batch + vendor (used by the receive form). Only shows
   * stages that still have pieces to receive — closed lines and fully-received
   * (already forwarded) stages are excluded so the floor only sees open work.
   *
   * For STICKING stages we also surface the linked material-issue voucher's
   * open lines so the receive form can prompt "vendor returning the extra
   * material or keeping it?" inline, instead of forcing a separate trip to
   * the Material Issues page.
   */
  async pendingForVendor(batchId: number, vendorId: number, editReceiptId?: number) {
    const batch = await this.getBatch(batchId);
    // Stages this vendor can return pcs against: not closed, and either
    // (a) classic pending pcs (qty - settled - openRepair > 0), or
    // (b) at least one OPEN repair order linked to this stage from this
    //     vendor — those pcs are sitting at the vendor as a repair lot and
    //     need to come back as a new receipt. Without (b), B0046-style
    //     stages where everything's already been settled-or-sent-for-repair
    //     would silently filter out and the user couldn't "Receive back".
    const stageIdsWithOpenRepair = new Set(
      (
        await this.prisma.repairOrder.findMany({
          where: {
            stageId: { in: batch.items.filter((i) => i.vendorId === vendorId).map((i) => i.id) },
            vendorId,
            status: 'OPEN',
          },
          select: { stageId: true },
        })
      ).map((r) => r.stageId),
    );

    // Edit-mode adjustment: when this call is in the service of editing
    // an existing receipt, we PRESENT a "pre-this-receipt" view to the
    // form. That means:
    //   • Add this receipt's SETTLED qty (acc+rej) back to pendingQty
    //     so the row shows the full headroom the operator can work
    //     with (otherwise the row says "Pending 0" and changing Recv
    //     Qty makes no sense).
    //   • Subtract the same SETTLED qty from receivedQty so the
    //     "Recd-so-far" column shows what OTHER receipts have brought
    //     in. Without this, the operator sees Recd-so-far INCLUDING
    //     this receipt's pcs AND also sees the same pcs pre-filled in
    //     Recv Qty — reads as "adding more on top of what's already
    //     received" which is the exact confusion the user reported.
    //   • Include the row in the list even if pendingQty is currently
    //     0 (because this receipt fully filled it) — otherwise rows
    //     vanish from the edit form.
    // We track SETTLED (accepted + rejected), not gross receivedQty,
    // because the stage's receivedQty field on the batch is itself the
    // settled total (see getBatch — pendingQty = quantity − settled −
    // openRepair). Adding gross would over-add for repair-bearing
    // receipts; Guard 2 in updateReceipt blocks editing those anyway
    // but defence-in-depth keeps the math right if that ever changes.
    const editReceiptItems = editReceiptId
      ? await this.prisma.castingReceiptItem.findMany({
          where: { receiptId: editReceiptId },
          select: { batchItemId: true, acceptedQty: true, rejectedQty: true },
        })
      : [];
    const editSettledAddBack = new Map<number, number>();
    const editStageIds = new Set<number>();
    for (const ri of editReceiptItems) {
      editStageIds.add(ri.batchItemId);
      const settled = (ri.acceptedQty ?? 0) + (ri.rejectedQty ?? 0);
      editSettledAddBack.set(ri.batchItemId, (editSettledAddBack.get(ri.batchItemId) ?? 0) + settled);
    }

    const items = batch.items
      .filter(
        (i) =>
          i.vendorId === vendorId &&
          !i.closed &&
          (i.pendingQty > 0 || stageIdsWithOpenRepair.has(i.id) || editStageIds.has(i.id)),
      )
      .map((i) => {
        const addBack = editSettledAddBack.get(i.id) ?? 0;
        if (!addBack) return i;
        return {
          ...i,
          pendingQty: i.pendingQty + addBack,
          receivedQty: Math.max(0, i.receivedQty - addBack),
        };
      });

    // Attach linked material-issue voucher to ANY stage that has one —
    // Sticking (auto BOM), Filing / Polish / etc. (ad-hoc issue from the
    // Forward dialog). The receive form's materials-return section
    // renders one block per stage with a voucher.
    const stagesWithMaterialIssues = items.map((i) => i.id);
    let linkedIssuesByStage = new Map<number, any>();
    if (stagesWithMaterialIssues.length) {
      const issues = await this.prisma.materialIssue.findMany({
        where: {
          stageId: { in: stagesWithMaterialIssues },
          status: { not: 'CLOSED' },
        },
        include: { lines: { include: { variant: true } }, stage: true },
      });
      for (const iss of issues) {
        if (!iss.stageId) continue;
        // Pull perPiece from the stage's BOM snapshot so the receive form can
        // auto-calculate "used = perPiece × sticking pcs received NOW". This
        // is the same number the system used at issue time, frozen.
        const snap: any[] = Array.isArray(iss.stage?.bomSnapshot) ? (iss.stage!.bomSnapshot as any[]) : [];
        const perPieceByVariant = new Map<number, number>();
        for (const s of snap) {
          if (!s?.variantId) continue;
          const pp = s.perPiece != null ? Number(s.perPiece) : 0;
          perPieceByVariant.set(s.variantId, Math.round(pp));
        }
        const lines = iss.lines
          .map((l) => {
            const cons = (l as any).consumedQty ?? 0;
            // Pending here excludes already-consumed — that's what the vendor
            // physically still has and can return/keep/mark-used at this receipt.
            const pending = l.issuedQty - l.receivedQty - cons;
            const issuedW   = Number((l as any).issuedWeight ?? 0);
            const receivedW = Number((l as any).receivedWeight ?? 0);
            const consumedW = Number((l as any).consumedWeight ?? 0);
            const pendingW  = Math.round((issuedW - receivedW - consumedW) * 1000) / 1000;
            return {
              lineId: l.id,
              variantId: l.variantId,
              variantCode: l.variant.variantCode,
              variantName: l.variant.variantName,
              unit: l.variant.unit,
              trackByQty: (l.variant as any).trackByQty ?? true,
              trackByWeight: (l.variant as any).trackByWeight ?? false,
              issuedQty: l.issuedQty,
              receivedQty: l.receivedQty,
              consumedQty: cons,
              pendingQty: pending,
              // Weight ledger — surfaced so the receive form can prompt for
              // returned + used weight on filing-style materials (weighed in,
              // weighed back out).
              issuedWeight: issuedW,
              receivedWeight: receivedW,
              consumedWeight: consumedW,
              pendingWeight: pendingW,
              lostWeight: Number((l as any).lostWeight ?? 0),
              runnersWeight: Number((l as any).runnersWeight ?? 0),
              // BOM per sticking piece — drives the auto-used calc in the UI.
              perPiece: perPieceByVariant.get(l.variantId) ?? 0,
            };
          })
          .filter((l) => l.pendingQty > 0 || l.pendingWeight > 0);
        if (lines.length) {
          // Aggregate across multiple issues to the same stage — when the
          // operator issued extra material later (initial forward auto-
          // issue + a subsequent "Issue more" voucher), Map.set was
          // overwriting the earlier entry so the receive form only saw
          // the LAST voucher's lines. Now we keep every voucher and
          // merge line data by variantId so the operator sees the
          // combined pending qty/weight AND a comma-separated voucher
          // list for context.
          const prev = linkedIssuesByStage.get(iss.stageId);
          if (!prev) {
            linkedIssuesByStage.set(iss.stageId, {
              issueId: iss.id,
              voucherNumber: iss.voucherNumber,
              // Track every source issue so the frontend can render a
              // "V001 + V004" summary if multiple exist.
              voucherNumbers: [iss.voucherNumber],
              lines,
            });
          } else {
            prev.voucherNumbers.push(iss.voucherNumber);
            prev.voucherNumber = prev.voucherNumbers.join(' + ');
            // Merge lines by variantId — sum issued / received / consumed /
            // pending across all vouchers so the operator sees the true
            // outstanding balance the vendor still owes.
            const byVariant = new Map<number, any>(prev.lines.map((l: any) => [l.variantId, l]));
            for (const ln of lines) {
              const existing = byVariant.get(ln.variantId);
              if (!existing) {
                byVariant.set(ln.variantId, ln);
              } else {
                existing.issuedQty       += ln.issuedQty;
                existing.receivedQty     += ln.receivedQty;
                existing.consumedQty     += ln.consumedQty;
                existing.pendingQty      += ln.pendingQty;
                existing.issuedWeight    = Math.round((existing.issuedWeight + ln.issuedWeight) * 1000) / 1000;
                existing.receivedWeight  = Math.round((existing.receivedWeight + ln.receivedWeight) * 1000) / 1000;
                existing.consumedWeight  = Math.round((existing.consumedWeight + ln.consumedWeight) * 1000) / 1000;
                existing.pendingWeight   = Math.round((existing.pendingWeight + ln.pendingWeight) * 1000) / 1000;
                existing.lostWeight      = Math.round((existing.lostWeight + ln.lostWeight) * 1000) / 1000;
                existing.runnersWeight   = Math.round((existing.runnersWeight + ln.runnersWeight) * 1000) / 1000;
                // perPiece stays with the first line — vouchers share the
                // stage's BOM snapshot so they agree.
              }
            }
            prev.lines = Array.from(byVariant.values());
          }
        }
      }
    }

    return {
      batchNumber: batch.batchNumber,
      items: items.map((i) => ({
        ...i,
        // Only populated for sticking stages that have an open auto-issued voucher.
        materialIssue: linkedIssuesByStage.get(i.id) ?? null,
      })),
    };
  }

  /**
   * Full-fledged inventory: every piece of every design wherever it is, in one of
   * three states — FINISHED (packed, in our hands), IN_HOUSE (received mid-chain,
   * awaiting next forward), AT_VENDOR (issued, vendor is working on it). Grouped
   * by design + process + vendor + COLOUR so colour lots don't merge.
   */
  async producedGoods(itemId?: number) {
    // Load ALL stages (incl. closed) so the forwarded-out chain stays correct —
    // a parent's child stage still counts toward its forwarded total even if the
    // child was later short-closed. We only filter closed stages when EMITTING.
    const rows = await this.prisma.castingBatchItem.findMany({
      where: itemId ? { itemId } : {},
      include: {
        receiptRows: true,
        stageProcess: true,
        item: { include: { processes: { include: { process: true, vendors: true } } } },
        batch: true,
        vendor: true,
        // repairOrders so byDesign rollup can count "currently in repair" pcs
        // per design (Item Statement Dialog surfaces this).
        repairOrders: true,
      },
    });
    // Forwarded-out qty per stage = Σ children quantity (across ALL children).
    const fwd = new Map<number, number>();
    for (const r of rows) if (r.parentItemId != null) fwd.set(r.parentItemId, (fwd.get(r.parentItemId) ?? 0) + r.quantity);

    const nextProcessOf = (r: (typeof rows)[number]) => {
      const procs = (r.item?.processes ?? [])
        .filter((p) => (p.vendors?.length ?? 0) > 0)
        .sort((a, b) => a.process.sortOrder - b.process.sortOrder);
      const curSort = r.stageProcess?.sortOrder ?? null;
      if (curSort == null) return null;
      const next = procs.find((p) => p.process.sortOrder > curSort);
      if (!next) return null;
      const colours = Array.from(new Set(next.vendors.map((v) => (v.color ?? '').trim()).filter(Boolean)));
      return {
        nextProcessId: next.processId,
        nextProcessName: next.process.name,
        nextProcessCode: next.process.code,
        nextUsesColor: COLOUR_PROCESSES.includes(next.process.code),
        nextColorOptions: colours,
      };
    };

    const baseInfo = (r: (typeof rows)[number]) => ({
      itemId: r.itemId!,
      itemNumber: r.item?.itemNumber ?? null,
      designCode: r.item?.sampleDesignCode ?? r.itemNumber,
      itemName: r.item?.itemName ?? null,
      processId: r.processId,
      processName: r.stageProcess?.name ?? '—',
      processCode: r.stageProcess?.code ?? null,
      vendorId: r.vendorId,
      vendorCode: r.vendor?.vendorCode ?? null,
      vendorName: r.vendor?.vendorName ?? null,
      color: r.color ?? null,
      // Reflects whether the parent batch was short-closed — the inventory page
      // marks these lots as "frozen / short-closed" instead of "ready for next step".
      batchClosed: r.batch?.closed === true,
    });

    // Group key INCLUDES colour so colour lots stay separate (no more merging).
    const groups = new Map<string, any>();
    for (const r of rows) {
      if (!r.itemId) continue;
      // Stock = pcs PHYSICALLY in our hand at this step. That's accepted pcs
      // (passed QC); rejected pcs were written off; repair pcs are with
      // vendor again. So only acceptedQty counts toward inventory.
      const accepted = r.receiptRows.reduce((s, x) => s + x.acceptedQty, 0);
      const idle = accepted - (fwd.get(r.id) ?? 0);
      // Closed (short-closed) stages: vendor's pending was written off; what
      // came back & passed QC is stock. Repair pcs (with vendor) are NOT
      // at-vendor for inventory purposes — they're tracked in the Repair
      // module. at-vendor here only counts "pcs vendor still owes from the
      // original order" = quantity - accepted - rejected (settled qty).
      const settled = r.receiptRows.reduce((s, x) => s + x.acceptedQty + x.rejectedQty, 0);
      const atVendor = r.closed ? 0 : Math.max(r.quantity - settled, 0);
      const colourKey = (r.color ?? '').toLowerCase();
      // Include batch-closed status in the key so a closed-batch lot stays distinct
      // from an active-batch lot of the same design/process/vendor/colour.
      const batchClosedKey = r.batch?.closed ? 'C' : 'O';
      const baseKey = `${r.itemId}:${r.processId}:${r.vendorId}:${colourKey}:${batchClosedKey}`;

      if (idle > 0) {
        const isFinished = r.stageProcess?.code === 'PACKING';
        const state = isFinished ? 'FINISHED' : 'IN_HOUSE';
        const key = `${state}:${baseKey}`;
        const np = !isFinished ? nextProcessOf(r) : null;
        const g = groups.get(key) ?? {
          state, finished: isFinished, // legacy flag for existing UI
          ...baseInfo(r),
          qty: 0,
          // shortQty = pcs ordered but NEVER received before short-close (now
          // owed by vendor on the ledger). Surfaced in the item statement
          // dialog so the user sees "received X · short Y · total ordered X+Y"
          // for short-closed stages instead of guessing the lost qty.
          shortQty: 0,
          stages: [] as { id: number; idle: number }[],
          batches: new Set<string>(),
          ...(np ?? { nextProcessId: null, nextProcessName: null, nextProcessCode: null, nextUsesColor: false, nextColorOptions: [] as string[] }),
        };
        g.qty += idle;
        if (r.closed) g.shortQty += r.shortQty ?? 0;
        g.stages.push({ id: r.id, idle });
        g.batches.add(r.batch.batchNumber);
        groups.set(key, g);
      }

      if (atVendor > 0) {
        const key = `AT_VENDOR:${baseKey}`;
        // For AT_VENDOR we surface the suggested next process too, so the
        // new-batch dialog can default the planned forward target.
        const np = nextProcessOf(r);
        const g = groups.get(key) ?? {
          state: 'AT_VENDOR', finished: false,
          ...baseInfo(r),
          qty: 0,
          // Stage ids ARE needed for AT_VENDOR — the new-batch dialog uses them
          // to register a "planned forward" so receipts auto-route into the
          // new batch (see /casting/stages/:id/plan-forward). batchId +
          // perPieceWeight let the dialog construct a Receive Goods call when
          // the user picks "Receive now" instead of "plan for later".
          stages: [] as { id: number; idle: number; batchId: number; perPieceWeight: number }[],
          batches: new Set<string>(),
          ...(np ?? { nextProcessId: null, nextProcessName: null, nextProcessCode: null, nextUsesColor: false, nextColorOptions: [] as string[] }),
        };
        g.qty += atVendor;
        g.stages.push({ id: r.id, idle: atVendor, batchId: r.batchId, perPieceWeight: Number(r.weight) });
        g.batches.add(r.batch.batchNumber);
        groups.set(key, g);
      }
    }

    // ---------------------------------------------------------------------
    // Cost-of-production per FINISHED lot — sum every stage's totalCost
    // along the lineage chain (root casting → … → packing), de-duped if a
    // single stage feeds multiple FINISHED lots. Different production
    // runs of the same design can have DIFFERENT rates (vendor changed
    // costPerKg between runs), so this number is computed PER LOT rather
    // than as a design-wide average — exactly what the user asked for.
    // Materials and additional-services costs are NOT included in v1;
    // they can be added later as further sums.
    // ---------------------------------------------------------------------
    const parentOf = new Map<number, number | null>();
    const stageById = new Map<number, (typeof rows)[number]>();
    for (const r of rows) { parentOf.set(r.id, r.parentItemId); stageById.set(r.id, r); }
    const lineageIds = (stageId: number): number[] => {
      const out: number[] = [];
      let cur: number | null | undefined = stageId;
      while (cur != null) { out.push(cur); cur = parentOf.get(cur); }
      return out;
    };

    const allRows = Array.from(groups.values())
      .map((g) => ({ ...g, batches: Array.from(g.batches) }))
      .sort((a, b) => String(a.itemNumber ?? '').localeCompare(String(b.itemNumber ?? ''), undefined, { numeric: true }));

    for (const g of allRows) {
      if (g.state !== 'FINISHED') continue;
      let cost = 0;
      const seen = new Set<number>();
      // Per-process breakdown so the UI can show "Casting Rs. X · Plating
      // Rs. Y …" instead of just one number — makes rate variation across
      // runs obvious at a glance.
      const byProcess: Record<string, number> = {};
      for (const s of g.stages as { id: number }[]) {
        for (const id of lineageIds(s.id)) {
          if (seen.has(id)) continue;
          seen.add(id);
          const stg = stageById.get(id);
          if (!stg) continue;
          const c = stg.totalCost != null ? Number(stg.totalCost) : 0;
          cost += c;
          const procName = stg.stageProcess?.name ?? 'Unknown';
          byProcess[procName] = (byProcess[procName] ?? 0) + c;
        }
      }
      g.productionCost = Math.round(cost * 100) / 100;
      g.productionCostPerPc = g.qty > 0 ? Math.round((cost / g.qty) * 100) / 100 : 0;
      g.productionCostByProcess = Object.fromEntries(
        Object.entries(byProcess).map(([k, v]) => [k, Math.round(v * 100) / 100]),
      );
    }

    // Per-design rollup so the inventory page can show totals per design.
    const byDesignMap = new Map<number, any>();
    for (const g of allRows) {
      const cur = byDesignMap.get(g.itemId) ?? {
        itemId: g.itemId, itemNumber: g.itemNumber, designCode: g.designCode, itemName: g.itemName,
        finishedQty: 0, inHouseQty: 0, atVendorQty: 0, totalQty: 0,
        rejectedQty: 0, inRepairQty: 0,
        openRepairs: [] as any[],
      };
      if (g.state === 'FINISHED') cur.finishedQty += g.qty;
      else if (g.state === 'IN_HOUSE') cur.inHouseQty += g.qty;
      else cur.atVendorQty += g.qty;
      cur.totalQty += g.qty;
      byDesignMap.set(g.itemId, cur);
    }
    // Roll up rejected pcs (lifetime) + currently-in-repair pcs per design
    // from the raw stage rows. Item Statement Dialog renders these as their
    // own sections so the user sees "🔴 12 rejected · 🔧 5 in repair" right
    // alongside finished/in-house counters.
    // openRepairs[] surfaces every OPEN RepairOrder for the item so the
    // dialog can render a per-repair table (batch · vendor · qty · cycle ·
    // reason) instead of just a single aggregate number.
    for (const r of rows) {
      if (!r.itemId) continue;
      const cur = byDesignMap.get(r.itemId);
      if (!cur) continue;
      cur.rejectedQty += r.receiptRows.reduce((s: number, x: any) => s + x.rejectedQty, 0);
      const openOnStage = (r.repairOrders ?? []).filter((ro: any) => ro.status === 'OPEN');
      cur.inRepairQty += openOnStage.reduce((s: number, ro: any) => s + ro.qty, 0);
      for (const ro of openOnStage) {
        cur.openRepairs.push({
          id: ro.id,
          batchNumber: r.batch?.batchNumber ?? null,
          vendorCode: r.vendor?.vendorCode ?? null,
          vendorName: r.vendor?.vendorName ?? null,
          processName: r.stageProcess?.name ?? '—',
          color: r.color ?? null,
          qty: ro.qty,
          cycle: ro.cycle,
          reason: ro.reason ?? null,
          sentAt: ro.sentAt,
        });
      }
    }
    const byDesign = Array.from(byDesignMap.values()).sort((a, b) => String(a.itemNumber ?? '').localeCompare(String(b.itemNumber ?? ''), undefined, { numeric: true }));

    // ---------------------------------------------------------------------
    // Short-closed pcs per process — INFO ONLY, not inventory.
    //
    // Production Inventory shows physical stock (pcs we hold). Short-closed
    // pcs are LOST (vendor owes them on the ledger) — they don't belong in
    // any inventory row. But the user still wants a small contextual line
    // on each process card: "X pcs short-closed at this step" so the loss
    // is visible without opening the batch.
    //
    // We aggregate by processCode:
    //   shortByProcess[CASTING]  = total short-closed at Casting
    //   shortByProcess[FITTING]  = total short-closed at Fitting
    //   …
    // The frontend renders this as a sub-line on the card, completely
    // independent of the inventory rows above.
    // ---------------------------------------------------------------------
    const shortByProcess: Record<string, number> = {};
    for (const r of rows) {
      if (!r.closed) continue;
      const qty = r.shortQty ?? 0;
      if (qty <= 0) continue;
      const code = r.stageProcess?.code ?? 'OTHER';
      shortByProcess[code] = (shortByProcess[code] ?? 0) + qty;
    }

    return { rows: allRows, byDesign, shortByProcess };
  }

  /**
   * Record a "planned forward" on an AT-VENDOR stage. When this stage is later
   * received via Receive Goods, the receipt handler will auto-forward the newly
   * received pieces to the planned next process / vendor / colour, into the
   * planned target batch. Lets the new-batch dialog steer at-vendor pieces into
   * the new batch the moment they physically return — no manual forward needed.
   *
   * Pass nulls to clear an existing plan.
   */
  async planForward(
    stageId: number,
    plan: {
      nextProcessId: number | null;
      vendorId?: number | null;
      color?: string | null;
      targetBatchId?: number | null;
    },
  ) {
    const stage = await this.prisma.castingBatchItem.findUnique({ where: { id: stageId } });
    if (!stage) throw new NotFoundException('Stage not found.');
    await this.prisma.castingBatchItem.update({
      where: { id: stageId },
      data: {
        plannedNextProcessId: plan.nextProcessId ?? null,
        plannedNextVendorId: plan.vendorId ?? null,
        plannedNextColor: plan.color ?? null,
        plannedTargetBatchId: plan.targetBatchId ?? null,
      },
    });
    return { id: stageId };
  }

  /**
   * "Continue" idle in-process pieces straight to their next process — used from
   * the new-batch dialog so existing stock is settled instead of re-cast. Forwards
   * each idle stage's available pieces to `nextProcessId` (colour chosen per step,
   * which auto-picks that colour's vendor unless `vendorId` overrides).
   *
   * `maxQty` caps the TOTAL forwarded across all listed stages — so the dialog
   * can say "use 30 of these 80 idle pcs and leave the rest in stock." When
   * omitted, every stage's full idle qty is forwarded as before.
   */
  async settleInProcess(
    dto: { stageIds: number[]; nextProcessId: number; color?: string; vendorId?: number; maxQty?: number; targetBatchId?: number },
    userId?: number,
  ) {
    if (!dto.stageIds?.length) throw new BadRequestException('No pieces to continue.');
    let forwarded = 0;
    let remaining = dto.maxQty != null ? Math.max(0, Math.trunc(dto.maxQty)) : Number.POSITIVE_INFINITY;
    for (const stageId of dto.stageIds) {
      if (remaining <= 0) break;
      const stage = await this.prisma.castingBatchItem.findUnique({
        where: { id: stageId },
        include: { receiptRows: true },
      });
      if (!stage) continue;
      const received = stage.receiptRows.reduce((s, r) => s + r.receivedQty, 0);
      const children = await this.prisma.castingBatchItem.findMany({ where: { parentItemId: stage.id } });
      const already = children.reduce((s, c) => s + c.quantity, 0);
      const idle = received - already;
      if (idle <= 0) continue;
      const take = Math.min(idle, remaining);
      await this.forwardStage(
        stageId,
        { processId: dto.nextProcessId, quantity: take, color: dto.color, vendorId: dto.vendorId },
        userId,
        { targetBatchId: dto.targetBatchId },
      );
      forwarded += take;
      remaining -= take;
    }
    if (forwarded === 0) throw new BadRequestException('Nothing available to continue.');
    return { forwarded };
  }

  private async recomputeBatchStatus(batchId: number) {
    const items = await this.prisma.castingBatchItem.findMany({
      where: { batchId },
      include: { receiptRows: true, stageProcess: true },
    });
    // Forwarded-out qty per stage (count children's quantity). Children may
    // live in OTHER batches too (cross-batch absorb / settle), so we look
    // across all batches — otherwise a settled-into-new-batch stage would
    // look "stuck" here even though pcs moved on cleanly.
    const stageIds = items.map((i) => i.id);
    const childRows = stageIds.length
      ? await this.prisma.castingBatchItem.findMany({
          where: { parentItemId: { in: stageIds } },
          select: { parentItemId: true, quantity: true },
        })
      : [];
    const forwardedByParent = new Map<number, number>();
    for (const c of childRows) {
      if (c.parentItemId != null) {
        forwardedByParent.set(c.parentItemId, (forwardedByParent.get(c.parentItemId) ?? 0) + c.quantity);
      }
    }

    let anyReceived = false;
    let allDone = true;
    // Open repair counts per stage — if a stage has pending repairs, it's
    // NOT done (vendor still has pcs we're waiting on).
    const openRepairsByStage = new Map<number, number>();
    if (stageIds.length) {
      const openRepairs = await this.prisma.repairOrder.findMany({
        where: { stageId: { in: stageIds }, status: 'OPEN' },
        select: { stageId: true, qty: true },
      });
      for (const r of openRepairs) {
        openRepairsByStage.set(r.stageId, (openRepairsByStage.get(r.stageId) ?? 0) + r.qty);
      }
    }
    for (const it of items) {
      // For completion purposes "settled" qty per stage = accepted + rejected.
      // Repair pcs are at vendor again (re-tracked via RepairOrder). Pure
      // legacy receipts (no buckets set) had acceptedQty backfilled to
      // receivedQty, so the math stays identical for old data.
      const accQty = it.receiptRows.reduce((s, r) => s + r.acceptedQty, 0);
      const rejQty = it.receiptRows.reduce((s, r) => s + r.rejectedQty, 0);
      const settled = accQty + rejQty;
      if (accQty > 0 || rejQty > 0) anyReceived = true;
      // A stage is "done" when no action remains:
      //   1) short-closed → settled, OR
      //   2) settled qty >= ordered AND (it's Packing OR all accepted pcs
      //      were forwarded onward) AND no open repairs are pending
      if (it.closed) continue;
      if (settled < it.quantity) { allDone = false; continue; }
      if ((openRepairsByStage.get(it.id) ?? 0) > 0) { allDone = false; continue; }
      const isPacking = it.stageProcess?.code === 'PACKING';
      if (!isPacking) {
        const forwarded = forwardedByParent.get(it.id) ?? 0;
        if (forwarded < accQty) { allDone = false; continue; }
      }
    }
    const status = allDone && items.length > 0 ? 'COMPLETED' : anyReceived ? 'PARTIAL' : 'OPEN';
    await this.prisma.castingBatch.update({ where: { id: batchId }, data: { status } });
  }

  /** Short-close ONE order line: settle it even though received < ordered. */
  async closeBatchItem(id: number, reason?: string, userId?: number) {
    const item = await this.prisma.castingBatchItem.findUnique({
      where: { id },
      include: { receiptRows: true },
    });
    if (!item) throw new NotFoundException('Batch item not found.');
    const beforeSnap = { id: item.id, closed: item.closed, closedReason: item.closedReason, shortQty: item.shortQty, shortWeight: item.shortWeight };
    // Short-close writes off the SETTLED-vs-ordered gap. Settled = accepted
    // + rejected (rejected counts toward "no longer pending" because the
    // user already decided how to pay for them). Open repair pcs stay open
    // — short-closing while a repair is pending would prematurely write off
    // pcs we're still hoping to get back; we don't auto-block but the UI
    // will warn.
    const settledQty = item.receiptRows.reduce((s, r) => s + r.acceptedQty + r.rejectedQty, 0);
    const receivedWeight = item.receiptRows.reduce((s, r) => s + Number(r.receivedWeight), 0);
    const shortQty = Math.max(item.quantity - settledQty, 0);
    const shortWeight = Math.max(Number(item.totalWeight) - receivedWeight, 0);
    await this.prisma.castingBatchItem.update({
      where: { id },
      data: {
        closed: true,
        closedReason: reason ?? null,
        closedAt: new Date(),
        shortQty,
        shortWeight,
      },
    });
    await this.recomputeBatchStatus(item.batchId);
    await this.audit.log(userId, {
      action: 'casting.batch.item.close',
      targetType: 'CastingBatchItem',
      targetId: id,
      description: `Short-closed stage #${id}${item.itemNumber ? ' (#' + item.itemNumber + ')' : ''} — short ${shortQty} pcs${reason ? ': ' + reason : ''}`,
      snapshotBefore: beforeSnap,
      snapshotAfter: { id, closed: true, shortQty, shortWeight, closedReason: reason ?? null },
      undoStrategy: 'casting.batch.item.close',
    });
    return { id, shortQty, shortWeight };
  }

  /**
   * Mark a batch as Short-Closed at the batch level — also short-closes every
   * still-open stage along the way. The batch.closed flag is the source of truth
   * for the Batch Inventory "Short-Closed" folder; per-stage shorts alone do not
   * qualify a batch as closed.
   */
  async closeBatch(batchId: number, reason?: string, userId?: number) {
    const batch = await this.prisma.castingBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('Batch not found.');
    const stages = await this.prisma.castingBatchItem.findMany({
      where: { batchId, closed: false },
      include: { receiptRows: true },
    });
    let closedStages = 0;
    for (const s of stages) {
      const received = s.receiptRows.reduce((a, r) => a + r.receivedQty, 0);
      if (received >= s.quantity) continue; // already fully received → nothing to short
      await this.closeBatchItem(s.id, reason, userId);
      closedStages++;
    }
    await this.prisma.castingBatch.update({
      where: { id: batchId },
      data: { closed: true, closedAt: new Date(), closedReason: reason ?? null },
    });
    await this.audit.log(userId, {
      action: 'casting.batch.close',
      targetType: 'CastingBatch',
      targetId: batchId,
      description: `Closed batch ${batch.batchNumber} short — ${closedStages} stage(s) auto-short-closed${reason ? ': ' + reason : ''}`,
      snapshotBefore: { id: batchId, closed: false },
      snapshotAfter: { id: batchId, closed: true, closedReason: reason ?? null },
      undoStrategy: 'casting.batch.close',
    });
    return { closedStages };
  }

  /** Reopen a batch marked Short-Closed. (Per-stage closes can be reopened separately.) */
  async reopenBatch(batchId: number) {
    const batch = await this.prisma.castingBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw new NotFoundException('Batch not found.');
    await this.prisma.castingBatch.update({
      where: { id: batchId },
      data: { closed: false, closedAt: null, closedReason: null },
    });
    await this.recomputeBatchStatus(batchId);
    return { id: batchId };
  }

  /** Re-open a mistakenly short-closed line. */
  async reopenBatchItem(id: number) {
    const item = await this.prisma.castingBatchItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Batch item not found.');
    await this.prisma.castingBatchItem.update({
      where: { id },
      data: { closed: false, closedReason: null, closedAt: null, shortQty: null, shortWeight: null },
    });
    await this.recomputeBatchStatus(item.batchId);
    return { id };
  }

  // ================================================================
  // REPAIR ORDERS — list / detail / final-reject (give up on repair).
  // RepairOrders themselves are created automatically when a receive
  // row marks pcs for repair (see createReceipt). They're closed when
  // the vendor returns the pcs via a new receipt that carries
  // fromRepairOrderId. The frontend's /repairs page reads these.
  // ================================================================

  async listRepairs(params?: { status?: string; vendorId?: number; batchId?: number; search?: string }) {
    const where: any = {};
    if (params?.status) where.status = params.status;
    if (params?.vendorId) where.vendorId = Number(params.vendorId);
    // batchId filter — the in-batch Repair Orders panel uses this so it
    // only shows the repairs against THIS batch instead of every open one.
    if (params?.batchId) where.stage = { batchId: Number(params.batchId) };
    const rows = await this.prisma.repairOrder.findMany({
      where,
      include: {
        vendor: true,
        stage: { include: { batch: true, stageProcess: true, item: true } },
        receiptItem: { include: { receipt: true } },
        returns: { include: { receipt: true } },
      },
      orderBy: { sentAt: 'desc' },
    });
    const out = rows
      .map((r) => ({
        id: r.id,
        cycle: r.cycle,
        status: r.status,
        qty: r.qty,
        finalRejectedQty: r.finalRejectedQty,
        reason: r.reason,
        sentAt: r.sentAt,
        returnedAt: r.returnedAt,
        closedAt: r.closedAt,
        notes: r.notes,
        vendorId: r.vendorId,
        vendorCode: r.vendor.vendorCode,
        vendorName: r.vendor.vendorName,
        stageId: r.stageId,
        batchNumber: r.stage?.batch?.batchNumber ?? null,
        batchId: r.stage?.batchId ?? null,
        processId: r.stage?.processId ?? null,
        processName: r.stage?.stageProcess?.name ?? null,
        itemNumber: r.stage?.itemNumber ?? null,
        itemName: r.stage?.item?.itemName ?? null,
        color: r.stage?.color ?? null,
        // Receipt that flagged this repair (so user can trace back).
        originReceiptNumber: r.receiptItem?.receipt?.receiptNumber ?? null,
        originReceiptDate: r.receiptItem?.receipt?.receiptDate ?? null,
        // Latest return receipt (when status = RETURNED).
        returnReceiptNumber: r.returns[0]?.receipt?.receiptNumber ?? null,
      }))
      .filter((r) => {
        if (!params?.search) return true;
        const q = params.search.toLowerCase();
        return (
          (r.batchNumber ?? '').toLowerCase().includes(q) ||
          (r.vendorName ?? '').toLowerCase().includes(q) ||
          (r.vendorCode ?? '').toLowerCase().includes(q) ||
          (r.itemNumber ?? '').toLowerCase().includes(q) ||
          (r.reason ?? '').toLowerCase().includes(q)
        );
      });
    return out;
  }

  async getRepair(id: number) {
    const r = await this.prisma.repairOrder.findUnique({
      where: { id },
      include: {
        vendor: true,
        stage: { include: { batch: true, stageProcess: true, item: true } },
        receiptItem: { include: { receipt: true } },
        returns: { include: { receipt: true } },
        parentRepair: true,
        childRepairs: true,
        createdBy: true,
      },
    });
    if (!r) throw new NotFoundException('Repair order not found.');
    return r;
  }

  /** User gives up on repair — the qty marked here is rejected with the
   *  chosen payment mode, the RepairOrder is closed FINAL_REJECTED, and the
   *  corresponding rejection is recorded back on the origin receipt item. */
  async finalRejectRepair(
    id: number,
    dto: { qty: number; reason?: string; paymentMode: 'NO_PAY' | 'ADJUSTED' | 'FULL_PAY'; adjustment?: number },
    userId?: number,
  ) {
    const repair = await this.prisma.repairOrder.findUnique({
      where: { id },
      include: { receiptItem: true },
    });
    if (!repair) throw new NotFoundException('Repair order not found.');
    if (repair.status === 'FINAL_REJECTED') {
      throw new BadRequestException('This repair was already final-rejected.');
    }
    const q = Math.max(0, Math.trunc(dto.qty));
    if (q <= 0) throw new BadRequestException('Reject qty must be > 0.');
    if (q > repair.qty) {
      throw new BadRequestException(`Cannot reject ${q} — only ${repair.qty} were sent for repair.`);
    }
    if (dto.paymentMode === 'ADJUSTED' && (dto.adjustment == null || dto.adjustment < 0)) {
      throw new BadRequestException('ADJUSTED mode needs a non-negative adjustment amount.');
    }

    await this.prisma.$transaction(async (tx) => {
      // Update the origin receipt item — move qty from repair → rejected,
      // and stamp the payment decision (the receipt is the source of truth
      // for ledger reads, so we keep that consistent).
      await tx.castingReceiptItem.update({
        where: { id: repair.receiptItemId },
        data: {
          repairQty: { decrement: q },
          rejectedQty: { increment: q },
          rejectReason: dto.reason ?? repair.receiptItem.rejectReason,
          rejectPaymentMode: dto.paymentMode,
          rejectAdjustment: dto.paymentMode === 'ADJUSTED' ? (dto.adjustment ?? 0) : null,
        },
      });
      // Close the repair order.
      await tx.repairOrder.update({
        where: { id: repair.id },
        data: {
          status: 'FINAL_REJECTED',
          finalRejectedQty: q,
          closedAt: new Date(),
          notes: [repair.notes, `Final-rejected ${q} on ${new Date().toISOString().slice(0,10)} (${dto.paymentMode})`]
            .filter(Boolean).join(' · '),
        },
      });
    });
    const stage = await this.prisma.castingBatchItem.findUnique({ where: { id: repair.stageId } });
    if (stage) await this.recomputeBatchStatus(stage.batchId);
    return { id: repair.id, status: 'FINAL_REJECTED', qty: q };
  }

  /** Data shape for the Repair Order PDF — same layout as the issue slip
   *  but with docType=Repair (which the PDF renderer flips the banner +
   *  title for) and qty/weight scoped to the repair only. */
  async repairPdfData(id: number) {
    const r = await this.prisma.repairOrder.findUnique({
      where: { id },
      include: {
        vendor: true,
        stage: { include: { batch: true, stageProcess: true, item: true } },
      },
    });
    if (!r) throw new NotFoundException('Repair order not found.');
    const perPcWt = Number(r.stage?.weight ?? 0);
    return {
      batchNumber: `${r.stage?.batch?.batchNumber ?? '—'} · REP-${r.id} (cycle ${r.cycle})`,
      processName: r.stage?.stageProcess?.name ?? '—',
      batchDate: r.sentAt,
      vendor: { vendorCode: r.vendor.vendorCode, vendorName: r.vendor.vendorName },
      isWeightProcess: false, // repair is qty-based, no rate
      items: [
        {
          vendorDesignReference: r.stage?.vendorDesignReference ?? null,
          color: r.stage?.color ?? null,
          weight: perPcWt,
          quantity: r.qty,
          totalWeight: perPcWt * r.qty,
          price: null,
          amount: null,
          services: null,
          remarks: r.reason ?? `Repair cycle ${r.cycle} — no charge`,
        },
      ],
    };
  }

  /**
   * Full lineage / provenance for a stage: walks UP the parentItemId chain
   * from this stage back to its origin (the first Casting that has no
   * parent). Returns the chain in chronological order (origin → current)
   * with batch / process / vendor / colour / qty / receipt / short / close
   * info per step. Powers the "📜 History" dialog on Production Tracking.
   *
   * Cross-batch link: when a parent's batch differs from its child's, the
   * step is flagged `crossBatchSettle` so the UI can label "absorbed from
   * batch X" — that's how excess routing / multi-batch settles surface.
   */
  async stageLineage(stageId: number) {
    const chain: any[] = [];
    let cursor: number | null = stageId;
    const seen = new Set<number>(); // guard against pathological cycles
    while (cursor != null && !seen.has(cursor)) {
      seen.add(cursor);
      const stage: any = await this.prisma.castingBatchItem.findUnique({
        where: { id: cursor },
        include: {
          batch: true,
          stageProcess: true,
          vendor: true,
          item: true,
          receiptRows: {
            include: { receipt: true },
            orderBy: { id: 'asc' },
          },
        },
      });
      if (!stage) break;
      const receipts = stage.receiptRows.map((rr: any) => ({
        receiptId: rr.receiptId,
        receiptNumber: rr.receipt?.receiptNumber ?? null,
        receiptDate: rr.receipt?.receiptDate ?? null,
        receivedQty: rr.receivedQty,
        receivedWeight: Number(rr.receivedWeight),
      }));
      const receivedQty = receipts.reduce((s: number, r: any) => s + r.receivedQty, 0);
      // Forwarded qty out of this stage (sum of children's quantity).
      const children = await this.prisma.castingBatchItem.findMany({
        where: { parentItemId: stage.id },
        select: { quantity: true, batchId: true },
      });
      const forwardedQty = children.reduce((s, c) => s + c.quantity, 0);
      chain.unshift({
        id: stage.id,
        batchId: stage.batchId,
        batchNumber: stage.batch.batchNumber,
        batchDate: stage.batch.batchDate,
        batchClosed: stage.batch.closed,
        processName: stage.stageProcess?.name ?? '—',
        processCode: stage.stageProcess?.code ?? null,
        vendorId: stage.vendorId,
        vendorCode: stage.vendor.vendorCode,
        vendorName: stage.vendor.vendorName,
        vendorDesignReference: stage.vendorDesignReference,
        color: stage.color ?? null,
        colorModel: stage.colorModel ?? null,
        itemNumber: stage.item?.itemNumber ?? stage.itemNumber ?? null,
        itemName: stage.item?.itemName ?? stage.itemName ?? null,
        designCode: stage.item?.sampleDesignCode ?? null,
        quantity: stage.quantity,
        receivedQty,
        forwardedQty,
        receipts,
        closed: stage.closed,
        closedAt: stage.closedAt,
        closedReason: stage.closedReason,
        shortQty: stage.shortQty ?? 0,
        parentItemId: stage.parentItemId,
        // Issue date heuristic: the stage's createdAt is when it was issued.
        issuedAt: stage.createdAt,
      });
      cursor = stage.parentItemId ?? null;
    }
    // Mark cross-batch jumps so the UI can label "absorbed from batch X".
    for (let i = 1; i < chain.length; i++) {
      if (chain[i].batchId !== chain[i - 1].batchId) {
        chain[i].crossBatchSettle = true;
        chain[i].sourceBatchNumber = chain[i - 1].batchNumber;
      }
    }
    return { chain };
  }

  /**
   * Vendor drift accumulator — aggregates claimed-sent vs actual-received
   * weight per vendor across every receipt-item that recorded a claim.
   *
   *   drift = claimedSentWeight − receivedWeight
   *   drift > 0 → vendor claimed MORE than we actually got (under-delivery)
   *   drift < 0 → vendor claimed LESS than we got (rare but possible)
   *
   * The purchase-bill reconciliation section reads this endpoint to show
   * "Vendor X owes 4.821 g across 47 receipts" so the accountant can
   * either recover the drift on the next bill or write it off explicitly.
   *
   * Without vendorId: fleet-wide roll-up, one row per vendor. With a
   * vendorId: same roll-up PLUS the per-row breakdown (batch, design,
   * date, claimed, actual, drift) so the accountant can drill in.
   *
   * from / to are optional YYYY-MM-DD strings matched against receipt date.
   */
  async vendorDrift(vendorId?: number, from?: string, to?: string) {
    const fromD = from ? new Date(from) : new Date('1970-01-01');
    const toD = to ? new Date(`${to}T23:59:59`) : new Date('2999-12-31');

    // Rows with a recorded claim — null claimedSentWeight means "no claim
    // captured", which is different from "claim was 0". We exclude nulls
    // so the drift math isn't skewed by rows the operator didn't fill in.
    const rows = await this.prisma.castingReceiptItem.findMany({
      where: {
        claimedSentWeight: { not: null } as any,
        receipt: {
          receiptDate: { gte: fromD, lte: toD },
          ...(vendorId ? { vendorId } : {}),
        },
      },
      include: {
        receipt: {
          select: {
            id: true, receiptNumber: true, receiptDate: true,
            vendorId: true,
            vendor: { select: { vendorCode: true, vendorName: true } },
            batch: { select: { id: true, batchNumber: true } },
          },
        },
        batchItem: {
          select: {
            itemNumber: true,
            item: { select: { sampleDesignCode: true } },
            stageProcess: { select: { code: true, name: true } },
          },
        },
      },
      orderBy: [{ receipt: { receiptDate: 'asc' } }, { id: 'asc' }],
    });

    type Bucket = {
      vendorId: number;
      vendorCode: string | null;
      vendorName: string | null;
      totalClaimed: number;
      totalReceived: number;
      totalDrift: number;
      receiptCount: Set<number>;
      rowCount: number;
    };
    const byVendor = new Map<number, Bucket>();
    const detail: any[] = [];
    for (const r of rows) {
      const vId = r.receipt.vendorId;
      const claimed = Number(r.claimedSentWeight ?? 0);
      const actual  = Number(r.receivedWeight ?? 0);
      const drift = Math.round((claimed - actual) * 1000) / 1000;
      let b = byVendor.get(vId);
      if (!b) {
        b = {
          vendorId: vId,
          vendorCode: r.receipt.vendor?.vendorCode ?? null,
          vendorName: r.receipt.vendor?.vendorName ?? null,
          totalClaimed: 0,
          totalReceived: 0,
          totalDrift: 0,
          receiptCount: new Set(),
          rowCount: 0,
        };
        byVendor.set(vId, b);
      }
      b.totalClaimed += claimed;
      b.totalReceived += actual;
      b.totalDrift += drift;
      b.receiptCount.add(r.receipt.id);
      b.rowCount += 1;

      // Per-row detail — surfaced only for single-vendor calls. Skipping
      // for the fleet-wide roll-up keeps the payload small (batch of 500+
      // vendors × months of receipts would balloon otherwise).
      if (vendorId) {
        detail.push({
          receiptId: r.receipt.id,
          receiptNumber: r.receipt.receiptNumber,
          receiptDate: r.receipt.receiptDate,
          batchNumber: r.receipt.batch?.batchNumber ?? null,
          itemNumber: r.batchItem?.itemNumber ?? null,
          designCode: r.batchItem?.item?.sampleDesignCode ?? null,
          processCode: r.batchItem?.stageProcess?.code ?? null,
          processName: r.batchItem?.stageProcess?.name ?? null,
          claimedSentWeight: claimed,
          receivedWeight: actual,
          drift,
        });
      }
    }

    const vendors = Array.from(byVendor.values())
      .map((b) => ({
        vendorId: b.vendorId,
        vendorCode: b.vendorCode,
        vendorName: b.vendorName,
        totalClaimed: Math.round(b.totalClaimed * 1000) / 1000,
        totalReceived: Math.round(b.totalReceived * 1000) / 1000,
        totalDrift: Math.round(b.totalDrift * 1000) / 1000,
        receiptCount: b.receiptCount.size,
        rowCount: b.rowCount,
      }))
      // Biggest under-deliverers surface first — that's the accountant's
      // action queue on the reconciliation screen.
      .sort((a, b) => b.totalDrift - a.totalDrift);

    return {
      from: fromD.toISOString().slice(0, 10),
      to: toD.toISOString().slice(0, 10),
      vendors,
      detail: vendorId ? detail : undefined,
    };
  }

  /**
   * Vendor ledger (Balances & Bills): issues + receipts in a date range, plus
   * the running outstanding balance from short-closed lines (qty, weight, amount).
   */
  async vendorLedger(vendorId: number, from?: string, to?: string) {
    const fromD = from ? new Date(from) : new Date('1970-01-01');
    const toD = to ? new Date(`${to}T23:59:59`) : new Date('2999-12-31');

    const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException('Vendor not found.');

    // Issues in range (by batch date). We include `stageProcess` so the ledger
    // shows what this VENDOR actually did (Sticking/Plating/etc.) — NOT the
    // batch's initial process (Casting) which was the old, wrong behaviour.
    const lines = await this.prisma.castingBatchItem.findMany({
      where: { vendorId, batch: { batchDate: { gte: fromD, lte: toD } } },
      include: { batch: true, stageProcess: true, receiptRows: true },
      orderBy: [{ batch: { batchDate: 'asc' } }, { id: 'asc' }],
    });

    const issues = lines.map((it) => {
      const recQty = it.receiptRows.reduce((s, r) => s + r.receivedQty, 0);
      const accQty = it.receiptRows.reduce((s, r) => s + r.acceptedQty, 0);
      const rejQty = it.receiptRows.reduce((s, r) => s + r.rejectedQty, 0);
      const settled = accQty + rejQty;
      return {
        date: it.batch.batchDate,
        batchNumber: it.batch.batchNumber,
        // Process this VENDOR did (Sticking/Plating/Meena…), not the batch's initial step.
        processName: it.stageProcess?.name ?? '—',
        itemNumber: it.itemNumber,
        vendorDesignReference: it.vendorDesignReference,
        qty: it.quantity,
        weight: Number(it.totalWeight),
        amount: it.totalCost != null ? Number(it.totalCost) : 0,
        receivedQty: recQty,
        // pendingQty = "vendor still owes" — uses settled (accepted+rejected)
        // so repair pcs aren't double-counted (they're already at vendor).
        pendingQty: it.closed ? 0 : Math.max(it.quantity - settled, 0),
        closed: it.closed,
      };
    });

    // Receipts in range (by receipt date) — flattened to item level so the
    // table can share the same columns as Issued/Pending.
    const receiptsRaw = await this.prisma.castingReceipt.findMany({
      where: { vendorId, receiptDate: { gte: fromD, lte: toD } },
      include: {
        items: {
          include: {
            batchItem: { include: { batch: true, stageProcess: true, receiptRows: true } },
          },
        },
      },
      orderBy: { receiptDate: 'asc' },
    });
    const receipts: any[] = [];
    for (const r of receiptsRaw) {
      for (const ri of r.items) {
        const bi = ri.batchItem;
        const totalRecd = bi.receiptRows.reduce((s, x) => s + x.receivedQty, 0);
        // Vendor ledger amount uses the RECEIPT's effective rate (ri.costPerKg
        // when set, else stage's bi.costPerKg) applied to what was ACTUALLY
        // received on this receipt — not the stage's pre-computed total cost.
        // This is what makes the receipt-rate-override actually flow into
        // billing: when a vendor charges ₹780 instead of the ₹760 on the
        // issue slip, the ledger entry reflects ₹780 × actual recd weight.
        const effectiveRate =
          ri.costPerKg != null ? Number(ri.costPerKg)
          : bi.costPerKg != null ? Number(bi.costPerKg)
          : null;
        const isWeightProcess = KG_PROCESSES.includes(bi.stageProcess?.code ?? '');
        const receiptAmount = effectiveRate == null ? 0
          : isWeightProcess
            ? Math.round(Number(ri.receivedWeight) * effectiveRate * 100) / 100
            : Math.round(effectiveRate * ri.receivedQty * 100) / 100;
        receipts.push({
          date: r.receiptDate,
          receiptNumber: r.receiptNumber,
          batchNumber: bi.batch.batchNumber,
          // What this VENDOR did at this stage (not the batch's starting process).
          processName: bi.stageProcess?.name ?? '—',
          itemNumber: bi.itemNumber,
          vendorDesignReference: bi.vendorDesignReference,
          qty: bi.quantity,
          weight: Number(bi.totalWeight),
          recd: ri.receivedQty,
          recdWeight: Number(ri.receivedWeight),
          pending: bi.closed ? 0 : Math.max(bi.quantity - totalRecd, 0),
          amount: receiptAmount,
          // Surface the actual rate billed so the ledger UI can show
          // "rate change ↑" indicators when receipts diverge from stage.
          ratePerUnit: effectiveRate,
          stageRatePerUnit: bi.costPerKg != null ? Number(bi.costPerKg) : null,
        });
      }
    }

    // Outstanding balances — short-closes that happened IN THIS PERIOD.
    // Date-scoped by closedAt so the ledger reflects only the period the
    // user picked (matches the Issued / Received sections). To see all-time
    // outstanding regardless of period, widen the date range.
    const outClosed = await this.prisma.castingBatchItem.findMany({
      where: {
        vendorId,
        closed: true,
        shortQty: { gt: 0 },
        closedAt: { gte: fromD, lte: toD },
      },
      include: { batch: true, stageProcess: true },
      orderBy: { closedAt: 'desc' },
    });
    const outstanding = outClosed.map((it) => {
      const shortQty = it.shortQty ?? 0;
      const amount =
        it.totalCost != null && it.quantity > 0
          ? (Number(it.totalCost) * shortQty) / it.quantity
          : 0;
      return {
        date: it.closedAt,
        batchNumber: it.batch.batchNumber,
        // Stage-level process — what the vendor was actually doing when short-closed.
        processName: it.stageProcess?.name ?? '—',
        itemNumber: it.itemNumber,
        reason: it.closedReason,
        shortQty,
        shortWeight: it.shortWeight != null ? Number(it.shortWeight) : 0,
        amount: Math.round(amount * 100) / 100,
      };
    });

    // Under-process WIP — open stages issued to this vendor that aren't yet
    // fully received. Date-scoped by the batch's issue date so the ledger
    // section matches the selected period (widen the range to see older WIP).
    const openStages = await this.prisma.castingBatchItem.findMany({
      where: {
        vendorId,
        closed: false,
        batch: { batchDate: { gte: fromD, lte: toD } },
      },
      include: { batch: { include: { process: true } }, stageProcess: true, item: true, receiptRows: true },
      orderBy: { id: 'desc' },
    });
    const underProcess: any[] = [];
    for (const it of openStages) {
      const recd = it.receiptRows.reduce((s, x) => s + x.receivedQty, 0);
      const pend = it.quantity - recd;
      if (pend <= 0) continue;
      const recdW = it.receiptRows.reduce((s, x) => s + Number(x.receivedWeight), 0);
      underProcess.push({
        batchNumber: it.batch.batchNumber,
        processName: it.stageProcess?.name ?? it.batch.process?.name ?? '—',
        itemNumber: it.itemNumber,
        designCode: it.item?.sampleDesignCode ?? null,
        color: it.color,
        vendorDesignReference: it.vendorDesignReference,
        pendingQty: pend,
        pendingWeight: Math.max(Math.round((Number(it.totalWeight) - recdW) * 1000) / 1000, 0),
      });
    }

    // ---- Rejections section — every receive row this vendor had where
    // rejectedQty > 0 in the period. Each one's deduction is computed from
    // the payment mode the user picked at receive time. ----
    const rejRows = await this.prisma.castingReceiptItem.findMany({
      where: {
        rejectedQty: { gt: 0 },
        receipt: { vendorId, receiptDate: { gte: fromD, lte: toD } },
      },
      include: {
        receipt: true,
        batchItem: { include: { batch: true, stageProcess: true } },
      },
      orderBy: { receipt: { receiptDate: 'desc' } },
    });
    const rejections = rejRows.map((r) => {
      const bi = r.batchItem;
      const perPcCost =
        bi.totalCost != null && bi.quantity > 0 ? Number(bi.totalCost) / bi.quantity : 0;
      // Deduction logic (negative = money flows AWAY from vendor's payable):
      //   NO_PAY    → full per-pc cost × rejectedQty deducted
      //   ADJUSTED  → custom adjustment (positive number = deduct that much)
      //   FULL_PAY  → 0 deduction (we still pay vendor in full)
      let deduction = 0;
      if (r.rejectPaymentMode === 'NO_PAY') deduction = perPcCost * r.rejectedQty;
      else if (r.rejectPaymentMode === 'ADJUSTED') deduction = Number(r.rejectAdjustment ?? 0);
      // FULL_PAY stays 0.
      return {
        date: r.receipt.receiptDate,
        receiptNumber: r.receipt.receiptNumber,
        batchNumber: bi.batch.batchNumber,
        processName: bi.stageProcess?.name ?? '—',
        itemNumber: bi.itemNumber,
        qty: r.rejectedQty,
        paymentMode: r.rejectPaymentMode,
        adjustment: r.rejectAdjustment != null ? Number(r.rejectAdjustment) : null,
        deduction: Math.round(deduction * 100) / 100,
        reason: r.rejectReason,
      };
    });

    // ---- Open repairs section — pcs sent back to this vendor and not yet
    // returned. Info-only for the ledger; no money impact while open.
    const openRepairs = await this.prisma.repairOrder.findMany({
      where: {
        vendorId,
        status: 'OPEN',
        sentAt: { gte: fromD, lte: toD },
      },
      include: {
        stage: { include: { batch: true, stageProcess: true } },
      },
      orderBy: { sentAt: 'desc' },
    });
    const openRepairRows = openRepairs.map((r) => ({
      id: r.id,
      sentAt: r.sentAt,
      cycle: r.cycle,
      batchNumber: r.stage?.batch?.batchNumber ?? null,
      processName: r.stage?.stageProcess?.name ?? '—',
      itemNumber: r.stage?.itemNumber ?? null,
      qty: r.qty,
      reason: r.reason,
    }));

    // ---- Metal-advance ledger — every ALLOCATE / RETURN / DRAW / ADJUST
    // touching this vendor's balance IN THIS PERIOD. Also compute the
    // current running balance (all-time) so the summary card can show
    // "how much metal is with this vendor RIGHT NOW". Works for in-house
    // vendors too — the query is vendor-scoped, not filtered by role. ----
    const metalLedgerRows = await this.prisma.vendorMetalLedger.findMany({
      where: { vendorId, createdAt: { gte: fromD, lte: toD } },
      include: { variant: true },
      orderBy: { createdAt: 'desc' },
    });
    const metalAdvanceRows = metalLedgerRows.map((m) => ({
      date: m.createdAt,
      eventType: m.eventType,
      variantCode: m.variant.variantCode,
      variantName: m.variant.variantName,
      // Signed weight — + means metal moved TO the vendor (allocate) or
      // returned FROM production (rare); − means metal moved AWAY from
      // the vendor (return / draw).
      weight: Number(m.weight),
      balanceAfter: Number(m.balanceAfter),
      note: m.note,
      refType: m.refType,
      refId: m.refId,
    }));
    // Current balances across every variant (all-time snapshot).
    const currentBalances = await this.prisma.vendorMetalBalance.findMany({
      where: { vendorId, balanceWeight: { gt: 0 } },
      include: { variant: true },
    });
    const metalAdvanceCurrent = currentBalances.map((b) => ({
      variantCode: b.variant.variantCode,
      variantName: b.variant.variantName,
      balanceWeight: Number(b.balanceWeight),
    }));

    // ---- Metal-flow — per-receipt loss, runners recovered, and claimed
    // vs actual drift for this vendor in the period. Data lives on
    // CastingReceipt (per-vendor visit totals) + CastingReceiptItem
    // (per-design row values). All three metrics work for in-house
    // vendors too because the schema doesn't differentiate. ----
    const flowReceipts = await this.prisma.castingReceipt.findMany({
      where: { vendorId, receiptDate: { gte: fromD, lte: toD } },
      include: {
        items: {
          select: {
            claimedSentWeight: true,
            receivedWeight: true,
            lossWeight: true,
            runnersWeight: true,
            batchItem: {
              select: {
                itemNumber: true,
                stageProcess: { select: { name: true } },
              },
            },
          },
        },
      },
      orderBy: { receiptDate: 'desc' },
    });
    const metalFlowRows = flowReceipts.map((r) => {
      // Per-row losses (sand-blast can go negative = gain) + the per-
      // receipt total the operator entered once for the whole visit.
      const perRowLoss = r.items.reduce((s, i) => s + Number(i.lossWeight ?? 0), 0);
      const receiptLoss = Number(r.lossWeight ?? 0);
      const totalLoss = Math.round((perRowLoss + receiptLoss) * 1000) / 1000;
      // Runners = silver recovered from cutting; goes back to RUNNERS-SILVER.
      const perRowRunners = r.items.reduce((s, i) => s + Math.max(0, Number(i.runnersWeight ?? 0)), 0);
      const receiptRunners = Math.max(0, Number(r.runnersWeight ?? 0));
      const totalRunners = Math.round((perRowRunners + receiptRunners) * 1000) / 1000;
      // Drift = what vendor CLAIMS they sent vs what we actually got.
      // Positive drift = vendor over-claimed (under-delivered).
      let claimedTotal = 0;
      let actualTotal = 0;
      for (const i of r.items) {
        if (i.claimedSentWeight != null) {
          claimedTotal += Number(i.claimedSentWeight);
          actualTotal += Number(i.receivedWeight ?? 0);
        }
      }
      const drift = Math.round((claimedTotal - actualTotal) * 1000) / 1000;
      return {
        date: r.receiptDate,
        receiptNumber: r.receiptNumber,
        totalLoss,
        totalRunners,
        claimedTotal: Math.round(claimedTotal * 1000) / 1000,
        actualTotal: Math.round(actualTotal * 1000) / 1000,
        drift,
        rowCount: r.items.length,
      };
    });

    const sum = (arr: any[], k: string) => arr.reduce((s, x) => s + (Number(x[k]) || 0), 0);
    // Metal advance in-period totals split by direction so the UI can
    // show "Allocated: 500g · Returned: 120g · Drawn to batch: 380g".
    const advanceAllocated = metalLedgerRows
      .filter((m) => m.eventType === 'ALLOCATE_ADVANCE')
      .reduce((s, m) => s + Number(m.weight), 0);
    const advanceReturned = metalLedgerRows
      .filter((m) => m.eventType === 'RETURN_TO_ADVANCE')
      .reduce((s, m) => s + Math.abs(Number(m.weight)), 0);
    const advanceDrawn = metalLedgerRows
      .filter((m) => m.eventType === 'DRAW_INTO_BATCH')
      .reduce((s, m) => s + Math.abs(Number(m.weight)), 0);
    const advanceAdjusted = metalLedgerRows
      .filter((m) => m.eventType === 'ADJUST')
      .reduce((s, m) => s + Number(m.weight), 0);
    const currentAdvanceTotal = metalAdvanceCurrent.reduce((s, b) => s + b.balanceWeight, 0);

    const summary = {
      issued: { qty: sum(issues, 'qty'), weight: sum(issues, 'weight'), amount: sum(issues, 'amount') },
      received: { qty: sum(receipts, 'recd'), weight: sum(receipts, 'recdWeight') },
      pending: { qty: sum(issues, 'pendingQty') },
      underProcess: { qty: sum(underProcess, 'pendingQty'), weight: Math.round(sum(underProcess, 'pendingWeight') * 1000) / 1000 },
      outstanding: {
        qty: sum(outstanding, 'shortQty'),
        weight: sum(outstanding, 'shortWeight'),
        amount: Math.round(sum(outstanding, 'amount') * 100) / 100,
      },
      rejected: {
        qty: sum(rejections, 'qty'),
        deduction: Math.round(sum(rejections, 'deduction') * 100) / 100,
      },
      inRepair: { qty: sum(openRepairRows, 'qty'), count: openRepairRows.length },
      // Metal advance — current balance (all-time) + net changes in period.
      metalAdvance: {
        currentBalance: Math.round(currentAdvanceTotal * 1000) / 1000,
        allocated: Math.round(advanceAllocated * 1000) / 1000,
        returned: Math.round(advanceReturned * 1000) / 1000,
        drawn: Math.round(advanceDrawn * 1000) / 1000,
        adjusted: Math.round(advanceAdjusted * 1000) / 1000,
      },
      // Metal flow — losses + runners + drift aggregated over the period.
      metalFlow: {
        totalLoss: Math.round(sum(metalFlowRows, 'totalLoss') * 1000) / 1000,
        totalRunners: Math.round(sum(metalFlowRows, 'totalRunners') * 1000) / 1000,
        totalClaimed: Math.round(sum(metalFlowRows, 'claimedTotal') * 1000) / 1000,
        totalActual: Math.round(sum(metalFlowRows, 'actualTotal') * 1000) / 1000,
        totalDrift: Math.round(sum(metalFlowRows, 'drift') * 1000) / 1000,
        receiptCount: metalFlowRows.length,
      },
    };

    return {
      vendor: { id: vendor.id, vendorCode: vendor.vendorCode, vendorName: vendor.vendorName, isInhouse: (vendor as any).isInhouse ?? false },
      from: fromD,
      to: toD,
      summary,
      issues,
      receipts,
      outstanding,
      underProcess,
      rejections,
      openRepairs: openRepairRows,
      // Metal advance detail — current balance rows + in-period ledger.
      metalAdvance: {
        currentBalances: metalAdvanceCurrent,
        ledger: metalAdvanceRows,
      },
      // Per-receipt loss / runners / drift rows.
      metalFlow: metalFlowRows,
    };
  }

  /**
   * Reshape vendorLedger data into the SECTIONED, PRICED-PER-LINE shape the
   * Vendor Ledger Report PDF needs. Sections (per the user's spec):
   *   • Work Done   — accepted qty × per-pc rate, BILLABLE.
   *   • Under Process — pending qty × per-pc rate, INFO ONLY.
   *   • Rejected     — deduction per row from the existing payment-mode logic.
   *   • Short-Closed — qty owed to us by the vendor × per-pc rate.
   *   • Repair       — info only, no charge (vendor fixes their own defects).
   * Grand Total Payable = Work Done − Rejected deductions − Short-Closed amount.
   * Per-piece rate is prorated from the stage's totalCost / quantity — works
   * cleanly for both KG processes (already cost-weighted on issue) and piece
   * processes (already cost × qty on issue).
   */
  /**
   * Pick a master price for a MaterialVariant given its vendor links.
   * Preferred → first explicit price → 0. Mirrors ItemsService.variantPrice
   * — duplicated here so the casting module doesn't have to depend on
   * the items module just to read a number.
   */
  private materialVariantMasterPrice(vendors: { price: any; isPreferred: boolean }[]): number {
    const pref = vendors.find((v) => v.isPreferred && v.price != null);
    if (pref) return Number(pref.price);
    const prices = vendors.map((v) => (v.price != null ? Number(v.price) : null)).filter((p): p is number => p != null);
    return prices.length ? Math.min(...prices) : 0;
  }

  async vendorLedgerReportData(vendorId: number, from?: string, to?: string) {
    const fromD = from ? new Date(`${from}T00:00:00`) : new Date('1970-01-01');
    const toD = to ? new Date(`${to}T23:59:59`) : new Date('2999-12-31');

    const vendor = await this.prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundException('Vendor not found.');

    // All stages issued to this vendor IN THE PERIOD (by batch date).
    // Include receipts + item link for design code visibility.
    const stages = await this.prisma.castingBatchItem.findMany({
      where: { vendorId, batch: { batchDate: { gte: fromD, lte: toD } } },
      include: {
        batch: true,
        stageProcess: true,
        item: true,
        receiptRows: true,
      },
      orderBy: [{ batch: { batchDate: 'asc' } }, { id: 'asc' }],
    });

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const ratePerPc = (stage: any) =>
      stage.totalCost != null && stage.quantity > 0
        ? Number(stage.totalCost) / stage.quantity
        : 0;

    // ---- WORK DONE: stages with acceptedQty > 0 ----
    const workDone: any[] = [];
    for (const s of stages) {
      const accQty = s.receiptRows.reduce((sum, r) => sum + r.acceptedQty, 0);
      if (accQty <= 0) continue;
      const rate = ratePerPc(s);
      workDone.push({
        itemNumber: s.itemNumber,
        designCode: s.item?.sampleDesignCode ?? null,
        vendorDesignReference: s.vendorDesignReference,
        batchNumber: s.batch.batchNumber,
        processName: s.stageProcess?.name ?? '—',
        qty: accQty,
        rate: round2(rate),
        total: round2(rate * accQty),
      });
    }

    // ---- UNDER PROCESS: open stages, pending qty × rate (info) ----
    const underProcess: any[] = [];
    for (const s of stages) {
      if (s.closed) continue;
      const accQty = s.receiptRows.reduce((sum, r) => sum + r.acceptedQty, 0);
      const rejQty = s.receiptRows.reduce((sum, r) => sum + r.rejectedQty, 0);
      const settled = accQty + rejQty;
      const pendingQty = Math.max(s.quantity - settled, 0);
      if (pendingQty <= 0) continue;
      const rate = ratePerPc(s);
      underProcess.push({
        itemNumber: s.itemNumber,
        designCode: s.item?.sampleDesignCode ?? null,
        vendorDesignReference: s.vendorDesignReference,
        batchNumber: s.batch.batchNumber,
        processName: s.stageProcess?.name ?? '—',
        qty: pendingQty,
        rate: round2(rate),
        total: round2(rate * pendingQty),
      });
    }

    // ---- REJECTED: receipt-item rows with rejectedQty > 0 in period ----
    // Re-use the same payment-mode deduction logic as vendorLedger() —
    // NO_PAY = full rate × qty deducted; ADJUSTED = custom ₹; FULL_PAY = 0.
    const rejRows = await this.prisma.castingReceiptItem.findMany({
      where: {
        rejectedQty: { gt: 0 },
        receipt: { vendorId, receiptDate: { gte: fromD, lte: toD } },
      },
      include: {
        receipt: true,
        batchItem: { include: { batch: true, stageProcess: true, item: true } },
      },
      orderBy: { receipt: { receiptDate: 'desc' } },
    });
    const rejected = rejRows.map((r) => {
      const bi = r.batchItem;
      const perPc = bi.totalCost != null && bi.quantity > 0 ? Number(bi.totalCost) / bi.quantity : 0;
      let deduction = 0;
      if (r.rejectPaymentMode === 'NO_PAY') deduction = perPc * r.rejectedQty;
      else if (r.rejectPaymentMode === 'ADJUSTED') deduction = Number(r.rejectAdjustment ?? 0);
      return {
        itemNumber: bi.itemNumber,
        designCode: bi.item?.sampleDesignCode ?? null,
        vendorDesignReference: bi.vendorDesignReference,
        batchNumber: bi.batch.batchNumber,
        processName: bi.stageProcess?.name ?? '—',
        qty: r.rejectedQty,
        rate: round2(perPc),
        paymentMode: r.rejectPaymentMode,
        deduction: round2(deduction),
        reason: r.rejectReason,
      };
    });

    // ---- SHORT-CLOSED: stages closed in period with shortQty > 0 ----
    const shortStages = await this.prisma.castingBatchItem.findMany({
      where: {
        vendorId,
        closed: true,
        shortQty: { gt: 0 },
        closedAt: { gte: fromD, lte: toD },
      },
      include: { batch: true, stageProcess: true, item: true },
      orderBy: { closedAt: 'desc' },
    });
    const shortClosed = shortStages.map((s) => {
      const shortQty = s.shortQty ?? 0;
      const perPc = s.totalCost != null && s.quantity > 0 ? Number(s.totalCost) / s.quantity : 0;
      const amount = perPc * shortQty;
      return {
        itemNumber: s.itemNumber,
        designCode: s.item?.sampleDesignCode ?? null,
        vendorDesignReference: s.vendorDesignReference,
        batchNumber: s.batch.batchNumber,
        processName: s.stageProcess?.name ?? '—',
        shortQty,
        rate: round2(perPc),
        amount: round2(amount),
        reason: s.closedReason,
      };
    });

    // ---- REPAIR: open repairs targeting this vendor (info only) ----
    const openRepairs = await this.prisma.repairOrder.findMany({
      where: {
        vendorId,
        status: 'OPEN',
        sentAt: { gte: fromD, lte: toD },
      },
      include: { stage: { include: { batch: true, stageProcess: true, item: true } } },
      orderBy: { sentAt: 'desc' },
    });
    const repair = openRepairs.map((r) => ({
      repairId: r.id,
      itemNumber: r.stage?.itemNumber ?? null,
      designCode: r.stage?.item?.sampleDesignCode ?? null,
      vendorDesignReference: r.stage?.vendorDesignReference ?? null,
      batchNumber: r.stage?.batch?.batchNumber ?? null,
      processName: r.stage?.stageProcess?.name ?? '—',
      qty: r.qty,
      cycle: r.cycle,
      reason: r.reason,
    }));

    // ---- MATERIALS OWED — aggregates EVERY MaterialIssue line for this
    // vendor (across all issues in the period) and computes the net qty
    // they still owe us per variant:
    //   owed = max(0, issuedQty − receivedQty − consumedQty)
    // Consumed = production write-off (we let them use it); Received =
    // physical return. What's left at vendor's end with no audit trail
    // is what they owe us — valued at the variant's master price.
    // The amount is DEDUCTED from grand-total payable since the vendor
    // owes us; this can flip a payment-owed into a vendor-owes-us scenario.
    const issueLines = await this.prisma.materialIssueLine.findMany({
      where: {
        issue: { vendorId, issueDate: { gte: fromD, lte: toD } },
      },
      include: {
        variant: { include: { material: true, vendors: true } },
        issue: { select: { voucherNumber: true, issueDate: true } },
      },
    });
    type MOwedRow = {
      variantCode: string;
      variantName: string;
      materialName: string;
      unit: string | null;
      issued: number;
      received: number;
      consumed: number;
      owed: number;
      masterPrice: number;
      amount: number;
    };
    const owedByVariant = new Map<number, MOwedRow>();
    for (const ln of issueLines) {
      const cur = owedByVariant.get(ln.variantId) ?? {
        variantCode: ln.variant.variantCode,
        variantName: ln.variant.variantName ?? ln.variant.material?.materialName ?? '—',
        materialName: ln.variant.material?.materialName ?? '—',
        unit: ln.variant.unit ?? null,
        issued: 0, received: 0, consumed: 0, owed: 0,
        masterPrice: this.materialVariantMasterPrice(ln.variant.vendors),
        amount: 0,
      };
      cur.issued += ln.issuedQty;
      cur.received += ln.receivedQty;
      cur.consumed += ln.consumedQty;
      owedByVariant.set(ln.variantId, cur);
    }
    const materialsOwed: MOwedRow[] = [];
    for (const r of owedByVariant.values()) {
      r.owed = Math.max(0, r.issued - r.received - r.consumed);
      r.amount = round2(r.owed * r.masterPrice);
      materialsOwed.push(r);
    }
    // Show all rows for transparency (issued/received/consumed/owed all
    // useful), but only owed rows feed the grand-total math.

    const sumOf = (arr: any[], k: string) =>
      arr.reduce((s, x) => s + (Number(x[k]) || 0), 0);
    const totals = {
      workDone: round2(sumOf(workDone, 'total')),
      underProcessInfo: round2(sumOf(underProcess, 'total')),
      rejectedDeduction: round2(sumOf(rejected, 'deduction')),
      shortClosedAmount: round2(sumOf(shortClosed, 'amount')),
      repairQty: sumOf(repair, 'qty'),
      // New: total ₹ value of materials the vendor owes us (issued − received − consumed)
      materialsOwedAmount: round2(sumOf(materialsOwed, 'amount')),
    };
    const grandTotalPayable = round2(
      totals.workDone - totals.rejectedDeduction - totals.shortClosedAmount - totals.materialsOwedAmount,
    );

    return {
      vendor: { id: vendor.id, vendorCode: vendor.vendorCode, vendorName: vendor.vendorName },
      from: fromD,
      to: toD,
      sections: { workDone, underProcess, rejected, shortClosed, repair, materialsOwed },
      totals: { ...totals, grandTotalPayable },
    };
  }

  /** Data for a per-vendor PDF. Shows vendor design reference, never the sample code. */
  /**
   * Builds the data for one vendor's slip PDF.
   *
   * `forwardDate` (YYYY-MM-DD in local time) splits one vendor's forwards
   * across multiple slips — same-day forwards still fold into one slip, but
   * a vendor receiving the same batch's pieces on Mon and Tue gets TWO
   * separate slip PDFs (one per day). Backward compatible: omitting
   * forwardDate aggregates everything for the vendor like before.
   */
  async vendorPdfData(batchId: number, vendorId: number, processId?: number, forwardDate?: string) {
    // When forwardDate is set, build a [start, end) window in local time
    // around that day so we filter items by createdAt cleanly.
    let dateFilter: { gte?: Date; lte?: Date } | undefined;
    let parsedForwardDate: Date | null = null;
    if (forwardDate) {
      const m = forwardDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) {
        const y = Number(m[1]);
        const mo = Number(m[2]) - 1;
        const d = Number(m[3]);
        parsedForwardDate = new Date(y, mo, d);
        dateFilter = {
          gte: new Date(y, mo, d, 0, 0, 0, 0),
          lte: new Date(y, mo, d, 23, 59, 59, 999),
        };
      }
    }

    const batch = await this.prisma.castingBatch.findUnique({
      where: { id: batchId },
      include: {
        process: true,
        items: {
          where: {
            vendorId,
            ...(processId ? { processId } : {}),
            // Match either operator-overridden issueDate OR createdAt fallback.
            ...(dateFilter ? { OR: [{ issueDate: dateFilter }, { AND: [{ issueDate: null }, { createdAt: dateFilter }] }] } : {}),
          },
          include: {
            vendor: true,
            stageProcess: true,
            // Pull the design's identity onto the stage so slipItem can
            // surface DESIGN NO (sampleDesignCode) and ITEM NO (sales SKU)
            // separately on the PDF.
            item: { select: { sampleDesignCode: true, itemNumber: true } },
          },
        },
      },
    });
    if (!batch || batch.items.length === 0) {
      throw new NotFoundException('No items for this vendor/process in the batch.');
    }
    // A traveler slip is for one process step; show that process in the header.
    const slipProcess = processId ? batch.items[0].stageProcess?.name ?? 'Production' : 'Production';

    const items = await Promise.all(batch.items.map((i) => this.slipItem(i)));

    // Weight-priced steps (Casting / Plating) keep weight columns; piece-priced
    // steps show price + total amount instead.
    const firstCode = batch.items[0].stageProcess?.code ?? null;
    const isWeightProcess = firstCode ? KG_PROCESSES.includes(firstCode) : true;

    return {
      batchNumber: batch.batchNumber,
      processName: slipProcess,
      // When a forwardDate scope was given, the slip header shows the
      // actual forward day instead of the batch creation day so multiple
      // same-vendor slips don't all read with the same date.
      batchDate: parsedForwardDate ?? batch.batchDate,
      vendor: batch.items[0].vendor,
      // ids surfaced for the Order Details QR code — scan URL encodes
      // (batchId × vendorId) so the karigar's phone opens ReceiveForm
      // pre-scoped to the right lot.
      batchId: batch.id,
      vendorId,
      isWeightProcess,
      items,
    };
  }

  /** One slip line for a stage. Materials come from two sources, merged:
   *    1. ItemMaterial BOM rows (Sticking / Kacha Fitting / Fitting+Mala)
   *    2. MaterialIssue lines attached to the stage (ad-hoc for Filing /
   *       Polish / any process where operator sent materials at forward)
   *  Whichever sources have data, the slip prints. Filing's ad-hoc kit
   *  shows up here even though it has no Item Master BOM. */
  private async slipItem(i: any) {
    type MaterialLine = {
      name: string;
      variantCode: string | null;
      required: number;
      unit: string | null;
      issuedQty: number;
      deferredQty: number;
    };
    const byVariant = new Map<number, MaterialLine>();
    const BOM_PROCESS_CODES = ['STICKING', 'KACHA_FITTING', 'FITTING_MALA'];
    const procCode = i.stageProcess?.code;

    // Source 1 — ItemMaterial BOM rows (for BOM-capable processes).
    if (procCode && BOM_PROCESS_CODES.includes(procCode) && i.itemId) {
      let src: { variantId: number; variantName: string; variantCode?: string | null; required: number; unit?: string | null }[] = [];
      if (procCode === 'STICKING') {
        const snap = Array.isArray(i.bomSnapshot) ? i.bomSnapshot : null;
        src = snap ?? (await this.buildStickingBom(i.itemId, i.quantity, i.color));
      } else {
        const bomLines = await this.prisma.itemMaterial.findMany({
          where: { itemId: i.itemId, process: { code: procCode } },
          include: { variant: { include: { material: true } } },
        });
        src = bomLines.map((m) => ({
          variantId: m.variantId,
          variantName: m.variant.variantName ?? m.variant.material?.materialName ?? '—',
          variantCode: m.variant.variantCode ?? null,
          required: Math.ceil(
            Number(m.quantity) * i.quantity * (1 + (Number(m.wastagePercent) || 0) / 100),
          ),
          unit: m.unit ?? m.variant.unit ?? null,
        }));
      }
      for (const line of src) {
        byVariant.set(line.variantId, {
          name: line.variantName,
          variantCode: line.variantCode ?? null,
          required: line.required,
          unit: line.unit ?? null,
          issuedQty: 0,
          deferredQty: 0,
        });
      }
    }

    // Source 2 — ALL MaterialIssue lines on this stage. Covers Sticking's
    // auto-issue, Filing's ad-hoc kit, every re-issue voucher, etc.
    // Lines that aren't in BOM get added; lines that ARE in BOM get their
    // issued/deferred numbers filled in.
    const issues = await this.prisma.materialIssue.findMany({
      where: { stageId: i.id },
      include: { lines: { include: { variant: { include: { material: true } } } } },
    });
    for (const iss of issues) {
      for (const ln of iss.lines) {
        const existing = byVariant.get(ln.variantId);
        if (existing) {
          existing.issuedQty += ln.issuedQty ?? 0;
          existing.deferredQty += (ln as any).deferredQty ?? 0;
        } else {
          // Not in BOM (or no BOM process) — add it as an ad-hoc line.
          byVariant.set(ln.variantId, {
            name: ln.variant.variantName ?? ln.variant.material?.materialName ?? '—',
            variantCode: ln.variant.variantCode ?? null,
            required: ln.issuedQty ?? 0,
            unit: ln.variant.unit ?? null,
            issuedQty: ln.issuedQty ?? 0,
            deferredQty: (ln as any).deferredQty ?? 0,
          });
        }
      }
    }

    const materials = byVariant.size > 0 ? Array.from(byVariant.values()) : undefined;
    // Remarks: operator's row remarks ONLY. The process name was
    // previously prefixed here, but the slip's header already prints
    // "Process: Casting/Plating/etc." and the column got noisy with the
    // same word repeated on every row. Blank cells let the operator
    // hand-write notes on the printed slip if needed.
    const services = await this.resolveStageServices(i);
    const remarkParts = [
      i.remarks ? String(i.remarks) : null,
    ].filter(Boolean);
    // Production identifiers on the slip:
    //   designCode      = TVM-001 (auto from CAD vendor short — primary)
    //   salesItemNumber = ABN-XXXX (sales SKU, only after packing allocation)
    //   vendorDesignReference = vendor's own code for THEIR own books
    const designCode = (i.item?.sampleDesignCode ?? i.itemNumber ?? '').toString().trim() || null;
    const salesItemNumber = i.item?.itemNumber ?? null;
    return {
      vendorDesignReference: i.vendorDesignReference,
      // Backward-compat: existing readers (UI, search) expect `itemNumber`
      // — keep it as the design code so they keep working.
      itemNumber: designCode,
      designCode,
      salesItemNumber,
      purpose: i.purpose ?? null,
      color: i.color ?? null,
      weight: Number(i.weight),
      quantity: i.quantity,
      totalWeight: Number(i.totalWeight),
      price: i.costPerKg != null ? Number(i.costPerKg) : null,
      amount: i.totalCost != null ? Number(i.totalCost) : null,
      services: services.length ? services : null,
      remarks: remarkParts.length ? remarkParts.join(' · ') : null,
      // Stage id surfaced for the per-card QR code in the slip's Order
      // Details box — the scan URL encodes (batchId × vendorId × stageId)
      // so the karigar phone-scan opens the right design's receive flow.
      stageId: i.id ?? null,
      materials,
    };
  }

  /** Resolve the per-stage additional-services snapshot into a costed list
   *  ready for the PDF: [{ name, costPerPc }]. We trust the snapshot for
   *  WHICH services were chosen at issue time, but fetch the current
   *  per-piece cost from ItemProcessService so the slip reflects the rate
   *  the vendor will actually bill. Returns [] when no services snapshot
   *  exists or the item/process linkage is missing. */
  private async resolveStageServices(i: any): Promise<{ name: string; costPerPc: number | null }[]> {
    const raw = (i.services ?? '').trim();
    if (!raw) return [];
    const names = raw.split(',').map((s: string) => s.trim()).filter(Boolean);
    if (names.length === 0) return [];
    // No item/process linkage → return names with unknown cost (rare, but
    // ad-hoc stages can have this shape).
    if (!i.itemId || !i.processId) return names.map((name: string) => ({ name, costPerPc: null }));
    const links = await this.prisma.itemProcessService.findMany({
      where: {
        itemProcess: { itemId: i.itemId, processId: i.processId },
        service: { name: { in: names } },
      },
      include: { service: true },
    });
    const byName = new Map<string, number | null>();
    for (const ln of links) {
      byName.set(ln.service.name, ln.cost != null ? Number(ln.cost) : null);
    }
    return names.map((name: string) => ({
      name,
      costPerPc: byName.has(name) ? (byName.get(name) ?? null) : null,
    }));
  }

  /** Issue slip for one slip-group: all stages sharing the same issueSlipId
   *  (issues to the same batch/process/vendor within a 15-minute window). */
  async stagePdfData(stageId: number) {
    const stage = await this.prisma.castingBatchItem.findUnique({
      where: { id: stageId },
      include: { vendor: true, stageProcess: true, batch: true, item: true },
    });
    if (!stage) throw new NotFoundException('Stage not found.');
    const slipId = stage.issueSlipId ?? stage.id;
    const grouped = await this.prisma.castingBatchItem.findMany({
      where: { issueSlipId: slipId },
      include: { vendor: true, stageProcess: true, batch: true, item: true },
      orderBy: { id: 'asc' },
    });
    const group = grouped.length ? grouped : [stage];
    const first = group[0];
    const code = first.stageProcess?.code ?? null;
    return {
      batchNumber: `${first.batch.batchNumber} · ISS-${slipId}`,
      processName: first.stageProcess?.name ?? 'Production',
      // Slip date = the stage's actual issue date (when the row was
      // created via the forward dialog, honouring any backdate the
      // operator picked). NOT the batch's batchDate, which is the day
      // the BATCH was created (casting day). For downstream slips —
      // e.g. Fitting issued on 19 Jun against a batch from 11 Jun —
      // the slip header would otherwise print "11 Jun" and read like
      // the slip was generated when casting was issued.
      // issueDate is an operator-set override (Edit Stage → Slip date)
      // — used to correct a wrong-day entry without unwinding receipts.
      // Falls back to createdAt when no override is set.
      batchDate: first.issueDate ?? first.createdAt,
      vendor: first.vendor,
      // ids surfaced for the Order Details QR code — scan URL encodes
      // (batchId × vendorId × stageId) so the karigar's phone opens
      // ReceiveForm pre-scoped to this lot.
      batchId: first.batchId,
      vendorId: first.vendorId,
      isWeightProcess: code ? KG_PROCESSES.includes(code) : true,
      items: await Promise.all(group.map((s) => this.slipItem(s))),
    };
  }

  /** Per-process colour code for an item (e.g. "900002(a)-Lime"); letters reset per process. */
  private async colourCodeFor(itemId: number, processId: number | null, color?: string | null) {
    if (!color || processId == null) return null;
    const item = await this.prisma.item.findUnique({
      where: { id: itemId },
      include: { processes: { where: { processId }, include: { vendors: { orderBy: { id: 'asc' } } } } },
    });
    const proc = item?.processes[0];
    if (!proc) return null;
    const seen: string[] = [];
    for (const v of proc.vendors) {
      const nm = (v.color ?? '').trim();
      if (nm && !seen.some((s) => s.toLowerCase() === nm.toLowerCase())) seen.push(nm);
    }
    const idx = seen.findIndex((s) => s.toLowerCase() === color.trim().toLowerCase());
    if (idx < 0) return null;
    return `${item?.itemNumber ?? ''}(${String.fromCharCode(97 + idx)})-${color}`;
  }

  /** Data for a per-receipt PDF (a receive slip for one process/vendor). Receipts are
   *  INTERNAL docs, so they DO show our item number + colour + colour code. */
  async receiptPdfData(receiptId: number) {
    const receipt = await this.prisma.castingReceipt.findUnique({
      where: { id: receiptId },
      include: {
        vendor: true,
        batch: true,
        items: { include: { batchItem: { include: { stageProcess: true, item: true } } } },
      },
    });
    if (!receipt) throw new NotFoundException('Receipt not found.');
    const processName = receipt.items[0]?.batchItem.stageProcess?.name ?? 'Production';
    const processCode = receipt.items[0]?.batchItem.stageProcess?.code ?? null;
    const isWeightProcess = processCode ? KG_PROCESSES.includes(processCode) : true;
    const items = await Promise.all(
      receipt.items.map(async (ri) => {
        const bi = ri.batchItem;
        const colorCode = bi.itemId ? await this.colourCodeFor(bi.itemId, bi.processId, bi.color) : null;
        // Receipt's effective rate — ri.costPerKg (the rate the operator
        // typed at receive time) wins when present, otherwise fall back
        // to the stage's issue-slip rate (bi.costPerKg). Lets the same
        // PDF builder render both legacy receipts (no override) AND new
        // receipts with rate changes; the cell math stays consistent
        // with whatever rate is actually displayed.
        const cpk =
          ri.costPerKg != null
            ? Number(ri.costPerKg)
            : bi.costPerKg != null
              ? Number(bi.costPerKg)
              : null;
        // QC bifurcation — vendor returned receivedQty pcs split across
        // three buckets. Only the PAYABLE portion bills on this receipt;
        // the rest is either deferred (repair, vendor still holds) or
        // permanently deducted (NO_PAY rejects). The slip shows all
        // three so the karigar's books match ours.
        const accepted = ri.acceptedQty ?? ri.receivedQty;
        const repair = ri.repairQty ?? 0;
        const rejected = ri.rejectedQty ?? 0;
        const rejMode = ri.rejectPaymentMode ?? null;
        const rejAdj = ri.rejectAdjustment != null ? Number(ri.rejectAdjustment) : 0;
        const receivedQty = ri.receivedQty;
        const receivedWeight = Number(ri.receivedWeight);
        // Apportion physical weight to each bucket by piece count — the
        // vendor weighed the whole bag, not per-bucket, so this is the
        // best uniform estimate. Avoids div-by-zero when receivedQty is
        // 0 (piece-priced processes can have weight 0).
        const perPcWt = receivedQty > 0 ? receivedWeight / receivedQty : 0;
        const acceptedWeight = Math.round(perPcWt * accepted * 1000) / 1000;
        const repairWeight = Math.round(perPcWt * repair * 1000) / 1000;
        const rejectedWeight = Math.round(perPcWt * rejected * 1000) / 1000;
        // Payable qty for billing:
        //   • accepted: always
        //   • rejected: only if FULL_PAY (rare). ADJUSTED uses the
        //     custom amount instead and contributes 0 weight here.
        //   • repair: 0 (billed on return, not now)
        const payableQty = accepted + (rejMode === 'FULL_PAY' ? rejected : 0);
        const payableWeight = isWeightProcess
          ? acceptedWeight + (rejMode === 'FULL_PAY' ? rejectedWeight : 0)
          : 0;
        // Amount math: base bill from the payable bucket + the explicit
        // ADJUSTED rupee amount on top. ADJUSTED is a one-off — operator
        // negotiated a partial price for the rejects ("vendor will give
        // us X back" → rejectAdjustment).
        const baseAmount = cpk == null ? null
          : isWeightProcess
            ? payableWeight * cpk
            : cpk * payableQty;
        const amount = baseAmount == null
          ? null
          : rejMode === 'ADJUSTED'
            ? Math.round((baseAmount + rejAdj) * 100) / 100
            : Math.round(baseAmount * 100) / 100;
        // Receipt remarks: operator's row remarks ONLY. The process
        // name was previously prefixed here, but the receipt header
        // already prints "Process: …" and the QC bifurcation lives in
        // its own footer block — repeating "Casting" on every row just
        // crowded the column. Blank cells let the operator hand-write
        // notes on the printed slip if needed.
        const services = await this.resolveStageServices(bi);
        const remarkParts = [
          ri.remarks ? String(ri.remarks) : null,
        ].filter(Boolean);
        // Per-pc weight on the receipt slip MUST be derived from the
        // actual physical receipt: receivedWeight / receivedQty. The
        // stage's stored bi.weight is the PLANNED per-pc — if the
        // operator weighed pcs differently at receive time (casting
        // loss / plating gain) bi.weight × receivedQty ≠ receivedWeight
        // and the slip would print Wt/pc + Rate/pc derived from the
        // stale planned value while Total Wt shows the actual. The
        // amount column would still match Total Wt × Rate/kg, but the
        // per-pc cells would be inconsistent. Fall back to bi.weight
        // only for receipts with no weight entered (e.g. piece-priced
        // processes where receivedWeight is 0).
        const actualPerPc = ri.receivedQty > 0 && Number(ri.receivedWeight) > 0
          ? Math.round((Number(ri.receivedWeight) / ri.receivedQty) * 1000) / 1000
          : Number(bi.weight);
        return {
          itemNumber: bi.item?.itemNumber != null ? String(bi.item.itemNumber) : (bi.itemNumber ?? '—'),
          color: bi.color ?? null,
          colorCode,
          vendorDesignReference: bi.vendorDesignReference,
          weight: actualPerPc,
          // Qty / Wt on the slip = PAYABLE portion (what the bill is for).
          // QC bifurcation surfaces beneath the qty in the renderer so
          // the operator and vendor see exactly what's been kept,
          // returned for rework, and refused — matches what they typed
          // at receive time.
          quantity: payableQty,
          totalWeight: payableWeight,
          price: cpk,
          amount,
          // QC bifurcation passed through — renderer prints "+N rep" /
          // "+N rej (NO PAY / FULL / ADJ)" beneath the qty value, plus
          // a footer summary line for any held-back amount.
          qc: {
            receivedQty,
            accepted,
            repair,
            rejected,
            rejectMode: rejMode,
            rejectAdjustment: rejAdj,
            repairWeight,
            rejectedWeight,
          },
          services: services.length ? services : null,
          remarks: remarkParts.length ? remarkParts.join(' · ') : null,
        };
      }),
    );
    return {
      batchNumber: `${receipt.batch.batchNumber} · ${receipt.receiptNumber}`,
      processName,
      docType: 'Receipt',
      batchDate: receipt.receiptDate,
      vendor: receipt.vendor,
      isWeightProcess,
      // Receipts are now rendered with the SAME column set as the issue slip
      // (Sr | Vendor Design Ref | [Colour] | Qty | Wt/pc | Total Wt | Total | Remarks).
      // The Colour column appears automatically when any item has a colour
      // (i.e. for Plating/Meena/Fitting/Mala/Sticking), and is hidden for
      // colour-less processes (Casting/Antique). No separate "Colour Code"
      // column.
      internal: false,
      items,
    };
  }

  /**
   * Collect the slip targets for a (batch × process) bundle download.
   * Walks the batch's items + receipts to figure out:
   *   - issue:   one entry per vendor that has stages on this process
   *              (mirrors the per-vendor PDF the UI already exposes)
   *   - receipt: one entry per CastingReceipt whose first item's stage
   *              process matches (mirrors the per-receipt PDF in the UI)
   *   - all:     both, concatenated
   * Returns an array of `{ kind, vendorId?, receiptId?, label }`. Names
   * are sanitised for the ZIP entry filename downstream.
   */
  async listProcessSlipTargets(batchId: number, processId: number, kind: 'issue' | 'receipt' | 'all') {
    const batch = await this.prisma.castingBatch.findUnique({
      where: { id: batchId },
      include: {
        items: { include: { vendor: true, stageProcess: true } },
        receipts: { include: { vendor: true, items: { include: { batchItem: { include: { stageProcess: true } } } } } },
        process: true,
      },
    });
    if (!batch) throw new NotFoundException('Batch not found.');
    const targets: Array<{ kind: 'issue' | 'receipt'; vendorId?: number; receiptId?: number; forwardDate?: string; label: string }> = [];

    // Issue slips — one entry per (vendor × forward-day). A vendor that
    // received the same batch's pieces on Mon and Tue gets TWO slips, one
    // per day; same-day forwards still fold into a single slip via the
    // shared map key. Forward day is the stage row's createdAt, formatted
    // YYYY-MM-DD in local time (matches what the frontend renders).
    if (kind === 'issue' || kind === 'all') {
      const pad = (n: number) => String(n).padStart(2, '0');
      const seen = new Map<string, { vendorId: number; vendorName: string; vendorCode: string; forwardDate: string }>();
      for (const it of batch.items) {
        if (it.processId !== processId) continue;
        const dt = it.createdAt as Date;
        const forwardDate = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
        const key = `${it.vendorId}|${forwardDate}`;
        if (seen.has(key)) continue;
        seen.set(key, {
          vendorId: it.vendorId,
          vendorName: it.vendor.vendorName,
          vendorCode: it.vendor.vendorCode,
          forwardDate,
        });
      }
      for (const [, v] of seen) {
        targets.push({
          kind: 'issue',
          vendorId: v.vendorId,
          forwardDate: v.forwardDate,
          label: `issue-${v.vendorCode}-${v.vendorName}-${v.forwardDate}`,
        });
      }
    }

    // Receipt slips — one entry per CastingReceipt whose stage process
    // matches. Receipts are tied to a vendor + items; we read the first
    // item's stage process to decide whether it belongs.
    if (kind === 'receipt' || kind === 'all') {
      for (const r of batch.receipts) {
        const recProcId = r.items[0]?.batchItem?.processId;
        if (recProcId !== processId) continue;
        targets.push({
          kind: 'receipt',
          receiptId: r.id,
          label: `receipt-${r.receiptNumber}-${r.vendor.vendorName}`,
        });
      }
    }

    return {
      batchNumber: batch.batchNumber,
      processName: batch.items.find((it) => it.processId === processId)?.stageProcess?.name
        ?? batch.process?.name
        ?? 'process',
      targets,
    };
  }
}
