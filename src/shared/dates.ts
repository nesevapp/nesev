// Calendar dates are "YYYY-MM-DD" strings (local time).

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today's local date as "YYYY-MM-DD". */
export function todayIso(): string {
  return toIsoDate(new Date());
}

/** addDays("2026-01-30", 3) → "2026-02-02" */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return toIsoDate(new Date(y!, m! - 1, d! + days));
}

/** "2026-10-13" → "13.10.2026"; null/empty → "" */
export function formatDate(isoDate: string | null | undefined): string {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}
