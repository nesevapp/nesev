import { z } from "./zod";
import { MAX_USEFUL_LIFE_YEARS, MIN_USEFUL_LIFE_YEARS } from "../assets";

const isoDate = () => z.iso.date();
const text = (max = 500) => z.string().trim().max(max);

/**
 * Asset fields (Anlagenverzeichnis). No defaults on purpose: the update variant must not fill in omitted fields.
 * Date order (Inbetriebnahme ≥ Anschaffung) is checked by the server on the merged values.
 */
export const assetFormSchema = z.object({
  /** asset number; omit to auto-assign (max + 1) */
  number: z.number().int().positive().optional(),
  name: text(300).min(1, "Bezeichnung ist erforderlich"),
  /** expense the asset was bought with */
  expenseId: z.number().int().positive().nullable(),
  acquisitionDate: isoDate(),
  inServiceDate: isoDate(),
  /** Anschaffungskosten in cents (net + non-deductible VAT) */
  costCents: z.number().int().positive("Anschaffungskosten müssen größer als 0 sein"),
  usefulLifeYears: z.number().int().min(MIN_USEFUL_LIFE_YEARS).max(MAX_USEFUL_LIFE_YEARS),
  notes: z.string().max(5000),
});

export const assetCreateSchema = assetFormSchema.extend({
  expenseId: assetFormSchema.shape.expenseId.optional(),
  notes: assetFormSchema.shape.notes.optional(),
});
export const assetUpdateSchema = assetFormSchema.partial();

export const assetDisposalSchema = z.object({
  disposalDate: isoDate(),
  /** Erlös (net); 0 when scrapped */
  disposalProceedsCents: z.number().int().min(0),
});

export const assetListQuerySchema = z.object({
  /** Anlagenverzeichnis for this year (default: current year) */
  year: z.coerce.number().int().min(1900).max(2999).optional(),
});

export type AssetCreate = z.infer<typeof assetCreateSchema>;
export type AssetUpdate = z.infer<typeof assetUpdateSchema>;
export type AssetFormValues = z.input<typeof assetCreateSchema>;
export type AssetDisposal = z.infer<typeof assetDisposalSchema>;
export type AssetListQuery = z.input<typeof assetListQuerySchema>;
