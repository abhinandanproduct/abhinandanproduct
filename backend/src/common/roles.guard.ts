import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from './decorators';

/**
 * Role check that runs AFTER the global JwtAuthGuard. Reads the @Roles()
 * metadata off the handler/class and confirms the authenticated user's
 * role is in the allow-list. No metadata = no role restriction (every
 * signed-in user passes — that's the default across the app).
 *
 * Throws 403 (not 401) when role doesn't match — JWT auth itself was
 * fine, the user just lacks permission for this resource.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!required || required.length === 0) return true;
    const req = ctx.switchToHttp().getRequest();
    const role = req.user?.role as UserRole | undefined;
    if (role && required.includes(role)) return true;
    throw new ForbiddenException(`This action requires one of: ${required.join(', ')}.`);
  }
}
