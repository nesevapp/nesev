import { useState } from "react";
import { Crop, ExternalLink, FileUp, Loader2, Replace, Trash2 } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { DropOverlay, pickReceiptFiles, useWindowFileDrag } from "./file-drop";

export interface ReceiptSource {
  url: string;
  name: string;
  /** "pdf" or an image */
  kind: "pdf" | "image";
}

export function receiptKind(nameOrPath: string, mime?: string): "pdf" | "image" {
  if (mime) return mime === "application/pdf" ? "pdf" : "image";
  return nameOrPath.toLowerCase().endsWith(".pdf") ? "pdf" : "image";
}

/** Crop actions for a saved photo receipt. */
export interface ReceiptCropActions {
  onCrop: () => void;
  /** URL of the uncropped photo when the receipt is cropped, else null */
  originalUrl: string | null;
  onRestore: () => void;
}

/**
 * Receipt preview (PDF in an iframe, images inline) that doubles as a drop zone.
 * Without a receipt it renders a large drop zone; dropping or picking a file calls onFile.
 */
export function ReceiptPane({
  receipt,
  onFile,
  onRemove,
  crop,
  busy,
  className,
}: {
  receipt: ReceiptSource | null;
  onFile: (file: File) => void;
  onRemove?: () => void;
  crop?: ReceiptCropActions;
  busy?: boolean;
  className?: string;
}) {
  const dragging = useWindowFileDrag();
  // "Original anzeigen" on a cropped receipt; resets when the receipt changes
  const [originalFor, setOriginalFor] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const pick = () => pickReceiptFiles(false, (files) => files[0] && onFile(files[0]));
  const onFiles = (files: File[]) => files[0] && onFile(files[0]);

  if (!receipt) {
    return (
      <div className={cn("relative", className)}>
        <button
          type="button"
          onClick={pick}
          disabled={busy}
          className="flex h-full min-h-80 w-full flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-muted-foreground/25 bg-muted/30 p-8 text-center text-sm text-muted-foreground transition-colors hover:border-muted-foreground/50 hover:bg-muted/50 focus-visible:border-ring focus-visible:outline-none"
        >
          {busy ? <Loader2 className="size-8 animate-spin" /> : <FileUp className="size-8 opacity-60" />}
          <span className="font-medium text-foreground">Beleg hierher ziehen</span>
          <span>oder klicken zum Auswählen · PDF, JPG, PNG, WebP · max. 20 MB</span>
        </button>
        <DropOverlay active={dragging} onFiles={onFiles} label="Beleg ablegen" />
      </div>
    );
  }

  const cropActions = receipt.kind === "image" ? crop : undefined;
  const showOriginal = !!cropActions?.originalUrl && originalFor === receipt.url;
  const shownUrl = showOriginal ? cropActions!.originalUrl! : receipt.url;

  return (
    <div className={cn("relative flex flex-col overflow-hidden rounded-lg border bg-muted/30", className)}>
      <div className="flex items-center gap-2 border-b bg-background px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-sm" title={receipt.name}>
          {receipt.name || "Beleg"}
        </span>
        {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {cropActions && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            title="Zuschneiden und gerade rücken"
            onClick={cropActions.onCrop}
            disabled={busy}
          >
            <Crop />
          </Button>
        )}
        <Button asChild variant="ghost" size="icon" className="size-7" title="In neuem Tab öffnen">
          <a href={shownUrl} target="_blank" rel="noreferrer">
            <ExternalLink />
          </a>
        </Button>
        <Button type="button" variant="ghost" size="icon" className="size-7" title="Beleg ersetzen" onClick={pick} disabled={busy}>
          <Replace />
        </Button>
        {onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-destructive"
            title="Beleg entfernen"
            aria-label="Beleg entfernen"
            onClick={() => setConfirmRemove(true)}
            disabled={busy}
          >
            <Trash2 />
          </Button>
        )}
      </div>
      {cropActions?.originalUrl && (
        <div className="flex items-center gap-1.5 border-b bg-background px-3 py-1 text-xs text-muted-foreground">
          <span>{showOriginal ? "Originalfoto" : "Zugeschnitten"}</span>
          <span>·</span>
          <button
            type="button"
            className="underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => setOriginalFor(showOriginal ? null : receipt.url)}
          >
            {showOriginal ? "Zuschnitt anzeigen" : "Original anzeigen"}
          </button>
          <span>·</span>
          <button
            type="button"
            className="underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
            onClick={cropActions.onRestore}
            disabled={busy}
          >
            Original wiederherstellen
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {receipt.kind === "pdf" ? (
          <iframe src={receipt.url} title="Beleg" className="size-full min-h-[70vh] bg-white lg:min-h-0" />
        ) : (
          <div className="size-full overflow-auto p-3">
            <img src={shownUrl} alt="Beleg" className="mx-auto max-w-full rounded shadow-sm" />
          </div>
        )}
      </div>
      <DropOverlay active={dragging} onFiles={onFiles} label="Beleg ersetzen" />
      {onRemove && (
        <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Beleg entfernen?</AlertDialogTitle>
              <AlertDialogDescription>
                Die Belegdatei{receipt.name ? ` „${receipt.name}“` : ""} wird von der Ausgabe entfernt und gelöscht. Die
                übrigen Angaben der Ausgabe bleiben erhalten.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Abbrechen</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={onRemove}>
                Entfernen
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
