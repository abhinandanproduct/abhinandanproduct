-- CreateTable
CREATE TABLE "invoice_estimate_coverages" (
    "id" SERIAL NOT NULL,
    "invoice_id" INTEGER NOT NULL,
    "estimate_id" INTEGER NOT NULL,
    "silver_allocated_g" DECIMAL(12,3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_estimate_coverages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_estimate_coverages_estimate_id_idx" ON "invoice_estimate_coverages"("estimate_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_estimate_coverages_invoice_id_estimate_id_key" ON "invoice_estimate_coverages"("invoice_id", "estimate_id");

-- AddForeignKey
ALTER TABLE "invoice_estimate_coverages" ADD CONSTRAINT "invoice_estimate_coverages_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_estimate_coverages" ADD CONSTRAINT "invoice_estimate_coverages_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

