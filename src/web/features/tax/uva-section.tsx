import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarClock, ChevronRight, Download, Info } from "lucide-react";
import { formatDate } from "@shared/dates";
import { formatCents } from "@shared/money";
import { UVA_SECTION_LABELS, VAT_BASIS_LABELS, VAT_PERIOD_LABELS } from "@shared/tax-report";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { taxCsvUrls, type UvaDTO, type UvaLineDTO, uvaQuery } from "./api";
import { CopyButton, dueLabel, PeriodNav, SectionHeader, SourcesTable, th, Warnings } from "./components";

export function UvaSection({
  period,
  euIn021,
  setSearch,
}: {
  period?: string;
  euIn021: boolean;
  setSearch: (s: { period?: string; eu?: boolean }) => void;
}) {
  const { data, isFetching } = useQuery(uvaQuery(period, euIn021));
  const [showAnyway, setShowAnyway] = useState(false);
  if (!data) return null;

  const nav = (
    <div className="flex flex-wrap items-center gap-2">
      <PeriodNav periodKey={data.period.key} onChange={(k) => setSearch({ period: k })} />
      <Button variant="outline" size="sm" asChild>
        <a href={taxCsvUrls.uva(data.period.key, euIn021)} download>
          <Download /> CSV
        </a>
      </Button>
    </div>
  );

  if (data.smallBusiness && !showAnyway) {
    return (
      <div className="space-y-6">
        <div className="flex justify-end">{nav}</div>
        <div className="flex gap-3 rounded-lg border bg-muted/30 p-5 text-sm">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="space-y-2">
            <p className="font-medium">Kleinunternehmerregelung aktiv — in der Regel keine UVA erforderlich.</p>
            <p className="text-muted-foreground">
              Kleinunternehmer (§ 6 Abs. 1 Z 27 UStG) sind von der Abgabe der Umsatzsteuervoranmeldung befreit, solange keine
              Vorauszahlung entsteht. Eine Steuerschuld kann trotzdem entstehen, z.B. bei Reverse-Charge-Leistungen aus dem
              Ausland (KZ 057) oder innergemeinschaftlichen Erwerben.
            </p>
            <button type="button" className="text-xs underline underline-offset-2 hover:text-foreground" onClick={() => setShowAnyway(true)}>
              Kennzahlen trotzdem anzeigen
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-8 transition-opacity", isFetching && "opacity-70")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {VAT_BASIS_LABELS[data.basis]} · UVA {VAT_PERIOD_LABELS[data.vatPeriod]} ·{" "}
          <Link to="/settings" className="underline underline-offset-2 hover:text-foreground">
            ändern
          </Link>
        </p>
        {nav}
      </div>

      <Summary data={data} />
      <Warnings items={data.warnings} />
      <KzTable data={data} />
      <NotTaxable data={data} euIn021={euIn021} setEu={(eu) => setSearch({ eu: eu || undefined })} />
    </div>
  );
}

function Summary({ data }: { data: UvaDTO }) {
  const due = dueLabel(data.dueDate, data.today);
  const payable = data.resultCents >= 0;
  return (
    <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
      <div className="bg-background p-4">
        <div className="text-xs text-muted-foreground">{payable ? "Zahllast (KZ 095)" : "Gutschrift (KZ 095)"}</div>
        <div className="mt-1.5 flex items-center gap-1">
          <span className="text-xl font-semibold tracking-tight tabular">{formatCents(Math.abs(data.resultCents))}</span>
          <CopyButton cents={data.resultCents} label="KZ 095" />
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          USt {formatCents(data.vatCents)} − Vorsteuer {formatCents(data.inputVatCents)}
        </div>
      </div>
      <div
        className={cn(
          "bg-background p-4",
          due.tone === "soon" && "bg-amber-50/70",
          due.tone === "overdue" && "bg-red-50/60",
        )}
      >
        <div className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", due.tone === "overdue" && "text-red-700", due.tone === "soon" && "text-amber-800")}>
          <CalendarClock className="size-3.5" />
          Fällig (Abgabe & Zahlung)
        </div>
        <div className={cn("mt-1.5 text-xl font-semibold tracking-tight tabular", due.tone === "overdue" && "text-red-700")}>
          {formatDate(data.dueDate)}
        </div>
        <div className={cn("mt-1 text-xs text-muted-foreground", due.tone === "overdue" && "text-red-700")}>{due.text}</div>
      </div>
      <div className="bg-background p-4">
        <div className="text-xs text-muted-foreground">Zeitraum</div>
        <div className="mt-1.5 text-xl font-semibold tracking-tight">{data.period.label}</div>
        <div className="mt-1 text-xs text-muted-foreground tabular">
          {formatDate(data.period.from)} – {formatDate(data.period.to)}
        </div>
      </div>
    </div>
  );
}

function KzTable({ data }: { data: UvaDTO }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (kz: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(kz)) next.delete(kz);
      else next.add(kz);
      return next;
    });

  const visible = data.lines.filter((l) => all || l.kz === "095" || l.amountCents !== 0 || (l.taxCents ?? 0) !== 0 || l.sources.length > 0);
  const sections = [...new Set(visible.map((l) => l.section))];

  return (
    <section>
      <SectionHeader title="Kennzahlen U 30" hint="Beträge in FinanzOnline je Kennzahl eintragen; die Steuer berechnet FinanzOnline aus der Bemessungsgrundlage.">
        <div className="flex items-center gap-2">
          <Switch id="all-kz" size="sm" checked={all} onCheckedChange={setAll} />
          <Label htmlFor="all-kz" className="text-xs font-normal text-muted-foreground">
            Alle Kennzahlen
          </Label>
        </div>
      </SectionHeader>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(th, "w-16")}>KZ</TableHead>
              <TableHead className={th}>Bezeichnung</TableHead>
              <TableHead className={cn(th, "w-44 text-right")}>Betrag</TableHead>
              <TableHead className={cn(th, "w-40 text-right")}>Umsatzsteuer</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.empty && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                  Keine Umsätze oder Ausgaben in diesem Zeitraum.
                </TableCell>
              </TableRow>
            )}
            {sections.map((section) => (
              <Fragment key={section}>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableCell colSpan={4} className="py-1.5 text-xs font-medium text-muted-foreground">
                    {UVA_SECTION_LABELS[section]}
                  </TableCell>
                </TableRow>
                {visible
                  .filter((l) => l.section === section)
                  .map((l) => (
                    <KzRow key={l.kz} line={l} open={open.has(l.kz)} onToggle={() => toggle(l.kz)} />
                  ))}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function KzRow({ line, open, onToggle }: { line: UvaLineDTO; open: boolean; onToggle: () => void }) {
  const expandable = line.sources.length > 0;
  const result = line.kz === "095";
  return (
    <>
      <TableRow
        className={cn(expandable && "cursor-pointer", result && "font-medium")}
        onClick={expandable ? onToggle : undefined}
        aria-expanded={expandable ? open : undefined}
      >
        <TableCell className="py-1.5 tabular">
          <span className="flex items-center gap-1">
            <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", !expandable && "invisible", open && "rotate-90")} />
            {line.kz}
          </span>
        </TableCell>
        <TableCell className="py-1.5 text-sm whitespace-normal">
          {line.label}
          {expandable && <span className="ml-1.5 text-xs text-muted-foreground">({line.sources.length})</span>}
        </TableCell>
        <TableCell className="py-1 text-right tabular">
          <span className="inline-flex items-center gap-0.5">
            {formatCents(line.amountCents)}
            <CopyButton cents={line.amountCents} label={`KZ ${line.kz}`} />
          </span>
        </TableCell>
        <TableCell className="py-1 pr-4 text-right tabular text-muted-foreground">{line.taxCents == null ? "" : formatCents(line.taxCents)}</TableCell>
      </TableRow>
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={4} className="bg-muted/20 px-6 py-2">
            <SourcesTable sources={line.sources} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function NotTaxable({ data, euIn021, setEu }: { data: UvaDTO; euIn021: boolean; setEu: (v: boolean) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = data.info.filter((i) => i.sources.length > 0);
  return (
    <section>
      <SectionHeader title="Nicht in der UVA" hint="Umsätze mit Leistungsort im Ausland bzw. ohne Zuordnung — zur Kontrolle.">
        <div className="flex items-center gap-2">
          <Switch id="eu021" size="sm" checked={euIn021} onCheckedChange={setEu} />
          <Label htmlFor="eu021" className="text-xs font-normal text-muted-foreground">
            EU-Leistungen in KZ 000/021 ausweisen
          </Label>
        </div>
      </SectionHeader>
      <div className="divide-y rounded-lg border">
        {rows.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted-foreground">Keine.</p>}
        {rows.map((i) => (
          <div key={i.key}>
            <button type="button" className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/30" onClick={() => setOpen(open === i.key ? null : i.key)} aria-expanded={open === i.key}>
              <ChevronRight className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform", open === i.key && "rotate-90")} />
              <div className="min-w-0 flex-1">
                <div className="text-sm">{i.label}</div>
                <div className="text-xs text-muted-foreground">{i.hint}</div>
              </div>
              <span className="text-sm tabular">{formatCents(i.netCents)}</span>
            </button>
            {open === i.key && (
              <div className="bg-muted/20 px-6 pb-2">
                <SourcesTable sources={i.sources} showTax={i.key === "unassigned"} />
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
