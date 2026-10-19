import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext } from "@tanstack/react-router";
import { AppShell } from "./app-shell";
import { NotFoundPage } from "./not-found";

export interface RouterContext {
  queryClient: QueryClient;
}

/** Parent of every feature route: `getParentRoute: () => rootRoute`. */
export const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppShell,
  notFoundComponent: NotFoundPage,
});
