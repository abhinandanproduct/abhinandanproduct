-- AlterTable
ALTER TABLE "casting_receipt_items" ADD COLUMN     "lost_qty" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lost_reason" TEXT;
