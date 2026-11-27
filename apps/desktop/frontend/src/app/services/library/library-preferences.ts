import { LIBRARY_SORTS, type LibrarySort } from "../../../../../shared/library-query";

/** Deliberate startup choices only. Queries, names, scopes and selection stay out. */
export interface LibraryPreferences {
  view: "grid" | "list";
  sort: LibrarySort;
  direction: "asc" | "desc";
  me: boolean;
  sidebarShown: boolean;
}
export function normalizeLibraryPreferences(value: unknown): LibraryPreferences {
  const saved = value && typeof value === "object" ? value as Partial<LibraryPreferences> : {};
  const sort = typeof saved.sort === "string" && Object.prototype.hasOwnProperty.call(LIBRARY_SORTS, saved.sort)
    ? saved.sort : "pp";
  return {
    view: saved.view === "list" ? "list" : "grid",
    sort,
    direction: saved.direction === "asc" || saved.direction === "desc" ? saved.direction : LIBRARY_SORTS[sort].direction,
    me: saved.me === true,
    sidebarShown: saved.sidebarShown !== false,
  };
}
export function readLibraryPreferences(): LibraryPreferences {
  try { return normalizeLibraryPreferences(JSON.parse(window.localStorage.getItem("library-layout") ?? "null")); }
  catch { return normalizeLibraryPreferences(null); }
}
export function saveLibraryPreferences(preferences: LibraryPreferences): void {
  try { window.localStorage.setItem("library-layout", JSON.stringify(normalizeLibraryPreferences(preferences))); }
  catch { /* Unavailable preference storage must not prevent using the library. */ }
}
