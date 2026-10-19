import { mkdirSync } from "node:fs";
import { Hono } from "hono";
import { z } from "zod";
import {
  appDataDir,
  cloudSyncWarning,
  configFile,
  documentsDataDir,
  inspectDataDir,
  missingDataDir,
  resolveDataDir,
  writeConfig,
} from "../lib/data-location";
import { canPickFolder, pickFolder, revealFolder } from "../lib/folder-dialog";
import { validate } from "../lib/validate";

// First-start setup: choosing the data dir. Mounted in two places:
//  - setup mode (server/setup.ts, no data dir yet): the only API; /complete writes the config and starts the app
//  - the normal app (/api/setup): status for Einstellungen → Datenordner, reveal; /complete answers 409
// Must not import lib/paths or the DB (both resolve the data dir on import).

type CompleteHook = () => Promise<void>;
let onComplete: CompleteHook | null = null;

/** Set by server/setup.ts while the server waits for a data dir. */
export function setSetupCompleteHook(hook: CompleteHook | null) {
  onComplete = hook;
}

const pathBody = z.object({ path: z.string().max(4096) });

const app = new Hono()
  .get("/status", (c) => {
    const resolved = resolveDataDir();
    const suggestions = [
      {
        id: "app" as const,
        label: "Programmdaten (empfohlen)",
        path: appDataDir(),
        hint:
          process.platform === "darwin"
            ? "Im Benutzer-Library-Ordner, wird von Time Machine gesichert und nicht mit iCloud synchronisiert."
            : "Im Benutzerprofil, wo Programme ihre Daten ablegen; nicht cloud-synchronisiert.",
      },
      {
        id: "documents" as const,
        label: "Dokumente",
        path: documentsDataDir(),
        hint: "Leicht im Finder/Explorer zu finden.",
      },
    ].map((s) => ({ ...s, warning: cloudSyncWarning(s.path) }));
    return c.json({
      configured: resolved !== null,
      dataDir: resolved?.dir ?? null,
      /** configured folder without its database (moved, drive not connected) */
      missingDataDir: resolved ? null : missingDataDir(),
      source: resolved?.source ?? null,
      configFile: configFile(),
      platform: process.platform,
      canBrowse: canPickFolder(),
      suggestions,
    });
  })
  .post("/check", validate("json", pathBody), (c) => c.json(inspectDataDir(c.req.valid("json").path)))
  .post("/browse", async (c) => c.json({ path: await pickFolder("Ordner für die nesev-Daten wählen") }))
  .post("/complete", validate("json", pathBody), async (c) => {
    if (!onComplete) return c.json({ error: "nesev ist bereits eingerichtet." }, 409);
    const check = inspectDataDir(c.req.valid("json").path);
    if (!check.ok) return c.json({ error: check.error ?? "Ordner nicht verwendbar" }, 400);
    mkdirSync(check.path, { recursive: true });
    writeConfig({ dataDir: check.path });
    const hook = onComplete;
    onComplete = null;
    await hook();
    return c.json({ dataDir: check.path, hasData: check.hasData });
  })
  .post("/reveal", (c) => {
    const resolved = resolveDataDir();
    if (!resolved) return c.json({ error: "Noch kein Datenordner gewählt" }, 409);
    return c.json({ opened: revealFolder(resolved.dir) });
  });

export default app;
