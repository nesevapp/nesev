import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { rootRoute } from "@/app/root-route";
import { Page } from "@/components/page";
import { apiErrorMessage } from "@/lib/api";
import { templateQuery, templatesQuery } from "./api";
import { TemplatesPage } from "./templates-page";

const listRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/templates",
  loader: ({ context }) => context.queryClient.ensureQueryData(templatesQuery),
  component: TemplatesPage,
});

const designerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/templates/$id",
  params: {
    parse: ({ id }: { id: string }) => ({ id: Number(id) }),
    stringify: ({ id }: { id: number }) => ({ id: String(id) }),
  },
  loader: ({ context, params }) => context.queryClient.ensureQueryData(templateQuery(params.id)),
  // pdfme (Designer, generator, fonts) is large: load it only on the designer page
  component: lazyRouteComponent(() => import("./template-designer-page"), "TemplateDesignerPage"),
  errorComponent: ({ error }) => (
    <Page title="PDF-Vorlage">
      <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
        {apiErrorMessage(error)}
      </div>
    </Page>
  ),
});

export const templatesRoutes = [listRoute, designerRoute] as const;
