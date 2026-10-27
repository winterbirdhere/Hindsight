import { errorCapabilities } from "../src/gameplay/error-analysis/ErrorCapabilities";
import { traceBeatmap, traceMapText } from "./ReplayTraceFixtures";
import { buildBeatmap } from "../src/beatmap/BeatmapBuilder";
import { parseBlueprint } from "../src/blueprint/BlueprintParser";
describe("analysis capabilities are facets, not a No-Mod switch", () => {
  it.each([
    "HIDDEN",
    "FLASH_LIGHT",
    "HARD_ROCK",
    "EASY",
    "DOUBLE_TIME",
    "NIGHT_CORE",
    "HALF_TIME",
    "NO_FAIL",
    "SUDDEN_DEATH",
    "PERFECT",
    "SCORE_V2",
    "TOUCH_DEVICE",
  ] as const)("retains prepared %s geometry and scoring", (mod) => {
    const map = traceBeatmap("300,192,1000,1,0");
    map.appliedMods.push(mod);
    expect(errorCapabilities(map, "stable")).toMatchObject({
      scoring: "supported",
      geometry: "supported",
      tapping: "manual",
      tracking: "supported",
    });
  });
  it.each([
    ["RELAX", "automated", "manual"],
    ["AUTO_PILOT", "manual", "automated"],
    ["AUTO_PLAY", "automated", "automated"],
  ] as const)("separates automated facets for %s", (mod, tapping, aim) => {
    const map = traceBeatmap("300,192,1000,1,0");
    map.appliedMods.push(mod);
    expect(errorCapabilities(map, "stable")).toMatchObject({ tapping, aim });
  });
  it("admits Classic head accuracy and notelock independently, and rejects unknown mechanics", () => {
    const mods = [{ acronym: "CL", settings: { no_slider_head_accuracy: false, classic_note_lock: true } }];
    const map = buildBeatmap(parseBlueprint(traceMapText("300,192,1000,1,0")), { lazerMods: mods });
    expect(errorCapabilities(map, "lazer").scoring).toBe("supported");
    const unknown = buildBeatmap(parseBlueprint(traceMapText("300,192,1000,1,0")), {
      lazerMods: [...mods, { acronym: "WIGGLE" }],
    });
    expect(errorCapabilities(unknown, "lazer").scoring).toBe("unsupported");
  });
});
