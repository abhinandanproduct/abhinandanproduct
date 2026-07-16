import { Badge } from '@/components/ui/badge';
import { SAMPLE_STATUS_LABELS } from '@/lib/utils';

/**
 * Status badge mappings — keeps the colour semantics consistent across the
 * app. ACTIVE / PRODUCTION_READY = success (green); DRAFT = warning (amber);
 * IN_DEVELOPMENT = info (blue); SAMPLE_READY = default (gold).
 */
const variantMap: Record<string, any> = {
  ACTIVE: 'success',
  INACTIVE: 'secondary',
  DRAFT: 'warning',
  IN_DEVELOPMENT: 'info',
  SAMPLE_READY: 'default',
  PRODUCTION_READY: 'success',
};

export function StatusBadge({ status }: { status: string }) {
  const label = SAMPLE_STATUS_LABELS[status] ?? status.charAt(0) + status.slice(1).toLowerCase();
  return <Badge variant={variantMap[status] ?? 'secondary'}>{label}</Badge>;
}

// Casting batch / delivery status. `context` controls the wording.
const CASTING_VARIANT: Record<string, any> = {
  OPEN: 'warning',
  PARTIAL: 'info',
  COMPLETED: 'success',
};
const CASTING_LABELS: Record<'batch' | 'delivery', Record<string, string>> = {
  batch:    { OPEN: 'Not Received',   PARTIAL: 'Partial', COMPLETED: 'Completed' },
  delivery: { OPEN: 'Not Delivered',  PARTIAL: 'Partial', COMPLETED: 'Completely Delivered' },
};

export function CastingStatusBadge({
  status,
  context = 'batch',
}: {
  status: string;
  context?: 'batch' | 'delivery';
}) {
  const label = CASTING_LABELS[context][status] ?? status;
  return <Badge variant={CASTING_VARIANT[status] ?? 'secondary'}>{label}</Badge>;
}
