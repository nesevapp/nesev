import type { Schema, Template } from "@pdfme/common";
import type { TemplateDocType } from "../documents";
import { FONT_BOLD, FONT_REGULAR } from "./plugins";
import { ITEMS_TABLE_HEAD, REMINDER_ITEMS_TABLE_HEAD } from "./variables";

// Default A4 layout (mm), loosely DIN 5008 form B: address window at 20/45 mm, info block on the right,
// content between 25 mm left and 20 mm right margin. The page padding defines where following pages
// start/end; elements inside the top/bottom margin repeat on every page (see prepareTemplate).

const PAGE = { width: 210, height: 297 };
const PADDING: [number, number, number, number] = [30, 20, 28, 25];
const LEFT = 25;
const RIGHT = 190;
const WIDTH = RIGHT - LEFT;

const TEXT = "#1f2328";
const MUTED = "#6b7280";
const RULE = "#d1d5db";
const ZERO = { top: 0, right: 0, bottom: 0, left: 0 };

type Box = { x: number; y: number; width: number; height: number };

function textSchema(name: string, box: Box, opts: Partial<Record<string, unknown>> = {}): Schema {
  return {
    name,
    type: "text",
    content: "",
    position: { x: box.x, y: box.y },
    width: box.width,
    height: box.height,
    rotate: 0,
    opacity: 1,
    alignment: "left",
    verticalAlignment: "top",
    fontSize: 9,
    lineHeight: 1.3,
    characterSpacing: 0,
    fontColor: TEXT,
    fontName: FONT_REGULAR,
    backgroundColor: "",
    textFormat: "plain",
    overflow: "visible",
    fontVariants: { bold: FONT_BOLD },
    fontVariantFallback: "synthetic",
    ...opts,
  };
}

function lineSchema(name: string, box: Box, color = RULE): Schema {
  return {
    name,
    type: "line",
    position: { x: box.x, y: box.y },
    width: box.width,
    height: box.height,
    rotate: 0,
    opacity: 1,
    color,
    readOnly: true,
  };
}

function cellStyle(overrides: Record<string, unknown> = {}) {
  return {
    fontName: FONT_REGULAR,
    alignment: "left",
    verticalAlignment: "top",
    fontSize: 8.5,
    lineHeight: 1.3,
    characterSpacing: 0,
    fontColor: TEXT,
    backgroundColor: "",
    borderColor: RULE,
    borderWidth: { top: 0, right: 0, bottom: 0.1, left: 0 },
    padding: { top: 2, right: 1.5, bottom: 2, left: 1.5 },
    ...overrides,
  };
}

const SAMPLE_ITEMS = [
  ["1", "Konzeption\nWorkshop und Konzept", "8 Std.", "€ 95,00", "20 %", "€ 760,00"],
  ["2", "Umsetzung", "1 Pauschale", "€ 2.400,00", "20 %", "€ 2.400,00"],
];

function itemsTable(y: number): Schema {
  return {
    name: "items",
    type: "table",
    position: { x: LEFT, y },
    width: WIDTH,
    height: 24,
    rotate: 0,
    opacity: 1,
    content: JSON.stringify(SAMPLE_ITEMS),
    showHead: true,
    repeatHead: true,
    head: [...ITEMS_TABLE_HEAD],
    headWidthPercentages: [7, 45, 13, 13, 8, 14],
    tableStyles: { borderColor: TEXT, borderWidth: 0 },
    headStyles: cellStyle({
      fontName: FONT_BOLD,
      fontSize: 8,
      fontColor: TEXT,
      borderColor: TEXT,
      borderWidth: { top: 0, right: 0, bottom: 0.3, left: 0 },
      padding: { top: 1.5, right: 1.5, bottom: 1.5, left: 1.5 },
    }),
    bodyStyles: { ...cellStyle(), alternateBackgroundColor: "" },
    columnStyles: { alignment: { 0: "left", 1: "left", 2: "right", 3: "right", 4: "right", 5: "right" } },
    readOnly: false,
  };
}

