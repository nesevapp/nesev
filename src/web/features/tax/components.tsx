import { type ReactNode, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Check, ChevronLeft, ChevronRight, Copy } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@shared/dates";
import { formatCents } from "@shared/money";
import { type PeriodKind, parsePeriod, periodKeyFor, shiftPeriod } from "@shared/tax-report";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { docLink } from "@/features/documents/config";
import { cn } from "@/lib/utils";
import type { UvaSourceDTO } from "./api";

export const th = "h-9 text-xs font-medium text-muted-foreground";

/** FinanzOnline-friendly amount: "1234,56" (no thousands separator). */
export function plainAmount(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

export function CopyButton({ cents, label, className }: { cents: number; label: string; className?: string }) {
  const [done, setDone] = useState(false);
  const value = plainAmount(cents);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("size-7 text-muted-foreground hover:text-foreground", className)}
      aria-label={`${label} kopieren (${value})`}
      title={`${value} kopieren`}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(value).then(
          () => {
            setDone(true);
            toast.success(`${label}: ${value} kopiert`);
            setTimeout(() => setDone(false), 1500);
          },
          () => toast.error("Kopieren nicht möglich"),
        );
      }}
    >
      {done ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
    </Button>
  );
}

export function SectionHeader({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children && <div className="flex items-center gap-3">{children}</div>}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-md border p-0.5 text-xs">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn("rounded px-2 py-0.5", value === o.value ? "bg-secondary font-medium" : "text-muted-foreground hover:text-foreground")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const KIND_OPTIONS: { value: PeriodKind; label: string }[] = [
  { value: "month", label: "Monat" },
  { value: "quarter", label: "Quartal" },
  { value: "year", label: "Jahr" },
];

/** ‹ Label › plus a month/quarter/year switch. */
export function PeriodNav({
  periodKey,
  kinds = ["month", "quarter", "year"],
  onChange,
}: {
  periodKey: string;
  kinds?: PeriodKind[];
  onChange: (key: string) => void;
}) {
  const p = parsePeriod(periodKey)!;
  return (
    <div className="flex items-center gap-2">
      {kinds.length > 1 && (
        <Segmented
          value={p.kind}
          options={KIND_OPTIONS.filter((o) => kinds.includes(o.value))}
          onChange={(k) => onChange(periodKeyFor(p.from, k))}
        />
      )}
      <div className="flex items-center rounded-md border">
        <Button variant="ghost" size="icon" className="size-8 rounded-r-none" onClick={() => onChange(shiftPeriod(periodKey, -1))} aria-label="Vorheriger Zeitraum">
          <ChevronLeft />
        </Button>
        <span className="min-w-32 px-1 text-center text-sm font-medium tabular" aria-live="polite">
          {p.label}
        </span>
        <Button variant="ghost" size="icon" className="size-8 rounded-l-none" onClick={() => onChange(shiftPeriod(periodKey, 1))} aria-label="Nächster Zeitraum">
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

export function SourceLink({ s }: { s: Pick<UvaSourceDTO, "kind" | "id" | "docType" | "number" | "party"> }) {
  const text = s.number || s.party || "–";
  if (s.kind === "document" && s.docType) {
    return (
      <Link {...docLink(s.docType, s.id)} className="font-medium tabular hover:underline">
        {text}
      </Link>
    );
  }
  if (s.kind === "expense") {
    return (
      <Link to="/expenses/$id" params={{ id: s.id }} className="font-medium tabular hover:underline">
        {text}
      </Link>
    );
  }
  return <span className="text-muted-foreground">{text}</span>;
}

/** Drill-down table of the documents/expenses behind a value. */
export function SourcesTable({ sources, showTax = true }: { sources: UvaSourceDTO[]; showTax?: boolean }) {
  if (sources.length === 0) return <p className="px-3 py-2 text-xs text-muted-foreground">Keine Belege.</p>;
  return (
    <Table className="text-xs">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-7 text-[11px] text-muted-foreground">Beleg</TableHead>
          <TableHead className="h-7 text-[11px] text-muted-foreground">Datum</TableHead>
          <TableHead className="h-7 text-[11px] text-muted-foreground">Partner</TableHead>
          <TableHead className="h-7 text-[11px] text-muted-foreground">Hinweis</TableHead>
          <TableHead className="h-7 text-right text-[11px] text-muted-foreground">Netto</TableHead>
          {showTax && <TableHead className="h-7 text-right text-[11px] text-muted-foreground">Steuer</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sources.map((s) => (
          <TableRow key={`${s.kind}-${s.id}-${s.date}-${s.number}`} className="hover:bg-transparent">
            <TableCell className="py-1.5">
              <SourceLink s={s} />
            </TableCell>
            <TableCell className="py-1.5 tabular">{formatDate(s.date)}</TableCell>
            <TableCell className="max-w-56 truncate py-1.5">{s.party}</TableCell>
            <TableCell className="py-1.5 text-muted-foreground">{s.note}</TableCell>
            <TableCell className="py-1.5 text-right tabular">{formatCents(s.netCents)}</TableCell>
            {showTax && <TableCell className="py-1.5 text-right tabular">{formatCents(s.taxCents)}</TableCell>}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function Warnings({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <ul className="list-disc space-y-0.5 pl-4">
        {items.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

/** Days from today to a due date: "in 12 Tagen", "heute", "seit 3 Tagen überfällig". */
export function dueLabel(due: string, today: string): { text: string; tone: "overdue" | "soon" | "normal" } {
  const days = Math.round((Date.parse(due) - Date.parse(today)) / 86_400_000);
  if (days < 0) return { text: `seit ${-days} ${-days === 1 ? "Tag" : "Tagen"} überfällig`, tone: "overdue" };
  if (days === 0) return { text: "heute fällig", tone: "soon" };
  return { text: `in ${days} ${days === 1 ? "Tag" : "Tagen"}`, tone: days <= 14 ? "soon" : "normal" };
}
