import { createRoute, getRouteApi } from "@tanstack/react-router";
import { z } from "@shared/schemas/zod";
import { documentListQuerySchema } from "@shared/schemas/document";
import type { DocumentType } from "@shared/documents";
import { rootRoute } from "@/app/root-route";
import { documentQuery } from "./api";
import { DocumentListPage } from "./document-list-page";
import { DocumentDetailPage, NewDocumentPage } from "./document-pages";

// Per type: list (/offers), new draft (/offers/new?clientId=), detail/editor (/offers/$id).
const listSearch = documentListQuerySchema.omit({ type: true });
const newSearch = z.object({ clientId: z.coerce.number().int().positive().optional() });
const parseId = (params: { id: string }) => ({ id: Number(params.id) });
const stringifyId = (params: { id: number }) => ({ id: String(params.id) });

type ListPath = "/offers" | "/invoices" | "/credit-notes";

function ListPage({ type, path }: { type: DocumentType; path: ListPath }) {
  const routeApi = getRouteApi(path);
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  return (
    <DocumentListPage
      type={type}
      search={search}
      setSearch={(update) => void navigate({ search: update, replace: true })}
    />
  );
}

const offersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/offers",
  validateSearch: listSearch,
  component: () => <ListPage type="offer" path="/offers" />,
});
const newOfferRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/offers/new",
  validateSearch: newSearch,
  component: function NewOffer() {
    return <NewDocumentPage type="offer" clientId={newOfferRoute.useSearch().clientId} />;
  },
});
const offerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/offers/$id",
  params: { parse: parseId, stringify: stringifyId },
  loader: ({ context, params }) => context.queryClient.ensureQueryData(documentQuery(params.id)),
  component: function Offer() {
    return <DocumentDetailPage type="offer" id={offerRoute.useParams().id} />;
  },
});

const invoicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invoices",
  validateSearch: listSearch,
  component: () => <ListPage type="invoice" path="/invoices" />,
});
const newInvoiceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invoices/new",
  validateSearch: newSearch,
  component: function NewInvoice() {
    return <NewDocumentPage type="invoice" clientId={newInvoiceRoute.useSearch().clientId} />;
  },
});
const invoiceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invoices/$id",
  params: { parse: parseId, stringify: stringifyId },
  loader: ({ context, params }) => context.queryClient.ensureQueryData(documentQuery(params.id)),
  component: function Invoice() {
    return <DocumentDetailPage type="invoice" id={invoiceRoute.useParams().id} />;
  },
});

const creditNotesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/credit-notes",
  validateSearch: listSearch,
  component: () => <ListPage type="credit_note" path="/credit-notes" />,
});
const newCreditNoteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/credit-notes/new",
  validateSearch: newSearch,
  component: function NewCreditNote() {
    return <NewDocumentPage type="credit_note" clientId={newCreditNoteRoute.useSearch().clientId} />;
  },
});
const creditNoteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/credit-notes/$id",
  params: { parse: parseId, stringify: stringifyId },
  loader: ({ context, params }) => context.queryClient.ensureQueryData(documentQuery(params.id)),
  component: function CreditNote() {
    return <DocumentDetailPage type="credit_note" id={creditNoteRoute.useParams().id} />;
  },
});

export const documentsRoutes = [
  offersRoute,
  newOfferRoute,
  offerRoute,
  invoicesRoute,
  newInvoiceRoute,
  invoiceRoute,
  creditNotesRoute,
  newCreditNoteRoute,
  creditNoteRoute,
] as const;
