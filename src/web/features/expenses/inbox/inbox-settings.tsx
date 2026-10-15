import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { FormSection } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage, inboxStatusQuery, useScanInbox, useSetInboxFolder } from "@/sdk";
import { formatTimestamp } from "./inbox-files";

/** Settings block "Belege-Eingang": the folder nesev picks receipts up from (own save, validated on the server). */
export function ReceiptInboxSettings() {
  const { data: status } = useQuery(inboxStatusQuery);
  const save = useSetInboxFolder();
  const scan = useScanInbox();
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const saved = status?.path ?? "";
  useEffect(() => setPath(saved), [saved]);
  const dirty = path.trim() !== saved;

  const submit = (next: string) => {
    setError(null);
    save.mutate(
      { path: next },
      {
        onSuccess: (s) => {
          setPath(s.path);
          toast.success(s.path ? "Eingangsordner gespeichert" : "Eingangsordner deaktiviert");
        },
        onError: (err) => setError(apiErrorMessage(err)),
      },
    );
  };

  return (
    <div className="max-w-4xl">
      <FormSection
        title="Belege-Eingang"
        description={
          <>
            Belege (PDF, Fotos) aus diesem Ordner landen automatisch im{" "}
            <Link to="/expenses/inbox" className="underline underline-offset-2">
              Eingang
            </Link>{" "}
            unter Ausgaben. Übernommene Dateien werden in den Unterordner „Importiert“ verschoben, nichts wird gelöscht
            oder automatisch analysiert.
          </>
        }
      >
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit(path);
          }}
        >
          <Label htmlFor="receipt-inbox-path">Ordner</Label>
          <div className="flex gap-2">
            <Input
              id="receipt-inbox-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="z. B. ~/Library/Mobile Documents/com~apple~CloudDocs/Belege"
              className="font-mono text-xs"
              aria-invalid={!!error}
            />
            <Button type="submit" size="sm" className="h-9" disabled={!dirty || save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />}
              Speichern
            </Button>
            {saved && (
              <Button type="button" size="sm" variant="ghost" className="h-9" disabled={save.isPending} onClick={() => submit("")}>
                Deaktivieren
              </Button>
            )}
          </div>
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Absoluter Pfad, „~“ für den Benutzerordner. Der Ordner wird beim Start und etwa jede Minute geprüft.
            </p>
          )}
        </form>

        {status?.path && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-muted/20 px-3 py-2 text-sm">
            {status.error ? (
              <span className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="size-4" /> {status.error}
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-success" />
                {status.lastScanAt ? `Zuletzt geprüft ${formatTimestamp(status.lastScanAt)}` : "Noch nicht geprüft"}
                {status.newCount > 0 && ` · ${status.newCount} im Eingang`}
              </span>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="ml-auto h-7"
              disabled={scan.isPending}
              onClick={() =>
                scan.mutate(undefined, {
                  onSuccess: ({ result }) =>
                    result.error
                      ? toast.error(result.error)
                      : toast.success(result.imported ? `${result.imported} neue Belege` : "Keine neuen Belege"),
                  onError: (err) => toast.error(apiErrorMessage(err)),
                })
              }
            >
              {scan.isPending && <Loader2 className="animate-spin" />}
              Jetzt prüfen
            </Button>
          </div>
        )}
      </FormSection>
    </div>
  );
}
