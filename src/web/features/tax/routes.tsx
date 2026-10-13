import { createRoute } from "@tanstack/react-router";
import { z } from "@shared/schemas/zod";
import { PERIOD_KEY_RE } from "@shared/tax-report";
import { rootRoute } from "@/app/root-route";
import { earQuery, uvaQuery, zmQuery } from "@/sdk";
import { TaxPage } from "./tax-page";

const taxSearch = z.object({
  tab: z.enum(["uva", "zm", "ear"]).optional().catch(undefined),
  period: z.string().regex(PERIOD_KEY_RE).optional().catch(undefined),
  year: z.coerce.number().int().min(2000).max(2100).optional().catch(undefined),
  eu: z.boolean().optional().catch(undefined),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tax",
  validateSearch: taxSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => {
    const tab = deps.tab ?? "uva";
    if (tab === "ear") return context.queryClient.ensureQueryData(earQuery(deps.year));
    if (tab === "zm") return context.queryClient.ensureQueryData(zmQuery(deps.period));
    return context.queryClient.ensureQueryData(uvaQuery(deps.period, deps.eu ?? false));
  },
  component: function Tax() {
    const search = indexRoute.useSearch();
    const navigate = indexRoute.useNavigate();
    return <TaxPage search={search} setSearch={(update) => void navigate({ search: (s) => ({ ...s, ...update }), replace: true })} />;
  },
});

export const taxRoutes = [indexRoute] as const;
