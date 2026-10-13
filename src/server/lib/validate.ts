import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { ZodType } from "zod";

/**
 * zValidator with a uniform 400 response: { error: string, issues: ZodIssue[] }.
 * Usage: .put("/", validate("json", schema), (c) => { const body = c.req.valid("json"); ... })
 */
export const validate = <T extends ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "Ungültige Eingabe", issues: result.error.issues }, 400);
    }
  });
