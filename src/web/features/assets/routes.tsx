import { useSuspenseQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { z } from "@shared/schemas/zod";
import { rootRoute } from "@/app/root-route";
import { assetQuery, assetRegisterQuery } from "@/sdk";
import { AssetPage } from "./asset-page";
import { AssetsPage } from "./assets-page";

// /assets (Anlagenverzeichnis of a year), /assets/$id (detail with AfA schedule).

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/assets",
  validateSearch: z.object({ year: z.coerce.number().int().min(2000).max(2100).optional().catch(undefined) }),
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(assetRegisterQuery(deps.year)),
  component: function Assets() {
    const { year } = indexRoute.useSearch();
    const navigate = indexRoute.useNavigate();
    return <AssetsPage year={year} setYear={(y) => void navigate({ search: { year: y }, replace: true })} />;
  },
});

const detailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/assets/$id",
  params: {
    parse: (p: { id: string }) => ({ id: Number(p.id) }),
    stringify: (p: { id: number }) => ({ id: String(p.id) }),
  },
  loader: ({ context, params }) => context.queryClient.ensureQueryData(assetQuery(params.id)),
  component: function Asset() {
    const { id } = detailRoute.useParams();
    const { data } = useSuspenseQuery(assetQuery(id));
    return <AssetPage asset={data} />;
  },
});

export const assetsRoutes = [indexRoute, detailRoute] as const;
