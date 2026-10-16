import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { CircleHelp, History, Keyboard, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { tour } from "@/features/tour/tour-store";
import { searchQuery, type SearchResult } from "@/sdk";
import { CREATE_ACTIONS, matchesCommand, PAGES, type PaletteCommand, RESULT_ICONS } from "./commands";
import { clearRecent, loadRecent, pushRecent, type RecentEntry } from "./recent";
import { Kbd, modKey } from "./kbd";

const DEBOUNCE_MS = 150;
const MAX_COMMANDS = 5;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

const resultId = (r: SearchResult) => `${r.type}:${r.id}`;

export function CommandPalette({
  open,
  onOpenChange,
  onShowShortcuts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onShowShortcuts: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [selected, setSelected] = useState("");
  const term = query.trim();
  const debounced = useDebounced(term, DEBOUNCE_MS);
  const { data, isFetching } = useQuery({ ...searchQuery(debounced), enabled: open && debounced.length > 0 });

  useEffect(() => {
    if (open) setRecent(loadRecent());
    else setQuery("");
  }, [open]);

  const commands = useMemo(
    () => (term ? [...CREATE_ACTIONS, ...PAGES].filter((c) => matchesCommand(c, term)).slice(0, MAX_COMMANDS) : []),
    [term],
  );
  const groups = term ? (data?.groups ?? []) : [];
  const loading = term.length > 0 && (debounced !== term || isFetching);

  // keep the first entry selected whenever the visible list changes (results arrive after typing)
  const firstId = term
    ? (commands[0]?.id ?? (groups[0]?.results[0] ? resultId(groups[0].results[0]) : ""))
    : (recent[0]?.id ?? CREATE_ACTIONS[0]!.id);
  useEffect(() => setSelected(firstId), [firstId, data]);

  const close = () => onOpenChange(false);
  const openEntry = (entry: RecentEntry) => {
    pushRecent(entry);
    close();
    void navigate({ href: entry.path });
  };
  const openCommand = (cmd: PaletteCommand) => {
    const kind = cmd.id.startsWith("new:") ? "action" : "page";
    // create actions are not worth a recent slot, pages are
    if (kind === "page") pushRecent({ kind, id: cmd.id, label: cmd.label, sublabel: "Seite", path: cmd.to });
    close();
    void navigate({ to: cmd.to });
  };
  const openResult = (r: SearchResult) =>
    openEntry({ kind: r.type, id: resultId(r), label: r.label, sublabel: r.sublabel, path: r.path });

  const commandItem = (cmd: PaletteCommand, prefix: "g" | "n") => (
    <CommandItem key={cmd.id} value={cmd.id} onSelect={() => openCommand(cmd)}>
      <cmd.icon strokeWidth={1.75} />
      <span>{cmd.label}</span>
      {cmd.key && (
        <span className="ml-auto flex gap-1">
          <Kbd>{prefix}</Kbd>
          <Kbd>{cmd.key}</Kbd>
        </span>
      )}
    </CommandItem>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[12%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-2xl" showCloseButton={false}>
        <DialogTitle className="sr-only">Suche</DialogTitle>
        <DialogDescription className="sr-only">Kunden, Belege, Ausgaben und Seiten durchsuchen</DialogDescription>
        {/* results are filtered and ranked by the server, so cmdk only handles selection */}
        <Command
          shouldFilter={false}
          value={selected}
          onValueChange={setSelected}
          className="**:data-[slot=command-input-wrapper]:h-12 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group]]:px-2 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:py-2"
        >
          <div className="relative">
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Suchen: Kunde, RE-2026-12, Betrag, Seite …"
            />
            {loading && <Loader2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
          </div>
          <CommandList className="max-h-[min(60vh,520px)]">
            {term && !loading && (
              <CommandEmpty className="py-8 text-center text-sm text-muted-foreground">
                Keine Treffer für „{term}“
              </CommandEmpty>
            )}

            {!term && (
              <>
                {recent.length > 0 && (
                  <CommandGroup heading="Zuletzt geöffnet">
                    {recent.map((e) => {
                      const Icon = e.kind === "page" || e.kind === "action" ? (PAGES.find((p) => p.id === e.id)?.icon ?? History) : RESULT_ICONS[e.kind];
                      return (
                        <CommandItem key={e.id} value={e.id} onSelect={() => openEntry(e)}>
                          <Icon strokeWidth={1.75} />
                          <span className="truncate font-medium">{e.label}</span>
                          <span className="truncate text-muted-foreground">{e.sublabel}</span>
                        </CommandItem>
                      );
                    })}
                    <CommandItem
                      value="recent:clear"
                      onSelect={() => {
                        clearRecent();
                        setRecent([]);
                      }}
                      className="text-xs text-muted-foreground"
                    >
                      <History strokeWidth={1.75} />
                      Verlauf löschen
                    </CommandItem>
                  </CommandGroup>
                )}
                <CommandGroup heading="Erstellen">{CREATE_ACTIONS.map((c) => commandItem(c, "n"))}</CommandGroup>
                <CommandGroup heading="Gehe zu">{PAGES.map((c) => commandItem(c, "g"))}</CommandGroup>
                <CommandGroup heading="Hilfe">
                  <CommandItem
                    value="help:shortcuts"
                    onSelect={() => {
                      close();
                      onShowShortcuts();
                    }}
                  >
                    <Keyboard strokeWidth={1.75} />
                    Tastenkürzel anzeigen
                    <span className="ml-auto">
                      <Kbd>?</Kbd>
                    </span>
                  </CommandItem>
                  <CommandItem
                    value="help:tour"
                    onSelect={() => {
                      close();
                      tour.start();
                    }}
                  >
                    <CircleHelp strokeWidth={1.75} />
                    Rundgang starten
                  </CommandItem>
                </CommandGroup>
              </>
            )}

            {commands.length > 0 && (
              <CommandGroup heading="Seiten & Aktionen">
                {commands.map((c) => commandItem(c, c.id.startsWith("new:") ? "n" : "g"))}
              </CommandGroup>
            )}

            {groups.map((g, i) => (
              <div key={g.type}>
                {(i > 0 || commands.length > 0) && <CommandSeparator />}
                <CommandGroup heading={g.label}>
                  {g.results.map((r) => {
                    const Icon = RESULT_ICONS[r.type];
                    return (
                      <CommandItem key={resultId(r)} value={resultId(r)} onSelect={() => openResult(r)} className="gap-2.5">
                        <Icon strokeWidth={1.75} />
                        <div className="flex min-w-0 flex-1 items-baseline gap-2">
                          <span className="shrink-0 font-medium tabular">{r.label}</span>
                          <span className="truncate text-muted-foreground">{r.sublabel}</span>
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground tabular">{r.meta}</span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </div>
            ))}
          </CommandList>
          <div className="flex items-center gap-4 border-t px-3 py-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> auswählen
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> öffnen
            </span>
            <span className="flex items-center gap-1">
              <Kbd>esc</Kbd> schließen
            </span>
            <span className="ml-auto flex items-center gap-1">
              <Kbd>{modKey}</Kbd>
              <Kbd>K</Kbd> Suche · <Kbd>?</Kbd> Tastenkürzel
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
