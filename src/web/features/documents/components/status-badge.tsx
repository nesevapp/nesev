import { DOCUMENT_STATUS_LABELS, type DocumentStatus, OVERDUE_LABEL } from "@shared/documents";
import { cn } from "@/lib/utils";

const TONES: Record<DocumentStatus | "overdue", string> = {
  draft: "border-dashed border-border text-muted-foreground",
  final: "border-border bg-secondary text-secondary-foreground",
  sent: "border-sky-200 bg-sky-50 text-sky-700",
  accepted: "border-emerald-200 bg-emerald-50 text-emerald-700",
  paid: "border-emerald-200 bg-emerald-50 text-emerald-700",
  declined: "border-zinc-200 bg-zinc-100 text-zinc-500 line-through decoration-zinc-400/60",
  overdue: "border-red-200 bg-red-50 text-red-700",
};

export function StatusBadge({
  status,
  overdue,
  className,
}: {
  status: DocumentStatus;
  overdue?: boolean;
  className?: string;
}) {
  const key = overdue ? "overdue" : status;
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-2 text-xs font-medium whitespace-nowrap",
        TONES[key],
        className,
      )}
    >
      {overdue ? OVERDUE_LABEL : DOCUMENT_STATUS_LABELS[status]}
    </span>
  );
}

/** Subtle hint next to the status badge: bank payments cover part of the invoice. */
export function PartialLabel({ className }: { className?: string }) {
  return <span className={cn("text-xs whitespace-nowrap text-amber-700", className)}>teilbezahlt</span>;
}
