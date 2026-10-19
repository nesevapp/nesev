import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatCents } from "@shared/money";
import { MONTHS } from "@/components/charts/chart-utils";
import { ColumnChart, type ColumnSeries } from "@/components/charts/column-chart";
import { Button } from "@/components/ui/button";
import type { ExpenseListItem } from "@/sdk";

const SERIES: ColumnSeries[] = [{ key: "gross", label: "Brutto", fill: "fill-chart-expenses", swatch: "bg-chart-expenses" }];

/**
 * Brutto per month by Belegdatum, from the rows the list shows (follows the filters). One year at a time: the year
 * of the newest row; when the rows span several years a small switcher steps through the years that have rows.
 */
export function ExpenseMonthChart({ rows }: { rows: readonly ExpenseListItem[] }) {
  const [picked, setPicked] = useState<number | null>(null);
  const years = [...new Set(rows.map((e) => Number(e.issueDate.slice(0, 4))).filter((y) => y > 0))].sort((a, b) => a - b);
  if (years.length === 0) return null;
  const year = picked !== null && years.includes(picked) ? picked : years.at(-1)!;
  const idx = years.indexOf(year);

  const months = MONTHS.map(() => ({ gross: 0, net: 0 }));
  for (const e of rows) {
    if (Number(e.issueDate.slice(0, 4)) !== year) continue;
    const m = months[Number(e.issueDate.slice(5, 7)) - 1];
    if (!m) continue;
    m.gross += e.grossCents;
    m.net += e.netCents;
  }
  const groups = months.map((m, i) => ({
    label: MONTHS[i]!,
    shortLabel: MONTHS[i]!.slice(0, 1),
    title: `${MONTHS[i]} ${year}`,
    values: { gross: m.gross },
    extra: [{ label: "Netto", cents: m.net }],
  }));
  const yearGross = months.reduce((s, m) => s + m.gross, 0);

  return (
    <div className="mb-4 rounded-lg border p-4 pb-2">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <p>
          Brutto pro Monat nach Belegdatum
          {years.length > 1 && <span className="tabular"> · {year}: {formatCents(yearGross)}</span>}
        </p>
        {years.length > 1 ? (
          <div className="flex items-center rounded-md border">
            <Button variant="ghost" size="icon" className="size-6 rounded-r-none" disabled={idx === 0} onClick={() => setPicked(years[idx - 1]!)} aria-label="Vorjahr">
              <ChevronLeft />
            </Button>
            <span className="w-11 text-center font-medium text-foreground tabular" aria-live="polite">
              {year}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 rounded-l-none"
              disabled={idx === years.length - 1}
              onClick={() => setPicked(years[idx + 1]!)}
              aria-label="Nächstes Jahr"
            >
              <ChevronRight />
            </Button>
          </div>
        ) : (
          <span className="font-medium text-foreground tabular">{year}</span>
        )}
      </div>
      <ColumnChart groups={groups} series={SERIES} height={140} ariaLabel={`Ausgaben brutto pro Monat ${year}`} />
    </div>
  );
}
