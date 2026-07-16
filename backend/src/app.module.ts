import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { UsersModule } from './users/users.module';
import { ProcessesModule } from './processes/processes.module';
import { VendorsModule } from './vendors/vendors.module';
import { MaterialsModule } from './materials/materials.module';
import { ItemsModule } from './items/items.module';
import { UploadsModule } from './uploads/uploads.module';
import { CastingModule } from './casting/casting.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { MaterialIssuesModule } from './material-issues/material-issues.module';
import { AuditModule } from './audit/audit.module';
import { VendorAdvancesModule } from './vendor-advances/vendor-advances.module';
import { CustomerAdvancesModule } from './customer-advances/customer-advances.module';
import { SilverLotsModule } from './silver-lots/silver-lots.module';
import { AlloyingModule } from './alloying/alloying.module';
import { ReportsModule } from './reports/reports.module';
import { BillingModule } from './billing/billing.module';
import { PurchasesModule } from './purchases/purchases.module';
import { RecurringModule } from './recurring/recurring.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    // AuditModule is @Global — must come BEFORE the domain modules so
    // AuditService is in the DI graph when items/casting/etc resolve.
    AuditModule,
    AuthModule,
    UsersModule,
    ProcessesModule,
    VendorsModule,
    MaterialsModule,
    ItemsModule,
    UploadsModule,
    CastingModule,
    DashboardModule,
    MaterialIssuesModule,
    VendorAdvancesModule,
    CustomerAdvancesModule,
    SilverLotsModule,
    AlloyingModule,
    ReportsModule,
    BillingModule,
    PurchasesModule,
    RecurringModule,
  ],
  controllers: [HealthController],
  providers: [
    // JWT auth is global; routes opt out with @Public()
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
