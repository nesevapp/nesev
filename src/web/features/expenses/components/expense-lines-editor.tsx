import { useFieldArray, useWatch, type UseFormReturn } from "react-hook-form";
import { Plus, Trash2 } from "lucide-react";
import {
  DEFAULT_EXPENSE_CATEGORY,
  EXPENSE_TAX_RATES_BP,
  expenseTaxCents,
  getExpenseCategory,
  isSelfAssessed,
  netFromGross,
  type VatTreatment,
} from "@shared/expenses";
import { formatBp } from "@shared/money";
import type { ExpenseFormData, ExpenseFormValues, ExpenseLineInput } from "@shared/schemas/expense";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CODECS, NumericInput } from "@/features/documents/components/numeric-input";
import { cn } from "@/lib/utils";
import { CategorySelect } from "./category-select";

type Form = UseFormReturn<ExpenseFormValues, unknown, ExpenseFormData>;
type Line = ExpenseFormValues["lines"][number];

const GRID = "grid grid-cols-[minmax(0,1fr)_92px_74px_84px_96px_58px_28px] gap-x-1.5";

export function newLine(category: string = DEFAULT_EXPENSE_CATEGORY, taxRateBp = 2000): ExpenseLineInput {
  const cat = getExpenseCategory(category);
  return {
    category: (cat?.key ?? DEFAULT_EXPENSE_CATEGORY) as ExpenseLineInput["category"],
    description: "",
    netCents: 0,
    taxRateBp,
    taxCents: 0,
    deductibleBp: cat?.defaultDeductibleBp ?? 10000,
  };
}

/** Amount payable to the supplier for a line: net + tax, or net for self-assessed treatments. */
export function linePayable(l: { netCents: number; taxCents: number }, treatment: VatTreatment): number {
  return isSelfAssessed(treatment) ? l.netCents : l.netCents + l.taxCents;
}

/**
 * Expense lines. Net and gross ("Brutto") are both editable: editing net recomputes tax, editing gross
 * back-calculates net and tax. `grossMode` decides which of the two is in the tab order and what a rate
 * change keeps fixed. Tax is auto-computed but can be overwritten to match the receipt.
 */
