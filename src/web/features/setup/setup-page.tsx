import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArchiveRestore, CheckCircle2, FolderOpen, Info, Loader2 } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  apiErrorMessage,
  type DataDirCheck,
  dataDirCheckQuery,
  type SetupStatus,
  useBrowseFolder,
  useCompleteSetup,
  useRestoreSetup,
} from "@/sdk";

type Choice = { kind: "suggestion"; id: string } | { kind: "custom" };

/** First start: where nesev keeps the books (database, PDFs, receipts, backups). */
export function SetupPage({ status }: { status: SetupStatus }) {
  const missing = status.missingDataDir;
  const [choice, setChoice] = useState<Choice>(
    missing ? { kind: "custom" } : { kind: "suggestion", id: status.suggestions[0]?.id ?? "app" },
  );
  const [custom, setCustom] = useState(missing ?? "");
  const [updateCheck, setUpdateCheck] = useState(true);
  const debounced = useDebounced(custom, 300);
  const browse = useBrowseFolder();
  const complete = useCompleteSetup();
  const restore = useRestoreSetup();
  const fileInput = useRef<HTMLInputElement>(null);

  const suggestion = choice.kind === "suggestion" ? status.suggestions.find((s) => s.id === choice.id) : undefined;
  const path = suggestion ? suggestion.path : debounced;
  const check = useQuery(dataDirCheckQuery(path));
  const pending = choice.kind === "custom" && custom !== debounced;
  const ready = !pending && !check.isFetching && check.data?.ok === true;

  const pickFolder = () =>
    browse.mutate(undefined, {
      onSuccess: ({ path: picked }) => {
        if (!picked) return;
        setChoice({ kind: "custom" });
        setCustom(picked);
      },
    });

  const restoreBackup = (file: File) => {
    if (!check.data?.ok) return;
    restore.mutate({ path: check.data.path, file, updateCheck }, { onSuccess: () => window.location.replace("/") });
  };

  const submit = () => {
    if (!check.data?.ok) return;
    complete.mutate({ path: check.data.path, updateCheck }, { onSuccess: () => window.location.replace("/") });
  };

  return (
    <div className="min-h-svh bg-muted/40 px-4 py-10 sm:py-16">
      <div className="mx-auto flex max-w-xl flex-col gap-8">
        <Logo className="h-7 self-start" />
        {missing ? (
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">Datenordner nicht gefunden</h1>
            <p className="text-muted-foreground">
              Im bisherigen Datenordner <code className="break-all text-foreground">{missing}</code> liegen keine
              nesev-Daten (mehr). Wurde er verschoben oder ist das Laufwerk nicht verbunden? Verbinde es und prüfe erneut,
              oder wähle den neuen Ort des Ordners.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">Willkommen bei nesev</h1>
            <p className="text-muted-foreground">
              nesev speichert alles auf diesem Computer: Datenbank, Rechnungs-PDFs, Belege und Backups. Wähle dafür
              einen Ordner. Du findest ihn später unter Einstellungen → Export &amp; Backup.
            </p>
          </div>
        )}

        <div role="radiogroup" aria-label="Datenordner" className="flex flex-col gap-3">
          {status.suggestions.map((s) => (
            <ChoiceCard
              key={s.id}
              selected={choice.kind === "suggestion" && choice.id === s.id}
              onSelect={() => setChoice({ kind: "suggestion", id: s.id })}
              title={s.label}
              description={s.hint}
            >
              <code className="block truncate text-xs text-muted-foreground" title={s.path}>
                {s.path}
              </code>
            </ChoiceCard>
          ))}
          <ChoiceCard
            selected={choice.kind === "custom"}
            onSelect={() => setChoice({ kind: "custom" })}
            title="Anderer Ordner"
            description="Zum Beispiel auf einer externen Festplatte oder in einem bestehenden Ordner mit nesev-Daten."
          >
            {choice.kind === "custom" && (
              <div className="mt-1 flex gap-2" onClick={(e) => e.stopPropagation()}>
                <Input
                  autoFocus
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder={status.platform === "win32" ? "C:\\Users\\Name\\nesev" : "~/nesev"}
                  aria-label="Pfad des Datenordners"
                  className="font-mono text-xs"
                />
                {status.canBrowse && (
                  <Button type="button" variant="outline" onClick={pickFolder} disabled={browse.isPending}>
                    {browse.isPending ? <Loader2 className="animate-spin" /> : <FolderOpen />}
                    Durchsuchen…
                  </Button>
                )}
              </div>
            )}
          </ChoiceCard>
        </div>

        <CheckResult check={pending ? undefined : check.data} loading={pending || check.isFetching} />
        {missing && check.data?.ok && !check.data.hasData && !pending && (
          <Note tone="warning" icon={AlertTriangle}>
            Hier liegen keine nesev-Daten. Fortfahren beginnt mit leeren Daten; deine bisherigen Rechnungen und Belege
            siehst du erst wieder, wenn du den Ordner mit ihnen wählst.
          </Note>
        )}

        {complete.error && <p className="text-sm text-destructive">{apiErrorMessage(complete.error)}</p>}
        {restore.error && <p className="text-sm text-destructive">{apiErrorMessage(restore.error)}</p>}
        {browse.error && <p className="text-sm text-destructive">{apiErrorMessage(browse.error)}</p>}

        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <Checkbox checked={updateCheck} onCheckedChange={(v) => setUpdateCheck(v === true)} className="mt-0.5" />
          <span className="flex flex-col gap-0.5">
            <span>Nach Updates suchen</span>
            <span className="text-muted-foreground">
              Einmal täglich fragt nesev bei GitHub nach der neuesten Version und zeigt dir, wenn es ein Update gibt. Sonst
              wird nichts gesendet. Jederzeit unter Einstellungen → Export &amp; Backup änderbar.
            </span>
          </span>
        </label>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button size="lg" className="sm:flex-1" onClick={submit} disabled={!ready || complete.isPending}>
              {complete.isPending && <Loader2 className="animate-spin" />}
              {check.data?.hasData
                ? "Bestehende Daten öffnen"
                : missing
                  ? "Mit leeren Daten beginnen"
                  : "Ordner verwenden und loslegen"}
            </Button>
            {missing && (
              <Button size="lg" variant="outline" onClick={() => void check.refetch()} disabled={check.isFetching}>
                Erneut prüfen
              </Button>
            )}
          </div>
          {!check.data?.hasData && (
            <div className="flex flex-col items-start gap-1 rounded-lg border border-dashed p-4 text-sm">
              <span className="font-medium">Umzug auf einen neuen Computer?</span>
              <span className="text-muted-foreground">
                Ein Backup aus „Backup herunterladen“ (ZIP) in den gewählten Ordner einspielen und damit weiterarbeiten.
              </span>
              <input
                ref={fileInput}
                type="file"
                accept=".zip,.db,application/zip"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) restoreBackup(file);
                }}
              />
              <Button
                variant="outline"
                className="mt-2"
                disabled={!ready || restore.isPending || complete.isPending}
                onClick={() => fileInput.current?.click()}
              >
                {restore.isPending ? <Loader2 className="animate-spin" /> : <ArchiveRestore />}
                {restore.isPending ? "Backup wird eingespielt…" : "Backup einspielen…"}
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Wichtig: Kein Ordner, der von iCloud, OneDrive oder Dropbox synchronisiert wird – die laufende Datenbank kann
            dabei beschädigt werden. Sichere stattdessen die Backups (Einstellungen → Export &amp; Backup).
          </p>
        </div>
      </div>
    </div>
  );
}

