import { z } from "./zod";
import { AT_TAX_RATES_BP } from "../tax";

const text = (max = 500) => z.string().trim().max(max);

export const articleCreateSchema = z.object({
  /** article number; omit to auto-assign (max + 1) */
  number: z.number().int().positive().optional(),
  title: text(500).min(1, "Bezeichnung ist erforderlich"),
  description: z.string().max(5000).default(""),
  unit: text(20).default(""),
  /** net unit price in cents */
  unitPriceCents: z.number().int(),
  /** basis points; one of the Austrian rates (20/13/10/0 %) */
  taxRateBp: z
    .number()
    .int()
    .refine((bp) => (AT_TAX_RATES_BP as readonly number[]).includes(bp), "Ungültiger Steuersatz"),
  /** internal notes, never printed */
  notes: z.string().max(5000).default(""),
});

export const articleUpdateSchema = articleCreateSchema.partial();

export type ArticleCreate = z.infer<typeof articleCreateSchema>;
export type ArticleUpdate = z.infer<typeof articleUpdateSchema>;
export type ArticleFormValues = z.input<typeof articleCreateSchema>;

/** Display form of an article number: 12 → "A-0012". */
export function formatArticleNumber(n: number): string {
  return `A-${String(n).padStart(4, "0")}`;
}

/** "A-0012", "a12", "0012" or "12" → 12; anything else → null. */
export function parseArticleNumber(input: string): number | null {
  const m = /^(?:a-?)?0*(\d{1,9})$/i.exec(input.trim());
  return m ? Number(m[1]) : null;
}

export const ARTICLE_ARCHIVED_FILTERS = ["active", "archived", "all"] as const;
export const ARTICLE_SORTS = ["title", "number", "usage"] as const;

export const articleListQuerySchema = z.object({
  /** matches title, description and number */
  q: z.string().trim().max(200).optional(),
  archived: z.enum(ARTICLE_ARCHIVED_FILTERS).default("active"),
  /** "usage" = most used first */
  sort: z.enum(ARTICLE_SORTS).default("title"),
});

export const articlePickerQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

export type ArticleListQuery = z.input<typeof articleListQuerySchema>;
