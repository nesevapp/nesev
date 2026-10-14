import { useEffect, useState } from "react";
import { toast } from "sonner";
import { afaForYear, bookValueAtYearEnd, formatAssetNumber } from "@shared/assets";
import { todayIso } from "@shared/dates";
import { formatCents } from "@shared/money";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CODECS, NumericInput } from "@/features/documents/components/numeric-input";
import { apiErrorMessage, type Asset, useDisposeAsset } from "@/sdk";

/** Sold or scrapped: date and proceeds; shows what is written off in that year. */
export function DisposalDialog({ asset, open, onOpenChange }: { asset: Asset; open: boolean; onOpenChange: (open: boolean) => void }) {
  const dispose = useDisposeAsset();
  const [date, setDate] = useState(todayIso());
  const [proceeds, setProceeds] = useState(0);
  useEffect(() => {
    if (!open) return;
    setDate(asset.disposalDate ?? todayIso());
    setProceeds(asset.disposalProceedsCents ?? 0);
  }, [open, asset.disposalDate, asset.disposalProceedsCents]);

  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= asset.inServiceDate;
  const year = Number(date.slice(0, 4));
  const preview = valid ? { ...afaForYear({ ...asset, disposalDate: date }, year), start: bookValueAtYearEnd({ ...asset, disposalDate: null }, year - 1) } : null;

  const submit = () =>
    dispose.mutate(
      { id: asset.id, json: { disposalDate: date, disposalProceedsCents: proceeds } },
      {
        onSuccess: () => {
          toast.success(`Anlage ${formatAssetNumber(asset.number)} als ausgeschieden erfasst`);
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err)),
      },
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Anlage ausscheiden</DialogTitle>
          <DialogDescription>Verkauf oder Entsorgung: der Restbuchwert wird im Jahr des Ausscheidens abgeschrieben.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="disposal-date">Ausgeschieden am</Label>
            <Input id="disposal-date" type="date" className="tabular" value={date} min={asset.inServiceDate} onChange={(e) => setDate(e.target.value)} />
            {!valid && <p className="text-xs text-destructive">Datum ab der Inbetriebnahme ({asset.inServiceDate}) angeben.</p>}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="disposal-proceeds">Erlös netto (€)</Label>
            <NumericInput id="disposal-proceeds" value={proceeds} onChange={setProceeds} codec={CODECS.money} min={0} />
            <p className="text-xs text-muted-foreground">0 bei Entsorgung. Erlös aus Anlagenverkauf — als Einnahme erfassen (Rechnung), er wird hier nicht gebucht.</p>
          </div>
          {preview && (
            <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
              <Row label={`Buchwert 1.1.${year}`} value={formatCents(preview.start)} />
              <Row label={`AfA ${year}`} value={formatCents(preview.afaCents)} />
              <Row label="Restbuchwert-Abgang" value={formatCents(preview.disposalCents)} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button onClick={submit} disabled={!valid || dispose.isPending}>
            Ausscheiden
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular">{value}</span>
    </div>
  );
}
