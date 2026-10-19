import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, RotateCcw, X } from "lucide-react";
import { toast } from "sonner";
import { DEFAULT_UNITS, unitsSchema } from "@shared/units";
import { FormSection } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiErrorMessage, unitsQuery, useUpdateUnits } from "@/sdk";

/** "Einheiten" section on the settings page: the list offered in the line-item "Einheit" dropdown. */
export function UnitSettingsSection() {
  const { data } = useQuery(unitsQuery);
  const update = useUpdateUnits();
  const [units, setUnits] = useState<string[]>([]);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (data) setUnits(data);
  }, [data]);

  const dirty = JSON.stringify(units) !== JSON.stringify(data ?? []);

  const add = () => {
    const unit = draft.trim();
    if (!unit) return;
    if (units.includes(unit)) {
      toast.error(`„${unit}“ ist bereits in der Liste`);
      return;
    }
    setUnits([...units, unit]);
    setDraft("");
  };

  const move = (i: number, dir: -1 | 1) => {
    const next = [...units];
    [next[i], next[i + dir]] = [next[i + dir]!, next[i]!];
    setUnits(next);
  };

  const save = () => {
    const parsed = unitsSchema.safeParse(units);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Ungültige Einheiten");
      return;
    }
    update.mutate(parsed.data, {
      onSuccess: () => toast.success("Einheiten gespeichert"),
      onError: (err) => toast.error(apiErrorMessage(err)),
    });
  };

  return (
    <div id="einheiten" className="max-w-4xl scroll-mt-8 border-t pt-8">
      <FormSection
        title="Einheiten"
        description="Auswahl für „Einheit“ in Positionen und Artikeln. Die Reihenfolge hier ist die Reihenfolge im Dropdown. Bestehende Belege behalten ihre Einheit, auch wenn sie hier entfernt wird."
      >
        <ul className="divide-y rounded-lg border">
          {units.map((u, i) => (
            <li key={u} className="flex items-center gap-2 px-3 py-1.5 text-sm">
              <span className="flex-1">{u}</span>
              <Button type="button" variant="ghost" size="icon" className="size-7" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`${u} nach oben`}>
                <ArrowUp className="size-3.5" />
              </Button>
              <Button type="button" variant="ghost" size="icon" className="size-7" disabled={i === units.length - 1} onClick={() => move(i, 1)} aria-label={`${u} nach unten`}>
                <ArrowDown className="size-3.5" />
              </Button>
              <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => setUnits(units.filter((x) => x !== u))} aria-label={`${u} entfernen`}>
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
          {units.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">Keine Einheiten – das Dropdown bietet dann nur „–“.</li>}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="Neue Einheit, z. B. Lizenz"
            maxLength={20}
            className="max-w-xs min-w-0 flex-1"
          />
          <Button type="button" variant="outline" onClick={add} disabled={!draft.trim()}>
            <Plus className="size-4" /> Hinzufügen
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={save} disabled={!dirty || update.isPending}>
            Einheiten speichern
          </Button>
          <Button type="button" variant="ghost" onClick={() => setUnits(DEFAULT_UNITS)}>
            <RotateCcw className="size-4" /> Standard wiederherstellen
          </Button>
        </div>
      </FormSection>
    </div>
  );
}
