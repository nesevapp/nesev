import { type ReactNode, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, X } from "lucide-react";
import { formatDate } from "@shared/dates";
import { formatCents } from "@shared/money";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { docLink } from "@/features/documents/config";
import { cn } from "@/lib/utils";
import { type Forecast, type ForecastEntry, type ForecastParams, forecastQuery, type ForecastSource } from "@/sdk";
import { type ChartColumn, ForecastChart, IN_SOURCES, OUT_SOURCES, SOURCE_META, SourceLegend } from "./forecast-chart";
import { ForecastSettingsPopover } from "./forecast-settings";

export interface ForecastSearch {
  months?: number;
  view?: "month" | "week";
  drafts?: boolean;
  offers?: boolean;
  probability?: number;
  outflows?: boolean;
}

const MONTHS = ["Jän", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const MONTHS_LONG = ["Jänner", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

function short(iso: string) {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
}

/** ISO week number (Mon–Sun). */
function isoWeek(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

function toColumns(data: Forecast, view: "month" | "week"): ChartColumn[] {
  const cols: ChartColumn[] = [];
  const o = data.overdueBucket;
  if (o.inCents > 0 || o.outCents > 0) {
    const balanceCounts = data.balance && data.balance.date <= data.today;
    cols.push({
      key: "overdue",
      label: "Überfällig",
      title: "Überfällig – sofort erwartet",
      ...o,
      lineCents: data.balance ? data.balance.startCents + (balanceCounts ? o.netCents : 0) : o.netCents,
      minBalanceCents: null,
      overdue: true,
    });
  }
  const buckets = view === "month" ? data.monthly : data.weekly;
  buckets.forEach((b, i) => {
    const month = Number(b.key.slice(5, 7)) - 1;
    const year = b.key.slice(2, 4);
    const col = { ...b, lineCents: b.balanceCents ?? b.cumulativeCents };
    if (view === "month") {
      cols.push({
        ...col,
        label: i === 0 || month === 0 ? `${MONTHS[month]} ${year}` : MONTHS[month]!,
        title: `${MONTHS_LONG[month]} ${b.key.slice(0, 4)}${i === 0 ? ` (ab ${short(data.today)})` : ""}`,
      });
    } else {
      cols.push({
        ...col,
        label: short(b.start),
        title: `KW ${isoWeek(b.start)} · ${formatDate(b.start)} – ${formatDate(b.end)}`,
      });
    }
  });
  return cols;
}

export function ForecastPage({ search, setSearch }: { search: ForecastSearch; setSearch: (u: ForecastSearch) => void }) {
  const params: ForecastParams = {
    months: search.months ?? 6,
    drafts: search.drafts ?? false,
    offers: search.offers ?? false,
    probability: search.probability ?? 50,
    outflows: search.outflows ?? true,
  };
  const view = search.view ?? "month";
  const { data, isFetching } = useQuery(forecastQuery(params));
  const [selected, setSelected] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => setSelected(null), [view, params.months]);

  if (!data) return <Page title="Zahlungsprognose" />;

  const columns = toColumns(data, view);
  const has = (dir: "in" | "out", s: ForecastSource) => data.entries.some((e) => e.direction === dir && e.source === s);
  const inSources = IN_SOURCES.filter((s) => s === "invoice" || s === "recurring" || has("in", s) || (s === "offer" ? params.offers : s === "draft" && params.drafts));
  const outSources = params.outflows ? OUT_SOURCES.filter((s) => s === "fixed_cost" || has("out", s)) : [];
  const selectedCol = columns.find((c) => c.key === selected);
  const rows = selectedCol
    ? data.entries.filter((e) =>
        selectedCol.overdue
          ? e.overdue
          : !e.overdue && e.expectedDate >= selectedCol.start! && e.expectedDate <= selectedCol.end!,
      )
    : data.entries;

  return (
    <Page
      title="Zahlungsprognose"
      description={`Erwartete Zahlungen (brutto) bis ${formatDate(data.horizonEnd)} – Eingänge aus Rechnungen und dem Zahlungsverhalten Ihrer Kunden, Ausgänge aus Fixkosten, offenen Ausgaben und Steuern.`}
      actions={
        <>
          <ForecastSettingsPopover open={settingsOpen} onOpenChange={setSettingsOpen} />
          <Segmented
            value={String(params.months)}
            options={[
              ["3", "3 Monate"],
              ["6", "6 Monate"],
              ["12", "12 Monate"],
            ]}
            onChange={(v) => setSearch({ months: Number(v) === 6 ? undefined : Number(v) })}
            label="Zeitraum"
          />
        </>
      }
    >
      <div className={cn("space-y-8 transition-opacity", isFetching && "opacity-70")}>
        <Kpis data={data} onSetBalance={() => setSettingsOpen(true)} />
        {data.kpis.lowestBalance && data.kpis.lowestBalance.cents < 0 && (
          <div className="-mt-4 flex items-start gap-2 rounded-lg border border-danger-border bg-danger-muted/60 px-4 py-3 text-sm text-danger">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              Der Kontostand fällt voraussichtlich am {formatDate(data.kpis.lowestBalance.date)} auf{" "}
              <span className="font-medium tabular">{formatCents(data.kpis.lowestBalance.cents)}</span>. Prüfen Sie Zahlungsziele,
              offene Rechnungen oder verschiebbare Ausgaben.
            </span>
          </div>
        )}

        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">
                Erwartete {params.outflows ? "Ein- und Ausgänge" : "Eingänge"} pro {view === "month" ? "Monat" : "Woche"}
              </h2>
              <p className="text-xs text-muted-foreground">Nach erwartetem Zahlungsdatum · Balken anklicken filtert die Liste</p>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <Toggle id="fc-outflows" label="Ausgänge" checked={params.outflows} onChange={(v) => setSearch({ outflows: v ? undefined : false })} />
              <Toggle id="fc-drafts" label="Entwürfe" checked={params.drafts} onChange={(v) => setSearch({ drafts: v || undefined })} />
              <div className="flex items-center gap-2">
                <Toggle id="fc-offers" label="Angebote" checked={params.offers} onChange={(v) => setSearch({ offers: v || undefined })} />
                {params.offers && <ProbabilityInput value={params.probability} onChange={(p) => setSearch({ probability: p === 50 ? undefined : p })} />}
              </div>
              <Segmented
                value={view}
                options={[
                  ["month", "Monate"],
                  ["week", "Wochen"],
                ]}
                onChange={(v) => setSearch({ view: v === "month" ? undefined : (v as "week") })}
                label="Darstellung"
              />
            </div>
          </div>
          <div className="rounded-lg border p-4 pb-2">
            <div className="mb-2 flex justify-end">
              <SourceLegend inSources={inSources} outSources={outSources} line={data.balance ? "Kontostand" : "Saldo kumuliert"} />
            </div>
            <ForecastChart columns={columns} selected={selected} onSelect={setSelected} showOut={params.outflows} balance={!!data.balance} />
          </div>
        </section>

        <section>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium">
              Erwartete Zahlungen{" "}
              <span className="font-normal text-muted-foreground">({rows.length})</span>
            </h2>
            {selectedCol && (
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="inline-flex items-center gap-1 rounded-full border bg-secondary px-2.5 py-0.5 text-xs"
              >
                {selectedCol.title}
                <X className="size-3" />
              </button>
            )}
          </div>
          <EntriesTable rows={rows} today={data.today} />
        </section>

        <Method data={data} />
      </div>
    </Page>
  );
}

// ── KPIs ────────────────────────────────────────────────────────────────────────

function Kpis({ data, onSetBalance }: { data: Forecast; onSetBalance: () => void }) {
  const { kpis } = data;
  const outflows = data.options.includeOutflows;
  const low = kpis.lowestBalance;
  const outParts = [
    kpis.fixedCosts > 0 && `Fixkosten ${formatCents(kpis.fixedCosts)}`,
    kpis.outOverdue > 0 && `überfällig ${formatCents(kpis.outOverdue)}`,
  ].filter(Boolean);
  return (
    <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        label={`Eingänge bis ${formatDate(data.horizonEnd)}`}
        value={formatCents(kpis.total)}
        sub={
          <>
            nächste 30 Tage <span className="tabular">{formatCents(kpis.next30)}</span>
            {kpis.overdue > 0 && (
              <span className="text-danger">
                {" "}
                · überfällig <span className="tabular">{formatCents(kpis.overdue)}</span>
              </span>
            )}
          </>
        }
      />
      <Tile
        label="Ausgänge"
        value={outflows ? formatCents(kpis.outTotal) : "–"}
        sub={
          outflows
            ? outParts.length
              ? outParts.join(" · ")
              : `nächste 30 Tage ${formatCents(kpis.outNext30)}`
            : "ausgeblendet"
        }
      />
      <Tile
        label="Saldo"
        value={formatCents(kpis.netTotal)}
        sub={outflows ? "Eingänge − Ausgänge im Zeitraum" : "nur Eingänge (Ausgänge ausgeblendet)"}
      />
      {data.balance && kpis.endBalance !== null ? (
        <Tile
          label={`Kontostand am ${formatDate(data.horizonEnd)}`}
          value={formatCents(kpis.endBalance)}
          sub={
            low && low.cents < 0 ? (
              <span className="text-danger">
                Tiefster Stand <span className="tabular">{formatCents(low.cents)}</span> am {formatDate(low.date)}
              </span>
            ) : low ? (
              <>
                Tiefster Stand <span className="tabular">{formatCents(low.cents)}</span> am {formatDate(low.date)}
              </>
            ) : null
          }
          tone={(low && low.cents < 0) || kpis.endBalance < 0 ? "danger" : undefined}
        />
      ) : (
        <div className="bg-background p-4">
          <div className="text-xs text-muted-foreground">Erwarteter Kontostand</div>
          <p className="mt-1.5 text-xs text-muted-foreground">Tragen Sie Ihren aktuellen Kontostand ein, um den Verlauf vorauszurechnen.</p>
          <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" onClick={onSetBalance}>
            Kontostand eintragen
          </Button>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub: ReactNode; tone?: "danger" }) {
  return (
    <div className={cn("bg-background p-4", tone === "danger" && "bg-danger-muted/60")}>
      <div className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", tone === "danger" && "text-danger")}>
        {tone === "danger" && <span className="size-1.5 rounded-full bg-danger-solid" aria-hidden />}
        {label}
      </div>
      <div className={cn("mt-1.5 text-xl font-semibold tracking-tight", tone === "danger" && "text-danger")}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

// ── Table ───────────────────────────────────────────────────────────────────────

function delayHint(delay: NonNullable<ForecastEntry["delay"]>): string {
  const { days, basis, samples } = delay;
  if (basis === "none") return "Keine Zahlungshistorie – Zahlung zur Fälligkeit angenommen";
  const amount = days === 0 ? "pünktlich" : `${Math.abs(days)} ${Math.abs(days) === 1 ? "Tag" : "Tage"} ${days > 0 ? "nach" : "vor"} Fälligkeit`;
  if (basis === "global") return `Keine eigene Historie – Schnitt aller Kunden: ${amount}`;
  return `Kunde zahlt im Schnitt ${amount} (${samples} ${samples === 1 ? "Rechnung" : "Rechnungen"})`;
}

function EntryHint({ e }: { e: ForecastEntry }) {
  const lines: ReactNode[] = [];
  if (e.overdue) lines.push(<span className="text-danger">Seit {e.daysOverdue} {e.daysOverdue === 1 ? "Tag" : "Tagen"} überfällig</span>);
  switch (e.source) {
    case "fixed_cost":
      lines.push("Geplante Zahlung laut Fixkosten");
      break;
    case "expense":
      if (e.recurringExpenseId) lines.push("Gebuchte Fixkosten-Zahlung (ersetzt den geplanten Termin)");
      if (!e.overdue) lines.push(`Fällig ${formatDate(e.dueDate)}`);
      if (e.fullGrossCents !== e.grossCents) lines.push(`Restbetrag (Rechnung ${formatCents(e.fullGrossCents)})`);
      break;
    case "vat":
      lines.push(
        e.estimated
          ? "Bisher erfasste Belege + Schätzung: USt. der erwarteten Eingänge − Vorsteuer der geplanten Ausgaben im Zeitraum"
          : "Laut UVA (bereits abgeschlossener Zeitraum)",
      );
      lines.push(`Fällig ${formatDate(e.dueDate)}${e.direction === "in" ? " · Gutschrift, Auszahlung nach Abgabe" : ""}`);
      break;
    case "income_tax":
      lines.push(`Vierteljährliche Vorauszahlung laut Einstellung, fällig ${formatDate(e.dueDate)}`);
      break;
    case "recurring":
      if (!e.documentId) lines.push(`Rechnung am ${formatDate(e.issueDate)}, fällig ${formatDate(e.dueDate)}`);
      else if (!e.overdue) lines.push(`Fällig ${formatDate(e.dueDate)}`);
      break;
    case "offer":
      lines.push(`${e.probability} % von ${formatCents(e.fullGrossCents)} · bei Annahme heute fällig ${formatDate(e.dueDate)}`);
      break;
    default:
      if (!e.overdue) lines.push(`Fällig ${formatDate(e.dueDate)}`);
      if (e.fullGrossCents !== e.grossCents) lines.push(`abzgl. Gutschrift/Teilzahlung (Rechnung ${formatCents(e.fullGrossCents)})`);
  }
  if (e.delay) lines.push(delayHint(e.delay));
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

const linkClass = "font-medium underline-offset-4 hover:underline";

function EntryLink({ e }: { e: ForecastEntry }) {
  if (e.documentId && e.documentType) {
    return (
      <Link {...docLink(e.documentType, e.documentId)} className={linkClass}>
        {e.number ?? "Entwurf"}
      </Link>
    );
  }
  if (e.recurringInvoiceId) {
    return (
      <Link to="/recurring/$id" params={{ id: e.recurringInvoiceId }} className={linkClass}>
        {e.label || "Serienrechnung"}
      </Link>
    );
  }
  if (e.expenseId) {
    return (
      <Link to="/expenses/$id" params={{ id: e.expenseId }} className={linkClass}>
        {e.number || "Ausgabe"}
      </Link>
    );
  }
  if (e.recurringExpenseId) {
    return (
      <Link to="/fixed-costs" className={linkClass}>
        {e.label}
      </Link>
    );
  }
  if (e.vatPeriod) {
    return (
      <Link to="/tax" search={{ tab: "uva", period: e.vatPeriod }} className={linkClass}>
        UVA {e.label.replace(/^USt-(Zahllast|Gutschrift) /, "")}
      </Link>
    );
  }
  return null;
}

function EntriesTable({ rows, today }: { rows: ForecastEntry[]; today: string }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
        Keine erwarteten Zahlungen in diesem Zeitraum.
      </div>
    );
  }
  const sum = (dir: "in" | "out") => rows.filter((e) => e.direction === dir).reduce((s, e) => s + e.grossCents, 0);
  const totalIn = sum("in");
  const totalOut = sum("out");
  const tax = rows.reduce((s, e) => s + (e.direction === "in" ? e.taxCents : 0), 0);
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Erwartet</TableHead>
          <TableHead>Quelle</TableHead>
          <TableHead>Partner · Beleg</TableHead>
          <TableHead className="text-right">Betrag</TableHead>
          <TableHead className="w-[38%]">Annahme</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((e) => (
          <TableRow key={e.key} className="align-top">
            <TableCell className="tabular">
              {e.overdue ? <span className="text-danger">sofort</span> : formatDate(e.expectedDate)}
              {!e.overdue && e.expectedDate === today && <div className="text-xs text-muted-foreground">heute</div>}
            </TableCell>
            <TableCell>
              <span className="flex items-center gap-1.5 whitespace-nowrap">
                <span className={cn("size-2 rounded-[2px]", SOURCE_META[e.source].bg)} aria-hidden />
                {sourceShort(e)}
              </span>
            </TableCell>
            <TableCell>
              <div className="max-w-72 truncate">{e.partyName}</div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <EntryLink e={e} />
                {(e.documentId || e.expenseId) && e.label && <span className="truncate">{e.label}</span>}
              </div>
            </TableCell>
            <TableCell className="text-right tabular whitespace-nowrap">
              {e.direction === "out" ? (
                <span>−{formatCents(e.grossCents)}</span>
              ) : (
                <span className="text-success">+{formatCents(e.grossCents)}</span>
              )}
              {e.taxCents > 0 && (
                <div className="text-xs text-muted-foreground">
                  {e.direction === "in" ? "USt." : "VSt."} {formatCents(e.taxCents)}
                </div>
              )}
            </TableCell>
            <TableCell className="whitespace-normal">
              <EntryHint e={e} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={3}>Summe</TableCell>
          <TableCell className="text-right tabular whitespace-nowrap">
            <div className="text-success">+{formatCents(totalIn)}</div>
            {totalOut > 0 && <div>−{formatCents(totalOut)}</div>}
            <div className={cn("border-t pt-0.5", totalIn - totalOut < 0 && "text-danger")}>{formatCents(totalIn - totalOut)}</div>
          </TableCell>
          <TableCell className="text-xs font-normal text-muted-foreground">
            In den Eingängen enthaltene USt.: <span className="tabular">{formatCents(tax)}</span>
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}

function sourceShort(e: ForecastEntry): string {
  switch (e.source) {
    case "invoice":
      return "Rechnung";
    case "recurring":
      return e.documentId ? "Serie (Entwurf)" : "Serienrechnung";
    case "offer":
      return "Angebot";
    case "draft":
      return "Entwurf";
    case "fixed_cost":
      return "Fixkosten";
    case "expense":
      return "Offene Ausgabe";
    case "vat":
      return `${e.direction === "in" ? "USt-Gutschrift" : "USt-Zahllast"}${e.estimated ? " (geschätzt)" : ""}`;
    case "income_tax":
      return "ESt-Vorauszahlung";
  }
}

// ── Controls & method ───────────────────────────────────────────────────────────

function Segmented({
  value,
  options,
  onChange,
  label,
}: {
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-md border p-0.5 text-xs">
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn("whitespace-nowrap rounded px-2 py-0.5", value === v ? "bg-secondary font-medium" : "text-muted-foreground hover:text-foreground")}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

function Toggle({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} size="sm" checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
    </div>
  );
}

function ProbabilityInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft));
    if (Number.isFinite(n) && n >= 0 && n <= 100) onChange(n);
    else setDraft(String(value));
  };
  return (
    <div className="relative">
      <Input
        aria-label="Wahrscheinlichkeit Angebote"
        inputMode="numeric"
        className="h-7 w-16 pr-6 text-xs tabular"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground">%</span>
    </div>
  );
}

function Method({ data }: { data: Forecast }) {
  const g = data.globalDelay;
  return (
    <section className="space-y-2 rounded-lg bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
      <p>
        <span className="font-medium text-foreground">Eingänge: </span>
        Offene Rechnungen werden zum Fälligkeitsdatum plus der durchschnittlichen Zahlungsverzögerung des Kunden erwartet
        (bezahlt am − fällig am, über alle bezahlten Rechnungen). Ohne eigene Historie gilt der Schnitt aller Kunden
        {g.basis === "none" ? " – derzeit gibt es noch keine bezahlten Rechnungen, daher 0 Tage" : ` (${g.days} Tage aus ${g.samples} Rechnungen)`}.
        Überfällige Rechnungen werden sofort erwartet. Aktive Serienrechnungen werden mit jedem künftigen Termin im Zeitraum
        hochgerechnet (Rechnungsdatum + Zahlungsziel + Verzögerung). Angebote fließen optional mit der angegebenen
        Wahrscheinlichkeit ein.
      </p>
      <p>
        <span className="font-medium text-foreground">Ausgänge: </span>
        Fixkosten zu jedem Zahlungstermin; unbezahlte Ausgaben zum Fälligkeitsdatum (ohne Datum: Rechnungsdatum + 14 Tage,
        überfällige sofort).{" "}
        {data.smallBusiness
          ? "Als Kleinunternehmer fällt keine USt-Zahllast an."
          : "USt-Zahllast am 15. des zweiten Monats nach dem UVA-Zeitraum: abgeschlossene Zeiträume laut UVA, laufende und künftige geschätzt (USt. der erwarteten Eingänge − Vorsteuer der geplanten Ausgaben)."}{" "}
        ESt-Vorauszahlungen laut Einstellung am 15.2., 15.5., 15.8. und 15.11. Ist eine Ausgabe mit einem
        Fixkosten-Termin verknüpft, entfällt der geplante Termin – es zählt die Ausgabe (unbezahlt als offene Ausgabe,
        bezahlt gar nicht mehr). Nicht verknüpfte Ausgaben zu Fixkosten erscheinen doppelt.
      </p>
      {data.balance && (
        <p>
          <span className="font-medium text-foreground">Kontostand: </span>
          {formatCents(data.balance.startCents)} am {formatDate(data.balance.date)} plus alle erwarteten Zahlungen ab diesem
          Tag. Alle Beträge brutto; eine Hilfe zur Planung, keine Steuerberatung.
        </p>
      )}
    </section>
  );
}
