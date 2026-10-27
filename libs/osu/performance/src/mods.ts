import type { LazerMod } from "@osujs/core";
import type { PerformanceMode } from "./types";

/** Keep settings and source order; NC/PF already include DT/SD. Shared by viewer and library. */
export function normalizePerformanceMods(source: readonly LazerMod[], mode: PerformanceMode): LazerMod[] {
  const acronyms = new Set(source.map(mod => mod.acronym));
  return source.filter(mod => mode !== "stable" || mod.acronym !== "CL")
    .filter(mod => !(mod.acronym === "DT" && acronyms.has("NC")))
    .filter(mod => !(mod.acronym === "SD" && acronyms.has("PF")))
    .map(mod => ({ ...mod, ...(mod.settings ? { settings: { ...mod.settings } } : {}) }));
}
