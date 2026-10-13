import { useEffect, useMemo, useRef, useState } from "react";
import { useForm, useWatch, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import { CircleCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { COUNTRY_OPTIONS } from "@shared/countries";
import { todayIso } from "@shared/dates";
import {
  calcExpenseTotals,
  deductibleTaxCents,
  defaultVatTreatment,
  expenseTaxCents,
  getExpenseCategory,
  isSelfAssessed,
  netFromGross,
  VAT_TREATMENT_LABELS,
  VAT_TREATMENTS,
  type VatTreatment,
} from "@shared/expenses";
import { formatBp, formatCents } from "@shared/money";
import { type ExpenseFormData, type ExpenseFormValues, expenseFormSchema } from "@shared/schemas/expense";
import { Page } from "@/components/page";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ActionBar } from "@/features/documents/components/action-bar";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  type ExpenseDTO,
  expensesQuery,
  receiptUrl,
  useCreateExpense,
  useDeleteExpense,
  useRemoveReceipt,
  useUpdateExpense,
  useUploadReceipt,
} from "./api";
import { ExpenseBadges } from "./components/expense-badges";
import { ExpenseLinesEditor, newLine } from "./components/expense-lines-editor";
import { type ReceiptSource, ReceiptPane, receiptKind } from "./components/receipt-pane";
import { splitReceiptFiles } from "./components/file-drop";
import { SupplierInput } from "./components/supplier-input";

type Form = UseFormReturn<ExpenseFormValues, unknown, ExpenseFormData>;

export function toFormValues(e: ExpenseDTO): ExpenseFormValues {
  return {
    supplierName: e.supplierName,
    supplierUid: e.supplierUid,
    supplierCountry: e.supplierCountry,
    supplierInvoiceNumber: e.supplierInvoiceNumber,
    issueDate: e.issueDate,
    dueDate: e.dueDate,
    paidAt: e.paidAt,
    vatTreatment: e.vatTreatment,
    description: e.description,
    notes: e.notes,
    lines: e.lines.map((l) => ({
      category: l.category as ExpenseFormValues["lines"][number]["category"],
      description: l.description,
      netCents: l.netCents,
      taxRateBp: l.taxRateBp,
      taxCents: l.taxCents,
      deductibleBp: l.deductibleBp,
    })),
  };
}

export function emptyFormValues(): ExpenseFormValues {
  return {
    supplierName: "",
    supplierUid: "",
    supplierCountry: "AT",
    supplierInvoiceNumber: "",
    issueDate: todayIso(),
    dueDate: null,
    paidAt: null,
    vatTreatment: "domestic",
    description: "",
    notes: "",
    lines: [newLine()],
  };
}

const GROSS_MODE_KEY = "nesev.expenses.grossMode";

function useGrossMode(): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(GROSS_MODE_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const set = (v: boolean) => {
    setValue(v);
    try {
      localStorage.setItem(GROSS_MODE_KEY, v ? "1" : "0");
    } catch {
      // ignore
    }
  };
  return [value, set];
}

/**
 * Expense editor: receipt preview / drop zone on the left, data entry on the right.
 * ⌘/Ctrl+S saves, ⌘/Ctrl+Enter saves and opens the next one (next incomplete draft when editing a
 * draft, otherwise a new expense).
 */
