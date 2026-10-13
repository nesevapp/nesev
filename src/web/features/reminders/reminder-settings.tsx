import { useEffect } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DEFAULT_REMINDER_SETTINGS, MAX_REMINDER_LEVELS, REMINDER_PLACEHOLDERS, type ReminderSettings } from "@shared/reminders";
import { reminderSettingsSchema } from "@shared/schemas/reminder";
import type { z } from "@shared/schemas/zod";
import { FormSection, NumberField, SwitchField, TextareaField, TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { CODECS, NumericInput } from "@/features/documents/components/numeric-input";
import { apiErrorMessage, reminderSettingsQuery, useUpdateReminderSettings } from "@/sdk";

type Values = z.input<typeof reminderSettingsSchema>;

/** "Mahnwesen" section on the settings page (own form, saved via PUT /api/reminders/settings). */
export function ReminderSettingsSection() {
  const { data } = useQuery(reminderSettingsQuery);
  const update = useUpdateReminderSettings();
  const form = useForm<Values, unknown, ReminderSettings>({
    resolver: zodResolver(reminderSettingsSchema),
    defaultValues: data ?? DEFAULT_REMINDER_SETTINGS,
  });
  const { control } = form;
  const levels = useFieldArray({ control, name: "levels" });
  const interestEnabled = form.watch("interestEnabled");

  useEffect(() => {
    if (data && !form.formState.isDirty) form.reset(data);
  }, [data, form]);

  const onSubmit = form.handleSubmit((values) =>
    update.mutate(values, {
      onSuccess: (saved) => {
        form.reset(saved);
        toast.success("Mahnwesen gespeichert");
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    }),
  );

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} id="mahnwesen" className="max-w-4xl scroll-mt-8 border-t pt-8">
        <FormSection
          title="Mahnwesen"
          description={
            <>
              Mahnstufen für überfällige Rechnungen. Die nächste Mahnung einer Rechnung verwendet die nächsthöhere Stufe;
              die letzte Stufe kann wiederholt werden. Mahnspesen und Verzugszinsen sind als Schadenersatz nicht
              umsatzsteuerbar und werden ohne USt. ausgewiesen.
            </>
          }
        >
          {levels.fields.map((field, i) => (
            <div key={field.id} className="grid gap-4 rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Stufe {i + 1}</span>
                {levels.fields.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Stufe ${i + 1} entfernen`}
                    onClick={() => levels.remove(i)}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-[1fr_140px_140px]">
                <TextField control={control} name={`levels.${i}.title`} label="Bezeichnung" />
                <FormField
                  control={control}
                  name={`levels.${i}.feeCents`}
                  render={({ field: f }) => (
                    <FormItem>
                      <FormLabel>Mahnspesen</FormLabel>
                      <div className="relative">
                        <FormControl>
                          <NumericInput codec={CODECS.money} min={0} value={f.value} onChange={f.onChange} onBlur={f.onBlur} className="pr-8" />
                        </FormControl>
                        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">€</span>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <NumberField control={control} name={`levels.${i}.days`} label="Neue Frist" suffix="Tage" min={0} />
              </div>
              <TextareaField control={control} name={`levels.${i}.introText`} label="Einleitung" rows={3} />
              <TextareaField control={control} name={`levels.${i}.closingText`} label="Schlusstext" rows={3} />
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            {levels.fields.length < MAX_REMINDER_LEVELS && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  const last = form.getValues(`levels.${levels.fields.length - 1}`);
                  levels.append({ ...last, title: `${levels.fields.length}. Mahnung` });
                }}
              >
                <Plus />
                Stufe hinzufügen
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => form.reset({ ...DEFAULT_REMINDER_SETTINGS }, { keepDefaultValues: true })}
            >
              Standardwerte
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Platzhalter in Texten:{" "}
            {REMINDER_PLACEHOLDERS.map((p, i) => (
              <span key={p.key}>
                {i > 0 && ", "}
                <code className="rounded bg-muted px-1">{`{${p.key}}`}</code> {p.label}
              </span>
            ))}
          </p>

          <SwitchField
            control={control}
            name="interestEnabled"
            label="Verzugszinsen berechnen"
            description="Zinsen auf den offenen Betrag ab Fälligkeit der Rechnung bis zum Mahndatum (taggenau, 365 Tage). Unternehmergeschäfte: Basiszinssatz + 9,2 Prozentpunkte (§ 456 UGB), Verbraucher: 4 % (§ 1000 ABGB). Aktuellen Basiszinssatz der OeNB prüfen."
          />
          {interestEnabled && (
            <FormField
              control={control}
              name="interestRateBp"
              render={({ field }) => (
                <FormItem className="max-w-48">
                  <FormLabel>Zinssatz</FormLabel>
                  <div className="relative">
                    <FormControl>
                      <NumericInput codec={CODECS.percent} min={0} value={field.value} onChange={field.onChange} onBlur={field.onBlur} className="pr-16" />
                    </FormControl>
                    <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">% p. a.</span>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={!form.formState.isDirty} onClick={() => form.reset()}>
              Verwerfen
            </Button>
            <Button type="submit" disabled={!form.formState.isDirty || update.isPending}>
              {update.isPending ? "Speichern…" : "Mahnwesen speichern"}
            </Button>
          </div>
        </FormSection>
      </form>
    </Form>
  );
}
