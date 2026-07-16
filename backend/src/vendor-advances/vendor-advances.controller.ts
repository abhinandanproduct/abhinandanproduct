import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query,
} from '@nestjs/common';
import { VendorAdvancesService } from './vendor-advances.service';
import { CurrentUser, AuthUser } from '../common/decorators';

@Controller('vendor-advances')
export class VendorAdvancesController {
  constructor(private readonly svc: VendorAdvancesService) {}

  @Get('balances')
  balances(@Query('vendorId') vendorId?: string) {
    return this.svc.balances(vendorId ? Number(vendorId) : undefined);
  }

  @Get('ledger')
  ledger(
    @Query('vendorId') vendorId?: string,
    @Query('variantId') variantId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.ledger({
      vendorId:  vendorId  ? Number(vendorId)  : undefined,
      variantId: variantId ? Number(variantId) : undefined,
      limit:     limit     ? Number(limit)     : undefined,
    });
  }

  @Post('allocate')
  allocate(
    @Body() dto: { vendorId: number; variantId: number; weight: number; note?: string; sourceLotId?: number },
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.allocate(dto, user.id);
  }

  @Post('return')
  returnFromVendor(
    @Body() dto: { vendorId: number; variantId: number; weight: number; note?: string; sourceLotId?: number },
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.returnFromVendor(dto, user.id);
  }

  @Post('adjust')
  adjust(
    @Body() dto: { vendorId: number; variantId: number; weight: number; note: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.adjust(dto, user.id);
  }

  // Edit a ledger row — only weight + note. Adjusts the corresponding
  // vendor-balance delta. Blocked for entries linked to production
  // receipts / batch draws (those must be edited at the receipt level).
  @Put('ledger/:id')
  updateLedger(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { weight: number; note?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.updateLedger(id, dto, user.id);
  }

  // Hard-delete a ledger row + unwind its balance impact. Same block:
  // production-linked entries can't be dropped here.
  @Delete('ledger/:id')
  deleteLedger(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.deleteLedger(id, user.id);
  }
}
