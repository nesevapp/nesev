import { Fragment, useRef, useState } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Download, FileArchive, FileSpreadsheet, HardDriveDownload, Loader2, RotateCcw, Upload } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@shared/dates";
import { formatCents } from "@shared/money";
import { FormSection } from "@/components/form-fields";
import { SettingsAreaPage, SettingsTabs } from "@/features/settings/settings-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  apiErrorMessage,
  type BackupSummary,
  exportSummaryQuery,
  exportUrls,
  localBackupsQuery,
  restoreStatusQuery,
  useConfirmRestore,
  useCreateLocalBackup,
  useDiscardRestore,
  useRestartNesev,
  useStageRestore,
} from "@/sdk";
import { AccountantExport } from "./accountant-export";
import { DownloadButton } from "./download-button";
import { useRangePicker } from "./range-picker";
import { DataDirSection } from "@/features/setup/data-dir-section";
import { UpdateSection } from "@/features/update/update-section";

function formatBytes(n: number): string {
  const fmt = (v: number) => new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(v);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${fmt(n / 1024)} KB`;
  return `${fmt(n / 1024 / 1024)} MB`;
}

export function ExportPage() {
  return (
    <SettingsAreaPage>
      <SettingsTabs value="export" />
      {/* same content width as the settings tabs */}
      <div className="max-w-4xl">
        <p className="mt-6 text-sm text-muted-foreground">Belege für die Steuerberatung exportieren und Daten sichern.</p>
        <DocumentsExport />
        <AccountantExport />
        <FormSection title="Kunden" description="Alle Kunden inkl. archivierter als CSV.">
          <div>
            <Button variant="outline" asChild>
              <a href={exportUrls.clientsCsv} download>
                <FileSpreadsheet /> Kunden-CSV herunterladen
              </a>
            </Button>
          </div>
        </FormSection>
        <DataDirSection />
        <UpdateSection />
        <BackupSection />
        <RestoreSection />
      </div>
    </SettingsAreaPage>
  );
}

function DocumentsExport() {
  const { range: query, valid, controls } = useRangePicker("export");
  const summary = useQuery({ ...exportSummaryQuery(query), enabled: valid });

  const s = summary.data;
  const empty = s && s.invoices + s.creditNotes === 0;

  return (
    <FormSection
      title="Belege"
      description="Finalisierte Rechnungen und Gutschriften nach Belegdatum. Entwürfe sind nicht enthalten."
    >
      {controls}

      <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">
        {!valid ? (
          <span className="text-destructive">Das Enddatum liegt vor dem Startdatum.</span>
        ) : summary.isPending ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Wird geladen …
          </span>
        ) : summary.isError ? (
          <span className="text-destructive">{apiErrorMessage(summary.error)}</span>
        ) : empty ? (
          <span className="text-muted-foreground">Keine finalisierten Belege in diesem Zeitraum.</span>
        ) : (
          s && (
            <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
              <span>
                <span className="font-medium tabular">{s.invoices}</span>{" "}
                {s.invoices === 1 ? "Rechnung" : "Rechnungen"}
                {s.creditNotes > 0 && (
                  <>
                    {" · "}
                    <span className="font-medium tabular">{s.creditNotes}</span>{" "}
                    {s.creditNotes === 1 ? "Gutschrift" : "Gutschriften"}
                  </>
                )}
              </span>
              <Stat label="Netto" cents={s.netCents} />
              <Stat label="USt" cents={s.taxCents} />
              <Stat label="Brutto" cents={s.grossCents} />
            </div>
          )
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <DownloadButton href={exportUrls.documentsCsv(query)} disabled={!valid} icon={FileSpreadsheet}>
          CSV herunterladen
        </DownloadButton>
        <DownloadButton href={exportUrls.documentsZip(query)} disabled={!valid} icon={FileArchive} variant="outline">
          ZIP mit PDFs
        </DownloadButton>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        CSV für Excel: UTF-8, Trennzeichen „;“, Dezimalkomma, Datum TT.MM.JJJJ. Gutschriften erscheinen mit negativen
        Beträgen. Belege mit mehreren Steuersätzen stehen mit einer Zeile pro Steuersatz in der Datei (Netto/USt/Brutto
        jeweils für diesen Satz). Das ZIP enthält die CSV und die PDFs der Belege
        {s && s.missingPdfs > 0 && ` (${s.missingPdfs} ohne gespeichertes PDF werden neu erzeugt)`}.
      </p>
    </FormSection>
  );
}

function Stat({ label, cents }: { label: string; cents: number }) {
  return (
    <span className="text-muted-foreground">
      {label} <span className="font-medium text-foreground tabular">{formatCents(cents)}</span>
    </span>
  );
}

function BackupSection() {
  const { data: backups } = useSuspenseQuery(localBackupsQuery);
  const create = useCreateLocalBackup();

  return (
    <>
      <FormSection
        title="Backup"
        description="Vollständige Sicherung: Datenbank, Logo/Briefpapier, alle gespeicherten PDFs und die Ausgabenbelege in einer ZIP-Datei."
      >
        <div>
          <Button asChild>
            <a href={exportUrls.backup} download>
              <HardDriveDownload /> Backup herunterladen
            </a>
          </Button>
        </div>
      </FormSection>
      <FormSection
        title="Automatische Backups"
        description="Beim Serverstart und einmal täglich wird nur die Datenbank in den Ordner backups im Datenordner gesichert, ohne Logo, PDFs und Belegdateien. Die letzten 14 bleiben erhalten, dazu eine Sicherung vor jedem Datenbank-Update (pre-migration-…). Für eine vollständige Sicherung „Backup herunterladen“ verwenden."
      >
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Datum</TableHead>
                <TableHead>Erstellt</TableHead>
                <TableHead className="text-right">Größe</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    Noch keine lokalen Backups.
                  </TableCell>
                </TableRow>
              ) : (
                backups.map((b) => (
                  <TableRow key={b.name}>
                    <TableCell>
                      <div className="font-medium tabular">{formatDate(b.date)}</div>
                      {/* local backups are always database snapshots (contents: "database") */}
                      <div className="text-xs text-muted-foreground">Nur Datenbank</div>
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular">
                      {new Date(b.createdAt).toLocaleTimeString("de-AT", { hour: "2-digit", minute: "2-digit" })} Uhr
                    </TableCell>

                    <TableCell className="text-right text-muted-foreground tabular">{formatBytes(b.sizeBytes)}</TableCell>
                    <TableCell className="py-1 text-right">
                      <Button variant="ghost" size="icon" className="size-8" asChild>
                        <a href={exportUrls.localBackup(b.name)} download aria-label={`${b.name} herunterladen`}>
                          <Download />
                        </a>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={create.isPending}
            onClick={() =>
              create.mutate(undefined, {
                onSuccess: () => toast.success("Backup erstellt"),
                onError: (err) => toast.error(apiErrorMessage(err)),
              })
            }
          >
            {create.isPending && <Loader2 className="animate-spin" />}
            Jetzt sichern
          </Button>
        </div>
      </FormSection>
    </>
  );
}

function RestoreSection() {
  const { data: status } = useQuery(restoreStatusQuery);
  const stage = useStageRestore();
  const confirm = useConfirmRestore();
  const discard = useDiscardRestore();
  const restart = useRestartNesev();
  /** the uploaded backup's summary; kept while the dialog animates out */
  const [staged, setStaged] = useState<BackupSummary | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pending = status?.pending;

  const onFile = (file: File | undefined) => {
    if (!file) return;
    stage.mutate(file, {
      onSuccess: ({ summary }) => {
        setStaged(summary);
        setDialogOpen(true);
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    });
  };
  /** dialog closed without confirming: drop the staged upload */
  const onCancel = () => {
    setDialogOpen(false);
    discard.mutate(undefined, { onError: (err) => toast.error(apiErrorMessage(err)) });
  };
  const onConfirm = () =>
    confirm.mutate(undefined, {
      onSuccess: () => {
        setDialogOpen(false);
        toast.success("Backup wird beim nächsten Start eingespielt");
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    });
  const onRestart = () =>
    restart.mutate(undefined, {
      onSuccess: () => window.location.reload(),
      onError: (err) => toast.error(apiErrorMessage(err)),
    });

  return (
    <FormSection
      title="Backup einspielen"
      description="Stellt alle Daten aus einer ZIP-Datei von „Backup herunterladen“ wieder her. Eine Datenbank-Sicherung (.db) aus „Automatische Backups“ geht auch; dann wird nur die Datenbank ersetzt."
    >
      {pending ? (
        <div className="grid gap-3 rounded-lg border border-info-border bg-info-muted px-4 py-3 text-sm" role="status">
          <p className="font-medium text-info">
            Backup vorgemerkt{pending.summary.companyName && ` (${pending.summary.companyName})`}: Es wird beim nächsten Start
            von nesev eingespielt.
          </p>
          <p className="text-muted-foreground">
            Änderungen bis zum Neustart sind danach nur noch in der Sicherung der aktuellen Daten
            (<Code>backups/before-restore-…</Code> im Datenordner) enthalten.
            {!status.canRestart && " Bitte nesev jetzt beenden und wieder starten."}
          </p>
          <div className="flex flex-wrap gap-2">
            {status.canRestart && (
              <Button size="sm" disabled={restart.isPending} onClick={onRestart}>
                {restart.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                {restart.isPending ? "nesev startet neu …" : "Jetzt neu starten"}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={discard.isPending || restart.isPending}
              onClick={() =>
                discard.mutate(undefined, {
                  onSuccess: () => toast.success("Vorgemerktes Backup verworfen"),
                  onError: (err) => toast.error(apiErrorMessage(err)),
                })
              }
            >
              Verwerfen
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <input
            ref={input}
            type="file"
            accept=".zip,.db,application/zip"
            className="hidden"
            onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <Button variant="outline" disabled={stage.isPending} onClick={() => input.current?.click()}>
            {stage.isPending ? <Loader2 className="animate-spin" /> : <Upload />}
            {stage.isPending ? "Backup wird geprüft …" : "Backup einspielen …"}
          </Button>
        </div>
      )}
      <p className="text-xs leading-relaxed text-muted-foreground">
        Startet nesev nicht mehr, steht die Anleitung zum manuellen Wiederherstellen in der Datei <Code>LIESMICH.txt</Code> im
        Backup-ZIP.
      </p>

      <AlertDialog open={dialogOpen} onOpenChange={(open) => !open && onCancel()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Backup einspielen?</AlertDialogTitle>
            <AlertDialogDescription>
              {staged?.kind === "zip"
                ? "Ersetzt die aktuelle Datenbank, Logo und Briefpapier, alle gespeicherten PDFs und die Ausgabenbelege durch den Stand des Backups."
                : "Ersetzt nur die Datenbank. Logo, gespeicherte PDFs und Belegdateien bleiben, wie sie sind."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {staged && <BackupSummaryView summary={staged} />}
          <p className="text-sm text-muted-foreground">
            Die aktuellen Daten werden nicht gelöscht: Sie bleiben im Datenordner unter{" "}
            <Code>backups/before-restore-…</Code>. Eingespielt wird beim nächsten Start von nesev.
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirm.isPending}>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={confirm.isPending}
              onClick={(e) => {
                e.preventDefault();
                onConfirm();
              }}
            >
              Einspielen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FormSection>
  );
}

function BackupSummaryView({ summary: s }: { summary: BackupSummary }) {
  const rows: [string, string][] = [
    ["Unternehmen", s.companyName || "–"],
    ["Kunden", String(s.clients)],
    [
      "Belege",
      `${s.invoices} Rechnungen · ${s.creditNotes} Gutschriften · ${s.offers} Angebote${s.drafts ? ` · ${s.drafts} Entwürfe` : ""}`,
    ],
    ["Letzter Beleg", s.latestDocumentDate ? formatDate(s.latestDocumentDate) : "–"],
    ["Ausgaben", `${s.expenses}${s.latestExpenseDate ? `, letzte vom ${formatDate(s.latestExpenseDate)}` : ""}`],
  ];
  if (s.kind === "zip") rows.push(["Dateien", `${s.files.pdfs} PDFs · ${s.files.receipts} Belegdateien · ${s.files.assets} Logo/Briefpapier`]);
  rows.push(["Größe", formatBytes(s.totalBytes)]);
  return (
    <div className="grid gap-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="tabular">{value}</dd>
          </Fragment>
        ))}
      </dl>
      {s.pendingMigrations > 0 && (
        <p className="text-xs text-muted-foreground">
          Das Backup stammt von einer älteren nesev-Version; die Datenbank wird beim Start automatisch aktualisiert.
        </p>
      )}
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">{children}</code>;
}
