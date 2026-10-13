import { useState } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, FileArchive, FileSpreadsheet, HardDriveDownload, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatDate, toIsoDate } from "@shared/dates";
import { formatCents } from "@shared/money";
import { FormSection } from "@/components/form-fields";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiErrorMessage } from "@/lib/api";
import { type ExportRange, exportSummaryQuery, exportUrls, localBackupsQuery, useCreateLocalBackup } from "./api";

type Preset = "month" | "quarter" | "year" | "custom";
const PRESETS: { value: Preset; label: string }[] = [
  { value: "month", label: "Monat" },
  { value: "quarter", label: "Quartal" },
  { value: "year", label: "Jahr" },
  { value: "custom", label: "Benutzerdefiniert" },
];
const STEP_MONTHS: Record<Exclude<Preset, "custom">, number> = { month: 1, quarter: 3, year: 12 };

const monthName = (d: Date, style: "long" | "short" = "long") => d.toLocaleDateString("de-AT", { month: style });

/** Range for a preset around an anchor month. */
function presetRange(preset: Exclude<Preset, "custom">, anchor: Date): ExportRange & { label: string } {
  const y = anchor.getFullYear();
  const m = anchor.getMonth();
  if (preset === "month") {
    return { from: toIsoDate(new Date(y, m, 1)), to: toIsoDate(new Date(y, m + 1, 0)), label: `${monthName(anchor)} ${y}` };
  }
  if (preset === "quarter") {
    const q = Math.floor(m / 3);
    const start = new Date(y, q * 3, 1);
    const end = new Date(y, q * 3 + 3, 0);
    return {
      from: toIsoDate(start),
      to: toIsoDate(end),
      label: `Q${q + 1} ${y} · ${monthName(start, "short")} – ${monthName(end, "short")}`,
    };
  }
  return { from: `${y}-01-01`, to: `${y}-12-31`, label: String(y) };
}

function formatBytes(n: number): string {
  const fmt = (v: number) => new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 }).format(v);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${fmt(n / 1024)} KB`;
  return `${fmt(n / 1024 / 1024)} MB`;
}

export function ExportPage() {
  return (
    <Page title="Export & Backup" description="Belege für die Steuerberatung exportieren und Daten sichern.">
      <DocumentsExport />
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
    </Page>
  );
}

function DocumentsExport() {
  const [preset, setPreset] = useState<Preset>("quarter");
  const [anchor, setAnchor] = useState(() => new Date());
  const [custom, setCustom] = useState<ExportRange>(() => presetRange("month", new Date()));

  const range: ExportRange & { label?: string } = preset === "custom" ? custom : presetRange(preset, anchor);
  const valid = !!range.from && !!range.to && range.from <= range.to;
  const query = { from: range.from, to: range.to };
  const summary = useQuery({ ...exportSummaryQuery(query), enabled: valid });

  const step = (dir: -1 | 1) => {
    if (preset === "custom") return;
    setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + dir * STEP_MONTHS[preset], 1));
  };

  const s = summary.data;
  const empty = s && s.invoices + s.creditNotes === 0;

  return (
    <FormSection
      title="Belege"
      description="Finalisierte Rechnungen und Gutschriften nach Belegdatum. Entwürfe sind nicht enthalten."
    >
      <Tabs value={preset} onValueChange={(v) => setPreset(v as Preset)}>
        <TabsList>
          {PRESETS.map((p) => (
            <TabsTrigger key={p.value} value={p.value}>
              {p.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {preset === "custom" ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="export-from">Von</Label>
            <Input
              id="export-from"
              type="date"
              className="w-40"
              value={custom.from}
              onChange={(e) => setCustom((r) => ({ ...r, from: e.target.value }))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="export-to">Bis</Label>
            <Input
              id="export-to"
              type="date"
              className="w-40"
              value={custom.to}
              aria-invalid={!valid}
              onChange={(e) => setCustom((r) => ({ ...r, to: e.target.value }))}
            />
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="size-8" onClick={() => step(-1)} aria-label="Zurück">
            <ChevronLeft />
          </Button>
          <div className="min-w-48 text-center text-sm font-medium">{range.label}</div>
          <Button variant="outline" size="icon" className="size-8" onClick={() => step(1)} aria-label="Weiter">
            <ChevronRight />
          </Button>
          <span className="ml-2 text-sm text-muted-foreground tabular">
            {formatDate(range.from)} – {formatDate(range.to)}
          </span>
        </div>
      )}

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

function DownloadButton({
  href,
  disabled,
  icon: Icon,
  variant = "default",
  children,
}: {
  href: string;
  disabled?: boolean;
  icon: typeof Download;
  variant?: "default" | "outline";
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <Button variant={variant} disabled>
        <Icon /> {children}
      </Button>
    );
  }
  return (
    <Button variant={variant} asChild>
      <a href={href} download>
        <Icon /> {children}
      </a>
    </Button>
  );
}

function BackupSection() {
  const { data: backups } = useSuspenseQuery(localBackupsQuery);
  const create = useCreateLocalBackup();

  return (
    <>
      <FormSection
        title="Backup"
        description="Datenbank, Logo/Briefpapier und alle gespeicherten PDFs in einer ZIP-Datei."
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
        description="Beim Serverstart und einmal täglich wird die Datenbank nach data/backups gesichert. Die letzten 14 bleiben erhalten."
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
                    <TableCell className="font-medium tabular">{formatDate(b.date)}</TableCell>
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
          Aus dem Backup-ZIP <Code>nesev.db</Code>, <Code>assets/</Code> und <Code>pdfs/</Code> in den Datenordner
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
