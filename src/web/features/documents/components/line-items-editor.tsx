import { useState } from "react";
import { type Control, Controller, useController, useFieldArray, useWatch } from "react-hook-form";
import { BookmarkPlus, ChevronDown, ChevronUp, Plus, Tag, Trash2 } from "lucide-react";
import { formatBp, formatCents } from "@shared/money";
import type { DocumentItemInput, documentItemSchema } from "@shared/schemas/document";
import type { z } from "@shared/schemas/zod";
import { AT_TAX_RATES_BP, DEFAULT_TAX_RATE_BP, type TaxMode } from "@shared/tax";
import { calcLine } from "@shared/totals";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { ArticleDTO } from "@/features/articles/api";
import { ArticleAutocompleteInput } from "@/features/articles/components/article-autocomplete";
import { ArticleFormDialog } from "@/features/articles/components/article-form-dialog";
import { cn } from "@/lib/utils";
import { CODECS, NumericInput } from "./numeric-input";

/** Any form with an `items` array of document lines (documents, recurring invoices, ...). */
export type LineItemsFormValues = { items: z.input<typeof documentItemSchema>[] };
// The editor only touches `items.*`, so it works on the narrowed form type internally.
type FormControl = Control<LineItemsFormValues>;

export const GRID = "grid grid-cols-[28px_minmax(0,1fr)_84px_76px_112px_84px_72px_112px_60px] gap-x-2";

export function newItem(taxRateBp: number = DEFAULT_TAX_RATE_BP): DocumentItemInput {
  return { articleId: null, title: "", description: "", quantity: 1000, unit: "", unitPriceCents: 0, taxRateBp, discountBp: 0 };
}

/**
 * Line-item table editor for any react-hook-form whose values contain `items` (see LineItemsFormValues).
 * The title field suggests catalog articles; picking one copies its values into the line.
 * Keyboard: Tab through fields; Alt+↑/↓ moves the focused row; "Position hinzufügen" focuses the new row's title.
 */
