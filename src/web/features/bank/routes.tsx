import { createRoute } from "@tanstack/react-router";
import { BANK_TX_STATUSES } from "@shared/bank";
import { z } from "@shared/schemas/zod";
import { rootRoute } from "@/app/root-route";
import { bankAccountsQuery } from "@/sdk";
import { BankPage } from "./bank-page";
import { PERIODS } from "./format";

const bankSearch = z.object({
  account: z.coerce.number().int().positive().optional(),
  status: z.enum([...BANK_TX_STATUSES, "all"]).optional(),
  dir: z.enum(["in", "out"]).optional(),
  q: z.string().optional(),
  period: z.enum(PERIODS).optional(),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bank",
  validateSearch: bankSearch,
  loader: ({ context }) => context.queryClient.ensureQueryData(bankAccountsQuery),
  component: function Bank() {
    const search = indexRoute.useSearch();
    const navigate = indexRoute.useNavigate();
    return (
      <BankPage
        search={search}
        setSearch={(patch) => void navigate({ search: (s) => ({ ...s, ...patch }), replace: true })}
      />
    );
  },
});

export const bankRoutes = [indexRoute] as const;
