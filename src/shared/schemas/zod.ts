import { z } from "zod";

// German validation messages for all shared schemas. Import `z` from here, not from "zod".
z.config(z.locales.de());

export { z };

/**
 * Like `schema.partial()`, but drops field defaults first: zod 4 applies defaults inside `.partial()`, so a PATCH-style
 * update with `.partial()` would reset every omitted field that has a default.
 */
export function partialWithoutDefaults<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([k, v]) => [k, (v instanceof z.ZodDefault ? (v.unwrap() as z.ZodType) : (v as z.ZodType)).optional()]),
  ) as unknown as { [K in keyof T]: z.ZodOptional<T[K] extends z.ZodDefault<infer I> ? I : T[K]> };
  return z.object(shape);
}
