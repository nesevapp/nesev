import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { type ThemePref, useTheme } from "./theme";

const OPTIONS: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Hell", icon: Sun },
  { value: "dark", label: "Dunkel", icon: Moon },
  { value: "system", label: "Wie System", icon: Monitor },
];

/** Light / dark / system switch in the sidebar footer. */
export function ThemeToggle() {
  const { pref, setPref } = useTheme();
  return (
    <div role="radiogroup" aria-label="Farbschema" className="flex rounded-md border border-sidebar-border p-0.5">
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={pref === value}
          title={label}
          onClick={() => setPref(value)}
          className={cn(
            "grid h-6 flex-1 place-items-center rounded-[5px] text-sidebar-foreground/70 transition-colors hover:text-sidebar-accent-foreground",
            pref === value && "bg-sidebar-accent text-sidebar-accent-foreground",
          )}
        >
          <Icon className="size-3.5" strokeWidth={1.75} />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}
