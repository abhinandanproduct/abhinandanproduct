import {
  Body, Controller, Get, Param, ParseIntPipe, Post, Query,
} from '@nestjs/common';
import { PurchasesService } from './purchases.service';
import { BillTypeStr, CreateBillDto, CreateVendorPaymentDto } from './dto/purchase.dto';
import { CurrentUser, AuthUser } from '../common/decorators';

@Controller()
export class PurchasesController {
  constructor(private readonly svc: PurchasesService) {}

  // Bills (PO / Bill / Vendor Credit / Expense)
  @Get('bills')
  list(
    @Query('type') type?: BillTypeStr,
    @Query('vendorId') vendorId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.svc.listBills({
      type, status, search, fromDate, toDate,
      vendorId: vendorId ? Number(vendorId) : undefined,
    });
  }

  @Get('bills/:id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getBill(id);
  }

  @Post('bills')
  create(@Body() dto: CreateBillDto, @CurrentUser() u: AuthUser) {
    return this.svc.createBill(dto, u?.id);
  }

  @Post('bills/:id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.svc.cancelBill(id);
  }

  @Post('bills/:id/convert-po')
  convertPo(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser) {
    return this.svc.convertPo(id, u?.id);
  }

  // Vendor Payments (Payments Made)
  @Get('vendor-payments')
  payments(
    @Query('vendorId') vendorId?: string,
    @Query('search') search?: string,
  ) {
    return this.svc.listVendorPayments({
      vendorId: vendorId ? Number(vendorId) : undefined,
      search,
    });
  }

  @Post('vendor-payments')
  createPayment(@Body() dto: CreateVendorPaymentDto, @CurrentUser() u: AuthUser) {
    return this.svc.createVendorPayment(dto, u?.id);
  }
}
