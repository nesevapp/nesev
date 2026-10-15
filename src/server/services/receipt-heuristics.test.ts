import { describe, expect, test } from "bun:test";
import { observationsToText } from "../lib/ocr/layout";
import { shortDescription } from "../../shared/receipts";
import { amountsIn, extractWithRules, findCategory } from "./receipt-heuristics";
import { mapLlmOutput } from "./receipt-llm";
import { mergeFields } from "./receipt-validate";
import { checkUid, ibanValid, parseAmountCents, parseDate, uidCountry } from "./receipt-parse";

// Texts as produced by the pipeline (Apple Vision OCR after line grouping / PDF text layer).

const SUPERMARKET = `BILLA AG
Filiale 1234 Wien
Mariahilfer Str. 77
UID: ATU14697808
Milch 3,5% 11   1,49 A
Vollkornbrot   2,99 A
Bananen 1,2kg   2,15 A
Druckerpapier A4   6,99 B
Kugelschreiber 3er   3,49 B
SUMME EUR   17,11
BAR
20,00
RUECKGELD   2,89
MwSt   Netto   Steuer   Brutto
A 10%   6,03   0,60   6,63
B 20%   8,73   1,75   10,48
09.10.2026 14:32 Bon 4711
Kassa 03   Danke fuer Ihren Einkauf`;

const SAAS_IE = `Cloudhost Software Ltd.
1 Grand Canal Square, Dublin 2, D02 X576, Ireland
VAT: IE6388047V
INVOICE
Invoice number: INV-2026-0042
Invoice date: 03 Oct 2026
Due date: 17 Oct 2026
Bill to: Mustermann Consulting, Wien, Austria
VAT ATU12345675
Description Qty Amount
Pro plan (monthly) October 2026 1 49.00 EUR
Subtotal 49.00 EUR
VAT 0% (Reverse charge) 0.00 EUR
Total 49.00 EUR
Reverse charge: VAT to be accounted for by the recipient (Art. 196 Directive 2006/112/EC).`;

const SERVICE_AT = `Elektro Gruber GmbH
Hauptstraße 12, 4020 Linz
UID: ATU24681351
Tel. 0732 123456 office@elektro-gruber.at
RECHNUNG
Rechnungsnr.: R-2026/0815
Rechnungsdatum: 12.09.2026
Leistungszeitraum: 08.09.2026 - 10.09.2026
Pos Bezeichnung Menge Einzelpreis Gesamt
1 Arbeitszeit Elektriker 4 Std 85,00 340,00
2 Installationsmaterial 1 Psch 60,00 60,00
Summe netto 400,00
zzgl. 20% USt 80,00
Gesamtbetrag EUR 480,00
Zahlbar innerhalb von 14 Tagen ohne Abzug bis 26.09.2026.
Bankverbindung: Raiffeisenbank Linz IBAN: AT48 3200 0000 1234 5864 BIC: RLNWATWW`;

const RESTAURANT = `Gasthaus Zum Goldenen Hirschen
Hirschengasse 5, 1060 Wien
ATU55512341
Rechnung Nr. 2026-3381
Tisch 7   11.10.2026   20:14
2 Wiener Schnitzel   31,80
1 Tafelspitz   19,90
2 Gruener Veltliner   11,00
1 Mineral 0,51   3,90
1 Espresso   3,20
Gesamt EUR   69,80
USt   Netto   USt   Brutto
10%   46,36   4,64   51,00
20%   15,67   3,13   18,80
Bezahlt Bankomat   69,80`;

const OWN = { ownUid: "ATU12345675", ownName: "Mustermann Consulting" };

describe("parsing helpers", () => {
  test("amounts in German and English notation", () => {
    expect(parseAmountCents("1.234,56")).toBe(123456);
    expect(parseAmountCents("1,234.56")).toBe(123456);
    expect(parseAmountCents("49.00")).toBe(4900);
    expect(parseAmountCents("17,11")).toBe(1711);
    expect(parseAmountCents("€ 3,20-")).toBe(-320);
    expect(parseAmountCents("1.234")).toBe(123400);
    expect(parseAmountCents("abc")).toBeNull();
  });

  test("amountsIn skips percentages and quantities", () => {
    expect(amountsIn("Milch 3,5% 1l 1,49 A")).toEqual([149]);
    expect(amountsIn("A 10% 6,03 0,60 6,63")).toEqual([603, 60, 663]);
    expect(amountsIn("Bananen 1,2kg 2,15")).toEqual([215]);
  });

  test("dates", () => {
    expect(parseDate("12.09.2026")).toBe("2026-09-12");
    expect(parseDate("1.2.26")).toBe("2026-02-01");
    expect(parseDate("03 Oct 2026")).toBe("2026-10-03");
    expect(parseDate("3. Oktober 2026")).toBe("2026-10-03");
    expect(parseDate("October 3, 2026")).toBe("2026-10-03");
    expect(parseDate("20260921")).toBe("2026-09-21");
    expect(parseDate("31.02.2026")).toBeNull();
  });

  test("UID check digits and formats", () => {
    expect(checkUid("ATU12345675")).toBe("valid");
    expect(checkUid("ATU 2468 1351")).toBe("valid");
    expect(checkUid("ATU12345678")).toBe("invalid");
    expect(checkUid("DE246813573")).toBe("valid");
    expect(checkUid("DE246813574")).toBe("invalid");
    expect(checkUid("IE6388047V")).toBe("format_ok");
    expect(checkUid("IE63880")).toBe("invalid");
    expect(uidCountry("EL123456789")).toBe("GR");
    expect(uidCountry("IE6388047V")).toBe("IE");
  });

  test("IBAN mod-97", () => {
    expect(ibanValid("AT48 3200 0000 1234 5864")).toBe(true);
    expect(ibanValid("AT611904300234573201")).toBe(true);
    expect(ibanValid("AT611904300234573202")).toBe(false);
    expect(ibanValid("DE89370400440532013000")).toBe(true);
    expect(ibanValid("AT6119043002345732")).toBe(false); // wrong length
  });
});

