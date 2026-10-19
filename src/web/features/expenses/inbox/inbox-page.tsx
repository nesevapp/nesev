import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, FileText, FolderInput, Image, Inbox, Loader2, RefreshCw, ScanText, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  apiErrorMessage,
  fileUrl,
  inboxItemsQuery,
  inboxStatusQuery,
  type InboxItem,
  useAnalyzeReceipts,
  useConvertInboxItems,
  useDismissInboxItems,
  useScanInbox,
  useUploadToInbox,
} from "@/sdk";
import { cn } from "@/lib/utils";
import { DropOverlay, useWindowFileDrag } from "../components/file-drop";
import { formatBytes, formatTimestamp, INBOX_ACCEPT_LABEL, pickInboxFiles, splitInboxFiles } from "./inbox-files";

const EMPTY: InboxItem[] = [];
const isPdf = (path: string) => path.toLowerCase().endsWith(".pdf");

/** /expenses/inbox: receipts from the inbox folder or dropped here, waiting to become expenses. */
export function InboxPage() {
  const navigate = useNavigate();
  const { data: items = EMPTY, isPending } = useQuery(inboxItemsQuery());
  const { data: status } = useQuery(inboxStatusQuery);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [activeId, setActiveId] = useState<number | null>(null);
  const dragging = useWindowFileDrag();

  const upload = useUploadToInbox();
  const scan = useScanInbox();
  const convert = useConvertInboxItems();
  const dismiss = useDismissInboxItems();
  const analyze = useAnalyzeReceipts();
  const busy = convert.isPending || dismiss.isPending || analyze.isPending;

  // keep selection/preview in sync with the (polled) list
  useEffect(() => {
    const ids = new Set(items.map((i) => i.id));
    setSelected((s) => {
      const next = new Set([...s].filter((id) => ids.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [items]);

  // the clicked item, else the first (an id that isn't listed yet, e.g. right after an upload, wins once it is)
  const active = items.find((i) => i.id === activeId) ?? items[0] ?? null;
  const allSelected = items.length > 0 && selected.size === items.length;
  const targets = useMemo(() => (selected.size ? [...selected] : active ? [active.id] : []), [selected, active]);

  const onFiles = (files: File[]) => {
    const { accepted, rejected } = splitInboxFiles(files);
    if (rejected.length) toast.error(`Nicht unterstützt: ${rejected.join(", ")}`);
    if (!accepted.length) return;
    upload.mutate(accepted, {
      onSuccess: ({ added, duplicates }) => {
        if (added.length) toast.success(added.length === 1 ? "1 Beleg im Eingang" : `${added.length} Belege im Eingang`);
        for (const d of duplicates) toast.info(`${d.name}: ${d.reason}`);
        if (added[0]) setActiveId(added[0].id);
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    });
  };

  const onConvert = (ids: number[], withAnalysis: boolean) => {
    convert.mutate(ids, {
      onSuccess: (created) => {
        setSelected(new Set());
        const go = () => created[0] && void navigate({ to: "/expenses/$id", params: { id: created[0].id } });
        const done = () => {
          if (created.length === 1) return go();
          toast.success(`${created.length} Ausgaben angelegt`, {
            description: withAnalysis ? "Belege werden analysiert." : "Als unvollständige Ausgaben gespeichert.",
            action: { label: "Anzeigen", onClick: () => void navigate({ to: "/expenses", search: { status: "incomplete" } }) },
          });
        };
        if (!withAnalysis) return done();
        analyze.mutate(
          created.map((e) => e.id),
          { onSuccess: done, onError: (err) => (toast.error(`Analyse nicht gestartet: ${apiErrorMessage(err)}`), done()) },
        );
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    });
  };

  const onDismiss = (ids: number[]) => {
    dismiss.mutate(ids, {
      onSuccess: ({ dismissed }) => {
        setSelected(new Set());
        toast.success(dismissed === 1 ? "Beleg verworfen" : `${dismissed} Belege verworfen`);
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    });
  };

  const onScan = () =>
    scan.mutate(undefined, {
      onSuccess: ({ result }) => {
        if (result.error) toast.error(result.error);
        else if (result.imported) toast.success(result.imported === 1 ? "1 neuer Beleg" : `${result.imported} neue Belege`);
        else if (result.pending) toast.info("Dateien werden noch geschrieben – gleich nochmal prüfen.");
        else toast.info("Keine neuen Belege im Ordner");
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    });

  const n = targets.length;
  return (
    <Page
      title="Belege-Eingang"
      description="Belege aus dem Eingangsordner oder hier abgelegt. Daraus werden Ausgaben – analysiert wird nur, wenn Sie es auswählen."
      actions={
        <>
          {status?.path && (
            <Button variant="outline" size="sm" disabled={scan.isPending} onClick={onScan}>
              {scan.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Jetzt prüfen
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={upload.isPending} onClick={() => pickInboxFiles(onFiles)}>
            {upload.isPending ? <Loader2 className="animate-spin" /> : <Upload />}
            Dateien hinzufügen
          </Button>
        </>
      }
    >
      <DropOverlay
        active={dragging}
        onFiles={onFiles}
        label="Belege ablegen – sie landen im Eingang"
        className="fixed inset-4 z-50 text-base"
      />

      <FolderStatus />

      {isPending ? null : items.length === 0 ? (
        <button
          type="button"
          onClick={() => pickInboxFiles(onFiles)}
          className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-16 text-center text-sm text-muted-foreground transition-colors hover:border-muted-foreground/50"
        >
          <Inbox className="size-6 opacity-60" strokeWidth={1.5} />
          <span className="font-medium text-foreground">Keine neuen Belege</span>
          <span>Dateien hier ablegen oder klicken ({INBOX_ACCEPT_LABEL}).</span>
        </button>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_1fr]">
          <div className="min-w-0">
            <div className="mb-2 flex h-8 items-center gap-2 px-1 text-sm">
              <Checkbox
                aria-label="Alle auswählen"
                checked={allSelected ? true : selected.size ? "indeterminate" : false}
                onCheckedChange={(v) => setSelected(v === true ? new Set(items.map((i) => i.id)) : new Set())}
              />
              <span className="text-muted-foreground">
                {selected.size ? `${selected.size} ausgewählt` : `${items.length} ${items.length === 1 ? "Beleg" : "Belege"}`}
              </span>
            </div>
            <ul className="divide-y rounded-lg border">
              {items.map((item) => (
                <li
                  key={item.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm transition-colors hover:bg-muted/40",
                    item.id === active?.id && "bg-muted/60",
                  )}
                  onClick={() => setActiveId(item.id)}
                >
                  <Checkbox
                    aria-label={`${item.fileName} auswählen`}
                    checked={selected.has(item.id)}
                    onClick={(e) => e.stopPropagation()}
                    onCheckedChange={(v) =>
                      setSelected((s) => {
                        const next = new Set(s);
                        if (v === true) next.add(item.id);
                        else next.delete(item.id);
                        return next;
                      })
                    }
                  />
                  {item.storedPath && isPdf(item.storedPath) ? (
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <Image className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium" title={item.fileName}>
                      {item.fileName}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatTimestamp(item.createdAt)} · {formatBytes(item.sizeBytes)} ·{" "}
                      {item.sourcePath ? "aus Ordner" : "hochgeladen"}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={!n || busy} onClick={() => onConvert(targets, false)}>
                {convert.isPending && !analyze.isPending ? <Loader2 className="animate-spin" /> : <FolderInput />}
                {n > 1 ? `${n} als Ausgaben anlegen` : "Als Ausgabe anlegen"}
              </Button>
              <Button size="sm" variant="outline" disabled={!n || busy} onClick={() => onConvert(targets, true)}>
                {analyze.isPending ? <Loader2 className="animate-spin" /> : <ScanText />}
                Anlegen + analysieren
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto text-muted-foreground hover:text-destructive"
                disabled={!n || busy}
                onClick={() => onDismiss(targets)}
              >
                <Trash2 />
                {n > 1 ? `${n} verwerfen` : "Verwerfen"}
              </Button>
            </div>
            {active?.storedPath && <Preview item={active} path={active.storedPath} />}
          </div>
        </div>
      )}
    </Page>
  );
}

function Preview({ item, path }: { item: InboxItem; path: string }) {
  const url = fileUrl(path);
  return (
    <div className="h-[calc(100dvh-14rem)] min-h-[28rem] overflow-auto rounded-lg border bg-muted/30">
      {isPdf(path) ? (
        <iframe key={item.id} src={url} title={item.fileName} className="size-full bg-white" />
      ) : (
        <div className="p-4">
          <img src={url} alt={item.fileName} className="mx-auto max-w-full rounded shadow-sm" />
        </div>
      )}
    </div>
  );
}

/** Folder line: where files come from, last scan, error, files left in the folder. */
function FolderStatus() {
  const { data: status } = useQuery(inboxStatusQuery);
  if (!status) return null;
  if (!status.path) {
    return (
      <p className="mb-4 text-sm text-muted-foreground">
        Kein Eingangsordner eingestellt.{" "}
        <Link to="/settings" search={{ tab: "belegerkennung" }} className="underline underline-offset-2">
          Ordner festlegen
        </Link>
        , dann werden Belege daraus automatisch übernommen.
      </p>
    );
  }
  return (
    <div className="mb-4 space-y-2">
      <p className="text-sm text-muted-foreground">
        Ordner <span className="font-mono text-xs text-foreground">{status.path}</span>
        {status.lastScanAt && <> · zuletzt geprüft {formatTimestamp(status.lastScanAt)}</>} · übernommene Dateien
        liegen danach in „Importiert“.
      </p>
      {status.error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" />
          {status.error}
        </div>
      )}
      {status.skipped.length > 0 && (
        <div className="rounded-lg border border-warning-border bg-warning-muted px-3 py-2 text-sm text-warning">
          Nicht übernommen:{" "}
          {status.skipped.map((s, i) => (
            <span key={s.name}>
              {i > 0 && ", "}
              {s.name} ({s.reason})
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
