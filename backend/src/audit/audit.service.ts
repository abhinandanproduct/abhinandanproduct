import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * What every mutation method passes to `log()`. The service handles
 * snapshot persistence + undo-strategy lookup. Keep this lean — every
 * mutation in the codebase becomes one `log()` call, so any field added
 * here multiplies across the codebase.
 */
export interface AuditLogInput {
  /** Stable action identifier — "items.update", "casting.receipt.create", etc.
   *  Used by both the activity feed (display) and the undo registry (dispatch). */
  action: string;
  /** Stable entity type — "Item", "CastingBatch", "Vendor", … Not a table
   *  name so refactors don't break old log rows. Optional for global
   *  actions that don't target a single record. */
  targetType?: string | null;
  /** Primary key of the target record. */
  targetId?: number | null;
  /** Human-readable one-liner shown in the activity feed before the user
   *  expands the row. Example: 'Item #6094 · added Plating colour "Ruby"'. */
  description?: string | null;
  /** Full state BEFORE the mutation. Null on create. Stored as JSONB so
   *  the undo handler can rehydrate. Keep it self-contained (don't rely on
   *  joins) so historical undos work even after related records change. */
  snapshotBefore?: unknown;
  /** Full state AFTER the mutation. Null on delete. */
  snapshotAfter?: unknown;
  /** Name of a registered undo handler. Null = action is logged but
   *  cannot be undone from the UI (e.g. cascading deletes that already
   *  have a manual recovery path). */
  undoStrategy?: string | null;
}

/**
 * Signature of an undo handler. Returns nothing on success; throws a
 * BadRequestException if the action can't be safely reversed (e.g.
 * downstream stages now exist on a batch we're trying to "uncreate").
 *
 * `actorUserId` is the user clicking Undo (NOT the original actor), used
 * to attribute the undo on side-effect rows that have createdBy.
 * `actorRole` lets handlers bypass time-window locks (e.g. the casting
 * batch's 3-hour edit window) when an admin is reversing — undo is
 * inherently an admin-tier action so respecting the user-tier lock
 * would deadlock legitimate corrections.
 */