describe("extractWithRules", () => {
  test("supermarket receipt with 10 % / 20 % table", () => {
    const { fields } = extractWithRules(SUPERMARKET, OWN);
    expect(fields.supplierName?.value).toBe("BILLA AG");
    expect(fields.supplierUid?.value).toBe("ATU14697808");
    expect(fields.supplierCountry?.value).toBe("AT");
    expect(fields.issueDate?.value).toBe("2026-10-09");
    expect(fields.grossCents?.value).toBe(1711);
    expect(fields.taxLines?.value).toEqual([
      { taxRateBp: 1000, netCents: 603, taxCents: 60, grossCents: 663 },
      { taxRateBp: 2000, netCents: 873, taxCents: 175, grossCents: 1048 },
    ]);
    expect(fields.vatTreatment?.value).toBe("domestic");
    expect(fields.currency?.value).toBe("EUR");
  });

  test("SaaS invoice from Ireland with reverse charge", () => {
    const { fields } = extractWithRules(SAAS_IE, OWN);
    expect(fields.supplierName?.value).toBe("Cloudhost Software Ltd.");
    // our own UID in the "Bill to" block is ignored
    expect(fields.supplierUid?.value).toBe("IE6388047V");
    expect(fields.supplierCountry?.value).toBe("IE");
    expect(fields.supplierInvoiceNumber?.value).toBe("INV-2026-0042");
    expect(fields.issueDate?.value).toBe("2026-10-03");
    expect(fields.dueDate?.value).toBe("2026-10-17");
    expect(fields.grossCents?.value).toBe(4900);
    expect(fields.taxLines?.value).toEqual([{ taxRateBp: 0, netCents: 4900, taxCents: 0, grossCents: 4900 }]);
    expect(fields.vatTreatment?.value).toBe("reverse_charge");
    expect(fields.category?.value).toBe("software_abos");
  });

  test("Austrian service invoice with 20 %", () => {
    const { fields } = extractWithRules(SERVICE_AT, OWN);
    expect(fields.supplierName?.value).toBe("Elektro Gruber GmbH");
    expect(fields.supplierUid?.value).toBe("ATU24681351");
    expect(fields.supplierInvoiceNumber?.value).toBe("R-2026/0815");
    // not the service period
    expect(fields.issueDate?.value).toBe("2026-09-12");
    expect(fields.dueDate?.value).toBe("2026-09-26");
    expect(fields.grossCents?.value).toBe(48000);
    expect(fields.taxLines?.value).toEqual([{ taxRateBp: 2000, netCents: 40000, taxCents: 8000, grossCents: 48000 }]);
    expect(fields.iban?.value).toBe("AT483200000012345864");
    expect(fields.vatTreatment?.value).toBe("domestic");
    expect(fields.category?.value).toBe("instandhaltung");
  });

  test("restaurant bill with mixed 10 / 20 %", () => {
    const { fields } = extractWithRules(RESTAURANT, OWN);
    expect(fields.supplierName?.value).toBe("Gasthaus Zum Goldenen Hirschen");
    expect(fields.supplierUid?.value).toBe("ATU55512341");
    expect(fields.supplierInvoiceNumber?.value).toBe("2026-3381");
    expect(fields.issueDate?.value).toBe("2026-10-11");
    expect(fields.grossCents?.value).toBe(6980);
    expect(fields.taxLines?.value.map((r) => [r.taxRateBp, r.netCents, r.taxCents])).toEqual([
      [1000, 4636, 464],
      [2000, 1567, 313],
    ]);
    expect(fields.category?.value).toBe("bewirtung");
  });

  test("due date from payment terms, gross derived from 'inkl. 20 % MwSt.'", () => {
    const { fields } = extractWithRules("Druckerei Huber e.U.\nRechnungsdatum 01.10.2026\nGesamtbetrag 120,00 EUR inkl. 20% MwSt.\nZahlbar innerhalb von 30 Tagen", OWN);
    expect(fields.dueDate?.value).toBe("2026-10-31");
    expect(fields.taxLines?.value).toEqual([{ taxRateBp: 2000, netCents: 10000, taxCents: 2000, grossCents: 12000 }]);
  });
});

