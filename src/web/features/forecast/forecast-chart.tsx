import { useLayoutEffect, useRef, useState } from "react";
import { formatCents } from "@shared/money";
import { cn } from "@/lib/utils";
import { type ForecastSource } from "@/sdk";

// Expected inflow per period as stacked columns (one color per source, fixed order, 2px surface gap between
// segments), plus a separate slim "kumuliert" chart on the same x bands. Two charts instead of a second
// y-axis: the running total dwarfs the per-period values. Hover/focus syncs both; click selects a period.

export const SOURCE_ORDER: ForecastSource[] = ["invoice", "recurring", "offer", "draft"];

export const SOURCE_META: Record<ForecastSource, { label: string; color: string; bg: string }> = {
  invoice: { label: "Offene Rechnungen", color: "#2a78d6", bg: "bg-[#2a78d6]" },
  recurring: { label: "Serienrechnungen", color: "#eb6834", bg: "bg-[#eb6834]" },
  offer: { label: "Angebote (gewichtet)", color: "#1baf7a", bg: "bg-[#1baf7a]" },
  draft: { label: "Entwürfe", color: "#eda100", bg: "bg-[#eda100]" },
};

export interface ChartColumn {
  key: string;
  label: string;
  /** long label for tooltip / aria */
  title: string;
  bySource: Record<ForecastSource, number>;
  totalCents: number;
  taxCents: number;
  cumulativeCents: number;
  /** period (absent for the overdue column) */
  start?: string;
  end?: string;
  overdue?: boolean;
}

const HEIGHT = 240;
const CUM_HEIGHT = 96;
const PAD = { top: 12, right: 8, bottom: 26, left: 72 };
const BAR_MAX = 24;
const RADIUS = 4;
const SEG_GAP = 2;

const euro = new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const compactEuro = new Intl.NumberFormat("de-AT", {
  style: "currency",
  currency: "EUR",
  notation: "compact",
  maximumFractionDigits: 1,
});

