import { useLayoutEffect, useRef, useState } from "react";
import { formatCents } from "@shared/money";
import { cn } from "@/lib/utils";

// Net revenue (blue) and optionally net expenses (orange) per month as columns, plus the result
// (revenue − expenses) as a line; the previous year adds lighter comparison columns. Single axis (cents),
// hover/focus tooltip per month, the table view lives next to it in the page.

export const MONTHS = ["Jän", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

const HEIGHT = 240;
const PAD = { top: 12, right: 0, bottom: 28, left: 72 };
const BAR_MAX = 24;
const GAP = 2;
const RADIUS = 4;

const euro = new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

/** Round step (1/2/5 × 10^n) so the axis gets ~4 ticks. */
function niceStep(span: number): number {
  if (span <= 0) return 100_00;
  const raw = span / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

/** Column path with a rounded data-end and a square baseline end (works for negative values). */
function columnPath(x: number, w: number, y0: number, y1: number): string {
  const h = Math.abs(y1 - y0);
  if (h < 0.5) return "";
  const r = Math.min(RADIUS, h, w / 2);
  if (y1 < y0) {
    return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  }
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export interface MonthDatum {
  month: number;
  cents: number;
  previousCents: number;
  expenseCents: number;
  previousExpenseCents: number;
}

type ValueKey = "cents" | "previousCents" | "expenseCents" | "previousExpenseCents";

interface Series {
  key: ValueKey;
  fill: string;
  swatch: string;
  label: string;
}

export const REVENUE_FILL = "fill-[#2a78d6]";
const RESULT_STROKE = "stroke-zinc-800";

/** Columns per month, left to right: previous-year revenue, revenue, previous-year expenses, expenses. */
export function chartSeries(year: number, compare: boolean, expenses: boolean): Series[] {
  const out: Series[] = [];
  if (compare) out.push({ key: "previousCents", fill: "fill-zinc-300", swatch: "bg-zinc-300", label: `Umsatz ${year - 1}` });
  out.push({ key: "cents", fill: REVENUE_FILL, swatch: "bg-[#2a78d6]", label: `Umsatz ${year}` });
  if (expenses && compare)
    out.push({ key: "previousExpenseCents", fill: "fill-[#f3cfae]", swatch: "bg-[#f3cfae]", label: `Ausgaben ${year - 1}` });
  if (expenses) out.push({ key: "expenseCents", fill: "fill-[#e5813e]", swatch: "bg-[#e5813e]", label: `Ausgaben ${year}` });
  return out;
}

export interface RevenueChartProps {
  data: MonthDatum[];
  year: number;
  compare: boolean;
  /** expense columns plus the result line (revenue − expenses) */
  expenses: boolean;
  /** months after this index are in the future (current year): no result point there */
  lastMonth?: number;
}

export function RevenueChart({ data, year, compare, expenses, lastMonth = 11 }: RevenueChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const series = chartSeries(year, compare, expenses);
  const result = (d: MonthDatum) => d.cents - d.expenseCents;
  const values = data.flatMap((d) => [...series.map((s) => d[s.key]), ...(expenses ? [result(d)] : [])]);
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
  const band = plotW / 12;
  const n = series.length;
  const barW = Math.min(BAR_MAX, (band * 0.75 - GAP * (n - 1)) / n);
  const groupW = barW * n + GAP * (n - 1);
  const cx = (i: number) => PAD.left + band * i + band / 2;
  const resultPoints = expenses ? data.filter((_, i) => i <= lastMonth).map((d, i) => [cx(i), y(result(d))] as const) : [];

  const activeDatum = active === null ? null : data[active];
  const aria = (d: MonthDatum, i: number) =>
    `${MONTHS[i]}: ${series.map((s) => `${s.label} ${formatCents(d[s.key])}`).join(", ")}${expenses ? `, Ergebnis ${formatCents(result(d))}` : ""}`;

  return (
    <div ref={ref} className="relative" onPointerLeave={() => setActive(null)}>
      {width > 0 && (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label={expenses ? `Nettoumsatz und Ausgaben pro Monat ${year}` : `Nettoumsatz pro Monat ${year}`}
          className="block"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(t)}
                y2={y(t)}
                className={t === 0 ? "stroke-zinc-300" : "stroke-zinc-100"}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text x={PAD.left - 12} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular">
                {euro.format(t / 100)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x0 = cx(i) - groupW / 2;
            const future = i > lastMonth;
            return (
              <g key={d.month}>
                {active === i && (
                  <rect x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} className="fill-zinc-100/70" />
                )}
                {series.map((s, k) => (
                  <path
                    key={s.key}
                    d={columnPath(x0 + k * (barW + GAP), barW, y(0), y(d[s.key]))}
                    className={cn(s.fill, active !== null && active !== i && "opacity-60")}
                  />
                ))}
                <text
                  x={cx(i)}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                  className={cn("text-[11px]", future ? "fill-muted-foreground/50" : "fill-muted-foreground")}
                >
                  {MONTHS[i]}
                </text>
              </g>
            );
          })}
          {resultPoints.length > 0 && (
            <g className="pointer-events-none">
              <polyline
                points={resultPoints.map(([px, py]) => `${px},${py}`).join(" ")}
                fill="none"
                className={RESULT_STROKE}
                strokeWidth={1.5}
                strokeLinejoin="round"
              />
              {resultPoints.map(([px, py], i) => (
                <circle key={i} cx={px} cy={py} r={active === i ? 4 : 2.5} className={cn("fill-background", RESULT_STROKE)} strokeWidth={1.5} />
              ))}
            </g>
          )}
          {data.map((d, i) => (
            // hit target: the whole month band (drawn last so the result line doesn't block it)
            <rect
              key={d.month}
              x={PAD.left + band * i}
              y={0}
              width={band}
              height={HEIGHT}
              fill="transparent"
              tabIndex={0}
              aria-label={aria(d, i)}
              onPointerEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              className="outline-none"
            />
          ))}
        </svg>
      )}
      {activeDatum && active !== null && (
        <div
          className="pointer-events-none absolute z-10 min-w-44 rounded-md border bg-popover px-3 py-2 text-xs shadow-md"
          // beside the hovered month so it never covers its columns; flips left in the second half
          style={
            active < 6
              ? { left: PAD.left + band * (active + 1) + 4, top: PAD.top }
              : { right: width - (PAD.left + band * active) + 4, top: PAD.top }
          }
        >
          <div className="mb-1 text-muted-foreground">{MONTHS[active]}</div>
          {[...series].reverse().map((s) => (
            <TooltipRow key={s.key} color={s.swatch} label={s.label} value={activeDatum[s.key]} />
          ))}
          {expenses && (
            <div className="mt-1 border-t pt-1">
              <TooltipRow color="bg-zinc-800" label={`Ergebnis ${year}`} value={result(activeDatum)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TooltipRow({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn("h-0.5 w-3 rounded-full", color)} />
      <span className={cn("font-medium tabular", value < 0 ? "text-red-600" : "text-foreground")}>{formatCents(value)}</span>
      <span className="ml-auto pl-3 text-muted-foreground">{label}</span>
    </div>
  );
}

export function ChartLegend({ year, compare, expenses }: { year: number; compare: boolean; expenses: boolean }) {
  if (!compare && !expenses) return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {chartSeries(year, compare, expenses).map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className={cn("size-2.5 rounded-[3px]", s.swatch)} />
          {s.label}
        </span>
      ))}
      {expenses && (
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full bg-zinc-800" />
          Ergebnis {year}
        </span>
      )}
    </div>
  );
}
