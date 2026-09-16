import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { AgentPanelProvider } from "./crm/agent/AgentPanelProvider";
import { UndoToastProvider } from "./crm/UndoToast";
import { AuthProvider } from "./lib/auth";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

/**
 * The one provider tree the app mounts, above the router, so it can be
 * rendered by a test as well as by `main.tsx`. Kept out of `main.tsx` because
 * that file calls `createRoot` at import time and can never be rendered under
 * vitest -- which is how `UndoToastProvider` went unmounted in production
 * while every test wrapped it by hand (staging `/crm` blank, 2026-09-16).
 *
 * Order, outermost first:
 * - `QueryClientProvider`: every screen and mutation hook.
 * - `AuthProvider`: `RequireAuth` and every API call.
 * - `AgentPanelProvider` (R63): the agent conversation must survive a walk
 *   from the Ledger to a case, so it lives above the routes, not in
 *   `CrmLayout`.
 * - `UndoToastProvider`: `CaseScreen` calls `useLedgerEdit()` ABOVE its own
 *   `CrmLayout`, so the provider cannot live in the layout either. Above the
 *   routes also means an undo toast outlives the navigation that follows the
 *   edit that produced it.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AgentPanelProvider>
          <UndoToastProvider>{children}</UndoToastProvider>
        </AgentPanelProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
