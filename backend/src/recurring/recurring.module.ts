import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { RecurringService } from './recurring.service';
import { RecurringController } from './recurring.controller';

@Module({
  imports: [PrismaModule, BillingModule],
  controllers: [RecurringController],
  providers: [RecurringService],
})
export class RecurringModule {}
