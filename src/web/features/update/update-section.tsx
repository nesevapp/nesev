import { useQuery } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { FormSection } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { apiErrorMessage, updateStatusQuery, useCheckForUpdates, useSetUpdateCheck } from "@/sdk";
import { updateCommand } from "./update-hint";

const dateTime = (iso: string) =>
  new Intl.DateTimeFormat("de-AT", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

/** Einstellungen → Export & Backup: version, update check switch, check now. */
export function UpdateSection() {
  const { data } = useQuery(updateStatusQuery);
  const check = useCheckForUpdates();
  const setEnabled = useSetUpdateCheck();
  if (!data) return null;

  return (
    <FormSection
      title="Updates"
      description="Einmal täglich fragt nesev bei GitHub nach der neuesten Version. Sonst wird nichts gesendet."
    >
      <div className="flex flex-col gap-3 text-sm">
        <p>
          Installierte Version: <span className="font-medium tabular">{data.current}</span>
          {data.enabled && data.latest && (
            <>
              {" "}
              · neueste: <span className="font-medium tabular">{data.latest}</span>
              {data.newer ? (
                <span className={data.security ? "text-warning" : undefined}>
                  {data.security ? " – Sicherheitsupdate verfügbar" : " – Update verfügbar"}
                </span>
              ) : (
                <span className="text-muted-foreground"> – aktuell</span>
              )}
            </>
          )}
        </p>
        {data.newer && (
          <p className="text-muted-foreground">
            Aktualisieren im Terminal: <code className="font-mono text-foreground">{updateCommand(data.install)}</code>
            {data.url && (
              <>
                {" · "}
                <a href={data.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                  Was ist neu
                </a>
              </>
            )}
          </p>
        )}
        {data.enabled && data.error && <p className="text-muted-foreground">Letzte Prüfung fehlgeschlagen: {data.error}</p>}
        <label className="flex items-center gap-3">
          <Switch
            checked={data.enabled}
            disabled={data.lockedByEnv || setEnabled.isPending}
            onCheckedChange={(enabled) =>
              setEnabled.mutate(enabled, { onError: (err) => toast.error(apiErrorMessage(err)) })
            }
          />
          <span>
            Nach Updates suchen
            {data.lockedByEnv && <span className="text-muted-foreground"> (abgeschaltet durch NESEV_UPDATE_CHECK=0)</span>}
          </span>
        </label>
        {data.enabled && (
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={check.isPending}
              onClick={() => check.mutate(undefined, { onError: (err) => toast.error(apiErrorMessage(err)) })}
            >
              {check.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Jetzt prüfen
            </Button>
            {data.checkedAt && <span className="text-xs text-muted-foreground">Zuletzt geprüft: {dateTime(data.checkedAt)}</span>}
          </div>
        )}
      </div>
    </FormSection>
  );
}
