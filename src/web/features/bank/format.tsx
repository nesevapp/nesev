import { addDays, todayIso } from "@shared/dates";
import { formatCents } from "@shared/money";
import { cn } from "@/lib/utils";

export const PERIODS = ["all", "month", "last-month", "quarter", "year", "last-year"] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_LABELS: Record<Period, string> = {
  all: "Gesamter Zeitraum",
  month: "Dieser Monat",
  "last-month": "Letzter Monat",
  quarter: "Dieses Quartal",
  year: "Dieses Jahr",
  "last-year": "Letztes Jahr",
};

/** Period → { from, to } ("YYYY-MM-DD", inclusive). */
export function periodRange(period: Period, today = todayIso()): { from?: string; to?: string } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const pad = (n: number) => String(n).padStart(2, "0");
  const monthStart = (yy: number, mm: number) => `${yy}-${pad(mm)}-01`;
  const monthEnd = (yy: number, mm: number) => addDays(mm === 12 ? `${yy + 1}-01-01` : monthStart(yy, mm + 1), -1);
  switch (period) {
    case "all":
      return {};
    case "month":
      return { from: monthStart(y, m), to: monthEnd(y, m) };
    case "last-month": {
      const [yy, mm] = m === 1 ? [y - 1, 12] : [y, m - 1];
      return { from: monthStart(yy, mm), to: monthEnd(yy, mm) };
    }
    case "quarter": {
      const q = Math.floor((m - 1) / 3) * 3 + 1;
      return { from: monthStart(y, q), to: monthEnd(y, q + 2) };
    }
    case "year":
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    case "last-year":
      return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
  }
}

/** Signed amount: incoming green with "+", outgoing plain with "−". */
export function Amount({ cents, className }: { cents: number; className?: string }) {
  return (
    <span className={cn("tabular whitespace-nowrap", cents > 0 && "text-emerald-700", className)}>
      {cents > 0 ? "+" : cents < 0 ? "−" : ""}
      {formatCents(Math.abs(cents)).replace("-", "")}
    </span>
  );
}
