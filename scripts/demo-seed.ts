import { join, resolve } from "node:path";
import { PDFDocument, StandardFonts, rgb } from "@pdfme/pdf-lib";
import { addDays, todayIso } from "../src/shared/dates";
import { formatCents } from "../src/shared/money";
import type { TaxMode } from "../src/shared/tax";
import { DATA_DIR, PROJECT_ROOT } from "../src/server/lib/paths";
import { api, call, idParam } from "../src/mcp/api";
import { type SeedCompany, seed } from "../src/mcp/test/seed";

// Demo data for `bun run demo` (scripts/demo.ts runs this with NESEV_DATA_DIR=demo-data):
//   NESEV_DATA_DIR=/tmp/nesev-demo bun scripts/demo-seed.ts
// The MCP/eval seed (src/mcp/test/seed.ts) with a fictional sole trader as seller, plus half a year of history
// around it, so every page has something to show: paid invoices matched to bank payments, open and overdue
// invoices, a reminder, offers (open/accepted/declined), expenses with receipt PDFs, recurring invoices.
// Every person, company, address and IBAN is made up (IBANs with valid checksums on the unused bank code 99999,
// e-mails on the reserved .example domain). Dates are relative to today. Refuses the default data dir.

export const DEMO_COMPANY: SeedCompany = {
  companyName: "Pixelweide Webstudio e.U.",
  ownerName: "Lena Beispiel",
  street: "Lindengasse 12",
  zip: "8020",
  city: "Graz",
  country: "AT",
  uid: "ATU12345678",
  email: "hallo@pixelweide.example",
  website: "pixelweide.example",
  iban: "AT47 9999 9000 1234 5678",
  bic: "DEMOATW1",
  bankName: "Demobank",
};

const line = (title: string, quantity: number, unitPriceCents: number, unit = "Std.", taxRateBp = 2000) => ({
  title,
  quantity: Math.round(quantity * 1000),
  unitPriceCents,
  taxRateBp,
  unit,
});
type Line = ReturnType<typeof line>;

/** a simple one-page receipt PDF, so the demo has real attachments to look at */
async function receiptPdf(r: { supplier: string; address: string; number: string; date: string; lines: [string, number][]; taxRateBp: number }) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([420, 595]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const grey = rgb(0.4, 0.4, 0.4);
  let y = 540;
  const text = (s: string, x: number, opts: { size?: number; f?: typeof font; color?: typeof grey; right?: boolean } = {}) => {
    const f = opts.f ?? font;
    const size = opts.size ?? 10;
    page.drawText(s, { x: opts.right ? x - f.widthOfTextAtSize(s, size) : x, y, size, font: f, color: opts.color ?? rgb(0, 0, 0) });
  };
  text(r.supplier, 40, { size: 16, f: bold });
  y -= 18;
  text(r.address, 40, { color: grey });
  y -= 40;
  text(`Rechnung ${r.number}`, 40, { size: 12, f: bold });
  text(r.date.split("-").reverse().join("."), 380, { right: true });
  y -= 30;
  let net = 0;
  for (const [title, cents] of r.lines) {
    text(title, 40);
    text(formatCents(cents), 380, { right: true });
    net += cents;
    y -= 18;
  }
  const tax = Math.round((net * r.taxRateBp) / 10000);
  y -= 12;
  page.drawLine({ start: { x: 40, y: y + 10 }, end: { x: 380, y: y + 10 }, thickness: 0.5, color: grey });
  for (const [label, cents, f] of [["Netto", net, font], [`USt ${r.taxRateBp / 100} %`, tax, font], ["Gesamt", net + tax, bold]] as const) {
    text(label, 220, { f });
    text(formatCents(cents), 380, { right: true, f });
    y -= 16;
  }
  y -= 30;
  text("Vielen Dank für Ihren Auftrag!", 40, { color: grey, size: 9 });
  return new File([await pdf.save()], `Rechnung-${r.number}.pdf`, { type: "application/pdf" });
}

