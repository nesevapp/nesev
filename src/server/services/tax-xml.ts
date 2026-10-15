import type { TaxPeriod } from "../../shared/tax-report";
import type { UvaReport, ZmReport } from "./tax";

// FinanzOnline upload files ("Eingaben → Übermittlung → Datei-Upload") for the UVA (U30) and the ZM (U13).
// Structure per the BMF XML documentation for software vendors (bmf.gv.at → FinanzOnline → Informationen für
// Softwarehersteller):
// - UVA: BMF_ERKLAERUNGS_UEBERMITTLUNG_U30_07_2026.xsd (Stand 24.04.2026, valid from 07/2026; the output never
//   uses the new KZ 124/125, so it also validates against the 01/2022 schema for earlier periods).
//   Amounts with decimal point and two decimals; every KZ except 000/070 must be ≥ 0.01 (zero → omitted),
//   only 063/067/090 may be negative. FinanzOnline computes the tax columns and the Zahllast (095) itself.
// - ZM: BMF_XSD_Schema_Zusammenfassende_Meldung.xsd (Stand 14.01.2025, valid from 6.3.2025): one <ZM> line per
//   UID with SUM_BGL in whole euros (may be negative), flags DREIECK / SOLEI = "J".
// The files are a helper: the user uploads them and checks the values in FinanzOnline.

// ── Steuernummer ─────────────────────────────────────────────────────────────────

export type SteuernummerResult = { ok: true; fastnr: string } | { ok: false; error: string };

/**
 * "12 345/6789", "12-345/6789", "123456789" → "123456789" (FinanzOnline "FASTNR": 2-digit Finanzamtsnummer +
 * 7-digit Steuernummer). The check digit isn't verified (FinanzOnline does that on upload).
 */
export function parseSteuernummer(input: string): SteuernummerResult {
  const raw = input.trim().replace(/^st(euer)?\.?\s*nr\.?:?\s*/i, "");
  if (!raw) return { ok: false, error: "Keine Steuernummer hinterlegt (Einstellungen → Unternehmen)." };
  if (/[^\d\s/\-.]/.test(raw)) {
    return { ok: false, error: `Steuernummer „${input.trim()}“ enthält ungültige Zeichen — erwartet z.B. „12 345/6789“.` };
  }
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 9) {
    return {
      ok: false,
      error: `Steuernummer „${input.trim()}“ hat ${digits.length} Ziffern — FinanzOnline erwartet 9 (2 Ziffern Finanzamt + 7 Ziffern Steuernummer, z.B. „12 345/6789“).`,
    };
  }
  if (digits.startsWith("00") || Number(digits) > 989999999) {
    return { ok: false, error: `Steuernummer „${input.trim()}“: unbekannte Finanzamtsnummer „${digits.slice(0, 2)}“.` };
  }
  return { ok: true, fastnr: digits };
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

