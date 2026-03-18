"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { useProjectStore } from "../lib/project-store";
import { setApiKey } from "../lib/api";

function ApiKeyHydrator({ children }: { children: React.ReactNode }) {
  const { currentApiKey } = useProjectStore();

  useEffect(() => {
    if (currentApiKey) {
      setApiKey(currentApiKey);
    }
  }, [currentApiKey]);

  return <>{children}</>;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        refetchInterval: 10_000,
      },
    },
  }));

  return (
    <QueryClientProvider client={queryClient}>
      <ApiKeyHydrator>
        {children}
      </ApiKeyHydrator>
    </QueryClientProvider>
  );
}
