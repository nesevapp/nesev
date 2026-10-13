import { useQuery } from "@tanstack/react-query";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { unitsQuery } from "@/sdk";

// Radix Select can't use "" as an item value.
const NONE = "__none__";

/**
 * "Einheit" dropdown fed by the unit list from Einstellungen.
 * A stored value that is no longer in the list (older documents) stays selectable.
 */
export function UnitSelect({
  value,
  onChange,
  onBlur,
  className,
  disabled,
  "aria-label": ariaLabel,
}: {
  value: string | null | undefined;
  onChange: (unit: string) => void;
  onBlur?: () => void;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  const { data: units = [] } = useQuery(unitsQuery);
  const current = value ?? "";
  const options = current && !units.includes(current) ? [...units, current] : units;

  return (
    <Select
      value={current || NONE}
      onValueChange={(v) => onChange(v === NONE ? "" : v)}
      onOpenChange={(open) => !open && onBlur?.()}
      disabled={disabled}
    >
      <SelectTrigger className={cn("w-full", className)} aria-label={ariaLabel}>
        <SelectValue placeholder="–" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE} className="text-muted-foreground">
          –
        </SelectItem>
        {options.map((u) => (
          <SelectItem key={u} value={u}>
            {u}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
