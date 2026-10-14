import { useLayoutEffect, useRef, useState } from "react";

// Pure helpers and color tokens shared by the SVG charts (dashboard revenue chart, forecast chart, assistant cards).

/** Platform chart colors: revenue / inflow blue, expenses / outflow orange (+ their light previous-year shades). */
export const CHART_COLORS = {
  revenue: "#2a78d6",
  revenueLight: "#93bdf0",
  expenses: "#e5813e",
  expensesLight: "#f3cfae",
  /** result / balance line (zinc-800) */
  result: "#27272a",
  neutral: "#71717a",
  muted: "#d4d4d8",
} as const;

export const euroAxis = new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
export const compactEuro = new Intl.NumberFormat("de-AT", {
  style: "currency",
  currency: "EUR",
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Round step (1/2/5 × 10^n) so the axis gets ~4 ticks. */
export function niceStep(span: number): number {
  if (span <= 0) return 100_00;
  const raw = span / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

/** Column path with a rounded data-end and a square baseline end (works for negative values). */
export function columnPath(x: number, w: number, y0: number, y1: number, radius = 4): string {
  const h = Math.abs(y1 - y0);
  if (h < 0.5) return "";
  const r = Math.min(radius, h, w / 2);
  if (y1 < y0) {
    return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  }
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

/** Content width of an element, kept up to date with a ResizeObserver. */
export function useWidth<T extends HTMLElement>() {
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