export function ExpenseEditor({ expense, onSavedNext }: { expense?: ExpenseDTO; onSavedNext: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const create = useCreateExpense();
  const update = useUpdateExpense();
  const remove = useDeleteExpense();
  const upload = useUploadReceipt();
  const removeReceipt = useRemoveReceipt();
  const [grossMode, setGrossMode] = useGrossMode();
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** receipt dropped on a new, unsaved expense; uploaded on first save */
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const pendingUrl = useMemo(() => (pendingFile ? URL.createObjectURL(pendingFile) : null), [pendingFile]);
  useEffect(() => () => void (pendingUrl && URL.revokeObjectURL(pendingUrl)), [pendingUrl]);
  /** whether this expense was a draft when opened ("Speichern & nächster" then continues with drafts) */
  const [startedIncomplete] = useState(() => !!expense?.incomplete);
  /** an explicit choice (or a picked supplier) stops deriving the treatment from country + UID */
  const treatmentTouched = useRef(!!expense && !expense.incomplete);

  const form: Form = useForm<ExpenseFormValues, unknown, ExpenseFormData>({
    resolver: zodResolver(expenseFormSchema),
    defaultValues: expense ? toFormValues(expense) : emptyFormValues(),
  });
  const { control, formState } = form;
  const [treatment, lines] = useWatch({ control, name: ["vatTreatment", "lines"] });

  const leaving = useRef(false);
  const dirty = formState.isDirty || !!pendingFile;
  useBlocker({
    shouldBlockFn: () => !leaving.current && dirty && !window.confirm("Ungespeicherte Änderungen verwerfen?"),
    enableBeforeUnload: () => !leaving.current && dirty,
  });

  const busy = create.isPending || update.isPending || remove.isPending || upload.isPending;

  /** Switch treatment and adapt line rates/taxes ("none" has no VAT). */
  const applyTreatment = (next: VatTreatment) => {
    const prev = form.getValues("vatTreatment");
    if (prev === next) return;
    form.setValue("vatTreatment", next, { shouldDirty: true });
    const current = form.getValues("lines");
    if (next === "none") {
      current.forEach((_, i) => {
        form.setValue(`lines.${i}.taxRateBp`, 0, { shouldDirty: true });
        form.setValue(`lines.${i}.taxCents`, 0, { shouldDirty: true });
      });
    } else if (prev === "none") {
      current.forEach((l, i) => {
        const rate = l.taxRateBp || 2000;
        // the entered amount was the receipt total; in gross mode keep it as such
        const amounts =
          grossMode && !isSelfAssessed(next)
            ? netFromGross(l.netCents, rate)
            : { netCents: l.netCents, taxCents: expenseTaxCents(l.netCents, rate) };
        form.setValue(`lines.${i}`, { ...l, taxRateBp: rate, ...amounts }, { shouldDirty: true });
      });
    }
  };

  const deriveTreatment = () => {
    if (treatmentTouched.current) return;
    applyTreatment(defaultVatTreatment(form.getValues("supplierCountry"), form.getValues("supplierUid")));
  };

  const save = (): Promise<ExpenseDTO | null> =>
    new Promise((resolve) => {
      void form.handleSubmit(
        async (values) => {
          try {
            let saved = expense
              ? await update.mutateAsync({ id: expense.id, json: values })
              : await create.mutateAsync(values);
            if (pendingFile) {
              try {
                saved = await upload.mutateAsync({ id: saved.id, file: pendingFile });
                setPendingFile(null);
              } catch (err) {
                toast.error(`Beleg konnte nicht gespeichert werden: ${apiErrorMessage(err)}`);
              }
            }
            form.reset(toFormValues(saved));
            resolve(saved);
          } catch (err) {
            toast.error(apiErrorMessage(err));
            resolve(null);
          }
        },
        () => {
          toast.error("Bitte Eingaben prüfen");
          resolve(null);
        },
      )();
    });

  const onSave = async () => {
    const saved = await save();
    if (!saved) return;
    toast.success(`Ausgabe ${saved.number ?? ""} gespeichert`.replace("  ", " "));
    if (!expense) {
      leaving.current = true;
      void navigate({ to: "/expenses/$id", params: { id: saved.id }, replace: true });
    }
  };

  const onSaveNext = async () => {
    const saved = await save();
    if (!saved) return;
    toast.success(`Ausgabe ${saved.number ?? ""} gespeichert`.replace("  ", " "));
    leaving.current = true;
    if (startedIncomplete) {
      const drafts = await qc.fetchQuery(expensesQuery({ status: "incomplete" })).catch(() => []);
      // oldest draft first, as they were dropped
      const next = [...drafts].reverse().find((d) => d.id !== saved.id);
      if (next) {
        void navigate({ to: "/expenses/$id", params: { id: next.id } });
        return;
      }
    }
    onSavedNext();
  };

  const onDelete = () => {
    if (!expense) return;
    remove.mutate(expense.id, {
      onSuccess: () => {
        toast.success("Ausgabe gelöscht");
        leaving.current = true;
        void navigate({ to: "/expenses" });
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    });
  };

  const onFile = (file: File) => {
    const { accepted, rejected } = splitReceiptFiles([file]);
    if (rejected.length || !accepted[0]) {
      toast.error("Nur PDF, JPG, PNG oder WebP erlaubt");
      return;
    }
    if (!expense) {
      setPendingFile(accepted[0]);
      return;
    }
    upload.mutate(
      { id: expense.id, file: accepted[0] },
      { onSuccess: () => toast.success("Beleg gespeichert"), onError: (err) => toast.error(apiErrorMessage(err)) },
    );
  };

  const onRemoveReceipt = () => {
    if (!expense) {
      setPendingFile(null);
      return;
    }
    removeReceipt.mutate(expense.id, { onError: (err) => toast.error(apiErrorMessage(err)) });
  };

  // ⌘/Ctrl+S and ⌘/Ctrl+Enter
  const keys = useRef({ onSave, onSaveNext });
  keys.current = { onSave, onSaveNext };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        void keys.current.onSave();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void keys.current.onSaveNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const receipt: ReceiptSource | null = pendingFile
    ? { url: pendingUrl!, name: pendingFile.name, kind: receiptKind(pendingFile.name, pendingFile.type) }
    : expense?.attachmentPath
      ? { url: receiptUrl(expense)!, name: expense.attachmentName, kind: receiptKind(expense.attachmentPath) }
      : null;

  return (
    <Page
      className="max-w-[1600px]"
      title={
        <span className="flex items-center gap-3">
          {expense ? `Ausgabe ${expense.number ?? ""}` : "Neue Ausgabe"}
          {expense && <ExpenseBadges expense={expense} />}
        </span>
      }
    >
      <div className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <ReceiptPane
          receipt={receipt}
          onFile={onFile}
          onRemove={onRemoveReceipt}
          busy={upload.isPending || removeReceipt.isPending}
          className="lg:sticky lg:top-6 lg:h-[calc(100vh-7rem)] lg:self-start"
        />

        <Form {...form}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void onSave();
            }}
            className="min-w-0"
          >
            <section className="grid gap-4 border-b pb-6 sm:grid-cols-2">
              <FormField
                control={control}
                name="supplierName"
                render={({ field }) => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>Lieferant</FormLabel>
                    <SupplierInput
                      inputRef={field.ref}
                      autoFocus={!expense || !expense.supplierName}
                      value={field.value ?? ""}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      onPick={(s) => applySupplier(form, s, applyTreatment, treatmentTouched)}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name="supplierCountry"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Land</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(v) => {
                        field.onChange(v);
                        deriveTreatment();
                      }}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {COUNTRY_OPTIONS.map((c) => (
                          <SelectItem key={c.code} value={c.code}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name="supplierUid"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>UID-Nummer</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder="optional"
                        onBlur={() => {
                          field.onBlur();
                          deriveTreatment();
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name="supplierInvoiceNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Rechnungsnummer (Lieferant)</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="optional" />
                    </FormControl>
                  </FormItem>
                )}
              />
              <DateInput form={form} name="issueDate" label="Rechnungsdatum" />
              <DateInput form={form} name="dueDate" label="Fällig am" />
              <PaidField form={form} />
            </section>

            <section className="grid gap-4 border-b py-6">
              <FormField
                control={control}
                name="vatTreatment"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Umsatzsteuer</FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(v) => {
                        treatmentTouched.current = true;
                        applyTreatment(v as VatTreatment);
                      }}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {VAT_TREATMENTS.map((t) => (
                          <SelectItem key={t} value={t}>
                            {VAT_TREATMENT_LABELS[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {isSelfAssessed(treatment) && (
                      <p className="text-xs text-muted-foreground">
                        Rechnung ohne USt.: Steuer wird selbst berechnet und ist zugleich als Vorsteuer abziehbar.
                        „Betrag“ = Rechnungsbetrag.
                      </p>
                    )}
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name="description"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Beschreibung</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="z. B. Hosting Oktober" />
                    </FormControl>
                  </FormItem>
                )}
              />
            </section>

            <section className="py-6">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-medium">Positionen</h2>
                <div className="flex items-center gap-2">
                  <Switch id="gross-mode" checked={grossMode} onCheckedChange={setGrossMode} />
                  <Label htmlFor="gross-mode" className="text-sm font-normal text-muted-foreground">
                    Brutto-Eingabe
                  </Label>
                </div>
              </div>
              <ExpenseLinesEditor form={form} treatment={treatment} grossMode={grossMode} />
              <div className="mt-6 flex justify-end">
                <ExpenseTotals lines={lines ?? []} treatment={treatment} />
              </div>
            </section>

            <section className="border-t pt-6">
              <FormField
                control={control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notizen</FormLabel>
                    <FormControl>
                      <Textarea {...field} rows={2} placeholder="intern" />
                    </FormControl>
                  </FormItem>
                )}
              />
            </section>

            <ActionBar
              left={
                expense && (
                  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>
                    <Trash2 />
                    Löschen
                  </Button>
                )
              }
            >
              <span className="mr-2 text-xs text-muted-foreground">
                {dirty ? "Ungespeicherte Änderungen" : expense ? "Gespeichert" : ""}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void onSaveNext()}
                title="⌘/Strg + Enter"
              >
                Speichern & nächster
              </Button>
              <Button type="submit" size="sm" disabled={busy} title="⌘/Strg + S">
                Speichern
              </Button>
            </ActionBar>
          </form>
        </Form>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Ausgabe löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              Die Ausgabe {expense?.number} und der zugehörige Beleg werden endgültig gelöscht. Zuordnungen zu
              Bankbuchungen werden entfernt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete} className="bg-destructive text-white hover:bg-destructive/90">
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

/** Prefill from a previous expense of the same supplier. */
function applySupplier(
  form: Form,
  s: { name: string; uid: string; country: string; vatTreatment: VatTreatment; category: string | null; taxRateBp: number | null; deductibleBp: number | null; description: string },
  applyTreatment: (t: VatTreatment) => void,
  treatmentTouched: React.RefObject<boolean>,
) {
  const opts = { shouldDirty: true };
  form.setValue("supplierName", s.name, opts);
  form.setValue("supplierUid", s.uid, opts);
  form.setValue("supplierCountry", s.country, opts);
  applyTreatment(s.vatTreatment);
  treatmentTouched.current = true;
  if (!form.getValues("description") && s.description) form.setValue("description", s.description, opts);
  // Only prefill the line when nothing was entered yet.
  const lines = form.getValues("lines");
  const untouched = lines.every((l) => l.netCents === 0 && l.taxCents === 0 && !l.description);
  if (untouched && s.category) {
    const cat = getExpenseCategory(s.category);
    const line = newLine(s.category, s.vatTreatment === "none" ? 0 : (s.taxRateBp ?? 2000));
    form.setValue("lines", [{ ...line, deductibleBp: s.deductibleBp ?? cat?.defaultDeductibleBp ?? 10000 }], opts);
  }
}

function DateInput({ form, name, label }: { form: Form; name: "issueDate" | "dueDate"; label: string }) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="date"
              {...field}
              value={field.value ?? ""}
              onChange={(e) => field.onChange(name === "issueDate" ? e.target.value : e.target.value || null)}
              className="tabular"
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function PaidField({ form }: { form: Form }) {
  return (
    <FormField
      control={form.control}
      name="paidAt"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Bezahlt am</FormLabel>
          <div className="flex gap-2">
            <FormControl>
              <Input
                type="date"
                {...field}
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value || null)}
                className={cn("tabular", field.value && "border-emerald-300")}
              />
            </FormControl>
            {!field.value && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 shrink-0"
                tabIndex={-1}
                onClick={() => field.onChange(form.getValues("issueDate") || todayIso())}
                title="Als bezahlt am Rechnungsdatum markieren"
              >
                <CircleCheck />
                Bezahlt
              </Button>
            )}
          </div>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function ExpenseTotals({ lines, treatment }: { lines: ExpenseFormValues["lines"]; treatment: VatTreatment }) {
  const normalized = lines.map((l) => ({
    netCents: l.netCents,
    taxRateBp: treatment === "none" ? 0 : l.taxRateBp,
    taxCents: treatment === "none" ? 0 : l.taxCents,
    deductibleBp: l.deductibleBp ?? 10000,
  }));
  const totals = calcExpenseTotals(normalized, treatment);
  const byRate = new Map<number, number>();
  for (const l of normalized) if (l.taxRateBp > 0) byRate.set(l.taxRateBp, (byRate.get(l.taxRateBp) ?? 0) + l.taxCents);
  const deductible = normalized.reduce((s, l) => s + deductibleTaxCents(l), 0);
  const selfAssessed = isSelfAssessed(treatment);

  return (
    <div className="w-full max-w-sm space-y-1.5 text-sm">
      <Row label="Summe netto" value={formatCents(totals.netCents)} />
      {[...byRate.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([rate, tax]) => (
          <Row
            key={rate}
            label={`${selfAssessed ? "USt. (selbst berechnet)" : treatment === "import" ? "EUSt." : "USt."} ${formatBp(rate)}`}
            value={formatCents(tax)}
            muted
          />
        ))}
      <div className="flex items-baseline justify-between border-t pt-2 text-base font-semibold">
        <span>{selfAssessed ? "Rechnungsbetrag" : "Gesamt brutto"}</span>
        <span className="tabular">{formatCents(totals.grossCents)}</span>
      </div>
      {treatment !== "none" && (
        <Row label="davon abziehbare Vorsteuer" value={formatCents(deductible)} muted />
      )}
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
