'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { Spinner } from '@/components/ui/spinner';
import { NavProgress } from '@/components/layout/nav-progress';
import { FiscalYearProvider } from '@/lib/fiscal-year';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  React.useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        <Spinner className="size-6" />
      </div>
    );
  }

  return (
    <FiscalYearProvider>
      <div className="min-h-screen">
        <NavProgress />
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <div className="lg:pl-64">
          <Topbar onMenu={() => setSidebarOpen(true)} />
          {/* Mobile: 12px gutters so even iPhone 12 mini (360px wide) has full
              usable width minus a thin frame. sm+: 16px. md+: 24px. */}
          {/* `page-shell` cascades `min-width: 0` to every top-level child
              so a wide table inside doesn't force the whole page to scroll
              sideways. Individual tables that still need horizontal scroll
              should be wrapped in `<div className="table-scroll">…</div>`. */}
          <main className="page-shell p-3 sm:p-4 md:p-6 lg:overflow-x-hidden">{children}</main>
        </div>
      </div>
    </FiscalYearProvider>
  );
}
