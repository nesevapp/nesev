import { useState } from "react";
import { formatCents } from "@shared/money";
import { CHART_COLORS, columnPath, compactEuro, euroAxis, niceStep, useWidth } from "@/components/charts/chart-utils";
import { cn } from "@/lib/utils";
import type { ChatCard, ChatTone } from "@/sdk";

// Small chart for assistant cards, in the visual language of the dashboard / forecast charts (rounded columns,
// light grid, € axis, hover/focus tooltip per label) but compact for the side panel: compact € axis, no x-label
// collisions, legend below when there is more than one series.

type ChartCardData = Extract<ChatCard, { kind: "chart" }>;
type Series = ChartCardData["series"][number];

/** ChatTone → chart color (bars, lines, legend swatches). */
export const TONE_COLOR: Record<ChatTone, string> = {
  revenue: CHART_COLORS.revenue,
  expenses: CHART_COLORS.expenses,
  result: CHART_COLORS.result,
  // like the forecast: inflow blue, outflow orange
  positive: CHART_COLORS.revenue,
  negative: CHART_COLORS.expenses,
  neutral: CHART_COLORS.neutral,
  muted: CHART_COLORS.muted,
};

const HEIGHT = 168;
const PAD = { top: 8, right: 4, bottom: 22, left: 56 };

/** "€ 8.000"; from a million on compact ("€ 1,2 Mio.") so the axis stays narrow */
const axisLabel = (cents: number) => (Math.abs(cents) >= 100_000_000 ? compactEuro : euroAxis).format(cents / 100);
const BAR_MAX = 18;
const GAP = 2;

const isLine = (s: Series, chart: ChartCardData["chart"]) => chart === "line" || s.type === "line";

