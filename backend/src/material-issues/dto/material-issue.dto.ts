import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsOptional, IsString, MaxLength, ValidateNested, Min } from 'class-validator';

export class MaterialIssueLineDto {
  @IsInt() variantId!: number;
  // Issued qty is ALWAYS a whole number — you give N stones / pearls / chains, never a fraction.
  @IsInt() issuedQty!: number;
  // Issued weight (g) — required for filing-process / weight-tracked variants.
  // Defaults to 0 when the variant is qty-only.
  @IsOptional() @IsNumber() @Min(0) issuedWeight?: number;
  @IsOptional() @IsInt() deferredQty?: number;
  @IsOptional() @IsString() notes?: string;
}

export class CreateMaterialIssueDto {
  @IsInt() vendorId!: number;
  @IsOptional() @IsInt() batchId?: number;
  @IsOptional() @IsInt() stageId?: number;
  @IsOptional() @IsString() issueDate?: string;
  @IsOptional() @IsString() notes?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => MaterialIssueLineDto)
  lines!: MaterialIssueLineDto[];
}

export class ReturnLineDto {
  @IsInt() lineId!: number;
  @IsInt() returnedQty!: number; // whole number being physically returned
  // Vendor consumed in production but didn't return (e.g. wastage). When set,
  // these pieces are written off — no stock movement IN, pending drops to 0.
  @IsOptional() @IsInt() consumedQty?: number;
  // Weight ledger mirrors — required for weight-tracked variants (filing etc.).
  // returnedWeight comes back into stock; consumedWeight is written off.
  @IsOptional() @IsNumber() @Min(0) returnedWeight?: number;
  @IsOptional() @IsNumber() @Min(0) consumedWeight?: number;
  // Loss (filings dust) + runners (silver chips cut off the material). Same
  // model as CastingReceiptItem on the design side: loss posts SIGNED to
  // LOSS-SILVER, runners posts IN to RUNNERS-SILVER.
  @IsOptional() @IsNumber() lostWeight?: number;
  @IsOptional() @IsNumber() @Min(0) runnersWeight?: number;
  @IsOptional() @IsString() notes?: string;
}

export class RecordReturnDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => ReturnLineDto)
  lines!: ReturnLineDto[];
  @IsOptional() @IsString() notes?: string;
}

export class CloseIssueDto {
  @IsOptional() @IsString() @MaxLength(255) reason?: string;
}
