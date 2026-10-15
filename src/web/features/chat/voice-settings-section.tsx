import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  DEFAULT_VOICE_SETTINGS,
  VOICE_LANGUAGE_LABELS,
  VOICE_LANGUAGES,
  type VoiceSettings,
  voiceSettingsSchema,
} from "@shared/voice";
import { FormSection, SwitchField, TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiErrorMessage, useUpdateVoiceSettings, voiceSettingsQuery, voiceStatusQuery, whisperModelsQuery } from "@/sdk";
import { CodeText } from "@/features/receipts/code-text";
import { StatusRow } from "@/features/receipts/status-row";

/** Radix Select can't hold "": stands for an empty model path (automatic choice) */
const AUTO_MODEL = "__auto__";

const mb = (bytes: number) => `${Math.round(bytes / 1e6).toLocaleString("de-AT")} MB`;

/** "Spracheingabe" block in the assistant settings tab (own form, saved via PUT /api/transcribe/settings). */
export function VoiceSettingsSection() {
  const { data } = useQuery(voiceSettingsQuery);
  const status = useQuery(voiceStatusQuery);
  const models = useQuery(whisperModelsQuery);
  const update = useUpdateVoiceSettings();
  const form = useForm<VoiceSettings>({
    resolver: zodResolver(voiceSettingsSchema),
    defaultValues: data ?? DEFAULT_VOICE_SETTINGS,
  });
  const { control } = form;
  const [enabled, modelPath] = useWatch({ control, name: ["enabled", "modelPath"] });

  useEffect(() => {
    if (data && !form.formState.isDirty) form.reset(data);
  }, [data, form]);

  const onSubmit = form.handleSubmit((values) =>
    update.mutate(values, {
      onSuccess: (saved) => {
        form.reset(saved);
        toast.success("Spracheingabe gespeichert");
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    }),
  );

  const found = models.data ?? [];
  const s = status.data;
  const autoLabel = s?.model?.auto ? s.model.label : null;

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} id="spracheingabe" className="max-w-4xl scroll-mt-8 border-t pt-8">
        <FormSection
          title="Spracheingabe"
          description={
            <>
              Mikrofon-Knopf im Assistenten: klicken oder gedrückt halten, sprechen, der Text landet im Eingabefeld (wird
              nicht automatisch gesendet). Die Erkennung läuft lokal mit whisper.cpp, die Aufnahme verlässt den Rechner nicht.
            </>
          }
        >
          {s && s.enabled && (
            <div className="grid gap-1.5 rounded-lg border p-4">
              <StatusRow state={s.ready ? "ok" : "warn"} label="Status">
                {s.ready ? "bereit" : <CodeText text={s.problem ?? "nicht bereit"} />}
              </StatusRow>
              <StatusRow state={s.binary ? "ok" : "warn"} label="whisper.cpp">
                {s.binary ?? "nicht gefunden"}
              </StatusRow>
              <StatusRow state={s.model ? "ok" : "warn"} label="Modell">
                {s.model ? (
                  <span title={s.model.path}>{s.model.auto ? `Automatisch: ${s.model.label}` : s.model.label}</span>
                ) : (
                  "keines gefunden"
                )}
              </StatusRow>
            </div>
          )}

          <SwitchField control={control} name="enabled" label="Spracheingabe aktivieren" description="Aus: kein Mikrofon-Knopf im Assistenten." />

          {enabled && (
            <>
              <FormField
                control={control}
                name="language"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Sprache</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full sm:w-60">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {VOICE_LANGUAGES.map((l) => (
                          <SelectItem key={l} value={l}>
                            {VOICE_LANGUAGE_LABELS[l]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              <TextField
                control={control}
                name="modelPath"
                label="Whisper-Modell (ggml-*.bin)"
                placeholder={autoLabel ? `leer = automatisch (${autoLabel})` : "leer = automatisch (bevorzugt large-v3-turbo)"}
                description="Mehrsprachiges Modell nötig (nicht *.en). large-v3-turbo-q5_0 (ca. 550 MB) erkennt Deutsch gut und braucht auf Apple Silicon unter einer Sekunde pro Satz."
              />
              {found.length > 0 && (
                <Select
                  value={!modelPath ? AUTO_MODEL : found.some((m) => m.path === modelPath) ? modelPath : ""}
                  onValueChange={(path) =>
                    form.setValue("modelPath", path === AUTO_MODEL ? "" : path, { shouldDirty: true, shouldValidate: true })
                  }
                >
                  <SelectTrigger className="-mt-2 w-full" aria-label="Gefundene Whisper-Modelle">
                    <SelectValue placeholder="Gefundenes Modell wählen…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO_MODEL}>Automatisch{autoLabel ? `: ${autoLabel}` : ""}</SelectItem>
                    {found.map((m) => (
                      <SelectItem key={m.path} value={m.path} title={m.path}>
                        {m.name} ({mb(m.sizeBytes)}){m.englishOnly ? " – nur Englisch" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={!form.formState.isDirty} onClick={() => form.reset()}>
              Verwerfen
            </Button>
            <Button type="submit" disabled={!form.formState.isDirty || update.isPending}>
              {update.isPending ? "Speichern…" : "Spracheingabe speichern"}
            </Button>
          </div>
        </FormSection>
      </form>
    </Form>
  );
}
