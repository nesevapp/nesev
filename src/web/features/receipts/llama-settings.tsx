import { type Control, useFormContext, useWatch } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import { FlaskConical, Loader2 } from "lucide-react";
import { formatCents } from "@shared/money";
import type { OcrMode } from "@shared/receipts";
import type { OcrSettingsInput } from "@shared/schemas/receipt";
import { NumberField, SwitchField, TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { FormItem, FormLabel } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiErrorMessage, type LlamaModel, llamaModelsQuery, type ReceiptEngineStatus, useTestLlama } from "@/sdk";
import { CodeText } from "./code-text";
import { formatGb, StatusRow } from "./status-row";

// llama.cpp (llama-server, started by nesev): form fields and status rows of the Belegerkennung settings.

const seconds = (ms: number) => `${(ms / 1000).toLocaleString("de-AT", { maximumFractionDigits: 1 })} s`;

export const llamaModelLabel = (m: LlamaModel) =>
  [m.name, m.quant, formatGb(m.sizeBytes), m.mmproj ? "Vision" : null].filter(Boolean).join(" · ");

export function LlamaFields({
  control,
  mode,
  autoModel,
}: {
  control: Control<OcrSettingsInput>;
  mode: OcrMode;
  /** the model used when the path is left empty (from the status) */
  autoModel: { path: string; label: string } | null;
}) {
  const models = useQuery(llamaModelsQuery);
  const test = useTestLlama();
  const [serverPath, modelPath, mmprojPath, contextSize] = useWatch({
    control,
    name: ["llamaServerPath", "llamaModelPath", "llamaMmprojPath", "llamaContextSize"],
  });
  const found = models.data ?? [];

  return (
    <>
      <TextField
        control={control}
        name="llamaModelPath"
        label="Modelldatei (GGUF)"
        placeholder={autoModel ? `leer = automatisch (${autoModel.label})` : "~/.cache/huggingface/hub/models--…/…/modell.gguf"}
        description={
          found.length > 0
            ? undefined
            : "Keine GGUF-Dateien gefunden (gesucht: Hugging-Face-Cache, llama.cpp-Cache, ~/.unsloth, LM Studio). Einmal `llama-server -hf unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL` lädt das empfohlene Modell."
        }
      />
      {found.length > 0 && (
        <FormItem className="-mt-2">
          <FormLabel className="sr-only">Gefundene Modelle</FormLabel>
          <ModelPicker models={found} value={modelPath ?? ""} autoModel={autoModel} />
        </FormItem>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField control={control} name="llamaServerPath" label="llama-server" placeholder="automatisch erkennen" />
        <NumberField control={control} name="llamaContextSize" label="Kontextgröße" suffix="Token" min={1024} step={1024} />
      </div>
      <TextField
        control={control}
        name="llamaMmprojPath"
        label={mode === "vision" ? "mmproj-Datei (Vision, aktiv)" : "mmproj-Datei (nur Vision-Modus)"}
        placeholder="automatisch: mmproj*.gguf neben dem Modell"
      />
      <SwitchField
        control={control}
        name="unloadAfterBatch"
        label="llama-server nach der Analyse beenden"
        description="Gibt den Arbeitsspeicher frei, sobald die Warteschlange leer ist. Aus: läuft noch 5 Minuten weiter, damit die nächste Analyse nicht erneut lädt."
      />
      <div className="-mt-2 grid gap-2 text-xs text-muted-foreground">
        <p>
          nesev startet <code className="rounded bg-muted px-1">llama-server</code> selbst, nur lokal (127.0.0.1, eigener Port und
          Schlüssel, ohne Netzwerkzugriff), und beendet ihn wieder. Kein anderes Programm muss laufen. Das erste Laden dauert je nach
          Modell 10–30 Sekunden.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={test.isPending || (!modelPath && !autoModel)}
            onClick={() =>
              test.mutate({
                serverPath: serverPath ?? "",
                modelPath: modelPath ?? "",
                mmprojPath: mmprojPath ?? "",
                contextSize: typeof contextSize === "number" && contextSize >= 1024 ? contextSize : undefined,
              })
            }
          >
            {test.isPending ? <Loader2 className="animate-spin" /> : <FlaskConical />}
            {test.isPending ? "Starte llama-server…" : "Testen"}
          </Button>
          <span>Startet den Server mit diesen Werten, liest einen Beispielbeleg und beendet ihn wieder.</span>
        </div>
        {test.data && !test.isPending && (
          <p className="text-success">
            Funktioniert: geladen in {seconds(test.data.startMs)}, Beispielbeleg in {seconds(test.data.extractMs)} gelesen (
            {test.data.supplierName ?? "kein Lieferant"}
            {test.data.grossCents != null ? `, ${formatCents(test.data.grossCents)}` : ""}).
          </p>
        )}
        {test.error && !test.isPending && (
          <p className="text-destructive">
            <CodeText text={apiErrorMessage(test.error)} />
          </p>
        )}
      </div>
    </>
  );
}

/** Radix Select can't hold "": stands for an empty model path (automatic choice) */
const AUTO_MODEL = "__auto__";

/** Picks a discovered GGUF (or the automatic choice) into the path field above; a custom path shows the placeholder. */
function ModelPicker({ models, value, autoModel }: { models: LlamaModel[]; value: string; autoModel: { label: string } | null }) {
  const { setValue } = useFormContext<OcrSettingsInput>();
  return (
    <Select
      value={!value ? AUTO_MODEL : models.some((m) => m.path === value) ? value : ""}
      onValueChange={(path) => setValue("llamaModelPath", path === AUTO_MODEL ? "" : path, { shouldDirty: true, shouldValidate: true })}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Gefundenes Modell wählen…" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={AUTO_MODEL}>Automatisch{autoModel ? `: ${autoModel.label}` : ""}</SelectItem>
        {models.map((m) => (
          <SelectItem key={m.path} value={m.path} title={m.path}>
            {llamaModelLabel(m)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function LlamaStatusRows({ status: s }: { status: NonNullable<ReceiptEngineStatus["llamacpp"]> }) {
  return (
    <>
      <StatusRow state={s.binary.path ? "ok" : "warn"} label="llama-server">
        {s.binary.path ? (
          <span title={s.binary.path}>
            {s.binary.source} · {s.binary.version ? `Version ${s.binary.version}` : "Version unbekannt"}
          </span>
        ) : (
          <CodeText text={s.binary.error ?? "nicht gefunden"} />
        )}
      </StatusRow>
      <StatusRow state={s.model.exists ? "ok" : "warn"} label="Modell">
        {s.model.exists ? (
          <span title={s.model.path}>
            {s.model.auto ? `Automatisch: ${s.model.label}` : s.model.label}
            {s.model.sizeBytes != null ? ` · ${formatGb(s.model.sizeBytes)}` : ""}
          </span>
        ) : (
          <CodeText text={s.model.hint ?? "nicht gefunden"} />
        )}
      </StatusRow>
      <StatusRow state={s.vision ? "ok" : "off"} label="Vision">
        {s.vision ? (
          <span title={s.mmproj.path ?? ""}>
            verfügbar ({s.mmproj.auto ? "mmproj neben dem Modell" : "mmproj eingestellt"})
          </span>
        ) : s.mmproj.path ? (
          `mmproj-Datei nicht gefunden: ${s.mmproj.path}`
        ) : (
          "nicht verfügbar (keine mmproj-Datei) – nur Modus „Text“"
        )}
      </StatusRow>
      <StatusRow state={s.server.running ? "ok" : "off"} label="Server">
        {s.server.running
          ? `läuft auf Port ${s.server.port} (PID ${s.server.pid})`
          : s.server.starting
            ? "startet…"
            : "gestoppt – startet bei der nächsten Analyse"}
      </StatusRow>
      {s.server.lastError && (
        <p className="text-xs text-destructive">
          Letzter Fehler: <CodeText text={s.server.lastError} />
        </p>
      )}
    </>
  );
}
