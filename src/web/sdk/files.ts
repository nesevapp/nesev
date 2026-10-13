/** URL for a file under data/ (e.g. settings.logoPath = "assets/logo.png"). */
export function fileUrl(relPath: string): string {
  return `/api/files/${relPath}`;
}