export async function seedDemo() {
  const today = todayIso();
  const d = (days: number) => addDays(today, days);

  // the seller first, so the history below is finalized with its snapshot
  const settings = await call(api.settings.index.$get());
  await call(api.settings.index.$put({ json: { ...settings, ...DEMO_COMPANY, vatBasis: "accrual", vatPeriod: "monthly" } }));

  const client = (json: { type: "company" | "person"; name: string; street: string; zip: string; city: string; country: string; email: string; contactPerson?: string }) =>
    call(api.clients.index.$post({ json }));
  const cafe = await client({ type: "company", name: "Café Lindenblatt OG", contactPerson: "Mira Lindner", street: "Lindengasse 4", zip: "8020", city: "Graz", country: "AT", email: "office@lindenblatt.example" });
  const outdoor = await client({ type: "company", name: "Bergsteig Outdoor GmbH", contactPerson: "Tobias Steiner", street: "Talweg 8", zip: "6020", city: "Innsbruck", country: "AT", email: "einkauf@bergsteig.example" });
  const verein = await client({ type: "company", name: "Kulturverein Murufer", street: "Uferweg 2", zip: "8010", city: "Graz", country: "AT", email: "vorstand@murufer.example" });
  const seeblick = await client({ type: "company", name: "Seeblick Reisen AG", street: "Seestrasse 44", zip: "8002", city: "Zürich", country: "CH", email: "it@seeblick.example" });
  const jonas = await client({ type: "person", name: "Jonas Beispiel", street: "Kirchengasse 9/3", zip: "1070", city: "Wien", country: "AT", email: "jonas@beispiel.example" });

  type DocOpts = { title: string; issueDate: string; items: Line[]; dueDate?: string; taxMode?: TaxMode };
  const finalized = async (type: "invoice" | "offer", clientId: number, o: DocOpts) => {
    const doc = await call(api.documents.index.$post({ json: { type, clientId, ...o } }));
    return call(api.documents[":id"].finalize.$post({ param: idParam(doc.id) }));
  };
  const status = (id: number, action: "sent" | "accepted" | "declined") => call(api.documents[":id"].status.$post({ param: idParam(id), json: { action } }));

  // ── history (older than the base seed, so the numbers follow the dates) ──────────────────────────
  const offerShop = await finalized("offer", outdoor.id, { title: "Online-Shop", issueDate: d(-160), items: [line("Shop-Setup und Theme", 30, 9500), line("Produktimport", 1, 85000, "pausch.")] });
  await status(offerShop.id, "sent");
  await status(offerShop.id, "accepted");

  // [invoice, payment date] – paid via the bank import below
  const paid: [Awaited<ReturnType<typeof finalized>>, string][] = [];
  const invoice = async (clientId: number, o: DocOpts, paidAt?: string) => {
    const doc = await finalized("invoice", clientId, o);
    await status(doc.id, "sent");
    if (paidAt) paid.push([doc, paidAt]);
    return doc;
  };
  await invoice(cafe.id, { title: "Website Konzeption & Design", issueDate: d(-172), items: [line("Konzept und Wireframes", 8, 9500), line("Design (Desktop + Mobil)", 16, 9500)] }, d(-160));
  await invoice(outdoor.id, { title: "Online-Shop – Phase 1", issueDate: d(-150), items: [line("Shop-Setup und Theme", 30, 9500), line("Produktimport", 1, 85000, "pausch.")] }, d(-139));
  await invoice(verein.id, { title: "Veranstaltungskalender", issueDate: d(-128), items: [line("Entwicklung Kalendermodul", 14, 8500)] }, d(-108));
  await invoice(jonas.id, { title: "Portfolio-Website", issueDate: d(-112), items: [line("Portfolio-Website (Pauschale)", 1, 120000, "pausch.")] }, d(-104));
  const offerBooking = await finalized("offer", seeblick.id, { title: "Buchungsstrecke", issueDate: d(-100), taxMode: "THIRD_COUNTRY", items: [line("Buchungsstrecke mit Zahlungsanbindung", 22, 11000, "Std.", 0)] });
  await status(offerBooking.id, "accepted");
  await invoice(cafe.id, { title: "Wartung & Hosting Q2", issueDate: d(-95), items: [line("Wartung", 3, 9500), line("Hosting", 3, 2400, "Monat")] }, d(-88));
  await invoice(outdoor.id, { title: "Online-Shop – Phase 2", issueDate: d(-80), items: [line("Filter, Merkliste, Gutscheine", 28, 9500)] }, d(-70));
  await invoice(seeblick.id, { title: "Buchungsstrecke", issueDate: d(-66), taxMode: "THIRD_COUNTRY", items: [line("Buchungsstrecke mit Zahlungsanbindung", 22, 11000, "Std.", 0)] }, d(-52));
  const offerReservation = await finalized("offer", cafe.id, { title: "Reservierungssystem", issueDate: d(-58), items: [line("Online-Reservierung", 18, 9500)] });
  await status(offerReservation.id, "declined");
  const overdue = await invoice(verein.id, { title: "Website-Update & Plakat", issueDate: d(-52), dueDate: d(-38), items: [line("Website-Update", 6, 8500), line("Plakatgestaltung A2", 1, 32000, "pausch.")] });

  const expense = (json: Parameters<typeof api.expenses.index.$post>[0]["json"]) => call(api.expenses.index.$post({ json }));
  const exp = (supplierName: string, issueDate: string, description: string, category: string, netCents: number, taxRateBp = 2000, extra: Record<string, unknown> = {}) =>
    expense({
      supplierName,
      supplierCountry: "AT",
      issueDate,
      vatTreatment: "domestic",
      description,
      lines: [{ category: category as never, description, netCents, taxRateBp, taxCents: Math.round((netCents * taxRateBp) / 10000) }],
      ...extra,
    });
  // [expense, payment date] – paid via the bank import below
  const paidExpenses: [Awaited<ReturnType<typeof exp>>, string][] = [];
  const hosting1 = await exp("Serverhaus Nord GmbH", d(-165), "Server-Hosting Halbjahr", "software_abos", 14400, 2000, { supplierInvoiceNumber: "SN-24817" });
  paidExpenses.push([hosting1, d(-163)]);
  const paper = await exp("Papierwerk Graz KG", d(-148), "Druckerpapier, Notizbücher, Toner", "buero", 8740, 2000, { supplierInvoiceNumber: "PW-1093" });
  paidExpenses.push([paper, d(-148)]);
  await call(
    api.expenses[":id"].attachment.$post({
      param: idParam(paper.id),
      form: { file: await receiptPdf({ supplier: "Papierwerk Graz KG", address: "Kornmarkt 3, 8010 Graz", number: "PW-1093", date: d(-148), taxRateBp: 2000, lines: [["Druckerpapier A4, 5×500 Blatt", 2490], ["Notizbücher (3 Stk.)", 1950], ["Toner schwarz", 4300]] }) },
    }),
  );
  const monitor = await exp("Elektro Lindner e.U.", d(-131), "Monitor 27 Zoll", "hardware_gwg", 34900, 2000, { supplierInvoiceNumber: "EL-2025-311" });
  paidExpenses.push([monitor, d(-130)]);
  const course = await exp("Codeschmiede Akademie GmbH", d(-96), "Workshop Barrierefreiheit im Web", "fortbildung", 49000, 2000, { supplierInvoiceNumber: "CA-0457" });
  paidExpenses.push([course, d(-90)]);
  await call(
    api.expenses[":id"].attachment.$post({
      param: idParam(course.id),
      form: { file: await receiptPdf({ supplier: "Codeschmiede Akademie GmbH", address: "Lernweg 1, 4020 Linz", number: "CA-0457", date: d(-96), taxRateBp: 2000, lines: [["Workshop Barrierefreiheit im Web (2 Tage)", 45000], ["Seminarunterlagen", 4000]] }) },
    }),
  );
  const lunch = await exp("Gasthaus Zur Linde", d(-61), "Geschäftsessen Bergsteig Outdoor", "bewirtung", 7860, 1000);
  paidExpenses.push([lunch, d(-61)]);
  const svs = await expense({ supplierName: "Sozialversicherung der Selbständigen", supplierCountry: "AT", issueDate: d(-45), vatTreatment: "domestic", description: "SVS-Beiträge Quartal", lines: [{ category: "svs", description: "SVS-Beiträge Quartal", netCents: 98250, taxRateBp: 0, taxCents: 0 }] });
  paidExpenses.push([svs, d(-40)]);
  const hosting2 = await exp("Serverhaus Nord GmbH", d(-15), "Server-Hosting Halbjahr", "software_abos", 14400, 2000, { supplierInvoiceNumber: "SN-26102" });

  // ── the MCP/eval seed with the demo company ─────────────────────────────────────────────────────
  const ids = await seed(DEMO_COMPANY);

  // ── recent: open invoices, the reminder, offers sent, another recurring invoice ─────────────────
  await invoice(outdoor.id, { title: "Online-Shop – Phase 3", issueDate: d(-12), items: [line("Anbindung Warenwirtschaft", 16, 9500), line("Tests und Go-live", 6, 9500)] });
  await invoice(cafe.id, { title: "Newsletter-Vorlage", issueDate: d(-6), items: [line("Newsletter-Vorlage (responsive)", 5, 9500)] });
  await status(ids.documents.offer, "sent");
  await finalized("offer", verein.id, { title: "Mitgliederbereich", issueDate: d(-1), items: [line("Login und Mitgliederverwaltung", 20, 8500)] });

  const reminder = await call(api.reminders.index.$post({ json: { invoiceId: overdue.id, issueDate: d(-7) } }));
  await call(api.reminders[":id"].finalize.$post({ param: idParam(reminder.id) }));
  await call(api.reminders[":id"].sent.$post({ param: idParam(reminder.id) }));

  await call(
    api.recurring.index.$post({
      json: {
        name: "Wartung Lindenblatt",
        clientId: cafe.id,
        active: true,
        intervalUnit: "month",
        intervalCount: 3,
        startDate: d(20),
        endDate: null,
        setServicePeriod: true,
        autoFinalize: false,
        taxMode: "AT_DOMESTIC",
        title: "Wartung & Hosting",
        introText: "",
        closingText: "",
        templateId: null,
        items: [line("Wartung", 3, 9500), line("Hosting", 3, 2400, "Monat")],
      },
    }),
  );

  // ── bank: payments of the history, matched; plus a few open lines ───────────────────────────────
  const csvAmount = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");
  const payers: Record<number, [string, string]> = {
    [cafe.id]: ["Café Lindenblatt OG", "AT869999900087654321"],
    [outdoor.id]: ["Bergsteig Outdoor GmbH", "AT799999900055500111"],
    [verein.id]: ["Kulturverein Murufer", "AT129999900031415926"],
    [seeblick.id]: ["Seeblick Reisen AG", "CH8399999000123456789"],
    [jonas.id]: ["Jonas Beispiel", "DE39999999990012345678"],
  };
  const rows = [
    ...paid.map(([doc, date]) => {
      const [name, iban] = payers[doc.clientId!]!;
      return `${date};${csvAmount(doc.grossCents)};${name};${iban};${doc.number}`;
    }),
    ...paidExpenses.map(([e, date]) => `${date};-${csvAmount(e.grossCents)};${e.supplierName};;${e.supplierInvoiceNumber || e.description}`),
    `${d(-31)};-12,90;Demobank;;Kontoführung`,
    `${d(-1)};-12,90;Demobank;;Kontoführung`,
    `${d(-9)};-23,40;Tankstelle Süd;;Kartenzahlung`,
  ];
  const mapping = { delimiter: ";", encoding: "utf-8", hasHeader: true, decimal: ",", dateFormat: "YYYY-MM-DD", bookingDate: 0, amount: 1, counterpartyName: [2], counterpartyIban: 3, purpose: [4] };
  await call(
    api.bank.accounts[":id"].import.$post({
      param: idParam(ids.bank.account),
      form: { file: new File([["Datum;Betrag;Name;IBAN;Zweck", ...rows].join("\n")], "umsaetze-demo.csv", { type: "text/csv" }), mapping: JSON.stringify(mapping) },
    }),
  );
  const txs = await call(api.bank.transactions.$get({ query: { accountId: String(ids.bank.account) } }));
  const tx = (date: string, cents: number) => txs.find((t) => t.bookingDate === date && t.amountCents === cents)!;
  for (const [doc, date] of paid) {
    await call(api.bank.transactions[":id"].match.$post({ param: idParam(tx(date, doc.grossCents).id), json: { allocations: [{ documentId: doc.id, amountCents: doc.grossCents }] } }));
  }
  for (const [e, date] of paidExpenses) {
    await call(api.bank.transactions[":id"].match.$post({ param: idParam(tx(date, -e.grossCents).id), json: { allocations: [{ expenseId: e.id, amountCents: e.grossCents }] } }));
  }
  await call(api.bank.transactions[":id"].ignore.$post({ param: idParam(tx(d(-9), -2340).id) }));

  return { ...ids, demo: { clients: { cafe: cafe.id, outdoor: outdoor.id, verein: verein.id, seeblick: seeblick.id, jonas: jonas.id }, overdueInvoice: overdue.id, reminder: reminder.id, openExpense: hosting2.id } };
}

if (import.meta.main) {
  if (resolve(DATA_DIR) === resolve(join(PROJECT_ROOT, "data"))) {
    console.error("Refusing to seed the default data dir. Set NESEV_DATA_DIR to a temp dir.");
    process.exit(1);
  }
  const ids = await seedDemo();
  process.stdout.write(`${JSON.stringify(ids)}\n`);
}
