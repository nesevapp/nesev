import { z } from "./zod";
import { INTERVAL_UNITS } from "../recurring";
import { TAX_MODES } from "../tax";
import { documentItemSchema } from "./document";

const isoDate = () => z.iso.date();

/** All editable fields of a recurring invoice (Serienrechnung). Items replace the full list. */
export const recurringFormSchema = z
  .object({
    name: z.string().trim().min(1, "Name ist erforderlich").max(200),
    clientId: z.number({ error: "Kunde ist erforderlich" }).int().positive("Kunde ist erforderlich"),
    active: z.boolean(),
    intervalUnit: z.enum(INTERVAL_UNITS),
    intervalCount: z.number().int().min(1, "Mindestens 1").max(60),
    startDate: isoDate(),
    endDate: isoDate().nullable(),
    nextRunDate: isoDate(),
    setServicePeriod: z.boolean(),
    autoFinalize: z.boolean(),
    taxMode: z.enum(TAX_MODES),
    title: z.string().trim().max(200),
    introText: z.string().max(5000),
    closingText: z.string().max(5000),
    templateId: z.number().int().positive().nullable(),
    items: z.array(documentItemSchema),
  });

const checkDates = (v: { startDate?: string; endDate?: string | null; nextRunDate?: string }, ctx: z.RefinementCtx) => {
  if (v.startDate && v.endDate && v.endDate < v.startDate) {
    ctx.addIssue({ code: "custom", path: ["endDate"], message: "Ende liegt vor dem Start" });
  }
  if (v.startDate && v.nextRunDate && v.nextRunDate < v.startDate) {
    ctx.addIssue({ code: "custom", path: ["nextRunDate"], message: "Nächste Ausführung liegt vor dem Start" });
  }
};

/** Form validation (client + create). */
export const recurringFormSchemaChecked = recurringFormSchema.superRefine(checkDates);

/** Create: `nextRunDate` defaults to `startDate`. */
export const recurringCreateSchema = recurringFormSchema
  .extend({ nextRunDate: isoDate().optional() })
  .superRefine(checkDates);

/** Update: omitted fields stay unchanged (e.g. `{ active: false }` from the list toggle). */
export const recurringUpdateSchema = recurringFormSchema.partial().superRefine(checkDates);

export type RecurringFormValues = z.input<typeof recurringFormSchema>;
export type RecurringFormData = z.infer<typeof recurringFormSchema>;
export type RecurringCreate = z.infer<typeof recurringCreateSchema>;
export type RecurringUpdate = z.infer<typeof recurringUpdateSchema>;