export type UndoHandler = (
  log: { id: number; targetType: string | null; targetId: number | null; snapshotBefore: unknown; snapshotAfter: unknown },
  actorUserId: number | null,
  actorRole: string | null,
) => Promise<void>;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  /** Strategy name → undo handler. Populated by `registerUndo()` at
   *  module-init time from each domain module that owns mutations. */
  private readonly undoHandlers = new Map<string, UndoHandler>();

  constructor(private prisma: PrismaService) {}

  /** Domain modules call this from their onModuleInit (or constructor) to
   *  hook up undo handlers for the actions they own. The handler is
   *  responsible for reversing the mutation using the snapshot data —
   *  AuditService doesn't know domain semantics. */
  registerUndo(strategy: string, handler: UndoHandler) {
    if (this.undoHandlers.has(strategy)) {
      this.logger.warn(`Undo strategy "${strategy}" already registered — overwriting.`);
    }
    this.undoHandlers.set(strategy, handler);
  }

  /**
   * Persist an audit log row for one mutation. Called inline from each
   * service method right after the write completes (so the snapshotAfter
   * reflects what's actually saved). Synchronous on the wire but the
   * caller can ignore the returned promise if it's not critical to wait —
   * failures are swallowed with a log line rather than throwing, so a
   * downed audit table never breaks user-facing mutations.
   */
  async log(userId: number | null | undefined, input: AuditLogInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: userId ?? null,
          action: input.action,
          targetType: input.targetType ?? null,
          targetId: input.targetId ?? null,
          description: input.description ?? null,
          snapshotBefore: this.toJson(input.snapshotBefore),
          snapshotAfter: this.toJson(input.snapshotAfter),
          undoStrategy: input.undoStrategy ?? null,
        },
      });
    } catch (e) {
      this.logger.error(`AuditLog write failed for action=${input.action}: ${(e as Error).message}`);
    }
  }

  /**
   * List audit log entries with filters + cursor pagination. Default
   * order is newest first so the feed reads as a timeline.
   */
  async list(opts: {
    userId?: number;
    action?: string;
    targetType?: string;
    targetId?: number;
    actionPrefix?: string; // e.g. "casting." to grab everything in casting
    search?: string;       // matches description
    from?: string;         // ISO date
    to?: string;
    limit?: number;
    cursor?: number;       // last id seen
  }) {
    const where: Prisma.AuditLogWhereInput = {};
    if (opts.userId) where.userId = opts.userId;
    if (opts.action) where.action = opts.action;
    if (opts.actionPrefix) where.action = { startsWith: opts.actionPrefix };
    if (opts.targetType) where.targetType = opts.targetType;
    if (opts.targetId) where.targetId = opts.targetId;
    if (opts.search) where.description = { contains: opts.search };
    if (opts.from || opts.to) {
      where.createdAt = {};
      if (opts.from) where.createdAt.gte = new Date(opts.from);
      if (opts.to) where.createdAt.lte = new Date(opts.to);
    }
    const take = Math.min(opts.limit ?? 50, 200);
    const rows = await this.prisma.auditLog.findMany({
      where,
      take: take + 1, // grab one extra to detect more
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      orderBy: { id: 'desc' },
      include: {
        user: { select: { id: true, username: true, fullName: true, role: true } },
        undoneBy: { select: { id: true, username: true, fullName: true } },
      },
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return {
      items: items.map((r) => ({
        ...r,
        // Surface "is this undoable from the UI right now?" so the
        // frontend doesn't have to replicate the rules.
        canUndo: !!r.undoStrategy && !r.undoneAt && this.undoHandlers.has(r.undoStrategy),
      })),
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  }

  /**
   * Reverse a logged action. Looks up the registered undo handler,
   * calls it with the original snapshot data, then STAMPS undoneAt /
   * undoneByUserId on the row so the UI hides the button. Throws when:
   *   - log doesn't exist
   *   - log was already undone
   *   - log has no undoStrategy or the strategy isn't registered
   *   - undo handler itself throws (cascade conflict, etc.)
   *
   * A second AUDIT LOG row is appended documenting the undo (with
   * undoOfId pointing at the reversed row) so the timeline shows both
   * sides of the operation.
   */
  async undo(logId: number, actorUserId: number | null) {
    const log = await this.prisma.auditLog.findUnique({ where: { id: logId } });
    if (!log) throw new NotFoundException('Audit log entry not found.');
    if (log.undoneAt) throw new BadRequestException('This action was already undone.');
    if (!log.undoStrategy) {
      throw new BadRequestException('This action does not have an undo handler configured.');
    }
    const handler = this.undoHandlers.get(log.undoStrategy);
    if (!handler) {
      throw new BadRequestException(`Undo handler "${log.undoStrategy}" is not registered.`);
    }
    // Look up the actor's role so handlers can bypass per-user time
    // locks (the casting batch 3-hour window in particular). Activity
    // page is admin-gated on the frontend so in practice this is
    // always ADMIN, but we read it from the DB rather than trusting
    // an absent JWT claim.
    const actor = actorUserId
      ? await this.prisma.user.findUnique({ where: { id: actorUserId }, select: { role: true } })
      : null;
    // Run the domain-specific reversal. If it throws, propagate the
    // friendly message so the UI can surface it (e.g. "can't delete this
    // batch — receipts already exist downstream").
    await handler(
      {
        id: log.id,
        targetType: log.targetType,
        targetId: log.targetId,
        snapshotBefore: log.snapshotBefore,
        snapshotAfter: log.snapshotAfter,
      },
      actorUserId,
      actor?.role ?? null,
    );
    // Stamp the original row + append the undo row in one transaction so
    // the audit trail is self-consistent.
    await this.prisma.$transaction([
      this.prisma.auditLog.update({
        where: { id: logId },
        data: { undoneAt: new Date(), undoneByUserId: actorUserId ?? null },
      }),
      this.prisma.auditLog.create({
        data: {
          userId: actorUserId ?? null,
          action: `${log.action}.undo`,
          targetType: log.targetType,
          targetId: log.targetId,
          description: `Undo of #${log.id}: ${log.description ?? log.action}`,
          // Swap: the undo's "before" is the original "after" (what was
          // there before the undo), and vice versa.
          snapshotBefore: log.snapshotAfter as Prisma.InputJsonValue,
          snapshotAfter: log.snapshotBefore as Prisma.InputJsonValue,
          undoOfId: log.id,
          // Undos are not themselves undoable — re-do is a separate
          // mutation the operator can re-create normally.
        },
      }),
    ]);
    return { id: logId, undoneAt: new Date() };
  }

  /** List the actions registered with undo handlers — used by the UI
   *  to render an "Undoable" filter chip. */
  registeredUndoStrategies(): string[] {
    return Array.from(this.undoHandlers.keys()).sort();
  }

  // Safe JSON serialisation — Prisma's Json column accepts plain JS
  // objects. We strip undefined values (which would crash JSON.stringify
  // chains) and bail out on circular references.
  private toJson(v: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    if (v === undefined || v === null) return Prisma.JsonNull;
    try {
      return JSON.parse(JSON.stringify(v, (_k, val) => (val === undefined ? null : val)));
    } catch (e) {
      this.logger.warn(`AuditLog snapshot JSON serialise failed: ${(e as Error).message}`);
      return Prisma.JsonNull;
    }
  }
}
