import { join, resolve } from "node:path";
import { addDays, todayIso } from "../../shared/dates";
import { DATA_DIR, PROJECT_ROOT } from "../../server/lib/paths";
import { api, call, idParam } from "../api";

// Demo data for the MCP tests and for trying the server by hand, created through nesev's own API (in-process):
//   NESEV_DATA_DIR=/tmp/nesev-mcp bun src/mcp/test/seed.ts
// Refuses to run against the default data dir (your real data). Dates are relative to today, so the first
// invoice is always overdue. Prints the created ids as JSON on stdout.
// `bun run demo` (scripts/demo-seed.ts) builds on this with its own company and more history.

/** the seller: settings fields; `iban`/`bankName` also name the seeded bank account */
export interface SeedCompany {
  companyName: string;
  ownerName: string;
  street: string;
  zip: string;
  city: string;
  country: string;
  uid: string;
  email: string;
  iban: string;
  bic: string;
  bankName: string;
  phone?: string;
  website?: string;
}

export const TEST_COMPANY: SeedCompany = {
  companyName: "Muster IT e.U.",
  ownerName: "Max Muster",
  street: "Hauptstraße 1",
  zip: "1010",
  city: "Wien",
  country: "AT",
  uid: "ATU12345678",
  email: "office@muster.at",
  iban: "AT61 1904 3002 3457 3201",
  bic: "BKAUATWW",
  bankName: "Testbank",
};

