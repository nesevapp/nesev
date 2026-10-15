import { runCommand } from "../ocr/run";

// One whisper-cli process per transcription. With the model in the OS file cache, large-v3-turbo-q5_0 loads and
// transcribes a 5–20 s German sentence in well under a second on Apple Silicon (Metal), so no resident server.

export interface WhisperJob {
  binary: string;
  model: string;
  /** "de", "en" or "auto" */
  language: string;
  wavPath: string;
}

/** Runs a command and returns its stdout (lib/ocr/run.ts' runCommand); injectable for tests. */
export type CommandRunner = (cmd: string[], opts: { signal?: AbortSignal; timeoutMs?: number }) => Promise<string>;

export const defaultRunner: CommandRunner = (cmd, opts) => runCommand(cmd, opts);

export function buildWhisperArgs(job: WhisperJob): string[] {
  return [
    job.binary,
    "-m", job.model,
    "-l", job.language,
    "-f", job.wavPath,
    "-nt", // no timestamps: plain text, one line per segment
    "-np", // no progress / system info on stdout
    "-sns", // suppress non-speech tokens ([Musik], ♪)
  ];
}

/** Segment lines → one string; drops annotations like "[BLANK_AUDIO]" or "(Musik)". */
export function cleanTranscript(stdout: string): string {
  return stdout
    .split("\n")
    .map((line) => line.replace(/\[[^\]]*\]|^\s*\([^)]*\)\s*$/g, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function runWhisper(
  job: WhisperJob,
  { run = defaultRunner, signal, timeoutMs = 90_000 }: { run?: CommandRunner; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  return cleanTranscript(await run(buildWhisperArgs(job), { signal, timeoutMs }));
}
