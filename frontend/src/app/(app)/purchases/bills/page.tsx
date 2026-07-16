'use client';
import { PurchasesDocList } from '@/components/shared/purchases-doc-list';
export default function BillsPage() {
  return (
    <PurchasesDocList
      type="BILL"
      title="Bills"
      description="Vendor invoices — what you owe and what's been paid."
    />
  );
}
