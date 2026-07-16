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
import { ZipArchive } from 'archiver';
import { CastingService } from './casting.service';
import { streamVendorPdf, renderVendorPdfToBuffer } from './casting.pdf';
import { streamVendorLedgerReport } from './vendor-ledger-report.pdf';
import {
  BatchQueryDto,
  CastingBatchItemDto,
  CreateBatchDto,
  CreateReceiptDto,
  ForwardStageDto,
  UpdateStageDto,
  ReceiptQueryDto,
} from './dto/casting.dto';
import { CurrentUser, AuthUser, Public } from '../common/decorators';

@Controller('casting')
export class CastingController {
  constructor(private readonly casting: CastingService) {}

  // ---- Batches ----
  @Get('next-batch-number')
  nextBatchNumber() {
    return this.casting.nextBatchNumber();
  }

  @Get('batches')
  listBatches(@Query() q: BatchQueryDto) {
    return this.casting.listBatches(q);
  }

  @Get('batches/:id')
  getBatch(@Param('id', ParseIntPipe) id: number) {
    return this.casting.getBatch(id);
  }

  @Get('batches/:id/vendors')
  batchVendors(@Param('id', ParseIntPipe) id: number) {
    return this.casting.batchVendors(id);
  }

  @Post('batches')
  createBatch(@Body() dto: CreateBatchDto, @CurrentUser() user: AuthUser) {
    return this.casting.createBatch(dto, user.id);
  }

  @Put('batches/:id')
  updateBatch(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateBatchDto, @CurrentUser() user: AuthUser) {
    return this.casting.updateBatch(id, dto, user?.role);
  }

  // Add a single design row to an existing OPEN batch — creates a root
  // Casting stage. Used by the per-row "+ Add design" button on the batch
  // detail page (mid-batch addition without going through the full edit
  // batch form).
  @Post('batches/:id/add-design')
  addBatchDesign(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CastingBatchItemDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.casting.addBatchDesign(id, dto, user.id, user?.role);
  }

  @Delete('batches/:id')
  removeBatch(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.casting.removeBatch(id, user?.role);
  }

  // Forward received pieces of a stage to the next process.
  @Post('batch-items/:id/forward')
  forwardStage(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ForwardStageDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.casting.forwardStage(id, dto, user.id);
  }

  // Edit an existing stage (vendor/qty/weight/rate/colour/remarks).
  @Put('batch-items/:id')
  updateStage(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateStageDto, @CurrentUser() user: AuthUser) {
    return this.casting.updateStage(id, dto, user?.id, user?.role);
  }

  // Undo a mistaken forward — delete an unreceived child stage and roll
  // back any auto-issued sticking materials. Backend enforces all safety
  // checks (parent only, no receipts, no children, not short-closed).
  @Delete('stages/:id')
  deleteStage(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.casting.deleteForwardedStage(id, user.id, user?.role);
  }

  // Operator-flagged missing parts at receive time. Multi-part designs that
  // arrive short get one MissingPart row per (part × qty) entry. Used by
  // the design's "Recast" CTA downstream.
  @Post('stages/:id/report-missing-parts')
  reportMissingParts(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { parts: { partName: string; qtyMissing: number; notes?: string }[] },
    @CurrentUser() user: AuthUser,
  ) {
    return this.casting.reportMissingParts(id, body.parts ?? [], user?.id);
  }

  // List pending recasts (MissingPart rows not yet linked to a recast batch
  // item). Used by the dashboard "Pending Recasts" card and by the receive
  // form popup that asks "recast here / new batch / later".
  @Get('missing-parts/pending')
  pendingRecasts() {
    return this.casting.pendingRecasts();
  }

  // Execute the recast. body.where = 'SAME_BATCH' → adds a CASTING line in
  // the source batch for the missing qty. 'NEW_BATCH' → spawns a new batch
  // with just this design × missing qty.
  @Post('missing-parts/:id/recast')
  recastMissingPart(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { where: 'SAME_BATCH' | 'NEW_BATCH' },
    @CurrentUser() user: AuthUser,
  ) {
    return this.casting.recastMissingPart(id, body.where, user?.id);
  }

  // Per-vendor PDF. Public so it can open in a new tab / be shared; the token
  // is still passed as a query param by the client for traceability.
  @Public()
  @Get('batches/:id/pdf/:vendorId')
  async vendorPdf(
    @Param('id', ParseIntPipe) id: number,
    @Param('vendorId', ParseIntPipe) vendorId: number,
    @Query('processId') processId: string | undefined,
    @Query('tax') tax: string | undefined,
    // Optional YYYY-MM-DD — when set, only the items forwarded on that
    // day are included in the slip. Same vendor on two days = two PDFs.
    @Query('forwardDate') forwardDate: string | undefined,
    @Res() res: Response,
  ) {
    const data = await this.casting.vendorPdfData(
      id, vendorId,
      processId ? Number(processId) : undefined,
      forwardDate,
    );
    await streamVendorPdf(res, { ...data, tax: this.parseTax(tax) });
  }

