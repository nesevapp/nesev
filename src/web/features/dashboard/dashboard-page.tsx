import { type ReactNode, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Building2, Check, ChevronLeft, ChevronRight, FileText, Receipt, Users } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@shared/dates";
import { DOCUMENT_TYPE_LABELS, isOverdue } from "@shared/documents";
import { formatCents } from "@shared/money";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PartialLabel, StatusBadge } from "@/features/documents/components/status-badge";
import { docLink } from "@/features/documents/config";
import { RemindButton } from "@/features/reminders/components/invoice-reminders";
import { tour } from "@/features/tour/tour-store";
import { cn } from "@/lib/utils";
import {
  apiErrorMessage,
  type Dashboard,
  type DashboardDocument,
  dashboardQuery,
  type OverdueDocument,
  useChangeDocumentStatus,
} from "@/sdk";
import { ChartLegend, MONTHS, RevenueChart } from "./revenue-chart";
import { SmallBusinessLimitCard } from "./small-business-limit";

interface DashboardSearch {
  year?: number;
  compare?: boolean;
  expenses?: boolean;
}

export function DashboardPage({
  year,
  compare,
  expenses,
  setSearch,
}: {
  year?: number;
  compare: boolean;
  expenses: boolean;
  setSearch: (update: DashboardSearch) => void;
}) {
  const { data, isFetching } = useQuery(dashboardQuery(year));
  if (!data) return <Page title="Dashboard" />;

  const thisYear = Number(data.today.slice(0, 4));
  const setYear = (y: number) => setSearch({ year: y === thisYear ? undefined : y });
  const fresh = !data.setup.hasDocuments;

  return (
    <Page
      title="Dashboard"
      actions={!fresh && <YearSwitcher year={data.year} years={data.years} onChange={setYear} />}
    >
      {fresh ? (
        <Onboarding setup={data.setup} />
      ) : (
        <div className={cn("space-y-8 transition-opacity", isFetching && "opacity-70")}>
          {data.setup.companyMissing && <CompanyBanner />}
          <Kpis data={data} />
          {data.smallBusiness && <SmallBusinessLimitCard limit={data.smallBusiness} isCurrentYear={data.year === thisYear} />}
          <RevenueSection
            data={data}
            compare={compare}
            setCompare={(c) => setSearch({ compare: c || undefined })}
            expenses={expenses}
            setExpenses={(e) => setSearch({ expenses: e ? undefined : false })}
          />
          <OverdueSection rows={data.overdue} total={data.kpis.overdue.count} />
          <div className="grid gap-8 lg:grid-cols-2">
            <RecentSection rows={data.recent} today={data.today} />
            <OpenOffersSection rows={data.openOffers} total={data.kpis.openOffers.count} today={data.today} />
          </div>
        </div>
      )}
    </Page>
  );
}

// ── Header ──────────────────────────────────────────────────────────────────────

function YearSwitcher({ year, years, onChange }: { year: number; years: number[]; onChange: (y: number) => void }) {
  const min = Math.min(...years);
  const max = Math.max(...years);
  return (
    <div className="flex items-center rounded-md border">
      <Button variant="ghost" size="icon" className="size-8 rounded-r-none" disabled={year <= min} onClick={() => onChange(year - 1)} aria-label="Vorjahr">
        <ChevronLeft />
      </Button>
      <span className="w-14 text-center text-sm font-medium tabular" aria-live="polite">
        {year}
      </span>
      <Button variant="ghost" size="icon" className="size-8 rounded-l-none" disabled={year >= max} onClick={() => onChange(year + 1)} aria-label="Nächstes Jahr">
        <ChevronRight />
      </Button>
    </div>
  );
}

// ── KPIs ────────────────────────────────────────────────────────────────────────

