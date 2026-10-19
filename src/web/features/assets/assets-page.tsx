import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Download, Plus } from "lucide-react";
import { formatAssetNumber } from "@shared/assets";
import { formatDate } from "@shared/dates";
import { formatCents } from "@shared/money";
import { ColumnChart, ColumnLegend, type ColumnSeries } from "@/components/charts/column-chart";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { assetRegisterCsvUrl, assetRegisterQuery } from "@/sdk";
import { AssetFormDialog } from "./components/asset-form-dialog";

const th = "h-9 text-xs font-medium text-muted-foreground";

/** Anlagenverzeichnis of a year: cost, AfA of the year, book values; year switcher and totals. */
export function AssetsPage({ year, setYear }: { year?: number; setYear: (year: number | undefined) => void }) {
  const { data, isFetching } = useQuery(assetRegisterQuery(year));
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  if (!data) return null;
  const t = data.totals;

  return (
    <Page
      title="Anlagen"
      description="Anlagenverzeichnis und Abschreibungen (AfA) für Anlagegüter über 1.000 € netto."
      actions={
        <>
          <Button variant="outline" size="sm" asChild>
            <a href={assetRegisterCsvUrl(data.year)} download>
              <Download /> CSV
            </a>
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> Neue Anlage
          </Button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
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
        <div className="flex gap-6 text-sm">
          <Figure label={`AfA ${data.year}`} cents={t.afaCents + t.disposalCents} />
          <Figure label={`Buchwert 31.12.${data.year}`} cents={t.endCents} />
        </div>
      </div>

      <HalfYearChart year={data.year} halves={data.halves} />

      <div className={cn("rounded-lg border transition-opacity", isFetching && "opacity-70")}>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(th, "w-24")}>Nr.</TableHead>
              <TableHead className={th}>Bezeichnung</TableHead>
              <TableHead className={th}>Inbetriebnahme</TableHead>
              <TableHead className={cn(th, "text-right")}>AK</TableHead>
              <TableHead className={cn(th, "text-right")}>ND</TableHead>
              <TableHead className={cn(th, "text-right")}>Buchwert 1.1.</TableHead>
              <TableHead className={cn(th, "text-right")}>AfA {data.year}</TableHead>
              <TableHead className={cn(th, "text-right")}>Buchwert 31.12.</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="py-16 text-center text-sm text-muted-foreground">
                  Keine Anlagen im Jahr {data.year}.{" "}
                  <button type="button" className="underline underline-offset-2" onClick={() => setCreating(true)}>
                    Anlage anlegen
                  </button>{" "}
                  oder bei einer Ausgabe mit Kategorie „Anlagegüter“ übernehmen.
                </TableCell>
              </TableRow>
            )}
            {data.rows.map((r) => (
              <TableRow key={r.id} className="cursor-pointer" onClick={() => void navigate({ to: "/assets/$id", params: { id: r.id } })}>
                <TableCell className="py-2 tabular">
                  <Link to="/assets/$id" params={{ id: r.id }} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                    {formatAssetNumber(r.number)}
                  </Link>
                </TableCell>
                <TableCell className="max-w-72 py-2">
                  <span className="flex items-center gap-2">
                    <span className="truncate">{r.name}</span>
                    {r.disposedThisYear && (
                      <span className="inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-xs text-muted-foreground">
                        ausgeschieden {formatDate(r.disposalDate)}
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell className="py-2 tabular">{formatDate(r.inServiceDate)}</TableCell>
                <TableCell className="py-2 text-right tabular">{formatCents(r.costCents)}</TableCell>
                <TableCell className="py-2 text-right tabular">{r.usefulLifeYears} J.</TableCell>
                <TableCell className="py-2 text-right tabular">{formatCents(r.startCents)}</TableCell>
                <TableCell className="py-2 text-right tabular" title={r.disposalCents ? `davon Restbuchwert-Abgang ${formatCents(r.disposalCents)}` : undefined}>
                  {formatCents(r.afaCents + r.disposalCents)}
                </TableCell>
                <TableCell className="py-2 text-right tabular">{formatCents(r.endCents)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          {data.rows.length > 0 && (
            <TableFooter>
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3} className="py-2.5 text-xs font-normal text-muted-foreground">
                  {data.rows.length} {data.rows.length === 1 ? "Anlage" : "Anlagen"}
                </TableCell>
                <TableCell className="py-2.5 text-right tabular">{formatCents(t.costCents)}</TableCell>
                <TableCell />
                <TableCell className="py-2.5 text-right tabular">{formatCents(t.startCents)}</TableCell>
                <TableCell className="py-2.5 text-right tabular">{formatCents(t.afaCents + t.disposalCents)}</TableCell>
                <TableCell className="py-2.5 text-right tabular">{formatCents(t.endCents)}</TableCell>
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </div>

      <div className="mt-3 space-y-1 text-xs text-muted-foreground">
        {t.disposalCents > 0 && <p>AfA {data.year} enthält {formatCents(t.disposalCents)} Restbuchwert ausgeschiedener Anlagen.</p>}
        {t.proceedsCents > 0 && <p>Erlöse aus Anlagenverkauf {data.year}: {formatCents(t.proceedsCents)} — als Einnahme erfassen.</p>}
        {data.hiddenCount > 0 && (
          <p>
            {data.hiddenCount} weitere {data.hiddenCount === 1 ? "Anlage ist" : "Anlagen sind"} erst später in Betrieb oder schon vor {data.year} ausgeschieden.
          </p>
        )}
      </div>

      <p className="mt-12 border-t pt-4 text-xs text-muted-foreground">
        Lineare AfA nach § 7 EStG mit Halbjahresregel, als Hilfe für die Einnahmen-Ausgaben-Rechnung — keine Steuerberatung. Nutzungsdauer,
        Anschaffungskosten und Sonderfälle (PKW-Angemessenheitsgrenze, Privatanteile, Investitionsfreibetrag, degressive AfA) mit der
        Steuerberatung klären.
      </p>

      <AssetFormDialog open={creating} onOpenChange={setCreating} onSaved={(a) => void navigate({ to: "/assets/$id", params: { id: a.id } })} />
    </Page>
  );
}

const HALF_SERIES: ColumnSeries[] = [
  { key: "additions", label: "Zugänge", fill: "fill-chart-neutral", swatch: "bg-chart-neutral" },
  { key: "afa", label: "AfA", fill: "fill-chart-afa", swatch: "bg-chart-afa" },
];

/** Zugänge (cost by Inbetriebnahme) and AfA per half-year; hidden when the year has neither. */
function HalfYearChart({ year, halves }: { year: number; halves: { additionsCents: number; afaCents: number }[] }) {
  if (!halves.some((h) => h.additionsCents || h.afaCents)) return null;
  const groups = halves.map((h, i) => ({
    label: i === 0 ? "1. Halbjahr" : "2. Halbjahr",
    title: i === 0 ? `1. Halbjahr ${year} (Jän–Jun)` : `2. Halbjahr ${year} (Jul–Dez)`,
    values: { additions: h.additionsCents, afa: h.afaCents },
  }));
  return (
    <div className="mb-4 rounded-lg border p-4 pb-2">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <p className="text-xs text-muted-foreground">Zugänge nach Inbetriebnahme, AfA {year} je Halbjahr</p>
        <ColumnLegend series={HALF_SERIES} />
      </div>
      <ColumnChart groups={groups} series={HALF_SERIES} height={150} barMax={40} ariaLabel={`Zugänge und AfA ${year} pro Halbjahr`} />
    </div>
  );
}

function Figure({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="text-right">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium tabular">{formatCents(cents)}</div>
    </div>
  );
}
