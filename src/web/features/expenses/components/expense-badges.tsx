import { todayIso } from "@shared/dates";
import { cn } from "@/lib/utils";

const BADGE = "inline-flex h-5 items-center rounded-full border px-2 text-xs font-medium whitespace-nowrap";

export function IncompleteBadge({ className }: { className?: string }) {
  return (
    <span className={cn(BADGE, "border-dashed border-amber-300 bg-amber-50 text-amber-700", className)}>
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
        <span className={cn(BADGE, "border-emerald-200 bg-emerald-50 text-emerald-700")}>Bezahlt</span>
      ) : overdue ? (
        <span className={cn(BADGE, "border-red-200 bg-red-50 text-red-700")}>Überfällig</span>
      ) : (
        <span className={cn(BADGE, "border-border text-muted-foreground")}>Offen</span>
      )}
    </span>
  );
}