function Kpis({ data }: { data: Dashboard }) {
  const { kpis, year, today, monthly } = data;
  const isCurrentYear = year === Number(today.slice(0, 4));
  // Current year: compare with the same months of the previous year, not the whole year.
  const lastMonth = isCurrentYear ? Number(today.slice(5, 7)) - 1 : 11;
  const comparable = monthly.slice(0, lastMonth + 1);
  const deltaLabel = isCurrentYear ? `ggü. Jän–${MONTHS[lastMonth]} ${year - 1}` : `ggü. ${year - 1}`;
  const result = kpis.revenue.cents - kpis.expenses.cents;
  const margin = kpis.revenue.cents > 0 ? result / kpis.revenue.cents : null;
  const overdue = kpis.overdue.count > 0;

  return (
    <div className="space-y-3">
      <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label={`Umsatz ${year} (netto)`}
          value={formatCents(kpis.revenue.cents)}
          sub={
            <Delta
              current={kpis.revenue.cents}
              previous={comparable.reduce((s, m) => s + m.previousCents, 0)}
              label={deltaLabel}
              fallback="Rechnungen abzgl. Gutschriften"
            />
          }
        />
        <Tile
          label={`Ausgaben ${year}`}
          value={formatCents(kpis.expenses.cents)}
          sub={
            <Delta
              current={kpis.expenses.cents}
              previous={comparable.reduce((s, m) => s + m.previousExpenseCents, 0)}
              label={deltaLabel}
              fallback="nach Belegdatum"
              lowerIsBetter
            />
          }
          link={<Link to="/expenses" className="absolute inset-0" aria-label="Ausgaben anzeigen" />}
        />
        <Tile
          label={`Ergebnis ${year}`}
          value={formatCents(result)}
          tone={result < 0 ? "danger" : undefined}
          sub={margin === null ? "Umsatz − Ausgaben" : `Marge ${(margin * 100).toLocaleString("de-AT", { maximumFractionDigits: 0 })} % · Umsatz − Ausgaben`}
        />
        <Tile label={`Bezahlt ${year}`} value={formatCents(kpis.paid.cents)} sub={`${countLabel(kpis.paid.count, "Rechnung", "Rechnungen")} (brutto)`} />
      </div>
      <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
        <Tile label="Offene Rechnungen" value={formatCents(kpis.openInvoices.cents)} sub={countLabel(kpis.openInvoices.count, "Rechnung", "Rechnungen")} />
        <Tile
          label="Davon überfällig"
          value={formatCents(kpis.overdue.cents)}
          sub={countLabel(kpis.overdue.count, "Rechnung", "Rechnungen")}
          tone={overdue ? "danger" : undefined}
          link={overdue ? <Link to="/invoices" search={{ status: "overdue" }} className="absolute inset-0" aria-label="Überfällige Rechnungen anzeigen" /> : undefined}
        />
        <Tile label="Offene Angebote" value={formatCents(kpis.openOffers.cents)} sub={countLabel(kpis.openOffers.count, "Angebot", "Angebote")} />
      </div>
    </div>
  );
}

/** "+12 % ggü. …"; green when the change is good (more revenue, fewer expenses). */
function Delta({
  current,
  previous,
  label,
  fallback,
  lowerIsBetter = false,
}: {
  current: number;
  previous: number;
  label: string;
  fallback: string;
  lowerIsBetter?: boolean;
}) {
  if (previous <= 0) return <>{fallback}</>;
  const delta = (current - previous) / previous;
  const good = lowerIsBetter ? delta <= 0 : delta >= 0;
  return (
    <>
      <span className={cn("font-medium", good ? "text-success" : "text-danger")}>
        {delta >= 0 ? "+" : "−"}
        {Math.abs(delta * 100).toLocaleString("de-AT", { maximumFractionDigits: 0 })} %
      </span>{" "}
      {label}
    </>
  );
}

function countLabel(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

function Tile({
  label,
  value,
  sub,
  tone,
  link,
}: {
  label: string;
  value: string;
  sub: ReactNode;
  tone?: "danger";
  link?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative bg-background p-4",
        tone === "danger" && "bg-danger-muted/60",
        link && (tone === "danger" ? "hover:bg-danger-muted" : "hover:bg-muted/50"),
      )}
    >
      <div className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", tone === "danger" && "text-danger")}>
        {tone === "danger" && <span className="size-1.5 rounded-full bg-danger-solid" aria-hidden />}
        {label}
      </div>
      <div className={cn("mt-1.5 text-xl font-semibold tracking-tight", tone === "danger" && "text-danger")}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
      {link}
    </div>
  );
}

// ── Revenue chart ───────────────────────────────────────────────────────────────

