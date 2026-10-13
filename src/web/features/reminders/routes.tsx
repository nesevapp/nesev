import { createRoute } from "@tanstack/react-router";
import { z } from "@shared/schemas/zod";
import { REMINDER_STATUSES } from "@shared/reminders";
import { rootRoute } from "@/app/root-route";
import { reminderQuery, reminderSettingsQuery } from "./api";
import { ReminderPage } from "./reminder-page";
import { RemindersPage } from "./reminders-page";

const listSearch = z.object({
  tab: z.enum(["due", "all"]).optional(),
  status: z.enum(REMINDER_STATUSES).optional(),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reminders",
  validateSearch: listSearch,
  component: function Reminders() {
    const search = indexRoute.useSearch();
    const navigate = indexRoute.useNavigate();
    return <RemindersPage search={search} setSearch={(update) => void navigate({ search: update, replace: true })} />;
  },
});

const detailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reminders/$id",
  params: { parse: (p: { id: string }) => ({ id: Number(p.id) }), stringify: (p: { id: number }) => ({ id: String(p.id) }) },
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(reminderQuery(params.id)),
      context.queryClient.ensureQueryData(reminderSettingsQuery),
    ]),
  component: function Reminder() {
    return <ReminderPage id={detailRoute.useParams().id} />;
  },
});

export const remindersRoutes = [indexRoute, detailRoute] as const;
