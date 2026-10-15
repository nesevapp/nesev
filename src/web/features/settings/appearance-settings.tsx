import { Monitor, Moon, Sun } from "lucide-react";
import { type ThemePref, useTheme } from "@/app/theme";
import { FormSection } from "@/components/form-fields";
import { cn } from "@/lib/utils";

const OPTIONS: { value: ThemePref; label: string; hint: string; icon: typeof Sun }[] = [
  { value: "light", label: "Hell", hint: "Immer helles Design", icon: Sun },
  { value: "dark", label: "Dunkel", hint: "Immer dunkles Design", icon: Moon },
  { value: "system", label: "Wie System", hint: "Folgt der Einstellung von macOS", icon: Monitor },
];

/** Settings tab "Darstellung": color theme (stored per browser, see app/theme.ts; applies at once, no save button). */
export function AppearanceSettingsSection() {
  const { pref, setPref } = useTheme();
  return (
    <FormSection
      title="Farbschema"
      description="Gilt für diesen Browser und wird sofort übernommen. PDFs bleiben immer hell."
    >
      <div role="radiogroup" aria-label="Farbschema" className="grid max-w-xl gap-3 sm:grid-cols-3">
        {OPTIONS.map(({ value, label, hint, icon: Icon }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={pref === value}
            onClick={() => setPref(value)}
            className={cn(
              "flex flex-col items-start gap-2 rounded-lg border p-3 text-left transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
              pref === value && "border-foreground/40 bg-accent ring-1 ring-foreground/20",
            )}
          >
            <Icon className="size-4 text-muted-foreground" strokeWidth={1.75} />
            <span className="text-sm font-medium">{label}</span>
            <span className="text-xs text-muted-foreground">{hint}</span>
          </button>
        ))}
      </div>
    </FormSection>
  );
}
