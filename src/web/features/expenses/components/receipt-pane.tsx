import { ExternalLink, FileUp, Loader2, Replace, Trash2 } from "lucide-react";
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

/**
 * Receipt preview (PDF in an iframe, images inline) that doubles as a drop zone.
 * Without a receipt it renders a large drop zone; dropping or picking a file calls onFile.
 */
export function ReceiptPane({
  receipt,
  onFile,
  onRemove,
  busy,
  className,
}: {
  receipt: ReceiptSource | null;
  onFile: (file: File) => void;
  onRemove?: () => void;
  busy?: boolean;
  className?: string;
}) {
  const dragging = useWindowFileDrag();
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

  return (
    <div className={cn("relative flex flex-col overflow-hidden rounded-lg border bg-muted/30", className)}>
      <div className="flex items-center gap-2 border-b bg-background px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-sm" title={receipt.name}>
          {receipt.name || "Beleg"}
        </span>
        {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        <Button asChild variant="ghost" size="icon" className="size-7" title="In neuem Tab öffnen">
          <a href={receipt.url} target="_blank" rel="noreferrer">
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
            onClick={onRemove}
            disabled={busy}
          >
            <Trash2 />
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {receipt.kind === "pdf" ? (
          <iframe src={receipt.url} title="Beleg" className="size-full min-h-[70vh] bg-white" />
        ) : (
          <div className="size-full overflow-auto p-3">
            <img src={receipt.url} alt="Beleg" className="mx-auto max-w-full rounded shadow-sm" />
          </div>
        )}
      </div>
      <DropOverlay active={dragging} onFiles={onFiles} label="Beleg ersetzen" />
    </div>
  );
}