function totalsTable(y: number): Schema {
  return {
    name: "totals",
    type: "table",
    position: { x: 115, y },
    width: RIGHT - 115,
    height: 12,
    rotate: 0,
    opacity: 1,
    content: JSON.stringify([
      ["Summe netto", "€ 3.160,00"],
      ["USt 20 %", "€ 632,00"],
    ]),
    showHead: false,
    repeatHead: false,
    head: ["Bezeichnung", "Betrag"],
    headWidthPercentages: [60, 40],
    tableStyles: { borderColor: TEXT, borderWidth: 0 },
    headStyles: cellStyle({ borderWidth: ZERO }),
    bodyStyles: {
      ...cellStyle({ fontSize: 9, borderWidth: ZERO, padding: { top: 1, right: 1.5, bottom: 1, left: 1.5 } }),
      alternateBackgroundColor: "",
    },
    columnStyles: { alignment: { 0: "left", 1: "right" } },
    readOnly: false,
  };
}

/** Reminders list the overdue invoice instead of line items. */
function reminderItemsTable(y: number): Schema {
  return {
    ...itemsTable(y),
    name: "reminderItems",
    height: 12,
    content: JSON.stringify([["RE-2026-0001", "01.09.2026", "15.09.2026", "28", "€ 3.792,00", "€ 3.792,00"]]),
    head: [...REMINDER_ITEMS_TABLE_HEAD],
    headWidthPercentages: [22, 15, 15, 10, 19, 19],
    columnStyles: { alignment: { 0: "left", 1: "left", 2: "left", 3: "right", 4: "right", 5: "right" } },
  };
}

const DEFAULT_NAMES: Record<TemplateDocType, string> = {
  offer: "Standard – Angebot",
  invoice: "Standard – Rechnung",
  credit_note: "Standard – Gutschrift",
  reminder: "Standard – Mahnung",
};

export function defaultTemplateName(type: TemplateDocType): string {
  return DEFAULT_NAMES[type];
}

