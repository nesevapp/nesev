import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Download, FileArchive, FileSpreadsheet, HardDriveDownload, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@shared/dates";
import { formatCents } from "@shared/money";
import { FormSection } from "@/components/form-fields";
import { SettingsAreaPage, SettingsTabs } from "@/features/settings/settings-area";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  apiErrorMessage,
  exportSummaryQuery,
  exportUrls,
  localBackupsQuery,
  useCreateLocalBackup,
} from "@/sdk";
import { AccountantExport } from "./accountant-export";
import { DownloadButton } from "./download-button";
import { useRangePicker } from "./range-picker";

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
        description="Beim Serverstart und einmal täglich wird nur die Datenbank nach data/backups gesichert, ohne Logo, PDFs und Belegdateien. Die letzten 14 bleiben erhalten. Für eine vollständige Sicherung „Backup herunterladen“ verwenden."
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
  return (
    <FormSection
      title="Wiederherstellen"
      description="Bewusst kein automatischer Import in der App, damit nichts versehentlich überschrieben wird."
    >
      <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed">
        <li>nesev-Server beenden.</li>
        <li>
          Im Datenordner (standardmäßig <Code>data/</Code> im Projektordner bzw. <Code>NESEV_DATA_DIR</Code>) die
          aktuelle Datenbank sichern und entfernen: <Code>nesev.db</Code>, <Code>nesev.db-wal</Code>,{" "}
          <Code>nesev.db-shm</Code>.
        </li>
        <li>
          Aus dem Backup-ZIP <Code>nesev.db</Code>, <Code>assets/</Code>, <Code>pdfs/</Code> und <Code>receipts/</Code> in den Datenordner
          kopieren. Bei einem automatischen Backup die Datei <Code>backups/nesev-JJJJ-MM-TT.db</Code> als{" "}
          <Code>nesev.db</Code> in den Datenordner kopieren.
        </li>
        <li>Server wieder starten.</li>
      </ol>
    </FormSection>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]">{children}</code>;
}
