import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { formatDate } from "@shared/dates";
import { formatCents } from "@shared/money";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MONTHS } from "@/features/dashboard/revenue-chart";
import { cn } from "@/lib/utils";
import { earQuery, type EarReport, taxCsvUrls } from "@/sdk";
import { CopyButton, SectionHeader, Segmented, SourceLink, SourcesTable, th, Warnings } from "./components";
import { EarChart, EarLegend } from "./ear-chart";

export function EarSection({ year, setYear }: { year?: number; setYear: (y: number) => void }) {
  const { data, isFetching } = useQuery(earQuery(year));
  if (!data) return null;
  const amountHint = data.gross ? "Beträge brutto (Kleinunternehmer)" : "Beträge netto (Nettomethode)";

  return (
    <div className={cn("space-y-8 transition-opacity", isFetching && "opacity-70")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          className="text-xs text-muted-foreground"
          title={data.gross ? "Kein Vorsteuerabzug: Ausgaben inkl. USt." : "USt-Zahlungen und abziehbare Vorsteuer bleiben außer Ansatz; nicht abziehbare Vorsteuer ist Ausgabe."}
        >
          Zufluss-/Abflussprinzip: Einnahmen nach Zahlungseingang, Ausgaben nach Zahlung · {amountHint}
        </p>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md border">
            <Button variant="ghost" size="icon" className="size-8 rounded-r-none" onClick={() => setYear(data.year - 1)} aria-label="Vorjahr">
              <ChevronLeft />
            </Button>
            <span className="w-14 text-center text-sm font-medium tabular" aria-live="polite">
              {data.year}
            </span>
            <Button variant="ghost" size="icon" className="size-8 rounded-l-none" onClick={() => setYear(data.year + 1)} aria-label="Nächstes Jahr">
              <ChevronRight />
            </Button>
          </div>
          <Button variant="outline" size="sm" asChild>
            <a href={taxCsvUrls.ear(data.year)} download>
              <Download /> CSV
            </a>
          </Button>
        </div>
      </div>

      <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
        <Tile label="Einnahmen" cents={data.incomeCents} />
        <Tile label="Ausgaben" cents={data.expensesCents} />
        <Tile label={data.profitCents >= 0 ? "Gewinn" : "Verlust"} cents={data.profitCents} strong />
      </div>

      <Warnings items={data.warnings} />
      <MonthlySection data={data} />

      <div className="grid gap-8 lg:grid-cols-2">
        <Breakdown data={data} />
        <E1a data={data} />
      </div>

      <Unpaid data={data} />
    </div>
  );
}

function Tile({ label, cents, strong }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className="bg-background p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-1.5 text-xl tracking-tight tabular", strong ? "font-semibold" : "font-medium")}>{formatCents(cents)}</div>
    </div>
  );
}

