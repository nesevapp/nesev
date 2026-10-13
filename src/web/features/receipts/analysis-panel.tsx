import { useWatch, type UseFormReturn } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, Loader2, ScanText, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { countryName } from "@shared/countries";
import { formatDate } from "@shared/dates";
import {
  calcExpenseTotals,
  categoryLabel,
  DEFAULT_EXPENSE_CATEGORY,
  getExpenseCategory,
  VAT_TREATMENT_SHORT_LABELS,
  type VatTreatment,
} from "@shared/expenses";
import { formatBp, formatCents } from "@shared/money";
import {
  confidenceLevel,
  FIELD_SOURCE_LABELS,
  type FieldSuggestion,
  type ReceiptFields,
  suggestedLines,
  TEXT_SOURCE_LABELS,
} from "@shared/receipts";
import type { ExpenseFormData, ExpenseFormValues } from "@shared/schemas/expense";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CodeText } from "./code-text";
import { receiptAnalysisQuery, type ReceiptAnalysisDTO, useAnalyzeReceipts, useCancelAnalysis } from "./api";

type Form = UseFormReturn<ExpenseFormValues, unknown, ExpenseFormData>;
type FormLine = ExpenseFormValues["lines"][number];

/** Form fields a suggestion can be applied to ("lines" = the tax breakdown as expense lines). */
export type ApplyKey =
  | "supplierName"
  | "supplierUid"
  | "supplierCountry"
  | "supplierInvoiceNumber"
  | "issueDate"
  | "dueDate"
  | "vatTreatment"
  | "category"
  | "description"
  | "lines";

export interface ApplyTarget {
  form: Form;
  /** sets the treatment and adapts line rates (the editor's handler) */
  applyTreatment: (t: VatTreatment) => void;
  /** the expense is a draft: its defaulted date / country / treatment count as empty */
  draft: boolean;
  onApplied: (keys: ApplyKey[], analysisId: number) => void;
}

/** Highlight for fields filled from suggestions but not saved yet. */
export const APPLIED_CLASS = "bg-sky-50 ring-2 ring-sky-200";

const LABELS: Record<ApplyKey, string> = {
  supplierName: "Lieferant",
  supplierUid: "UID",
  supplierCountry: "Land",
  supplierInvoiceNumber: "Rechnungsnr.",
  issueDate: "Datum",
  dueDate: "Fällig am",
  vatTreatment: "USt.",
  category: "Kategorie",
  description: "Beschreibung",
  lines: "Positionen",
};

const ORDER: ApplyKey[] = [
  "supplierName",
  "supplierUid",
  "supplierCountry",
  "supplierInvoiceNumber",
  "issueDate",
  "dueDate",
  "vatTreatment",
  "category",
  "description",
  "lines",
];

/** treatment first: suggested lines depend on it */
const APPLY_ORDER: ApplyKey[] = ["vatTreatment", ...ORDER.filter((k) => k !== "vatTreatment")];

const untouchedLines = (lines: readonly FormLine[]) =>
  lines.every((l) => l.netCents === 0 && l.taxCents === 0 && !l.description);

function linesSummary(lines: readonly { netCents: number; taxRateBp: number; taxCents: number }[]): string {
  return lines.map((l) => `${formatBp(l.taxRateBp)}: ${formatCents(l.netCents)} + ${formatCents(l.taxCents)}`).join(" · ");
}

function suggestionFor(key: ApplyKey, fields: ReceiptFields): FieldSuggestion<unknown> | undefined {
  if (key === "lines") return fields.taxLines ?? (fields.grossCents && { ...fields.grossCents, confidence: Math.min(fields.grossCents.confidence, 0.5) });
  return fields[key];
}

function display(key: ApplyKey, value: unknown, fields: ReceiptFields, treatment: VatTreatment): string {
  switch (key) {
    case "issueDate":
    case "dueDate":
      return formatDate(value as string);
    case "supplierCountry":
      return `${countryName(value as string)} (${value as string})`;
    case "vatTreatment":
      return VAT_TREATMENT_SHORT_LABELS[value as VatTreatment];
    case "category":
      return categoryLabel(value as string);
    case "lines":
      return linesSummary(suggestedLines(fields, treatment));
    default:
      return String(value);
  }
}

