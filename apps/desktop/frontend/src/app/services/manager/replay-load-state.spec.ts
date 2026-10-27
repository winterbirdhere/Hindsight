import { formatReplayMods, IDLE_LOAD_STATE, loadFraction, loadStepRows, ReplayLoadState } from "./replay-load-state";

const loading = (state: Partial<ReplayLoadState>): ReplayLoadState => ({ phase: "loading", ...state });

describe("replay load state", () => {
  it("starts idle with four pending rows and no progress", () => {
    expect(IDLE_LOAD_STATE).toEqual({ phase: "idle" });
    expect(Object.isFrozen(IDLE_LOAD_STATE)).toBe(true);
    expect(loadStepRows(IDLE_LOAD_STATE)).toEqual([
      { label: "Reading replay file", status: "pending" },
      { label: "Finding beatmap in Songs", status: "pending" },
      { label: "Simulating", status: "pending" },
      { label: "Explaining misses", status: "pending" },
    ]);
    expect(loadFraction(IDLE_LOAD_STATE)).toBe(0);
  });

  it("marks the first row active while the replay file is read", () => {
    const state = loading({ step: "read-replay", fileName: "a.osr" });
    expect(loadStepRows(state)).toEqual([
      { label: "Reading replay file", status: "active" },
      { label: "Finding beatmap in Songs", status: "pending" },
      { label: "Simulating", status: "pending" },
      { label: "Explaining misses", status: "pending" },
    ]);
    expect(loadFraction(state)).toBe(0);
  });

  it("marks the replay read and the beatmap search active at the second step", () => {
    const state = loading({ step: "find-beatmap", ruleset: "Stable" });
    expect(loadStepRows(state)).toEqual([
      { label: "Read replay file", status: "done" },
      { label: "Finding beatmap in Songs", status: "active" },
      { label: "Simulating with Stable rules", status: "pending" },
      { label: "Explaining misses", status: "pending" },
    ]);
    expect(loadFraction(state)).toBe(0.25);
  });

  it.each([
    ["Stable", "Simulating with Stable rules"],
    ["Lazer", "Simulating with Lazer rules"],
    [undefined, "Simulating"],
  ] as const)("names the simulation step for the %s ruleset", (ruleset, label) => {
    const state = loading({ step: "simulate", ruleset });
    expect(loadStepRows(state)).toEqual([
      { label: "Read replay file", status: "done" },
      { label: "Found beatmap in Songs", status: "done" },
      { label, status: "active" },
      { label: "Explaining misses", status: "pending" },
    ]);
    expect(loadFraction(state)).toBe(0.5);
  });

  it("never shows the miss explanation as done or active", () => {
    for (const step of ["read-replay", "find-beatmap", "simulate"] as const) {
      expect(loadStepRows(loading({ step }))[3]).toEqual({ label: "Explaining misses", status: "pending" });
    }
  });

  it.each(["failed", "ready"] as const)("shows four pending rows and no progress in the %s phase", (phase) => {
    const state: ReplayLoadState = { phase, step: "simulate", ruleset: "Lazer" };
    expect(loadStepRows(state).map((row) => row.status)).toEqual(["pending", "pending", "pending", "pending"]);
    expect(loadFraction(state)).toBe(0);
  });

  it("treats a loading state without a step as pending", () => {
    expect(loadStepRows(loading({})).map((row) => row.status)).toEqual(["pending", "pending", "pending", "pending"]);
    expect(loadFraction(loading({}))).toBe(0);
  });

  it("formats mods like the readout does", () => {
    expect(formatReplayMods([])).toBe("NM");
    expect(formatReplayMods(["HIDDEN", "DOUBLE_TIME"])).toBe("HDDT");
    expect(formatReplayMods([], [{ acronym: "HD" }, { acronym: "DT" }])).toBe("HDDT");
  });
});
