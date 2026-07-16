import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

// User's payment intent when REJECTING pcs at receive time.
// Mirrors the Prisma RejectPaymentMode enum.
export enum RejectPaymentMode {
  NO_PAY = 'NO_PAY',
  ADJUSTED = 'ADJUSTED',
  FULL_PAY = 'FULL_PAY',
}

export class CastingBatchItemDto {
  @IsOptional() @IsInt() id?: number; // existing batch-item id (edit)
  @IsOptional() @IsInt() itemId?: number; // link to Item Master (drives auto-fetch)
  // Initial process for THIS row. Defaults to CAM server-side when omitted;
  // operator can pick Casting or any other production process per row so
  // rows that don't need a CAM step start further down the chain.
  @IsOptional() @IsInt() entryProcessId?: number;
  @IsInt() quantity!: number;
  // Optional overrides — when omitted, the server derives them from the item's
  // process data for the batch's process (preferred vendor, weight, cost/kg…).
  @IsOptional() @IsInt() vendorId?: number;
  @IsOptional() @IsString() @MaxLength(60) itemNumber?: string;
  @IsOptional() @IsString() @MaxLength(150) itemName?: string;
  @IsOptional() @IsString() @MaxLength(80) vendorDesignReference?: string;
  @IsOptional() @IsNumber() weight?: number;
  @IsOptional() @IsNumber() totalWeight?: number; // manual override (editable for KG processes)
  @IsOptional() @IsNumber() costPerKg?: number;
  @IsOptional() @IsString() remarks?: string;
  @IsOptional() @IsString() @MaxLength(120) colorModel?: string; // chosen colour model snapshot
  @IsOptional() @IsString() @MaxLength(60) color?: string;
  // Customer / order purpose — free text. Carries forward through
  // downstream stages automatically (forwardStage copies parent's
  // purpose unless overridden), so the karigar at every step knows
  // who the work is for.
  @IsOptional() @IsString() @MaxLength(120) purpose?: string;
  // Operator's explicit "this weight is a best-guess" tick. When true:
  //   - the typed weight still saves to Item Master normally
  //   - the Casting ItemProcess.notes get the "casting weight temporary"
  //     marker appended (per-process notes, not Item.notes)
  //   - the next Casting receipt for this item pops a final-weight
  //     dialog so the operator can confirm the actual per-pc value
  // Defaults to false / absent — non-temp rows behave unchanged.
  @IsOptional() @IsBoolean() castingWeightTemporary?: boolean;
}

export class CreateBatchDto {
  @IsOptional() @IsString() @MaxLength(40) batchNumber?: string; // auto if omitted
  // Production batches always start at Casting; processId optional (defaults to Casting).
  @IsOptional() @IsInt() processId?: number;
  @IsString() batchDate!: string;
  @IsOptional() @IsString() notes?: string;

  @IsArray() @ValidateNested({ each: true }) @Type(() => CastingBatchItemDto)
  items!: CastingBatchItemDto[];
}

// Edit an existing stage (vendor/qty/weight/rate/colour/remarks/purpose).
// History (receipts) is preserved; the stage's slip is regenerated live
// from the updated values.
export class UpdateStageDto {
  @IsOptional() @IsInt() vendorId?: number;
  @IsOptional() @IsString() @MaxLength(80) vendorDesignReference?: string;
  @IsOptional() @IsInt() quantity?: number;
  @IsOptional() @IsNumber() weight?: number;
  @IsOptional() @IsNumber() totalWeight?: number;
  @IsOptional() @IsNumber() costPerKg?: number;
  @IsOptional() @IsString() @MaxLength(60) color?: string;
  @IsOptional() @IsString() remarks?: string;
  @IsOptional() @IsString() @MaxLength(120) purpose?: string;
  // Swap the design (item) on a stage — used when the order-giver typed
  // the wrong design number and the operator catches it before anything
  // else happens. Backend enforces 3 safety guards: no receipts on this
  // stage, no children forwarded from it, and (Sticking only) no
  // material-issue voucher. Any of those → throw with a clear message
  // and "use short-close + re-enter" as the fix path.
  @IsOptional() @IsInt() itemId?: number;
  // Operator-overridable slip date (YYYY-MM-DD). When set, the karigar
  // forward slip PDF uses this date instead of createdAt — used to correct
  // a wrong-day entry without unwinding receipts.
  @IsOptional() @IsString() @MaxLength(40) issueDate?: string;
}

