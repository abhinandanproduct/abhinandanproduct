'use client';
import { PurchasesDocList } from '@/components/shared/purchases-doc-list';
export default function PurchaseOrdersPage() {
  return (
    <PurchasesDocList
      type="PURCHASE_ORDER"
      title="Purchase Orders"
      description="Orders sent to vendors — convert to Bill when goods/services arrive."
    />
  );
}
