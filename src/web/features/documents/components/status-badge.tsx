import { DOCUMENT_STATUS_LABELS, type DocumentStatus, OVERDUE_LABEL } from "@shared/documents";
import { cn } from "@/lib/utils";

const TONES: Record<DocumentStatus | "overdue", string> = {
  draft: "border-dashed border-border text-muted-foreground",
  final: "border-border bg-secondary text-secondary-foreground",
  sent: "border-info-border bg-info-muted text-info",
  accepted: "border-success-border bg-success-muted text-success",
  paid: "border-success-border bg-success-muted text-success",
  declined: "border-border bg-muted text-muted-foreground line-through decoration-muted-foreground/60",
  overdue: "border-danger-border bg-danger-muted text-danger",
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
  return <span className={cn("text-xs whitespace-nowrap text-warning", className)}>teilbezahlt</span>;
}
