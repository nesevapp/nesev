/** Countries offered in pickers (German names). Extend as needed. */
export const COUNTRY_NAMES: Record<string, string> = {
  AT: "Österreich",
  DE: "Deutschland",
  CH: "Schweiz",
  LI: "Liechtenstein",
  IT: "Italien",
  SI: "Slowenien",
  HU: "Ungarn",
  CZ: "Tschechien",
  SK: "Slowakei",
  FR: "Frankreich",
  NL: "Niederlande",
  BE: "Belgien",
  LU: "Luxemburg",
  DK: "Dänemark",
  SE: "Schweden",
  FI: "Finnland",
  IE: "Irland",
  ES: "Spanien",
  PT: "Portugal",
  PL: "Polen",
  HR: "Kroatien",
  RO: "Rumänien",
  BG: "Bulgarien",
  GR: "Griechenland",
  CY: "Zypern",
  MT: "Malta",
  EE: "Estland",
  LV: "Lettland",
  LT: "Litauen",
  GB: "Vereinigtes Königreich",
  NO: "Norwegen",
  US: "Vereinigte Staaten",
};

/** AT, DE, CH first, then alphabetical by German name. */
export const COUNTRY_OPTIONS = Object.entries(COUNTRY_NAMES)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => {
    const pin = ["AT", "DE", "CH"];
    const pa = pin.indexOf(a.code);
    const pb = pin.indexOf(b.code);
    if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    return a.name.localeCompare(b.name, "de");
  });

export function countryName(code: string): string {
  return COUNTRY_NAMES[code.toUpperCase()] ?? code;
}

