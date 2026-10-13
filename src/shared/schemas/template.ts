import { z } from "./zod";
import { TEMPLATE_DOC_TYPES } from "../documents";

/** pdfme Template JSON; the server additionally runs pdfme's own checkTemplate(). */
export const pdfmeTemplateSchema = z.looseObject({
  basePdf: z.unknown(),
  schemas: z.array(z.array(z.looseObject({ name: z.string(), type: z.string() }))),
});

export const templateCreateSchema = z.object({
  name: z.string().trim().min(1, "Name ist erforderlich").max(200),
  docType: z.enum(TEMPLATE_DOC_TYPES),
  /** duplicate this template; otherwise start from the built-in default layout for docType */
  sourceId: z.number().int().positive().optional(),
});

export const templateUpdateSchema = z.object({
  name: z.string().trim().min(1, "Name ist erforderlich").max(200).optional(),
  docType: z.enum(TEMPLATE_DOC_TYPES).optional(),
  template: pdfmeTemplateSchema.optional(),
});

export type TemplateCreate = z.infer<typeof templateCreateSchema>;
export type TemplateUpdate = z.infer<typeof templateUpdateSchema>;
