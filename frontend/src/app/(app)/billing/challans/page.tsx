'use client';
import { BillingDocList } from '@/components/shared/billing-doc-list';

export default function ChallansPage() {
  return (
    <BillingDocList
      type="DELIVERY_CHALLAN"
      title="Delivery Challans"
      description="Goods movement — no GST, tax invoice to follow."
    />
  );
}