function MonthlySection({ data }: { data: EarReport }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  return (
    <section>
      <SectionHeader title="Pro Monat" hint="Einnahmen und Ausgaben nach Zahlungsdatum, Ergebnis = Einnahmen − Ausgaben">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: "chart", label: "Diagramm" },
            { value: "table", label: "Tabelle" },
          ]}
        />
      </SectionHeader>
      <div className="rounded-lg border p-4 pb-2">
        {view === "chart" ? (
          <>
            <div className="mb-2 flex justify-end">
              <EarLegend />
            </div>
            <EarChart data={data.monthly} year={data.year} />
          </>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8 text-xs text-muted-foreground">Monat</TableHead>
                <TableHead className="h-8 text-right text-xs text-muted-foreground">Einnahmen</TableHead>
                <TableHead className="h-8 text-right text-xs text-muted-foreground">Ausgaben</TableHead>
                <TableHead className="h-8 text-right text-xs text-muted-foreground">Ergebnis</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.monthly.map((m) => (
                <TableRow key={m.month} className="hover:bg-transparent">
                  <TableCell className="py-1.5">{MONTHS[m.month]}</TableCell>
                  <TableCell className="py-1.5 text-right tabular">{formatCents(m.incomeCents)}</TableCell>
                  <TableCell className="py-1.5 text-right tabular">{formatCents(m.expensesCents)}</TableCell>
                  <TableCell className="py-1.5 text-right tabular">{formatCents(m.profitCents)}</TableCell>
                </TableRow>
              ))}
              <TableRow className="font-medium hover:bg-transparent">
                <TableCell className="py-1.5">Summe</TableCell>
                <TableCell className="py-1.5 text-right tabular">{formatCents(data.incomeCents)}</TableCell>
                <TableCell className="py-1.5 text-right tabular">{formatCents(data.expensesCents)}</TableCell>
                <TableCell className="py-1.5 text-right tabular">{formatCents(data.profitCents)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}

function Breakdown({ data }: { data: EarReport }) {
  const [openIncome, setOpenIncome] = useState(false);
  const income = data.income[0]!;
  return (
    <section className="min-w-0">
      <SectionHeader title="Einnahmen-Ausgaben-Rechnung" />
      <div className="rounded-lg border">
        <Table>
          <TableBody>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableCell className="py-1.5 text-xs font-medium text-muted-foreground">Einnahmen</TableCell>
              <TableCell className="py-1.5 text-right text-xs font-medium text-muted-foreground tabular">{formatCents(data.incomeCents)}</TableCell>
            </TableRow>
            <TableRow className={cn(income.sources.length > 0 && "cursor-pointer")} onClick={() => setOpenIncome(!openIncome)} aria-expanded={openIncome}>
              <TableCell className="py-1.5 pl-4">
                <span className="flex items-center gap-1">
                  <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", openIncome && "rotate-90")} />
                  {income.label}
                  <span className="text-xs text-muted-foreground">({income.sources.length})</span>
                </span>
              </TableCell>
              <TableCell className="py-1.5 text-right tabular">{formatCents(income.amountCents)}</TableCell>
            </TableRow>
            {openIncome && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={2} className="bg-muted/20 px-4 py-2">
                  <SourcesTable sources={income.sources} />
                </TableCell>
              </TableRow>
            )}
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableCell className="py-1.5 text-xs font-medium text-muted-foreground">Ausgaben</TableCell>
              <TableCell className="py-1.5 text-right text-xs font-medium text-muted-foreground tabular">{formatCents(data.expensesCents)}</TableCell>
            </TableRow>
            {data.groups.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={2} className="py-4 text-center text-sm text-muted-foreground">
                  Keine bezahlten Ausgaben.
                </TableCell>
              </TableRow>
            )}
            {data.groups.map((g) => (
              <Fragment key={g.group}>
                <TableRow className="hover:bg-transparent">
                  <TableCell className="py-1.5 pl-4 font-medium">{g.group}</TableCell>
                  <TableCell className="py-1.5 text-right font-medium tabular">{formatCents(g.amountCents)}</TableCell>
                </TableRow>
                {g.categories.map((c) =>
                  c.assets ? (
                    <AssetCategoryRows key={c.key} category={c} />
                  ) : (
                    <TableRow key={c.key} className="hover:bg-transparent">
                      <TableCell className="py-1 pl-8 text-muted-foreground" title={c.hint || undefined}>
                        {c.label}
                      </TableCell>
                      <TableCell className="py-1 text-right text-muted-foreground tabular">{formatCents(c.amountCents)}</TableCell>
                    </TableRow>
                  ),
                )}
              </Fragment>
            ))}
            <TableRow className="border-t-2 font-semibold hover:bg-transparent">
              <TableCell className="py-2">{data.profitCents >= 0 ? "Gewinn" : "Verlust"}</TableCell>
              <TableCell className="py-2 text-right tabular">{formatCents(data.profitCents)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

type EarCategory = EarReport["groups"][number]["categories"][number];

/** AfA rows: expandable to the assets of the Anlagenverzeichnis behind the amount. */
function AssetCategoryRows({ category: c }: { category: EarCategory }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TableRow className="cursor-pointer" onClick={() => setOpen(!open)} aria-expanded={open}>
        <TableCell className="py-1 pl-8 text-muted-foreground" title={c.hint || undefined}>
          <span className="flex items-center gap-1">
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
            {c.label}
            <span className="text-xs">({c.assets?.length ?? 0})</span>
          </span>
        </TableCell>
        <TableCell className="py-1 text-right text-muted-foreground tabular">{formatCents(c.amountCents)}</TableCell>
      </TableRow>
      {open &&
        c.assets?.map((a) => (
          <TableRow key={a.id} className="hover:bg-transparent">
            <TableCell className="bg-muted/20 py-1 pl-14 text-xs">
              <Link to="/assets/$id" params={{ id: a.id }} className="font-medium tabular hover:underline">
                {a.number}
              </Link>{" "}
              {a.name}
              {a.note && <span className="text-muted-foreground"> · {a.note}</span>}
            </TableCell>
            <TableCell className="bg-muted/20 py-1 text-right text-xs tabular">{formatCents(a.amountCents)}</TableCell>
          </TableRow>
        ))}
    </>
  );
}

function E1a({ data }: { data: EarReport }) {
  return (
    <section className="min-w-0">
      <SectionHeader title="Zuordnung E1a (Vorschlag)" hint="Kennzahlen der Beilage zur Einkommensteuererklärung — Zuordnung je Kategorie, mit Steuerberatung prüfen." />
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(th, "w-16")}>KZ</TableHead>
              <TableHead className={th}>Bezeichnung</TableHead>
              <TableHead className={cn(th, "pr-10 text-right")}>Betrag</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.e1a.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3} className="py-6 text-center text-sm text-muted-foreground">
                  Keine Werte.
                </TableCell>
              </TableRow>
            )}
            {data.e1a.map((e) => (
              <TableRow key={e.kz} className="hover:bg-transparent">
                <TableCell className="py-1 tabular">{e.kz}</TableCell>
                <TableCell className="py-1">{e.label}</TableCell>
                <TableCell className="py-1 text-right tabular">
                  <span className="inline-flex items-center gap-0.5">
                    {formatCents(e.amountCents)}
                    <CopyButton cents={e.amountCents} label={`KZ ${e.kz}`} />
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function Unpaid({ data }: { data: EarReport }) {
  return (
    <section>
      <SectionHeader title="Offene Posten zum Jahresende" hint={`Belege aus ${data.year}, die bis 31.12. nicht (vollständig) bezahlt wurden — nicht in der EAR ${data.year} enthalten.`} />
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={th}>Beleg</TableHead>
              <TableHead className={th}>Art</TableHead>
              <TableHead className={th}>Datum</TableHead>
              <TableHead className={th}>Partner</TableHead>
              <TableHead className={cn(th, "text-right")}>Offen (brutto)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.unpaid.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                  Keine offenen Posten.
                </TableCell>
              </TableRow>
            )}
            {data.unpaid.map((u) => (
              <TableRow key={`${u.kind}-${u.id}`} className="hover:bg-transparent">
                <TableCell className="py-1.5">
                  <SourceLink s={u} />
                </TableCell>
                <TableCell className="py-1.5 text-muted-foreground">{u.kind === "expense" ? "Ausgabe" : "Rechnung"}</TableCell>
                <TableCell className="py-1.5 tabular">{formatDate(u.date)}</TableCell>
                <TableCell className="max-w-64 truncate py-1.5">{u.party}</TableCell>
                <TableCell className="py-1.5 text-right tabular">{formatCents(u.openCents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
