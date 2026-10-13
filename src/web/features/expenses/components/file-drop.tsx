import { useEffect, useRef, useState } from "react";
import { RECEIPT_ACCEPT, RECEIPT_MIME_TYPES } from "@shared/expenses";
import { cn } from "@/lib/utils";

const hasFiles = (e: DragEvent | React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/**
 * True while files are dragged anywhere over the window. Drop targets render an overlay while this is
 * set, so drops over iframes (PDF preview) still reach them. Also stops the browser from opening
 * files dropped outside a target.
 */
export function useWindowFileDrag(): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const end = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
      depth.current = 0;
      setDragging(false);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", end);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", end);
    };
  }, []);
  return dragging;
}

/** Splits files into accepted receipts and rejected names (by MIME type or extension). */
export function splitReceiptFiles(files: Iterable<File>): { accepted: File[]; rejected: string[] } {
  const accepted: File[] = [];
  const rejected: string[] = [];
  for (const f of files) {
    const ext = f.name.toLowerCase().split(".").pop() ?? "";
    if (RECEIPT_MIME_TYPES[f.type] || ["pdf", "jpg", "jpeg", "png", "webp"].includes(ext)) accepted.push(f);
    else rejected.push(f.name);
  }
  return { accepted, rejected };
}

/** Opens the native file dialog for receipts. */
export function pickReceiptFiles(multiple: boolean, onFiles: (files: File[]) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = RECEIPT_ACCEPT;
  input.multiple = multiple;
  input.onchange = () => onFiles(Array.from(input.files ?? []));
  input.click();
}

/** Absolute overlay that captures a file drop while `active` (see useWindowFileDrag). */
export function DropOverlay({
  active,
  onFiles,
  label,
  className,
}: {
  active: boolean;
  onFiles: (files: File[]) => void;
  label: string;
  className?: string;
}) {
  const [over, setOver] = useState(false);
  if (!active) return null;
  return (
    <div
      className={cn(
        "absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed bg-background/85 text-sm font-medium backdrop-blur-[1px] transition-colors",
        over ? "border-primary text-foreground" : "border-muted-foreground/40 text-muted-foreground",
        className,
      )}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {label}
    </div>
  );
}
