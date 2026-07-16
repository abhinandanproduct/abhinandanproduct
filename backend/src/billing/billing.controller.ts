import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, Res,
} from '@nestjs/common';
import { Response } from 'express';
import { BillingService } from './billing.service';
import {
  CreateInvoiceDto, CreatePaymentDto, InvoiceTypeStr, UpsertCustomerDto,
} from './dto/billing.dto';
import { CurrentUser, AuthUser, Public } from '../common/decorators';
import { streamInvoicePdf } from './billing.pdf';

@Controller()
export class BillingController {
  constructor(private readonly svc: BillingService) {}

  // ---- Customer ----
  @Get('customers')
  customers(@Query('search') search?: string) {
    return this.svc.listCustomers(search);
  }

  @Get('customers/:id')
  customer(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getCustomer(id);
  }

  @Post('customers')
  createCustomer(@Body() dto: UpsertCustomerDto) {
    return this.svc.createCustomer(dto);
  }

  @Put('customers/:id')
  updateCustomer(@Param('id', ParseIntPipe) id: number, @Body() dto: UpsertCustomerDto) {
    return this.svc.updateCustomer(id, dto);
  }

  @Get('customers/:id/ledger')
  customerLedger(@Param('id', ParseIntPipe) id: number) {
    return this.svc.customerLedger(id);
  }

  // ---- Invoice ----
  @Get('invoices')
  invoices(
    @Query('type') type?: InvoiceTypeStr,
    @Query('customerId') customerId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.svc.listInvoices({
      type, status, search, fromDate, toDate,
      customerId: customerId ? Number(customerId) : undefined,
    });
  }

  @Get('invoices/invoiceable')
  invoiceable() {
    return this.svc.invoiceablePieces();
  }

  @Get('invoices/:id')
  invoice(@Param('id', ParseIntPipe) id: number) {
    return this.svc.getInvoice(id);
  }

  @Post('invoices')
  createInvoice(@Body() dto: CreateInvoiceDto, @CurrentUser() u: AuthUser) {
    return this.svc.createInvoice(dto, u?.id);
  }

  // Edit an existing invoice — replaces lines + charges + rates and
  // recomputes totals. Rejects if payments are allocated (unwind first).
  @Put('invoices/:id')
  updateInvoice(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateInvoiceDto,
    @CurrentUser() u: AuthUser,
  ) {
    return this.svc.updateInvoice(id, dto, u?.id);
  }

  @Post('invoices/:id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.svc.cancelInvoice(id);
  }

  @Delete('invoices/:id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.svc.deleteInvoice(id);
  }

  @Post('invoices/:id/convert')
  convert(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser) {
    return this.svc.convertEstimate(id, u?.id);
  }

  // Consolidate an Estimate's lines into a single-row TEMP_INVOICE for the
  // customer bill. Software-side marker only — the PDF prints identically
  // to a real tax invoice. Final tax invoice is created separately later.
  @Post('invoices/:id/temp-invoice')
  generateTemp(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser) {
    return this.svc.generateTempFromEstimate(id, u?.id);
  }

  // PDF — anonymous so the print-window can pull without bouncing through auth.
  // The id namespace is the same as the secured endpoint.
  @Public()
  @Get('invoices/:id/pdf')
  async invoicePdf(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const inv = await this.svc.getInvoice(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${inv.invoiceNumber}.pdf"`);
    streamInvoicePdf(res, inv as any);
  }

  // ---- Payment ----
  @Get('payments')
  payments(
    @Query('customerId') customerId?: string,
    @Query('search') search?: string,
  ) {
    return this.svc.listPayments({
      customerId: customerId ? Number(customerId) : undefined,
      search,
    });
  }

  @Post('payments')
  createPayment(@Body() dto: CreatePaymentDto, @CurrentUser() u: AuthUser) {
    return this.svc.createPayment(dto, u?.id);
  }

  // ---- Charge type master ----
  @Get('charge-types')
  chargeTypes() {
    return this.svc.listChargeTypes();
  }

  @Post('charge-types')
  createChargeType(@Body() body: { name: string }) {
    return this.svc.createChargeType(body.name);
  }
}
