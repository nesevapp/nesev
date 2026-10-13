import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { BellRing } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@shared/dates";
import { formatCents } from "@shared/money";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { remindersQuery, useCreateReminder } from "../api";
import { LevelBadge, ReminderStatusBadge } from "./reminder-status-badge";

/** Create the next reminder for an invoice (or reopen its existing draft) and open it. */
export function useRemindAndOpen() {
  const create = useCreateReminder();
  const navigate = useNavigate();
  return {
    isPending: create.isPending,
    pendingId: create.isPending ? create.variables?.invoiceId : undefined,
    run: (invoiceId: number) =>
      create.mutate(
        { invoiceId, reuseDraft: true },
        {
          onSuccess: (r) => {
            toast.success(`Mahnungsentwurf: ${r.title || `Stufe ${r.level}`}`);
            void navigate({ to: "/reminders/$id", params: { id: r.id } });
          },
          onError: (err) => toast.error(apiErrorMessage(err)),
        },
      ),
  };
}

/** "Mahnung erstellen" for overdue invoices (document view action bar). Renders nothing otherwise. */
export function CreateReminderButton({ invoice, disabled }: { invoice: { id: number; type: string; overdue: boolean }; disabled?: boolean }) {
  const remind = useRemindAndOpen();
  if (invoice.type !== "invoice" || !invoice.overdue) return null;
  return (
    <Button variant="ghost" size="sm" disabled={disabled || remind.isPending} onClick={() => remind.run(invoice.id)}>
      <BellRing />
      Mahnung erstellen
    </Button>
  );
}

/** Compact "Mahnen" quick action (dashboard overdue list). */
export function RemindButton({ invoiceId, className }: { invoiceId: number; className?: string }) {
  const remind = useRemindAndOpen();
  return (
    <Button
      size="sm"
      variant="outline"
      className={cn("h-7 text-xs", className)}
      disabled={remind.isPending}
      onClick={(e) => {
        e.stopPropagation();
        remind.run(invoiceId);
      }}
    >
      <BellRing />
      Mahnen
    </Button>
  );
}

/** Reminders of an invoice (document view). Hidden while there are none. */
export function InvoiceReminders({ invoiceId }: { invoiceId: number }) {
  const { data = [] } = useQuery(remindersQuery({ invoiceId }));
  if (data.length === 0) return null;
  return (
    <section className="border-t pt-6">
      <h2 className="mb-3 text-sm font-medium">Mahnungen</h2>
      <ul className="divide-y rounded-lg border text-sm">
        {data.map((r) => (
          <li key={r.id}>
            <Link
              to="/reminders/$id"
              params={{ id: r.id }}
              className="grid grid-cols-[8rem_5rem_1fr_auto_auto] items-center gap-4 px-3 py-2 hover:bg-muted/50"
            >
              <span className={cn("tabular", r.number ? "font-medium" : "text-muted-foreground")}>{r.number ?? "Entwurf"}</span>
              <LevelBadge level={r.level} className="justify-self-start" />
              <span className="truncate text-muted-foreground">
                {r.title} · <span className="tabular">{formatDate(r.issueDate)}</span>, Frist{" "}
                <span className="tabular">{formatDate(r.dueDate)}</span>
              </span>
              <span className="tabular text-right">{formatCents(r.totalCents)}</span>
              <ReminderStatusBadge status={r.status} settled={r.settled} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
