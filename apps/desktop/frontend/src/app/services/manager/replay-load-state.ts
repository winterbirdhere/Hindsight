import { buildFullMapReplayMods } from "../analysis/full-map-analysis-view-model";

export type ReplayLoadStep = "read-replay" | "find-beatmap" | "simulate";

export interface LoadedMap {
  artist?: string;
  title: string;
  difficulty?: string;
  mapper?: string;
}

export type ReplayLoadFailure =
  | { kind: "beatmap-not-found"; lookup: "found" | "not-found" | "unavailable"; beatmapUrl?: string }
  | { kind: "other"; message: string };

export interface ReplayLoadState {
  phase: "idle" | "loading" | "failed" | "ready";
  /** The step in progress; loading only. */
  step?: ReplayLoadStep;
  /** Basename of the .osr path. */
  fileName?: string;
  player?: string;
  /** "NM", "HDDT", ... */
  mods?: string;
  /** The ruleset the simulation will focus. */
  ruleset?: "Stable" | "Lazer";
  map?: LoadedMap;
  /** File URL of the map background, once the map is found. */
  backgroundUrl?: string;
  /** Failed only. */
  failure?: ReplayLoadFailure;
}

/** Frozen: it is the shared value of every idle `loadState$`. */
export const IDLE_LOAD_STATE: ReplayLoadState = Object.freeze({ phase: "idle" as const });

/** The same expression the readout uses for its mods text. */
export function formatReplayMods(
  mods: Parameters<typeof buildFullMapReplayMods>[0],
  lazerMods?: Parameters<typeof buildFullMapReplayMods>[1],
): string {
  return (
    buildFullMapReplayMods(mods ?? [], lazerMods ?? [])
      .map((mod) => mod.acronym)
      .join("") || "NM"
  );
}

export interface LoadStepRow {
  label: string;
  status: "done" | "active" | "pending";
}

const STEP_ORDER: readonly ReplayLoadStep[] = ["read-replay", "find-beatmap", "simulate"];

function doneCount(state: ReplayLoadState): number {
  if (state.phase !== "loading" || state.step === undefined) return 0;
  return STEP_ORDER.indexOf(state.step);
}

export function loadStepRows(state: ReplayLoadState): LoadStepRow[] {
  const loading = state.phase === "loading" && state.step !== undefined;
  const done = doneCount(state);
  const status = (index: number): LoadStepRow["status"] =>
    !loading ? "pending" : index < done ? "done" : index === done ? "active" : "pending";
  const simulating = state.ruleset ? `Simulating with ${state.ruleset} rules` : "Simulating";
  return [
    { label: status(0) === "done" ? "Read replay file" : "Reading replay file", status: status(0) },
    { label: status(1) === "done" ? "Found beatmap in Songs" : "Finding beatmap in Songs", status: status(1) },
    { label: simulating, status: status(2) },
    // The M61 sidecar starts only after the replay is interactive, so this row is never started here.
    { label: "Explaining misses", status: "pending" },
  ];
}

export function loadFraction(state: ReplayLoadState): number {
  return doneCount(state) / 4;
}
