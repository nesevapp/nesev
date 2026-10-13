import { BP_SCALE, QTY_SCALE, roundHalfAwayFromZero } from "./money";
import { effectiveTaxRateBp, type TaxMode } from "./tax";

export interface TotalsItemInput {
  quantity: number; // milli-units
  unitPriceCents: number;
  taxRateBp: number;
  discountBp?: number | null;
}

export interface LineTotals {
  /** quantity × unit price, before discount (rounded to cents) */
  grossLineCents: number;
  discountCents: number;
  /** line net after discount — this is what gets summed */
  netCents: number;
  /** tax rate actually applied given the tax mode */
  taxRateBp: number;
}

export interface TaxGroup {
  rateBp: number;
  netCents: number;
  taxCents: number;
}

export interface Totals {
  lines: LineTotals[];
  taxGroups: TaxGroup[];
  discountCents: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
}

export function calcLine(item: TotalsItemInput, taxMode: TaxMode): LineTotals {
  const grossLineCents = roundHalfAwayFromZero((item.quantity * item.unitPriceCents) / QTY_SCALE);
  const discountBp = item.discountBp ?? 0;
  const discountCents = roundHalfAwayFromZero((grossLineCents * discountBp) / BP_SCALE);
  return {
    grossLineCents,
    discountCents,
    netCents: grossLineCents - discountCents,
    taxRateBp: effectiveTaxRateBp(taxMode, item.taxRateBp),
  };
}

/**
 * The single totals function used by UI, API and PDF.
 * Line nets are rounded to cents per line; tax is computed per rate group on the summed net
 * (avoids per-line tax rounding drift). Groups are sorted by rate descending.
 */
export function calcTotals(items: TotalsItemInput[], taxMode: TaxMode): Totals {
  const lines = items.map((i) => calcLine(i, taxMode));
  const groups = new Map<number, number>();
  for (const l of lines) groups.set(l.taxRateBp, (groups.get(l.taxRateBp) ?? 0) + l.netCents);

  const taxGroups: TaxGroup[] = [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rateBp, netCents]) => ({
      rateBp,
      netCents,
      taxCents: roundHalfAwayFromZero((netCents * rateBp) / BP_SCALE),
    }));

  const netCents = lines.reduce((s, l) => s + l.netCents, 0);
  const taxCents = taxGroups.reduce((s, g) => s + g.taxCents, 0);
  const discountCents = lines.reduce((s, l) => s + l.discountCents, 0);
  return { lines, taxGroups, discountCents, netCents, taxCents, grossCents: netCents + taxCents };
}