function RevenueSection({
  data,
  compare,
  setCompare,
  expenses,
  setExpenses,
}: {
  data: Dashboard;
  compare: boolean;
  setCompare: (c: boolean) => void;
  expenses: boolean;
  setExpenses: (e: boolean) => void;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const isCurrentYear = data.year === Number(data.today.slice(0, 4));
  const lastMonth = isCurrentYear ? Number(data.today.slice(5, 7)) - 1 : 11;
  const { revenue, expenses: costs } = data.kpis;
  const head = "h-8 text-right text-xs text-muted-foreground";
  const cell = "py-1.5 text-right tabular";
  const prevCell = cn(cell, "text-muted-foreground");
  const resultCell = (v: number) => cn(cell, "font-medium", v < 0 && "text-danger");
  return (
    <section>
      <SectionHeader
        title={expenses ? "Umsatz & Ausgaben pro Monat" : "Umsatz pro Monat"}
        hint={
          expenses
            ? "netto nach Belegdatum; Umsatz = Rechnungen abzüglich Gutschriften"
            : "netto, Rechnungen abzüglich Gutschriften nach Belegdatum"
        }
      >
        <div className="flex items-center gap-2">
          <Switch id="expenses" size="sm" checked={expenses} onCheckedChange={setExpenses} />
          <Label htmlFor="expenses" className="text-xs font-normal text-muted-foreground">
            Ausgaben
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="compare" size="sm" checked={compare} onCheckedChange={setCompare} />
          <Label htmlFor="compare" className="text-xs font-normal text-muted-foreground">
            Vorjahr {data.year - 1}
          </Label>
        </div>
        <div className="flex rounded-md border p-0.5 text-xs">
          {(["chart", "table"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={cn("rounded px-2 py-0.5", view === v ? "bg-secondary font-medium" : "text-muted-foreground hover:text-foreground")}
            >
              {v === "chart" ? "Diagramm" : "Tabelle"}
            </button>
          ))}
        </div>
      </SectionHeader>
      <div className="rounded-lg border p-4 pb-2">
        {view === "chart" ? (
          <>
            <div className="mb-2 flex justify-end">
              <ChartLegend year={data.year} compare={compare} expenses={expenses} />
            </div>
            <RevenueChart data={data.monthly} year={data.year} compare={compare} expenses={expenses} lastMonth={lastMonth} />
          </>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8 text-xs text-muted-foreground">Monat</TableHead>
                <TableHead className={head}>Umsatz {data.year}</TableHead>
                {compare && <TableHead className={head}>Umsatz {data.year - 1}</TableHead>}
                {expenses && <TableHead className={head}>Ausgaben {data.year}</TableHead>}
                {expenses && compare && <TableHead className={head}>Ausgaben {data.year - 1}</TableHead>}
                {expenses && <TableHead className={head}>Ergebnis {data.year}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.monthly.map((m) => (
                <TableRow key={m.month} className="hover:bg-transparent">
                  <TableCell className="py-1.5">{MONTHS[m.month]}</TableCell>
                  <TableCell className={cell}>{formatCents(m.cents)}</TableCell>
                  {compare && <TableCell className={prevCell}>{formatCents(m.previousCents)}</TableCell>}
                  {expenses && <TableCell className={cell}>{formatCents(m.expenseCents)}</TableCell>}
                  {expenses && compare && <TableCell className={prevCell}>{formatCents(m.previousExpenseCents)}</TableCell>}
                  {expenses && <TableCell className={resultCell(m.cents - m.expenseCents)}>{formatCents(m.cents - m.expenseCents)}</TableCell>}
                </TableRow>
              ))}
              <TableRow className="font-medium hover:bg-transparent">
                <TableCell className="py-1.5">Summe</TableCell>
                <TableCell className={cell}>{formatCents(revenue.cents)}</TableCell>
                {compare && <TableCell className={prevCell}>{formatCents(revenue.previousCents)}</TableCell>}
                {expenses && <TableCell className={cell}>{formatCents(costs.cents)}</TableCell>}
                {expenses && compare && <TableCell className={prevCell}>{formatCents(costs.previousCents)}</TableCell>}
                {expenses && <TableCell className={resultCell(revenue.cents - costs.cents)}>{formatCents(revenue.cents - costs.cents)}</TableCell>}
              </TableRow>
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}

// ── Lists ───────────────────────────────────────────────────────────────────────

function SectionHeader({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children && <div className="flex items-center gap-3">{children}</div>}
    </div>
  );
}

function AllLink({ to, search, children }: { to: "/invoices" | "/offers"; search?: { status: "overdue" | "sent" }; children: ReactNode }) {
  return (
    <Link to={to} search={search} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
      {children}
      <ArrowRight className="size-3" />
    </Link>
  );
}

function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="py-8 text-center text-sm text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  );
}

const th = "h-9 text-xs font-medium text-muted-foreground";

function useRowNav() {
  const navigate = useNavigate();
  return (row: { type: DashboardDocument["type"]; id: number }) => ({
    tabIndex: 0,
    onClick: () => navigate(docLink(row.type, row.id)),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && e.target === e.currentTarget) navigate(docLink(row.type, row.id));
    },
    className: "cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-none",
  });
}

