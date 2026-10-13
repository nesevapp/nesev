import { useSuspenseQuery } from "@tanstack/react-query";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { expenseListQuerySchema } from "@shared/schemas/expense";
import { z } from "@shared/schemas/zod";
import { rootRoute } from "@/app/root-route";
import { expenseQuery } from "./api";
import { ExpenseEditor } from "./expense-editor";
import { ExpensesPage } from "./expenses-page";

// /expenses (list, drop receipts for quick capture), /expenses/new, /expenses/$id (editor).

const listRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/expenses",
  validateSearch: expenseListQuerySchema,
  component: function Expenses() {
    const search = listRoute.useSearch();
    const navigate = listRoute.useNavigate();
    return <ExpensesPage search={search} setSearch={(update) => void navigate({ search: update, replace: true })} />;
  },
});

const newRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/expenses/new",
  /** `n` only forces a fresh form after "Speichern & nächster" */
  validateSearch: z.object({ n: z.coerce.number().int().optional() }),
  component: function NewExpense() {
    const { n } = newRoute.useSearch();
    const navigate = useNavigate();
    return (
      <ExpenseEditor
        key={n ?? 0}
        onSavedNext={() => void navigate({ to: "/expenses/new", search: { n: Date.now() } })}
      />
    );
  },
});

const detailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/expenses/$id",
  params: {
    parse: (p: { id: string }) => ({ id: Number(p.id) }),
    stringify: (p: { id: number }) => ({ id: String(p.id) }),
  },
  loader: ({ context, params }) => context.queryClient.ensureQueryData(expenseQuery(params.id)),
  component: function Expense() {
    const { id } = detailRoute.useParams();
    const { data } = useSuspenseQuery(expenseQuery(id));
    const navigate = useNavigate();
    return (
      <ExpenseEditor
        key={id}
        expense={data}
        onSavedNext={() => void navigate({ to: "/expenses/new", search: { n: Date.now() } })}
      />
    );
  },
});

export const expensesRoutes = [listRoute, newRoute, detailRoute] as const;
