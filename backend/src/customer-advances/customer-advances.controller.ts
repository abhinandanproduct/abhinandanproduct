import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { CustomerAdvancesService } from './customer-advances.service';
import { CurrentUser, AuthUser } from '../common/decorators';

@Controller('customer-advances')
export class CustomerAdvancesController {
  constructor(private readonly svc: CustomerAdvancesService) {}

  @Get('balances')
  balances(@Query('customerId') customerId?: string) {
    return this.svc.balances(customerId ? Number(customerId) : undefined);
  }

  @Get('ledger')
  ledger(
    @Query('customerId') customerId?: string,
    @Query('variantId') variantId?: string,
    @Query('eventType') eventType?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.ledger({
      customerId: customerId ? Number(customerId) : undefined,
      variantId:  variantId  ? Number(variantId)  : undefined,
      eventType:  eventType || undefined,
      limit:      limit ? Number(limit) : undefined,
    });
  }

  @Get(':customerId/summary')
  summary(@Param('customerId', ParseIntPipe) customerId: number) {
    return this.svc.summary(customerId);
  }

  @Get(':customerId/metal-ledger-full')
  metalLedgerFull(@Param('customerId', ParseIntPipe) customerId: number) {
    return this.svc.metalLedgerFull(customerId);
  }

  @Post('allocate')
  allocate(
    @Body() dto: { customerId: number; variantId: number; weight: number; note?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.allocate(dto, user.id);
  }

  @Post('allocate-estimate')
  allocateToEstimate(
    @Body() dto: { estimateId: number; variantId: number; weight: number; note?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.allocateToEstimate(dto, user.id);
  }

  @Post('return')
  returnToCustomer(
    @Body() dto: { customerId: number; variantId: number; weight: number; note?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.returnToCustomer(dto, user.id);
  }

  @Post('labour-given')
  labourGiven(
    @Body() dto: { customerId: number; amount: number; refType?: string; refId?: number; note?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.recordLabourGiven(dto, user.id);
  }

  @Post('labour-received')
  labourReceived(
    @Body() dto: { customerId: number; amount: number; refType?: string; refId?: number; note?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.recordLabourReceived(dto, user.id);
  }

  @Post('adjust')
  adjust(
    @Body() dto: { customerId: number; variantId: number; weight: number; note: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.adjust(dto, user.id);
  }

  @Delete('ledger/:id')
  deleteLedger(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.svc.deleteLedger(id, user.id);
  }
}
