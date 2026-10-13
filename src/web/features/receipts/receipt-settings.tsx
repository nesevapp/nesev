import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, CircleDashed, Hammer, Loader2, PlugZap } from "lucide-react";
import { toast } from "sonner";
import { DEFAULT_OCR_SETTINGS, type OcrSettings } from "@shared/receipts";
import { ocrSettingsSchema, type OcrSettingsInput } from "@shared/schemas/receipt";
import { FormSection, SwitchField, TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CodeText } from "./code-text";
import { ocrSettingsQuery, receiptStatusQuery, useBuildHelper, useUpdateOcrSettings } from "./api";

/** "Belegerkennung" section on the settings page (own form, saved via PUT /api/receipts/settings). */
export function ReceiptSettingsSection() {
  const { data } = useQuery(ocrSettingsQuery);
  const update = useUpdateOcrSettings();
  const form = useForm<OcrSettingsInput, unknown, OcrSettings>({
    resolver: zodResolver(ocrSettingsSchema),
    defaultValues: data ?? DEFAULT_OCR_SETTINGS,
  });
  const { control } = form;
  const [mode, llmEnabled, model, visionModel, ollamaUrl] = useWatch({
    control,
    name: ["mode", "llmEnabled", "model", "visionModel", "ollamaUrl"],
  });

  useEffect(() => {
    if (data && !form.formState.isDirty) form.reset(data);
  }, [data, form]);

  const onSubmit = form.handleSubmit((values) =>
    update.mutate(values, {
      onSuccess: (saved) => {
        form.reset(saved);
        toast.success("Belegerkennung gespeichert");
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    }),
  );

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} id="belegerkennung" className="max-w-4xl scroll-mt-8 border-t pt-8">
        <FormSection
          title="Belegerkennung"
          description={
            <>
              Liest Belege von Ausgaben aus – vollständig lokal, ohne Cloud. Beim Hochladen passiert nichts; die Analyse
              startest du selbst im Beleg oder in der Ausgabenliste. Ergebnisse sind nur Vorschläge.
            </>
          }
        >
          <ComponentStatus ollamaUrl={ollamaUrl ?? ""} model={model ?? ""} visionModel={visionModel ?? ""} mode={mode ?? "text"} />

          <FormField
            control={control}
            name="ocrEngine"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Texterkennung (Bilder, gescannte PDFs)</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="vision">Apple Vision (empfohlen, macOS)</SelectItem>
                    <SelectItem value="tesseract">Tesseract</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  PDFs mit Textebene und E-Rechnungen (ZUGFeRD/XRechnung) werden direkt gelesen, ohne Texterkennung.
                </p>
              </FormItem>
            )}
          />

          <SwitchField
            control={control}
            name="llmEnabled"
            label="Lokales KI-Modell verwenden (Ollama)"
            description="Aus: nur regelbasierte Erkennung (UID, Datum, Summen, Steuersätze, IBAN). Ollama wird von nesev nie selbst gestartet."
          />

          {llmEnabled && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField control={control} name="ollamaUrl" label="Ollama-Adresse" placeholder="http://127.0.0.1:11434" />
                <FormField
                  control={control}
                  name="mode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Modus</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="text">Textmodell auf erkanntem Text</SelectItem>
                          <SelectItem value="vision">Vision-Modell auf Seitenbildern</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  control={control}
                  name="model"
                  label={mode === "text" ? "Textmodell (aktiv)" : "Textmodell"}
                  placeholder="qwen3.5:4b"
                />
                <TextField
                  control={control}
                  name="visionModel"
                  label={mode === "vision" ? "Vision-Modell (aktiv)" : "Vision-Modell"}
                  placeholder="qwen3.5:4b"
                />
              </div>
              <p className="-mt-2 text-xs text-muted-foreground">
                Standard für beide Modi: qwen3.5:4b (Text und Bilder, braucht Ollama ≥ 0.19). Andere Modelle für den
                Vision-Modus brauchen die Fähigkeit „vision“ (<code className="rounded bg-muted px-1">ollama show &lt;modell&gt;</code>).
              </p>
              <SwitchField
                control={control}
                name="unloadAfterBatch"
                label="Modell nach der Analyse entladen"
                description="Gibt den Arbeitsspeicher frei, sobald die Warteschlange leer ist (keep_alive 0)."
              />
            </>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={!form.formState.isDirty} onClick={() => form.reset()}>
              Verwerfen
            </Button>
            <Button type="submit" disabled={!form.formState.isDirty || update.isPending}>
              {update.isPending ? "Speichern…" : "Belegerkennung speichern"}
            </Button>
          </div>
        </FormSection>
      </form>
    </Form>
  );
}

