import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuthUser, CurrentUser } from '../common/decorators';

/**
 * Activity feed endpoints. Both routes are protected by the global JWT
 * guard — only signed-in users can read or undo. We don't gate to a role
 * yet because the front-end will only render the page for ADMIN/MANAGER;
 * the backend stays open so it's easy to add per-action checks later.
 */
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /**
   * GET /audit/logs — filterable timeline.
   * Query params:
   *   userId, action, actionPrefix, targetType, targetId,
   *   search (matches description), from / to (ISO dates),
   *   limit (default 50, max 200), cursor (last id seen).
   */
  @Get('logs')
  list(
    @Query('userId') userId?: string,
    @Query('action') action?: string,
    @Query('actionPrefix') actionPrefix?: string,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.audit.list({
      userId: userId ? Number(userId) : undefined,
      action,
      actionPrefix,
      targetType,
      targetId: targetId ? Number(targetId) : undefined,
      search,
      from,
      to,
      limit: limit ? Number(limit) : undefined,
      cursor: cursor ? Number(cursor) : undefined,
    });
  }

  /** List undo strategies actually wired up — drives the "Undoable" filter
   *  chip on the activity page so it shows real categories, not a hard-
   *  coded list that can drift from reality. */
  @Get('undo-strategies')
  undoStrategies() {
    return { strategies: this.audit.registeredUndoStrategies() };
  }

  /** Reverse one logged action. Body is optional confirmation hash for
   *  future "type the action to confirm" workflows; ignored for now. */
  @Post('logs/:id/undo')
  undo(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
    @Body() _body: { confirm?: string } = {},
  ) {
    return this.audit.undo(id, user?.id ?? null);
  }
}
