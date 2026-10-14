import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Hammer, Loader2, PlugZap } from "lucide-react";
import { toast } from "sonner";
import { DEFAULT_OCR_SETTINGS, modelLabel, OCR_PROVIDER_LABELS, OCR_PROVIDERS, type OcrSettings } from "@shared/receipts";
import { ocrSettingsSchema, type OcrSettingsInput } from "@shared/schemas/receipt";
import { FormSection, SwitchField, TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  apiErrorMessage,
  type OcrStatusProbe,
  ocrSettingsQuery,
  type ReceiptEngineStatus,
  receiptStatusQuery,
  useBuildOcrHelper,
  useUpdateOcrSettings,
} from "@/sdk";
import { CodeText } from "./code-text";
import { LlamaFields, LlamaStatusRows } from "./llama-settings";
import { formatGb, StatusRow } from "./status-row";

/** "Belegerkennung" section on the settings page (own form, saved via PUT /api/receipts/settings). */
export function ReceiptSettingsSection() {
  const { data } = useQuery(ocrSettingsQuery);
  const update = useUpdateOcrSettings();
  const form = useForm<OcrSettingsInput, unknown, OcrSettings>({
    resolver: zodResolver(ocrSettingsSchema),
    defaultValues: data ?? DEFAULT_OCR_SETTINGS,
  });
  const { control } = form;
  const [mode, llmEnabled, model, visionModel, ollamaUrl, provider, openaiUrl, openaiApiKey, openaiModel, llamaServerPath, llamaModelPath, llamaMmprojPath] =
    useWatch({
      control,
      name: [
        "mode",
        "llmEnabled",
        "model",
        "visionModel",
        "ollamaUrl",
        "provider",
        "openaiUrl",
        "openaiApiKey",
        "openaiModel",
        "llamaServerPath",
        "llamaModelPath",
        "llamaMmprojPath",
      ],
    });
  const activeProvider = provider ?? "ollama";
  // the status probes the saved settings until "Verbindung testen" or a provider switch in the form
  const [probe, setProbe] = useState<OcrStatusProbe>({});
  const formProbe = (): OcrStatusProbe =>
    activeProvider === "openai"
      ? { provider: "openai", url: openaiUrl || undefined, apiKey: openaiApiKey ?? "", model: openaiModel ?? "" }
      : activeProvider === "llamacpp"
        ? { provider: "llamacpp", serverPath: llamaServerPath ?? "", modelPath: llamaModelPath ?? "", mmprojPath: llamaMmprojPath ?? "" }
        : { provider: "ollama", url: ollamaUrl || undefined };
  useEffect(() => {
    setProbe(data && activeProvider === data.provider ? {} : formProbe());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on provider switches
  }, [activeProvider, data?.provider]);
  const status = useQuery(receiptStatusQuery(probe));
  const loadedModels = status.data?.openai?.models ?? [];

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
          <ComponentStatus
            status={status.data}
            fetching={status.isFetching}
            onTest={() => {
              setProbe(formProbe());
              void status.refetch();
            }}
            activeModel={mode === "vision" ? (visionModel ?? "") : (model ?? "")}
          />

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
            label="Lokales KI-Modell verwenden"
            description={
              activeProvider === "llamacpp"
                ? "Aus: nur regelbasierte Erkennung (UID, Datum, Summen, Steuersätze, IBAN). Mit llama.cpp startet nesev den Modell-Server nur für eine Analyse und beendet ihn danach."
                : "Aus: nur regelbasierte Erkennung (UID, Datum, Summen, Steuersätze, IBAN). nesev startet Ollama bzw. Unsloth Studio nie selbst."
            }
          />

          {llmEnabled && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={control}
                  name="provider"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Modell-Server</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {OCR_PROVIDERS.map((p) => (
                            <SelectItem key={p} value={p}>
                              {OCR_PROVIDER_LABELS[p]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
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

              {activeProvider === "ollama" ? (
                <>
                  <TextField control={control} name="ollamaUrl" label="Ollama-Adresse" placeholder="http://127.0.0.1:11434" />
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
              ) : activeProvider === "llamacpp" ? (
                <LlamaFields control={control} mode={mode ?? "text"} />
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <TextField control={control} name="openaiUrl" label="Server-Adresse (inkl. /v1)" placeholder="http://127.0.0.1:8888/v1" />
                    <TextField
                      control={control}
                      name="openaiApiKey"
                      label="API-Key"
                      type="password"
                      autoComplete="off"
                      placeholder="sk-unsloth-…"
                    />
                  </div>
                  <FormField
                    control={control}
                    name="openaiModel"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Modell</FormLabel>
                        {loadedModels.length > 0 ? (
                          <Select value={field.value || AUTO_MODEL} onValueChange={(v) => field.onChange(v === AUTO_MODEL ? "" : v)}>
                            <FormControl>
                              <SelectTrigger className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value={AUTO_MODEL}>Automatisch (erstes geladenes Modell)</SelectItem>
                              {loadedModels.map((m) => (
                                <SelectItem key={m} value={m} title={m}>
                                  {modelLabel(m)}
                                </SelectItem>
                              ))}
                              {field.value && !loadedModels.includes(field.value) && (
                                <SelectItem value={field.value}>{modelLabel(field.value)} (nicht geladen)</SelectItem>
                              )}
                            </SelectContent>
                          </Select>
                        ) : (
                          <FormControl>
                            <Input {...field} value={field.value ?? ""} placeholder="leer = erstes geladenes Modell" />
                          </FormControl>
                        )}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <p className="-mt-2 text-xs text-muted-foreground">
                    Unsloth Studio: Modell in der App laden und unter Settings → API einen Key anlegen; die Adresse ist meist
                    http://127.0.0.1:8888/v1 (manchmal Port 8000). Funktioniert auch mit LM Studio und llama-server. Der
                    Vision-Modus braucht ein Modell mit Bildunterstützung (llama-server: mit <code className="rounded bg-muted px-1">--mmproj</code>).
                  </p>
                </>
              )}
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

/** Radix Select can't hold "": stands for an empty openaiModel (first loaded model) */
const AUTO_MODEL = "__auto__";

function ComponentStatus({
  status: s,
  fetching,
  onTest,
  activeModel,
}: {
  status: ReceiptEngineStatus | undefined;
  fetching: boolean;
  onTest: () => void;
  /** Ollama: configured model of the active mode */
  activeModel: string;
}) {
  const build = useBuildOcrHelper();
  const has = (name: string) => {
    const want = name.includes(":") ? name : `${name}:latest`;
    return !!s?.ollama?.models.some((m) => m.name === want || m.name === name);
  };

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
          {s.ollama && (
            <>
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
          {s.openai && (
            <>
              <StatusRow state={s.openai.reachable ? "ok" : "warn"} label="OpenAI-kompatibler Server">
                {s.openai.reachable ? `erreichbar unter ${s.openai.url}` : <CodeText text={s.openai.error ?? "nicht erreichbar"} />}
              </StatusRow>
              {s.openai.reachable && (
                <StatusRow state={s.openai.activeModel ? "ok" : "warn"} label="Modell">
                  {s.openai.activeModel ? (
                    <span title={s.openai.activeModel}>{modelLabel(s.openai.activeModel)}</span>
                  ) : (
                    (s.openai.modelHint ?? "kein Modell geladen")
                  )}
                </StatusRow>
              )}
              {s.openai.models.length > 0 && (
                <p className="text-xs text-muted-foreground">Geladene Modelle: {s.openai.models.map(modelLabel).join(", ")}</p>
              )}
            </>
          )}
          {s.llamacpp && <LlamaStatusRows status={s.llamacpp} />}
        </>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={fetching}
          onClick={onTest}
        >
          {fetching ? <Loader2 className="animate-spin" /> : <PlugZap />}
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
