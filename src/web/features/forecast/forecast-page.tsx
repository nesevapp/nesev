import { type ReactNode, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { addDays, formatDate } from "@shared/dates";
import { formatCents } from "@shared/money";
import { Page } from "@/components/page";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { docLink } from "@/features/documents/config";
import { cn } from "@/lib/utils";
import { type ForecastDTO, type ForecastEntryDTO, type ForecastParams, forecastQuery, type ForecastSource } from "./api";
import { type ChartColumn, ForecastChart, SOURCE_META, SOURCE_ORDER, SourceLegend } from "./forecast-chart";

export interface ForecastSearch {
  months?: number;
  view?: "month" | "week";
  drafts?: boolean;
  offers?: boolean;
  probability?: number;
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

function toColumns(data: ForecastDTO, view: "month" | "week"): ChartColumn[] {
  const cols: ChartColumn[] = [];
  if (data.overdueBucket.totalCents > 0) {
    cols.push({
      key: "overdue",
      label: "Überfällig",
      title: "Überfällig – sofort erwartet",
      ...data.overdueBucket,
      cumulativeCents: data.overdueBucket.totalCents,
      overdue: true,
    });
  }
  const buckets = view === "month" ? data.monthly : data.weekly;
  buckets.forEach((b, i) => {
    const month = Number(b.key.slice(5, 7)) - 1;
    const year = b.key.slice(2, 4);
    if (view === "month") {
      cols.push({
        ...b,
        label: i === 0 || month === 0 ? `${MONTHS[month]} ${year}` : MONTHS[month]!,
        title: `${MONTHS_LONG[month]} ${b.key.slice(0, 4)}${i === 0 ? ` (ab ${short(data.today)})` : ""}`,
      });
    } else {
      cols.push({
        ...b,
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
  };
  const view = search.view ?? "month";
  const { data, isFetching } = useQuery(forecastQuery(params));
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(null), [view, params.months]);

  if (!data) return <Page title="Zahlungsprognose" />;

  const columns = toColumns(data, view);
  const usedSources = SOURCE_ORDER.filter((s) => s === "invoice" || s === "recurring" || (s === "offer" ? params.offers : params.drafts));
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
      description={`Erwartete Zahlungseingänge (brutto) bis ${formatDate(data.horizonEnd)} – aus offenen Rechnungen, Serienrechnungen und dem Zahlungsverhalten deiner Kunden.`}
      actions={
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
      }
    >
      <div className={cn("space-y-8 transition-opacity", isFetching && "opacity-70")}>
        <Kpis data={data} />

        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">Erwartete Eingänge pro {view === "month" ? "Monat" : "Woche"}</h2>
              <p className="text-xs text-muted-foreground">Nach erwartetem Zahlungsdatum · Balken anklicken filtert die Liste</p>
            </div>
            <div className="flex flex-wrap items-center gap-4">
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
              <SourceLegend sources={usedSources} />
            </div>
            <ForecastChart columns={columns} selected={selected} onSelect={setSelected} />
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

function Kpis({ data }: { data: ForecastDTO }) {
  const { kpis } = data;
  const until = (days: number) => {
    const end = addDays(data.today, days);
    const label = end > data.horizonEnd ? `bis ${formatDate(data.horizonEnd)} (Ende Zeitraum)` : `bis ${formatDate(end)}`;
    return kpis.overdue > 0 ? `${label} · inkl. überfällig` : label;
  };
  const share = (part: number) => (kpis.total > 0 ? `${Math.round((part / kpis.total) * 100)} % der Summe` : "–");
  return (
    <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 lg:grid-cols-5">
      <Tile label="Nächste 30 Tage" value={formatCents(kpis.next30)} sub={until(30)} />
      <Tile label="Nächste 90 Tage" value={formatCents(kpis.next90)} sub={until(90)} />
      <Tile
        label={`Gesamt bis ${formatDate(data.horizonEnd)}`}
        value={formatCents(kpis.total)}
        sub={
          <>
            davon USt. <span className="tabular">{formatCents(kpis.tax)}</span> (ans Finanzamt)
          </>
        }
      />
      <Tile
        label="Davon überfällig"
        value={formatCents(kpis.overdue)}
        sub={kpis.overdueCount ? `${kpis.overdueCount} ${kpis.overdueCount === 1 ? "Rechnung" : "Rechnungen"} · ${share(kpis.overdue)}` : "Keine überfälligen Rechnungen"}
        tone={kpis.overdue > 0 ? "danger" : undefined}
      />
      <Tile label="Davon wiederkehrend" value={formatCents(kpis.recurring)} sub={share(kpis.recurring)} />
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub: ReactNode; tone?: "danger" }) {
  return (
    <div className={cn("bg-background p-4", tone === "danger" && "bg-red-50/60")}>
      <div className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", tone === "danger" && "text-red-700")}>
        {tone === "danger" && <span className="size-1.5 rounded-full bg-red-600" aria-hidden />}
        {label}
      </div>
      <div className={cn("mt-1.5 text-xl font-semibold tracking-tight", tone === "danger" && "text-red-700")}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

// ── Table ───────────────────────────────────────────────────────────────────────

function delayHint(e: ForecastEntryDTO): string {
  const { days, basis, samples } = e.delay;
  if (basis === "none") return "Keine Zahlungshistorie – Zahlung zur Fälligkeit angenommen";
  const amount = days === 0 ? "pünktlich" : `${Math.abs(days)} ${Math.abs(days) === 1 ? "Tag" : "Tage"} ${days > 0 ? "nach" : "vor"} Fälligkeit`;
  if (basis === "global") return `Keine eigene Historie – Schnitt aller Kunden: ${amount}`;
  return `Kunde zahlt im Schnitt ${amount} (${samples} ${samples === 1 ? "Rechnung" : "Rechnungen"})`;
}

function EntryHint({ e }: { e: ForecastEntryDTO }) {
  const lines: ReactNode[] = [];
  if (e.overdue) lines.push(<span className="text-red-700">Seit {e.daysOverdue} {e.daysOverdue === 1 ? "Tag" : "Tagen"} überfällig</span>);
  if (e.source === "recurring" && !e.documentId) lines.push(`Rechnung am ${formatDate(e.issueDate)}, fällig ${formatDate(e.dueDate)}`);
  else if (e.source === "offer") lines.push(`${e.probability} % von ${formatCents(e.fullGrossCents)} · bei Annahme heute fällig ${formatDate(e.dueDate)}`);
  else if (!e.overdue) lines.push(`Fällig ${formatDate(e.dueDate)}`);
  if (e.fullGrossCents !== e.grossCents && e.source !== "offer") lines.push(`abzgl. Gutschrift (Rechnung ${formatCents(e.fullGrossCents)})`);
  lines.push(delayHint(e));
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

function EntryLink({ e }: { e: ForecastEntryDTO }) {
  if (e.documentId && e.documentType) {
    return (
      <Link {...docLink(e.documentType, e.documentId)} className="font-medium underline-offset-4 hover:underline">
        {e.number ?? "Entwurf"}
      </Link>
    );
  }
  if (e.recurringInvoiceId) {
    return (
      <Link to="/recurring/$id" params={{ id: e.recurringInvoiceId }} className="font-medium underline-offset-4 hover:underline">
        {e.label || "Serienrechnung"}
      </Link>
    );
  }
  return null;
}

function EntriesTable({ rows, today }: { rows: ForecastEntryDTO[]; today: string }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
        Keine erwarteten Zahlungen in diesem Zeitraum.
      </div>
    );
  }
  const total = rows.reduce((s, e) => s + e.grossCents, 0);
  const tax = rows.reduce((s, e) => s + e.taxCents, 0);
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Erwartet</TableHead>
          <TableHead>Quelle</TableHead>
          <TableHead>Kunde · Beleg</TableHead>
          <TableHead className="text-right">Betrag</TableHead>
          <TableHead className="w-[38%]">Annahme</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((e) => (
          <TableRow key={e.key} className="align-top">
            <TableCell className="tabular">
              {e.overdue ? <span className="text-red-700">sofort</span> : formatDate(e.expectedDate)}
              {!e.overdue && e.expectedDate === today && <div className="text-xs text-muted-foreground">heute</div>}
            </TableCell>
            <TableCell>
              <span className="flex items-center gap-1.5 whitespace-nowrap">
                <span className={cn("size-2 rounded-[2px]", SOURCE_META[e.source].bg)} aria-hidden />
                {sourceShort(e.source, !!e.documentId)}
              </span>
            </TableCell>
            <TableCell>
              <div className="max-w-72 truncate">{e.clientName}</div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <EntryLink e={e} />
                {e.documentId && e.label && <span className="truncate">{e.label}</span>}
              </div>
            </TableCell>
            <TableCell className="text-right tabular">
              {formatCents(e.grossCents)}
              {e.taxCents > 0 && <div className="text-xs text-muted-foreground">USt. {formatCents(e.taxCents)}</div>}
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
          <TableCell className="text-right tabular">
            {formatCents(total)}
            <div className="text-xs font-normal text-muted-foreground">USt. {formatCents(tax)}</div>
          </TableCell>
          <TableCell className="text-xs font-normal text-muted-foreground">
            Netto nach USt.: <span className="tabular">{formatCents(total - tax)}</span>
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}

function sourceShort(s: ForecastSource, hasDocument: boolean): string {
  switch (s) {
    case "invoice":
      return "Rechnung";
    case "recurring":
      return hasDocument ? "Serie (Entwurf)" : "Serienrechnung";
    case "offer":
      return "Angebot";
    case "draft":
      return "Entwurf";
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

function Method({ data }: { data: ForecastDTO }) {
  const g = data.globalDelay;
  return (
    <section className="rounded-lg bg-muted/40 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
      <span className="font-medium text-foreground">So wird gerechnet: </span>
      Offene Rechnungen werden zum Fälligkeitsdatum plus der durchschnittlichen Zahlungsverzögerung des Kunden erwartet
      (bezahlt am − fällig am, über alle bezahlten Rechnungen). Ohne eigene Historie gilt der Schnitt aller Kunden
      {g.basis === "none" ? " – derzeit gibt es noch keine bezahlten Rechnungen, daher 0 Tage" : ` (${g.days} Tage aus ${g.samples} Rechnungen)`}.
      Überfällige Rechnungen werden sofort erwartet. Aktive Serienrechnungen werden mit jedem künftigen Termin im Zeitraum
      hochgerechnet (Rechnungsdatum + Zahlungsziel + Verzögerung). Angebote fließen optional mit der angegebenen
      Wahrscheinlichkeit ein. Beträge sind brutto – der USt.-Anteil ist ans Finanzamt abzuführen.
    </section>
  );
}
