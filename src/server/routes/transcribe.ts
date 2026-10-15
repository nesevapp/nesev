import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { VOICE_MAX_BYTES, VOICE_MAX_SECONDS, voiceSettingsSchema } from "../../shared/voice";
import { db } from "../db";
import { discoverWhisperModels } from "../lib/whisper/paths";
import { validate } from "../lib/validate";
import { getVoiceSettings, transcribe, updateVoiceSettings, VoiceError, voiceStatus } from "../services/voice";

// Voice input for the assistant (contract in src/shared/voice.ts). POST / takes the raw WAV body.

const app = new Hono()
  .post(
    "/",
    bodyLimit({
      maxSize: VOICE_MAX_BYTES,
      onError: (c) => c.json({ error: `Aufnahme zu lang (höchstens ${VOICE_MAX_SECONDS / 60} Minuten)` }, 413),
    }),
    async (c) => {
      const wav = new Uint8Array(await c.req.arrayBuffer());
      try {
        return c.json(await transcribe(db, wav, { signal: c.req.raw.signal }));
      } catch (err) {
        if (err instanceof VoiceError) return c.json({ error: err.message }, err.status as ContentfulStatusCode);
        throw err;
      }
    },
  )
  .get("/status", (c) => c.json(voiceStatus(db)))
  .get("/models", (c) => c.json(discoverWhisperModels()))
  .get("/settings", (c) => c.json(getVoiceSettings(db)))
  .put("/settings", validate("json", voiceSettingsSchema), (c) => c.json(updateVoiceSettings(db, c.req.valid("json"))));

export default app;
