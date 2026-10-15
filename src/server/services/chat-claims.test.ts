import { describe, expect, test } from "bun:test";
import { CASES } from "../eval/chat-eval.cases";
import { claimRetryMessage, detectClaims, honestReply, isWriteRequest, unbackedClaims } from "./chat-claims";

// "Claimed but not done" guard: claims of an own action in a final answer, and the tools that back them.

const kinds = (text: string) => detectClaims(text).map((c) => `${c.kind}:${c.word}`);

describe("claim detection", () => {
  test("own-action claims", () => {
    expect(kinds("Ich habe die Zahlung von Alpen der Rechnung RE-2026-0001 zugeordnet.")).toEqual(["assign:zugeordnet"]);
    expect(kinds("Hab den Entwurf angelegt.")).toEqual(["create:angelegt"]);
    expect(kinds("Die Zahlung wurde erfolgreich der Rechnung zugeordnet.")).toEqual(["assign:zugeordnet"]);
    expect(kinds("Die Buchungen wurden soeben zugeordnet.")).toEqual(["assign:zugeordnet"]);
    expect(kinds("Der Rechnungsentwurf wurde erstellt: 3 Std. Beratung, brutto € 432,00.")).toEqual(["create:erstellt"]);
    expect(kinds("Die E-Mail-Adresse wurde auf office@alpen.at geändert.")).toEqual(["update:geändert"]);
    expect(kinds("Die Rechnung ist jetzt als bezahlt markiert.")).toEqual(["mark:markiert"]);
    expect(kinds("Die Serienrechnung ist nun pausiert.")).toEqual(["recurring:pausiert"]);
    expect(kinds("Ich ordne die Zahlung jetzt der Rechnung zu.")).toEqual(["assign:ordne"]);
    expect(kinds("Jetzt lege ich den Entwurf an.")).toEqual(["create:lege"]);
    expect(kinds("Ich ändere die E-Mail auf office@alpen.at.")).toEqual(["update:ändere"]);
    expect(kinds("Die Belegerkennung wurde jetzt übernommen.")).toEqual(["apply:übernommen"]);
    // eval, bank-match: a claim after only a search
    expect(kinds("Die Zahlung von Alpen (€ 1.284,00) wurde der Rechnung RE-2026-0001 (id 1) zugeordnet. Die Rechnung ist nun vollständig bezahlt.")).toEqual([
      "assign:zugeordnet",
      "mark:bezahlt",
    ]);
    expect(kinds("Die Bankbuchung wurde der Rechnung RE-2026-0001 zugeordnet.")).toEqual(["assign:zugeordnet"]);
    expect(kinds("Erledigt!")).toEqual(["any:erledigt"]);
    expect(kinds("**Alles erledigt.** Die Zahlung ist zugeordnet.")).toEqual(["any:erledigt"]);
    // several claims in one answer
    expect(kinds("Ich habe den Entwurf erstellt und finalisiert.")).toEqual(["create:erstellt", "finalize:finalisiert"]);
    expect(kinds("Ich habe den Entwurf erstellt. Außerdem wurde die Zahlung jetzt zugeordnet.")).toEqual(["create:erstellt", "assign:zugeordnet"]);
  });

  test("negations, questions, offers and conditionals don't count", () => {
    for (const text of [
      "Ich habe die Zahlung nicht zugeordnet.",
      "Die Zuordnung wurde noch nicht ausgeführt.",
      "Es wurde kein Entwurf erstellt.",
      "Die Zahlung ist jetzt noch nicht zugeordnet.",
      "Ich ändere nichts, bevor Sie bestätigen.",
      "Soll ich die Zahlung der Rechnung zuordnen?",
      "Wurde die Rechnung schon finalisiert?",
      "Habe ich das richtig verstanden, dass die Zahlung zugeordnet werden soll?",
      "Wenn Sie bestätigen, ordne ich die Zahlung zu.",
      "Ich kann die Zahlung zuordnen, sobald Sie bestätigen.",
      "Möchten Sie, dass ich den Entwurf erstelle?",
      "Falls gewünscht, habe ich den Entwurf gleich erstellt.",
      "Ich würde die E-Mail auf office@alpen.at ändern.",
      "Bitte bestätigen Sie, dann ist die Zahlung jetzt zugeordnet.",
    ]) {
      expect([text, kinds(text)]).toEqual([text, []]);
    }
  });

  test("data descriptions don't count", () => {
    for (const text of [
      "Die Rechnung wurde am 3.10. erstellt.",
      "Die Rechnung RE-2026-0001 wurde am 03.10.2026 erstellt und ist überfällig.",
      "Status: bezahlt",
      "Status: erledigt",
      "Die Zahlung ist bereits zugeordnet.",
      "Die Zahlung von Alpen wurde bereits der Rechnung RE-2026-0001 zugeordnet.",
      "Ich habe nachgesehen: die Zahlung ist bereits zugeordnet.",
      "Ich habe 3 Rechnungen gefunden, die im Oktober erstellt wurden.",
      "Die Rechnung RE-2026-0002 wurde von Berlin bezahlt und ist zugeordnet.",
      "Die Gutschrift wurde automatisch angelegt.",
      "Sie haben diesen Monat 2 Rechnungen erstellt.",
      "Offene Bankbuchungen:\n- 13.10.2026 € 1.140,00 · Alpen Software GmbH · zugeordnet\n- 12.10.2026 -€ 60,00 · Adobe · offen",
      "| Nr. | Status |\n|---|---|\n| RE-2026-0001 | zugeordnet |",
      "Der Entwurf für Alpen (id 4) wurde vor zwei Wochen angelegt und hat noch keine Nummer.",
      "Die Rechnung RE-2026-0001 wurde im Oktober erstellt.",
      "RE-2026-0001 wurde 2026 erstellt.",
      "Die Buchung wurde am 13.10. über € 1.140,00 der Rechnung zugeordnet.",
      "Die Rechnung ist bezahlt.",
      "Die Rechnung RE-2026-0002 wurde bezahlt.",
    ]) {
      expect([text, kinds(text)]).toEqual([text, []]);
    }
  });

  test("evidence: a successful or pending call of a mapped tool in this turn", () => {
    const claims = detectClaims("Ich habe die Zahlung zugeordnet und den Entwurf erstellt.");
    expect(claims.map((c) => c.kind)).toEqual(["assign", "create"]);
    expect(unbackedClaims(claims, [{ toolName: "list_bank_transactions", status: "done" }]).map((c) => c.kind)).toEqual(["assign", "create"]);
    expect(unbackedClaims(claims, [{ toolName: "match_bank_transaction", status: "pending" }]).map((c) => c.kind)).toEqual(["create"]);
    // a failed or rejected call backs nothing
    expect(unbackedClaims(claims, [{ toolName: "match_bank_transaction", status: "error" }, { toolName: "create_invoice_draft", status: "cancelled" }])).toHaveLength(2);
    expect(unbackedClaims(claims, [{ toolName: "match_bank_transaction", status: "done" }, { toolName: "create_invoice_draft", status: "done" }])).toEqual([]);
    const backed = (text: string, tool: string) => unbackedClaims(detectClaims(text), [{ toolName: tool, status: "done" }]).length === 0;
    expect(backed("Die Ausgabe wurde jetzt den Fixkosten zugeordnet.", "link_expense_to_fixed_cost")).toBe(true);
    expect(backed("Ich habe die Mahnung erstellt.", "create_reminder")).toBe(true);
    expect(backed("Die Rechnung wurde soeben erstellt.", "generate_recurring_invoice")).toBe(true);
    expect(backed("Ich habe das Angebot umgewandelt.", "convert_offer_to_invoice")).toBe(true);
    expect(backed("Die Ausgabe ist jetzt aktualisiert.", "apply_receipt_analysis")).toBe(true);
    expect(backed("Die Erkennung wurde jetzt übernommen.", "apply_receipt_analysis")).toBe(true);
    expect(backed("Ich habe die Rechnung finalisiert.", "finalize_document")).toBe(true);
    expect(backed("Die Serienrechnung ist jetzt fortgesetzt.", "set_recurring_invoice_active")).toBe(true);
    expect(backed("Erledigt.", "mark_expense_paid")).toBe(true);
    expect(backed("Erledigt.", "search")).toBe(false);
    expect(backed("Ich habe die Rechnung finalisiert.", "create_invoice_draft")).toBe(false);
    expect(backed("Die Zahlung wurde jetzt zugeordnet.", "list_bank_transactions")).toBe(false);
  });

  test("corrective message and fixed reply name what was claimed", () => {
    const claims = detectClaims("Ich habe die Zahlung zugeordnet.");
    expect(claimRetryMessage(claims)).toBe(
      "Du hast behauptet, die Zuordnung sei erledigt („zugeordnet“), aber in dieser Runde wurde kein passendes Tool ausgeführt (match_bank_transaction bzw. link_expense_to_fixed_cost). Ruf jetzt das passende Tool auf (vorher nachschlagen, ids nicht raten) oder sag ehrlich, dass es noch nicht erledigt ist.",
    );
    expect(honestReply(claims)).toBe("Das ist noch nicht erledigt: Die Zuordnung wurde nicht ausgeführt. Soll ich sie jetzt vorbereiten?");
    expect(honestReply(detectClaims("Der Entwurf wurde erfolgreich erstellt."))).toBe("Das ist noch nicht erledigt: Es wurde noch nichts angelegt. Soll ich es jetzt anlegen?");
  });
});