describe("observationsToText", () => {
  test("joins label and amount on the same baseline, in reading order", () => {
    const text = observationsToText([
      { text: "17,11", confidence: 1, box: [0.57, 0.508, 0.12, 0.039] },
      { text: "SUMME EUR", confidence: 1, box: [0.06, 0.497, 0.23, 0.031] },
      { text: "BILLA AG", confidence: 1, box: [0.27, 0.047, 0.2, 0.031] },
    ]);
    expect(text).toBe("BILLA AG\nSUMME EUR   17,11");
  });
});

describe("category rules", () => {
  const cases: [string, string][] = [
    ["Elektrotechnik Huber GmbH\nElektroinstallation Büro, Austausch FI-Schalter\nArbeitszeit 2,5 Std.", "instandhaltung"],
    ["Installateur Meier\nHeizungswartung Therme, Dichtungen", "instandhaltung"],
    ["Rechnung Nr. 42\nReparatur Bürotür, Schloss getauscht", "instandhaltung"],
    ["Klimaservice Wien\nWartung Klimaanlage Büro", "instandhaltung"],
    ["Malermeister Gruber\nMalerarbeiten Besprechungsraum", "instandhaltung"],
    ["Autohaus Wiesinger\nKFZ-Werkstätte: Reparatur Bremsen, Pickerl §57a", "kfz"],
    ["Softwarewartung Jahreslizenz ERP", "software_abos"],
    ["Mustermann Steuerberatung GmbH\nJahresabschluss 2025", "beratung"],
    ["Gasthaus Zur Post\n2x Getränke", "bewirtung"],
  ];
  for (const [text, key] of cases) {
    test(`${text.split("\n")[0]} → ${key}`, () => expect(findCategory(text)?.value).toBe(key as never));
  }

  test("trade keywords override the model category unless it is very sure", () => {
    const text = "Elektro Gruber GmbH\nElektroinstallation, Störungsbehebung\nArbeitszeit 2 Std.";
    const rules = extractWithRules(text).fields;
    expect(rules.category).toMatchObject({ value: "instandhaltung", confidence: 0.7 });
    const unsure = mapLlmOutput({ category: "hardware_gwg", confidence: { category: 0.4 } });
    expect(mergeFields(unsure, rules).category?.value).toBe("instandhaltung");
    const fairlySure = mapLlmOutput({ category: "wareneinkauf", confidence: { category: 0.72 } });
    expect(mergeFields(fairlySure, rules).category?.value).toBe("instandhaltung");
    const fuel = extractWithRules("GUTMANN GMBH\nDISK TANKSTELLE\n*ZP01 EURO SUPER 10,19L 18,59*B").fields;
    expect(mergeFields(fairlySure, fuel).category?.value).toBe("kfz");
    const sure = mapLlmOutput({ category: "wareneinkauf", confidence: { category: 0.9 } });
    expect(mergeFields(sure, rules).category?.value).toBe("wareneinkauf");
    // generic keywords stay a weak hint
    expect(findCategory("Lieferung Papier und Toner")?.confidence).toBe(0.45);
  });
});

describe("shortDescription", () => {
  const cases: [string, string][] = [
    ["Hosting Oktober 2026", "Hosting Oktober 2026"],
    ["Elektroinstallationsarbeiten im Büro inkl. Material und Anfahrt laut Regiebericht", "Elektroinstallationsarbeiten im Büro inkl. Material"],
    ["Monatliches Abonnement für Google Workspace Business Starter (5 Benutzer)", "Monatliches Abonnement für Google Workspace Business"],
    ["Reparatur der Heizungsanlage. Austausch des Ventils und Entlüftung", "Reparatur der Heizungsanlage"],
    ["Beratungsleistung für die Erstellung der Steuererklärung und Beilagen", "Beratungsleistung für die Erstellung der Steuererklärung"],
    ["Wartung - Klimaanlage Büro", "Wartung - Klimaanlage Büro"],
    ["Toner,\nPapier", "Toner"],
  ];
  for (const [input, expected] of cases) {
    test(input, () => {
      const out = shortDescription(input);
      expect(out).toBe(expected);
      expect(out.length).toBeLessThanOrEqual(60);
      expect(out.split(" ").length).toBeLessThanOrEqual(6);
    });
  }

  test("model descriptions are shortened", () => {
    const fields = mapLlmOutput({ description: "Lieferung und Montage einer neuen Beleuchtung im Büro inklusive Material" });
    expect(fields.description?.value).toBe("Lieferung und Montage einer neuen Beleuchtung");
  });
});
