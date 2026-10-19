import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { settingsUpdateSchema } from "../../shared/schemas/settings";
import { db } from "../db";
import { sniffLogo, svgProblem } from "../lib/logo-file";
import { ASSETS_DIR, DATA_DIR } from "../lib/paths";
import { validate } from "../lib/validate";
import { getSettings, updateSettings } from "../services/settings";

const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const TYPE_ERROR = "Nur PNG, JPG, SVG oder WebP erlaubt";

async function removeLogoFile(logoPath: string | null) {
  if (logoPath) await unlink(join(DATA_DIR, logoPath)).catch(() => {});
}

const app = new Hono()
  .get("/", (c) => c.json(getSettings(db)))
  .put("/", validate("json", settingsUpdateSchema), (c) => c.json(updateSettings(db, c.req.valid("json"))))
  /** multipart/form-data, field "file". The file type comes from the content, not the client's MIME type; SVGs must pass svgProblem() (lib/logo-file.ts). */
  .post(
    "/logo",
    bodyLimit({ maxSize: MAX_LOGO_BYTES + 64 * 1024, onError: (c) => c.json({ error: "Datei ist zu groß (max. 5 MB)" }, 413) }),
    validate("form", z.object({ file: z.instanceof(File, { message: "Keine Datei hochgeladen" }) })),
    async (c) => {
      const { file } = c.req.valid("form");
      if (file.size > MAX_LOGO_BYTES) return c.json({ error: "Datei ist zu groß (max. 5 MB)" }, 400);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const ext = sniffLogo(bytes);
      if (!ext) return c.json({ error: TYPE_ERROR }, 400);
      if (ext === "svg") {
        const problem = svgProblem(new TextDecoder().decode(bytes));
        if (problem) return c.json({ error: `${problem} – bitte ein einfaches SVG (Formen, Pfade, Text) oder ein PNG hochladen` }, 400);
      }

      const name = `logo-${Date.now()}.${ext}`;
      await Bun.write(join(ASSETS_DIR, name), bytes);
      const previous = getSettings(db).logoPath;
      const updated = updateSettings(db, { logoPath: `assets/${name}` });
      await removeLogoFile(previous);
      return c.json(updated);
    },
  )
  .delete("/logo", async (c) => {
    const previous = getSettings(db).logoPath;
    const updated = updateSettings(db, { logoPath: null });
    await removeLogoFile(previous);
    return c.json(updated);
  });

export default app;
