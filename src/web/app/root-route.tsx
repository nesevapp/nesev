import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext } from "@tanstack/react-router";
import { AppShell } from "./app-shell";

export interface RouterContext {
  queryClient: QueryClient;
}

/** Parent of every feature route: `getParentRoute: () => rootRoute`. */
export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppShell,
  notFoundComponent: () => <div className="p-8 text-sm text-muted-foreground">Seite nicht gefunden.</div>,
});
