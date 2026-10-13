import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { countryName } from "@shared/countries";
import { categoryLabel, VAT_TREATMENT_SHORT_LABELS } from "@shared/expenses";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/features/clients/use-debounced-value";
import { cn } from "@/lib/utils";
import { type SupplierSuggestionDTO, supplierSuggestionsQuery } from "../api";

/**
 * Free-text supplier name with suggestions from previous expenses.
 * ↑/↓ + Enter (or click) picks a suggestion, which calls onPick so the caller can prefill.
 */
export function SupplierInput({
  value,
  onChange,
  onPick,
  onBlur,
  inputRef,
  id,
  autoFocus,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  onPick: (s: SupplierSuggestionDTO) => void;
  onBlur?: () => void;
  inputRef?: React.Ref<HTMLInputElement>;
  id?: string;
  autoFocus?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = useDebouncedValue(value.trim(), 120);
  const listId = useId();
  const { data } = useQuery({ ...supplierSuggestionsQuery(q), enabled: open });
  // Hide the exact match when it is the only one (nothing left to suggest).
  const options = (data ?? []).filter((s, _, all) => !(all.length === 1 && s.name === value));
  const visible = open && options.length > 0;

  useEffect(() => setActive(0), [q]);

  const pick = (s: SupplierSuggestionDTO) => {
    onPick(s);
    setOpen(false);
  };

  return (
    <div className="relative">
      <Input
        ref={inputRef}
        id={id}
        autoFocus={autoFocus}
        value={value}
        autoComplete="off"
        placeholder="Name des Lieferanten"
        className={className}
        role="combobox"
        aria-expanded={visible}
        aria-controls={listId}
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          onBlur?.();
        }}
        onKeyDown={(e) => {
          if (!visible) {
            if (e.key === "ArrowDown") setOpen(true);
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(i + 1, options.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            const s = options[active];
            if (s) {
              e.preventDefault();
              pick(s);
            }
          } else if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
          }
        }}
      />
      {visible && (
        <ul
          id={listId}
          role="listbox"
          className="absolute top-full right-0 left-0 z-30 mt-1 max-h-72 overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {options.map((s, i) => (
            <li
              key={s.name}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault(); // keep focus in the input
                pick(s);
              }}
              onMouseMove={() => setActive(i)}
              className={cn(
                "cursor-pointer rounded-sm px-2 py-1.5 text-sm",
                i === active && "bg-accent text-accent-foreground",
              )}
            >
              <div className="truncate">{s.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {countryName(s.country)}
                {s.uid && ` · ${s.uid}`}
                {` · ${VAT_TREATMENT_SHORT_LABELS[s.vatTreatment]}`}
                {s.category && ` · ${categoryLabel(s.category)}`}
                {` · ${s.count}×`}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
