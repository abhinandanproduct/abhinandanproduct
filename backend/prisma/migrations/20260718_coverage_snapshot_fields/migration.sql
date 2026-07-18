-- AlterTable
ALTER TABLE "invoice_estimate_coverages" ADD COLUMN     "snapshot_allocated_g" DECIMAL(12,3),
ADD COLUMN     "snapshot_remaining_g" DECIMAL(12,3),
ADD COLUMN     "snapshot_required_g" DECIMAL(12,3),
ADD COLUMN     "snapshot_status" VARCHAR(16);

