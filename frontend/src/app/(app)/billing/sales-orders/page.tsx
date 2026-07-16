'use client';
import { BillingDocList } from '@/components/shared/billing-doc-list';

export default function SalesOrdersPage() {
  return (
    <BillingDocList
      type="SALES_ORDER"
      title="Sales Orders"
      description="Confirmed customer orders — locked rates, awaiting invoicing."
    />
  );
}
