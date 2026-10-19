import { useQuery } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { FormSection } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { apiErrorMessage, setupStatusQuery, useRevealDataDir } from "@/sdk";

const SOURCE_NOTE = {
  env: "Festgelegt über die Umgebungsvariable NESEV_DATA_DIR.",
  config: "Gewählt bei der Einrichtung.",
  checkout: "Der Ordner data/ im Programmordner (ältere Installation).",
} as const;

const MANAGER = { darwin: "Finder", win32: "Explorer" } as Record<string, string>;

/** Einstellungen → Export & Backup: where the books live, open it, how to move it. */
export function DataDirSection() {
  const { data } = useQuery(setupStatusQuery);
  const reveal = useRevealDataDir();
  if (!data?.dataDir) return null;
  const manager = MANAGER[data.platform] ?? "Dateimanager";

  return (
    <FormSection
      title="Datenordner"
      description="Hier liegen Datenbank, eingefrorene PDFs, Belege und die automatischen Backups."
    >
      <div className="flex flex-col gap-3 text-sm">
        <code className="break-all rounded-md border bg-muted/50 px-3 py-2 text-xs">{data.dataDir}</code>
        {data.source && <p className="text-muted-foreground">{SOURCE_NOTE[data.source]}</p>}
        <div>
          <Button
            variant="outline"
            onClick={() =>
              reveal.mutate(undefined, {
                onSuccess: ({ opened }) => {
                  if (!opened) toast.error(`Kein ${manager} verfügbar – Pfad bitte manuell öffnen.`);
                },
                onError: (err) => toast.error(apiErrorMessage(err)),
              })
            }
          >
            <FolderOpen /> Im {manager} zeigen
          </Button>
        </div>
        {data.source === "config" && (
          <p className="text-muted-foreground">
            Ordner verschieben: nesev beenden, den Ordner verschieben und nesev wieder starten. nesev findet die Daten
            dann nicht mehr und fragt nach dem neuen Ort. Kein Cloud-Ordner (iCloud, OneDrive, Dropbox): die laufende
            Datenbank kann dabei beschädigt werden.
          </p>
        )}
      </div>
    </FormSection>
  );
}
