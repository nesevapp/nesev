import { useQuery } from "@tanstack/react-query";
import { Undo2 } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@shared/dates";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiErrorMessage, bankImportsQuery, useUndoBankImport } from "@/sdk";

const FORMAT: Record<string, string> = { camt053: "camt.053", csv: "CSV", "george-json": "George JSON" };

/** Import history of an account with "Rückgängig" (deletes the import's unmatched transactions). */
export function ImportsDialog({
  accountId,
  open,
  onOpenChange,
}: {
  accountId: number | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data = [] } = useQuery({ ...bankImportsQuery(accountId), enabled: open });
  const undo = useUndoBankImport();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Importverlauf</DialogTitle>
          <DialogDescription>
            Rückgängig entfernt die noch nicht zugeordneten Buchungen eines Imports. Zugeordnete bleiben erhalten.
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-[60vh] divide-y overflow-y-auto rounded-lg border text-sm">
          {data.map((imp) => (
            <li key={imp.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{imp.fileName || "Import"}</div>
                <div className="text-xs text-muted-foreground tabular">
                  {formatDate(imp.createdAt)} · {FORMAT[imp.format] ?? imp.format}
                  {imp.firstDate && ` · ${formatDate(imp.firstDate)} – ${formatDate(imp.lastDate)}`}
                  {` · ${imp.importedCount} importiert`}
                  {imp.skippedCount > 0 && `, ${imp.skippedCount} übersprungen`}
                  {imp.remainingCount !== imp.importedCount && ` · noch ${imp.remainingCount} vorhanden`}
                  {imp.matchedCount > 0 && `, ${imp.matchedCount} zugeordnet`}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={undo.isPending || imp.remainingCount === imp.matchedCount}
                onClick={() => {
                  const n = imp.remainingCount - imp.matchedCount;
                  if (!window.confirm(`${n} nicht zugeordnete Buchung(en) dieses Imports löschen?`)) return;
                  undo.mutate(imp.id, {
                    onSuccess: (r) => toast.success(r.kept ? `${r.deleted} entfernt, ${r.kept} zugeordnete behalten` : `${r.deleted} Buchungen entfernt`),
                    onError: (err) => toast.error(apiErrorMessage(err)),
                  });
                }}
              >
                <Undo2 />
                Rückgängig
              </Button>
            </li>
          ))}
          {data.length === 0 && <li className="px-3 py-8 text-center text-muted-foreground">Noch keine Importe.</li>}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