  // Helper — narrows `?tax=GST|URD` to the strict union the PDF expects.
  // Anything else (missing or invalid) renders the PDF without a tax block.
  private parseTax(raw?: string): 'GST' | 'URD' | null {
    if (raw === 'GST' || raw === 'URD') return raw;
    return null;
  }

  // Bulk download — ALL slips for a (batch × process) bundled as a ZIP.
  // Used by the Slips & Receipts panel's per-process "Download all" buttons.
  // `kind` = issue → vendor PDFs only; receipt → receipt PDFs only; all →
  // both, concatenated. Public so the browser can open via window.open()
  // without an Authorization header (matches the per-slip PDF routes).
  @Public()
  @Get('batches/:id/process-slips.zip')
  async processSlipsZip(
    @Param('id', ParseIntPipe) id: number,
    @Query('processId') processIdRaw: string | undefined,
    @Query('kind') kindRaw: string | undefined,
    @Query('tax') tax: string | undefined,
    @Res() res: Response,
  ) {
    const processId = Number(processIdRaw);
    if (!processId) {
      res.status(400).json({ message: 'processId is required.' });
      return;
    }
    const kind: 'issue' | 'receipt' | 'all' =
      kindRaw === 'issue' || kindRaw === 'receipt' || kindRaw === 'all' ? kindRaw : 'all';
    const { batchNumber, processName, targets } = await this.casting.listProcessSlipTargets(id, processId, kind);
    const taxPick = this.parseTax(tax);

    // Filename mirrors the per-vendor PDF naming style — sanitised batch +
    // process + kind. Operator gets "B0042-Casting-all.zip" or similar.
    const sanitize = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    const fileName = `${sanitize(batchNumber)}-${sanitize(processName)}-${kind}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    // archiver streams entries straight to the response — backend memory
    // never holds the whole ZIP. We still buffer each PDF first (PDFKit
    // doesn't expose a "Content-Length-known" interface for archiver
    // without one), but a per-slip buffer is small (< 100KB typically).
    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on('error', (err) => {
      res.status(500).end(`Archive error: ${err.message}`);
    });
    archive.pipe(res);

    for (const target of targets) {
      try {
        if (target.kind === 'issue' && target.vendorId != null) {
          const data = await this.casting.vendorPdfData(id, target.vendorId, processId, target.forwardDate);
          const buf = await renderVendorPdfToBuffer({ ...data, tax: taxPick });
          archive.append(buf, { name: `${sanitize(target.label)}.pdf` });
        } else if (target.kind === 'receipt' && target.receiptId != null) {
          const data = await this.casting.receiptPdfData(target.receiptId);
          const buf = await renderVendorPdfToBuffer({ ...data, tax: taxPick });
          archive.append(buf, { name: `${sanitize(target.label)}.pdf` });
        }
      } catch (e: any) {
        // Skip individual slip failures so one corrupt entry doesn't
        // sink the whole bundle; include an error placeholder so the
        // operator sees what's missing.
        archive.append(
          Buffer.from(`Failed to render ${target.label}: ${e?.message ?? 'unknown error'}\n`, 'utf8'),
          { name: `${sanitize(target.label)}.ERROR.txt` },
        );
      }
    }

    if (targets.length === 0) {
      archive.append(
        Buffer.from(`No ${kind} slips found for this process.\n`, 'utf8'),
        { name: 'README.txt' },
      );
    }
    await archive.finalize();
  }

  // Per-MOVEMENT issue slip — one slip for a single stage (each forward/issue).
  @Public()
  @Get('stages/:id/pdf')
  async stagePdf(
    @Param('id', ParseIntPipe) id: number,
    @Query('tax') tax: string | undefined,
    @Res() res: Response,
  ) {
    const data = await this.casting.stagePdfData(id);
    await streamVendorPdf(res, { ...data, tax: this.parseTax(tax) });
  }

  // Per-receipt PDF (receive slip).
  @Public()
  @Get('receipts/:id/pdf')
  async receiptPdf(
    @Param('id', ParseIntPipe) id: number,
    @Query('tax') tax: string | undefined,
    @Res() res: Response,
  ) {
    const data = await this.casting.receiptPdfData(id);
    await streamVendorPdf(res, { ...data, tax: this.parseTax(tax) });
  }

  // ---- Receipts ----
  @Get('receipts')
  listReceipts(@Query() q: ReceiptQueryDto) {
    return this.casting.listReceipts(q);
  }

  // Single receipt detail — used by the Edit Receipt flow on the
  // frontend to pre-fill the form. Returns the receipt header + every
  // row in the createReceipt DTO shape so the form can map straight
  // onto inputs without re-translation.
  @Get('receipts/:id')
  findReceipt(@Param('id', ParseIntPipe) id: number) {
    return this.casting.findReceipt(id);
  }

  // Edit a receipt in place — preserves id + receiptNumber so the slip's
  // identity in the books / vendor ledger is unchanged. Internally a
  // destructive delete + recreate of receipt items inside one transaction.
  // Guards forwarded-out + repair-related rows; both refusals are friendly
  // BadRequest with clear next-step instructions.
  @Put('receipts/:id')
  updateReceipt(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateReceiptDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.casting.updateReceipt(id, dto, user?.id);
  }

  // Produced-goods inventory (idle/finished pieces grouped by design + last process).
  @Get('produced')
  producedGoods(@Query('itemId') itemId?: string) {
    return this.casting.producedGoods(itemId ? Number(itemId) : undefined);
  }

  // ---- Repair orders (Reject/Repair module) ----
  @Get('repairs')
  listRepairs(
    @Query('status') status?: string,
    @Query('vendorId') vendorId?: string,
    @Query('batchId') batchId?: string,
    @Query('search') search?: string,
  ) {
    return this.casting.listRepairs({
      status,
      vendorId: vendorId ? Number(vendorId) : undefined,
      batchId: batchId ? Number(batchId) : undefined,
      search,
    });
  }

  @Get('repairs/:id')
  getRepair(@Param('id', ParseIntPipe) id: number) {
    return this.casting.getRepair(id);
  }

  // Final-reject the (remaining) qty on a repair — user gives up after N
  // attempts. Records the rejection with the chosen payment mode and closes
  // the repair as FINAL_REJECTED.
  @Post('repairs/:id/final-reject')
  finalRejectRepair(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { qty: number; reason?: string; paymentMode: 'NO_PAY' | 'ADJUSTED' | 'FULL_PAY'; adjustment?: number },
    @CurrentUser() user: AuthUser,
  ) {
    return this.casting.finalRejectRepair(id, body, user.id);
  }

  // Per-repair-order PDF — the "🔧 REPAIR ORDER — NO CHARGE" slip the
  // floor hands to the vendor along with the pcs for rework.
  @Public()
  @Get('repairs/:id/pdf')
  async repairPdf(
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    const data = await this.casting.repairPdfData(id);
    await streamVendorPdf(res, { ...data, docType: 'Repair' });
  }

  // Lineage for one stage — walks the parentItemId chain from origin to this
  // stage, returning the full history (batch / process / vendor / qty /
  // receipts / short / close per step). Powers the "📜 History" dialog on
  // Production Tracking so the user can answer "where did these N pcs come
  // from" for any lot, with full audit trail across cross-batch absorbs.
  @Get('stages/:id/lineage')
  stageLineage(@Param('id', ParseIntPipe) id: number) {
    return this.casting.stageLineage(id);
  }

  // Continue idle in-process pieces straight to their next process (settle stock).
  @Post('settle')
  settle(
    @Body() body: { stageIds: number[]; nextProcessId: number; color?: string; vendorId?: number; maxQty?: number; targetBatchId?: number },
    @CurrentUser() user: AuthUser,
  ) {
    return this.casting.settleInProcess(body, user.id);
  }

  // Record a planned forward on an AT-VENDOR stage — applied automatically when
  // the stage is later received via Receive Goods (auto-forwards into the
  // planned target batch). Pass null fields to clear an existing plan.
  @Post('stages/:id/plan-forward')
  planForward(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { nextProcessId: number | null; vendorId?: number | null; color?: string | null; targetBatchId?: number | null },
  ) {
    return this.casting.planForward(id, body);
  }

  // Preview the editable material-issue table the Forward dialog shows when
  // the target step is Sticking. Aggregates BOM × qty across colour splits and
  // returns the default issue qty (per variant) plus current stock for context.
  @Post('preview-sticking-issue')
  previewStickingIssue(
    @Body()
    body: {
      itemId: number;
      splits: { color?: string | null; quantity: number }[];
      bufferPercent?: number;
    },
  ) {
    return this.casting.previewStickingIssue(
      body.itemId,
      body.splits ?? [],
      body.bufferPercent ?? 0,
    );
  }

  @Get('batches/:id/pending/:vendorId')
  pending(
    @Param('id', ParseIntPipe) id: number,
    @Param('vendorId', ParseIntPipe) vendorId: number,
    @Query('editReceiptId') editReceiptId?: string,
  ) {
    const eid = editReceiptId ? Number(editReceiptId) : undefined;
    return this.casting.pendingForVendor(id, vendorId, Number.isFinite(eid) ? eid : undefined);
  }

  @Post('receipts')
  createReceipt(@Body() dto: CreateReceiptDto, @CurrentUser() user: AuthUser) {
    return this.casting.createReceipt(dto, user.id);
  }

  // Confirm the final per-piece Casting weight on an item — called from the
  // receive form's popup after the operator weighs the actually-returned
  // pieces. Overwrites the temporary master value AND strips the "casting
  // weight temporary" marker from notes so subsequent receipts don't
  // re-prompt. Body: { itemId, weight }.
  @Post('finalize-casting-weight')
  finalizeCastingWeight(@Body() body: { itemId: number; weight: number }) {
    return this.casting.finalizeCastingWeight(Number(body?.itemId), Number(body?.weight));
  }

  // Post-Packing details for a single production variant. Body carries
  // the operator's per-variant numbers (nullable = "Save Later" style
  // partial save; the packingDetailsFilled flag still flips true so the
  // modal doesn't re-prompt on the next receipt).
  @Post('production-variants/:id/packing-details')
  savePackingDetails(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { additionalCharge?: number | null; grossWt?: number | null; lessWt?: number | null; netWt?: number | null },
  ) {
    return this.casting.savePackingDetails(id, body);
  }

  // Variants with item numbers allocated but packing details still
  // pending — drives the /items page badge + a follow-up-list view.
  @Get('pending-packing-details')
  pendingPackingDetails() {
    return this.casting.listPendingPackingDetails();
  }

  // Look up a vendor's MOST RECENT rate for a process across any item —
  // used by the batch / forward / edit forms to pre-fill the rate field
  // when the chosen (item × vendor) master has no specific rate. Reflects
  // the "Krishna does casting at ₹760/kg for everything" pattern. Returns
  // { rate: number | null }; null means no rate history exists for this
  // (vendor × process).
  @Get('vendor-rate')
  async vendorRate(
    @Query('vendorId') vendorId: string,
    @Query('processId') processId: string,
  ) {
    const rate = await this.casting.getVendorLastRate(Number(vendorId), Number(processId));
    return { rate };
  }

  @Delete('receipts/:id')
  deleteReceipt(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: AuthUser) {
    return this.casting.deleteReceipt(id, user?.id);
  }

  // ---- Short-close a single order line ----
  @Post('batch-items/:id/close')
  closeItem(@Param('id', ParseIntPipe) id: number, @Body() body: { reason?: string }, @CurrentUser() user: AuthUser) {
    return this.casting.closeBatchItem(id, body?.reason, user?.id);
  }

  // ---- Short-close the WHOLE batch (every still-open stage). ----
  @Post('batches/:id/close')
  closeBatch(@Param('id', ParseIntPipe) id: number, @Body() body: { reason?: string }, @CurrentUser() user: AuthUser) {
    return this.casting.closeBatch(id, body?.reason, user?.id);
  }

  // ---- Reopen a short-closed batch (clears the batch-level mark). ----
  @Post('batches/:id/reopen')
  reopenBatch(@Param('id', ParseIntPipe) id: number) {
    return this.casting.reopenBatch(id);
  }

  @Post('batch-items/:id/reopen')
  reopenItem(@Param('id', ParseIntPipe) id: number) {
    return this.casting.reopenBatchItem(id);
  }

  // ---- Vendor ledger (Balances & Bills) ----
  @Get('vendor-ledger/:vendorId')
  vendorLedger(
    @Param('vendorId', ParseIntPipe) vendorId: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.casting.vendorLedger(vendorId, from, to);
  }

  // Per-vendor drift accumulator — aggregates claimed-sent vs actual-received
  // weight across every non-Casting receipt. Powers the purchase-bill
  // "Received vs Actual" reconciliation. Omit vendorId query param for the
  // fleet-wide roll-up; pass it for a single-vendor detail view (with the
  // per-design breakdown of every drift-bearing row).
  @Get('vendor-drift')
  vendorDrift(
    @Query('vendorId') vendorId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.casting.vendorDrift(
      vendorId ? Number(vendorId) : undefined,
      from, to,
    );
  }

  // Downloadable PDF ledger report — sections: workDone / underProcess /
  // rejected / shortClosed / repair, with subtotals + grand-total payable.
  // Public so the browser can open it directly via window.open() without
  // an Authorization header (the token still travels via cookie/query).
  @Public()
  @Get('vendor-ledger/:vendorId/report.pdf')
  async vendorLedgerReportPdf(
    @Param('vendorId', ParseIntPipe) vendorId: number,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Res() res: Response,
  ) {
    const data = await this.casting.vendorLedgerReportData(vendorId, from, to);
    streamVendorLedgerReport(res, data);
  }
}
