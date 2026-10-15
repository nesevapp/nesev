// Free-text units ("Std.", "Stk.", "Pauschal", ...) → UN/ECE Recommendation 20 codes, which EN 16931
// (BT-130) and ebInterface expect. Unknown units fall back to C62 ("one", a plain count).

const UNIT_CODES: [RegExp, string][] = [
  [/^(std|stunden?|h|hrs?|hours?)$/, "HUR"],
  [/^(min|minuten?|minutes?)$/, "MIN"],
  [/^(tage?|tg|d|days?|pt|personentage?|manntage?)$/, "DAY"],
  [/^(wochen?|wo|weeks?)$/, "WEE"],
  [/^(monate?|mon|mo|monat|months?)$/, "MON"],
  [/^(jahre?|j|years?|yrs?)$/, "ANN"],
  [/^(pauschal[e]?|psch|pausch|pa|lump ?sum|ls)$/, "LS"],
  [/^(km|kilometer)$/, "KMT"],
  [/^(m|meter)$/, "MTR"],
  [/^(m2|m²|qm)$/, "MTK"],
  [/^(kg|kilogramm)$/, "KGM"],
  [/^(g|gramm)$/, "GRM"],
  [/^(l|liter)$/, "LTR"],
  [/^(stk|stück|stueck|st|pcs?|pieces?)$/, "H87"],
  [/^(seiten?|pages?)$/, "C62"],
];

export function unitCode(unit: string): string {
  const key = unit.trim().toLowerCase().replace(/\.$/, "");
  if (!key) return "C62";
  // already a Rec 20 code (e.g. "HUR")
  if (/^[A-Z0-9]{2,3}$/.test(unit.trim()) && UNIT_CODES.some(([, c]) => c === unit.trim())) return unit.trim();
  return UNIT_CODES.find(([re]) => re.test(key))?.[1] ?? "C62";
}
