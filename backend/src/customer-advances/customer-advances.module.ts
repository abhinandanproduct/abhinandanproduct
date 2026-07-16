import { Module } from '@nestjs/common';
import { CustomerAdvancesService } from './customer-advances.service';
import { CustomerAdvancesController } from './customer-advances.controller';

@Module({
  controllers: [CustomerAdvancesController],
  providers: [CustomerAdvancesService],
  exports: [CustomerAdvancesService],
})
export class CustomerAdvancesModule {}
