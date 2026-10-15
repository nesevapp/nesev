import { REMINDER_STATUS_LABELS, type ReminderStatus, SETTLED_LABEL } from "@shared/reminders";
import { cn } from "@/lib/utils";

const TONES: Record<ReminderStatus | "settled", string> = {
  draft: "border-dashed border-border text-muted-foreground",
  final: "border-border bg-secondary text-secondary-foreground",
  sent: "border-info-border bg-info-muted text-info",
  settled: "border-success-border bg-success-muted text-success",
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
    level >= 3 ? "border-danger-border bg-danger-muted text-danger" : level === 2 ? "border-warning-border bg-warning-muted text-warning" : "border-border";
  return (
    <span className={cn(pill, tone, className)} title={title}>
      Stufe {level}
    </span>
  );
}
