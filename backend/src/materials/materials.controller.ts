import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { MaterialsService } from './materials.service';
import { BulkCreateColorVariantsDto, UpsertVariantDto, VariantQueryDto } from './dto/material.dto';
import { CurrentUser, AuthUser } from '../common/decorators';

@Controller('materials')
export class MaterialsController {
  constructor(private readonly materials: MaterialsService) {}

  @Get('categories')
  categories() {
    return this.materials.categories();
  }

  // Create a new MaterialCategory inline from the Material Variant form's
  // category dropdown. Idempotent on name (case-insensitive) so a
  // double-click can't make duplicates.
  @Post('categories')
  createCategory(@Body() body: { name: string }) {
    return this.materials.createCategory(body.name);
  }

  @Get('list')
  materialsList() {
    return this.materials.materials();
  }

  // ---- Inventory / stock ----
  @Get('stock')
  stockList(@Query('search') search?: string) {
    return this.materials.stockList(search);
  }

  @Get('stock/movements')
  movements(@Query('variantId') variantId?: string) {
    return this.materials.movements(variantId ? Number(variantId) : undefined);
  }

  // Purchase receipts grouped by vendor — IN movements that were tagged with
  // a vendor + invoice number. Drives the "Received slips" folders on
  // /raw-materials.
  @Get('purchase-receipts')
  purchaseReceipts() {
    return this.materials.purchaseReceipts();
  }

  @Post('variants/:id/stock')
  adjustStock(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: {
      type: 'IN' | 'OUT' | 'ADJUST';
      quantity?: number;
      weight?: number;
      note?: string;
      vendorId?: number | null;
      invoiceNumber?: string | null;
      unitPrice?: number | null;
      unitRatePerGram?: number | null;
    },
    @CurrentUser() user: AuthUser,
  ) {
    return this.materials.adjustStock(id, body, user.id);
  }

  @Get('variants')
  findAll(@Query() query: VariantQueryDto) {
    return this.materials.findAll(query);
  }

  @Get('variants/:id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.materials.findOne(id);
  }

  @Post('variants')
  create(@Body() dto: UpsertVariantDto, @CurrentUser() user: AuthUser) {
    return this.materials.create(dto, user.id);
  }

  // Bulk-create N colour variants from one shared base. UI surfaces this as
  // a "Bulk-create colour variants" toggle on the variant form — the
  // operator enters material / size / vendor ONCE plus a colours[] list
  // with per-row price + opening stock + image, server loops in a single
  // transaction. Replaces N round-trips with one.
  @Post('variants/bulk-colors')
  bulkCreateColors(@Body() dto: BulkCreateColorVariantsDto, @CurrentUser() user: AuthUser) {
    return this.materials.bulkCreateColors(dto, user.id);
  }

  @Put('variants/:id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertVariantDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.materials.update(id, dto, user.id);
  }

  @Delete('variants/:id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.materials.remove(id);
  }

  // Quick status flip — used by the UI's "delete blocked → deactivate
  // instead" flow when the variant has existing production history.
  @Put('variants/:id/status')
  setStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status: 'ACTIVE' | 'INACTIVE' },
  ) {
    return this.materials.setVariantStatus(id, body.status);
  }
}
