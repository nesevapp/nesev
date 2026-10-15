import { useLayoutEffect, useRef, useState } from "react";
import { formatCents } from "@shared/money";
import { MONTHS } from "@/features/dashboard/revenue-chart";
import { cn } from "@/lib/utils";

// Income vs. expenses per month as paired columns (categorical slots 1 and 2), the monthly result as a
// neutral line with markers on the same € axis. Hover/focus tooltip per month; the table view is in the page.

const HEIGHT = 260;
const PAD = { top: 12, right: 0, bottom: 28, left: 72 };
const BAR_MAX = 18;
const GAP = 2;
const RADIUS = 4;

const euro = new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

function niceStep(span: number): number {
  if (span <= 0) return 100_00;
  const raw = span / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

function columnPath(x: number, w: number, y0: number, y1: number): string {
  const h = Math.abs(y1 - y0);
  if (h < 0.5) return "";
  const r = Math.min(RADIUS, h, w / 2);
  if (y1 > y0) return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
  return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
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

export interface EarMonth {
  month: number;
  incomeCents: number;
  expensesCents: number;
  profitCents: number;
}

export function EarChart({ data, year }: { data: EarMonth[]; year: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const values = data.flatMap((d) => [d.incomeCents, d.expensesCents, d.profitCents]);
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
  const barW = Math.min(BAR_MAX, (band * 0.7 - GAP) / 2);
  const cx = (i: number) => PAD.left + band * i + band / 2;
  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${cx(i)},${y(d.profitCents)}`).join("");
  const a = active === null ? null : data[active];

  return (
    <div ref={ref} className="relative" onPointerLeave={() => setActive(null)}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label={`Einnahmen, Ausgaben und Ergebnis pro Monat ${year}`} className="block">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className={t === 0 ? "stroke-chart-muted" : "stroke-chart-grid"} strokeWidth={1} shapeRendering="crispEdges" />
              <text x={PAD.left - 12} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular">
                {euro.format(t / 100)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x0 = cx(i) - barW - GAP / 2;
            return (
              <g key={d.month} className={cn(active !== null && active !== i && "opacity-60")}>
                {active === i && <rect x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} className="fill-muted/70" />}
                <path d={columnPath(x0, barW, y(0), y(d.incomeCents))} className="fill-chart-revenue" />
                <path d={columnPath(x0 + barW + GAP, barW, y(0), y(d.expensesCents))} className="fill-chart-expenses" />
                <text x={cx(i)} y={HEIGHT - 8} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                  {MONTHS[i]}
                </text>
              </g>
            );
          })}
          <path d={line} fill="none" className="stroke-chart-result" strokeWidth={2} strokeLinejoin="round" />
          {data.map((d, i) => (
            <circle key={d.month} cx={cx(i)} cy={y(d.profitCents)} r={4} className="fill-chart-result stroke-background" strokeWidth={2} />
          ))}
          {data.map((d, i) => (
            <rect
              key={d.month}
              x={PAD.left + band * i}
              y={0}
              width={band}
              height={HEIGHT}
              fill="transparent"
              tabIndex={0}
              aria-label={`${MONTHS[i]} ${year}: Einnahmen ${formatCents(d.incomeCents)}, Ausgaben ${formatCents(d.expensesCents)}, Ergebnis ${formatCents(d.profitCents)}`}
              onPointerEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
              className="outline-none"
            />
          ))}
        </svg>
      )}
      {a && active !== null && (
        <div
          className="pointer-events-none absolute z-10 min-w-44 rounded-md border bg-popover px-3 py-2 text-xs shadow-md"
          style={active < 6 ? { left: PAD.left + band * (active + 1) + 4, top: PAD.top } : { right: width - (PAD.left + band * active) + 4, top: PAD.top }}
        >
          <div className="mb-1 text-muted-foreground">
            {MONTHS[active]} {year}
          </div>
          <TooltipRow swatch={<span className="size-2 rounded-[2px] bg-chart-revenue" />} label="Einnahmen" value={a.incomeCents} />
          <TooltipRow swatch={<span className="size-2 rounded-[2px] bg-chart-expenses" />} label="Ausgaben" value={a.expensesCents} />
          <TooltipRow swatch={<span className="h-0.5 w-2.5 rounded-full bg-chart-result" />} label="Ergebnis" value={a.profitCents} />
        </div>
      )}
    </div>
  );
}

function TooltipRow({ swatch, label, value }: { swatch: React.ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      {swatch}
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto pl-3 font-medium tabular text-foreground">{formatCents(value)}</span>
    </div>
  );
}

export function EarLegend() {
  return (
    <div className="flex items-center gap-4 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-[3px] bg-chart-revenue" />
        Einnahmen
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-[3px] bg-chart-expenses" />
        Ausgaben
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-0.5 w-3 rounded-full bg-chart-result" />
        Ergebnis
      </span>
    </div>
  );
}
