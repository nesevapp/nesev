import { runCommand } from "./run";

// Tesseract CLI fallback (brew install tesseract tesseract-lang). German needs the "deu" traineddata.

export interface TesseractStatus {
  available: boolean;
  languages: string[];
  hasGerman: boolean;
}

export async function tesseractStatus(): Promise<TesseractStatus> {
  if (!Bun.which("tesseract")) return { available: false, languages: [], hasGerman: false };
  try {
    const out = await runCommand(["tesseract", "--list-langs"], { timeoutMs: 10_000 });
    const languages = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("List of"));
    return { available: true, languages, hasGerman: languages.includes("deu") };
  } catch {
    return { available: false, languages: [], hasGerman: false };
  }
}

/** OCR of one image file (PNG/JPG); uses deu+eng when German is installed. */
export async function tesseractImage(file: string, langs: string[], signal?: AbortSignal): Promise<string> {
  const lang = langs.filter((l) => l === "deu" || l === "eng").join("+") || "eng";
  return runCommand(["tesseract", file, "stdout", "-l", lang, "--psm", "4"], { signal, timeoutMs: 180_000 });
}
