'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster, TooltipProvider } from '@am/ui';

export function Providers({ children }: { children: React.ReactNode }) {
  // Created lazily per browser session so server-rendered requests never share
  // a cache between users.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // Authorisation and validation failures are not worth retrying;
              // retrying them just delays the German error the user needs.
              const code = (error as { code?: string } | null)?.code;
              if (code === 'FORBIDDEN' || code === 'UNAUTHENTICATED' || code === 'VALIDATION_FAILED') {
                return false;
              }
              return failureCount < 2;
            },
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>{children}</TooltipProvider>
      <Toaster />
    </QueryClientProvider>
  );
}
