// Runs a local CLI (Swift helper, tesseract, pdftotext) with cancellation and a timeout.

export class CommandError extends Error {}

/** Raised when the user cancelled the run (AbortSignal). */
export class AbortedError extends Error {
  constructor() {
    super("Abgebrochen");
  }
}

export async function runCommand(
  cmd: string[],
  { signal, timeoutMs = 120_000 }: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  if (signal?.aborted) throw new AbortedError();
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const onAbort = () => proc.kill();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (signal?.aborted) throw new AbortedError();
    if (timedOut) throw new CommandError(`${cmd[0]?.split("/").pop()}: Zeitüberschreitung`);
    if (code !== 0) throw new CommandError(stderr.trim().split("\n").slice(-3).join(" ") || `Exit-Code ${code}`);
    return stdout;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
