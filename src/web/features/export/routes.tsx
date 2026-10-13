import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "@/app/root-route";
import { localBackupsQuery } from "@/sdk";
import { ExportPage } from "./export-page";

const exportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/export",
  loader: ({ context }) => context.queryClient.ensureQueryData(localBackupsQuery),
  component: ExportPage,
});

export const exportRoutes = [exportRoute] as const;
