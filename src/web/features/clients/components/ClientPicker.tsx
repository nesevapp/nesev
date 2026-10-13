import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { countryName } from "@shared/countries";
import { formatClientNumber } from "@shared/schemas/client";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { type Client, clientPickerQuery, clientQuery } from "@/sdk";
import { useDebouncedValue } from "../use-debounced-value";

export interface ClientPickerProps {
  /** selected client id */
  value?: number;
  /** called with the full client on select, null when cleared */
  onChange: (client: Client | null) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-invalid"?: boolean;
}

/**
 * Searchable client combobox (active clients only; a selected archived client still shows).
 * Usage: <ClientPicker value={clientId} onChange={(c) => form.setValue("clientId", c?.id ?? 0)} />
 */
export function ClientPicker({
  value,
  onChange,
  placeholder = "Kunde auswählen…",
  disabled,
  className,
  id,
  "aria-invalid": ariaInvalid,
}: ClientPickerProps) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const q = useDebouncedValue(search.trim(), 150);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  const selected = useQuery({ ...clientQuery(value ?? 0), enabled: !!value });
  const results = useQuery({ ...clientPickerQuery(q), enabled: open });
  const options = results.data ?? [];

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const select = (client: Client | null) => {
    if (client) qc.setQueryData(clientQuery(client.id).queryKey, client);
    onChange(client);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const client = options[active];
      if (client) select(client);
    }
  };

  const current = value ? selected.data : undefined;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-invalid={ariaInvalid}
          disabled={disabled}
          className={cn("w-full justify-between px-3 font-normal", className)}
        >
          {current ? (
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate">{current.name}</span>
              <span className="tabular shrink-0 text-xs text-muted-foreground">{formatClientNumber(current.number)}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">{value && selected.isPending ? "Lädt…" : placeholder}</span>
          )}
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-72 p-0">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Name, Nummer, E-Mail, Ort…"
            role="searchbox"
            aria-controls={listId}
            aria-activedescendant={options[active] ? `${listId}-${options[active].id}` : undefined}
            className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <ul ref={listRef} id={listId} role="listbox" className="max-h-72 overflow-y-auto p-1">
          {options.map((client, i) => (
            <li
              key={client.id}
              id={`${listId}-${client.id}`}
              data-index={i}
              role="option"
              aria-selected={client.id === value}
              onMouseMove={() => setActive(i)}
              onClick={() => select(client)}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                i === active && "bg-accent text-accent-foreground",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate">{client.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  <span className="tabular">{formatClientNumber(client.number)}</span>
                  {client.city && ` · ${client.city}`}
                  {` · ${countryName(client.country)}`}
                </div>
              </div>
              {client.id === value && <Check className="size-4 shrink-0" />}
            </li>
          ))}
          {results.isSuccess && options.length === 0 && (
            <li className="px-2 py-6 text-center text-sm text-muted-foreground">Keine Kunden gefunden.</li>
          )}
          {results.isPending && <li className="px-2 py-6 text-center text-sm text-muted-foreground">Lädt…</li>}
        </ul>
        {value ? (
          <div className="border-t p-1">
            <button
              type="button"
              onClick={() => select(null)}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <X className="size-4" />
              Auswahl entfernen
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
