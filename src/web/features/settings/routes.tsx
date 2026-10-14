import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "@/app/root-route";
import { settingsQuery } from "@/sdk";
import { SettingsPage } from "./settings-page";
import { settingsSearch } from "./settings-tabs";

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  validateSearch: settingsSearch,
  loader: ({ context }) => context.queryClient.ensureQueryData(settingsQuery),
  component: SettingsPage,
});

export const settingsRoutes = [settingsRoute] as const;
