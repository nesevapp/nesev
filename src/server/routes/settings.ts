import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { settingsUpdateSchema } from "../../shared/schemas/settings";
import { db } from "../db";
import { ASSETS_DIR, DATA_DIR } from "../lib/paths";
import { validate } from "../lib/validate";
import { getSettings, updateSettings } from "../services/settings";

const LOGO_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/webp": "webp",
};
const MAX_LOGO_BYTES = 5 * 1024 * 1024;

async function removeLogoFile(logoPath: string | null) {
  if (logoPath) await unlink(join(DATA_DIR, logoPath)).catch(() => {});
}

const app = new Hono()
  .get("/", (c) => c.json(getSettings(db)))
  .put("/", validate("json", settingsUpdateSchema), (c) => c.json(updateSettings(db, c.req.valid("json"))))
  /** multipart/form-data, field "file" */
  .post("/logo", validate("form", z.object({ file: z.instanceof(File, { message: "Keine Datei hochgeladen" }) })), async (c) => {
    const { file } = c.req.valid("form");
    const ext = LOGO_TYPES[file.type];
    if (!ext) return c.json({ error: "Nur PNG, JPG, SVG oder WebP erlaubt" }, 400);
    if (file.size > MAX_LOGO_BYTES) return c.json({ error: "Datei ist zu groß (max. 5 MB)" }, 400);

    const name = `logo-${Date.now()}.${ext}`;
    await Bun.write(join(ASSETS_DIR, name), file);
    const previous = getSettings(db).logoPath;
    const updated = updateSettings(db, { logoPath: `assets/${name}` });
    await removeLogoFile(previous);
    return c.json(updated);
  })
  .delete("/logo", async (c) => {
    const previous = getSettings(db).logoPath;
    const updated = updateSettings(db, { logoPath: null });
    await removeLogoFile(previous);
    return c.json(updated);
  });

export default app;
