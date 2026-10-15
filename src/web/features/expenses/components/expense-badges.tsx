import { todayIso } from "@shared/dates";
import { cn } from "@/lib/utils";

const BADGE = "inline-flex h-5 items-center rounded-full border px-2 text-xs font-medium whitespace-nowrap";

export function IncompleteBadge({ className }: { className?: string }) {
  return (
    <span className={cn(BADGE, "border-dashed border-warning-border bg-warning-muted text-warning", className)}>
      Unvollständig
    </span>
  );
}

/** Status badges for the editor title: unvollständig, bezahlt / offen / überfällig. */
export function ExpenseBadges({
  expense,
}: {
  expense: { incomplete: boolean; paidAt: string | null; dueDate: string | null };
}) {
  const overdue = !expense.paidAt && !!expense.dueDate && expense.dueDate < todayIso();
  return (
    <span className="flex items-center gap-1.5">
      {expense.incomplete && <IncompleteBadge />}
      {expense.paidAt ? (
        <span className={cn(BADGE, "border-success-border bg-success-muted text-success")}>Bezahlt</span>
      ) : overdue ? (
        <span className={cn(BADGE, "border-danger-border bg-danger-muted text-danger")}>Überfällig</span>
      ) : (
        <span className={cn(BADGE, "border-border text-muted-foreground")}>Offen</span>
      )}
    </span>
  );
}