export function defaultTemplate(type: TemplateDocType): Template {
  const reminder = type === "reminder";
  // the reminder table is 12 mm shorter than the items table; everything below moves up
  const dy = reminder ? -12 : 0;
  const schemas: Schema[] = [
    // Header band (repeats on every page)
    imageSchema("logo", { x: 140, y: 10, width: 50, height: 16 }),
    svgSchema("logoSvg", { x: 140, y: 10, width: 50, height: 16 }),

    // Address window
    textSchema("sellerLine", { x: LEFT, y: 46, width: 85, height: 4 }, {
      fontSize: 6.5,
      fontColor: MUTED,
      content: "Muster GmbH · Hauptstraße 1 · 1010 Wien",
    }),
    lineSchema("sellerLineRule", { x: LEFT, y: 50.5, width: 85, height: 0.1 }),
    textSchema("recipientAddress", { x: LEFT, y: 53, width: 85, height: 30 }, {
      fontSize: 10,
      lineHeight: 1.35,
      content: "Beispiel AG\nz. Hd. Max Mustermann\nMusterweg 5\n8010 Graz",
    }),

    // Info block
    textSchema("infoLabels", { x: 120, y: 46, width: 30, height: 34 }, {
      fontSize: 8.5,
      lineHeight: 1.55,
      fontColor: MUTED,
      content: "Rechnungsnr.\nDatum\nKundennr.",
    }),
    textSchema("infoValues", { x: 146, y: 46, width: RIGHT - 146, height: 34 }, {
      fontSize: 8.5,
      lineHeight: 1.55,
      alignment: "right",
      content: "RE-2026-0001\n13.10.2026\n1001",
    }),

    // Title, subject, intro
    textSchema("heading", { x: LEFT, y: 96, width: WIDTH, height: 8 }, {
      fontSize: 15,
      fontName: FONT_BOLD,
      lineHeight: 1.1,
      content: reminder ? "1. Mahnung MA-2026-0001" : "Rechnung RE-2026-0001",
    }),
    textSchema("subject", { x: LEFT, y: 104, width: WIDTH, height: 5 }, {
      fontSize: 9.5,
      fontColor: MUTED,
      overflow: "expand",
      content: reminder ? "Rechnung RE-2026-0001 vom 01.09.2026" : "Website-Relaunch",
    }),
    textSchema("introText", { x: LEFT, y: 112, width: WIDTH, height: 5 }, {
      overflow: "expand",
      content: reminder
        ? "Für unsere Rechnung RE-2026-0001 konnten wir noch keinen Zahlungseingang feststellen."
        : "Vielen Dank für Ihren Auftrag.",
    }),

    // Items + totals
    reminder ? reminderItemsTable(121) : itemsTable(121),
    totalsTable(149 + dy),
    lineSchema("grossRule", { x: 115, y: 162.5 + dy, width: RIGHT - 115, height: 0.3 }, TEXT),
    textSchema("grossLabel", { x: 116.5, y: 164 + dy, width: 45, height: 6 }, {
      fontSize: 10,
      fontName: FONT_BOLD,
      content: reminder ? "Zu zahlen" : "Gesamtbetrag",
    }),
    textSchema("grossTotal", { x: 150, y: 164 + dy, width: RIGHT - 1.5 - 150, height: 6 }, {
      fontSize: 10,
      fontName: FONT_BOLD,
      alignment: "right",
      content: "€ 3.792,00",
    }),

    // Notes and payment
    textSchema("taxNote", { x: LEFT, y: 176 + dy, width: WIDTH, height: 4 }, { overflow: "expand", content: "" }),
    textSchema("closingText", { x: LEFT, y: 182 + dy, width: WIDTH, height: 4 }, {
      overflow: "expand",
      content: reminder
        ? "Sollten Sie die Zahlung bereits veranlasst haben, betrachten Sie dieses Schreiben bitte als gegenstandslos."
        : "Wir freuen uns auf die weitere Zusammenarbeit.",
    }),
    ...(type === "invoice" || reminder
      ? [
          textSchema("paymentInfo", { x: LEFT, y: 190 + dy, width: 120, height: 8 }, {
            overflow: "expand",
            fontSize: 8.5,
            // inline markdown (bold due date) only works for read-only texts, so the value comes in via placeholder
            textFormat: "inline-markdown",
            readOnly: true,
            content: "{paymentInfo}",
          }),
          qrSchema("epcQr", { x: 166, y: 189 + dy, width: 24, height: 24 }),
          textSchema("epcQrLabel", { x: 150, y: 213.5 + dy, width: 40, height: 3 }, {
            fontSize: 6,
            fontColor: MUTED,
            alignment: "right",
            content: "Mit Banking-App scannen",
          }),
        ]
      : []),

    // Footer band (repeats on every page)
    lineSchema("footerRule", { x: LEFT, y: 271, width: WIDTH, height: 0.1 }),
    textSchema("footerCompany", { x: LEFT, y: 273, width: 55, height: 14 }, {
      fontSize: 6.5,
      lineHeight: 1.4,
      fontColor: MUTED,
      content: "Muster GmbH\nHauptstraße 1\n1010 Wien",
    }),
    textSchema("footerContact", { x: 82, y: 273, width: 50, height: 14 }, {
      fontSize: 6.5,
      lineHeight: 1.4,
      fontColor: MUTED,
      content: "office@example.at\n+43 1 234 56 78\nwww.example.at",
    }),
    textSchema("footerBank", { x: 134, y: 273, width: RIGHT - 134, height: 14 }, {
      fontSize: 6.5,
      lineHeight: 1.4,
      fontColor: MUTED,
      alignment: "right",
      content: "IBAN AT00 0000 0000 0000 0000\nBIC XXXXATWW\nUID ATU12345678",
    }),
    textSchema("pageNumber", { x: 140, y: 290, width: RIGHT - 140, height: 4 }, {
      fontSize: 6.5,
      fontColor: MUTED,
      alignment: "right",
      readOnly: true,
      content: "Seite {currentPage} von {totalPages}",
    }),
  ];

  return {
    basePdf: { width: PAGE.width, height: PAGE.height, padding: PADDING },
    schemas: [schemas],
  };
}

function imageSchema(name: string, box: Box): Schema {
  return {
    name,
    type: "image",
    content: "",
    position: { x: box.x, y: box.y },
    width: box.width,
    height: box.height,
    rotate: 0,
    opacity: 1,
    objectFit: "contain",
    objectPosition: "right top",
  };
}

function svgSchema(name: string, box: Box): Schema {
  return {
    name,
    type: "svg",
    content: "",
    position: { x: box.x, y: box.y },
    width: box.width,
    height: box.height,
    rotate: 0,
    opacity: 1,
  };
}

function qrSchema(name: string, box: Box): Schema {
  return {
    name,
    type: "qrcode",
    content: "BCD\n002\n1\nSCT\n\nMuster GmbH\nAT000000000000000000\nEUR3792.00\n\n\nRE-2026-0001",
    position: { x: box.x, y: box.y },
    width: box.width,
    height: box.height,
    rotate: 0,
    opacity: 1,
    backgroundColor: "#ffffff",
    barColor: "#000000",
  };
}
