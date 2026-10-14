import { createRoute } from "@tanstack/react-router";
import { z } from "@shared/schemas/zod";
import { rootRoute } from "@/app/root-route";
import { dashboardQuery } from "@/sdk";
import { DashboardPage } from "./dashboard-page";

const dashboardSearch = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  compare: z.boolean().optional(),
  /** expenses are shown by default; only `false` is kept in the URL */
  expenses: z.boolean().optional(),
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: dashboardSearch,
  loaderDeps: ({ search }) => ({ year: search.year }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(dashboardQuery(deps.year)),
  component: function Dashboard() {
    const search = dashboardRoute.useSearch();
    const navigate = dashboardRoute.useNavigate();
    return (
      <DashboardPage
        year={search.year}
        compare={search.compare ?? false}
        expenses={search.expenses ?? true}
        setSearch={(update) => void navigate({ search: (s) => ({ ...s, ...update }), replace: true })}
      />
    );
  },
});

export const dashboardRoutes = [dashboardRoute] as const;
