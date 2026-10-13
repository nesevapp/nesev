import { z } from "./zod";
import { MAX_REMINDER_LEVELS, REMINDER_STATUSES, type ReminderSettings } from "../reminders";

const isoDate = z.iso.date();
const cents = z.number().int().min(0).max(99_999_999_99);
const longText = () => z.string().max(5000);

export const reminderLevelSchema = z.object({
  title: z.string().trim().min(1, "Bezeichnung ist erforderlich").max(200),
  feeCents: cents,
  days: z.number().int().min(0).max(365),
  introText: longText(),
  closingText: longText(),
});

/** PUT /api/reminders/settings; also used to read settings.reminder_levels defensively. */
export const reminderSettingsSchema = z.object({
  levels: z.array(reminderLevelSchema).min(1, "Mindestens eine Mahnstufe ist erforderlich").max(MAX_REMINDER_LEVELS),
  interestEnabled: z.boolean(),
  /** % p.a. in basis points (max 30 %) */
  interestRateBp: z.number().int().min(0).max(3000),
}) satisfies z.ZodType<ReminderSettings>;

export const reminderCreateSchema = z.object({
  invoiceId: z.number().int().positive(),
  /** default: next level for the invoice */
  level: z.number().int().min(1).max(MAX_REMINDER_LEVELS).optional(),
  /** default: today */
  issueDate: isoDate.optional(),
  /** return the invoice's existing draft instead of failing with 409 */
  reuseDraft: z.boolean().optional(),
});

export const reminderBulkCreateSchema = z.object({
  invoiceIds: z.array(z.number().int().positive()).min(1).max(500),
});

export const reminderUpdateSchema = z.object({
  level: z.number().int().min(1).max(MAX_REMINDER_LEVELS),
  issueDate: isoDate,
  dueDate: isoDate,
  feeCents: cents,
  interestCents: cents,
  title: z.string().trim().max(200),
  introText: longText(),
  closingText: longText(),
  templateId: z.number().int().positive().nullable(),
});

export const reminderListQuerySchema = z.object({
  invoiceId: z.coerce.number().int().positive().optional(),
  status: z.enum(REMINDER_STATUSES).optional(),
});

export type ReminderCreate = z.infer<typeof reminderCreateSchema>;
export type ReminderUpdate = z.infer<typeof reminderUpdateSchema>;
export type ReminderListQuery = z.infer<typeof reminderListQuerySchema>;
export type ReminderSettingsInput = z.infer<typeof reminderSettingsSchema>;