function NumberCell({ number }: { number: string | null }) {
  return number ? <span className="tabular font-medium">{number}</span> : <span className="text-muted-foreground">Entwurf</span>;
}

function OverdueSection({ rows, total }: { rows: OverdueDocument[]; total: number }) {
  const rowNav = useRowNav();
  const changeStatus = useChangeDocumentStatus();
  const markPaid = (row: OverdueDocument) =>
    changeStatus.mutate(
      { id: row.id, json: { action: "paid" } },
      {
        onSuccess: () => toast.success(`${row.number} als bezahlt markiert`),
        onError: (err) => toast.error(apiErrorMessage(err)),
      },
    );

  return (
    <section>
      <SectionHeader
        title={
          <span className="flex items-center gap-2">
            Überfällig
            {total > 0 && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-danger-muted px-1.5 text-xs font-medium text-danger tabular">
                {total}
              </span>
            )}
          </span>
        }
      >
        {total > rows.length && (
          <AllLink to="/invoices" search={{ status: "overdue" }}>
            Alle {total} anzeigen
          </AllLink>
        )}
      </SectionHeader>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={th}>Nummer</TableHead>
              <TableHead className={th}>Kunde</TableHead>
              <TableHead className={th}>Fällig</TableHead>
              <TableHead className={cn(th, "text-right")}>Tage überfällig</TableHead>
              <TableHead className={cn(th, "text-right")}>Brutto</TableHead>
              <TableHead className={cn(th, "w-0")} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} {...rowNav(row)}>
                <TableCell className="py-2">
                  <span className="inline-flex items-center gap-1.5">
                    <NumberCell number={row.number} />
                    {row.partial && <PartialLabel />}
                  </span>
                </TableCell>
                <TableCell className="max-w-64 truncate py-2">{row.clientName}</TableCell>
                <TableCell className="py-2 tabular text-danger">{formatDate(row.dueDate)}</TableCell>
                <TableCell className="py-2 text-right tabular">{row.daysOverdue}</TableCell>
                <TableCell className="py-2 text-right tabular">
                  {formatCents(row.grossCents)}
                  {row.openCents !== row.grossCents && (
                    <div className="text-xs text-muted-foreground">offen {formatCents(row.openCents)}</div>
                  )}
                </TableCell>
                <TableCell className="py-1.5 text-right whitespace-nowrap">
                  <RemindButton invoiceId={row.id} className="mr-2" />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={changeStatus.isPending && changeStatus.variables?.id === row.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      markPaid(row);
                    }}
                  >
                    <Check />
                    Als bezahlt markieren
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && <EmptyRow colSpan={6}>Keine überfälligen Rechnungen.</EmptyRow>}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function RecentSection({ rows, today }: { rows: DashboardDocument[]; today: string }) {
  const rowNav = useRowNav();
  return (
    <section className="min-w-0">
      <SectionHeader title="Zuletzt bearbeitet" />
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={th}>Beleg</TableHead>
              <TableHead className={th}>Kunde</TableHead>
              <TableHead className={cn(th, "text-right")}>Brutto</TableHead>
              <TableHead className={th}>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} {...rowNav(row)}>
                <TableCell className="py-2">
                  {row.number ? (
                    <span className="tabular font-medium">{row.number}</span>
                  ) : (
                    <span className="text-muted-foreground">{DOCUMENT_TYPE_LABELS[row.type]}-Entwurf</span>
                  )}
                </TableCell>
                <TableCell className="max-w-44 truncate py-2">{row.clientName}</TableCell>
                <TableCell className="py-2 text-right tabular">{formatCents(row.grossCents)}</TableCell>
                <TableCell className="py-2">
                  <StatusBadge status={row.status} overdue={isOverdue(row, today)} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function OpenOffersSection({ rows, total, today }: { rows: DashboardDocument[]; total: number; today: string }) {
  const rowNav = useRowNav();
  return (
    <section className="min-w-0">
      <SectionHeader title="Offene Angebote">
        {total > rows.length && <AllLink to="/offers">Alle {total} anzeigen</AllLink>}
      </SectionHeader>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={th}>Nummer</TableHead>
              <TableHead className={th}>Kunde</TableHead>
              <TableHead className={th}>Gültig bis</TableHead>
              <TableHead className={cn(th, "text-right")}>Brutto</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} {...rowNav(row)}>
                <TableCell className="py-2">
                  <NumberCell number={row.number} />
                </TableCell>
                <TableCell className="max-w-44 truncate py-2">{row.clientName}</TableCell>
                <TableCell className="py-2 tabular">
                  {row.validUntil ? (
                    <span className={cn(row.validUntil < today && "text-muted-foreground")}>
                      {formatDate(row.validUntil)}
                      {row.validUntil < today && <span className="ml-1.5 text-xs">(abgelaufen)</span>}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/60">–</span>
                  )}
                </TableCell>
                <TableCell className="py-2 text-right tabular">{formatCents(row.grossCents)}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && <EmptyRow colSpan={4}>Keine offenen Angebote.</EmptyRow>}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

// ── Empty states ────────────────────────────────────────────────────────────────

function CompanyBanner() {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-warning-border bg-warning-muted px-4 py-3 text-sm text-warning">
      <span>Firmendaten sind unvollständig. Sie erscheinen auf jedem Beleg.</span>
      <Button asChild size="sm" variant="outline" className="h-7 bg-background text-xs">
        <Link to="/settings">Einstellungen öffnen</Link>
      </Button>
    </div>
  );
}

