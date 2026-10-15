import { useState } from "react";
import { formatCents } from "@shared/money";
import { CHART_COLORS, columnPath, compactEuro, euroAxis as euro, niceStep, useWidth } from "@/components/charts/chart-utils";
import { cn } from "@/lib/utils";
import { type ForecastSource } from "@/sdk";

// Per period two stacked columns: expected inflow (blue family, left) and outflow (orange family, right), one
// color per source in a fixed order with a 2px surface gap between segments. Below, a slim line chart on the
// same x bands: the projected account balance (when a start balance is set) or the running net. Two charts
// instead of a second y-axis: the balance dwarfs the per-period values. Hover/focus syncs both; click selects.

export const IN_SOURCES: ForecastSource[] = ["invoice", "recurring", "offer", "draft", "vat"];
export const OUT_SOURCES: ForecastSource[] = ["fixed_cost", "expense", "vat", "income_tax"];

export const SOURCE_META: Record<ForecastSource, { label: string; color: string; bg: string }> = {
  invoice: { label: "Offene Rechnungen", color: CHART_COLORS.revenue, bg: "bg-chart-revenue" },
  recurring: { label: "Serienrechnungen", color: "#5b4fcf", bg: "bg-[#5b4fcf]" },
  offer: { label: "Angebote (gewichtet)", color: "#1baf7a", bg: "bg-[#1baf7a]" },
  draft: { label: "Entwürfe", color: CHART_COLORS.revenueLight, bg: "bg-chart-revenue-light" },
  fixed_cost: { label: "Fixkosten", color: CHART_COLORS.expenses, bg: "bg-chart-expenses" },
  expense: { label: "Offene Ausgaben", color: "#f5b583", bg: "bg-[#f5b583]" },
  vat: { label: "Umsatzsteuer", color: "#c2410c", bg: "bg-[#c2410c]" },
  income_tax: { label: "ESt-Vorauszahlung", color: "#7c2d12", bg: "bg-[#7c2d12]" },
};

export interface ChartColumn {
  key: string;
  label: string;
  /** long label for tooltip / aria */
  title: string;
  /** cents per source, split by direction (VAT can be either) */
  inBySource: Partial<Record<ForecastSource, number>>;
  outBySource: Partial<Record<ForecastSource, number>>;
  inCents: number;
  outCents: number;
  netCents: number;
  taxCents: number;
  /** line value: balance at the end of the period, or the running net without a start balance */
  lineCents: number;
  /** lowest balance within the period (null without a start balance) */
  minBalanceCents: number | null;
  /** period (absent for the overdue column) */
  start?: string;
  end?: string;
  overdue?: boolean;
}

const HEIGHT = 240;
const LINE_HEIGHT = 112;
const PAD = { top: 12, right: 8, bottom: 26, left: 72 };
const BAR_MAX = 22;
const GAP = 3;
const SEG_GAP = 2;

function ticksFor(max: number) {
  const step = niceStep(max);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(t);
  return { top, ticks };
}

