import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional,
  IsString, MaxLength, Min, ValidateNested,
} from 'class-validator';

export type BillTypeStr = 'PURCHASE_ORDER' | 'BILL' | 'VENDOR_CREDIT' | 'EXPENSE';

export class BillLineDto {
  @IsOptional() @IsInt() itemId?: number;
  @IsOptional() @IsInt() variantId?: number;
  @IsString() @MaxLength(300) description!: string;
  @IsOptional() @IsString() @MaxLength(20) hsnCode?: string;
  @IsNumber() @Min(0.001) quantity!: number;
  @IsOptional() @IsNumber() @Min(0) weightG?: number;
  @IsNumber() @Min(0) rate!: number;
  @IsOptional() @IsString() notes?: string;
}

export class CreateBillDto {
  @IsEnum(['PURCHASE_ORDER', 'BILL', 'VENDOR_CREDIT', 'EXPENSE'] as const)
  type!: BillTypeStr;
  @IsString() billDate!: string;
  @IsOptional() @IsString() dueDate?: string;
  @IsInt() vendorId!: number;
  @IsOptional() @IsString() vendorRefNumber?: string;
  @IsOptional() @IsString() placeOfSupply?: string;
  @IsOptional() @IsNumber() @Min(0) gstPercent?: number;
  @IsOptional() @IsBoolean() isInterState?: boolean;
  @IsOptional() @IsString() category?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => BillLineDto)
  lines!: BillLineDto[];
  @IsOptional() @IsString() notes?: string;
}

export class VendorPaymentAllocationDto {
  @IsInt() billId!: number;
  @IsNumber() @Min(0) amount!: number;
}

export class CreateVendorPaymentDto {
  @IsInt() vendorId!: number;
  @IsString() paymentDate!: string;
  @IsNumber() @Min(0) amount!: number;
  @IsEnum(['CASH', 'BANK', 'UPI', 'CHEQUE', 'OTHER'] as const)
  mode!: 'CASH' | 'BANK' | 'UPI' | 'CHEQUE' | 'OTHER';
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => VendorPaymentAllocationDto)
  allocations?: VendorPaymentAllocationDto[];
}
