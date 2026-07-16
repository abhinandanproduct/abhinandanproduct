-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MANAGER', 'STAFF');

-- CreateEnum
CREATE TYPE "ActiveStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "StockMoveType" AS ENUM ('IN', 'OUT', 'ADJUST');

-- CreateEnum
CREATE TYPE "DesignType" AS ENUM ('CAD', 'HANDMADE');

-- CreateEnum
CREATE TYPE "SampleStatus" AS ENUM ('DRAFT', 'IN_DEVELOPMENT', 'SAMPLE_READY', 'PRODUCTION_READY');

-- CreateEnum
CREATE TYPE "CastingBatchStatus" AS ENUM ('OPEN', 'PARTIAL', 'COMPLETED');

-- CreateEnum
CREATE TYPE "MetalSource" AS ENUM ('FRESH', 'FROM_ADVANCE');

-- CreateEnum
CREATE TYPE "RejectPaymentMode" AS ENUM ('NO_PAY', 'ADJUSTED', 'FULL_PAY');

-- CreateEnum
CREATE TYPE "RepairStatus" AS ENUM ('OPEN', 'RETURNED', 'FINAL_REJECTED');

-- CreateEnum
CREATE TYPE "MaterialIssueStatus" AS ENUM ('OPEN', 'PARTIAL', 'COMPLETED', 'CLOSED');

-- CreateEnum
CREATE TYPE "WarehouseKind" AS ENUM ('DISPATCH', 'STORAGE');

-- CreateEnum
CREATE TYPE "ProductionVariantState" AS ENUM ('IN_PROGRESS', 'PACKED', 'SOLD', 'SCRAPPED');

