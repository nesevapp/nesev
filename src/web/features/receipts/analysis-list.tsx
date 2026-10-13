import { createContext, useContext, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import {
  ANALYSIS_LIST_STATUS_LABELS,
  type AnalysisListStatus,
  analysisListStatus,
  type AnalysisQueueItem,
} from "@shared/receipts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { apiErrorMessage, receiptQueueQuery, useAnalyzeReceipts, useCancelAnalysis } from "@/sdk";

// Receipt analysis on the expenses list: status column, row selection, bulk actions, progress.

interface Row {
  id: number;
  attachmentPath: string | null;
  supplierName: string;
  attachmentName: string;
}

export interface ReceiptListState {
  items: Map<number, AnalysisQueueItem>;
  statusOf: (expenseId: number) => AnalysisListStatus;
  selected: Set<number>;
  toggle: (expenseId: number, on: boolean) => void;
  clearSelection: () => void;
  /** filter "Vorschläge bereit" */
  readyOnly: boolean;
  setReadyOnly: (v: boolean) => void;
  filter: <T extends Row>(rows: T[]) => T[];
  queued: number;
  running: number;
}

const Ctx = createContext<ReceiptListState | null>(null);

/** Container (e.g. the table wrapper) that provides the state to SelectCell / AnalysisStatusCell. */
export function ReceiptListScope({ value, className, children }: { value: ReceiptListState; className?: string; children: React.ReactNode }) {
  return (
    <Ctx.Provider value={value}>
      <div className={className}>{children}</div>
    </Ctx.Provider>
  );
}

function useListState(): ReceiptListState {
  const v = useContext(Ctx);
  if (!v) throw new Error("ReceiptListProvider missing");
  return v;
}

export function useReceiptListState(): ReceiptListState {
  const { data } = useQuery(receiptQueueQuery);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [readyOnly, setReadyOnly] = useState(false);
  const items = useMemo(() => new Map((data?.items ?? []).map((i) => [i.expenseId, i])), [data]);
  const statusOf = (id: number) => analysisListStatus(items.get(id));
  return {
    items,
    statusOf,
    selected,
    toggle: (id, on) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      }),
    clearSelection: () => setSelected(new Set()),
    readyOnly,
    setReadyOnly,
    filter: (rows) => (readyOnly ? rows.filter((r) => statusOf(r.id) === "ready") : rows),
    queued: data?.queued ?? 0,
    running: data?.running ?? 0,
  };
}

export function SelectCell({ expense }: { expense: Row }) {
  const s = useListState();
  if (!expense.attachmentPath) return null;
  return (
    <Checkbox
      checked={s.selected.has(expense.id)}
      onCheckedChange={(v) => s.toggle(expense.id, v === true)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      aria-label="Für Analyse auswählen"
    />
  );
}

const STYLES: Record<AnalysisListStatus, string> = {
  none: "border-transparent text-muted-foreground/70",
  queued: "border-border text-muted-foreground",
  running: "border-sky-200 bg-sky-50 text-sky-700",
  ready: "border-violet-200 bg-violet-50 text-violet-700",
  applied: "border-transparent text-muted-foreground",
  failed: "border-red-200 bg-red-50 text-red-700",
  cancelled: "border-transparent text-muted-foreground",
};

export function AnalysisStatusCell({ expense }: { expense: Row }) {
  const s = useListState();
  if (!expense.attachmentPath) return null;
  const status = s.statusOf(expense.id);
  const item = s.items.get(expense.id);
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full border px-2 text-xs whitespace-nowrap",
        STYLES[status],
      )}
      title={status === "failed" ? item?.error : undefined}
    >
      {(status === "running" || status === "queued") && <Loader2 className={cn("size-3", status === "running" && "animate-spin")} />}
      {status === "ready" && <Sparkles className="size-3" />}
      {status === "failed" && item?.hasResult ? "teilweise erkannt" : ANALYSIS_LIST_STATUS_LABELS[status]}
    </span>
  );
}

/** Bulk actions, "Vorschläge bereit" filter and queue progress above the expenses table. */
export function AnalysisToolbar({ state, rows }: { state: ReceiptListState; rows: Row[] }) {
  const analyze = useAnalyzeReceipts();
  const cancel = useCancelAnalysis();
  const unanalysed = rows.filter((r) => r.attachmentPath && ["none", "cancelled"].includes(state.statusOf(r.id)));
  const readyCount = rows.filter((r) => state.statusOf(r.id) === "ready").length;
  const selected = rows.filter((r) => state.selected.has(r.id));

  const run = (ids: number[]) =>
    analyze.mutate(ids, {
      onSuccess: (r) => {
        state.clearSelection();
        if (r.queued.length) toast.success(r.queued.length === 1 ? "1 Beleg in Warteschlange" : `${r.queued.length} Belege in Warteschlange`);
        else toast.info("Nichts zu analysieren", { description: r.skipped[0]?.reason });
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    });

  // progress of the current batch: everything queued since the oldest active run
  const all = [...state.items.values()];
  const active = all.filter((i) => i.status === "queued" || i.status === "running");
  const since = active.reduce((min, i) => (i.createdAt < min ? i.createdAt : min), active[0]?.createdAt ?? "");
  const batch = active.length ? all.filter((i) => i.createdAt >= since) : [];
  const finished = batch.length - active.length;
  const current = active.find((i) => i.status === "running");
  const currentRow = current && rows.find((r) => r.id === current.expenseId);

  const cancelAll = () => {
    for (const i of active) cancel.mutate(i.analysisId, { onError: (err) => toast.error(apiErrorMessage(err)) });
  };

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
      {selected.length > 0 ? (
        <>
          <span className="text-muted-foreground">{selected.length} ausgewählt</span>
          <Button size="sm" variant="outline" disabled={analyze.isPending} onClick={() => run(selected.map((r) => r.id))}>
            <Sparkles />
            Auswahl analysieren
          </Button>
          <Button size="sm" variant="ghost" onClick={state.clearSelection}>
            Auswahl aufheben
          </Button>
        </>
      ) : (
        unanalysed.length > 0 && (
          <Button size="sm" variant="outline" disabled={analyze.isPending} onClick={() => run(unanalysed.map((r) => r.id))}>
            {analyze.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
            Alle unanalysierten analysieren ({unanalysed.length})
          </Button>
        )
      )}
      {(readyCount > 0 || state.readyOnly) && (
        <Button
          size="sm"
          variant={state.readyOnly ? "secondary" : "ghost"}
          onClick={() => state.setReadyOnly(!state.readyOnly)}
          aria-pressed={state.readyOnly}
        >
          {state.readyOnly && <X />}
          Vorschläge bereit ({readyCount})
        </Button>
      )}

      {active.length > 0 && (
        <div className="ml-auto flex min-w-64 items-center gap-3 rounded-md border px-3 py-1">
          <Loader2 className="size-4 shrink-0 animate-spin text-sky-600" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate">
                Belegerkennung {finished + (current ? 1 : 0)} von {batch.length}
                {currentRow && (
                  <span className="text-muted-foreground"> · {currentRow.supplierName || currentRow.attachmentName || "Beleg"}</span>
                )}
              </span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-sky-500 transition-[width]"
                style={{ width: `${batch.length ? Math.round((finished / batch.length) * 100) : 0}%` }}
              />
            </div>
          </div>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={cancelAll} disabled={cancel.isPending}>
            Abbrechen
          </Button>
        </div>
      )}
    </div>
  );
}

