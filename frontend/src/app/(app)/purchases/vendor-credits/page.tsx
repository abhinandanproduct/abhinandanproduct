'use client';
import { PurchasesDocList } from '@/components/shared/purchases-doc-list';
export default function DebitNotesPage() {
  return (
    <PurchasesDocList
      type="VENDOR_CREDIT"
      title="Debit Notes"
      description="Debit notes against vendors — adjusts what you owe them when goods are returned or short."
    />
  );
}
