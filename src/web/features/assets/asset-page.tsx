import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Ban, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { formatAssetNumber, GWG_LIMIT_CENTS, isFirstHalf } from "@shared/assets";
import { formatDate, todayIso } from "@shared/dates";
import { formatCents } from "@shared/money";
import { Page } from "@/components/page";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { apiErrorMessage, type Asset, useDeleteAsset, useUndoAssetDisposal } from "@/sdk";
import { AssetFormDialog } from "./components/asset-form-dialog";
import { DisposalDialog } from "./components/disposal-dialog";
import { ScheduleTable } from "./components/schedule-table";

/** Asset detail: master data, AfA schedule, link to the source expense, edit / disposal / delete. */
export function AssetPage({ asset }: { asset: Asset }) {
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<"edit" | "dispose" | "delete" | null>(null);
  const undo = useUndoAssetDisposal();
  const remove = useDeleteAsset();
  const thisYear = Number(todayIso().slice(0, 4));
  const close = (open: boolean) => !open && setDialog(null);

  const onDelete = () =>
    remove.mutate(asset.id, {
      onSuccess: () => {
        toast.success(`Anlage ${formatAssetNumber(asset.number)} gelöscht`);
        void navigate({ to: "/assets" });
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    });

  return (
    <Page
      title={
        <span className="flex items-center gap-3">
          <Link to="/assets" className="text-muted-foreground hover:text-foreground" aria-label="Zurück zu Anlagen">
            <ArrowLeft className="size-5" />
          </Link>
          {formatAssetNumber(asset.number)} · {asset.name}
          {asset.disposalDate && (
            <span className="inline-flex h-5 items-center rounded-full border px-2 text-xs font-medium text-muted-foreground">ausgeschieden</span>
          )}
        </span>
      }
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={() => setDialog("delete")}>
            <Trash2 /> Löschen
          </Button>
          {asset.disposalDate ? (
            <Button
              variant="outline"
              size="sm"
              disabled={undo.isPending}
              onClick={() => undo.mutate(asset.id, { onSuccess: () => toast.success("Ausscheiden rückgängig gemacht"), onError: (err) => toast.error(apiErrorMessage(err)) })}
            >
              <RotateCcw /> Ausscheiden rückgängig
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setDialog("dispose")}>
              <Ban /> Ausscheiden
            </Button>
          )}
          <Button size="sm" onClick={() => setDialog("edit")}>
            <Pencil /> Bearbeiten
          </Button>
        </>
      }
    >
      <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <dl className="grid content-start gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_1fr]">
          <Item label="Anschaffung">{formatDate(asset.acquisitionDate)}</Item>
          <Item label="Inbetriebnahme">
            {formatDate(asset.inServiceDate)}
            <span className="ml-2 text-xs text-muted-foreground">{isFirstHalf(asset.inServiceDate) ? "1. Halbjahr: volle AfA" : "2. Halbjahr: halbe AfA"}</span>
          </Item>
          <Item label="Anschaffungskosten">
            <span className="tabular">{formatCents(asset.costCents)}</span>
            {asset.gwg && <span className="ml-2 text-xs text-warning">≤ {formatCents(GWG_LIMIT_CENTS)}: als GWG sofort absetzbar</span>}
          </Item>
          <Item label="Nutzungsdauer">
            {asset.usefulLifeYears} {asset.usefulLifeYears === 1 ? "Jahr" : "Jahre"} · <span className="tabular">{formatCents(asset.annualAfaCents)}</span> / Jahr
          </Item>
          <Item label="Ausgabe">
            {asset.expense ? (
              <Link to="/expenses/$id" params={{ id: asset.expense.id }} className="font-medium hover:underline">
                {asset.expense.number ?? "Ausgabe"} · {asset.expense.supplierName} · {formatDate(asset.expense.issueDate)}
              </Link>
            ) : (
              <span className="text-muted-foreground">nicht verknüpft</span>
            )}
          </Item>
          {asset.disposalDate && (
            <>
              <Item label="Ausgeschieden am">{formatDate(asset.disposalDate)}</Item>
              <Item label="Erlös">
                <span className="tabular">{formatCents(asset.disposalProceedsCents ?? 0)}</span>
                {(asset.disposalProceedsCents ?? 0) > 0 && (
                  <span className="ml-2 text-xs text-muted-foreground">Erlös aus Anlagenverkauf — als Einnahme erfassen</span>
                )}
              </Item>
            </>
          )}
          {asset.notes && <Item label="Notizen"><span className="whitespace-pre-wrap">{asset.notes}</span></Item>}
        </dl>

        <section className="min-w-0">
          <h2 className="mb-3 text-sm font-medium">AfA-Plan</h2>
          <div className="rounded-lg border">
            <ScheduleTable rows={asset.schedule} highlightYear={thisYear} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Die AfA eines Jahres steht in der EAR unter E1a KZ 9130. Die Ausgabe selbst zählt nicht als Betriebsausgabe; die Vorsteuer ist sofort abziehbar.
          </p>
        </section>
      </div>

      <AssetFormDialog open={dialog === "edit"} onOpenChange={close} asset={asset} />
      <DisposalDialog open={dialog === "dispose"} onOpenChange={close} asset={asset} />
      <AlertDialog open={dialog === "delete"} onOpenChange={close}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Anlage löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              {formatAssetNumber(asset.number)} wird aus dem Anlagenverzeichnis entfernt, ihre AfA fehlt danach in der EAR. Für verkaufte oder
              entsorgte Anlagen stattdessen „Ausscheiden“ verwenden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete} variant="destructive">
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}
