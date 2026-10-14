import { CircleAlert, CircleCheck, CircleDashed } from "lucide-react";
import { cn } from "@/lib/utils";

export function StatusRow({
  state,
  label,
  children,
}: {
  state: "ok" | "warn" | "off";
  label: string;
  children?: React.ReactNode;
}) {
  const Icon = state === "ok" ? CircleCheck : state === "warn" ? CircleAlert : CircleDashed;
  return (
    <div className="flex items-start gap-2 text-sm">
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          state === "ok" ? "text-emerald-600" : state === "warn" ? "text-amber-600" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0">
        <span className="font-medium">{label}</span>
        {children && <span className="text-muted-foreground"> · {children}</span>}
      </div>
    </div>
  );
}

export function formatGb(bytes: number) {
  return `${(bytes / 1e9).toLocaleString("de-AT", { maximumFractionDigits: 1 })} GB`;
}
