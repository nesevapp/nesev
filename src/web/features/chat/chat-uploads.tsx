import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, CircleAlert, FileText, Loader2, Paperclip, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  apiErrorMessage,
  type ChatUpload,
  type ChatUploads,
  expenseQuery,
  fileUrl,
  type ReceiptAnalysis,
  receiptAnalysisQuery,
  useAnalyzeReceipts,
} from "@/sdk";
import { useOpenPath } from "./chat-actions";

// Receipts uploaded in the chat (paperclip / drop on the panel): one card per upload message, one row per receipt
// with a thumbnail, the draft's number, a link to the expense and "Erkennung starten" (queues the analysis like the
// editor's button; never automatic). The status follows the analysis query, which polls while it is queued/running.

const IMAGE = /\.(jpe?g|png|webp)$/i;

export function UploadsCard({ uploads }: { uploads: ChatUploads }) {
  const n = uploads.uploads.length;
  return (
    <div className="ml-auto max-w-[92%] overflow-hidden rounded-lg border bg-card text-xs">
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5 font-medium">
        <Paperclip className="size-3.5 text-muted-foreground" />
        {n === 1 ? "Beleg hochgeladen" : `${n} Belege hochgeladen`}
        <span className="font-normal text-muted-foreground">· als Ausgaben-Entwurf</span>
      </div>
      <ul className="divide-y border-t">
        {uploads.uploads.map((u) => (
          <UploadRow key={u.expenseId} upload={u} />
        ))}
      </ul>
      {uploads.failures.length > 0 && (
        <div className="flex items-start gap-1.5 border-t border-warning-border bg-warning-muted px-3 py-2 text-warning">
          <CircleAlert className="mt-px size-3.5 shrink-0" />
          <span>{uploads.failures.join(" · ")}</span>
        </div>
      )}
    </div>
  );
}

function UploadRow({ upload }: { upload: ChatUpload }) {
  const open = useOpenPath();
  const expense = useQuery({ ...expenseQuery(upload.expenseId), retry: false });
  const gone = expense.isError;
  const analysis = useQuery({ ...receiptAnalysisQuery(upload.expenseId), enabled: !gone });
  const analyze = useAnalyzeReceipts();
  const e = expense.data;
  const path = e?.attachmentPath ?? upload.attachmentPath;
  const number = e?.number ?? upload.number;
  const a = analysis.data ?? null;
  const active = a?.status === "queued" || a?.status === "running";
  const suggestions = !!a && !a.stale && !active && !!a.result && (a.status === "done" || a.status === "failed");

  const start = () =>
    analyze.mutate([upload.expenseId], {
      onSuccess: (r) => {
        if (r.skipped.length) toast.info(`Nicht erkannt: ${r.skipped[0]!.reason}`);
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    });

  return (
    <li className="flex items-start gap-2.5 px-3 py-2">
      <button
        type="button"
        disabled={gone}
        onClick={() => open(`/expenses/${upload.expenseId}`)}
        className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/50"
        aria-label={`${upload.fileName} öffnen`}
      >
        {path && IMAGE.test(path) && !gone ? (
          <img src={fileUrl(path)} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <FileText className="size-5 text-muted-foreground" strokeWidth={1.5} />
        )}
      </button>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="truncate font-medium text-foreground" title={upload.fileName}>
          {upload.fileName}
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
          {gone ? (
            <span>Ausgabe gelöscht</span>
          ) : (
            <>
              <span className="tabular">{number ?? `Ausgabe ${upload.expenseId}`}</span>
              <span>·</span>
              <span className={cn(e && !e.incomplete && "text-success")}>{!e || e.incomplete ? "Entwurf" : "erfasst"}</span>
              {e && !e.incomplete && e.supplierName && <span className="truncate">· {e.supplierName}</span>}
            </>
          )}
        </div>
        {!gone && <AnalysisLine analysis={a} loading={analysis.isPending} />}
        {!gone && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            <Button variant="outline" size="xs" onClick={() => open(`/expenses/${upload.expenseId}`)}>
              Ausgabe öffnen
              <ArrowUpRight />
            </Button>
            {suggestions ? (
              <Button variant="outline" size="xs" onClick={() => open(`/expenses/${upload.expenseId}`)}>
                <Sparkles />
                Vorschläge ansehen
              </Button>
            ) : null}
            {!active && !(a?.status === "done" && !a.stale) && (
              <Button variant={a ? "ghost" : "secondary"} size="xs" disabled={analyze.isPending || analysis.isPending} onClick={start}>
                {analyze.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {a && !a.stale && a.status !== "cancelled" ? "Erneut starten" : "Erkennung starten"}
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function AnalysisLine({ analysis, loading }: { analysis: ReceiptAnalysis | null; loading: boolean }) {
  if (loading) return null;
  const spin = <Loader2 className="size-3 animate-spin" />;
  if (!analysis) return <p className="text-muted-foreground">Noch nicht erkannt</p>;
  if (analysis.stale) return <p className="text-muted-foreground">Beleg ersetzt – Erkennung neu starten</p>;
  switch (analysis.status) {
    case "queued":
      return <p className="flex items-center gap-1 text-muted-foreground">{spin} Erkennung in der Warteschlange …</p>;
    case "running":
      return <p className="flex items-center gap-1 text-muted-foreground">{spin} Erkennung läuft …</p>;
    case "done":
      return <p className="text-success">{analysis.appliedAt ? "Erkannt, Vorschläge übernommen" : "Erkannt – Vorschläge bereit"}</p>;
    case "failed":
      return (
        <p className="text-warning" title={analysis.error || undefined}>
          Erkennung fehlgeschlagen{analysis.result ? " – nur Regel-Vorschläge" : ""}
          {analysis.error ? `: ${analysis.error.length > 90 ? `${analysis.error.slice(0, 89)}…` : analysis.error}` : ""}
        </p>
      );
    case "cancelled":
      return <p className="text-muted-foreground">Erkennung abgebrochen</p>;
    default:
      return null;
  }
}
