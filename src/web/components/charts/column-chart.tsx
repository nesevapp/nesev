import { useState } from "react";
import { formatCents } from "@shared/money";
import { cn } from "@/lib/utils";
import { columnPath, euroAxis, niceStep, useWidth } from "./chart-utils";

// Small grouped column chart (cents, values ≥ 0) in the look of the dashboard chart: one band per group
// (month, half-year, …), one column per series, hover/focus tooltip beside the band. Used on the Anlagen and
// Ausgaben pages; the legend is rendered by the caller with ColumnLegend.

export interface ColumnSeries {
  key: string;
  label: string;
  /** Tailwind fill class, e.g. fill-chart-expenses */
  fill: string;
  /** Tailwind background class for legend/tooltip swatches, e.g. bg-chart-expenses */
  swatch: string;
}

export interface ColumnGroup {
  label: string;
  /** axis label when the band is too narrow for `label` (e.g. "J" for "Jän") */
  shortLabel?: string;
  /** label in the tooltip and aria (default: label) */
  title?: string;
  values: Record<string, number>;
  /** extra tooltip rows below the series (no column) */
  extra?: { label: string; cents: number }[];
}

const PAD = { top: 8, right: 0, bottom: 24, left: 64 };
const GAP = 2;

export function ColumnChart({
  groups,
  series,
  ariaLabel,
  height = 150,
  barMax = 24,
}: {
  groups: ColumnGroup[];
  series: ColumnSeries[];
  ariaLabel: string;
  height?: number;
  barMax?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const max = Math.max(0, ...groups.flatMap((g) => series.map((s) => g.values[s.key] ?? 0)));
  const step = niceStep(max);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(t);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + ((top - v) / top) * plotH;
  const band = plotW / Math.max(1, groups.length);
  const n = series.length;
  const barW = Math.max(1, Math.min(barMax, (band * 0.75 - GAP * (n - 1)) / n));
  const groupW = barW * n + GAP * (n - 1);
  const cx = (i: number) => PAD.left + band * i + band / 2;
  const half = groups.length / 2;

  const g = active === null ? null : groups[active];
  const aria = (grp: ColumnGroup) =>
    `${grp.title ?? grp.label}: ${[...series.map((s) => [s.label, grp.values[s.key] ?? 0] as const), ...(grp.extra ?? []).map((e) => [e.label, e.cents] as const)]
      .map(([label, cents]) => `${label} ${formatCents(cents)}`)
      .join(", ")}`;

  return (
    <div ref={ref} className="relative" onPointerLeave={() => setActive(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
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
              <text x={PAD.left - 12} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular">
                {euroAxis.format(t / 100)}
              </text>
            </g>
          ))}
          {groups.map((grp, i) => (
            <g key={grp.label}>
              {active === i && <rect x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} className="fill-muted/70" />}
              {series.map((s, k) => (
                <path
                  key={s.key}
                  d={columnPath(cx(i) - groupW / 2 + k * (barW + GAP), barW, y(0), y(grp.values[s.key] ?? 0))}
                  className={cn(s.fill, active !== null && active !== i && "opacity-60")}
                />
              ))}
              <text x={cx(i)} y={height - 8} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                {band < 32 && grp.shortLabel ? grp.shortLabel : grp.label}
              </text>
            </g>
          ))}
          {groups.map((grp, i) => (
            <rect
              key={grp.label}
              x={PAD.left + band * i}
              y={0}
              width={band}
              height={height}
              fill="transparent"
              tabIndex={0}
              aria-label={aria(grp)}
              onPointerEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              className="outline-none"
            />
          ))}
        </svg>
      )}
      {g && active !== null && (
        <div
          className="pointer-events-none absolute z-10 min-w-40 rounded-md border bg-popover px-3 py-2 text-xs shadow-md"
          style={
            active < half
              ? { left: PAD.left + band * (active + 1) + 4, top: PAD.top }
              : { right: width - (PAD.left + band * active) + 4, top: PAD.top }
          }
        >
          <div className="mb-1 text-muted-foreground">{g.title ?? g.label}</div>
          {series.map((s) => (
            <Row key={s.key} swatch={s.swatch} label={s.label} cents={g.values[s.key] ?? 0} />
          ))}
          {g.extra?.map((e) => <Row key={e.label} swatch="bg-transparent" label={e.label} cents={e.cents} />)}
        </div>
      )}
    </div>
  );
}

function Row({ swatch, label, cents }: { swatch: string; label: string; cents: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn("h-0.5 w-3 rounded-full", swatch)} />
      <span className="font-medium text-foreground tabular">{formatCents(cents)}</span>
      <span className="ml-auto pl-3 whitespace-nowrap text-muted-foreground">{label}</span>
    </div>
  );
}

export function ColumnLegend({ series }: { series: ColumnSeries[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className={cn("size-2.5 rounded-[3px]", s.swatch)} />
          {s.label}
        </span>
      ))}
    </div>
  );
}