export async function seed(company: SeedCompany = TEST_COMPANY) {
  const today = todayIso();
  const year = Number(today.slice(0, 4));

  const settings = await call(api.settings.index.$get());
  await call(api.settings.index.$put({ json: { ...settings, ...company, vatBasis: "accrual", vatPeriod: "monthly" } }));

  const alpen = await call(
    api.clients.index.$post({
      json: { type: "company", name: "Alpen Software GmbH", street: "Ringstraße 5", zip: "1010", city: "Wien", country: "AT", email: "buchhaltung@alpen.at" },
    }),
  );
  const berlin = await call(
    api.clients.index.$post({
      json: { type: "company", name: "Berlin Digital GmbH", street: "Torstraße 10", zip: "10119", city: "Berlin", country: "DE", uid: "DE123456789" },
    }),
  );

  const article = await call(
    api.articles.index.$post({ json: { title: "Webentwicklung", unit: "Std.", unitPriceCents: 9500, taxRateBp: 2000 } }),
  );

  const line = (title: string, quantity: number, unitPriceCents: number, taxRateBp = 2000, unit = "Std.") => ({
    title,
    quantity: quantity * 1000,
    unitPriceCents,
    taxRateBp,
    unit,
  });

  // overdue invoice with a partial credit note: gross 1.284,00 − 144,00 = open 1.140,00
  const inv1 = await call(
    api.documents.index.$post({
      json: {
        type: "invoice",
        clientId: alpen.id,
        issueDate: addDays(today, -45),
        dueDate: addDays(today, -31),
        title: "Website-Relaunch",
        items: [{ ...line("Webentwicklung", 10, 9500), articleId: article.id }, line("Hosting", 1, 12000, 2000, "Monat")],
      },
    }),
  );
  await call(api.documents[":id"].finalize.$post({ param: idParam(inv1.id) }));
  const cn = await call(api.documents[":id"]["credit-note"].$post({ param: idParam(inv1.id) }));
  await call(api.documents[":id"].$put({ param: idParam(cn.id), json: { items: [line("Hosting (Gutschrift)", 1, 12000, 2000, "Monat")] } }));
  await call(api.documents[":id"].finalize.$post({ param: idParam(cn.id) }));

  // paid reverse-charge invoice to a German client
  const inv2 = await call(
    api.documents.index.$post({
      json: { type: "invoice", clientId: berlin.id, issueDate: addDays(today, -20), title: "API-Integration", taxMode: "EU_REVERSE_CHARGE", items: [line("Entwicklung", 8, 9500, 0)] },
    }),
  );
  await call(api.documents[":id"].finalize.$post({ param: idParam(inv2.id) }));
  await call(api.documents[":id"].status.$post({ param: idParam(inv2.id), json: { action: "paid", paidAt: addDays(today, -5) } }));

  const draft = await call(
    api.documents.index.$post({ json: { type: "invoice", clientId: alpen.id, issueDate: today, title: "Wartung", items: [line("Wartung", 2, 9500)] } }),
  );
  const offer = await call(
    api.documents.index.$post({ json: { type: "offer", clientId: alpen.id, issueDate: addDays(today, -3), title: "Shop-Erweiterung", items: [line("Konzept", 6, 9500)] } }),
  );
  await call(api.documents[":id"].finalize.$post({ param: idParam(offer.id) }));

  const telekom = await call(
    api.expenses.index.$post({
      json: {
        supplierName: "A1 Telekom Austria AG",
        supplierCountry: "AT",
        issueDate: addDays(today, -10),
        paidAt: addDays(today, -8),
        vatTreatment: "domestic",
        description: "Internet",
        lines: [{ category: "telefon_internet", description: "Internet", netCents: 5000, taxRateBp: 2000, taxCents: 1000 }],
      },
    }),
  );
  const adobe = await call(
    api.expenses.index.$post({
      json: {
        supplierName: "Adobe Systems Software Ireland Ltd",
        supplierCountry: "IE",
        supplierUid: "IE6364992H",
        issueDate: addDays(today, -4),
        dueDate: addDays(today, 10),
        vatTreatment: "reverse_charge",
        description: "Creative Cloud",
        lines: [{ category: "software_abos", description: "Creative Cloud", netCents: 6000, taxRateBp: 2000, taxCents: 1200 }],
      },
    }),
  );
  const incomplete = await call(api.expenses.index.$post({ json: { supplierName: "", issueDate: today } }));

  const rent = await call(
    api.recurringExpenses.index.$post({
      json: {
        name: "Büromiete",
        supplierName: "Hausverwaltung Wien",
        category: "miete",
        active: true,
        intervalUnit: "month",
        intervalCount: 1,
        startDate: `${year}-01-01`,
        endDate: null,
        grossCents: 60000,
        taxCents: 10000,
        notes: "",
      },
    }),
  );
  const asset = await call(
    api.assets.index.$post({
      json: { name: "MacBook Pro", acquisitionDate: `${year}-02-10`, inServiceDate: `${year}-02-12`, costCents: 240000, usefulLifeYears: 3 },
    }),
  );

  // ── bank + recurring (tools/bank.ts, tools/recurring.ts) ──────────────────────
  // One account without auto-matching, so nothing is allocated yet: payment of the overdue invoice (number + open
  // amount), the Adobe expense (amount + name), a private card payment (to ignore). Plus a monthly recurring invoice.
  const bankAccount = await call(api.bank.accounts.$post({ json: { name: "Geschäftskonto", iban: company.iban, bankName: company.bankName, autoMatch: "off" } }));
  const inv1Number = (await call(api.documents[":id"].$get({ param: idParam(inv1.id) }))).number;
  const csv = [
    "Datum;Betrag;Name;IBAN;Zweck",
    `${addDays(today, -2)};1140,00;Alpen Software GmbH;AT483200000012345864;Rechnung ${inv1Number}`,
    `${addDays(today, -3)};-60,00;Adobe Systems Software Ireland;IE29AIBK93115212345678;Creative Cloud`,
    `${addDays(today, -6)};-12,34;BILLA DANKT 1234;;Kartenzahlung`,
  ].join("\n");
  const mapping = { delimiter: ";", encoding: "utf-8", hasHeader: true, decimal: ",", dateFormat: "YYYY-MM-DD", bookingDate: 0, amount: 1, counterpartyName: [2], counterpartyIban: 3, purpose: [4] };
  await call(
    api.bank.accounts[":id"].import.$post({
      param: idParam(bankAccount.id),
      form: { file: new File([csv], "umsaetze.csv", { type: "text/csv" }), mapping: JSON.stringify(mapping) },
    }),
  );
  const txs = await call(api.bank.transactions.$get({ query: { accountId: String(bankAccount.id) } }));
  const txId = (name: string) => txs.find((t) => t.counterpartyName.startsWith(name))!.id;

  const hosting = await call(
    api.recurring.index.$post({
      json: {
        name: "Hosting Alpen",
        clientId: alpen.id,
        active: true,
        intervalUnit: "month",
        intervalCount: 1,
        startDate: addDays(today, 5),
        endDate: null,
        setServicePeriod: true,
        autoFinalize: false,
        taxMode: "AT_DOMESTIC",
        title: "Hosting",
        introText: "",
        closingText: "",
        templateId: null,
        items: [line("Hosting", 1, 12000, 2000, "Monat")],
      },
    }),
  );

  return {
    clients: { alpen: alpen.id, berlin: berlin.id },
    article: article.id,
    documents: { overdueInvoice: inv1.id, creditNote: cn.id, paidInvoice: inv2.id, draftInvoice: draft.id, offer: offer.id },
    expenses: { telekom: telekom.id, adobe: adobe.id, incomplete: incomplete.id },
    fixedCost: rent.id,
    asset: asset.id,
    bank: { account: bankAccount.id, alpenPayment: txId("Alpen"), adobePayment: txId("Adobe"), billa: txId("BILLA") },
    recurring: { hosting: hosting.id },
  };
}

export type SeedIds = Awaited<ReturnType<typeof seed>>;

if (import.meta.main) {
  if (resolve(DATA_DIR) === resolve(join(PROJECT_ROOT, "data"))) {
    console.error("Refusing to seed the default data dir. Set NESEV_DATA_DIR to a temp dir.");
    process.exit(1);
  }
  const ids = await seed();
  process.stdout.write(`${JSON.stringify(ids)}\n`);
}
