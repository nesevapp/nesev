import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { expenseFromFixedCost } from "@shared/recurring-expenses";
import { expenseListQuerySchema } from "@shared/schemas/expense";
import { z } from "@shared/schemas/zod";
import { rootRoute } from "@/app/root-route";
import { expenseQuery, recurringExpensesQuery } from "@/sdk";
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
  /** `n` only forces a fresh form after "Speichern & nächster"; `fixedCost` + `slot` prefill from a scheduled
   *  Fixkosten payment and link the saved expense to it ("Ausgabe erfassen" on the Fixkosten page) */
  validateSearch: z.object({
    n: z.coerce.number().int().optional(),
    fixedCost: z.coerce.number().int().positive().optional(),
    slot: z.iso.date().optional(),
  }),
  component: function NewExpense() {
    const { n, fixedCost, slot } = newRoute.useSearch();
    const navigate = useNavigate();
    const fixed = useQuery({ ...recurringExpensesQuery, enabled: !!fixedCost && !!slot });
    const source = fixedCost && slot ? fixed.data?.find((r) => r.id === fixedCost) : undefined;
    if (fixedCost && slot && fixed.isPending) return null;
    return (
      <ExpenseEditor
        key={`${n ?? 0}-${source?.id ?? ""}-${slot ?? ""}`}
        initialValues={source && slot ? expenseFromFixedCost(source, slot) : undefined}
        linkTo={source && slot ? { recurringExpenseId: source.id, scheduledDate: slot, name: source.name } : undefined}
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
