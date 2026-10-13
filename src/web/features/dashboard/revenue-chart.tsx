import { useLayoutEffect, useRef, useState } from "react";
import { formatCents } from "@shared/money";
import { cn } from "@/lib/utils";

// Net revenue per month as columns; optional previous year as a recessive gray comparison column.
// Single axis (cents), hover/focus tooltip per month, the table view lives next to it in the page.

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

export interface RevenueChartProps {
  data: { month: number; cents: number; previousCents: number }[];
  year: number;
  compare: boolean;
  /** months after this index are in the future (current year) and drawn without a tooltip value */
  lastMonth?: number;
}

export function RevenueChart({ data, year, compare, lastMonth = 11 }: RevenueChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const values = data.flatMap((d) => (compare ? [d.cents, d.previousCents] : [d.cents]));
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
  const barW = Math.min(BAR_MAX, (band * 0.7 - (compare ? GAP : 0)) / (compare ? 2 : 1));
  const groupW = compare ? barW * 2 + GAP : barW;

  const activeDatum = active === null ? null : data[active];

  return (
    <div ref={ref} className="relative" onPointerLeave={() => setActive(null)}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label={`Nettoumsatz pro Monat ${year}`} className="block">
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
            const cx = PAD.left + band * i + band / 2;
            const x0 = cx - groupW / 2;
            const future = i > lastMonth;
            return (
              <g key={d.month}>
                {active === i && (
                  <rect x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} className="fill-zinc-100/70" />
                )}
                {compare && <path d={columnPath(x0, barW, y(0), y(d.previousCents))} className="fill-zinc-300" />}
                <path
                  d={columnPath(compare ? x0 + barW + GAP : x0, barW, y(0), y(d.cents))}
                  className={cn("fill-[#2a78d6]", active !== null && active !== i && "opacity-60")}
                />
                <text
                  x={cx}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                  className={cn("text-[11px]", future ? "fill-muted-foreground/50" : "fill-muted-foreground")}
                >
                  {MONTHS[i]}
                </text>
                {/* hit target: the whole month band */}
                <rect
                  x={PAD.left + band * i}
                  y={0}
                  width={band}
                  height={HEIGHT}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${MONTHS[i]} ${year}: ${formatCents(d.cents)}${compare ? `, Vorjahr ${formatCents(d.previousCents)}` : ""}`}
                  onPointerEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  className="outline-none"
                />
              </g>
            );
          })}
        </svg>
      )}
      {activeDatum && active !== null && (
        <div
          className="pointer-events-none absolute z-10 min-w-36 rounded-md border bg-popover px-3 py-2 text-xs shadow-md"
          // beside the hovered month so it never covers its columns; flips left in the second half
          style={
            active < 6
              ? { left: PAD.left + band * (active + 1) + 4, top: PAD.top }
              : { right: width - (PAD.left + band * active) + 4, top: PAD.top }
          }
        >
          <div className="mb-1 text-muted-foreground">{MONTHS[active]}</div>
          <TooltipRow color="bg-[#2a78d6]" label={String(year)} value={activeDatum.cents} />
          {compare && <TooltipRow color="bg-zinc-300" label={String(year - 1)} value={activeDatum.previousCents} />}
        </div>
      )}
    </div>
  );
}

function TooltipRow({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn("h-0.5 w-3 rounded-full", color)} />
      <span className="font-medium tabular text-foreground">{formatCents(value)}</span>
      <span className="ml-auto pl-3 text-muted-foreground">{label}</span>
    </div>
  );
}

export function ChartLegend({ year, compare }: { year: number; compare: boolean }) {
  if (!compare) return null;
  return (
    <div className="flex items-center gap-4 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-[3px] bg-[#2a78d6]" />
        {year}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-[3px] bg-zinc-300" />
        {year - 1}
      </span>
    </div>
  );
}
