import { z } from "./zod";
import { DOCUMENT_STATUSES, DOCUMENT_TYPES, STATUS_ACTIONS } from "../documents";
import { TAX_MODES } from "../tax";

const isoDate = () => z.iso.date();

export const documentItemSchema = z.object({
  /** catalog article the values were copied from (origin only; null/omitted = free line) */
  articleId: z.number().int().positive().nullish(),
  title: z.string().trim().max(500),
  description: z.string().max(5000).default(""),
  /** milli-units (1000 = 1) */
  quantity: z.number().int(),
  unit: z.string().trim().max(20).default(""),
  unitPriceCents: z.number().int(),
  /** basis points (2000 = 20 %) */
  taxRateBp: z.number().int().min(0).max(10000),
  /** basis points (1000 = 10 %) */
  discountBp: z.number().int().min(0).max(10000).default(0),
});

/**
 * All editable fields of a draft. No defaults on purpose: the partial variants below must not
 * fill in omitted fields (zod 4 applies defaults inside .partial()).
 * Items are always sent as the full ordered list; position = array index.
 */
export const documentFormSchema = z.object({
  clientId: z.number({ error: "Kunde ist erforderlich" }).int().positive("Kunde ist erforderlich"),
  issueDate: isoDate(),
  servicePeriodStart: isoDate().nullable(),
  servicePeriodEnd: isoDate().nullable(),
  dueDate: isoDate().nullable(),
  validUntil: isoDate().nullable(),
  taxMode: z.enum(TAX_MODES),
  title: z.string().trim().max(200),
  introText: z.string().max(5000),
  closingText: z.string().max(5000),
  templateId: z.number().int().positive().nullable(),
  items: z.array(documentItemSchema),
});

/** Create a draft. Omitted fields are prefilled on the server (texts, tax mode, dates). */
export const documentCreateSchema = documentFormSchema.partial().extend({
  type: z.enum(DOCUMENT_TYPES),
  clientId: documentFormSchema.shape.clientId,
});

/** Update a draft. Omitted fields stay unchanged; `items` replaces all items. */
export const documentUpdateSchema = documentFormSchema.partial();

export const documentListQuerySchema = z.object({
  type: z.enum(DOCUMENT_TYPES).optional(),
  /** a stored status or the derived "overdue" (final/sent invoices past due date) */
  status: z.enum([...DOCUMENT_STATUSES, "overdue"]).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  /** search in number, client name and title */
  q: z.string().trim().optional(),
  /** issue date range (inclusive) */
  from: isoDate().optional(),
  to: isoDate().optional(),
});

export const documentDefaultsQuerySchema = z.object({
  type: z.enum(DOCUMENT_TYPES),
  clientId: z.coerce.number().int().positive().optional(),
  issueDate: isoDate().optional(),
});

export const documentStatusSchema = z.object({
  action: z.enum(STATUS_ACTIONS),
  /** for action "paid"; defaults to today */
  paidAt: isoDate().optional(),
  /** for action "unpaid": also remove the invoice's bank allocations (the transactions become open again) */
  removeAllocations: z.boolean().optional(),
});

export type DocumentItemInput = z.infer<typeof documentItemSchema>;
export type DocumentFormData = z.infer<typeof documentFormSchema>;
export type DocumentFormValues = z.input<typeof documentFormSchema>;
export type DocumentCreate = z.infer<typeof documentCreateSchema>;
export type DocumentUpdate = z.infer<typeof documentUpdateSchema>;
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;
export type DocumentStatusInput = z.infer<typeof documentStatusSchema>;
