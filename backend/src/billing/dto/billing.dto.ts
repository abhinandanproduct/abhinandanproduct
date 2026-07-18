import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsBoolean, IsEmail, IsEnum, IsInt, IsNotEmpty, IsNumber,
  IsOptional, IsString, MaxLength, Min, ValidateNested,
} from 'class-validator';

// ---------- Customer ----------

export class UpsertCustomerDto {
  @IsString() @MaxLength(200) customerName!: string;
  @IsOptional() @IsString() @MaxLength(20) gstin?: string;
  @IsOptional() @IsString() @MaxLength(200) addressLine1?: string;
  @IsOptional() @IsString() @MaxLength(200) addressLine2?: string;
  @IsOptional() @IsString() @MaxLength(80)  city?: string;
  @IsOptional() @IsString() @MaxLength(80)  state?: string;
  @IsOptional() @IsString() @MaxLength(4)   stateCode?: string;
  @IsOptional() @IsString() @MaxLength(10)  pincode?: string;
  @IsOptional() @IsString() @MaxLength(40)  phone?: string;
  @IsOptional() @IsString() @MaxLength(150) email?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() status?: 'ACTIVE' | 'INACTIVE';
}

// ---------- Invoice ----------

export type InvoiceTypeStr =
  | 'QUOTE'
  | 'SALES_ORDER'
  | 'TAX_INVOICE'
  | 'DELIVERY_CHALLAN'
  | 'CREDIT_NOTE'
  | 'ESTIMATE'
  | 'TEMP_INVOICE';

export class InvoiceLineDto {
  @IsOptional() @IsInt() itemId?: number;
  @IsOptional() @IsString() @MaxLength(40) itemNumber?: string;
  @IsString() @IsNotEmpty({ message: 'Line description cannot be blank.' }) @MaxLength(300) description!: string;
  @IsOptional() @IsString() @MaxLength(20) hsnCode?: string;
  @IsInt() @Min(1) quantity!: number;
  @IsNumber() @Min(0) weightG!: number;
  @IsOptional() @IsNumber() @Min(0) silverRatePerG?: number;
  @IsOptional() @IsNumber() @Min(0) makingRatePerG?: number;
  // Detailed weight + labor breakdown (Tanvi-style). All optional.
  @IsOptional() @IsNumber() @Min(0) lessWeightG?: number;
  @IsOptional() @IsNumber() @Min(0) netWeightG?: number;
  @IsOptional() @IsNumber() @Min(0) purity?: number;
  @IsOptional() @IsNumber() @Min(0) fineWeightG?: number;
  @IsOptional() @IsNumber() @Min(0) wastagePercent?: number;
  @IsOptional() @IsNumber() @Min(0) wastageFineG?: number;
  @IsOptional() @IsNumber() @Min(0) boxWeightG?: number;
  @IsOptional() @IsNumber() @Min(0) bagWeightG?: number;
  @IsOptional() @IsNumber() @Min(0) tagWeightG?: number;
  @IsOptional() @IsNumber() @Min(0) padWeightG?: number;
  @IsOptional() @IsNumber() @Min(0) totalGrossWeightG?: number;
  // Operator-typed total weight — when present, PDF prints this exact
  // value instead of (weightG × quantity), sidestepping per-piece
  // rounding drift.
  @IsOptional() @IsNumber() @Min(0) totalWeightG?: number;
  @IsOptional() @IsString() @MaxLength(40)  size?: string;
  @IsOptional() @IsString() @MaxLength(80)  category?: string;
  @IsOptional() @IsString() @MaxLength(80)  plating?: string;
  @IsOptional() @IsString() laborOn?: 'WEIGHT' | 'PIECE';
  @IsOptional() @IsNumber() laborRateWithTax?: number;
  @IsOptional() @IsNumber() laborRateWithoutTax?: number;
  @IsOptional() @IsNumber() laborAmount?: number;
  @IsOptional() @IsNumber() extraAmount?: number;
  // Optional description printed on the PDF next to the extra amount so
  // the customer knows what the add-on is for. Blank = amount alone.
  @IsOptional() @IsString() @MaxLength(120) extraDescription?: string;
  @IsOptional() @IsNumber() fineAmount?: number;
  @IsOptional() @IsInt()    packetNo?: number;
  @IsOptional() @IsString() productionOrderRef?: string;
  @IsOptional() @IsString() boxRef?: string;
  @IsOptional() @IsString() barcode?: string;
  @IsOptional() @IsString() notes?: string;
}

