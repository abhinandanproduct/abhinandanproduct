'use client';
import { BillingDocList } from '@/components/shared/billing-doc-list';

export default function CreditNotesPage() {
  return (
    <BillingDocList
      type="CREDIT_NOTE"
      title="Credit Notes"
      description="Adjustments / returns against tax invoices — reverse GST and credit the customer."
    />
  );
}
