import { Module } from '@nestjs/common';
import { VendorAdvancesService } from './vendor-advances.service';
import { VendorAdvancesController } from './vendor-advances.controller';

@Module({
  controllers: [VendorAdvancesController],
  providers: [VendorAdvancesService],
  exports: [VendorAdvancesService],
})
export class VendorAdvancesModule {}
