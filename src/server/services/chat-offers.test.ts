import { describe, expect, test } from "bun:test";
import { candidates, offerInsteadOfAction, type OfferToolRow } from "./chat-offers";

// "Offered instead of acting" nudge: the offer, the request, and exactly one candidate per slot.

// texts in the shape of the MCP tools (seeded demo data)
const REMINDERS_ONE =
  "1 überfällige Rechnungen, offen gesamt € 1.140,00:\n- RE-2026-0001 (invoice id 1) · Alpen Software GmbH · fällig 14.09.2026 (31 Tage) · offen € 1.140,00 · noch nicht gemahnt · jetzt fällig: Zahlungserinnerung (Spesen € 0,00)";
const REMINDERS_TWO = `${REMINDERS_ONE}\n- RE-2026-0003 (invoice id 7) · Berlin GmbH · fällig 01.10.2026 (14 Tage) · offen € 300,00 · noch nicht gemahnt`;
const BANK =
  "3 Bankbuchungen, Eingänge € 1.140,00, Ausgänge -€ 72,34:\n- 13.10.2026 € 1.140,00 · Alpen Software GmbH · Rechnung RE-2026-0001 · Offen · id 1\n- 12.10.2026 -€ 60,00 · Adobe Systems Software Ireland · Creative Cloud · Offen · id 2\n- 09.10.2026 -€ 12,34 · BILLA DANKT 1234 · Kartenzahlung · Offen · id 3";
const SEARCH_RE1 =
  "Rechnungen:\n- RE-2026-0001 (invoice id 1) · Alpen Software GmbH · Website-Relaunch · 31.08.2026 · € 1.284,00 · Überfällig\nGutschriften:\n- GS-2026-0001 (credit_note id 2) · Alpen Software GmbH · Gutschrift zu Rechnung RE-2026-0001 · 15.10.2026 · € 144,00 · Finalisiert";
const SEARCH_ADOBE = "Ausgaben:\n- ER-2026-0002 (expense id 2) · Adobe Systems Software Ireland Ltd · Creative Cloud · 11.10.2026 · € 60,00 · Offen";
const SEARCH_ALPEN =
  "Kunden:\n- Alpen Software GmbH (client id 1) · K-0001\nRechnungen:\n- Rechnung (Entwurf) (invoice id 4) · Alpen Software GmbH · Wartung · 15.10.2026 · € 228,00 · Entwurf\n- RE-2026-0001 (invoice id 1) · Alpen Software GmbH · Website-Relaunch · 31.08.2026 · € 1.284,00 · Überfällig";

const row = (toolName: string, content: string, status = "done"): OfferToolRow => ({ toolName, status, content });
const OFFER_REMINDER = "Es gibt eine überfällige Rechnung: RE-2026-0001 an Alpen Software GmbH. Möchten Sie jetzt eine Zahlungserinnerung (1. Mahnung) für diese Rechnung erstellen?";
const tool = (answer: string, user: string, rows: OfferToolRow[]) => offerInsteadOfAction(answer, user, rows)?.tool ?? null;

