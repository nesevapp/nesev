import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "@/app/root-route";
import { recurringExpensesQuery } from "@/sdk";
import { FixedCostsPage } from "./fixed-costs-page";

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/fixed-costs",
  loader: ({ context }) => context.queryClient.ensureQueryData(recurringExpensesQuery),
  component: FixedCostsPage,
});

export const fixedCostsRoutes = [indexRoute] as const;
