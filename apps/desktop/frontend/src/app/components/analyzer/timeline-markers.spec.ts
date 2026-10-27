import type { ReplayAnalysisEvent } from "@osujs/core";
import { DEFAULT_REPLAY_DISPLAY_SETTINGS } from "../../services/analysis/replay-display-settings";
import { REWIND_COLORS } from "../../styles/tokens";
import { buildTimelineMarkerGroups, TIMELINE_MARKS } from "./timeline-markers";

describe("timeline marker groups", () => {
  it("keeps navigable error markers in the upper lane with slider marks slightly shorter than misses", () => {
    expect(buildTimelineMarkerGroups([], "stable").map((group) => group.tooltip)).toEqual([
      "Misses",
      "Slider Breaks",
      "50s",
      "100s",
    ]);
    expect(buildTimelineMarkerGroups([], "lazer").map((group) => group.tooltip)).toEqual([
      "Misses",
      "Slider Tick misses",
      "50s",
      "100s",
    ]);
    expect(buildTimelineMarkerGroups([], "stable").map((group) => group.placement)).toEqual([
      "above",
      "above",
      "below",
      "below",
    ]);
    expect(buildTimelineMarkerGroups([], "stable").slice(2).map((group) => group.markerHeight)).toEqual([14, 10]);
    expect(buildTimelineMarkerGroups([], "stable").every((group) => group.opacity === 1)).toBe(true);
    expect(buildTimelineMarkerGroups([], "stable").map((group) => group.markerWidth)).toEqual([2, 1.5, 1.5, 1]);
    expect(
      buildTimelineMarkerGroups([], "stable")
        .slice(0, 2)
        .map((group) => group.markerWidth),
    ).toEqual([2, 1.5]);
    expect(
      buildTimelineMarkerGroups([], "lazer")
        .slice(0, 2)
        .map((group) => group.markerWidth),
    ).toEqual([2, 1.5]);
    expect(
      buildTimelineMarkerGroups([], "stable")
        .slice(0, 2)
        .map((group) => group.markerHeight),
    ).toEqual([15, 11]);
    expect(
      buildTimelineMarkerGroups([], "lazer")
        .slice(0, 2)
        .map((group) => group.markerHeight),
    ).toEqual([15, 11]);
  });

  it("uses the 3a mark sizes", () => {
    expect(TIMELINE_MARKS).toEqual({
      miss: { width: 2, height: 15 },
      sliderBreak: { width: 1.5, height: 11 },
      meh: { width: 1.5, height: 14 },
      ok: { width: 1, height: 10 },
      sliderEnd: { width: 1, height: 10 },
    });
  });

  it("shows Stable and lazer SliderEnd misses in the lower lane only when enabled", () => {
    const stableTail: ReplayAnalysisEvent = {
      type: "CheckpointJudgement",
      eventId: "stable-tail",
      ruleset: "stable",
      time: 10_000,
      objectTime: 9_000,
      judgementTime: 10_000,
      sliderEndTime: 10_000,
      sliderId: "stable-slider",
      checkpointId: "stable-tail-checkpoint",
      checkpointType: "LAST_LEGACY_TICK",
      position: { x: 256, y: 192 },
      hit: false,
      isLastTick: true,
    };
    const lazerTail: ReplayAnalysisEvent = {
      type: "SliderComponentMiss",
      eventId: "lazer-tail",
      ruleset: "lazer",
      time: 20_000,
      objectTime: 20_000,
      judgementTime: 20_000,
      sliderId: "lazer-slider",
      componentId: "lazer-slider/TAIL",
      componentType: "TAIL",
      position: { x: 256, y: 192 },
    };

    const stableGroups = buildTimelineMarkerGroups([stableTail], "stable");
    const lazerGroups = buildTimelineMarkerGroups([lazerTail], "lazer");

    expect(stableGroups.map((group) => group.tooltip)).not.toContain("SliderEnd misses");
    expect(lazerGroups.map((group) => group.tooltip)).not.toContain("SliderEnd misses");
    expect(stableGroups.flatMap((group) => group.timings)).not.toContain(10_000);
    expect(lazerGroups.flatMap((group) => group.timings)).not.toContain(20_000);

    const displaySettings = { ...DEFAULT_REPLAY_DISPLAY_SETTINGS, timelineSliderEndEnabled: true };
    const events = [stableTail, lazerTail];
    expect(
      buildTimelineMarkerGroups(events, "stable", displaySettings).find(
        (group) => group.tooltip === "SliderEnd misses",
      ),
    ).toEqual({
      color: REWIND_COLORS.sliderEnd,
      timings: [10_000],
      tooltip: "SliderEnd misses",
      markerWidth: 1,
      markerHeight: 10,
      placement: "below",
      opacity: 1,
    });
    expect(
      buildTimelineMarkerGroups(events, "lazer", displaySettings).find((group) => group.tooltip === "SliderEnd misses"),
    ).toMatchObject({ timings: [20_000], placement: "below", color: REWIND_COLORS.sliderEnd });
    expect(stableGroups.find((group) => group.tooltip === "Slider Breaks")?.color).toBe(REWIND_COLORS.sliderBreak);
    expect(lazerGroups.find((group) => group.tooltip === "Slider Tick misses")?.color).toBe(
      REWIND_COLORS.sliderBreak,
    );
  });

  it.each([
    ["timeline100Enabled", "100s"],
    ["timeline50Enabled", "50s"],
    ["timelineMissEnabled", "Misses"],
    ["timelineSliderBreakEnabled", "Slider Breaks"],
    ["timelineSliderTickEnabled", "Slider Tick misses"],
    ["timelineSliderEndEnabled", "SliderEnd misses"],
  ] as const)("filters %s independently in both rulesets", (setting, tooltip) => {
    const allEnabled = { ...DEFAULT_REPLAY_DISPLAY_SETTINGS, timelineSliderEndEnabled: true };
    const displaySettings = { ...allEnabled, [setting]: false };

    for (const ruleset of ["stable", "lazer"] as const) {
      const allGroups = buildTimelineMarkerGroups([], ruleset, allEnabled);
      expect(buildTimelineMarkerGroups([], ruleset, displaySettings)).toEqual(
        allGroups.filter((group) => group.tooltip !== tooltip),
      );
    }
  });

  it("draws slider-end misses after 100s so the taller 50 tips stay visible", () => {
    const all = { ...DEFAULT_REPLAY_DISPLAY_SETTINGS, timelineSliderEndEnabled: true };
    expect(buildTimelineMarkerGroups([], "stable", all).map((group) => group.tooltip)).toEqual([
      "Misses",
      "Slider Breaks",
      "50s",
      "100s",
      "SliderEnd misses",
    ]);
  });
});
