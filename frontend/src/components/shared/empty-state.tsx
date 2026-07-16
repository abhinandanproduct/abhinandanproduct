import { Inbox } from 'lucide-react';

/**
 * Empty state — a centered icon disc with a gold-tinted ring, a title, an
 * optional description, and an optional CTA. Used wherever a list / panel
 * has nothing to render but the page itself isn't loading.
 */
export function EmptyState({
  title = 'Nothing here yet',
  description,
  icon: Icon = Inbox,
  action,
}: {
  title?: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-14 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-full border border-gold/30 bg-gold/5 shadow-[0_0_24px_-12px_hsl(var(--gold)/0.5)]">
        <Icon className="size-6 text-gold" />
      </div>
      <p className="text-base font-semibold text-foreground">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-text-faint">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
