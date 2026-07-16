'use client';

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { AuthProvider } from '@/lib/auth';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1,
            // Make navigation feel instant — cached data is considered fresh for 30s
            // so revisiting a page uses cache. Per-mutation refresh still works via
            // invalidateQueries (we already call this everywhere mutations happen).
            staleTime: 30_000,
            // Keep cache around for 5 min before garbage collection so quick back/forth
            // navigation doesn't re-trigger network requests.
            gcTime: 5 * 60_000,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        {children}
        <Toaster richColors position="top-right" closeButton />
      </AuthProvider>
    </QueryClientProvider>
  );
}