describe("offer instead of action", () => {
  test("candidates from list lines, bank lines and detail headers", () => {
    expect(candidates("list_bank_transactions", BANK).map((c) => `${c.kind}:${c.id}`)).toEqual(["bank_transaction:1", "bank_transaction:2", "bank_transaction:3"]);
    expect(candidates("search", SEARCH_RE1).map((c) => `${c.kind}:${c.id}`)).toEqual(["invoice:1", "credit_note:2"]);
    expect(candidates("get_document", "Rechnung RE-2026-0001 (id 1) · Überfällig\nKunde: Alpen Software GmbH (id 1)").map((c) => `${c.kind}:${c.id}`)).toEqual(["invoice:1"]);
    expect(candidates("get_bank_transaction", "Bankbuchung (id 1) · Offen · Geschäftskonto\n13.10.2026 € 1.140,00 · Alpen\nZweck: x\nzugeordnet € 0,00").map((c) => `${c.kind}:${c.id}`)).toEqual(["bank_transaction:1"]);
  });

  test("fires: one candidate per slot, the requested action offered", () => {
    expect(tool(OFFER_REMINDER, "Schick eine Mahnung für die überfällige Rechnung", [row("list_reminders_due", REMINDERS_ONE)])).toBe("create_reminder");
    // one open booking from Alpen (named) and the named invoice
    expect(
      tool("Die Zahlung von Alpen ist offen. Soll ich sie der Rechnung RE-2026-0001 zuordnen?", "Ordne die Zahlung von Alpen der Rechnung RE-2026-0001 zu", [
        row("list_bank_transactions", BANK),
        row("search", SEARCH_RE1),
      ]),
    ).toBe("match_bank_transaction");
    expect(tool("Ich habe ER-2026-0002 gefunden. Soll ich sie als bezahlt markieren?", "Markiere die Ausgabe von Adobe als bezahlt", [row("search", SEARCH_ADOBE)])).toBe("mark_expense_paid");
    expect(tool("Der Entwurf für Alpen hat die id 4. Möchten Sie ihn finalisieren?", "Finalisiere den Entwurf für Alpen", [row("search", SEARCH_ALPEN)])).toBe("finalize_document");
  });

  test("doesn't fire: several candidates, no lookup, a question as request, no offer, the tool already ran", () => {
    const user = "Schick eine Mahnung für die überfällige Rechnung";
    expect(tool(OFFER_REMINDER, user, [row("list_reminders_due", REMINDERS_TWO)])).toBeNull();
    expect(tool(OFFER_REMINDER, user, [])).toBeNull();
    expect(tool(OFFER_REMINDER, user, [row("list_reminders_due", REMINDERS_ONE, "error")])).toBeNull();
    expect(tool(OFFER_REMINDER, "Kann man für die überfällige Rechnung eine Mahnung schicken?", [row("list_reminders_due", REMINDERS_ONE)])).toBeNull();
    expect(tool("Es gibt eine überfällige Rechnung: RE-2026-0001. Die Mahnung ist noch nicht erstellt.", user, [row("list_reminders_due", REMINDERS_ONE)])).toBeNull();
    expect(tool(OFFER_REMINDER, user, [row("list_reminders_due", REMINDERS_ONE), row("create_reminder", REJECTED, "cancelled")])).toBeNull();
    // the offer is about something else than the request
    expect(tool("Soll ich Ihnen die Liste der Kunden zeigen?", user, [row("list_reminders_due", REMINDERS_ONE)])).toBeNull();
    // three open bookings, the user named none of them
    expect(tool("Welche Buchung soll ich der Rechnung RE-2026-0001 zuordnen?", "Ordne die Zahlung der überfälligen Rechnung zu", [row("list_bank_transactions", BANK), row("search", SEARCH_RE1)])).toBeNull();
    // … but a booking whose purpose names the invoice the user named is the one
    expect(tool("Soll ich die Buchung der Rechnung RE-2026-0001 zuordnen?", "Ordne die Zahlung der Rechnung RE-2026-0001 zu", [row("list_bank_transactions", BANK), row("search", SEARCH_RE1)])).toBe("match_bank_transaction");
    // the named booking but no invoice looked up
    expect(tool("Soll ich die Zahlung von Alpen zuordnen?", "Ordne die Zahlung von Alpen zu", [row("list_bank_transactions", BANK)])).toBeNull();
    // two open invoices for Alpen
    expect(tool("Welche Rechnung von Alpen soll ich als bezahlt markieren?", "Markiere die Rechnung von Alpen als bezahlt", [row("search", `${SEARCH_ALPEN}\n- RE-2026-0005 (invoice id 9) · Alpen Software GmbH · x · 01.10.2026 · € 10,00 · Offen`)])).toBeNull();
  });

  test("the ambiguity case stays a question (not a write request, no rule)", () => {
    expect(tool("Meinen Sie RE-2026-0001 oder den Entwurf (id 4)? Soll ich eine davon öffnen?", "Öffne die Rechnung von Alpen", [row("search", SEARCH_ALPEN)])).toBeNull();
  });
});

const REJECTED = "Der Nutzer hat die Aktion abgelehnt; es wurde nichts ausgeführt oder geändert.";
