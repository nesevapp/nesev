import { z } from "./zod";
import { EXPENSE_CATEGORY_KEYS } from "../expenses";
import { INTERVAL_UNITS } from "../recurring";

const isoDate = () => z.iso.date();
const text = (max = 500) => z.string().trim().max(max);

/**
 * All editable fields of a recurring outgoing payment (Fixkosten). No defaults on purpose: the partial
 * update variant must not fill in omitted fields.
 */
export const recurringExpenseFormSchema = z.object({
  name: text(200).min(1, "Name ist erforderlich"),
  supplierName: text(200),
  category: z.enum(EXPENSE_CATEGORY_KEYS),
  active: z.boolean(),
  intervalUnit: z.enum(INTERVAL_UNITS),
  intervalCount: z.number().int().min(1, "Mindestens 1").max(60),
  /** first payment; later ones keep its day of month */
  startDate: isoDate(),
  endDate: isoDate().nullable(),
  /** amount leaving the account per payment */
  grossCents: z.number().int().positive("Betrag muss größer als 0 sein"),
  /** deductible input VAT contained in grossCents */
  taxCents: z.number().int().min(0, "Darf nicht negativ sein"),
  notes: z.string().max(5000),
});

const check = (v: { startDate?: string; endDate?: string | null; grossCents?: number; taxCents?: number }, ctx: z.RefinementCtx) => {
  if (v.startDate && v.endDate && v.endDate < v.startDate) {
    ctx.addIssue({ code: "custom", path: ["endDate"], message: "Ende liegt vor dem Start" });
  }
  if (v.grossCents != null && v.taxCents != null && v.taxCents >= v.grossCents) {
    ctx.addIssue({ code: "custom", path: ["taxCents"], message: "USt. muss kleiner als der Betrag sein" });
  }
};

export const recurringExpenseCreateSchema = recurringExpenseFormSchema.superRefine(check);
/** Update: omitted fields stay unchanged (e.g. `{ active: false }` from the list toggle). */
export const recurringExpenseUpdateSchema = recurringExpenseFormSchema.partial().superRefine(check);

export type RecurringExpenseFormValues = z.input<typeof recurringExpenseFormSchema>;
export type RecurringExpenseCreate = z.infer<typeof recurringExpenseCreateSchema>;
export type RecurringExpenseUpdate = z.infer<typeof recurringExpenseUpdateSchema>;

/** Forecast settings (Einstellungen der Zahlungsprognose). */
export const forecastSettingsSchema = z
  .object({
    /** account balance on `cashBalanceDate`; both null = forecast without balance */
    cashBalanceCents: z.number().int().nullable(),
    cashBalanceDate: isoDate().nullable(),
    /** quarterly ESt-Vorauszahlung; 0 = none */
    incomeTaxPrepaymentCents: z.number().int().min(0, "Darf nicht negativ sein"),
  })
  .superRefine((v, ctx) => {
    if ((v.cashBalanceCents == null) !== (v.cashBalanceDate == null)) {
      ctx.addIssue({
        code: "custom",
        path: [v.cashBalanceDate == null ? "cashBalanceDate" : "cashBalanceCents"],
        message: "Kontostand und Datum gemeinsam angeben",
      });
    }
  });

export type ForecastSettings = z.infer<typeof forecastSettingsSchema>;
