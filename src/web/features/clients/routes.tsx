import { createRoute } from "@tanstack/react-router";
import { CLIENT_ARCHIVED_FILTERS } from "@shared/schemas/client";
import { rootRoute } from "@/app/root-route";
import { Page } from "@/components/page";
import { apiErrorMessage, clientQuery, clientsQuery } from "@/sdk";
import { ClientPage } from "./client-page";
import { EditClientPage, NewClientPage } from "./client-edit-pages";
import { ClientsPage } from "./clients-page";

type ArchivedFilter = (typeof CLIENT_ARCHIVED_FILTERS)[number];

export interface ClientsSearch {
  q?: string;
  archived?: Exclude<ArchivedFilter, "active">;
  country?: string;
}

const listRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/clients",
  validateSearch: (s: Record<string, unknown>): ClientsSearch => ({
    q: typeof s.q === "string" && s.q ? s.q : undefined,
    archived: s.archived === "archived" || s.archived === "all" ? s.archived : undefined,
    country: typeof s.country === "string" && /^[A-Z]{2}$/.test(s.country) ? s.country : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(clientsQuery(deps)),
  component: ClientsPage,
});

const newRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/clients/new",
  component: NewClientPage,
});

const params = {
  parse: ({ id }: { id: string }) => ({ id: Number(id) }),
  stringify: ({ id }: { id: number }) => ({ id: String(id) }),
};

function ClientError({ error }: { error: unknown }) {
  return (
    <Page title="Kunde">
      <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
        {apiErrorMessage(error)}
      </div>
    </Page>
  );
}

const detailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/clients/$id",
  params,
  loader: ({ context, params }) => context.queryClient.ensureQueryData(clientQuery(params.id)),
  component: ClientPage,
  errorComponent: ClientError,
});

const editRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/clients/$id/edit",
  params,
  loader: ({ context, params }) => context.queryClient.ensureQueryData(clientQuery(params.id)),
  component: EditClientPage,
  errorComponent: ClientError,
});

export const clientsRoutes = [listRoute, newRoute, detailRoute, editRoute] as const;
