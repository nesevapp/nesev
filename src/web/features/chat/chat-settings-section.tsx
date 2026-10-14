import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { type ChatSettings, chatSettingsSchema, DEFAULT_CHAT_SETTINGS } from "@shared/chat";
import { FormSection, SwitchField, TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiErrorMessage, chatSettingsQuery, chatStatusQuery, llamaModelsQuery, useUpdateChatSettings } from "@/sdk";
import { CodeText } from "@/features/receipts/code-text";
import { llamaModelLabel } from "@/features/receipts/llama-settings";
import { StatusRow } from "@/features/receipts/status-row";

/** Radix Select can't hold "": stands for an empty model path (automatic choice) */
const AUTO_MODEL = "__auto__";
const CONTEXT_SIZES = [8192, 16384, 32768, 65536];

/** "Assistent" section on the settings page (own form, saved via PUT /api/chat/settings). */
export function ChatSettingsSection() {
  const { data } = useQuery(chatSettingsQuery);
  const status = useQuery(chatStatusQuery());
  const models = useQuery(llamaModelsQuery);
  const update = useUpdateChatSettings();
  const form = useForm<ChatSettings>({
    resolver: zodResolver(chatSettingsSchema),
    defaultValues: data ?? DEFAULT_CHAT_SETTINGS,
  });
  const { control } = form;
  const [enabled, modelPath, contextSize] = useWatch({ control, name: ["enabled", "modelPath", "contextSize"] });

  useEffect(() => {
    if (data && !form.formState.isDirty) form.reset(data);
  }, [data, form]);

  const onSubmit = form.handleSubmit((values) =>
    update.mutate(values, {
      onSuccess: (saved) => {
        form.reset(saved);
        toast.success("Assistent gespeichert");
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    }),
  );

  const found = models.data ?? [];
  const s = status.data;
  const autoLabel = s?.model?.auto ? s.model.label : null;
  const sizes = CONTEXT_SIZES.includes(contextSize) ? CONTEXT_SIZES : [...CONTEXT_SIZES, contextSize].sort((a, b) => a - b);

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} id="assistent" className="max-w-4xl scroll-mt-8 border-t pt-8">
        <FormSection
          title="Assistent"
          description={
            <>
              Chat über deine Buchhaltung (⌘J). Läuft vollständig lokal mit llama.cpp und teilt sich den llama-server mit der
              Belegerkennung. Alles, was Belege verändert, wird erst nach deiner Bestätigung ausgeführt.
            </>
          }
        >
          {s && (
            <div className="grid gap-1.5 rounded-lg border p-4">
              <StatusRow state={!s.enabled ? "off" : s.ready ? "ok" : "warn"} label="Status">
                {!s.enabled ? "deaktiviert" : s.ready ? "bereit" : <CodeText text={s.problem ?? "nicht bereit"} />}
              </StatusRow>
              <StatusRow state={s.model ? "ok" : "warn"} label="Modell">
                {s.model ? (
                  <span title={s.model.path}>{s.model.auto ? `Automatisch: ${s.model.label}` : s.model.label}</span>
                ) : (
                  "keines gefunden"
                )}
              </StatusRow>
              <StatusRow state={s.running ? "ok" : "off"} label="Server">
                {s.running ? "läuft" : "gestoppt – startet bei der ersten Frage"}
              </StatusRow>
            </div>
          )}

          <SwitchField control={control} name="enabled" label="Assistent aktivieren" description="Aus: Seitenleiste und ⌘J bleiben, senden ist aber gesperrt." />

          {enabled && (
            <>
              <TextField
                control={control}
                name="modelPath"
                label="Modelldatei (GGUF)"
                placeholder={autoLabel ? `leer = automatisch (${autoLabel})` : "leer = automatisch (bevorzugt Qwen3.5-4B)"}
                description={
                  found.length > 0
                    ? "Ein Modell mit Tool-Calling (z. B. Qwen3.5) ist nötig. Leer lassen für die automatische Wahl."
                    : "Keine GGUF-Dateien gefunden. Einmal `llama-server -hf unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL` lädt das empfohlene Modell."
                }
              />
              {found.length > 0 && (
                <Select
                  value={!modelPath ? AUTO_MODEL : found.some((m) => m.path === modelPath) ? modelPath : ""}
                  onValueChange={(path) =>
                    form.setValue("modelPath", path === AUTO_MODEL ? "" : path, { shouldDirty: true, shouldValidate: true })
                  }
                >
                  <SelectTrigger className="-mt-2 w-full" aria-label="Gefundene Modelle">
                    <SelectValue placeholder="Gefundenes Modell wählen…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO_MODEL}>Automatisch{autoLabel ? `: ${autoLabel}` : ""}</SelectItem>
                    {found.map((m) => (
                      <SelectItem key={m.path} value={m.path} title={m.path}>
                        {llamaModelLabel(m)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <FormField
                control={control}
                name="contextSize"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Kontextgröße</FormLabel>
                    <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                      <FormControl>
                        <SelectTrigger className="w-full sm:w-60">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {sizes.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n / 1024}k Token
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Platz für Werkzeugbeschreibungen und Verlauf. Mehr erlaubt längere Unterhaltungen, braucht aber mehr
                      Arbeitsspeicher.
                    </p>
                  </FormItem>
                )}
              />
              <SwitchField
                control={control}
                name="reasoning"
                label="Nachdenken lassen"
                description="Das Modell überlegt vor der Antwort: langsamer, manchmal genauer bei mehrstufigen Aufgaben."
              />
            </>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={!form.formState.isDirty} onClick={() => form.reset()}>
              Verwerfen
            </Button>
            <Button type="submit" disabled={!form.formState.isDirty || update.isPending}>
              {update.isPending ? "Speichern…" : "Assistent speichern"}
            </Button>
          </div>
        </FormSection>
      </form>
    </Form>
  );
}
