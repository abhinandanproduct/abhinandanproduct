import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole, ActiveStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** Strip the password hash from any user row before returning it.
   *  Centralised so future callers don't accidentally leak it. */
  private sanitise<T extends { passwordHash?: string }>(u: T) {
    const { passwordHash: _ignore, ...rest } = u;
    void _ignore;
    return rest;
  }

  async list(opts: { search?: string; role?: UserRole; status?: ActiveStatus }) {
    const where: Prisma.UserWhereInput = {};
    if (opts.role) where.role = opts.role;
    if (opts.status) where.status = opts.status;
    if (opts.search) {
      where.OR = [
        { username: { contains: opts.search } },
        { email: { contains: opts.search } },
        { fullName: { contains: opts.search } },
      ];
    }
    const users = await this.prisma.user.findMany({
      where,
      orderBy: [{ status: 'asc' }, { fullName: 'asc' }],
    });
    return users.map((u) => this.sanitise(u));
  }

  async findOne(id: number) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found.');
    return this.sanitise(user);
  }

  async create(dto: CreateUserDto, actorUserId?: number) {
    // Friendly duplicate checks BEFORE Prisma hits its unique constraint.
    const dupU = await this.prisma.user.findUnique({ where: { username: dto.username } });
    if (dupU) throw new ConflictException(`Username "${dto.username}" is already taken.`);
    const dupE = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (dupE) throw new ConflictException(`Email "${dto.email}" is already registered.`);
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const created = await this.prisma.user.create({
      data: {
        username: dto.username.trim(),
        email: dto.email.trim().toLowerCase(),
        fullName: dto.fullName.trim(),
        passwordHash,
        role: dto.role ?? UserRole.STAFF,
        status: dto.status ?? ActiveStatus.ACTIVE,
      },
    });
    await this.audit.log(actorUserId, {
      action: 'users.create',
      targetType: 'User',
      targetId: created.id,
      description: `Created user @${created.username} (${created.role}) — ${created.fullName}`,
      // SnapshotAfter deliberately strips the password hash. We log
      // identity + role; the secret never lands in the audit table.
      snapshotAfter: this.sanitise(created),
    });
    return this.sanitise(created);
  }

  async update(id: number, dto: UpdateUserDto, actorUserId?: number) {
    const before = await this.prisma.user.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('User not found.');
    if (dto.email && dto.email.toLowerCase() !== before.email.toLowerCase()) {
      const dupE = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
      if (dupE && dupE.id !== id) throw new ConflictException(`Email "${dto.email}" is already registered.`);
    }
    // Don't let the system drift into "no admin exists" — block demoting
    // / disabling the LAST ACTIVE ADMIN. Operator must promote another
    // user first. Same logic applies on delete (below).
    if (before.role === UserRole.ADMIN) {
      const becomingNonAdmin = dto.role && dto.role !== UserRole.ADMIN;
      const becomingInactive = dto.status === ActiveStatus.INACTIVE;
      if (becomingNonAdmin || becomingInactive) {
        await this.assertNotLastActiveAdmin(id);
      }
    }
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.email != null ? { email: dto.email.trim().toLowerCase() } : {}),
        ...(dto.fullName != null ? { fullName: dto.fullName.trim() } : {}),
        ...(dto.role != null ? { role: dto.role } : {}),
        ...(dto.status != null ? { status: dto.status } : {}),
      },
    });
    await this.audit.log(actorUserId, {
      action: 'users.update',
      targetType: 'User',
      targetId: id,
      description: `Updated user @${updated.username}`,
      snapshotBefore: this.sanitise(before),
      snapshotAfter: this.sanitise(updated),
      undoStrategy: 'users.update',
    });
    return this.sanitise(updated);
  }

  async resetPassword(id: number, newPassword: string, actorUserId?: number) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found.');
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({ where: { id }, data: { passwordHash } });
    // Audit — DELIBERATELY no snapshotBefore/After here. We never want
    // password material in the log. The description records WHO and WHEN;
    // that's enough for an audit trail.
    await this.audit.log(actorUserId, {
      action: 'users.password.reset',
      targetType: 'User',
      targetId: id,
      description: `Reset password for @${user.username}`,
    });
    return { id, ok: true };
  }

  async remove(id: number, actorUserId?: number) {
    const before = await this.prisma.user.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('User not found.');
    if (before.id === actorUserId) {
      throw new BadRequestException('You cannot delete your own account while signed in.');
    }
    if (before.role === UserRole.ADMIN) {
      await this.assertNotLastActiveAdmin(id);
    }
    await this.prisma.user.delete({ where: { id } });
    await this.audit.log(actorUserId, {
      action: 'users.delete',
      targetType: 'User',
      targetId: id,
      description: `Deleted user @${before.username}`,
      snapshotBefore: this.sanitise(before),
    });
    return { id };
  }

  /** Guards against deleting / demoting the LAST active admin so the
   *  app can't end up with no one able to manage users. */
  private async assertNotLastActiveAdmin(excludingId: number) {
    const count = await this.prisma.user.count({
      where: { role: UserRole.ADMIN, status: ActiveStatus.ACTIVE, id: { not: excludingId } },
    });
    if (count === 0) {
      throw new BadRequestException(
        'Cannot remove or demote the last active admin. Promote another user to admin first.',
      );
    }
  }
}