function ChoiceCard({
  selected,
  onSelect,
  title,
  description,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "flex cursor-pointer gap-3 rounded-lg border bg-card p-4 text-left shadow-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
        selected ? "border-primary ring-1 ring-primary" : "hover:bg-accent/50",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
          selected ? "border-primary" : "border-input",
        )}
      >
        {selected && <span className="size-2 rounded-full bg-primary" />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-medium">{title}</span>
        <span className="text-sm text-muted-foreground">{description}</span>
        {children}
      </div>
    </div>
  );
}

function CheckResult({ check, loading }: { check: DataDirCheck | undefined; loading: boolean }) {
  if (!check) return loading ? <p className="text-sm text-muted-foreground">Ordner wird geprüft…</p> : null;
  return (
    <div className="flex flex-col gap-2 text-sm" aria-live="polite">
      {check.error && (
        <Note tone="error" icon={AlertTriangle}>
          {check.error}
        </Note>
      )}
      {check.ok && check.hasData && (
        <Note tone="info" icon={Info}>
          In diesem Ordner liegen bereits nesev-Daten. nesev arbeitet mit ihnen weiter.
        </Note>
      )}
      {check.ok && !check.hasData && (
        <Note tone="ok" icon={CheckCircle2}>
          {check.exists ? "Ordner ist bereit." : "Der Ordner wird angelegt."}
        </Note>
      )}
      {check.warnings.map((w) => (
        <Note key={w} tone="warning" icon={AlertTriangle}>
          {w}
        </Note>
      ))}
    </div>
  );
}

const TONES = {
  ok: "text-muted-foreground",
  info: "border-border bg-muted/60",
  warning: "border-warning-border bg-warning-muted text-warning",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
} as const;

function Note({ tone, icon: Icon, children }: { tone: keyof typeof TONES; icon: typeof Info; children: React.ReactNode }) {
  return (
    <p className={cn("flex items-start gap-2", tone !== "ok" && "rounded-md border px-3 py-2", TONES[tone])}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
