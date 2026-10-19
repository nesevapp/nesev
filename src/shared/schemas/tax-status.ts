import { z } from "./zod";

/** POST /api/tax-status, PUT /api/tax-status/:id. The history checks (first entry, unique dates, Soll/Ist only at the
 *  start of a UVA period) run on the server against the whole list: taxStatusProblems() in shared/tax-status.ts. */
export const taxStatusInputSchema = z.object({
  validFrom: z.iso.date(),
  smallBusiness: z.boolean(),
  vatBasis: z.enum(["accrual", "cash"]),
  note: z.string().trim().max(500).default(""),
});

export type TaxStatusInput = z.infer<typeof taxStatusInputSchema>;
export type TaxStatusFormValues = z.input<typeof taxStatusInputSchema>;
