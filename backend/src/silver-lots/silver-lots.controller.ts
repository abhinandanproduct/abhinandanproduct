import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common';
import { SilverLotsService } from './silver-lots.service';
import { CurrentUser, AuthUser } from '../common/decorators';

@Controller('silver-lots')
export class SilverLotsController {
  constructor(private readonly svc: SilverLotsService) {}

  @Get()
  list(
    @Query('customerId') customerId?: string,
    @Query('source') source?: 'BULLION' | 'CUSTOMER_ADVANCE',
    @Query('variantId') variantId?: string,
    @Query('hasRemaining') hasRemaining?: string,
  ) {
    return this.svc.list({
      customerId: customerId ? Number(customerId) : undefined,
      source,
      variantId: variantId ? Number(variantId) : undefined,
      hasRemaining: hasRemaining === 'true' || hasRemaining === '1',
    });
  }

  @Post()
  create(
    @Body() dto: {
      source: 'BULLION' | 'CUSTOMER_ADVANCE';
      rateType: 'FIX' | 'UNFIX';
      variantId: number;
      vendorId?: number;
      customerId?: number;
      receivedAt?: string;
      receivedWeightG: number;
      ratePerG: number;
      billNumber?: string;
      notes?: string;
    },
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.createLot(dto, user.id);
  }

  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: {
      rateType?: 'FIX' | 'UNFIX';
      receivedAt?: string;
      ratePerG?: number;
      billNumber?: string;
      notes?: string;
    },
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.updateLot(id, dto, user.id);
  }

  @Delete(':id')
  delete(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.deleteLot(id, user.id);
  }

  @Get('preview-draw')
  previewDraw(
    @Query('customerId') customerId?: string,
    @Query('variantId') variantId?: string,
    @Query('weightG') weightG?: string,
  ) {
    if (!variantId || !weightG) return { draws: [], remainingUnfilled: 0 };
    return this.svc.computeFifoDraw({
      customerId: customerId ? Number(customerId) : undefined,
      variantId: Number(variantId),
      weightG: Number(weightG),
    });
  }
}