-- CreateEnum
CREATE TYPE "VendorMetalEventType" AS ENUM ('ALLOCATE_ADVANCE', 'DRAW_INTO_BATCH', 'RETURN_TO_ADVANCE', 'ADJUST');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "username" VARCHAR(60) NOT NULL,
    "email" VARCHAR(150) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "full_name" VARCHAR(150) NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'STAFF',
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "action" VARCHAR(80) NOT NULL,
    "target_type" VARCHAR(60),
    "target_id" INTEGER,
    "description" TEXT,
    "snapshot_before" JSONB,
    "snapshot_after" JSONB,
    "undo_strategy" VARCHAR(80),
    "undone_at" TIMESTAMP(3),
    "undone_by_user_id" INTEGER,
    "undo_of_id" INTEGER,
    "ip" VARCHAR(45),
    "user_agent" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processes" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_costed" BOOLEAN NOT NULL DEFAULT true,
    "bom_capable" BOOLEAN NOT NULL DEFAULT false,
    "bifurcates" BOOLEAN NOT NULL DEFAULT false,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" SERIAL NOT NULL,
    "vendor_code" VARCHAR(20) NOT NULL,
    "vendor_name" VARCHAR(150) NOT NULL,
    "short_name" VARCHAR(60),
    "contact_person" VARCHAR(120),
    "mobile" VARCHAR(20),
    "email" VARCHAR(150),
    "address" TEXT,
    "gst_number" VARCHAR(20),
    "pan_number" VARCHAR(15),
    "notes" TEXT,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_processes" (
    "id" SERIAL NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "process_id" INTEGER NOT NULL,

    CONSTRAINT "vendor_processes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_categories" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "materials" (
    "id" SERIAL NOT NULL,
    "material_code" VARCHAR(20) NOT NULL,
    "material_name" VARCHAR(150) NOT NULL,
    "category_id" INTEGER,
    "unit" VARCHAR(20),
    "notes" TEXT,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_variants" (
    "id" SERIAL NOT NULL,
    "material_id" INTEGER NOT NULL,
    "variant_code" VARCHAR(30) NOT NULL,
    "variant_name" VARCHAR(150) NOT NULL,
    "size" VARCHAR(60),
    "color" VARCHAR(60),
    "finish" VARCHAR(60),
    "shape" VARCHAR(60),
    "unit" VARCHAR(20),
    "image_path" VARCHAR(255),
    "notes" TEXT,
    "track_by_qty" BOOLEAN NOT NULL DEFAULT true,
    "track_by_weight" BOOLEAN NOT NULL DEFAULT false,
    "stock_qty" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "stock_weight" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_variant_vendors" (
    "id" SERIAL NOT NULL,
    "variant_id" INTEGER NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "vendor_reference" VARCHAR(80),
    "price" DECIMAL(12,2),
    "moq" DECIMAL(12,2),
    "is_preferred" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_variant_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" SERIAL NOT NULL,
    "variant_id" INTEGER NOT NULL,
    "type" "StockMoveType" NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "balance_after" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "weight" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "balance_weight_after" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "ref_type" VARCHAR(40),
    "ref_id" INTEGER,
    "note" VARCHAR(255),
    "vendor_id" INTEGER,
    "invoice_number" VARCHAR(60),
    "unit_price" DECIMAL(12,2),
    "unit_rate_per_gram" DECIMAL(12,2),
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "items" (
    "id" SERIAL NOT NULL,
    "internal_design_code" VARCHAR(40) NOT NULL,
    "item_number" VARCHAR(40),
    "item_number_allocated_at" TIMESTAMP(3),
    "item_number_allocated_by_id" INTEGER,
    "bifurcation_enabled" BOOLEAN NOT NULL DEFAULT true,
    "item_name" VARCHAR(150),
    "category" VARCHAR(80),
    "subcategory" VARCHAR(80),
    "collection" VARCHAR(80),
    "notes" TEXT,
    "design_type" "DesignType",
    "designer_name" VARCHAR(120),
    "designer_short_name" VARCHAR(20),
    "design_cost" DECIMAL(12,2),
    "selling_price" DECIMAL(12,2),
    "cost_price" DECIMAL(12,2),
    "cad_file_path" VARCHAR(255),
    "sample_status" "SampleStatus" NOT NULL DEFAULT 'DRAFT',
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_design_parts" (
    "id" SERIAL NOT NULL,
    "item_id" INTEGER NOT NULL,
    "part_name" VARCHAR(80) NOT NULL,
    "qty_per_set" INTEGER NOT NULL DEFAULT 1,
    "weight_per_pc" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "item_design_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_color_models" (
    "id" SERIAL NOT NULL,
    "item_id" INTEGER NOT NULL,
    "letter" VARCHAR(8) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "photo_path" VARCHAR(255),
    "cost_price" DECIMAL(12,2),
    "selling_price" DECIMAL(12,2),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_color_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_color_model_processes" (
    "id" SERIAL NOT NULL,
    "color_model_id" INTEGER NOT NULL,
    "process_id" INTEGER NOT NULL,
    "color" VARCHAR(60) NOT NULL,

    CONSTRAINT "item_color_model_processes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_images" (
    "id" SERIAL NOT NULL,
    "item_id" INTEGER NOT NULL,
    "file_path" VARCHAR(255) NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_processes" (
    "id" SERIAL NOT NULL,
    "item_id" INTEGER NOT NULL,
    "process_id" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "item_processes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_services" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "applies_to" VARCHAR(40),
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "process_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_process_services" (
    "id" SERIAL NOT NULL,
    "item_process_id" INTEGER NOT NULL,
    "service_id" INTEGER NOT NULL,
    "cost" DECIMAL(12,2),

    CONSTRAINT "item_process_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_process_attributes" (
    "id" SERIAL NOT NULL,
    "item_process_id" INTEGER NOT NULL,
    "attr_key" VARCHAR(60) NOT NULL,
    "attr_value" VARCHAR(255),

    CONSTRAINT "item_process_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_process_vendors" (
    "id" SERIAL NOT NULL,
    "item_process_id" INTEGER NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "vendor_design_reference" VARCHAR(80),
    "color" VARCHAR(80),
    "color_photo_path" VARCHAR(255),
    "cost_per_piece" DECIMAL(12,2),
    "is_preferred" BOOLEAN NOT NULL DEFAULT false,
    "brings_own_materials" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "item_process_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "process_photos" (
    "id" SERIAL NOT NULL,
    "item_process_id" INTEGER NOT NULL,
    "item_process_vendor_id" INTEGER,
    "file_path" VARCHAR(255) NOT NULL,
    "caption" VARCHAR(150),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "process_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_materials" (
    "id" SERIAL NOT NULL,
    "item_id" INTEGER NOT NULL,
    "variant_id" INTEGER NOT NULL,
    "process_id" INTEGER,
    "color" VARCHAR(80),
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "weight" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "unit" VARCHAR(20),
    "wastage_percent" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "rate" DECIMAL(12,2),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "item_materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" SERIAL NOT NULL,
    "module" VARCHAR(40) NOT NULL,
    "record_id" INTEGER,
    "file_type" VARCHAR(40),
    "original_name" VARCHAR(255),
    "file_name" VARCHAR(255) NOT NULL,
    "file_path" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100),
    "size_bytes" INTEGER,
    "uploaded_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_history" (
    "id" SERIAL NOT NULL,
    "module" VARCHAR(40) NOT NULL,
    "record_id" INTEGER NOT NULL,
    "old_status" VARCHAR(60),
    "new_status" VARCHAR(60) NOT NULL,
    "note" VARCHAR(255),
    "changed_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "casting_batches" (
    "id" SERIAL NOT NULL,
    "batch_number" VARCHAR(40) NOT NULL,
    "process_id" INTEGER,
    "batch_date" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "status" "CastingBatchStatus" NOT NULL DEFAULT 'OPEN',
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "closed_at" TIMESTAMP(3),
    "closed_reason" VARCHAR(255),
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "casting_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "casting_batch_items" (
    "id" SERIAL NOT NULL,
    "batch_id" INTEGER NOT NULL,
    "item_id" INTEGER,
    "item_number" VARCHAR(60) NOT NULL,
    "item_name" VARCHAR(150),
    "vendor_id" INTEGER NOT NULL,
    "vendor_design_reference" VARCHAR(80),
    "weight" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "total_weight" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "cost_per_kg" DECIMAL(12,2),
    "total_cost" DECIMAL(12,2),
    "services" VARCHAR(255),
    "remarks" TEXT,
    "purpose" VARCHAR(120),
    "stage_process_id" INTEGER,
    "parent_item_id" INTEGER,
    "line_key" VARCHAR(40),
    "color_model" VARCHAR(120),
    "color" VARCHAR(60),
    "bom_snapshot" JSONB,
    "issue_slip_id" INTEGER,
    "issue_slip_at" TIMESTAMP(3),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "closed_reason" VARCHAR(255),
    "closed_at" TIMESTAMP(3),
    "short_qty" INTEGER,
    "short_weight" DECIMAL(12,3),
    "planned_next_process_id" INTEGER,
    "planned_next_vendor_id" INTEGER,
    "planned_next_color" VARCHAR(60),
    "planned_target_batch_id" INTEGER,
    "metal_source" "MetalSource" NOT NULL DEFAULT 'FRESH',
    "advance_draw_vendor_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "casting_batch_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "casting_receipts" (
    "id" SERIAL NOT NULL,
    "batch_id" INTEGER NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "receipt_number" VARCHAR(40) NOT NULL,
    "receipt_date" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "casting_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "casting_receipt_items" (
    "id" SERIAL NOT NULL,
    "receipt_id" INTEGER NOT NULL,
    "batch_item_id" INTEGER NOT NULL,
    "received_qty" INTEGER NOT NULL DEFAULT 0,
    "received_weight" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "accepted_qty" INTEGER NOT NULL DEFAULT 0,
    "repair_qty" INTEGER NOT NULL DEFAULT 0,
    "rejected_qty" INTEGER NOT NULL DEFAULT 0,
    "reject_reason" TEXT,
    "reject_payment_mode" "RejectPaymentMode",
    "reject_adjustment" DECIMAL(12,2),
    "cost_per_kg" DECIMAL(12,2),
    "from_repair_order_id" INTEGER,
    "production_variant_id" INTEGER,
    "per_piece_weight" DECIMAL(10,3),
    "remarks" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "casting_receipt_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_orders" (
    "id" SERIAL NOT NULL,
    "receipt_item_id" INTEGER NOT NULL,
    "stage_id" INTEGER NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL,
    "reason" TEXT,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "parent_repair_id" INTEGER,
    "status" "RepairStatus" NOT NULL DEFAULT 'OPEN',
    "final_rejected_qty" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "returned_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_by" INTEGER,
    "production_variant_id" INTEGER,

    CONSTRAINT "repair_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_issues" (
    "id" SERIAL NOT NULL,
    "voucher_number" VARCHAR(40) NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "batch_id" INTEGER,
    "stage_id" INTEGER,
    "issue_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "status" "MaterialIssueStatus" NOT NULL DEFAULT 'OPEN',
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "material_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_issue_lines" (
    "id" SERIAL NOT NULL,
    "issue_id" INTEGER NOT NULL,
    "variant_id" INTEGER NOT NULL,
    "issued_qty" INTEGER NOT NULL,
    "received_qty" INTEGER NOT NULL DEFAULT 0,
    "consumed_qty" INTEGER NOT NULL DEFAULT 0,
    "deferred_qty" INTEGER NOT NULL DEFAULT 0,
    "short_qty" INTEGER,
    "issued_weight" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "received_weight" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "consumed_weight" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "deferred_weight" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "short_weight" DECIMAL(14,3),
    "notes" TEXT,

    CONSTRAINT "material_issue_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouses" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "kind" "WarehouseKind" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finished_good_variants" (
    "id" SERIAL NOT NULL,
    "batch_id" INTEGER NOT NULL,
    "item_id" INTEGER NOT NULL,
    "plating_colour" VARCHAR(80),
    "collection" VARCHAR(120) NOT NULL,
    "total_pcs" INTEGER NOT NULL,
    "loss_pcs" INTEGER NOT NULL DEFAULT 0,
    "loss_reason" TEXT,
    "loss_by_name" VARCHAR(120),
    "counted_by_name" VARCHAR(120) NOT NULL,
    "categorized_by_name" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finished_good_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "box_groups" (
    "id" SERIAL NOT NULL,
    "variant_id" INTEGER NOT NULL,
    "pcs_per_box" INTEGER NOT NULL,
    "initial_box_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "box_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "box_movements" (
    "id" SERIAL NOT NULL,
    "box_group_id" INTEGER NOT NULL,
    "from_location_id" INTEGER,
    "to_location_id" INTEGER NOT NULL,
    "box_count" INTEGER NOT NULL,
    "actor_name" VARCHAR(120) NOT NULL,
    "notes" TEXT,
    "transfer_group_id" VARCHAR(40),
    "moved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "box_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_audit_log" (
    "id" SERIAL NOT NULL,
    "entity_type" VARCHAR(40) NOT NULL,
    "entity_id" INTEGER NOT NULL,
    "field" VARCHAR(60) NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,
    "changed_by_name" VARCHAR(120) NOT NULL,
    "changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_variants" (
    "id" SERIAL NOT NULL,
    "item_id" INTEGER NOT NULL,
    "variant_code" VARCHAR(50) NOT NULL,
    "variant_index" INTEGER NOT NULL,
    "birth_receipt_item_id" INTEGER NOT NULL,
    "birth_weight" DECIMAL(10,3) NOT NULL,
    "current_stage_id" INTEGER,
    "state" "ProductionVariantState" NOT NULL DEFAULT 'IN_PROGRESS',
    "finished_good_id" INTEGER,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "production_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_variant_stage_stops" (
    "id" SERIAL NOT NULL,
    "production_variant_id" INTEGER NOT NULL,
    "stage_id" INTEGER NOT NULL,
    "weight_in" DECIMAL(10,3) NOT NULL,
    "weight_out" DECIMAL(10,3),
    "entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exited_at" TIMESTAMP(3),

    CONSTRAINT "production_variant_stage_stops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_metal_balances" (
    "id" SERIAL NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "variant_id" INTEGER NOT NULL,
    "balance_weight" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_metal_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_metal_ledger" (
    "id" SERIAL NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "variant_id" INTEGER NOT NULL,
    "event_type" "VendorMetalEventType" NOT NULL,
    "weight" DECIMAL(14,3) NOT NULL,
    "balance_after" DECIMAL(14,3) NOT NULL,
    "ref_type" VARCHAR(40),
    "ref_id" INTEGER,
    "note" TEXT,
    "created_by_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_metal_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_idx" ON "audit_logs"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "processes_code_key" ON "processes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_vendor_code_key" ON "vendors"("vendor_code");

-- CreateIndex
CREATE INDEX "vendors_status_idx" ON "vendors"("status");

-- CreateIndex
CREATE INDEX "vendors_vendor_name_idx" ON "vendors"("vendor_name");

-- CreateIndex
CREATE INDEX "vendor_processes_process_id_idx" ON "vendor_processes"("process_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_processes_vendor_id_process_id_key" ON "vendor_processes"("vendor_id", "process_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_categories_name_key" ON "material_categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "materials_material_code_key" ON "materials"("material_code");

-- CreateIndex
CREATE INDEX "materials_category_id_idx" ON "materials"("category_id");

-- CreateIndex
CREATE INDEX "materials_status_idx" ON "materials"("status");

-- CreateIndex
CREATE UNIQUE INDEX "material_variants_variant_code_key" ON "material_variants"("variant_code");

-- CreateIndex
CREATE INDEX "material_variants_material_id_idx" ON "material_variants"("material_id");

-- CreateIndex
CREATE INDEX "material_variants_status_idx" ON "material_variants"("status");

-- CreateIndex
CREATE INDEX "material_variant_vendors_vendor_id_idx" ON "material_variant_vendors"("vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_variant_vendors_variant_id_vendor_id_key" ON "material_variant_vendors"("variant_id", "vendor_id");

-- CreateIndex
CREATE INDEX "stock_movements_variant_id_idx" ON "stock_movements"("variant_id");

-- CreateIndex
CREATE INDEX "stock_movements_ref_type_ref_id_idx" ON "stock_movements"("ref_type", "ref_id");

-- CreateIndex
CREATE INDEX "stock_movements_vendor_id_idx" ON "stock_movements"("vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "items_internal_design_code_key" ON "items"("internal_design_code");

-- CreateIndex
CREATE UNIQUE INDEX "items_item_number_key" ON "items"("item_number");

-- CreateIndex
CREATE INDEX "items_sample_status_idx" ON "items"("sample_status");

-- CreateIndex
CREATE INDEX "items_category_idx" ON "items"("category");

-- CreateIndex
CREATE INDEX "item_design_parts_item_id_idx" ON "item_design_parts"("item_id");

-- CreateIndex
CREATE INDEX "item_color_models_item_id_idx" ON "item_color_models"("item_id");

-- CreateIndex
CREATE INDEX "item_color_model_processes_color_model_id_idx" ON "item_color_model_processes"("color_model_id");

-- CreateIndex
CREATE INDEX "item_images_item_id_idx" ON "item_images"("item_id");

-- CreateIndex
CREATE INDEX "item_processes_process_id_idx" ON "item_processes"("process_id");

-- CreateIndex
CREATE UNIQUE INDEX "item_processes_item_id_process_id_key" ON "item_processes"("item_id", "process_id");

-- CreateIndex
CREATE UNIQUE INDEX "process_services_code_key" ON "process_services"("code");

-- CreateIndex
CREATE INDEX "item_process_services_service_id_idx" ON "item_process_services"("service_id");

-- CreateIndex
CREATE UNIQUE INDEX "item_process_services_item_process_id_service_id_key" ON "item_process_services"("item_process_id", "service_id");

-- CreateIndex
CREATE UNIQUE INDEX "item_process_attributes_item_process_id_attr_key_key" ON "item_process_attributes"("item_process_id", "attr_key");

-- CreateIndex
CREATE INDEX "item_process_vendors_item_process_id_idx" ON "item_process_vendors"("item_process_id");

-- CreateIndex
CREATE INDEX "item_process_vendors_vendor_id_idx" ON "item_process_vendors"("vendor_id");

-- CreateIndex
CREATE INDEX "process_photos_item_process_id_idx" ON "process_photos"("item_process_id");

-- CreateIndex
CREATE INDEX "process_photos_item_process_vendor_id_idx" ON "process_photos"("item_process_vendor_id");

-- CreateIndex
CREATE INDEX "item_materials_item_id_idx" ON "item_materials"("item_id");

-- CreateIndex
CREATE INDEX "item_materials_variant_id_idx" ON "item_materials"("variant_id");

-- CreateIndex
CREATE INDEX "item_materials_process_id_idx" ON "item_materials"("process_id");

-- CreateIndex
CREATE INDEX "files_module_record_id_idx" ON "files"("module", "record_id");

-- CreateIndex
CREATE INDEX "status_history_module_record_id_idx" ON "status_history"("module", "record_id");

-- CreateIndex
CREATE UNIQUE INDEX "casting_batches_batch_number_key" ON "casting_batches"("batch_number");

-- CreateIndex
CREATE INDEX "casting_batches_status_idx" ON "casting_batches"("status");

-- CreateIndex
CREATE INDEX "casting_batches_process_id_idx" ON "casting_batches"("process_id");

-- CreateIndex
CREATE INDEX "casting_batch_items_batch_id_idx" ON "casting_batch_items"("batch_id");

-- CreateIndex
CREATE INDEX "casting_batch_items_vendor_id_idx" ON "casting_batch_items"("vendor_id");

-- CreateIndex
CREATE INDEX "casting_batch_items_line_key_idx" ON "casting_batch_items"("line_key");

-- CreateIndex
CREATE UNIQUE INDEX "casting_receipts_receipt_number_key" ON "casting_receipts"("receipt_number");

-- CreateIndex
CREATE INDEX "casting_receipts_batch_id_idx" ON "casting_receipts"("batch_id");

-- CreateIndex
CREATE INDEX "casting_receipts_vendor_id_idx" ON "casting_receipts"("vendor_id");

-- CreateIndex
CREATE INDEX "casting_receipt_items_receipt_id_idx" ON "casting_receipt_items"("receipt_id");

-- CreateIndex
CREATE INDEX "casting_receipt_items_batch_item_id_idx" ON "casting_receipt_items"("batch_item_id");

-- CreateIndex
CREATE INDEX "casting_receipt_items_production_variant_id_idx" ON "casting_receipt_items"("production_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "repair_orders_receipt_item_id_key" ON "repair_orders"("receipt_item_id");

-- CreateIndex
CREATE INDEX "repair_orders_stage_id_idx" ON "repair_orders"("stage_id");

-- CreateIndex
CREATE INDEX "repair_orders_vendor_id_idx" ON "repair_orders"("vendor_id");

-- CreateIndex
CREATE INDEX "repair_orders_status_idx" ON "repair_orders"("status");

-- CreateIndex
CREATE INDEX "repair_orders_production_variant_id_idx" ON "repair_orders"("production_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_issues_voucher_number_key" ON "material_issues"("voucher_number");

-- CreateIndex
CREATE INDEX "material_issues_vendor_id_idx" ON "material_issues"("vendor_id");

-- CreateIndex
CREATE INDEX "material_issues_batch_id_idx" ON "material_issues"("batch_id");

-- CreateIndex
CREATE INDEX "material_issues_status_idx" ON "material_issues"("status");

-- CreateIndex
CREATE INDEX "material_issue_lines_issue_id_idx" ON "material_issue_lines"("issue_id");

-- CreateIndex
CREATE INDEX "material_issue_lines_variant_id_idx" ON "material_issue_lines"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_name_key" ON "warehouses"("name");

-- CreateIndex
CREATE INDEX "finished_good_variants_batch_id_idx" ON "finished_good_variants"("batch_id");

-- CreateIndex
CREATE INDEX "finished_good_variants_item_id_plating_colour_collection_idx" ON "finished_good_variants"("item_id", "plating_colour", "collection");

-- CreateIndex
CREATE INDEX "box_groups_variant_id_idx" ON "box_groups"("variant_id");

-- CreateIndex
CREATE INDEX "box_movements_box_group_id_idx" ON "box_movements"("box_group_id");

-- CreateIndex
CREATE INDEX "box_movements_to_location_id_idx" ON "box_movements"("to_location_id");

-- CreateIndex
CREATE INDEX "box_movements_from_location_id_idx" ON "box_movements"("from_location_id");

-- CreateIndex
CREATE INDEX "box_movements_transfer_group_id_idx" ON "box_movements"("transfer_group_id");

-- CreateIndex
CREATE INDEX "dispatch_audit_log_entity_type_entity_id_idx" ON "dispatch_audit_log"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "dispatch_audit_log_changed_at_idx" ON "dispatch_audit_log"("changed_at");

-- CreateIndex
CREATE UNIQUE INDEX "production_variants_variant_code_key" ON "production_variants"("variant_code");

-- CreateIndex
CREATE INDEX "production_variants_item_id_idx" ON "production_variants"("item_id");

-- CreateIndex
CREATE INDEX "production_variants_current_stage_id_idx" ON "production_variants"("current_stage_id");

-- CreateIndex
CREATE INDEX "production_variants_state_idx" ON "production_variants"("state");

-- CreateIndex
CREATE UNIQUE INDEX "production_variants_item_id_variant_index_key" ON "production_variants"("item_id", "variant_index");

-- CreateIndex
CREATE INDEX "production_variant_stage_stops_stage_id_idx" ON "production_variant_stage_stops"("stage_id");

-- CreateIndex
CREATE UNIQUE INDEX "production_variant_stage_stops_production_variant_id_stage__key" ON "production_variant_stage_stops"("production_variant_id", "stage_id");

-- CreateIndex
CREATE INDEX "vendor_metal_balances_vendor_id_idx" ON "vendor_metal_balances"("vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_metal_balances_vendor_id_variant_id_key" ON "vendor_metal_balances"("vendor_id", "variant_id");

-- CreateIndex
CREATE INDEX "vendor_metal_ledger_vendor_id_variant_id_idx" ON "vendor_metal_ledger"("vendor_id", "variant_id");

-- CreateIndex
CREATE INDEX "vendor_metal_ledger_event_type_idx" ON "vendor_metal_ledger"("event_type");

-- CreateIndex
CREATE INDEX "vendor_metal_ledger_created_at_idx" ON "vendor_metal_ledger"("created_at");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_undone_by_user_id_fkey" FOREIGN KEY ("undone_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_undo_of_id_fkey" FOREIGN KEY ("undo_of_id") REFERENCES "audit_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_processes" ADD CONSTRAINT "vendor_processes_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_processes" ADD CONSTRAINT "vendor_processes_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "material_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "materials" ADD CONSTRAINT "materials_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_variants" ADD CONSTRAINT "material_variants_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "materials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_variant_vendors" ADD CONSTRAINT "material_variant_vendors_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "material_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_variant_vendors" ADD CONSTRAINT "material_variant_vendors_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "material_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "items" ADD CONSTRAINT "items_item_number_allocated_by_id_fkey" FOREIGN KEY ("item_number_allocated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_design_parts" ADD CONSTRAINT "item_design_parts_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_color_models" ADD CONSTRAINT "item_color_models_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_color_model_processes" ADD CONSTRAINT "item_color_model_processes_color_model_id_fkey" FOREIGN KEY ("color_model_id") REFERENCES "item_color_models"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_images" ADD CONSTRAINT "item_images_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_processes" ADD CONSTRAINT "item_processes_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_processes" ADD CONSTRAINT "item_processes_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_process_services" ADD CONSTRAINT "item_process_services_item_process_id_fkey" FOREIGN KEY ("item_process_id") REFERENCES "item_processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_process_services" ADD CONSTRAINT "item_process_services_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "process_services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_process_attributes" ADD CONSTRAINT "item_process_attributes_item_process_id_fkey" FOREIGN KEY ("item_process_id") REFERENCES "item_processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_process_vendors" ADD CONSTRAINT "item_process_vendors_item_process_id_fkey" FOREIGN KEY ("item_process_id") REFERENCES "item_processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_process_vendors" ADD CONSTRAINT "item_process_vendors_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_photos" ADD CONSTRAINT "process_photos_item_process_id_fkey" FOREIGN KEY ("item_process_id") REFERENCES "item_processes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "process_photos" ADD CONSTRAINT "process_photos_item_process_vendor_id_fkey" FOREIGN KEY ("item_process_vendor_id") REFERENCES "item_process_vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_materials" ADD CONSTRAINT "item_materials_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_materials" ADD CONSTRAINT "item_materials_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "material_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_materials" ADD CONSTRAINT "item_materials_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "processes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_history" ADD CONSTRAINT "status_history_changed_by_fkey" FOREIGN KEY ("changed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_batches" ADD CONSTRAINT "casting_batches_process_id_fkey" FOREIGN KEY ("process_id") REFERENCES "processes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_batch_items" ADD CONSTRAINT "casting_batch_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "casting_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_batch_items" ADD CONSTRAINT "casting_batch_items_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_batch_items" ADD CONSTRAINT "casting_batch_items_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_batch_items" ADD CONSTRAINT "casting_batch_items_stage_process_id_fkey" FOREIGN KEY ("stage_process_id") REFERENCES "processes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_batch_items" ADD CONSTRAINT "casting_batch_items_planned_next_process_id_fkey" FOREIGN KEY ("planned_next_process_id") REFERENCES "processes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_batch_items" ADD CONSTRAINT "casting_batch_items_planned_next_vendor_id_fkey" FOREIGN KEY ("planned_next_vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_batch_items" ADD CONSTRAINT "casting_batch_items_planned_target_batch_id_fkey" FOREIGN KEY ("planned_target_batch_id") REFERENCES "casting_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_batch_items" ADD CONSTRAINT "casting_batch_items_advance_draw_vendor_id_fkey" FOREIGN KEY ("advance_draw_vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_receipts" ADD CONSTRAINT "casting_receipts_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "casting_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_receipts" ADD CONSTRAINT "casting_receipts_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_receipt_items" ADD CONSTRAINT "casting_receipt_items_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "casting_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_receipt_items" ADD CONSTRAINT "casting_receipt_items_batch_item_id_fkey" FOREIGN KEY ("batch_item_id") REFERENCES "casting_batch_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_receipt_items" ADD CONSTRAINT "casting_receipt_items_from_repair_order_id_fkey" FOREIGN KEY ("from_repair_order_id") REFERENCES "repair_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "casting_receipt_items" ADD CONSTRAINT "casting_receipt_items_production_variant_id_fkey" FOREIGN KEY ("production_variant_id") REFERENCES "production_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_receipt_item_id_fkey" FOREIGN KEY ("receipt_item_id") REFERENCES "casting_receipt_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "casting_batch_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_parent_repair_id_fkey" FOREIGN KEY ("parent_repair_id") REFERENCES "repair_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_production_variant_id_fkey" FOREIGN KEY ("production_variant_id") REFERENCES "production_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_orders" ADD CONSTRAINT "repair_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_issues" ADD CONSTRAINT "material_issues_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_issues" ADD CONSTRAINT "material_issues_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "casting_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_issues" ADD CONSTRAINT "material_issues_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "casting_batch_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_issues" ADD CONSTRAINT "material_issues_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_issue_lines" ADD CONSTRAINT "material_issue_lines_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "material_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_issue_lines" ADD CONSTRAINT "material_issue_lines_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "material_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_good_variants" ADD CONSTRAINT "finished_good_variants_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "casting_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_good_variants" ADD CONSTRAINT "finished_good_variants_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "box_groups" ADD CONSTRAINT "box_groups_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "finished_good_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "box_movements" ADD CONSTRAINT "box_movements_box_group_id_fkey" FOREIGN KEY ("box_group_id") REFERENCES "box_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "box_movements" ADD CONSTRAINT "box_movements_from_location_id_fkey" FOREIGN KEY ("from_location_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "box_movements" ADD CONSTRAINT "box_movements_to_location_id_fkey" FOREIGN KEY ("to_location_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_variants" ADD CONSTRAINT "production_variants_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_variant_stage_stops" ADD CONSTRAINT "production_variant_stage_stops_production_variant_id_fkey" FOREIGN KEY ("production_variant_id") REFERENCES "production_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_variant_stage_stops" ADD CONSTRAINT "production_variant_stage_stops_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "casting_batch_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_metal_balances" ADD CONSTRAINT "vendor_metal_balances_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_metal_balances" ADD CONSTRAINT "vendor_metal_balances_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "material_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_metal_ledger" ADD CONSTRAINT "vendor_metal_ledger_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_metal_ledger" ADD CONSTRAINT "vendor_metal_ledger_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "material_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_metal_ledger" ADD CONSTRAINT "vendor_metal_ledger_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
