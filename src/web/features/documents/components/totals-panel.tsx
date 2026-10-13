import { formatBp, formatCents } from "@shared/money";
import type { TaxMode } from "@shared/tax";
import { calcTotals, type TotalsItemInput } from "@shared/totals";
import { cn } from "@/lib/utils";

/** Net, tax grouped by rate and gross — computed with the shared calcTotals(). */
export function TotalsPanel({
  items,
  taxMode,
  taxNote,
  className,
}: {
  items: TotalsItemInput[];
  taxMode: TaxMode;
  taxNote?: string | null;
  className?: string;
}) {
  const t = calcTotals(items, taxMode);
  return (
    <div className={cn("w-full max-w-sm space-y-1.5 text-sm", className)}>
      <Row label="Summe netto" value={formatCents(t.netCents)} />
      {t.taxGroups.map((g) =>
        g.rateBp > 0 ? (
          <Row
            key={g.rateBp}
            label={`USt. ${formatBp(g.rateBp)} auf ${formatCents(g.netCents)}`}
            value={formatCents(g.taxCents)}
            muted
          />
        ) : null,
      )}
      {t.taxGroups.every((g) => g.rateBp === 0) && <Row label="USt. 0 %" value={formatCents(0)} muted />}
      <div className="flex items-baseline justify-between border-t pt-2 text-base font-semibold">
        <span>Gesamt brutto</span>
        <span className="tabular">{formatCents(t.grossCents)}</span>
      </div>
      {taxNote && <p className="pt-1 text-xs text-muted-foreground">{taxNote}</p>}
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4", muted && "text-muted-foreground")}>
      <span>{label}</span>
      <span className="tabular">{value}</span>
    </div>
  );
}
