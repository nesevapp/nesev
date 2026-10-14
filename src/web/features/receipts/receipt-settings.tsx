import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Hammer, Loader2, PlugZap } from "lucide-react";
import { toast } from "sonner";
import { DEFAULT_OCR_SETTINGS, type OcrSettings } from "@shared/receipts";
import { ocrSettingsSchema, type OcrSettingsInput } from "@shared/schemas/receipt";
import { FormSection, SwitchField, TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
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
import { StatusRow } from "./status-row";

/** "Belegerkennung" section on the settings page (own form, saved via PUT /api/receipts/settings). */
export function ReceiptSettingsSection() {
  const { data } = useQuery(ocrSettingsQuery);
  const update = useUpdateOcrSettings();
  const form = useForm<OcrSettingsInput, unknown, OcrSettings>({
    resolver: zodResolver(ocrSettingsSchema),
    defaultValues: data ?? DEFAULT_OCR_SETTINGS,
  });
  const { control } = form;
  const [mode, llmEnabled, llamaServerPath, llamaModelPath, llamaMmprojPath] = useWatch({
    control,
    name: ["mode", "llmEnabled", "llamaServerPath", "llamaModelPath", "llamaMmprojPath"],
  });
  // the status shows the saved settings until "Verbindung testen" probes the form's paths
  const [probe, setProbe] = useState<OcrStatusProbe>({});
  const status = useQuery(receiptStatusQuery(probe));

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
              setProbe({ serverPath: llamaServerPath ?? "", modelPath: llamaModelPath ?? "", mmprojPath: llamaMmprojPath ?? "" });
              void status.refetch();
            }}
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
            description="Aus: nur regelbasierte Erkennung (UID, Datum, Summen, Steuersätze, IBAN). An: nesev startet llama.cpp (llama-server) nur für die Analyse und beendet es danach wieder."
          />

          {llmEnabled && (
            <>
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

              <LlamaFields control={control} mode={mode ?? "text"} autoModel={status.data?.llamacpp.autoModel ?? null} />
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

function ComponentStatus({
  status: s,
  fetching,
  onTest,
}: {
  status: ReceiptEngineStatus | undefined;
  fetching: boolean;
  onTest: () => void;
}) {
  const build = useBuildOcrHelper();

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
          <LlamaStatusRows status={s.llamacpp} />
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
