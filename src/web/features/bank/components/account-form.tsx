import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AUTO_MATCH_MODE_LABELS, AUTO_MATCH_MODES, type AutoMatchMode, formatIban, isValidIban } from "@shared/bank";
import { formatDate } from "@shared/dates";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  apiErrorMessage,
  type BankAccount,
  bankAccountsQuery,
  bankAccountSuggestionQuery,
  useDeleteBankAccount,
  useSaveBankAccount,
  useSetBankAccountArchived,
} from "@/sdk";

interface Values {
  name: string;
  iban: string;
  bankName: string;
  autoMatch: AutoMatchMode;
}

/** Create/edit form for a bank account. New accounts are prefilled from the company settings. */
export function AccountForm({
  account,
  onSaved,
  onCancel,
  submitLabel = "Speichern",
}: {
  account?: BankAccount;
  onSaved?: (a: { id: number }) => void;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const suggestion = useQuery({ ...bankAccountSuggestionQuery, enabled: !account });
  const save = useSaveBankAccount();
  const [values, setValues] = useState<Values | null>(
    account ? { name: account.name, iban: account.iban, bankName: account.bankName, autoMatch: account.autoMatch } : null,
  );
  const v: Values = values ?? {
    name: suggestion.data?.name ?? "",
    iban: suggestion.data?.iban ?? "",
    bankName: suggestion.data?.bankName ?? "",
    autoMatch: "safe",
  };
  const set = (patch: Partial<Values>) => setValues({ ...v, ...patch });
  const ibanInvalid = v.iban.trim() !== "" && !isValidIban(v.iban);

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(
          { id: account?.id, json: v },
          {
            onSuccess: (a) => {
              toast.success(account ? "Konto gespeichert" : "Konto angelegt");
              onSaved?.(a);
            },
            onError: (err) => toast.error(apiErrorMessage(err)),
          },
        );
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="acc-name">Bezeichnung</Label>
          <Input id="acc-name" value={v.name} onChange={(e) => set({ name: e.target.value })} required autoFocus />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="acc-bank">Bank</Label>
          <Input id="acc-bank" value={v.bankName} onChange={(e) => set({ bankName: e.target.value })} placeholder="z. B. Erste Bank" />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="acc-iban">IBAN</Label>
        <Input
          id="acc-iban"
          value={v.iban}
          onChange={(e) => set({ iban: e.target.value })}
          onBlur={() => !ibanInvalid && v.iban && set({ iban: formatIban(v.iban) })}
          placeholder="AT.."
          className="tabular"
          aria-invalid={ibanInvalid || undefined}
        />
        {ibanInvalid && <p className="text-xs text-danger">Die IBAN-Prüfziffer stimmt nicht.</p>}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="acc-auto">Automatisch zuordnen</Label>
        <Select value={v.autoMatch} onValueChange={(x) => set({ autoMatch: x as AutoMatchMode })}>
          <SelectTrigger id="acc-auto" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUTO_MATCH_MODES.map((m) => (
              <SelectItem key={m} value={m}>
                {AUTO_MATCH_MODE_LABELS[m]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">Gilt nach jedem Import. Alles andere erscheint als Vorschlag.</p>
      </div>
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Abbrechen
          </Button>
        )}
        <Button type="submit" disabled={save.isPending || !v.name.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** "Konten verwalten": list with edit / archive / delete, plus "Neues Konto". */
export function AccountsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { data: accounts = [] } = useQuery(bankAccountsQuery);
  const [editing, setEditing] = useState<BankAccount | "new" | null>(null);
  const archive = useSetBankAccountArchived();
  const remove = useDeleteBankAccount();

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setEditing(null);
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing === "new" ? "Neues Konto" : editing ? "Konto bearbeiten" : "Bankkonten"}</DialogTitle>
          <DialogDescription>
            {editing ? "IBAN und Bank helfen beim Erkennen der Kontoauszüge." : "Konten, deren Auszüge importiert werden."}
          </DialogDescription>
        </DialogHeader>
        {editing ? (
          <AccountForm
            key={editing === "new" ? "new" : editing.id}
            account={editing === "new" ? undefined : editing}
            onSaved={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <>
            <ul className="divide-y rounded-lg border text-sm">
              {accounts.map((a) => (
                <li key={a.id} className={cn("flex items-center gap-3 px-3 py-2", a.archivedAt && "text-muted-foreground")}>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">
                      {a.name}
                      {a.archivedAt && <span className="ml-2 text-xs font-normal">(archiviert)</span>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground tabular">
                      {[formatIban(a.iban), a.bankName].filter(Boolean).join(" · ") || "Keine IBAN"}
                      {a.transactionCount > 0 &&
                        ` · ${a.transactionCount} Buchungen${a.lastBookingDate ? ` bis ${formatDate(a.lastBookingDate)}` : ""}`}
                    </div>
                  </div>
                  <Button variant="ghost" size="icon-sm" aria-label="Bearbeiten" onClick={() => setEditing(a)}>
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={a.archivedAt ? "Wiederherstellen" : "Archivieren"}
                    title={a.archivedAt ? "Wiederherstellen" : "Archivieren"}
                    onClick={() =>
                      archive.mutate({ id: a.id, archived: !a.archivedAt }, { onError: (err) => toast.error(apiErrorMessage(err)) })
                    }
                  >
                    {a.archivedAt ? <ArchiveRestore /> : <Archive />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Löschen"
                    title="Löschen"
                    onClick={() => {
                      if (!window.confirm(`Konto „${a.name}" mit ${a.transactionCount} Buchungen löschen?`)) return;
                      remove.mutate(a.id, {
                        onSuccess: () => toast.success("Konto gelöscht"),
                        onError: (err) => toast.error(apiErrorMessage(err)),
                      });
                    }}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
              {accounts.length === 0 && <li className="px-3 py-6 text-center text-muted-foreground">Noch keine Konten.</li>}
            </ul>
            <div>
              <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
                <Plus />
                Neues Konto
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
