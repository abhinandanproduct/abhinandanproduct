-- AlterEnum
ALTER TYPE "InvoiceType" ADD VALUE 'TEMP_INVOICE';

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "source_estimate_id" INTEGER;

-- CreateIndex
CREATE INDEX "invoices_source_estimate_id_idx" ON "invoices"("source_estimate_id");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_source_estimate_id_fkey" FOREIGN KEY ("source_estimate_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
