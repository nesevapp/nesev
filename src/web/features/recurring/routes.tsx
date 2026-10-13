import { useQuery } from "@tanstack/react-query";
import { createRoute } from "@tanstack/react-router";
import { z } from "@shared/schemas/zod";
import { rootRoute } from "@/app/root-route";
import { Page } from "@/components/page";
import { fetchDocumentDefaults } from "@/features/documents/api";
import { recurringListQuery, recurringQuery } from "./api";
import { newRecurringValues, RecurringEditor, toFormValues } from "./recurring-editor";
import { RecurringListPage } from "./recurring-list-page";

const parseId = (params: { id: string }) => ({ id: Number(params.id) });
const stringifyId = (params: { id: number }) => ({ id: String(params.id) });

const listRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/recurring",
  loader: ({ context }) => context.queryClient.ensureQueryData(recurringListQuery),
  component: RecurringListPage,
});

const newRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/recurring/new",
  validateSearch: z.object({ clientId: z.coerce.number().int().positive().optional() }),
  component: function NewRecurring() {
    const { clientId } = newRoute.useSearch();
    // invoice defaults (texts, tax mode) for the optional preselected client
    const { data } = useQuery({
      queryKey: ["documents", "defaults", "invoice", clientId ?? null],
      queryFn: () => fetchDocumentDefaults("invoice", clientId),
      staleTime: Infinity,
    });
    if (!data) return <Page title="Neue Serienrechnung" />;
    return <RecurringEditor initialValues={newRecurringValues(data, clientId)} />;
  },
});

const detailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/recurring/$id",
  params: { parse: parseId, stringify: stringifyId },
  loader: ({ context, params }) => context.queryClient.ensureQueryData(recurringQuery(params.id)),
  component: function RecurringDetail() {
    const { id } = detailRoute.useParams();
    const { data } = useQuery(recurringQuery(id));
    if (!data) return <Page title="Serienrechnung" />;
    // key: a different recurring invoice gets a fresh form
    return <RecurringEditor key={data.id} recurring={data} initialValues={toFormValues(data)} />;
  },
});

export const recurringRoutes = [listRoute, newRoute, detailRoute] as const;
