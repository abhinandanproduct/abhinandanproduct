'use client';
import { BillingDocList } from '@/components/shared/billing-doc-list';

export default function QuotesPage() {
  return (
    <BillingDocList
      type="QUOTE"
      title="Estimates"
      description="Flexible-rate quotes — convert to Sales Order or Tax Invoice when confirmed."
    />
  );
}
