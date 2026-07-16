import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';

/**
 * @Global so every domain module can `constructor(private audit: AuditService)`
 * without having to import AuditModule explicitly. Audit logging is
 * cross-cutting infrastructure (like Prisma) — wiring it per-module
 * would be repetitive boilerplate.
 */
@Global()
@Module({
  providers: [AuditService],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule {}
