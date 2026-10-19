import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, FileCode2 } from "lucide-react";
import type { EInvoiceFormat } from "@shared/einvoice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiErrorMessage, einvoiceDownloadUrl, einvoiceStatusQuery, type EInvoiceStatus } from "@/sdk";

/** "E-Rechnung" button + dialog on a finalized invoice / credit note. */
export function EInvoiceDownloadButton({ documentId, number }: { documentId: number; number: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <FileCode2 />
        E-Rechnung
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>E-Rechnung herunterladen</DialogTitle>
            <DialogDescription>{number}</DialogDescription>
          </DialogHeader>
          {open && <EInvoiceDialogBody documentId={documentId} onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function EInvoiceDialogBody({ documentId, onDone }: { documentId: number; onDone: () => void }) {
  const status = useQuery(einvoiceStatusQuery(documentId));
  if (status.isPending) return <p className="py-4 text-sm text-muted-foreground">Daten werden geprüft…</p>;
  if (status.isError) return <p className="py-4 text-sm text-destructive">{apiErrorMessage(status.error)}</p>;
  return <EInvoiceForm documentId={documentId} status={status.data} onDone={onDone} />;
}

function EInvoiceForm({ documentId, status, onDone }: { documentId: number; status: EInvoiceStatus; onDone: () => void }) {
  const [format, setFormat] = useState<EInvoiceFormat>(
    status.defaultFormat ?? status.formats.find((f) => f.problems.length === 0)?.format ?? "ebinterface",
  );
  const selected = status.formats.find((f) => f.format === format)!;
  const blocked = selected.problems.length > 0;

  return (
    <>
      <div className="grid gap-4 py-2">
        <div className="grid gap-2">
          <Label htmlFor="einvoice-format">Format</Label>
          <Select value={format} onValueChange={(v) => setFormat(v as EInvoiceFormat)}>
            <SelectTrigger id="einvoice-format" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {status.formats.map((f) => (
                <SelectItem key={f.format} value={f.format}>
                  {f.label}
                  {f.format === status.defaultFormat && <span className="text-muted-foreground"> · Kundenvorgabe</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!status.defaultFormat && (
            <p className="text-xs text-muted-foreground">Beim Kunden ist kein E-Rechnungsformat hinterlegt.</p>
          )}
        </div>

        {status.buyerReference && (
          <p className="text-sm text-muted-foreground">
            Referenz: <span className="tabular text-foreground">{status.buyerReference}</span>
          </p>
        )}

        {blocked ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
            <p className="mb-1 flex items-center gap-1.5 font-medium text-destructive">
              <AlertTriangle className="size-4" />
              Für dieses Format fehlen Angaben:
            </p>
            <ul className="list-disc space-y-0.5 pl-5">
              {selected.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            {selected.problems.some((p) => p.startsWith("Einstellungen:")) && (
              <p className="mt-2 text-xs text-muted-foreground">
                Firmendaten sind im finalisierten Beleg eingefroren: Änderungen in den Einstellungen gelten nur für neue
                Belege.
              </p>
            )}
          </div>
        ) : (
          format === "zugferd" && (
            <p className="text-xs text-muted-foreground">
              ZUGFeRD-XML (EN 16931) wird in eine Kopie des Rechnungs-PDFs eingebettet. PDF/A-3 ist mit den
              Standardvorlagen geprüft, bei eigenem Briefpapier-PDF nicht garantiert.
            </p>
          )
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Schließen
        </Button>
        {blocked ? (
          <Button disabled>Herunterladen</Button>
        ) : (
          <Button asChild>
            <a href={einvoiceDownloadUrl(documentId, format)} download onClick={onDone}>
              Herunterladen
            </a>
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
