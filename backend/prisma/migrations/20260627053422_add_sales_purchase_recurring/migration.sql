-- CreateEnum
CREATE TYPE "BillType" AS ENUM ('PURCHASE_ORDER', 'BILL', 'VENDOR_CREDIT', 'EXPENSE');

-- CreateEnum
CREATE TYPE "BillStatus" AS ENUM ('DRAFT', 'ISSUED', 'PAID', 'CANCELLED', 'BILLED');

-- CreateEnum
CREATE TYPE "RecurringFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');

-- AlterEnum
ALTER TYPE "InvoiceStatus" ADD VALUE 'INVOICED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InvoiceType" ADD VALUE 'QUOTE';
ALTER TYPE "InvoiceType" ADD VALUE 'SALES_ORDER';
ALTER TYPE "InvoiceType" ADD VALUE 'CREDIT_NOTE';

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "rates_fixed" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "bills" (
    "id" SERIAL NOT NULL,
    "bill_number" VARCHAR(40) NOT NULL,
    "type" "BillType" NOT NULL,
    "status" "BillStatus" NOT NULL DEFAULT 'DRAFT',
    "bill_date" TIMESTAMP(3) NOT NULL,
    "due_date" TIMESTAMP(3),
    "vendor_id" INTEGER NOT NULL,
    "vendor_name" VARCHAR(200) NOT NULL,
    "vendor_address" TEXT,
    "vendor_gstin" VARCHAR(20),
    "vendor_ref_number" VARCHAR(60),
    "place_of_supply" VARCHAR(80),
    "gst_percent" DECIMAL(5,2) NOT NULL DEFAULT 3,
    "is_inter_state" BOOLEAN NOT NULL DEFAULT false,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cgst_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sgst_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igst_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "round_off" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paid_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "balance_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "category" VARCHAR(80),
    "notes" TEXT,
    "converted_from_id" INTEGER,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bill_items" (
    "id" SERIAL NOT NULL,
    "bill_id" INTEGER NOT NULL,
    "item_id" INTEGER,
    "variant_id" INTEGER,
    "description" VARCHAR(300) NOT NULL,
    "hsn_code" VARCHAR(20),
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 1,
    "weight_g" DECIMAL(14,3),
    "rate" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "line_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "bill_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_payments" (
    "id" SERIAL NOT NULL,
    "payment_number" VARCHAR(40) NOT NULL,
    "payment_date" TIMESTAMP(3) NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "mode" "PaymentMode" NOT NULL,
    "reference" VARCHAR(120),
    "notes" TEXT,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_payment_allocations" (
    "id" SERIAL NOT NULL,
    "vendor_payment_id" INTEGER NOT NULL,
    "bill_id" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "vendor_payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_invoices" (
    "id" SERIAL NOT NULL,
    "profile_name" VARCHAR(120) NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "silver_rate_per_g" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "making_rate_per_g" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "gst_percent" DECIMAL(5,2) NOT NULL DEFAULT 3,
    "is_inter_state" BOOLEAN NOT NULL DEFAULT false,
    "lines_json" JSONB NOT NULL,
    "frequency" "RecurringFrequency" NOT NULL,
    "next_run_date" TIMESTAMP(3) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bills_bill_number_key" ON "bills"("bill_number");

-- CreateIndex
CREATE UNIQUE INDEX "bills_converted_from_id_key" ON "bills"("converted_from_id");

-- CreateIndex
CREATE INDEX "bills_vendor_id_idx" ON "bills"("vendor_id");

-- CreateIndex
CREATE INDEX "bills_bill_date_idx" ON "bills"("bill_date");

-- CreateIndex
CREATE INDEX "bills_type_status_idx" ON "bills"("type", "status");

-- CreateIndex
CREATE INDEX "bill_items_bill_id_idx" ON "bill_items"("bill_id");

-- CreateIndex
CREATE INDEX "bill_items_variant_id_idx" ON "bill_items"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_payments_payment_number_key" ON "vendor_payments"("payment_number");

-- CreateIndex
CREATE INDEX "vendor_payments_vendor_id_idx" ON "vendor_payments"("vendor_id");

-- CreateIndex
CREATE INDEX "vendor_payments_payment_date_idx" ON "vendor_payments"("payment_date");

-- CreateIndex
CREATE INDEX "vendor_payment_allocations_vendor_payment_id_idx" ON "vendor_payment_allocations"("vendor_payment_id");

-- CreateIndex
CREATE INDEX "vendor_payment_allocations_bill_id_idx" ON "vendor_payment_allocations"("bill_id");

-- CreateIndex
CREATE INDEX "recurring_invoices_enabled_next_run_date_idx" ON "recurring_invoices"("enabled", "next_run_date");

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_converted_from_id_fkey" FOREIGN KEY ("converted_from_id") REFERENCES "bills"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bill_items" ADD CONSTRAINT "bill_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "material_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_payment_allocations" ADD CONSTRAINT "vendor_payment_allocations_vendor_payment_id_fkey" FOREIGN KEY ("vendor_payment_id") REFERENCES "vendor_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_payment_allocations" ADD CONSTRAINT "vendor_payment_allocations_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
