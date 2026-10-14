import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "@/app/root-route";
import { Page } from "@/components/page";

// Placeholder – implemented by the feature agent.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/assets",
  component: () => <Page title="Anlagen" />,
});

export const assetsRoutes = [indexRoute] as const;
