import { DEFAULT_REPLAY_DISPLAY_SETTINGS } from "../../services/analysis/replay-display-settings";
import { DISPLAY_TOGGLES, displaySections, displayToggles } from "./display-rows";

describe("display rows", () => {
  it("the viewer shows timeline marks and no cursors", () => {
    expect(displaySections("viewer")).toEqual(["timing", "performance", "liveResults", "timelineMarks", "gameplayHud"]);
  });

  it("the clip shows cursors and no timeline marks", () => {
    expect(displaySections("clip")).toEqual(["timing", "performance", "liveResults", "gameplayHud", "cursors"]);
  });

  it("every toggle key is a boolean key of ReplayDisplaySettings and appears once per section", () => {
    const all: string[] = [];
    for (const [section, toggles] of Object.entries(DISPLAY_TOGGLES)) {
      const keys = toggles.map((toggle) => toggle.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const key of keys) {
        expect(typeof DEFAULT_REPLAY_DISPLAY_SETTINGS[key]).toBe("boolean");
        all.push(key);
      }
      expect(section).not.toBe("cursors");
    }
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(21);
  });

  it("uses the designed labels, with judgement colours on the result rows only", () => {
    expect(DISPLAY_TOGGLES.timing.map((t) => t.label)).toEqual(["Key overlay", "UR", "Bias", "UR bar"]);
    expect(DISPLAY_TOGGLES.performance.map((t) => t.label)).toEqual(["PP", "Star rating", "Max combo"]);
    expect(DISPLAY_TOGGLES.gameplayHud.map((t) => t.label)).toEqual(["Combo", "Accuracy"]);
    const results = ["100", "50", "Miss", "Slider break", "Slider tick", "Slider end"];
    expect(DISPLAY_TOGGLES.liveResults.map((t) => t.label)).toEqual(results);
    expect(DISPLAY_TOGGLES.timelineMarks.map((t) => t.label)).toEqual(results);
    expect(DISPLAY_TOGGLES.liveResults.map((t) => t.color)).toEqual(DISPLAY_TOGGLES.timelineMarks.map((t) => t.color));
    expect(DISPLAY_TOGGLES.liveResults.every((t) => typeof t.color === "string")).toBe(true);
    const plain = [...DISPLAY_TOGGLES.timing, ...DISPLAY_TOGGLES.performance, ...DISPLAY_TOGGLES.gameplayHud];
    expect(plain.every((t) => t.color === undefined)).toBe(true);
  });

  it("offers Max combo to the exported clip only, after Star rating, under a label of its own", () => {
    const clip = displayToggles("performance", "clip");
    const viewer = displayToggles("performance", "viewer");
    expect(clip.map((t) => [t.key, t.label])).toEqual([
      ["performancePointsEnabled", "PP"],
      ["starRatingEnabled", "Star rating"],
      ["maxComboEnabled", "Max combo"],
    ]);
    expect(viewer.map((t) => t.label)).toEqual(["PP", "Star rating"]);
    expect(viewer.some((t) => t.key === "maxComboEnabled")).toBe(false);
    // The HUD's own Combo toggle is another key, so the two labels must differ.
    expect(DISPLAY_TOGGLES.gameplayHud.map((t) => t.label)).not.toContain("Max combo");
    for (const section of ["timing", "liveResults", "timelineMarks", "gameplayHud"] as const) {
      expect(displayToggles(section, "viewer")).toEqual(DISPLAY_TOGGLES[section]);
      expect(displayToggles(section, "clip")).toEqual(DISPLAY_TOGGLES[section]);
    }
  });
});
