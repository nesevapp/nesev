import { createRouter } from "@tanstack/react-router";
import { queryClient } from "@/lib/query-client";
import { rootRoute } from "./root-route";
import { articlesRoutes } from "@/features/articles/routes";
import { bankRoutes } from "@/features/bank/routes";
import { clientsRoutes } from "@/features/clients/routes";
import { dashboardRoutes } from "@/features/dashboard/routes";
import { documentsRoutes } from "@/features/documents/routes";
import { expensesRoutes } from "@/features/expenses/routes";
import { exportRoutes } from "@/features/export/routes";
import { forecastRoutes } from "@/features/forecast/routes";
import { recurringRoutes } from "@/features/recurring/routes";
import { remindersRoutes } from "@/features/reminders/routes";
import { settingsRoutes } from "@/features/settings/routes";
import { taxRoutes } from "@/features/tax/routes";
import { templatesRoutes } from "@/features/templates/routes";

// ── Feature route registry ──────────────────────────────────────────────────────
// Each feature exports a tuple of routes from src/web/features/<feature>/routes.tsx.
// Adding pages to an existing feature only touches that file. A NEW feature adds one
// import above and one entry here.
const routeTree = rootRoute.addChildren([
  ...dashboardRoutes,
  ...documentsRoutes,
  ...remindersRoutes,
  ...recurringRoutes,
  ...forecastRoutes,
  ...expensesRoutes,
  ...bankRoutes,
  ...taxRoutes,
  ...clientsRoutes,
  ...articlesRoutes,
  ...templatesRoutes,
  ...exportRoutes,
  ...settingsRoutes,
]);
// ────────────────────────────────────────────────────────────────────────────────

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
