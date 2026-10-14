import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { HardDrive, Plus } from "lucide-react";
import { toast } from "sonner";
import { formatAssetNumber } from "@shared/assets";
import { formatCents } from "@shared/money";
import type { AssetFormValues } from "@shared/schemas/asset";
import { Button } from "@/components/ui/button";
import { AssetFormDialog } from "@/features/assets/components/asset-form-dialog";
import { apiErrorMessage, assetLinksQuery, assetPrefillQuery } from "@/sdk";

/**
 * Shown in the expense editor when a line has category "anlagen": such lines are capitalized (AfA via the
 * Anlagenverzeichnis), so the asset has to be created there. Links to assets already created from this expense.
 */
export function AssetHint({ expenseId, number, dirty }: { expenseId: number | null; number: string | null; dirty: boolean }) {
  const qc = useQueryClient();
  const links = useQuery(assetLinksQuery);
  const linked = (links.data ?? []).filter((a) => a.expenseId === expenseId);
  const [defaults, setDefaults] = useState<Partial<AssetFormValues> | null>(null);
  const [loading, setLoading] = useState(false);
  const canCreate = expenseId != null && !dirty;

  const openCreate = async () => {
    if (expenseId == null) return;
    setLoading(true);
    try {
      const p = await qc.fetchQuery(assetPrefillQuery(expenseId));
      setDefaults({ name: p.name, expenseId, acquisitionDate: p.acquisitionDate, inServiceDate: p.inServiceDate, costCents: p.costCents });
    } catch (err) {
      toast.error(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-sky-200 bg-sky-50/60 px-3 py-2.5 text-sm">
      <div className="flex items-start gap-2">
        <HardDrive className="mt-0.5 size-4 shrink-0 text-sky-700" />
        <div>
          <p>Anlagegüter werden nicht als Ausgabe erfasst, sondern über die Nutzungsdauer abgeschrieben (AfA).</p>
          {linked.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {canCreate ? "Noch keine Anlage im Anlagenverzeichnis — sonst fehlt die AfA in der EAR." : "Zuerst speichern, dann im Anlagenverzeichnis anlegen."}
            </p>
          ) : (
            <p className="flex flex-wrap gap-x-3 text-xs">
              {linked.map((a) => (
                <Link key={a.id} to="/assets/$id" params={{ id: a.id }} className="font-medium text-sky-800 hover:underline">
                  Anlage {formatAssetNumber(a.number)} öffnen ({a.name}, {formatCents(a.costCents)})
                </Link>
              ))}
            </p>
          )}
        </div>
      </div>
      <Button type="button" variant={linked.length ? "ghost" : "outline"} size="sm" className="bg-background" disabled={!canCreate || loading} onClick={() => void openCreate()}>
        <Plus />
        {linked.length ? "Weitere Anlage" : "Im Anlagenverzeichnis anlegen"}
      </Button>
      <AssetFormDialog
        open={defaults != null}
        onOpenChange={(open) => !open && setDefaults(null)}
        defaults={defaults ?? undefined}
        source={number ? `Aus Ausgabe ${number}` : "Aus Ausgabe"}
      />
    </div>
  );
}
