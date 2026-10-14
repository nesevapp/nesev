import { formatCents } from "@shared/money";
import type { AfaYear } from "@shared/assets";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

const th = "h-8 text-xs font-medium text-muted-foreground";

/** AfA schedule: one row per year (book value 1.1., AfA, disposal write-off, book value 31.12.). */
export function ScheduleTable({ rows, highlightYear, compact }: { rows: AfaYear[]; highlightYear?: number; compact?: boolean }) {
  const hasDisposal = rows.some((r) => r.disposalCents);
  const cell = compact ? "py-1" : "py-1.5";
  if (rows.length === 0) return <p className="py-4 text-center text-sm text-muted-foreground">Keine AfA (Anschaffungskosten fehlen).</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className={th}>Jahr</TableHead>
          <TableHead className={cn(th, "text-right")}>Buchwert 1.1.</TableHead>
          <TableHead className={cn(th, "text-right")}>AfA</TableHead>
          {hasDisposal && <TableHead className={cn(th, "text-right")}>Restbuchwert-Abgang</TableHead>}
          <TableHead className={cn(th, "text-right")}>Buchwert 31.12.</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.year} className={cn("hover:bg-transparent", r.year === highlightYear && "bg-muted/40 font-medium")}>
            <TableCell className={cn(cell, "tabular")}>{r.year}</TableCell>
            <TableCell className={cn(cell, "text-right tabular")}>{formatCents(r.startCents)}</TableCell>
            <TableCell className={cn(cell, "text-right tabular")}>{formatCents(r.afaCents)}</TableCell>
            {hasDisposal && <TableCell className={cn(cell, "text-right tabular")}>{r.disposalCents ? formatCents(r.disposalCents) : "–"}</TableCell>}
            <TableCell className={cn(cell, "text-right tabular")}>{formatCents(r.endCents)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
