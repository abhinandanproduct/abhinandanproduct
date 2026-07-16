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
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ItemsService } from './items.service';
import { UpsertItemDto, ItemQueryDto, AllocateItemNumberDto } from './dto/item.dto';
import { CurrentUser, AuthUser, Public } from '../common/decorators';
import { streamItemDatasheetPdf } from './item-datasheet.pdf';

@Controller('items')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  @Get('meta')
  meta() {
    return this.items.meta();
  }

  // Distinct taxonomy values across all items — feeds the Category /
  // Subcategory / Collection dropdowns in the Item Master form so users
  // can pick reused values (instead of re-typing slightly different
  // variants of the same thing) and add new ones inline.
  @Get('lookups')
  lookups() {
    return this.items.lookups();
  }

  @Get('next-design-code')
  nextDesignCode(@Query('shortName') shortName?: string) {
    return this.items.nextDesignCode(shortName);
  }

  // Suggest the next free ABN-NNNN. Operator can accept the suggestion or
  // override with any unused alphanumeric value in the allocate dialog.
  @Get('next-item-number')
  nextItemNumber() {
    return this.items.nextItemNumber();
  }

  // Allocate the sales item number for this design — gated on at least one
  // Packing receipt existing and the item not yet having a number assigned.
  @Post(':id/allocate-item-number')
  allocateItemNumber(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AllocateItemNumberDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.items.allocateItemNumber(id, dto.itemNumber, user.id);
  }

  // Missing-parts surface — list open MissingPart records for this design
  // so the detail page can banner the "Recast" CTA.
  @Get(':id/missing-parts')
  listMissingParts(@Param('id', ParseIntPipe) id: number) {
    return this.items.listMissingParts(id);
  }

  // Operator-triggered recast — bundles the picked MissingPart ids into a
  // fresh Casting batch (one row per part × qty) and backfills each
  // MissingPart's recastBatchItemId for traceability.
  @Post(':id/recast-missing-parts')
  recastMissingParts(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { vendorId: number; missingPartIds: number[]; castingDate?: string; notes?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return this.items.recastMissingParts(id, body, user.id);
  }

  // Maintenance: recompute cost price for every item from persisted data.
  @Post('recompute-costs')
  recomputeCosts() {
    return this.items.recomputeAllCosts();
  }

  @Post(':id/recompute-cost')
  recomputeCost(@Param('id', ParseIntPipe) id: number) {
    return this.items.recomputeItemCost(id).then((costPrice) => ({ id, costPrice }));
  }

  @Get()
  findAll(@Query() query: ItemQueryDto) {
    return this.items.findAll(query);
  }

  // Printable blank datasheet — design photo on top + process-wise blank
  // form below. Employees print + fill by hand on the karigar floor, then
  // someone transcribes the data into Item Master. Public so the browser
  // can open it in a new tab without an Authorization header.
  //
  // URL shape: `/items/:id/datasheet/<itemNumber>_details.pdf`. The last
  // segment is purely cosmetic (item is resolved from :id) but browsers
  // use it as the default save-as filename, so a Chrome "Save As" gives
  // `<itemNumber>_details.pdf` instead of the generic `datasheet.pdf`
  // that Chrome was previously deriving from the URL even though the
  // Content-Disposition header told it otherwise. Route is BEFORE
  // @Get(':id') so the multi-segment path doesn't get matched as a
  // numeric id.
  @Public()
  @Get(':id/datasheet/:filename')
  async datasheetPdf(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    const data = await this.items.datasheetData(id);
    streamItemDatasheetPdf(res, data);
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.items.findOne(id);
  }

  @Post()
  create(@Body() dto: UpsertItemDto, @CurrentUser() user: AuthUser) {
    return this.items.create(dto, user.id);
  }

  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpsertItemDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.items.update(id, dto, user.id);
  }

  // Lightweight rate-only endpoint. Used by the Undo button on the
  // auto-rate-sync toasts: when the batch / forward flow updates the
  // item's master process rate (because the user typed a different
  // value), the toast lets them revert it for 8 seconds. This endpoint
  // is also handy for any future "edit just the rate" workflow without
  // a full item upsert.
  @Put(':id/processes/:processId/rate')
  setProcessRate(
    @Param('id', ParseIntPipe) id: number,
    @Param('processId', ParseIntPipe) processId: number,
    @Body() body: { vendorId?: number; rate: number | null },
  ) {
    return this.items.setProcessVendorRate(id, processId, body.vendorId, body.rate);
  }

  @Delete(':id/images/:imageId')
  deleteImage(
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
    @CurrentUser() user: AuthUser,
  ) {
    return this.items.deleteImage(id, imageId, user?.id);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.items.remove(id, user?.id);
  }
}
