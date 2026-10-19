import { useEffect, useState } from "react";
import { type Control, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { formatDate, todayIso } from "@shared/dates";
import { DEFAULT_EXPENSE_CATEGORY, EXPENSE_TAX_RATES_BP, getExpenseCategory } from "@shared/expenses";
import { formatBp, formatCents } from "@shared/money";
import { INTERVAL_PRESETS } from "@shared/recurring";
import { containedTaxCents, monthlyEquivalentCents, paymentDatesBetween } from "@shared/recurring-expenses";
import {
  type RecurringExpenseCreate,
  recurringExpenseCreateSchema,
  type RecurringExpenseFormValues,
} from "@shared/schemas/recurring-expense";
import { SwitchField, TextareaField, TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CODECS, NumericInput } from "@/features/documents/components/numeric-input";
import { CategorySelect } from "@/features/expenses/components/category-select";
import { SupplierInput } from "@/features/expenses/components/supplier-input";
import { apiErrorMessage, type RecurringExpense, useCreateRecurringExpense, useUpdateRecurringExpense } from "@/sdk";

type FormCtl = Control<RecurringExpenseFormValues, unknown, RecurringExpenseCreate>;

const emptyValues = (): RecurringExpenseFormValues => ({
  name: "",
  supplierName: "",
  category: DEFAULT_EXPENSE_CATEGORY,
  active: true,
  intervalUnit: "month",
  intervalCount: 1,
  startDate: todayIso(),
  endDate: null,
  grossCents: 0,
  taxCents: 0,
  notes: "",
});

function toValues(r: RecurringExpense): RecurringExpenseFormValues {
  const { name, supplierName, active, intervalUnit, intervalCount, startDate, endDate, grossCents, taxCents, notes } = r;
  const category = getExpenseCategory(r.category) ? r.category : DEFAULT_EXPENSE_CATEGORY;
  return { name, supplierName, category: category as RecurringExpenseFormValues["category"], active, intervalUnit, intervalCount, startDate, endDate, grossCents, taxCents, notes };
}

/** The rate whose contained VAT matches the stored amount; "custom" when edited by hand. */
function rateFor(grossCents: number, taxCents: number): string {
  if (grossCents === 0) return "2000";
  const bp = EXPENSE_TAX_RATES_BP.find((r) => containedTaxCents(grossCents, r) === taxCents);
  return bp === undefined ? "custom" : String(bp);
}

/** Create (`item` null) or edit a Fixkosten entry. */
export function FixedCostDialog({
  open,
  onOpenChange,
  item,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: RecurringExpense | null;
}) {
  const form = useForm<RecurringExpenseFormValues, unknown, RecurringExpenseCreate>({
    resolver: zodResolver(recurringExpenseCreateSchema),
    defaultValues: emptyValues(),
  });
  const create = useCreateRecurringExpense();
  const update = useUpdateRecurringExpense();
  const [rate, setRate] = useState("2000");

  useEffect(() => {
    if (!open) return;
    const values = item ? toValues(item) : emptyValues();
    form.reset(values);
    setRate(rateFor(values.grossCents, values.taxCents));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when (re)opened
  }, [open, item?.id]);

  const applyRate = (gross: number, r: string) => {
    if (r !== "custom") form.setValue("taxCents", containedTaxCents(gross, Number(r)), { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  };

  const onSubmit = (values: RecurringExpenseCreate) => {
    const done = {
      onSuccess: () => {
        toast.success(item ? "Fixkosten gespeichert" : `„${values.name}“ angelegt`);
        onOpenChange(false);
      },
      onError: (err: unknown) => toast.error(apiErrorMessage(err)),
    };
    if (item) update.mutate({ id: item.id, json: values }, done);
    else create.mutate(values, done);
  };
  const pending = create.isPending || update.isPending;
  const { control } = form;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{item ? "Fixkosten bearbeiten" : "Neue Fixkosten"}</DialogTitle>
          <DialogDescription>
            Wiederkehrende Zahlung, die in der Zahlungsprognose als Ausgang eingeplant wird. Gebucht wird nichts –
            die tatsächliche Rechnung erfassen Sie weiterhin als Ausgabe.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField control={control} name="name" label="Bezeichnung" placeholder="z.B. SVS-Beiträge" autoFocus autoComplete="off" />
              <FormField
                control={control}
                name="supplierName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Empfänger</FormLabel>
                    <FormControl>
                      <SupplierInput
                        value={field.value}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        inputRef={field.ref}
                        onPick={(s) => {
                          field.onChange(s.name);
                          if (s.category && getExpenseCategory(s.category)) {
                            form.setValue("category", s.category as RecurringExpenseFormValues["category"], { shouldDirty: true });
                          }
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-[1fr_150px_190px]">
              <FormField
                control={control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Kategorie</FormLabel>
                    <CategorySelect value={field.value} onChange={field.onChange} triggerRef={field.ref} className="w-full" aria-label="Kategorie" />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name="grossCents"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Betrag brutto (€)</FormLabel>
                    <FormControl>
                      <NumericInput
                        ref={field.ref}
                        name={field.name}
                        value={field.value}
                        min={0}
                        onChange={(v) => {
                          field.onChange(v);
                          applyRate(v, rate);
                        }}
                        onBlur={field.onBlur}
                        codec={CODECS.money}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name="taxCents"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>enthaltene USt. (€)</FormLabel>
                    <div className="flex gap-1.5">
                      <Select
                        value={rate}
                        onValueChange={(r) => {
                          setRate(r);
                          applyRate(form.getValues("grossCents"), r);
                        }}
                      >
                        <SelectTrigger className="w-[76px] shrink-0 px-2" aria-label="USt.-Satz">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {EXPENSE_TAX_RATES_BP.map((bp) => (
                            <SelectItem key={bp} value={String(bp)}>
                              {formatBp(bp)}
                            </SelectItem>
                          ))}
                          <SelectItem value="custom">manuell</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormControl>
                        <NumericInput
                          ref={field.ref}
                          name={field.name}
                          value={field.value}
                          min={0}
                          onChange={(v) => {
                            field.onChange(v);
                            setRate("custom");
                          }}
                          onBlur={field.onBlur}
                          codec={CODECS.money}
                        />
                      </FormControl>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <IntervalField control={control} setUnit={(u) => form.setValue("intervalUnit", u, { shouldDirty: true })} />
              <DateField control={control} name="startDate" label="Erste Zahlung am" />
              <DateField control={control} name="endDate" label="Endet am" placeholder="unbefristet" />
            </div>
            <SchedulePreview control={control} />

            <TextareaField control={control} name="notes" label="Notizen" rows={2} placeholder="z.B. Vertragsnummer, Kündigungsfrist" />
            <SwitchField control={control} name="active" label="Aktiv" description="Pausierte Fixkosten werden in der Prognose nicht berücksichtigt." />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Abbrechen
              </Button>
              <Button type="submit" disabled={pending}>
                {item ? "Speichern" : "Anlegen"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function IntervalField({ control, setUnit }: { control: FormCtl; setUnit: (u: "month" | "year") => void }) {
  const [unit, count] = useWatch({ control, name: ["intervalUnit", "intervalCount"] });
  const preset = INTERVAL_PRESETS.find((p) => p.interval.intervalUnit === unit && p.interval.intervalCount === count);
  const [custom, setCustom] = useState(false);
  const showCustom = custom || !preset;
  return (
    <FormField
      control={control}
      name="intervalCount"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Intervall</FormLabel>
          <Select
            value={showCustom ? "custom" : preset.key}
            onValueChange={(key) => {
              const p = INTERVAL_PRESETS.find((x) => x.key === key);
              setCustom(!p);
              if (p) {
                field.onChange(p.interval.intervalCount);
                setUnit(p.interval.intervalUnit);
              } else {
                field.onChange(2);
                setUnit("month");
              }
            }}
          >
            <FormControl>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {INTERVAL_PRESETS.map((p) => (
                <SelectItem key={p.key} value={p.key}>
                  {p.label}
                </SelectItem>
              ))}
              <SelectItem value="custom">Alle N Monate …</SelectItem>
            </SelectContent>
          </Select>
          {showCustom && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              alle
              <Input
                type="number"
                min={1}
                max={60}
                className="h-8 w-16 tabular"
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value === "" ? 1 : Number(e.target.value))}
                aria-label="Anzahl"
              />
              {unit === "year" ? "Jahre" : "Monate"}
            </div>
          )}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function DateField({ control, name, label, placeholder }: { control: FormCtl; name: "startDate" | "endDate"; label: string; placeholder?: string }) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="date"
              {...field}
              placeholder={placeholder}
              value={field.value ?? ""}
              onChange={(e) => field.onChange(name === "endDate" ? e.target.value || null : e.target.value)}
              className="tabular"
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** Next payment dates and the monthly equivalent. */
function SchedulePreview({ control }: { control: FormCtl }) {
  const [startDate, endDate, intervalUnit, intervalCount, grossCents] = useWatch({
    control,
    name: ["startDate", "endDate", "intervalUnit", "intervalCount", "grossCents"],
  });
  if (!startDate || !intervalCount || intervalCount < 1) return null;
  const schedule = { startDate, endDate: endDate ?? null, intervalUnit, intervalCount };
  const next = paymentDatesBetween(schedule, todayIso(), "9999-12-31", 4);
  return (
    <p className="-mt-1 text-xs text-muted-foreground">
      {next.length ? (
        <>
          Nächste Zahlungen: <span className="tabular">{next.map(formatDate).join(" · ")}</span>
        </>
      ) : (
        "Keine künftigen Zahlungen (Ende liegt in der Vergangenheit)."
      )}
      {grossCents > 0 && (intervalUnit !== "month" || intervalCount !== 1) && (
        <> · entspricht {formatCents(monthlyEquivalentCents({ intervalUnit, intervalCount, grossCents }))} pro Monat</>
      )}
    </p>
  );
}