export function ExpenseLinesEditor({
  form,
  treatment,
  grossMode,
}: {
  form: Form;
  treatment: VatTreatment;
  grossMode: boolean;
}) {
  const { control, setValue } = form;
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const lines = (useWatch({ control, name: "lines" }) ?? []) as Line[];
  const noVat = treatment === "none";
  const selfAssessed = isSelfAssessed(treatment);

  const set = (i: number, patch: Partial<ExpenseLineInput>) => {
    for (const [k, v] of Object.entries(patch)) {
      setValue(`lines.${i}.${k as keyof ExpenseLineInput}`, v as never, { shouldDirty: true });
    }
  };
  const rateOf = (l: Line) => (noVat ? 0 : l.taxRateBp);

  const setNet = (i: number, netCents: number) =>
    set(i, { netCents, taxCents: expenseTaxCents(netCents, rateOf(lines[i]!)) });

  const setGross = (i: number, gross: number) => {
    const rate = rateOf(lines[i]!);
    set(i, selfAssessed ? { netCents: gross, taxCents: expenseTaxCents(gross, rate) } : netFromGross(gross, rate));
  };

  const setTax = (i: number, taxCents: number) => {
    const l = lines[i]!;
    // Gross entry keeps the receipt's total fixed; net entry keeps net.
    if (grossMode && !selfAssessed) set(i, { taxCents, netCents: l.netCents + l.taxCents - taxCents });
    else set(i, { taxCents });
  };

  const setRate = (i: number, taxRateBp: number) => {
    const l = lines[i]!;
    if (grossMode && !selfAssessed) set(i, { taxRateBp, ...netFromGross(l.netCents + l.taxCents, taxRateBp) });
    else set(i, { taxRateBp, taxCents: expenseTaxCents(l.netCents, taxRateBp) });
  };

  const add = () => {
    const last = lines.at(-1);
    append(newLine(last?.category, last?.taxRateBp ?? (noVat ? 0 : 2000)), {
      focusName: `lines.${fields.length}.description`,
    });
  };

  return (
    <div>
      <div className={cn(GRID, "border-b pb-2 text-xs font-medium text-muted-foreground")}>
        <span>Kategorie / Beschreibung</span>
        <span className="text-right">Netto</span>
        <span>USt.</span>
        <span className="text-right" title={selfAssessed ? "selbst berechnete Steuer (Reverse Charge / ig. Erwerb)" : undefined}>
          {selfAssessed ? "USt. (RC)" : "USt."}
        </span>
        <span className="text-right">{selfAssessed ? "Betrag" : "Brutto"}</span>
        <span className="text-right" title="Vorsteuer abzugsfähig in %">
          VSt. %
        </span>
        <span />
      </div>

      {fields.length === 0 && (
        <div className="py-6 text-center text-sm text-muted-foreground">
          Noch keine Positionen — ohne Positionen bleibt die Ausgabe „unvollständig“.
        </div>
      )}

      <ol>
        {fields.map((field, i) => {
          const l = lines[i];
          if (!l) return null;
          const cat = getExpenseCategory(l.category ?? DEFAULT_EXPENSE_CATEGORY);
          const expected = expenseTaxCents(l.netCents, rateOf(l));
          const taxOverridden = !noVat && l.taxCents !== expected;
          return (
            <li key={field.id} className={cn(GRID, "group items-start border-b py-2")}>
              <div className="space-y-1.5">
                <CategorySelect
                  value={l.category ?? DEFAULT_EXPENSE_CATEGORY}
                  onChange={(key) => {
                    const next = getExpenseCategory(key);
                    set(i, {
                      category: key as ExpenseLineInput["category"],
                      ...(next ? { deductibleBp: next.defaultDeductibleBp } : {}),
                    });
                  }}
                  className="w-full px-2.5"
                  aria-label={`Position ${i + 1}: Kategorie`}
                />
                <Input
                  {...form.register(`lines.${i}.description`)}
                  placeholder="Beschreibung (optional)"
                  aria-label={`Position ${i + 1}: Beschreibung`}
                  className="h-8 text-muted-foreground focus-visible:text-foreground"
                />
                {cat?.hint && <p className="text-[11px] leading-tight text-muted-foreground">{cat.hint}</p>}
              </div>
              <NumericInput
                value={l.netCents}
                onChange={(v) => setNet(i, v)}
                codec={CODECS.money}
                tabIndex={grossMode ? -1 : undefined}
                aria-label={`Position ${i + 1}: Netto`}
                className={cn(grossMode && "text-muted-foreground")}
              />
              {noVat ? (
                <div className="flex h-9 items-center px-2.5 text-sm text-muted-foreground">–</div>
              ) : (
                <Select value={String(l.taxRateBp)} onValueChange={(v) => setRate(i, Number(v))}>
                  <SelectTrigger className="w-full px-2" aria-label={`Position ${i + 1}: USt.-Satz`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {rateOptions(l.taxRateBp).map((bp) => (
                      <SelectItem key={bp} value={String(bp)}>
                        {formatBp(bp)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <NumericInput
                value={l.taxCents}
                onChange={(v) => setTax(i, v)}
                codec={CODECS.money}
                disabled={noVat}
                aria-label={`Position ${i + 1}: USt.-Betrag`}
                title={taxOverridden ? `Manuell angepasst (berechnet: ${CODECS.money.display(expected)})` : undefined}
                className={cn(taxOverridden && "border-amber-300 bg-amber-50/50")}
              />
              <NumericInput
                value={linePayable(l, treatment)}
                onChange={(v) => setGross(i, v)}
                codec={CODECS.money}
                tabIndex={grossMode ? undefined : -1}
                aria-label={`Position ${i + 1}: ${selfAssessed ? "Betrag" : "Brutto"}`}
                className={cn(!grossMode && "text-muted-foreground")}
              />
              <NumericInput
                value={l.deductibleBp ?? 10000}
                onChange={(v) => set(i, { deductibleBp: Math.min(10000, v) })}
                codec={CODECS.percent}
                min={0}
                disabled={noVat}
                tabIndex={-1}
                aria-label={`Position ${i + 1}: Vorsteuer abzugsfähig %`}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                tabIndex={-1}
                className="size-9 text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-destructive"
                aria-label={`Position ${i + 1} entfernen`}
                onClick={() => remove(i)}
              >
                <Trash2 />
              </Button>
            </li>
          );
        })}
      </ol>

      <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={add}>
        <Plus />
        Position hinzufügen
      </Button>
    </div>
  );
}

function rateOptions(current: number): number[] {
  const rates: number[] = [...EXPENSE_TAX_RATES_BP];
  if (!rates.includes(current)) rates.push(current);
  return rates;
}