function StatusRow({
  state,
  label,
  children,
}: {
  state: "ok" | "warn" | "off";
  label: string;
  children?: React.ReactNode;
}) {
  const Icon = state === "ok" ? CircleCheck : state === "warn" ? CircleAlert : CircleDashed;
  return (
    <div className="flex items-start gap-2 text-sm">
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          state === "ok" ? "text-emerald-600" : state === "warn" ? "text-amber-600" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0">
        <span className="font-medium">{label}</span>
        {children && <span className="text-muted-foreground"> · {children}</span>}
      </div>
    </div>
  );
}

function formatGb(bytes: number) {
  return `${(bytes / 1e9).toLocaleString("de-AT", { maximumFractionDigits: 1 })} GB`;
}

function ComponentStatus({ ollamaUrl, model, visionModel, mode }: { ollamaUrl: string; model: string; visionModel: string; mode: string }) {
  // "Verbindung testen" probes the URL currently in the form (saved or not)
  const [probeUrl, setProbeUrl] = useState<string | undefined>(undefined);
  const status = useQuery(receiptStatusQuery(probeUrl));
  const build = useBuildHelper();
  const s = status.data;
  const has = (name: string) => {
    const want = name.includes(":") ? name : `${name}:latest`;
    return !!s?.ollama.models.some((m) => m.name === want || m.name === name);
  };
  const activeModel = mode === "vision" ? visionModel : model;

  return (
    <div className="grid gap-2 rounded-lg border bg-muted/20 p-4">
      {!s ? (
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Prüfe Komponenten…
        </span>
      ) : (
        <>
          <StatusRow
            state={s.helper.compiled ? "ok" : s.helper.available ? "off" : "warn"}
            label="Apple Vision / PDF-Helfer"
          >
            {s.helper.compiled
              ? "kompiliert"
              : s.helper.available
                ? "wird bei der ersten Analyse kompiliert (einige Sekunden)"
                : (s.helper.error ?? "nicht verfügbar")}
          </StatusRow>
          <StatusRow state={s.tesseract.available ? (s.tesseract.hasGerman ? "ok" : "warn") : "off"} label="Tesseract">
            {s.tesseract.available ? (
              s.tesseract.hasGerman ? (
                `Sprachen: ${s.tesseract.languages.join(", ")}`
              ) : (
                <CodeText text="installiert, aber ohne deutsche Sprachdaten (deu) – `brew install tesseract-lang`" />
              )
            ) : (
              "nicht installiert (nur Fallback)"
            )}
          </StatusRow>
          <StatusRow state={s.ollama.reachable ? "ok" : "warn"} label="Ollama">
            {s.ollama.reachable ? (
              `erreichbar unter ${s.ollama.url}${s.ollama.version ? ` · Version ${s.ollama.version}` : ""}`
            ) : (
              <CodeText text={s.ollama.error ?? "nicht erreichbar"} />
            )}
          </StatusRow>
          {s.ollama.reachable && (
            <StatusRow state={has(activeModel) ? "ok" : "warn"} label={`Modell ${activeModel}`}>
              {has(activeModel) ? (
                "installiert"
              ) : (
                <CodeText
                  text={`fehlt – \`ollama pull ${activeModel}\` (meldet der Download „requires a newer version of Ollama“: zuerst \`brew upgrade ollama\`)`}
                />
              )}
            </StatusRow>
          )}
          {s.ollama.models.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Installierte Modelle: {s.ollama.models.map((m) => `${m.name} (${formatGb(m.size)})`).join(", ")}
            </p>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={status.isFetching}
          onClick={() => {
            setProbeUrl(ollamaUrl || undefined);
            void status.refetch();
          }}
        >
          {status.isFetching ? <Loader2 className="animate-spin" /> : <PlugZap />}
          Verbindung testen
        </Button>
        {s && s.helper.available && !s.helper.compiled && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={build.isPending}
            onClick={() =>
              build.mutate(undefined, {
                onSuccess: () => toast.success("OCR-Helfer kompiliert"),
                onError: (err) => toast.error(apiErrorMessage(err)),
              })
            }
          >
            {build.isPending ? <Loader2 className="animate-spin" /> : <Hammer />}
            Helfer jetzt kompilieren
          </Button>
        )}
      </div>
    </div>
  );
}
