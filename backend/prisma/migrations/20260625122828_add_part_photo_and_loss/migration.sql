-- AlterTable
ALTER TABLE "casting_receipt_items" ADD COLUMN     "loss_weight" DECIMAL(10,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "item_design_parts" ADD COLUMN     "photo_path" VARCHAR(255);