function niceStep(span: number): number {
  if (span <= 0) return 100_00;
  const raw = span / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

function ticksFor(max: number) {
  const step = niceStep(max);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(t);
  return { top, ticks };
}

/** Column with a rounded top and square baseline. */
function topRoundedPath(x: number, w: number, yBottom: number, yTop: number): string {
  const h = yBottom - yTop;
  if (h < 0.5) return "";
  const r = Math.min(RADIUS, h, w / 2);
  return `M${x},${yBottom}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yBottom}Z`;
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

export function ForecastChart({
  columns,
  selected,
  onSelect,
}: {
  columns: ChartColumn[];
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const band = columns.length ? plotW / columns.length : 0;
  const barW = Math.max(4, Math.min(BAR_MAX, band * 0.62));
  // keep x labels ≥ 52px apart
  const labelEvery = Math.max(1, Math.ceil(52 / Math.max(1, band)));

  const main = ticksFor(Math.max(0, ...columns.map((c) => c.totalCents)));
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const y = (v: number) => PAD.top + (1 - v / main.top) * plotH;

  const cumMax = Math.max(0, ...columns.map((c) => c.cumulativeCents));
  const cum = ticksFor(cumMax);
  const cumPlotH = CUM_HEIGHT - 8 - 8;
  const yc = (v: number) => 8 + (1 - v / cum.top) * cumPlotH;
  const cx = (i: number) => PAD.left + band * i + band / 2;

  const activeCol = active === null ? null : columns[active];
  const linePath = columns.map((c, i) => `${i ? "L" : "M"}${cx(i)},${yc(c.cumulativeCents)}`).join("");
  const areaPath = columns.length
    ? `${linePath}L${cx(columns.length - 1)},${yc(0)}L${cx(0)},${yc(0)}Z`
    : "";
  const last = columns.at(-1);

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
        aria-label={h === HEIGHT ? `${c.title}: ${formatCents(c.totalCents)}` : undefined}
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

  return (
    <div ref={ref} className="relative" onPointerLeave={() => setActive(null)}>
      {width > 0 && (
        <>
          <svg width={width} height={HEIGHT} role="img" aria-label="Erwartete Zahlungseingänge pro Zeitraum" className="block">
            {main.ticks.map((t) => (
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
            {columns.map((c, i) => {
              const x0 = cx(i) - barW / 2;
              const dim = (active !== null && active !== i) || (selected !== null && selected !== c.key);
              let acc = 0;
              const segs = SOURCE_ORDER.filter((s) => c.bySource[s] > 0);
              return (
                <g key={c.key} className={cn("transition-opacity", dim && "opacity-45")}>
                  {(active === i || selected === c.key) && (
                    <rect x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} className="fill-zinc-100/70" />
                  )}
                  {segs.map((s, si) => {
                    const yBottom = y(acc) - (si > 0 ? SEG_GAP / 2 : 0);
                    acc += c.bySource[s];
                    const isTop = si === segs.length - 1;
                    const yTop = y(acc) + (isTop ? 0 : SEG_GAP / 2);
                    if (yBottom - yTop < 0.5) return null;
                    return isTop ? (
                      <path key={s} d={topRoundedPath(x0, barW, yBottom, yTop)} fill={SOURCE_META[s].color} />
                    ) : (
                      <rect key={s} x={x0} y={yTop} width={barW} height={yBottom - yTop} fill={SOURCE_META[s].color} />
                    );
                  })}
                  {(i % labelEvery === 0 || c.overdue) && (
                    <text
                      x={cx(i)}
                      y={HEIGHT - 8}
                      textAnchor="middle"
                      className={cn("text-[11px]", c.overdue ? "fill-red-700" : "fill-muted-foreground")}
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
                className="stroke-zinc-200"
                shapeRendering="crispEdges"
              />
            )}
            {hitTargets(HEIGHT)}
          </svg>

          <div className="mt-3 flex items-baseline justify-between border-t pt-2 text-xs text-muted-foreground" style={{ paddingLeft: PAD.left }}>
            <span>Kumuliert</span>
          </div>
          <svg width={width} height={CUM_HEIGHT} aria-hidden className="block">
            <line x1={PAD.left} x2={width - PAD.right} y1={yc(0)} y2={yc(0)} className="stroke-zinc-300" shapeRendering="crispEdges" />
            <text x={PAD.left - 12} y={yc(cum.top)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular">
              {compactEuro.format(cum.top / 100)}
            </text>
            <line x1={PAD.left} x2={width - PAD.right} y1={yc(cum.top)} y2={yc(cum.top)} className="stroke-zinc-100" shapeRendering="crispEdges" />
            {active !== null && <line x1={cx(active)} x2={cx(active)} y1={8} y2={yc(0)} className="stroke-zinc-300" />}
            <path d={areaPath} className="fill-zinc-800/[0.06]" />
            <path d={linePath} fill="none" className="stroke-zinc-700" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {active !== null && columns[active] && (
              <circle cx={cx(active)} cy={yc(columns[active].cumulativeCents)} r={4} className="fill-zinc-700 stroke-white" strokeWidth={2} />
            )}
            {last && active === null && (
              <>
                <circle cx={cx(columns.length - 1)} cy={yc(last.cumulativeCents)} r={4} className="fill-zinc-700 stroke-white" strokeWidth={2} />
                <text
                  x={cx(columns.length - 1) - 10}
                  y={yc(last.cumulativeCents) + 14}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-foreground text-[11px] font-medium tabular"
                >
                  {euro.format(last.cumulativeCents / 100)}
                </text>
              </>
            )}
            {hitTargets(CUM_HEIGHT)}
          </svg>
        </>
      )}
      {activeCol && active !== null && (
        <div
          className="pointer-events-none absolute z-10 min-w-52 rounded-md border bg-popover px-3 py-2 text-xs shadow-md"
          style={
            cx(active) < width / 2
              ? { left: cx(active) + barW / 2 + 12, top: PAD.top }
              : { right: width - cx(active) + barW / 2 + 12, top: PAD.top }
          }
        >
          <div className="mb-1.5 font-medium text-foreground">{activeCol.title}</div>
          {SOURCE_ORDER.filter((s) => activeCol.bySource[s] > 0).map((s) => (
            <div key={s} className="flex items-center gap-2">
              <span className={cn("size-2 rounded-[2px]", SOURCE_META[s].bg)} />
              <span className="text-muted-foreground">{SOURCE_META[s].label}</span>
              <span className="ml-auto pl-3 tabular text-foreground">{formatCents(activeCol.bySource[s])}</span>
            </div>
          ))}
          {activeCol.totalCents === 0 && <div className="text-muted-foreground">Keine Eingänge erwartet</div>}
          <div className="mt-1.5 flex justify-between border-t pt-1.5 font-medium text-foreground">
            <span>Summe</span>
            <span className="tabular">{formatCents(activeCol.totalCents)}</span>
          </div>
          {activeCol.taxCents > 0 && (
            <div className="flex justify-between text-muted-foreground">
              <span>davon USt.</span>
              <span className="tabular">{formatCents(activeCol.taxCents)}</span>
            </div>
          )}
          <div className="flex justify-between text-muted-foreground">
            <span>Kumuliert</span>
            <span className="tabular">{formatCents(activeCol.cumulativeCents)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function SourceLegend({ sources }: { sources: ForecastSource[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {sources.map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <span className={cn("size-2.5 rounded-[3px]", SOURCE_META[s].bg)} />
          {SOURCE_META[s].label}
        </span>
      ))}
    </div>
  );
}
