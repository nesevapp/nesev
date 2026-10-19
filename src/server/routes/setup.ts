import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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
import { RestoreError, restoreIntoEmptyDir } from "../services/restore";

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
const completeBody = pathBody.extend({ updateCheck: z.boolean().optional() });

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
  .post("/complete", validate("json", completeBody), async (c) => {
    if (!onComplete) return c.json({ error: "nesev ist bereits eingerichtet." }, 409);
    const { path, updateCheck } = c.req.valid("json");
    const check = inspectDataDir(path);
    if (!check.ok) return c.json({ error: check.error ?? "Ordner nicht verwendbar" }, 400);
    mkdirSync(check.path, { recursive: true });
    // an empty nesev.db marks the folder as nesev's before the config points at it: resolveDataDir() treats a configured
    // folder without one as moved/missing. SQLite opens a 0-byte file as a new database (migrations fill it).
    if (!check.hasData) closeSync(openSync(join(check.path, "nesev.db"), "a"));
    writeConfig({ dataDir: check.path, ...(updateCheck === undefined ? {} : { updateCheck }) });
    const hook = onComplete;
    onComplete = null;
    await hook();
    return c.json({ dataDir: check.path, hasData: check.hasData });
  })
  /**
   * multipart: "path" (the chosen data folder, new or empty) + "file" (backup ZIP or nesev .db). Restores the backup
   * there, then completes the setup like /complete. For moving to a new computer.
   */
  .post(
    "/restore",
    bodyLimit({ maxSize: 4 * 1024 ** 3, onError: (c) => c.json({ error: "Datei ist zu groß (max. 4 GB)" }, 413) }),
    validate(
      "form",
      z.object({
        path: z.string().max(4096),
        file: z.instanceof(File, { message: "Keine Datei hochgeladen" }),
        updateCheck: z.enum(["0", "1"]).optional(),
      }),
    ),
    async (c) => {
      if (!onComplete) return c.json({ error: "nesev ist bereits eingerichtet." }, 409);
      const { path, file, updateCheck } = c.req.valid("form");
      const check = inspectDataDir(path);
      if (!check.ok) return c.json({ error: check.error ?? "Ordner nicht verwendbar" }, 400);
      if (check.hasData) return c.json({ error: "In diesem Ordner liegen bereits nesev-Daten. Für ein Backup bitte einen neuen oder leeren Ordner wählen." }, 400);
      let summary;
      try {
        mkdirSync(check.path, { recursive: true });
        summary = restoreIntoEmptyDir(check.path, new Uint8Array(await file.arrayBuffer()));
      } catch (err) {
        if (err instanceof RestoreError) return c.json({ error: err.message }, 422);
        throw err;
      }
      writeConfig({ dataDir: check.path, ...(updateCheck === undefined ? {} : { updateCheck: updateCheck === "1" }) });
      const hook = onComplete;
      onComplete = null;
      await hook();
      return c.json({ dataDir: check.path, summary });
    },
  )
  .post("/reveal", (c) => {
    const resolved = resolveDataDir();
    if (!resolved) return c.json({ error: "Noch kein Datenordner gewählt" }, 409);
    return c.json({ opened: revealFolder(resolved.dir) });
  });

export default app;