// Forward received pieces of a stage to the next process (any order, partial OK).
export class ForwardStageDto {
  @IsInt() processId!: number; // next process
  @IsInt() quantity!: number;
  @IsOptional() @IsInt() vendorId?: number;
  @IsOptional() @IsNumber() weight?: number; // updated per-piece weight for the NEXT process
  @IsOptional() @IsNumber() totalWeight?: number;
  @IsOptional() @IsNumber() costPerKg?: number; // rate/kg for KG processes (Casting/Plating/Antique)
  @IsOptional() @IsString() @MaxLength(60) color?: string;
  @IsOptional() @IsString() @MaxLength(80) vendorDesignReference?: string;
  @IsOptional() @IsString() remarks?: string;
  // Purpose override for the downstream stage. When OMITTED, the
  // service carries forward source.purpose so the new stage inherits
  // the order context. Operators only fill this when re-targeting (rare).
  @IsOptional() @IsString() @MaxLength(120) purpose?: string;
  // ISO date string (YYYY-MM-DD). When provided, the new stage row's
  // createdAt is set to this date so the per-process date strip in the
  // batch detail reads "yesterday" when work actually started yesterday.
  // Defaults to now() server-side when omitted.
  @IsOptional() @IsString() @MaxLength(40) forwardDate?: string;
  // Sticking only: if true, the karigar uses their OWN raw materials (no material
  // issue voucher is created and our stock isn't touched).
  @IsOptional() @IsBoolean() bringsOwnMaterials?: boolean;
  // Sticking only: extra "buffer" pieces to issue on top of the BOM requirement
  // (e.g., we send 1000 stones when 720 are needed). Whole number. Applied per
  // BOM line proportionally — simplest is a flat multiplier on each line qty.
  @IsOptional() @IsNumber() materialBufferPercent?: number;
  // Sticking only: explicit per-variant issue quantities asked at issue time.
  // When provided, these override the BOM × buffer auto-calculation entirely.
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => MaterialIssueOverrideDto)
  materialIssueOverride?: MaterialIssueOverrideDto[];

  // Sticking only: BOM lines the operator captured inline because the Item
  // Master has no BOM saved for this design × colour. Backend will SAVE
  // these to ItemMaterial first (so the Item Master gains its BOM on this
  // forward) and then run the normal snapshot + auto-issue against the
  // freshly-populated master. Skipped entirely when the master already has
  // a BOM — the existing materialIssueOverride flow handles per-row qty edits.
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => BomCaptureLineDto)
  bomCapture?: BomCaptureLineDto[];

  // Ad-hoc material issue with this forward — Filing / Polish (and any
  // non-BOM process where the operator wants to send materials). One
  // MaterialIssue voucher per forward, lines = these rows. Operator can
  // re-issue later from the /material-issues page if more is needed.
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => AdHocMaterialLineDto)
  extraMaterials?: AdHocMaterialLineDto[];
}

export class AdHocMaterialLineDto {
  @IsInt() variantId!: number;
  @IsOptional() @IsInt() issuedQty?: number;
  @IsOptional() @IsNumber() issuedWeight?: number;
  @IsOptional() @IsString() notes?: string;
}

export class MaterialIssueOverrideDto {
  @IsInt() variantId!: number;
  @IsInt() issuedQty!: number; // whole pcs
}

// One BOM row the operator captures inline in the Forward dialog when the
// Item Master has no BOM for the target Sticking colour. The backend will
// save these as ItemMaterial rows (with processId = Sticking, color = the
// forward's colour) BEFORE the existing snapshotStageBom + auto-issue runs.
// Lets the operator forward to Sticking on a freshly-quick-added item
// without having to round-trip through the Item Master page.
export class BomCaptureLineDto {
  @IsInt() variantId!: number;
  @IsNumber() perPiece!: number; // whole pcs per finished piece
}

export class BatchQueryDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() status?: string;
}

export class CastingReceiptItemDto {
  @IsInt() batchItemId!: number;
  @IsOptional() @IsInt() receivedQty?: number;
  @IsOptional() @IsNumber() receivedWeight?: number;
  @IsOptional() @IsString() remarks?: string;
  // Rate actually charged on THIS receipt — set when the vendor's
  // rate differs from the issue-slip rate (rare but real, common cause:
  // raw-material price spike between issue and return). NULL / omitted
  // = use the stage's costPerKg (the rate on the issue slip).
  // When provided AND different from stage.costPerKg, the service
  // also syncs the new rate forward to the Item Master so future
  // batches default to it.
  @IsOptional() @IsNumber() costPerKg?: number;