export function ForecastChart({
  columns,
  selected,
  onSelect,
  showOut,
  balance,
}: {
  columns: ChartColumn[];
  selected: string | null;
  onSelect: (key: string | null) => void;
  /** draw outflow columns */
  showOut: boolean;
  /** the line is the account balance (else: running net) */
  balance: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const band = columns.length ? plotW / columns.length : 0;
  const n = showOut ? 2 : 1;
  const barW = Math.max(3, Math.min(BAR_MAX, (band * 0.7 - GAP * (n - 1)) / n));
  const groupW = barW * n + GAP * (n - 1);
  // keep x labels ≥ 52px apart
  const labelEvery = Math.max(1, Math.ceil(52 / Math.max(1, band)));

  const main = ticksFor(Math.max(0, ...columns.map((c) => Math.max(c.inCents, showOut ? c.outCents : 0))));
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + (1 - v / main.top) * plotH;

  // line chart: may go below zero
  const lineVals = columns.flatMap((c) => [c.lineCents, c.minBalanceCents ?? c.lineCents]);
  const lMax = Math.max(0, ...lineVals);
  const lMin = Math.min(0, ...lineVals);
  const lStep = niceStep(lMax - lMin || 1);
  const lTop = Math.max(lMax > 0 ? lStep : 0, Math.ceil(lMax / lStep) * lStep);
  const lBottom = Math.floor(lMin / lStep) * lStep;
  const linePlotH = LINE_HEIGHT - 16;
  const yl = (v: number) => 8 + ((lTop - v) / (lTop - lBottom || 1)) * linePlotH;
  const cx = (i: number) => PAD.left + band * i + band / 2;

  const activeCol = active === null ? null : columns[active];
  const linePath = columns.map((c, i) => `${i ? "L" : "M"}${cx(i)},${yl(c.lineCents)}`).join("");
  const areaPath = columns.length ? `${linePath}L${cx(columns.length - 1)},${yl(0)}L${cx(0)},${yl(0)}Z` : "";
  const last = columns.at(-1);
  const lineLabel = balance ? "Kontostand" : "Saldo kumuliert";

  const hitTargets = (h: number) =>
    columns.map((c, i) => (
      <rect
        key={c.key}
        x={PAD.left + band * i}
        y={0}
        width={band}
        height={h}
        fill="transparent"
        className="cursor-pointer outline-none"
        tabIndex={h === HEIGHT ? 0 : -1}
        aria-label={
          h === HEIGHT
            ? `${c.title}: Eingänge ${formatCents(c.inCents)}${showOut ? `, Ausgänge ${formatCents(c.outCents)}` : ""}, ${lineLabel} ${formatCents(c.lineCents)}`
            : undefined
        }
        onPointerEnter={() => setActive(i)}
        onFocus={() => setActive(i)}
        onBlur={() => setActive(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(selected === c.key ? null : c.key);
          }
        }}
        onClick={() => onSelect(selected === c.key ? null : c.key)}
      />
    ));

  const stack = (x0: number, bySource: Partial<Record<ForecastSource, number>>, order: ForecastSource[]) => {
    let acc = 0;
    const segs = order.filter((s) => (bySource[s] ?? 0) > 0);
    return segs.map((s, si) => {
      const yBottom = y(acc) - (si > 0 ? SEG_GAP / 2 : 0);
      acc += bySource[s]!;
      const isTop = si === segs.length - 1;
      const yTop = y(acc) + (isTop ? 0 : SEG_GAP / 2);
      if (yBottom - yTop < 0.5) return null;
      return isTop ? (
        <path key={s} d={columnPath(x0, barW, yBottom, yTop)} style={{ fill: SOURCE_META[s].color }} />
      ) : (
        <rect key={s} x={x0} y={yTop} width={barW} height={yBottom - yTop} style={{ fill: SOURCE_META[s].color }} />
      );
    });
  };

  return (
    <div ref={ref} className="relative" onPointerLeave={() => setActive(null)}>
      {width > 0 && (
        <>
          <svg width={width} height={HEIGHT} role="img" aria-label="Erwartete Zahlungsein- und -ausgänge pro Zeitraum" className="block">
            {main.ticks.map((t) => (
              <g key={t}>
                <line
                  x1={PAD.left}
                  x2={width - PAD.right}
                  y1={y(t)}
                  y2={y(t)}
                  className={t === 0 ? "stroke-chart-muted" : "stroke-chart-grid"}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text x={PAD.left - 12} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular">
                  {euro.format(t / 100)}
                </text>
              </g>
            ))}
            {columns.map((c, i) => {
              const x0 = cx(i) - groupW / 2;
              const dim = (active !== null && active !== i) || (selected !== null && selected !== c.key);
              return (
                <g key={c.key} className={cn("transition-opacity", dim && "opacity-45")}>
                  {(active === i || selected === c.key) && (
                    <rect x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} className="fill-muted/70" />
                  )}
                  {stack(x0, c.inBySource, IN_SOURCES)}
                  {showOut && stack(x0 + barW + GAP, c.outBySource, OUT_SOURCES)}
                  {(i % labelEvery === 0 || c.overdue) && (
                    <text
                      x={cx(i)}
                      y={HEIGHT - 8}
                      textAnchor="middle"
                      className={cn("text-[11px]", c.overdue ? "fill-danger" : "fill-muted-foreground")}
                    >
                      {c.label}
                    </text>
                  )}
                </g>
              );
            })}
            {columns[0]?.overdue && columns.length > 1 && (
              <line
                x1={PAD.left + band}
                x2={PAD.left + band}
                y1={PAD.top}
                y2={HEIGHT - PAD.bottom}
                className="stroke-border"
                shapeRendering="crispEdges"
              />
            )}
            {hitTargets(HEIGHT)}
          </svg>

          <div className="mt-3 flex items-baseline justify-between border-t pt-2 text-xs text-muted-foreground" style={{ paddingLeft: PAD.left }}>
            <span>{balance ? "Erwarteter Kontostand (Ende des Zeitraums)" : "Saldo kumuliert (Eingänge − Ausgänge)"}</span>
          </div>
          <svg width={width} height={LINE_HEIGHT} aria-hidden className="block">
            {lBottom < 0 && (
              <rect x={PAD.left} y={yl(0)} width={plotW} height={yl(lBottom) - yl(0)} className="fill-danger-muted" />
            )}
            {[lTop, lBottom].filter((t) => t !== 0).map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={yl(t)} y2={yl(t)} className="stroke-chart-grid" shapeRendering="crispEdges" />
                <text x={PAD.left - 12} y={yl(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular">
                  {compactEuro.format(t / 100)}
                </text>
              </g>
            ))}
            <line x1={PAD.left} x2={width - PAD.right} y1={yl(0)} y2={yl(0)} className="stroke-chart-muted" shapeRendering="crispEdges" />
            <text x={PAD.left - 12} y={yl(0)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular">
              0 €
            </text>
            {active !== null && <line x1={cx(active)} x2={cx(active)} y1={8} y2={LINE_HEIGHT - 8} className="stroke-chart-muted" />}
            <path d={areaPath} className="fill-chart-result/[0.06]" />
            <path d={linePath} fill="none" className="stroke-chart-result" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {columns.map((c, i) => {
              const low = (c.minBalanceCents ?? c.lineCents) < 0;
              if (!low && active !== i) return null;
              return (
                <circle
                  key={c.key}
                  cx={cx(i)}
                  cy={yl(c.lineCents)}
                  r={active === i ? 4 : 3}
                  className={cn(low ? "fill-danger" : "fill-chart-result", "stroke-background")}
                  strokeWidth={2}
                />
              );
            })}
            {last && active === null && (
              <>
                <circle cx={cx(columns.length - 1)} cy={yl(last.lineCents)} r={4} className={cn(last.lineCents < 0 ? "fill-danger" : "fill-chart-result", "stroke-background")} strokeWidth={2} />
                <text
                  x={cx(columns.length - 1) - 10}
                  y={yl(last.lineCents) + (yl(last.lineCents) > LINE_HEIGHT - 28 ? -14 : 14)}
                  dy="0.32em"
                  textAnchor="end"
                  className={cn("text-[11px] font-medium tabular", last.lineCents < 0 ? "fill-danger" : "fill-foreground")}
                >
                  {euro.format(last.lineCents / 100)}
                </text>
              </>
            )}
            {hitTargets(LINE_HEIGHT)}
          </svg>
        </>
      )}
      {activeCol && active !== null && (
        <div
          className="pointer-events-none absolute z-10 min-w-56 rounded-md border bg-popover px-3 py-2 text-xs shadow-md"
          style={
            cx(active) < width / 2
              ? { left: cx(active) + groupW / 2 + 12, top: PAD.top }
              : { right: width - cx(active) + groupW / 2 + 12, top: PAD.top }
          }
        >
          <div className="mb-1.5 font-medium text-foreground">{activeCol.title}</div>
          <TooltipGroup label="Eingänge" total={activeCol.inCents} bySource={activeCol.inBySource} order={IN_SOURCES} empty="Keine Eingänge erwartet" />
          {activeCol.taxCents > 0 && (
            <div className="flex justify-between text-muted-foreground">
              <span>davon USt.</span>
              <span className="tabular">{formatCents(activeCol.taxCents)}</span>
            </div>
          )}
          {showOut && (
            <div className="mt-1.5">
              <TooltipGroup label="Ausgänge" total={activeCol.outCents} bySource={activeCol.outBySource} order={OUT_SOURCES} empty="Keine Ausgänge erwartet" />
            </div>
          )}
          <div className="mt-1.5 space-y-0.5 border-t pt-1.5">
            {showOut && <TooltipTotal label="Saldo" cents={activeCol.netCents} />}
            <TooltipTotal label={balance ? "Kontostand am Ende" : "Saldo kumuliert"} cents={activeCol.lineCents} strong />
            {activeCol.minBalanceCents !== null && activeCol.minBalanceCents < activeCol.lineCents && (
              <TooltipTotal label="Tiefster Stand" cents={activeCol.minBalanceCents} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TooltipGroup({
  label,
  total,
  bySource,
  order,
  empty,
}: {
  label: string;
  total: number;
  bySource: Partial<Record<ForecastSource, number>>;
  order: ForecastSource[];
  empty: string;
}) {
  const rows = order.filter((s) => (bySource[s] ?? 0) > 0);
  return (
    <div>
      <div className="flex justify-between font-medium text-foreground">
        <span>{label}</span>
        <span className="tabular">{formatCents(total)}</span>
      </div>
      {rows.map((s) => (
        <div key={s} className="flex items-center gap-2">
          <span className={cn("size-2 rounded-[2px]", SOURCE_META[s].bg)} />
          <span className="text-muted-foreground">{SOURCE_META[s].label}</span>
          <span className="ml-auto pl-3 tabular text-foreground">{formatCents(bySource[s]!)}</span>
        </div>
      ))}
      {rows.length === 0 && <div className="text-muted-foreground">{empty}</div>}
    </div>
  );
}

function TooltipTotal({ label, cents, strong }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className={cn("flex justify-between", strong ? "font-medium text-foreground" : "text-muted-foreground")}>
      <span>{label}</span>
      <span className={cn("tabular", cents < 0 && "text-danger")}>{formatCents(cents)}</span>
    </div>
  );
}

export function SourceLegend({ inSources, outSources, line }: { inSources: ForecastSource[]; outSources: ForecastSource[]; line: string }) {
  const item = (s: ForecastSource) => (
    <span key={s} className="flex items-center gap-1.5">
      <span className={cn("size-2.5 rounded-[3px]", SOURCE_META[s].bg)} />
      {SOURCE_META[s].label}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {inSources.map(item)}
      {outSources.length > 0 && <span className="h-3 w-px bg-border" aria-hidden />}
      {outSources.map(item)}
      <span className="flex items-center gap-1.5">
        <span className="h-0.5 w-3 rounded-full bg-chart-result" />
        {line}
      </span>
    </div>
  );
}