/** 123456 → "1234.56", -5 → "-0.05" */
export function xmlAmount(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Cents → whole euros, half away from zero (ZM SUM_BGL). */
export function wholeEuros(cents: number): number {
  const r = Math.round(Math.abs(cents) / 100);
  return cents < 0 ? -r : r;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** First and last month ("YYYY-MM") of a monthly or quarterly period. */
function periodMonths(p: TaxPeriod): { from: string; to: string } {
  return { from: p.from.slice(0, 7), to: p.to.slice(0, 7) };
}

/** Errors that would make FinanzOnline reject the period. `today` = "YYYY-MM-DD". */
function periodErrors(p: TaxPeriod, today: string, what: string): string[] {
  const errors: string[] = [];
  if (p.kind === "year") errors.push(`${what} gibt es nur für Monate oder Quartale, nicht für ein ganzes Jahr.`);
  if (p.to.slice(0, 7) >= today.slice(0, 7)) errors.push(`${p.label} ist noch nicht abgeschlossen — FinanzOnline nimmt die ${what} erst ab dem Folgemonat an.`);
  if (p.year < Number(today.slice(0, 4)) - 5) errors.push(`${p.label} liegt mehr als fünf Jahre zurück — FinanzOnline lässt diesen Zeitraum nicht zu.`);
  return errors;
}

export interface XmlMeta {
  fastnr: string;
  /** creation time (local) */
  now: Date;
}

function infoDaten(meta: XmlMeta): string {
  const d = meta.now;
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return [
    "\t<INFO_DATEN>",
    "\t\t<ART_IDENTIFIKATIONSBEGRIFF>FASTNR</ART_IDENTIFIKATIONSBEGRIFF>",
    `\t\t<IDENTIFIKATIONSBEGRIFF>${meta.fastnr}</IDENTIFIKATIONSBEGRIFF>`,
    "\t\t<PAKET_NR>1</PAKET_NR>",
    `\t\t<DATUM_ERSTELLUNG type="datum">${date}</DATUM_ERSTELLUNG>`,
    `\t\t<UHRZEIT_ERSTELLUNG type="uhrzeit">${time}</UHRZEIT_ERSTELLUNG>`,
    "\t\t<ANZAHL_ERKLAERUNGEN>1</ANZAHL_ERKLAERUNGEN>",
    "\t</INFO_DATEN>",
  ].join("\n");
}

function allgemeineDaten(art: "U30" | "U13", p: TaxPeriod, meta: XmlMeta): string {
  const m = periodMonths(p);
  return [
    "\t\t<ALLGEMEINE_DATEN>",
    `\t\t\t<ANBRINGEN>${art}</ANBRINGEN>`,
    `\t\t\t<ZRVON type="jahrmonat">${m.from}</ZRVON>`,
    `\t\t\t<ZRBIS type="jahrmonat">${m.to}</ZRBIS>`,
    `\t\t\t<FASTNR>${meta.fastnr}</FASTNR>`,
    `\t\t\t<KUNDENINFO>${esc(`nesev ${art === "U30" ? "UVA" : "ZM"} ${p.key}`)}</KUNDENINFO>`,
    "\t\t</ALLGEMEINE_DATEN>",
  ].join("\n");
}

// ── UVA (U30) ────────────────────────────────────────────────────────────────────

/** The U30 element tree: container → KZ in schema order (only the KZ this app can fill). */
const U30_LAYOUT = {
  LIEFERUNGEN_LEISTUNGEN_EIGENVERBRAUCH: {
    head: ["000", "021"],
    STEUERFREI: ["011", "017", "016"],
    VERSTEUERT: ["022", "029", "006", "037", "056", "057"],
  },
  INNERGEMEINSCHAFTLICHE_ERWERBE: { head: ["070", "071"], VERSTEUERT_IGE: ["072", "073", "008", "088"] },
  VORSTEUER: ["060", "061", "065", "066", "067", "090"],
} as const;

/** KZ that may be negative (type "kzvorz"); all others need ≥ 0,01 (KZ 000 also 0). */
const SIGNED_KZ = new Set(["063", "067", "090"]);

/** Plausibility checks FinanzOnline runs on upload (BMF "Prüfungen Umsatzsteuervoranmeldung ab 7/2026"). */
export function uvaXmlErrors(r: UvaReport, fastnr: SteuernummerResult, today: string): string[] {
  const errors: string[] = [];
  if (!fastnr.ok) errors.push(fastnr.error);
  errors.push(...periodErrors(r.period, today, "UVA"));
  const v = (kz: string) => r.lines.find((l) => l.kz === kz)?.amountCents ?? 0;
  for (const l of r.lines) {
    if (l.kz === "095") continue;
    if (l.amountCents < 0 && !SIGNED_KZ.has(l.kz)) errors.push(`KZ ${l.kz} ist negativ (${xmlAmount(l.amountCents)}) — FinanzOnline erlaubt hier nur positive Beträge.`);
  }
  const taxable = v("000") - v("021");
  const exempt = ["011", "016", "017"].reduce((s, k) => s + v(k), 0);
  const rated = ["022", "029", "006", "037"].reduce((s, k) => s + v(k), 0);
  if (exempt > taxable) errors.push("Die steuerfreien Umsätze (KZ 011/016/017) sind größer als KZ 000 abzüglich KZ 021.");
  else if (rated !== taxable - exempt) {
    errors.push(`KZ 022 + 029 + 006 + 037 (${xmlAmount(rated)}) ≠ KZ 000 − 021 − steuerfreie Umsätze (${xmlAmount(taxable - exempt)}) — FinanzOnline würde die Datei ablehnen.`);
  }
  if ((v("065") || v("071")) && !v("070")) errors.push("KZ 065 bzw. 071 ohne innergemeinschaftliche Erwerbe in KZ 070.");
  if (v("071") > v("070")) errors.push("KZ 071 ist größer als KZ 070.");
  const ige = ["072", "073", "008", "088"].reduce((s, k) => s + v(k), 0);
  if (ige !== v("070") - v("071")) errors.push(`KZ 072 + 073 + 008 + 088 (${xmlAmount(ige)}) ≠ KZ 070 − 071 (${xmlAmount(v("070") - v("071"))}).`);
  if (v("066") > v("057")) errors.push("KZ 066 (Vorsteuer Reverse Charge) ist größer als die Steuerschuld in KZ 057.");
  return errors;
}

/** U30 upload file. Call uvaXmlErrors first; this function doesn't validate. */
export function uvaXml(r: UvaReport, meta: XmlMeta): string {
  const values = new Map(r.lines.map((l) => [l.kz, l.amountCents]));
  const kz = (k: string, indent: string): string[] => {
    const cents = values.get(k) ?? 0;
    // KZ 000 is mandatory (0 allowed); every other KZ is left out when empty
    if (cents === 0 && k !== "000") return [];
    return [`${indent}<KZ${k} type="kz">${xmlAmount(cents)}</KZ${k}>`];
  };
  const block = (name: string, inner: string[], indent: string): string[] =>
    inner.length ? [`${indent}<${name}>`, ...inner, `${indent}</${name}>`] : [];

  const L = U30_LAYOUT;
  const lle = [
    "\t\t<LIEFERUNGEN_LEISTUNGEN_EIGENVERBRAUCH>",
    ...L.LIEFERUNGEN_LEISTUNGEN_EIGENVERBRAUCH.head.flatMap((k) => kz(k, "\t\t\t")),
    ...block("STEUERFREI", L.LIEFERUNGEN_LEISTUNGEN_EIGENVERBRAUCH.STEUERFREI.flatMap((k) => kz(k, "\t\t\t\t")), "\t\t\t"),
    ...block("VERSTEUERT", L.LIEFERUNGEN_LEISTUNGEN_EIGENVERBRAUCH.VERSTEUERT.flatMap((k) => kz(k, "\t\t\t\t")), "\t\t\t"),
    "\t\t</LIEFERUNGEN_LEISTUNGEN_EIGENVERBRAUCH>",
  ];
  const ige = block(
    "INNERGEMEINSCHAFTLICHE_ERWERBE",
    [
      ...L.INNERGEMEINSCHAFTLICHE_ERWERBE.head.flatMap((k) => kz(k, "\t\t\t")),
      ...block("VERSTEUERT_IGE", L.INNERGEMEINSCHAFTLICHE_ERWERBE.VERSTEUERT_IGE.flatMap((k) => kz(k, "\t\t\t\t")), "\t\t\t"),
    ],
    "\t\t",
  );
  const vst = block("VORSTEUER", L.VORSTEUER.flatMap((k) => kz(k, "\t\t\t")), "\t\t");

  return [
    '<?xml version="1.0" encoding="iso-8859-1"?>',
    "<ERKLAERUNGS_UEBERMITTLUNG>",
    infoDaten(meta),
    '\t<ERKLAERUNG art="U30">',
    "\t\t<SATZNR>1</SATZNR>",
    allgemeineDaten("U30", r.period, meta),
    ...lle,
    ...ige,
    ...vst,
    "\t</ERKLAERUNG>",
    "</ERKLAERUNGS_UEBERMITTLUNG>",
    "",
  ].join("\n");
}

// ── ZM (U13) ─────────────────────────────────────────────────────────────────────

const UID_RE = /^[A-Z]{2}[0-9A-Z+*]{2,13}$/;

export function zmXmlErrors(r: ZmReport, fastnr: SteuernummerResult, uid: string, today: string): string[] {
  const errors: string[] = [];
  if (!fastnr.ok) errors.push(fastnr.error);
  if (!/^ATU\d{8}$/.test(uid.replace(/\s/g, "").toUpperCase())) {
    errors.push("Für die ZM ist eine eigene österreichische UID-Nummer (ATU + 8 Ziffern) nötig — in den Einstellungen hinterlegen.");
  }
  errors.push(...periodErrors(r.period, today, "ZM"));
  if (r.rows.length === 0) errors.push("Keine Meldezeilen in diesem Zeitraum — eine leere ZM kann nicht übermittelt werden.");
  for (const row of r.rows) {
    const name = row.clientNames.join(", ");
    if (!row.uid) errors.push(`${name}: UID-Nummer fehlt.`);
    else if (row.uid.startsWith("AT")) errors.push(`${name}: österreichische UID ${row.uid} gehört nicht in die ZM.`);
    else if (!UID_RE.test(row.uid)) errors.push(`${name}: UID-Nummer „${row.uid}“ ist ungültig.`);
    if (row.triangular && row.services) errors.push(`${row.uid}: Dreiecksgeschäft und sonstige Leistung können nicht gemeinsam gemeldet werden.`);
  }
  return errors;
}

/** U13 upload file: one line per UID, Bemessungsgrundlage in whole euros. Call zmXmlErrors first. */
export function zmXml(r: ZmReport, meta: XmlMeta): string {
  const lines = r.rows.flatMap((row) => [
    "\t\t<ZM>",
    `\t\t\t<UID_MS>${esc(row.uid)}</UID_MS>`,
    `\t\t\t<SUM_BGL type="kz">${wholeEuros(row.amountCents)}</SUM_BGL>`,
    ...(row.triangular ? ["\t\t\t<DREIECK>J</DREIECK>"] : []),
    ...(row.services ? ["\t\t\t<SOLEI>J</SOLEI>"] : []),
    "\t\t</ZM>",
  ]);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<ERKLAERUNGS_UEBERMITTLUNG>",
    infoDaten(meta),
    '\t<ERKLAERUNG art="U13">',
    "\t\t<SATZNR>1</SATZNR>",
    allgemeineDaten("U13", r.period, meta),
    ...lines,
    "\t</ERKLAERUNG>",
    "</ERKLAERUNGS_UEBERMITTLUNG>",
    "",
  ].join("\n");
}

export const taxXmlFileNames = {
  uva: (p: TaxPeriod) => `uva-${p.key}-finanzonline.xml`,
  zm: (p: TaxPeriod) => `zm-${p.key}-finanzonline.xml`,
};