export class InvoiceChargeDto {
  @IsInt() chargeTypeId!: number;
  @IsOptional() @IsString() @MaxLength(120) label?: string;
  @IsNumber() @Min(0) amount!: number;
}

export class CreateInvoiceDto {
  @IsEnum(['QUOTE', 'SALES_ORDER', 'TAX_INVOICE', 'DELIVERY_CHALLAN', 'CREDIT_NOTE', 'ESTIMATE', 'TEMP_INVOICE'] as const)
  type!: InvoiceTypeStr;
  // QUOTE may be saved with rates unfixed ("to be confirmed"). TAX_INVOICE
  // always requires rates. SALES_ORDER may or may not — operator choice.
  @IsOptional() @IsBoolean() ratesFixed?: boolean;
  // For CREDIT_NOTE: optional reference to the invoice it reverses.
  @IsOptional() @IsInt() againstInvoiceId?: number;
  // Optional labor / making-charges discount, percent off pre-GST.
  @IsOptional() @IsNumber() @Min(0) laborDiscountPercent?: number;
  // Header-level additional charges (freight / packaging / etc.).
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => InvoiceChargeDto)
  charges?: InvoiceChargeDto[];
  @IsString() invoiceDate!: string;
  @IsOptional() @IsString() dueDate?: string;
  // Nullable: DRAFT invoices may be "unassigned" until a customer is chosen at
  // issue time. When status flips to READY / ISSUED, customerId is required.
  @IsOptional() @IsInt() customerId?: number;
  // Optional manual override for invoice number. If not provided, auto-generates
  // from prefix + sequential number. Must be unique.
  @IsOptional() @IsString() @MaxLength(40) invoiceNumber?: string;
  // Invoice status: DRAFT (customer optional) | READY (customer required, still
  // editable) | ISSUED (default). Defaults to ISSUED if omitted.
  @IsOptional() @IsEnum(['DRAFT', 'READY', 'ISSUED', 'PAID', 'CANCELLED', 'INVOICED'] as const)
  status?: 'DRAFT' | 'READY' | 'ISSUED' | 'PAID' | 'CANCELLED' | 'INVOICED';
  @IsOptional() @IsString() placeOfSupply?: string;
  @IsOptional() @IsNumber() @Min(0) silverRatePerG?: number;
  @IsOptional() @IsNumber() @Min(0) makingRatePerG?: number;
  // Optional overrides — default 3% (jewellery), interstate=false (intra by default).
  @IsOptional() @IsNumber() @Min(0) gstPercent?: number;
  @IsOptional() @IsBoolean() isInterState?: boolean;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => InvoiceLineDto)
  lines!: InvoiceLineDto[];
  @IsOptional() @IsString() notes?: string;
  // Editable total weight for delivery challans (grams). Optional
  // override on top of the sum of per-line weights.
  @IsOptional() @IsNumber() @Min(0) totalWeightG?: number;
  // Free-text purpose for delivery challans — "Plating", "Casting" etc.
  @IsOptional() @IsString() @MaxLength(120) purpose?: string;
  // TAX_INVOICE only: which of the customer's OPEN/PARTIAL estimates this
  // invoice's silver line covers, and how many grams to each. Backend
  // validates Σ(alloc) ≤ each estimate's remaining silver need, and Σ
  // total ≤ this invoice's silver-line grams.
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => InvoiceCoverageDto)
  coverages?: InvoiceCoverageDto[];
}

export class InvoiceCoverageDto {
  @IsInt() estimateId!: number;
  @IsNumber() @Min(0) silverAllocatedG!: number;
  @IsOptional() @IsBoolean() includeOtherCharges?: boolean;
}

// ---------- Payment ----------

export class PaymentAllocationDto {
  @IsInt() invoiceId!: number;
  @IsNumber() @Min(0) amount!: number;
}

export class CreatePaymentDto {
  @IsInt() customerId!: number;
  @IsString() paymentDate!: string;
  @IsNumber() @Min(0) amount!: number;
  @IsEnum(['CASH', 'BANK', 'UPI', 'CHEQUE', 'OTHER'] as const)
  mode!: 'CASH' | 'BANK' | 'UPI' | 'CHEQUE' | 'OTHER';
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => PaymentAllocationDto)
  allocations?: PaymentAllocationDto[];
}