function Onboarding({ setup }: { setup: Dashboard["setup"] }) {
  const steps = [
    {
      done: !setup.companyMissing,
      icon: Building2,
      title: "Firmendaten hinterlegen",
      text: "Name, Adresse, UID und Bankverbindung für Ihre Belege.",
      action: <Link to="/settings">Einstellungen</Link>,
    },
    {
      done: setup.hasClients,
      icon: Users,
      title: "Ersten Kunden anlegen",
      text: "Kunden aus Österreich, der EU oder einem Drittland.",
      action: <Link to="/clients/new">Kunde anlegen</Link>,
    },
    {
      done: false,
      icon: Receipt,
      title: "Erste Rechnung schreiben",
      text: (
        <>
          Oder zuerst ein{" "}
          <Link to="/offers/new" className="underline underline-offset-2 hover:text-foreground">
            Angebot erstellen
          </Link>{" "}
          und später umwandeln.
        </>
      ),
      action: <Link to="/invoices/new">Rechnung erstellen</Link>,
    },
  ];
  return (
    <div className="mx-auto max-w-xl py-8">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-secondary">
          <FileText className="size-5 text-muted-foreground" />
        </div>
        <h2 className="text-base font-semibold">Willkommen bei nesev</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Noch keine Belege vorhanden. In drei Schritten zur ersten Rechnung.
        </p>
        <button
          type="button"
          onClick={tour.start}
          className="mt-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Rundgang durch nesev starten
        </button>
      </div>
      <ol className="divide-y rounded-lg border">
        {steps.map((s, i) => (
          <li key={s.title} className="flex items-center gap-4 p-4">
            <div
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-full border text-xs font-medium",
                s.done ? "border-success-border bg-success-muted text-success" : "text-muted-foreground",
              )}
            >
              {s.done ? <Check className="size-4" /> : i + 1}
            </div>
            <div className="min-w-0 flex-1">
              <div className={cn("text-sm font-medium", s.done && "text-muted-foreground line-through decoration-muted-foreground/40")}>
                {s.title}
              </div>
              <div className="text-xs text-muted-foreground">{s.text}</div>
            </div>
            {!s.done && (
              <Button asChild size="sm" variant={i === steps.findIndex((x) => !x.done) ? "default" : "outline"}>
                {s.action}
              </Button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
