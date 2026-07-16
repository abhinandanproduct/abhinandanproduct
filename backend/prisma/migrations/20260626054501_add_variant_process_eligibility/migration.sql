-- AlterTable
ALTER TABLE "casting_receipt_items" ADD COLUMN     "runners_weight" DECIMAL(10,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "material_issue_lines" ADD COLUMN     "lost_weight" DECIMAL(14,3) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "material_variant_processes" (
    "id" SERIAL NOT NULL,
    "variant_id" INTEGER NOT NULL,
    "process_id" INTEGER NOT NULL,

    CONSTRAINT "material_variant_processes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "missing_parts" (
    "id" SERIAL NOT NULL,
    "stage_id" INTEGER NOT NULL,
    "item_id" INTEGER NOT NULL,
    "part_name" VARCHAR(80) NOT NULL,
    "qty_missing" INTEGER NOT NULL,
    "weight_missing" DECIMAL(10,3),
    "recast_batch_item_id" INTEGER,
    "recast_at" TIMESTAMP(3),
    "notes" TEXT,
    "reported_by_id" INTEGER,
    "reported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "missing_parts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "material_variant_processes_process_id_idx" ON "material_variant_processes"("process_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_variant_processes_variant_id_process_id_key" ON "material_variant_processes"("variant_id", "process_id");

-- CreateIndex
CREATE INDEX "missing_parts_item_id_idx" ON "missing_parts"("item_id");

-- CreateIndex
CREATE INDEX "missing_parts_stage_id_idx" ON "missing_parts"("stage_id");

-- CreateIndex
CREATE INDEX "missing_parts_recast_batch_item_id_idx" ON "missing_parts"("recast_batch_item_id");

-- AddForeignKey
ALTER TABLE "material_variant_processes" ADD CONSTRAINT "material_variant_processes_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "material_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_variant_processes" ADD CONSTRAINT "material_variant_processes_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_parts" ADD CONSTRAINT "missing_parts_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "casting_batch_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_parts" ADD CONSTRAINT "missing_parts_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_parts" ADD CONSTRAINT "missing_parts_recast_batch_item_id_fkey" FOREIGN KEY ("recast_batch_item_id") REFERENCES "casting_batch_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_parts" ADD CONSTRAINT "missing_parts_reported_by_id_fkey" FOREIGN KEY ("reported_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
