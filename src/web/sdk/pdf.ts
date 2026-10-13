// PDF endpoints are plain links/fetches (the browser renders or downloads them), not hc calls.

export function documentPdfUrl(id: number, download = false): string {
  return `/api/pdf/documents/${id}${download ? "?download=1" : ""}`;
}

export function reminderPdfUrl(id: number, download = false): string {
  return `/api/pdf/reminders/${id}${download ? "?download=1" : ""}`;
}

/** Font files the server renders with (the designer loads the same ones). */
export function pdfFontUrl(file: string): string {
  return `/api/pdf/fonts/${file}`;
}
