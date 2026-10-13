import { createRoute } from "@tanstack/react-router";
import { z } from "@shared/schemas/zod";
import { rootRoute } from "@/app/root-route";
import { forecastQuery } from "./api";
import { ForecastPage } from "./forecast-page";

const forecastSearch = z.object({
  months: z.coerce.number().int().min(1).max(24).optional(),
  view: z.enum(["month", "week"]).optional(),
  drafts: z.boolean().optional(),
  offers: z.boolean().optional(),
  probability: z.coerce.number().int().min(0).max(100).optional(),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/forecast",
  validateSearch: forecastSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(
      forecastQuery({
        months: deps.months ?? 6,
        drafts: deps.drafts ?? false,
        offers: deps.offers ?? false,
        probability: deps.probability ?? 50,
      }),
    ),
  component: function Forecast() {
    const search = indexRoute.useSearch();
    const navigate = indexRoute.useNavigate();
    return (
      <ForecastPage
        search={search}
        setSearch={(update) => void navigate({ search: (s) => ({ ...s, ...update }), replace: true })}
      />
    );
  },
});

export const forecastRoutes = [indexRoute] as const;
