import { RECEIPT_ACCEPT, RECEIPT_MIME_TYPES } from "@shared/expenses";

// Belege-Eingang accepts the expense receipt types plus HEIC/HEIF (iPhone photos; converted to JPEG on the server).

const HEIC_TYPES = ["image/heic", "image/heif"];
const EXTENSIONS = ["pdf", "jpg", "jpeg", "png", "webp", "heic", "heif"];
export const INBOX_ACCEPT = `${RECEIPT_ACCEPT},.heic,.heif,${HEIC_TYPES.join(",")}`;
export const INBOX_ACCEPT_LABEL = "PDF, JPG, PNG, WebP oder HEIC";

export function splitInboxFiles(files: Iterable<File>): { accepted: File[]; rejected: string[] } {
  const accepted: File[] = [];
  const rejected: string[] = [];
  for (const f of files) {
    const ext = f.name.toLowerCase().split(".").pop() ?? "";
    if (RECEIPT_MIME_TYPES[f.type] || HEIC_TYPES.includes(f.type) || EXTENSIONS.includes(ext)) accepted.push(f);
    else rejected.push(f.name);
  }
  return { accepted, rejected };
}

export function pickInboxFiles(onFiles: (files: File[]) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = INBOX_ACCEPT;
  input.multiple = true;
  input.onchange = () => onFiles(Array.from(input.files ?? []));
  input.click();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toLocaleString("de-AT", { maximumFractionDigits: 1 })} MB`;
}

/** ISO timestamp → "15.10.2026, 14:03" (local time). */
export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("de-AT", { dateStyle: "medium", timeStyle: "short" });
}
