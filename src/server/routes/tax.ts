import { Hono } from "hono";
import { z } from "zod";
import { todayIso } from "../../shared/dates";
import { PERIOD_KEY_RE, parsePeriod, periodKind, previousPeriodKey } from "../../shared/tax-report";
import { db } from "../db";
import { validate } from "../lib/validate";
import { getSettings } from "../services/settings";
import { computeEar, computeUva, computeZm, earCsv, taxFileNames, uvaCsv, zmCsv } from "../services/tax";

// Steuern: UVA (U 30), ZM and EAR. Period keys: "2026-03" (month), "2026-Q1" (quarter), "2026" (year).
// Without `period` the last completed period per settings.vatPeriod is used.

const periodQuery = z.object({
  period: z.string().regex(PERIOD_KEY_RE, "Zeitraum im Format JJJJ, JJJJ-MM oder JJJJ-Qn erwartet").optional(),
  /** "1": EU B2B services in KZ 000/021 (default: ZM only) */
  euIn021: z.enum(["0", "1"]).optional(),
});
const yearQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });

function resolvePeriod(key: string | undefined) {
  const k = key ?? previousPeriodKey(todayIso(), periodKind(getSettings(db).vatPeriod));
  return parsePeriod(k)!;
}

function csv(body: string, fileName: string) {
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}

const app = new Hono()
  .get("/uva", validate("query", periodQuery), (c) => {
    const q = c.req.valid("query");
    return c.json({ ...computeUva(db, resolvePeriod(q.period), { euServicesIn021: q.euIn021 === "1" }), today: todayIso() });
  })
  .get("/uva.csv", validate("query", periodQuery), (c) => {
    const q = c.req.valid("query");
    const r = computeUva(db, resolvePeriod(q.period), { euServicesIn021: q.euIn021 === "1" });
    return csv(uvaCsv(r), taxFileNames.uva(r.period));
  })
  .get("/zm", validate("query", periodQuery), (c) => c.json({ ...computeZm(db, resolvePeriod(c.req.valid("query").period)), today: todayIso() }))
  .get("/zm.csv", validate("query", periodQuery), (c) => {
    const r = computeZm(db, resolvePeriod(c.req.valid("query").period));
    return csv(zmCsv(r), taxFileNames.zm(r.period));
  })
  .get("/ear", validate("query", yearQuery), (c) => c.json(computeEar(db, c.req.valid("query").year ?? Number(todayIso().slice(0, 4)))))
  .get("/ear.csv", validate("query", yearQuery), (c) => {
    const year = c.req.valid("query").year ?? Number(todayIso().slice(0, 4));
    return csv(earCsv(computeEar(db, year)), taxFileNames.ear(year));
  });

export default app;
