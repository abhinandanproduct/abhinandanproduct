'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ReceiveForm } from './receive-form';

/**
 * /casting/receipt — landing route used by deep-links (e.g. the Repair Orders
 * "Receive back" button). Reads URL params and opens the Receive Goods dialog
 * pre-scoped:
 *   ?batchId=<id>           — the batch to receive into
 *   ?vendorId=<id>          — pre-pick the vendor row
 *   ?repairOrderId=<id>     — when set, the resulting receipt closes that
 *                             repair order (the form stamps fromRepairOrderId
 *                             on every row it submits).
 *
 * When the user closes the form, they're sent back to /repairs (the most
 * common origin). Standalone visits without params just open an empty form.
 */
export default function CastingReceiptPage() {
  const router = useRouter();
  const search = useSearchParams();
  const batchId = search?.get('batchId') ? Number(search.get('batchId')) : null;
  // vendorId comes through from the QR-scan flow (/casting/scan → Accept)
  // so the form lands fully scoped to the right karigar without the
  // operator having to repick from the batch's vendor list.
  const vendorId = search?.get('vendorId') ? Number(search.get('vendorId')) : null;
  const repairOrderId = search?.get('repairOrderId') ? Number(search.get('repairOrderId')) : null;
  const [open, setOpen] = React.useState(true);

  return (
    <div>
      <ReceiveForm
        open={open}
        initialBatchId={batchId}
        initialVendorId={vendorId}
        repairOrderId={repairOrderId}
        onClose={() => {
          setOpen(false);
          // Bounce back to /repairs when the deep-link brought us here;
          // otherwise back to Production Management.
          router.push(repairOrderId ? '/repairs' : '/casting/batches');
        }}
      />
    </div>
  );
}
