import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "@/app/root-route";
import { settingsQuery } from "./api";
import { SettingsPage } from "./settings-page";

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  loader: ({ context }) => context.queryClient.ensureQueryData(settingsQuery),
  component: SettingsPage,
});

export const settingsRoutes = [settingsRoute] as const;
