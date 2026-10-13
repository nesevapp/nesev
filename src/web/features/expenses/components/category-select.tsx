import { EXPENSE_CATEGORIES, type ExpenseCategory } from "@shared/expenses";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const GROUPS = Object.entries(
  (EXPENSE_CATEGORIES as readonly ExpenseCategory[]).reduce<Record<string, ExpenseCategory[]>>((acc, c) => {
    (acc[c.group] ??= []).push(c);
    return acc;
  }, {}),
);

export function CategoryOptions() {
  return GROUPS.map(([group, cats], i) => (
    <SelectGroup key={group}>
      {i > 0 && <SelectSeparator />}
      <SelectLabel className="text-xs">{group}</SelectLabel>
      {cats.map((c) => (
        <SelectItem key={c.key} value={c.key} title={c.hint}>
          {c.label}
        </SelectItem>
      ))}
    </SelectGroup>
  ));
}

export function CategorySelect({
  value,
  onChange,
  className,
  triggerRef,
  ...props
}: {
  value: string;
  onChange: (key: string) => void;
  className?: string;
  triggerRef?: React.Ref<HTMLButtonElement>;
  "aria-label"?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger ref={triggerRef} className={className} aria-label={props["aria-label"]}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <CategoryOptions />
      </SelectContent>
    </Select>
  );
}