describe("write intent", () => {
  test("write verbs; participles and questions about data are read-only", () => {
    for (const t of [
      "Ordne die Zahlung von Alpen der Rechnung zu",
      "Kannst du die Zahlung zuordnen?",
      "Erstelle eine Rechnung für Alpen",
      "Leg bitte einen Kunden Muster GmbH an",
      "Ändere die E-Mail von Alpen auf office@alpen.at",
      "Markiere die Ausgabe von Adobe als bezahlt",
      "Finalisiere den Entwurf",
      "Verknüpfe die Ausgabe mit der Miete",
      "Übernimm die Belegerkennung",
      "Pausiere die Serienrechnung",
      "Setz die Serienrechnung wieder fort",
      "Trag die Ausgabe von BILLA ein",
      "Schick eine Mahnung für die überfällige Rechnung",
      "Wandle das Angebot in eine Rechnung um",
    ]) {
      expect([t, isWriteRequest(t)]).toEqual([t, true]);
    }
    for (const t of [
      "Welche Bankumsätze sind noch nicht zugeordnet?",
      "Welche Rechnungen habe ich diesen Monat erstellt?",
      "Wurde die Rechnung schon finalisiert?",
      "Zeig mir die markierten Ausgaben",
      "Welche Änderungen gab es?",
      "Ja, bitte",
    ]) {
      expect([t, isWriteRequest(t)]).toEqual([t, false]);
    }
  });

  test("a short yes counts only after the assistant offered a change", () => {
    expect(isWriteRequest("Ja, bitte", "Soll ich die Zahlung der Rechnung RE-2026-0001 zuordnen?")).toBe(true);
    expect(isWriteRequest("ok mach das", "Soll ich sie als bezahlt markieren?")).toBe(true);
    expect(isWriteRequest("Ja", "Offen ist RE-2026-0001 über € 1.140,00.")).toBe(false);
    expect(isWriteRequest("Ja, und wie hoch ist der Umsatz im Oktober insgesamt gewesen?", "Soll ich sie zuordnen?")).toBe(false);
  });

  test("the eval's read-only cases are not write requests; its write cases are", () => {
    const write = new Set(["bank-match", "update-client", "expense-paid", "reminder", "draft"]);
    for (const c of CASES) {
      const text = c.turns.at(-1)!.text;
      expect([c.id, isWriteRequest(text)]).toEqual([c.id, write.has(c.id)]);
    }
  });
});
