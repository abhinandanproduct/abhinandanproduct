'use client';
import { PurchasesDocList } from '@/components/shared/purchases-doc-list';
export default function ExpensesPage() {
  return (
    <PurchasesDocList
      type="EXPENSE"
      title="Expenses"
      description="Operating expenses — rent / electricity / salary / supplies."
    />
  );
}
