import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpCircle, ExternalLink, ShieldAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { type UpdateStatus, updateStatusQuery } from "@/sdk";

const DISMISS_KEY = "nesev.update-dismissed";

/** The command that updates this install (release binary or source checkout). */
export function updateCommand(install: UpdateStatus["install"]): string {
  return install === "binary" ? "nesev update" : "git pull && bun install && bun run build";
}

function dismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/** Sidebar card when a newer release is out; hidden per version once closed (security updates come back daily). */
export function UpdateHint() {
  const { data } = useQuery(updateStatusQuery);
  const [dismissed, setDismissed] = useState(dismissedVersion);
  if (!data?.newer || !data.latest) return null;
  if (dismissed === data.latest && !data.security) return null;

  const close = () => {
    try {
      localStorage.setItem(DISMISS_KEY, data.latest!);
    } catch {
      // storage unavailable: it comes back on the next load
    }
    setDismissed(data.latest);
  };
  const Icon = data.security ? ShieldAlert : ArrowUpCircle;

  return (
    <div
      role="status"
      className={cn(
        "relative mx-3 mb-3 flex shrink-0 flex-col gap-1.5 rounded-lg border p-3 text-xs",
        data.security ? "border-warning-border bg-warning-muted text-warning" : "bg-background",
      )}
    >
      <button
        type="button"
        onClick={close}
        aria-label="Hinweis schließen"
        className="absolute top-2 right-2 rounded p-0.5 opacity-60 hover:opacity-100"
      >
        <X className="size-3.5" />
      </button>
      <span className="flex items-center gap-1.5 pr-5 font-medium">
        <Icon className="size-4 shrink-0" strokeWidth={1.75} />
        {data.security ? "Sicherheitsupdate" : "Update"}: nesev {data.latest}
      </span>
      <span className={cn(!data.security && "text-muted-foreground")}>
        Du hast {data.current}. Im Terminal: <code className="font-mono">{updateCommand(data.install)}</code>
      </span>
      {data.url && (
        <a href={data.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
          Was ist neu <ExternalLink className="size-3" />
        </a>
      )}
    </div>
  );
}
