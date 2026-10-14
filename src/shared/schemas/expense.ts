import { z } from "./zod";
import { DEFAULT_EXPENSE_CATEGORY, EXPENSE_CATEGORY_KEYS, VAT_TREATMENTS } from "../expenses";
import { type Quad, quadProblem } from "../receipt-crop";

const isoDate = () => z.iso.date();
const text = (max = 500) => z.string().trim().max(max);

export const expenseLineSchema = z.object({
  category: z.enum(EXPENSE_CATEGORY_KEYS).default(DEFAULT_EXPENSE_CATEGORY),
  description: text(500).default(""),
  netCents: z.number().int(),
  /** basis points; the rate that applies (also for reverse charge / ig. Erwerb) */
  taxRateBp: z.number().int().min(0).max(10000),
  /** stored as entered so receipt rounding can be matched; see src/shared/expenses.ts */
  taxCents: z.number().int(),
  /** deductible share of the tax (Vorsteuer), 10000 = fully */
  deductibleBp: z.number().int().min(0).max(10000).default(10000),
});

/**
 * All editable fields. No defaults on purpose: the partial variants below must not fill in omitted
 * fields (zod 4 applies defaults inside .partial()). `lines` is always the full ordered list.
 */
export const expenseFormSchema = z.object({
  /** may be empty for drafts ("unvollständig") */
  supplierName: text(200),
  supplierUid: text(30),
  supplierCountry: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, "Ländercode (2 Buchstaben)")
    .transform((s) => s.toUpperCase()),
  supplierInvoiceNumber: text(100),
  issueDate: isoDate(),
  dueDate: isoDate().nullable(),
  /** date fully paid, null = open */
  paidAt: isoDate().nullable(),
  vatTreatment: z.enum(VAT_TREATMENTS),
  description: text(500),
  notes: z.string().max(5000),
  lines: z.array(expenseLineSchema).max(200),
});

/** Create. Omitted fields get defaults on the server (issue date today, AT, domestic, no lines). */
export const expenseCreateSchema = expenseFormSchema.partial();

/** Update. Omitted fields stay unchanged; `lines` replaces all lines. */
export const expenseUpdateSchema = expenseFormSchema.partial();

export const expensePaidSchema = z.object({ paidAt: isoDate().nullable() });

const quadCoord = z.number().min(0).max(1);
const quadPoint = z.tuple([quadCoord, quadCoord]);

/** Crop a photographed receipt: corners TL, TR, BR, BL, normalized (see src/shared/receipt-crop.ts). */
export const receiptCropSchema = z.object({
  quad: z
    .tuple([quadPoint, quadPoint, quadPoint, quadPoint])
    .superRefine((q, ctx) => {
      const problem = quadProblem(q as Quad);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
  /** grayscale + a little more contrast */
  enhance: z.boolean().default(false),
});

export const EXPENSE_STATUS_FILTERS = ["open", "paid", "incomplete"] as const;
export const EXPENSE_ATTACHMENT_FILTERS = ["with", "without"] as const;

export const expenseListQuerySchema = z.object({
  /** matches supplier, description, number, supplier invoice number, notes, attachment name */
  q: z.string().trim().max(200).optional(),
  /** issue date range (inclusive) */
  from: isoDate().optional(),
  to: isoDate().optional(),
  category: z.enum(EXPENSE_CATEGORY_KEYS).optional(),
  status: z.enum(EXPENSE_STATUS_FILTERS).optional(),
  attachment: z.enum(EXPENSE_ATTACHMENT_FILTERS).optional(),
});

export const supplierQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export type ExpenseLineInput = z.infer<typeof expenseLineSchema>;
export type ExpenseCreate = z.infer<typeof expenseCreateSchema>;
export type ExpenseUpdate = z.infer<typeof expenseUpdateSchema>;
export type ExpenseFormData = z.infer<typeof expenseFormSchema>;
export type ExpenseFormValues = z.input<typeof expenseFormSchema>;
export type ExpenseListQuery = z.infer<typeof expenseListQuerySchema>;
export type ReceiptCropInput = z.input<typeof receiptCropSchema>;
