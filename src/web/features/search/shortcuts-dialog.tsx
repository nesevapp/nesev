import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CREATE_ACTIONS, PAGES } from "./commands";
import { Kbd, modKey } from "./kbd";

function Row({ keys, children }: { keys: string[]; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1 text-sm">
      <span>{children}</span>
      <span className="flex shrink-0 items-center gap-1">
        {keys.map((k, i) => (
          <Kbd key={i}>{k}</Kbd>
        ))}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">{title}</h3>
      <div className="divide-y divide-border/60">{children}</div>
    </section>
  );
}

/** Overview of all keyboard shortcuts (opened with "?"). */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Tastenkürzel</DialogTitle>
          <DialogDescription>
            Gelten überall außer beim Tippen in Eingabefeldern. Für Folgen wie <Kbd>g</Kbd> <Kbd>r</Kbd> die Tasten
            nacheinander drücken.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          <div className="space-y-5">
            <Section title="Allgemein">
              <Row keys={[modKey, "K"]}>Suche öffnen</Row>
              <Row keys={["/"]}>Suche öffnen</Row>
              <Row keys={[modKey, "J"]}>Assistent ein-/ausblenden</Row>
              <Row keys={["?"]}>Diese Übersicht</Row>
              <Row keys={[modKey, "S"]}>Speichern (in Editoren)</Row>
              <Row keys={[modKey, "↵"]}>Ausgabe speichern & nächste</Row>
            </Section>
            <Section title="Erstellen">
              {CREATE_ACTIONS.filter((c) => c.key).map((c) => (
                <Row key={c.id} keys={["n", c.key!]}>
                  {c.label}
                </Row>
              ))}
            </Section>
          </div>
          <Section title="Gehe zu">
            {PAGES.filter((p) => p.key).map((p) => (
              <Row key={p.id} keys={["g", p.key!]}>
                {p.label}
              </Row>
            ))}
          </Section>
        </div>
        <p className="text-xs text-muted-foreground">
          In der Bank-Liste: <Kbd>/</Kbd> fokussiert die Suche, <Kbd>j</Kbd>/<Kbd>k</Kbd> wechseln die Zeile, <Kbd>↵</Kbd> ordnet zu.
        </p>
      </DialogContent>
    </Dialog>
  );
}
