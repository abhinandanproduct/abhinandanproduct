-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "charges_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "labor_discount_percent" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "processes" ADD COLUMN     "requires_short_name" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "charge_types" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "charge_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_charges" (
    "id" SERIAL NOT NULL,
    "invoice_id" INTEGER NOT NULL,
    "charge_type_id" INTEGER NOT NULL,
    "label" VARCHAR(120),
    "amount" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_charges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "charge_types_code_key" ON "charge_types"("code");

-- CreateIndex
CREATE INDEX "invoice_charges_invoice_id_idx" ON "invoice_charges"("invoice_id");

-- AddForeignKey
ALTER TABLE "invoice_charges" ADD CONSTRAINT "invoice_charges_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_charges" ADD CONSTRAINT "invoice_charges_charge_type_id_fkey" FOREIGN KEY ("charge_type_id") REFERENCES "charge_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