export function LineItemsEditor<T extends LineItemsFormValues, TTransformed = T>({
  control: formControl,
  taxMode,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any form context
  control: Control<T, any, TTransformed>;
  taxMode: TaxMode;
}) {
  const control = formControl as unknown as FormControl;
  const { fields, append, remove, move, update } = useFieldArray({ control, name: "items" });
  const items = useWatch({ control, name: "items" }) ?? [];
  /** row index for "Als Artikel speichern" */
  const [saveIndex, setSaveIndex] = useState<number | null>(null);
  const saveItem = saveIndex !== null ? items[saveIndex] : undefined;

  const add = () => {
    const lastRate = items.at(-1)?.taxRateBp ?? DEFAULT_TAX_RATE_BP;
    append(newItem(lastRate), { focusName: `items.${fields.length}.title` });
  };

  const moveRow = (from: number, to: number) => {
    if (to < 0 || to >= fields.length) return;
    move(from, to);
  };

  return (
    <div>
      <div className={cn(GRID, "border-b pb-2 text-xs font-medium text-muted-foreground")}>
        <span />
        <span>Bezeichnung</span>
        <span className="text-right">Menge</span>
        <span>Einheit</span>
        <span className="text-right">Einzelpreis</span>
        <span>USt.</span>
        <span className="text-right">Rabatt %</span>
        <span className="text-right">Gesamt netto</span>
        <span />
      </div>

      {fields.length === 0 && (
        <div className="py-8 text-center text-sm text-muted-foreground">Noch keine Positionen.</div>
      )}

      <ol>
        {fields.map((field, index) => {
          const item = items[index];
          const line = item
            ? calcLine(
                { quantity: item.quantity, unitPriceCents: item.unitPriceCents, taxRateBp: item.taxRateBp, discountBp: item.discountBp },
                taxMode,
              )
            : null;
          return (
            <li
              key={field.id}
              className={cn(GRID, "group items-start border-b py-2.5")}
              onKeyDown={(e) => {
                if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                  e.preventDefault();
                  const target = e.target as HTMLElement;
                  moveRow(index, e.key === "ArrowUp" ? index - 1 : index + 1);
                  requestAnimationFrame(() => target.focus());
                }
              }}
            >
              <div className="flex flex-col items-center pt-0.5 text-muted-foreground">
                <span className="tabular text-xs leading-4 group-hover:hidden group-focus-within:hidden">{index + 1}</span>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label="Nach oben"
                  disabled={index === 0}
                  onClick={() => moveRow(index, index - 1)}
                  className="hidden rounded hover:text-foreground disabled:opacity-30 group-hover:block group-focus-within:block"
                >
                  <ChevronUp className="size-4" />
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label="Nach unten"
                  disabled={index === fields.length - 1}
                  onClick={() => moveRow(index, index + 1)}
                  className="hidden rounded hover:text-foreground disabled:opacity-30 group-hover:block group-focus-within:block"
                >
                  <ChevronDown className="size-4" />
                </button>
              </div>

              <div className="space-y-1.5">
                <TitleField control={control} index={index} taxMode={taxMode} linked={item?.articleId != null} />
                <Controller
                  control={control}
                  name={`items.${index}.description`}
                  render={({ field: f }) => (
                    <Textarea
                      {...f}
                      value={f.value ?? ""}
                      rows={1}
                      placeholder="Beschreibung (optional)"
                      aria-label={`Position ${index + 1}: Beschreibung`}
                      className="min-h-8 resize-none py-1.5 text-muted-foreground focus-visible:text-foreground"
                    />
                  )}
                />
              </div>

              <Controller
                control={control}
                name={`items.${index}.quantity`}
                render={({ field: f }) => (
                  <NumericInput
                    ref={f.ref}
                    name={f.name}
                    value={f.value}
                    onChange={f.onChange}
                    onBlur={f.onBlur}
                    codec={CODECS.quantity}
                    aria-label={`Position ${index + 1}: Menge`}
                  />
                )}
              />
              <Controller
                control={control}
                name={`items.${index}.unit`}
                render={({ field: f }) => (
                  <Input {...f} value={f.value ?? ""} placeholder="Stk." aria-label={`Position ${index + 1}: Einheit`} />
                )}
              />
              <Controller
                control={control}
                name={`items.${index}.unitPriceCents`}
                render={({ field: f }) => (
                  <NumericInput
                    ref={f.ref}
                    name={f.name}
                    value={f.value}
                    onChange={f.onChange}
                    onBlur={f.onBlur}
                    codec={CODECS.money}
                    aria-label={`Position ${index + 1}: Einzelpreis`}
                  />
                )}
              />
              <Controller
                control={control}
                name={`items.${index}.taxRateBp`}
                render={({ field: f }) =>
                  taxMode === "AT_DOMESTIC" ? (
                    <Select value={String(f.value)} onValueChange={(v) => f.onChange(Number(v))}>
                      <SelectTrigger ref={f.ref} className="w-full px-2.5" aria-label={`Position ${index + 1}: USt.-Satz`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {rateOptions(f.value).map((bp) => (
                          <SelectItem key={bp} value={String(bp)}>
                            {formatBp(bp)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div
                      className="flex h-9 items-center px-2.5 text-sm text-muted-foreground"
                      title="Im gewählten Steuermodus wird keine Umsatzsteuer berechnet"
                    >
                      0 %
                    </div>
                  )
                }
              />
              <Controller
                control={control}
                name={`items.${index}.discountBp`}
                render={({ field: f }) => (
                  <NumericInput
                    ref={f.ref}
                    name={f.name}
                    value={f.value ?? 0}
                    onChange={f.onChange}
                    onBlur={f.onBlur}
                    codec={CODECS.percent}
                    min={0}
                    aria-label={`Position ${index + 1}: Rabatt in Prozent`}
                  />
                )}
              />
              <div className="flex h-9 flex-col items-end justify-center text-sm">
                <span className="tabular">{line ? formatCents(line.netCents) : ""}</span>
                {line && line.discountCents !== 0 && (
                  <span className="tabular text-xs text-muted-foreground line-through">{formatCents(line.grossLineCents)}</span>
                )}
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  tabIndex={-1}
                  aria-label={`Position ${index + 1} als Artikel speichern`}
                  title="Als Artikel speichern"
                  disabled={!item?.title.trim()}
                  onClick={() => setSaveIndex(index)}
                  className="text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <BookmarkPlus />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Position ${index + 1} entfernen`}
                  onClick={() => remove(index)}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 />
                </Button>
              </div>
            </li>
          );
        })}
      </ol>

      <Button type="button" variant="ghost" size="sm" onClick={add} className="mt-2 text-muted-foreground">
        <Plus />
        Position hinzufügen
      </Button>

      <ArticleFormDialog
        open={saveIndex !== null}
        onOpenChange={(open) => !open && setSaveIndex(null)}
        title="Als Artikel speichern"
        defaults={
          saveItem && {
            title: saveItem.title,
            description: saveItem.description ?? "",
            unit: saveItem.unit ?? "",
            unitPriceCents: saveItem.unitPriceCents,
            taxRateBp: saveItem.taxRateBp,
          }
        }
        onSaved={(article) => {
          // link the line to the new article (its values already match)
          if (saveIndex !== null && items[saveIndex]) update(saveIndex, { ...items[saveIndex], articleId: article.id });
        }}
      />
    </div>
  );
}

/** Title input with article suggestions; picking an article copies its values into the line. */
function TitleField({
  control,
  index,
  taxMode,
  linked,
}: {
  control: FormControl;
  index: number;
  taxMode: TaxMode;
  linked: boolean;
}) {
  const name = `items.${index}` as const;
  const title = useController({ control, name: `${name}.title` });
  const description = useController({ control, name: `${name}.description` });
  const unit = useController({ control, name: `${name}.unit` });
  const price = useController({ control, name: `${name}.unitPriceCents` });
  const rate = useController({ control, name: `${name}.taxRateBp` });
  const articleId = useController({ control, name: `${name}.articleId` });

  const pick = (a: ArticleDTO) => {
    title.field.onChange(a.title);
    description.field.onChange(a.description);
    unit.field.onChange(a.unit);
    price.field.onChange(a.unitPriceCents);
    // stored as-is; tax modes without VAT still compute 0 % (calcLine)
    rate.field.onChange(a.taxRateBp);
    articleId.field.onChange(a.id);
    // continue with the quantity
    requestAnimationFrame(() => {
      const qty = document.querySelector<HTMLInputElement>(`input[name="${name}.quantity"]`);
      qty?.focus();
    });
  };

  return (
    <div className="relative">
      <ArticleAutocompleteInput
        ref={title.field.ref}
        name={title.field.name}
        value={title.field.value ?? ""}
        onChange={title.field.onChange}
        onBlur={title.field.onBlur}
        onPick={pick}
        showTax={taxMode === "AT_DOMESTIC"}
        placeholder="Bezeichnung oder Artikel suchen…"
        aria-label={`Position ${index + 1}: Bezeichnung`}
        className={cn("font-medium", linked && "pr-8")}
      />
      {linked && (
        <Tag
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/60"
        />
      )}
    </div>
  );
}

function rateOptions(current: number): number[] {
  const rates: number[] = [...AT_TAX_RATES_BP];
  return rates.includes(current) ? rates : [...rates, current].sort((a, b) => b - a);
}
