import { Page } from "@/components/page";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EarSection } from "./ear-section";
import { UvaSection } from "./uva-section";
import { ZmSection } from "./zm-section";

export type TaxTab = "uva" | "zm" | "ear";

export interface TaxSearch {
  tab?: TaxTab;
  period?: string;
  year?: number;
  eu?: boolean;
}

export function TaxPage({ search, setSearch }: { search: TaxSearch; setSearch: (update: TaxSearch) => void }) {
  const tab = search.tab ?? "uva";
  return (
    <Page title="Steuern" description="Umsatzsteuervoranmeldung, Zusammenfassende Meldung und Einnahmen-Ausgaben-Rechnung vorbereiten.">
      <Tabs value={tab} onValueChange={(v) => setSearch({ tab: v === "uva" ? undefined : (v as TaxTab) })} className="mb-6">
        <TabsList>
          <TabsTrigger value="uva">UVA</TabsTrigger>
          <TabsTrigger value="zm">ZM</TabsTrigger>
          <TabsTrigger value="ear">EAR</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "uva" && <UvaSection period={search.period} euIn021={search.eu ?? false} setSearch={setSearch} />}
      {tab === "zm" && <ZmSection period={search.period} setPeriod={(period) => setSearch({ period })} />}
      {tab === "ear" && <EarSection year={search.year} setYear={(year) => setSearch({ year })} />}
      <p className="mt-12 border-t pt-4 text-xs text-muted-foreground">
        Hilfe zur Vorbereitung der Meldungen in FinanzOnline bzw. für die Steuerberatung — keine Steuerberatung. Werte vor der
        Abgabe prüfen; Sonderfälle (Anzahlungen, Eigenverbrauch, Anlagen-AfA, Warenlieferungen ins Ausland) sind nicht abgebildet.
      </p>
    </Page>
  );
}