export function ChatChart({ card }: { card: ChartCardData }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const { labels, series, chart } = card;
  const bars = series.filter((s) => !isLine(s, chart));
  const lines = series.filter((s) => isLine(s, chart));

  // null = no value (e.g. future months): ignored by the axis, no column, a gap in the line, "–" in the tooltip
  const values = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const step = niceStep(max - min);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const bottom = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let t = bottom; t <= top + step / 2; t += step) ticks.push(t);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + ((top - v) / (top - bottom)) * plotH;
  const band = labels.length ? plotW / labels.length : 0;
  const n = Math.max(1, bars.length);
  const barW = Math.max(2, Math.min(BAR_MAX, (band * 0.72 - GAP * (n - 1)) / n));
  const groupW = barW * n + GAP * (n - 1);
  const cx = (i: number) => PAD.left + band * i + band / 2;
  // keep x labels ≥ 34px apart
  const labelEvery = Math.max(1, Math.ceil(34 / Math.max(1, band)));
  // a line-only chart with a single series gets the forecast's soft area
  const area = bars.length === 0 && lines.length === 1;

  const show = (v: number | null | undefined) => (v == null ? "–" : formatCents(v));
  const aria = (i: number) => `${labels[i]}: ${series.map((s) => `${s.label} ${show(s.values[i])}`).join(", ")}`;

  return (
    <div className="space-y-1.5">
      <div ref={ref} className="relative" onPointerLeave={() => setActive(null)}>
        {width > 0 && (
          <svg width={width} height={HEIGHT} role="img" aria-label={card.title} className="block">
            {/* below zero, like the forecast's balance chart */}
            {area && bottom < 0 && <rect x={PAD.left} y={y(0)} width={plotW} height={y(bottom) - y(0)} className="fill-danger-muted dark:fill-danger-muted/50" />}
            {ticks.map((t) => (
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
                <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular">
                  {axisLabel(t)}
                </text>
              </g>
            ))}
            {labels.map((label, i) => {
              const x0 = cx(i) - groupW / 2;
              return (
                <g key={i}>
                  {active === i && <rect x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} className="fill-muted/70" />}
                  {bars.map((s, k) => {
                    const v = s.values[i];
                    return v == null ? null : (
                      <path
                        key={k}
                        d={columnPath(x0 + k * (barW + GAP), barW, y(0), y(v))}
                        style={{ fill: TONE_COLOR[s.tone] }}
                        className={cn(active !== null && active !== i && "opacity-60")}
                      />
                    );
                  })}
                  {i % labelEvery === 0 && (
                    <text x={cx(i)} y={HEIGHT - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                      {label}
                    </text>
                  )}
                </g>
              );
            })}
            {lines.map((s, k) => {
              // runs of consecutive values; a null breaks the line
              const runs: { i: number; x: number; y: number }[][] = [];
              let run: { i: number; x: number; y: number }[] = [];
              labels.forEach((_, i) => {
                const v = s.values[i];
                if (v == null) {
                  if (run.length) runs.push(run);
                  run = [];
                } else run.push({ i, x: cx(i), y: y(v) });
              });
              if (run.length) runs.push(run);
              const pathOf = (r: typeof run) => r.map((p, j) => `${j ? "L" : "M"}${p.x},${p.y}`).join("");
              const color = TONE_COLOR[s.tone];
              const dots = labels.length <= 16;
              return (
                <g key={k} className="pointer-events-none">
                  {area &&
                    runs.map((r, j) => (
                      <path key={j} d={`${pathOf(r)}L${r.at(-1)!.x},${y(0)}L${r[0]!.x},${y(0)}Z`} style={{ fill: color }} fillOpacity={0.07} />
                    ))}
                  {runs.map((r, j) => (
                    <path key={j} d={pathOf(r)} fill="none" style={{ stroke: color }} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
                  ))}
                  {runs.flat().map((p) =>
                    // a lone value has no line through it: always draw its dot
                    dots || active === p.i || runs.some((r) => r.length === 1 && r[0] === p) ? (
                      <circle key={p.i} cx={p.x} cy={p.y} r={active === p.i ? 3.5 : 2.25} className="fill-background" style={{ stroke: color }} strokeWidth={1.5} />
                    ) : null,
                  )}
                </g>
              );
            })}
            {labels.map((_, i) => (
              // hit target: the whole label band (drawn last so lines don't block it)
              <rect
                key={i}
                x={PAD.left + band * i}
                y={0}
                width={band}
                height={HEIGHT}
                fill="transparent"
                tabIndex={0}
                aria-label={aria(i)}
                onPointerEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                className="outline-none"
              />
            ))}
          </svg>
        )}
        {active !== null && (
          <div
            className="pointer-events-none absolute z-10 rounded-md border bg-popover px-2.5 py-1.5 text-xs whitespace-nowrap shadow-md"
            // the panel is narrow: pin the tooltip to the half away from the hovered band
            style={cx(active) < width / 2 ? { right: PAD.right, top: PAD.top } : { left: PAD.left + 4, top: PAD.top }}
          >
            <div className="mb-1 text-muted-foreground">{labels[active]}</div>
            {series.map((s, k) => {
              const v = s.values[active];
              return (
                <div key={k} className="flex items-center gap-2">
                  <Swatch series={s} chart={chart} />
                  <span className={cn("font-medium tabular", v == null ? "text-muted-foreground" : v < 0 ? "text-danger" : "text-foreground")}>
                    {show(v)}
                  </span>
                  <span className="ml-auto pl-3 text-muted-foreground">{s.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {series.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" style={{ paddingLeft: PAD.left }}>
          {series.map((s, k) => (
            <span key={k} className="flex items-center gap-1.5">
              <Swatch series={s} chart={chart} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Swatch({ series, chart }: { series: Series; chart: ChartCardData["chart"] }) {
  return (
    <span
      className={isLine(series, chart) ? "h-0.5 w-3 shrink-0 rounded-full" : "size-2.5 shrink-0 rounded-[3px]"}
      style={{ background: TONE_COLOR[series.tone] }}
    />
  );
}
