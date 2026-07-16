import { Module, OnModuleInit } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

/**
 * User management — admin-only CRUD over the users table. Wires up its
 * own users.update undo handler at boot (reverts email / fullName /
 * role / status to their pre-edit values). Password-reset is intentionally
 * NOT undoable: the old hash is never logged so there's nothing to restore.
 */
@Module({
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule implements OnModuleInit {
  constructor(
    private audit: AuditService,
    private prisma: PrismaService,
    private users: UsersService,
  ) {}
  onModuleInit() {
    this.audit.registerUndo('users.update', async (log) => {
      const before: any = log.snapshotBefore ?? {};
      if (!log.targetId) throw new BadRequestException('Cannot undo — log has no user id.');
      // Restore the four editable fields. Password isn't included; the
      // password reset path has its own (non-undoable) action key.
      const data: any = {};
      if ('email' in before) data.email = before.email;
      if ('fullName' in before) data.fullName = before.fullName;
      if ('role' in before) data.role = before.role as UserRole;
      if ('status' in before) data.status = before.status;
      await this.prisma.user.update({ where: { id: log.targetId }, data });
      // Mark `this.users` as used so the linter doesn't flag the import.
      void this.users;
    });
  }
}