function ConfidenceDot({ s }: { s: FieldSuggestion<unknown> }) {
  const level = confidenceLevel(s.confidence);
  return (
    <span
      className={cn(
        "mt-1.5 inline-block size-2 shrink-0 rounded-full",
        level === "high" ? "bg-emerald-500" : level === "medium" ? "bg-amber-400" : "bg-red-400",
      )}
      title={`Sicherheit ${Math.round(s.confidence * 100)} % · ${FIELD_SOURCE_LABELS[s.source]}${s.note ? ` · ${s.note}` : ""}`}
    />
  );
}

/**
 * "Erkennung" panel next to the receipt preview: queue/run state, suggested fields with confidence, apply
 * all (empty fields only) or single fields, and the raw text. Nothing is saved here — applied values are
 * plain form changes until the user saves the expense.
 */
export function AnalysisPanel({
  expenseId,
  hasReceipt,
  target,
  className,
}: {
  expenseId: number;
  hasReceipt: boolean;
  target: ApplyTarget;
  className?: string;
}) {
  const { data: analysis, isPending } = useQuery(receiptAnalysisQuery(expenseId));
  const analyze = useAnalyzeReceipts();
  const cancel = useCancelAnalysis();

  const start = () =>
    analyze.mutate([expenseId], {
      onSuccess: (r) => {
        if (r.skipped.length) toast.info(`Nicht analysiert: ${r.skipped[0]!.reason}`);
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    });

  if (!hasReceipt) return null;
  const active = analysis && (analysis.status === "queued" || analysis.status === "running");
  const usable = analysis && !analysis.stale && !active && analysis.result;

  return (
    <section className={cn("flex min-h-0 flex-col rounded-lg border bg-background text-sm", className)}>
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <ScanText className="size-4 text-muted-foreground" />
        <h2 className="font-medium">Erkennung</h2>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {isPending ? "" : <StatusText analysis={analysis ?? null} />}
        </span>
        {active ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(analysis.id, { onError: (err) => toast.error(apiErrorMessage(err)) })}
          >
            <X />
            Abbrechen
          </Button>
        ) : (
          <Button
            type="button"
            variant={usable ? "ghost" : "outline"}
            size="sm"
            className="h-7"
            disabled={analyze.isPending || isPending}
            onClick={start}
          >
            {analyze.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {analysis && !analysis.stale && analysis.status !== "cancelled" ? "Erneut analysieren" : "Beleg analysieren"}
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {analysis?.status === "failed" && !analysis.stale && analysis.error && (
          <p className="border-b bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
            <CodeText text={analysis.error} />
            {analysis.result && " – Vorschläge unten stammen nur aus der Regel-Erkennung."}
          </p>
        )}
        {usable && <Suggestions analysis={analysis} target={target} />}
      </div>
    </section>
  );
}

function StatusText({ analysis }: { analysis: ReceiptAnalysisDTO | null }) {
  if (!analysis) return <>Noch nicht analysiert</>;
  if (analysis.stale) return <>Beleg wurde ersetzt – neu analysieren</>;
  switch (analysis.status) {
    case "queued":
      return (
        <span className="inline-flex items-center gap-1">
          <Loader2 className="size-3 animate-spin" /> In Warteschlange…
        </span>
      );
    case "running":
      return (
        <span className="inline-flex items-center gap-1">
          <Loader2 className="size-3 animate-spin" /> Analysiere…
        </span>
      );
    case "cancelled":
      return <>Abgebrochen</>;
    case "failed":
      return <>Fehlgeschlagen</>;
    default: {
      const parts = [
        analysis.textSource ? TEXT_SOURCE_LABELS[analysis.textSource] : null,
        analysis.model || (analysis.textSource === "xml" ? null : "ohne KI"),
        analysis.result?.timings?.total != null ? `${(analysis.result.timings.total / 1000).toLocaleString("de-AT", { maximumFractionDigits: 1 })} s` : null,
      ].filter(Boolean);
      return <>{parts.join(" · ")}</>;
    }
  }
}

function Suggestions({ analysis, target }: { analysis: ReceiptAnalysisDTO; target: ApplyTarget }) {
  const { form } = target;
  const result = analysis.result!;
  const fields = result.fields;
  // re-render on every relevant form change so conflicts stay current
  const watched = useWatch({
    control: form.control,
    name: ["supplierName", "supplierUid", "supplierCountry", "supplierInvoiceNumber", "issueDate", "dueDate", "vatTreatment", "description", "lines"],
  });
  const treatment = (watched[6] ?? "domestic") as VatTreatment;
  const lines = (watched[8] ?? []) as FormLine[];

  const current = (key: ApplyKey): unknown => {
    if (key === "lines") return lines;
    if (key === "category") return lines.map((l) => l.category);
    return form.getValues(key);
  };

  const isEmpty = (key: ApplyKey): boolean => {
    if (key === "lines") return untouchedLines(lines);
    if (key === "category") return untouchedLines(lines) || lines.every((l) => l.category === DEFAULT_EXPENSE_CATEGORY);
    const v = form.getValues(key);
    if (key === "issueDate" || key === "supplierCountry" || key === "vatTreatment") {
      return !v || (target.draft && !form.getFieldState(key).isDirty);
    }
    return v == null || (typeof v === "string" && !v.trim());
  };

  const isSame = (key: ApplyKey, value: unknown): boolean => {
    if (key === "lines") {
      const want = suggestedLines(fields, treatment);
      return (
        want.length === lines.length &&
        want.every((w, i) => w.netCents === lines[i]!.netCents && w.taxCents === lines[i]!.taxCents && w.taxRateBp === lines[i]!.taxRateBp)
      );
    }
    if (key === "category") return lines.length > 0 && lines.every((l) => l.category === value);
    const cur = form.getValues(key);
    if (typeof cur === "string" && typeof value === "string") {
      return cur.replace(/\s+/g, "").toUpperCase() === value.replace(/\s+/g, "").toUpperCase();
    }
    return cur === value;
  };

  const apply = (key: ApplyKey) => {
    const s = suggestionFor(key, fields);
    if (!s) return;
    const opts = { shouldDirty: true, shouldValidate: true };
    switch (key) {
      case "vatTreatment":
        target.applyTreatment(s.value as VatTreatment);
        break;
      case "category": {
        const cat = getExpenseCategory(s.value as string);
        form.getValues("lines").forEach((_, i) => {
          form.setValue(`lines.${i}.category`, s.value as FormLine["category"], opts);
          if (cat) form.setValue(`lines.${i}.deductibleBp`, cat.defaultDeductibleBp, opts);
        });
        break;
      }
      case "lines": {
        const next = suggestedLines(fields, form.getValues("vatTreatment"));
        if (next.length) form.setValue("lines", next, opts);
        break;
      }
      default:
        form.setValue(key, s.value as string, opts);
    }
  };

  const applicable = (key: ApplyKey) => {
    const s = suggestionFor(key, fields);
    return !!s && (key !== "lines" || suggestedLines(fields, treatment).length > 0);
  };

  const applyOne = (key: ApplyKey) => {
    apply(key);
    target.onApplied([key], analysis.id);
  };

  const applyAll = () => {
    const keys = APPLY_ORDER.filter((k) => applicable(k) && isEmpty(k) && !isSame(k, suggestionFor(k, fields)!.value));
    for (const k of keys) apply(k);
    if (keys.length) {
      target.onApplied(keys, analysis.id);
      toast.success(keys.length === 1 ? "1 Feld übernommen" : `${keys.length} Felder übernommen`, {
        description: "Wird erst beim Speichern übernommen.",
      });
    } else toast.info("Keine leeren Felder zum Ausfüllen");
  };

  const rows = ORDER.filter(applicable);
  const formTotal = calcExpenseTotals(lines, treatment).grossCents;

  return (
    <div className="grid gap-3 p-3">
      {result.matchedSupplier && (
        <p className="text-xs text-muted-foreground">
          Bekannter Lieferant: <span className="text-foreground">{result.matchedSupplier.name}</span> (
          {result.matchedSupplier.count === 1 ? "1 Ausgabe" : `${result.matchedSupplier.count} Ausgaben`}, per{" "}
          {result.matchedSupplier.by === "uid" ? "UID" : "Name"})
        </p>
      )}

      {rows.length === 0 ? (
        <p className="text-muted-foreground">Keine Felder erkannt.</p>
      ) : (
        <div className="divide-y">
          {rows.map((key) => {
            const s = suggestionFor(key, fields)!;
            const same = isSame(key, s.value);
            const empty = isEmpty(key);
            const cur = current(key);
            return (
              <div key={key} className="grid grid-cols-[88px_minmax(0,1fr)_auto] items-start gap-2 py-1.5">
                <span className="pt-0.5 text-xs text-muted-foreground">{LABELS[key]}</span>
                <div className="flex min-w-0 gap-1.5">
                  <ConfidenceDot s={s} />
                  <div className="min-w-0">
                    <div className="break-words">{display(key, s.value, fields, treatment)}</div>
                    {!same && !empty && (
                      <div className="truncate text-xs text-muted-foreground" title="aktueller Wert">
                        aktuell:{" "}
                        {key === "lines"
                          ? linesSummary(cur as FormLine[])
                          : key === "category"
                            ? [...new Set(cur as string[])].map(categoryLabel).join(", ")
                            : display(key, cur, fields, treatment)}
                      </div>
                    )}
                    {s.note && <div className="text-xs text-amber-700">{s.note}</div>}
                  </div>
                </div>
                {same ? (
                  <Check className="mt-1 mr-2 size-4 text-emerald-600" aria-label="stimmt überein" />
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => applyOne(key)}
                    title={empty ? "Feld übernehmen" : "Aktuellen Wert ersetzen"}
                  >
                    <ChevronRight />
                    {empty ? "Übernehmen" : "Ersetzen"}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <InfoRows fields={fields} formTotal={formTotal} />

      {result.warnings.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-amber-800">
          {result.warnings.map((w) => (
            <li key={w}>
              <CodeText text={w} />
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <Button type="button" size="sm" onClick={applyAll} disabled={rows.length === 0}>
          <Sparkles />
          Alle übernehmen
        </Button>
        <span className="text-xs text-muted-foreground">füllt nur leere Felder</span>
      </div>

      {analysis.text && (
        <details className="group text-xs">
          <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">
            Erkannter Text{result.pageCount ? ` (${result.pageCount} ${result.pageCount === 1 ? "Seite" : "Seiten"})` : ""}
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {analysis.text}
          </pre>
        </details>
      )}
    </div>
  );
}

/** Values without a form field: receipt total (compared with the entered lines), IBAN, foreign currency. */
function InfoRows({ fields, formTotal }: { fields: ReceiptFields; formTotal: number }) {
  const gross = fields.grossCents;
  const items: { label: string; s: FieldSuggestion<unknown>; text: React.ReactNode }[] = [];
  if (gross) {
    const matches = formTotal === gross.value;
    items.push({
      label: "Belegsumme",
      s: gross,
      text: (
        <>
          {formatCents(gross.value)}
          {formTotal !== 0 && (
            <span className={cn("ml-2 text-xs", matches ? "text-emerald-700" : "text-amber-700")}>
              {matches ? "= Summe der Positionen" : `Positionen: ${formatCents(formTotal)}`}
            </span>
          )}
        </>
      ),
    });
  }
  if (fields.iban) items.push({ label: "IBAN", s: fields.iban, text: <span className="font-mono text-xs">{fields.iban.value}</span> });
  if (fields.currency && fields.currency.value !== "EUR") items.push({ label: "Währung", s: fields.currency, text: fields.currency.value });
  if (!items.length) return null;
  return (
    <div className="grid gap-1 rounded-md bg-muted/40 px-2 py-1.5">
      {items.map((i) => (
        <div key={i.label} className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
          <span className="text-xs text-muted-foreground">{i.label}</span>
          <div className="flex min-w-0 gap-1.5">
            <ConfidenceDot s={i.s} />
            <div className="min-w-0 break-words">{i.text}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
