import { REMINDER_STATUS_LABELS, type ReminderStatus, SETTLED_LABEL } from "@shared/reminders";
import { cn } from "@/lib/utils";

const TONES: Record<ReminderStatus | "settled", string> = {
  draft: "border-dashed border-border text-muted-foreground",
  final: "border-border bg-secondary text-secondary-foreground",
  sent: "border-sky-200 bg-sky-50 text-sky-700",
  settled: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

const pill = "inline-flex h-5 items-center rounded-full border px-2 text-xs font-medium whitespace-nowrap";

/** Reminder status; "Erledigt" once the invoice is paid (drafts keep showing "Entwurf"). */
export function ReminderStatusBadge({ status, settled, className }: { status: ReminderStatus; settled?: boolean; className?: string }) {
  const key = settled && status !== "draft" ? "settled" : status;
  return <span className={cn(pill, TONES[key], className)}>{key === "settled" ? SETTLED_LABEL : REMINDER_STATUS_LABELS[status]}</span>;
}

/** "Stufe 2" with escalating tone. */
export function LevelBadge({ level, title, className }: { level: number; title?: string; className?: string }) {
  const tone =
    level >= 3 ? "border-red-200 bg-red-50 text-red-700" : level === 2 ? "border-amber-200 bg-amber-50 text-amber-800" : "border-border";
  return (
    <span className={cn(pill, tone, className)} title={title}>
      Stufe {level}
    </span>
  );
}
