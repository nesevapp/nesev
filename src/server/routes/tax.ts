import { Hono } from "hono";
import { z } from "zod";
import { todayIso } from "../../shared/dates";
import { PERIOD_KEY_RE, parsePeriod, periodKind, previousPeriodKey } from "../../shared/tax-report";
import { db } from "../db";
import { validate } from "../lib/validate";
import { getSettings } from "../services/settings";
import { computeEar, computeUva, computeZm, earCsv, taxFileNames, uvaCsv, zmCsv } from "../services/tax";
import { parseSteuernummer, taxXmlFileNames, uvaXml, uvaXmlErrors, zmXml, zmXmlErrors } from "../services/tax-xml";

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

/** The files are ASCII only, so the encoding in their XML declaration (UVA iso-8859-1, ZM UTF-8) always holds. */
function xml(body: string, fileName: string) {
  return new Response(body, {
    headers: {
      "Content-Type": "application/xml",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}

function uvaFile(q: z.infer<typeof periodQuery>) {
  const r = computeUva(db, resolvePeriod(q.period), { euServicesIn021: q.euIn021 === "1" });
  const fastnr = parseSteuernummer(getSettings(db).taxNumber);
  return { r, fastnr, errors: uvaXmlErrors(r, fastnr, todayIso()), fileName: taxXmlFileNames.uva(r.period) };
}

function zmFile(q: z.infer<typeof periodQuery>) {
  const r = computeZm(db, resolvePeriod(q.period));
  const s = getSettings(db);
  const fastnr = parseSteuernummer(s.taxNumber);
  return { r, fastnr, errors: zmXmlErrors(r, fastnr, s.uid, todayIso()), fileName: taxXmlFileNames.zm(r.period) };
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
  /** Can the FinanzOnline file be created? `errors` explain why not (German). */
  .get("/uva/finanzonline", validate("query", periodQuery), (c) => {
    const f = uvaFile(c.req.valid("query"));
    return c.json({ errors: f.errors, fileName: f.fileName, fastnr: f.fastnr.ok ? f.fastnr.fastnr : null, warnings: f.r.warnings });
  })
  .get("/uva.xml", validate("query", periodQuery), (c) => {
    const f = uvaFile(c.req.valid("query"));
    if (f.errors.length || !f.fastnr.ok) return c.json({ error: f.errors.join(" ") }, 422);
    return xml(uvaXml(f.r, { fastnr: f.fastnr.fastnr, now: new Date() }), f.fileName);
  })
  .get("/zm", validate("query", periodQuery), (c) => c.json({ ...computeZm(db, resolvePeriod(c.req.valid("query").period)), today: todayIso() }))
  .get("/zm.csv", validate("query", periodQuery), (c) => {
    const r = computeZm(db, resolvePeriod(c.req.valid("query").period));
    return csv(zmCsv(r), taxFileNames.zm(r.period));
  })
  .get("/zm/finanzonline", validate("query", periodQuery), (c) => {
    const f = zmFile(c.req.valid("query"));
    return c.json({ errors: f.errors, fileName: f.fileName, fastnr: f.fastnr.ok ? f.fastnr.fastnr : null, warnings: f.r.warnings });
  })
  .get("/zm.xml", validate("query", periodQuery), (c) => {
    const f = zmFile(c.req.valid("query"));
    if (f.errors.length || !f.fastnr.ok) return c.json({ error: f.errors.join(" ") }, 422);
    return xml(zmXml(f.r, { fastnr: f.fastnr.fastnr, now: new Date() }), f.fileName);
  })
  .get("/ear", validate("query", yearQuery), (c) => c.json(computeEar(db, c.req.valid("query").year ?? Number(todayIso().slice(0, 4)))))
  .get("/ear.csv", validate("query", yearQuery), (c) => {
    const year = c.req.valid("query").year ?? Number(todayIso().slice(0, 4));
    return csv(earCsv(computeEar(db, year)), taxFileNames.ear(year));
  });

export default app;