  // QC breakdown — when omitted, server treats the full receivedQty as
  // accepted (back-compat with the old single-bucket receive flow).
  // INVARIANT enforced server-side: accepted + repair + rejected == received.
  @IsOptional() @IsInt() acceptedQty?: number;
  @IsOptional() @IsInt() repairQty?: number;
  @IsOptional() @IsInt() rejectedQty?: number;

  // Repair-only fields (set when repairQty > 0):
  @IsOptional() @IsString() repairReason?: string;

  // Reject-only fields (REQUIRED when rejectedQty > 0):
  @IsOptional() @IsString() rejectReason?: string;
  @IsOptional() @IsEnum(RejectPaymentMode) rejectPaymentMode?: RejectPaymentMode;
  @IsOptional() @IsNumber() rejectAdjustment?: number; // when mode = ADJUSTED

  // When this receipt row is the RETURN of an existing RepairOrder, the
  // frontend passes the order id so the server can mark that order RETURNED
  // and chain the cycle if more repair is requested.
  @IsOptional() @IsInt() fromRepairOrderId?: number;

  // Per-piece weights — used at Plating receive (the stage where group →
  // variant bifurcation happens). Array length must equal acceptedQty.
  // When omitted, the service auto-splits receivedWeight equally across
  // the accepted pieces.
  @IsOptional() @IsArray() @IsNumber({}, { each: true })
  perPieceWeights?: number[];

  // Pieces that physically went missing (didn't come back at all).
  // Distinct from rejectedQty (came back, failed QC). One MissingPart
  // record auto-created per lost piece on save.
  @IsOptional() @IsInt() lostQty?: number;
  @IsOptional() @IsString() lostReason?: string;

  // Metal delta on this row in grams. SIGNED — positive = loss (most
  // processes), negative = gain (sand blast can pick up sand/grit).
  // Backend posts the net into LOSS-SILVER as a signed movement.
  @IsOptional() @IsNumber() lossWeight?: number;

  // Legacy — silver runners per-design row. Kept for back-compat; new
  // receipts should send runners at the RECEIPT level (per-vendor total)
  // via CreateReceiptDto.runnersWeight below.
  @IsOptional() @IsNumber() runnersWeight?: number;

  // Pieces the vendor returned AS-IS (untouched). Flow back to the batch
  // item's pending pool for re-issue; NOT counted as received. Sum with
  // receivedQty is what the vendor physically returned; the difference
  // is what they actually worked on.
  @IsOptional() @IsInt() returnedAsIsQty?: number;

  // Vendor's CLAIMED weight per design (what they say they sent). Recorded
  // so drift vs receivedWeight can be aggregated per-vendor for the
  // purchase-bill reconciliation. Not printed on the vendor slip.
  @IsOptional() @IsNumber() claimedSentWeight?: number;

  // Die number the karigar stamped on this design at the Die Number stage.
  // Persisted onto Item.dieNumber (per-design master field) — one number
  // per design, set once by whichever DIE_NUMBER receipt captures it. Only
  // read by the service when the receipt row's stage is on DIE_NUMBER.
  @IsOptional() @IsString() dieNumber?: string;
}

export class CreateReceiptDto {
  @IsInt() batchId!: number;
  @IsInt() vendorId!: number;
  @IsString() receiptDate!: string;
  @IsOptional() @IsString() notes?: string;

  // Silver runners returned this receipt — per-vendor per-visit total.
  // The karigar weighs runners once on the scale, not per design. Posts
  // to the RUNNERS-SILVER variant on save.
  @IsOptional() @IsNumber() runnersWeight?: number;

  // Total metal LOSS on this receipt (per-vendor per-visit total). Karigar
  // reports one loss number for the whole batch — not per design. Posted
  // to LOSS-SILVER as a signed movement on save.
  @IsOptional() @IsNumber() lossWeight?: number;

  @IsArray() @ValidateNested({ each: true }) @Type(() => CastingReceiptItemDto)
  items!: CastingReceiptItemDto[];
}

export class ReceiptQueryDto {
  @IsOptional() @IsString() search?: string; // batch number or vendor name
}
