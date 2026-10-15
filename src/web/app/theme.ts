import { useCallback, useSyncExternalStore } from "react";

// Color theme: "light" | "dark" | "system" (default), stored per browser in localStorage. index.html applies the
// class "dark" on <html> before the first paint (same key and logic as `apply` below), so there is no flash.

export type ThemePref = "light" | "dark" | "system";

const KEY = "nesev-theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function resolve(pref: ThemePref): "light" | "dark" {
  return pref === "system" ? (media().matches ? "dark" : "light") : pref;
}

function apply() {
  document.documentElement.classList.toggle("dark", resolve(readThemePref()) === "dark");
  for (const l of listeners) l();
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // storage blocked: the choice lasts for this page only
  }
  apply();
}

let started = false;
function subscribe(listener: () => void) {
  if (!started) {
    started = true;
    media().addEventListener("change", apply);
    window.addEventListener("storage", (e) => e.key === KEY && apply());
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current preference and the resolved theme; re-renders on changes (incl. OS switch and other tabs). */
export function useTheme() {
  const pref = useSyncExternalStore(subscribe, readThemePref);
  const resolved = useSyncExternalStore(subscribe, () => resolve(readThemePref()));
  const set = useCallback((p: ThemePref) => setThemePref(p), []);
  return { pref, resolved, setPref: set };
}
