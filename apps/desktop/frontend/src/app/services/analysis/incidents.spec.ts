import type { ReplayAnalysisEvent } from "@osujs/core";
import type { ErrorAtom } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ErrorInventory";
import type { MissExplanationSessionState } from "./miss-explanation/MissExplanationSession";
import type { ReplayError } from "./replay-events";
import {
  buildDensityBins,
  errorIndexAtOrBefore,
  formatIncidentLabel,
  groupIncidents,
  incidentIndexOf,
} from "./incidents";

const miss = (hitObjectId: string, time: number, sliderId?: string): ReplayError => ({
  id: `miss:${hitObjectId}`,
  time,
  type: "MISS",
  hitObjectId,
  ...(sliderId ? { sliderId } : {}),
});
const sliderBreak = (sliderId: string, time: number): ReplayError => ({
  id: `stable:break:${sliderId}/HEAD`,
  time,
  type: "SLIDER_BREAK",
  hitObjectId: `${sliderId}/HEAD`,
  sliderId,
});
const judgement = (hitObjectId: string, time: number, blocker?: string, extra = {}): ReplayAnalysisEvent =>
  ({
    type: "HitObjectJudgement",
    hitObjectId,
    eventId: `stable:judgement:${hitObjectId}`,
    time,
    objectTime: time,
    judgementTime: time,
    ruleset: "stable",
    position: { x: 0, y: 0 },
    verdict: "MISS",
    ...(blocker
      ? {
          notelockCause: {
            kind: "STABLE_BLOCKED_VALID_PRESS",
            targetHitObjectId: hitObjectId,
            blockerHitObjectId: blocker,
            pressTime: time,
            cursorDistance: 1,
            objectRadius: 30,
            wouldHaveHit: "GREAT",
          },
        }
      : {}),
    ...extra,
  } as ReplayAnalysisEvent);
const ids = (incidents: ReturnType<typeof groupIncidents>) => incidents.map((incident) => incident.errorIndices);

describe("groupIncidents", () => {
  it("groups a large event batch without scanning the complete event array for every error", () => {
    const errors = Array.from({ length: 120 }, (_, i) => miss(String(i), 1000 + i * 100));
    const events = errors.map((error, i) => judgement(String(i), error.time, i ? String(i - 1) : undefined));
    const scan = jest.spyOn(events, "filter");
    try {
      expect(ids(groupIncidents(errors, events, "stable"))).toEqual([errors.map((_, i) => i)]);
      expect(scan).not.toHaveBeenCalled();
      // A new batch must see in-place mutation of caller-owned event arrays.
      events.push({ ...events[1] });
      expect(ids(groupIncidents(errors, events, "stable"))).toEqual([[0], errors.slice(1).map((_, i) => i + 1)]);
    } finally { scan.mockRestore(); }
  });
  it("keeps every error alone when nothing links them", () => {
    const errors = [miss("1", 1000), miss("2", 1100), sliderBreak("3", 1200)];
    const events = [judgement("1", 1000), judgement("2", 1100)];
    expect(ids(groupIncidents(errors, events, "stable"))).toEqual([[0], [1], [2]]);
  });

  it("links a notelocked miss to the earlier error that owns the blocker, with no analysis at all", () => {
    const errors = [miss("1", 1000), miss("2", 1100)];
    const events = [judgement("1", 1000), judgement("2", 1100, "1")];
    const incidents = groupIncidents(errors, events, "stable", { status: "building" });
    expect(ids(incidents)).toEqual([[0, 1]]);
    expect(incidents[0]).toMatchObject({
      id: "miss:1",
      leadIndex: 0,
      links: [{ from: 0, to: 1, kind: "notelock", source: "simulator" }],
    });
  });

  it("links across an unrelated error and keeps the unrelated one alone", () => {
    const errors = [miss("1", 1000), miss("9", 1050), miss("2", 1100)];
    const events = [judgement("1", 1000), judgement("9", 1050), judgement("2", 1100, "1")];
    expect(ids(groupIncidents(errors, events, "stable"))).toEqual([[0, 2], [1]]);
  });

  it("finds a slider-head blocker through the slider's own error", () => {
    const errors = [sliderBreak("7", 1000), miss("8", 1100)];
    const events = [judgement("8", 1100, "7/HEAD")];
    expect(ids(groupIncidents(errors, events, "stable"))).toEqual([[0, 1]]);
  });

  it("does not link when the blocker was not an error", () => {
    const errors = [miss("2", 1100)];
    expect(ids(groupIncidents(errors, [judgement("2", 1100, "1")], "stable"))).toEqual([[0]]);
  });

  it("does not link to a later error, a duplicate judgement or another ruleset's event", () => {
    const later = [miss("2", 1100), miss("1", 1200)];
    expect(ids(groupIncidents(later, [judgement("2", 1100, "1"), judgement("1", 1200)], "stable"))).toEqual([[0], [1]]);
    const errors = [miss("1", 1000), miss("2", 1100)];
    const duplicate = [judgement("1", 1000), judgement("2", 1100, "1"), judgement("2", 1100, "1")];
    expect(ids(groupIncidents(errors, duplicate, "stable"))).toEqual([[0], [1]]);
    const lazerOnly = [judgement("1", 1000), judgement("2", 1100, "1", { ruleset: "lazer" })];
    expect(ids(groupIncidents(errors, lazerOnly, "stable"))).toEqual([[0], [1]]);
  });

  it("chains three errors into one incident", () => {
    const errors = [miss("1", 1000), miss("2", 1100), miss("3", 1200)];
    const events = [judgement("1", 1000), judgement("2", 1100, "1"), judgement("3", 1200, "2")];
    expect(ids(groupIncidents(errors, events, "stable"))).toEqual([[0, 1, 2]]);
  });

  it("lets a Stable slider-head break own the slider-parent blocker", () => {
    const errors = [sliderBreak("7", 1000), miss("8", 1100)];
    const incidents = groupIncidents(errors, [judgement("8", 1100, "7")], "stable");
    expect(ids(incidents)).toEqual([[0, 1]]);
  });

  it("lets a parent MISS own a /HEAD blocker", () => {
    const errors = [miss("7", 1000), miss("8", 1100)];
    expect(ids(groupIncidents(errors, [judgement("8", 1100, "7/HEAD")], "stable"))).toEqual([[0, 1]]);
  });

  it("never lets a tick error of the slider own its blocker", () => {
    const tick: ReplayError = {
      id: "lazer:component:7/1",
      time: 1000,
      type: "SLIDER_COMPONENT_MISS",
      sliderId: "7",
      sliderComponentType: "TICK",
    };
    const errors = [tick, miss("8", 1100)];
    expect(ids(groupIncidents(errors, [judgement("8", 1100, "7")], "stable"))).toEqual([[0], [1]]);
    expect(ids(groupIncidents(errors, [judgement("8", 1100, "7/HEAD")], "stable"))).toEqual([[0], [1]]);
  });

  it("prefers the exact owner over a later tick error of the same slider", () => {
    const tick: ReplayError = {
      id: "lazer:component:7/1",
      time: 1050,
      type: "SLIDER_COMPONENT_MISS",
      sliderId: "7",
      sliderComponentType: "TICK",
    };
    const errors = [miss("7/HEAD", 1000), tick, miss("8", 1100)];
    expect(ids(groupIncidents(errors, [judgement("8", 1100, "7/HEAD")], "stable"))).toEqual([[0, 2], [1]]);
  });

  it("links a Lazer slider-head component miss through its own judgement", () => {
    const head: ReplayError = {
      id: "lazer:component:7/HEAD",
      time: 1100,
      type: "SLIDER_COMPONENT_MISS",
      sliderId: "7",
      sliderComponentType: "HEAD",
    };
    const errors = [miss("5", 1000), head];
    const events = [
      {
        type: "SliderComponentMiss",
        eventId: head.id,
        componentId: "7/HEAD",
        ruleset: "lazer",
        time: 1100,
      } as unknown as ReplayAnalysisEvent,
      judgement("7/HEAD", 1100, "5", { ruleset: "lazer", eventId: "lazer:judgement:7/HEAD" }),
    ];
    const incidents = groupIncidents(errors, events, "lazer");
    expect(ids(incidents)).toEqual([[0, 1]]);
    expect(incidents[0].links).toEqual([{ from: 0, to: 1, kind: "notelock", source: "simulator" }]);
  });

  it("ignores a miss whose only judgement does not affect accuracy", () => {
    const errors = [miss("1", 1000), miss("2", 1100)];
    const events = [judgement("1", 1000), judgement("2", 1100, "1", { affectsAccuracy: false })];
    expect(ids(groupIncidents(errors, events, "stable"))).toEqual([[0], [1]]);
  });

  it("returns no incidents for no errors", () => {
    expect(groupIncidents([], [], "stable")).toEqual([]);
  });
});

// A Stable slider-head break has no simulator notelock event; only the analysis can prove its blocker.
const headBreak = (sliderId: string, time: number): ReplayError => ({
  id: `stable:slider-break:${sliderId}/HEAD`,
  time,
  type: "SLIDER_BREAK",
  hitObjectId: `${sliderId}/HEAD`,
  sliderId,
});
const breakEvent = (sliderId: string, time: number): ReplayAnalysisEvent =>
  ({
    type: "SliderBreak",
    componentId: `${sliderId}/HEAD`,
    sliderId,
    componentType: "HEAD",
    eventId: `stable:slider-break:${sliderId}/HEAD`,
    time,
    objectTime: time,
    judgementTime: time,
    ruleset: "stable",
    position: { x: 0, y: 0 },
  } as ReplayAnalysisEvent);
/** One primary atom per target, each classified as a supported notelock with the given blocker ids. */
function analysisSession(
  targets: { componentId: string; time: number; blockers: string[] }[],
  profile = "stable",
): MissExplanationSessionState {
  const atoms = targets.map(
    ({ componentId, time }) =>
      ({
        id: `atom:${componentId}`,
        componentId,
        parentId: componentId.split("/")[0],
        component: componentId.endsWith("/HEAD") ? "slider-head" : "circle",
        result: "MISS",
        role: "primary",
        identity: { analysisProfileId: profile },
        objectTimeMs: time,
        resolutionTimeMs: time,
        relatedAtomIds: [],
        pendingContributionIds: [],
      } as unknown as ErrorAtom),
  );
  return {
    status: "partial",
    identity: { analysisProfileId: profile },
    analysis: {
      inventory: { atoms },
      classifications: targets.map(({ componentId, blockers }) => ({
        atomId: `atom:${componentId}`,
        mechanism: {
          status: "supported",
          codes: ["notelock"],
          headline: "Notelock",
          description: "",
          eventIds: [],
          limitations: [],
          diagnostics: {
            opportunities: [],
            primary: { directRejections: blockers.map((blockerId, index) => ({ blockerId, inputId: `r${index}` })) },
          },
        },
      })),
      incidents: [],
      excludedModelAtomIds: [],
    },
  } as unknown as MissExplanationSessionState;
}

describe("groupIncidents with analysis-proven notelock links", () => {
  const errors = [miss("6", 900), headBreak("7", 1000)];
  const events = [judgement("6", 900), breakEvent("7", 1000)];
  const proven = analysisSession([{ componentId: "7/HEAD", time: 1000, blockers: ["6", "6"] }]);

  it("links a Stable slider-head break to the preceding miss that the analysis names as its blocker", () => {
    const incidents = groupIncidents(errors, events, "stable", proven);
    expect(incidents).toEqual([
      {
        id: "miss:6",
        errorIndices: [0, 1],
        leadIndex: 0,
        links: [{ from: 0, to: 1, kind: "notelock", source: "analysis" }],
      },
    ]);
  });

  it("keeps the pair apart while the analysis is absent, pending, failed or unsupported", () => {
    const simulatorOnly = groupIncidents(errors, events, "stable");
    expect(ids(simulatorOnly)).toEqual([[0], [1]]);
    const states: MissExplanationSessionState[] = [
      { status: "empty" },
      { status: "not-captured", reasons: [] },
      { status: "building" },
      { status: "error", reasons: [] },
      { status: "unsupported", reasons: [] },
    ];
    for (const state of states) expect(groupIncidents(errors, events, "stable", state)).toEqual(simulatorOnly);
  });

  it("keeps the pair apart when the analysis belongs to another profile", () => {
    const lazer = analysisSession([{ componentId: "7/HEAD", time: 1000, blockers: ["6"] }], "lazer");
    expect(groupIncidents(errors, events, "stable", lazer)).toEqual(groupIncidents(errors, events, "stable"));
  });

  it("keeps the pair apart when the rejections name two blockers", () => {
    const two = analysisSession([{ componentId: "7/HEAD", time: 1000, blockers: ["6", "5"] }]);
    expect(ids(groupIncidents([miss("5", 800), ...errors], [judgement("5", 800), ...events], "stable", two))).toEqual([
      [0],
      [1],
      [2],
    ]);
  });

  it("does not consult the analysis for an error that has a simulator link", () => {
    const three = [miss("1", 800), miss("2", 900), miss("3", 1000)];
    const simulator = [judgement("1", 800), judgement("2", 900), judgement("3", 1000, "2")];
    const disagreeing = analysisSession([{ componentId: "3", time: 1000, blockers: ["1"] }]);
    const incidents = groupIncidents(three, simulator, "stable", disagreeing);
    expect(ids(incidents)).toEqual([[0], [1, 2]]);
    expect(incidents[1].links).toEqual([{ from: 1, to: 2, kind: "notelock", source: "simulator" }]);
  });

  it("does not consult the analysis when the simulator named a blocker that is not an error", () => {
    const two = [miss("1", 800), miss("3", 1000)];
    const simulator = [judgement("1", 800), judgement("3", 1000, "2")];
    const disagreeing = analysisSession([{ componentId: "3", time: 1000, blockers: ["1"] }]);
    expect(ids(groupIncidents(two, simulator, "stable", disagreeing))).toEqual([[0], [1]]);
  });

  it("links a plain miss through the analysis when the simulator recorded no notelock for it", () => {
    const two = [miss("1", 800), miss("3", 1000)];
    const simulator = [judgement("1", 800), judgement("3", 1000)];
    const session = analysisSession([{ componentId: "3", time: 1000, blockers: ["1"] }]);
    const incidents = groupIncidents(two, simulator, "stable", session);
    expect(ids(incidents)).toEqual([[0, 1]]);
    expect(incidents[0].links).toEqual([{ from: 0, to: 1, kind: "notelock", source: "analysis" }]);
  });

  it("does not link when the analysis blocker is not an error, or only a later one", () => {
    const absent = analysisSession([{ componentId: "7/HEAD", time: 1000, blockers: ["5"] }]);
    expect(ids(groupIncidents(errors, events, "stable", absent))).toEqual([[0], [1]]);
    const later = [headBreak("7", 1000), miss("6", 1100)];
    const laterEvents = [breakEvent("7", 1000), judgement("6", 1100)];
    expect(ids(groupIncidents(later, laterEvents, "stable", proven))).toEqual([[0], [1]]);
  });

  it("never lets a tick error of the blocker slider own an analysis blocker", () => {
    const tick: ReplayError = {
      id: "lazer:component:6/1",
      time: 900,
      type: "SLIDER_COMPONENT_MISS",
      sliderId: "6",
      sliderComponentType: "TICK",
    };
    expect(ids(groupIncidents([tick, headBreak("7", 1000)], [breakEvent("7", 1000)], "stable", proven))).toEqual([
      [0],
      [1],
    ]);
  });

  it("joins simulator and analysis links into one chain and records each source", () => {
    const chain = [miss("5", 800), miss("6", 900), headBreak("7", 1000), miss("8", 1100)];
    const chainEvents = [
      judgement("5", 800),
      judgement("6", 900, "5"),
      breakEvent("7", 1000),
      judgement("8", 1100, "7"),
    ];
    const incidents = groupIncidents(chain, chainEvents, "stable", proven);
    expect(ids(incidents)).toEqual([[0, 1, 2, 3]]);
    expect(incidents[0].links).toEqual([
      { from: 0, to: 1, kind: "notelock", source: "simulator" },
      { from: 1, to: 2, kind: "notelock", source: "analysis" },
      { from: 2, to: 3, kind: "notelock", source: "simulator" },
    ]);
  });

  it("does not merge independent errors that share a cause label or sit close in time", () => {
    const dense = [miss("1", 1000), headBreak("2", 1001), miss("3", 1002), headBreak("4", 1003)];
    const denseEvents = [judgement("1", 1000), breakEvent("2", 1001), judgement("3", 1002), breakEvent("4", 1003)];
    const unrelated = analysisSession([
      { componentId: "2/HEAD", time: 1001, blockers: ["0"] },
      { componentId: "4/HEAD", time: 1003, blockers: ["0"] },
    ]);
    expect(ids(groupIncidents(dense, denseEvents, "stable", unrelated))).toEqual([[0], [1], [2], [3]]);
  });

  it("does not mutate its inputs", () => {
    const before = JSON.stringify([errors, events, proven]);
    groupIncidents(errors, events, "stable", proven);
    expect(JSON.stringify([errors, events, proven])).toBe(before);
  });
});

describe("incident helpers", () => {
  it("formats contiguous, single and gapped labels", () => {
    expect(formatIncidentLabel(3, [4, 5], 18)).toBe("INCIDENT 3 · ERRORS 5–6 OF 18");
    expect(formatIncidentLabel(3, [4], 18)).toBe("INCIDENT 3 · ERROR 5 OF 18");
    expect(formatIncidentLabel(3, [4, 6], 18)).toBe("INCIDENT 3 · ERRORS 5, 7 OF 18");
    expect(formatIncidentLabel(3, [4, 5, 7], 18)).toBe("INCIDENT 3 · ERRORS 5, 6, 8 OF 18");
  });

  it("finds the incident of an error", () => {
    const incidents = groupIncidents(
      [miss("1", 1000), miss("9", 1050), miss("2", 1100)],
      [judgement("1", 1000), judgement("9", 1050), judgement("2", 1100, "1")],
      "stable",
    );
    expect(incidentIndexOf(incidents, 2)).toBe(0);
    expect(incidentIndexOf(incidents, 1)).toBe(1);
    expect(incidentIndexOf(incidents, 5)).toBe(-1);
  });

  it("follows the playhead to the error at or before it", () => {
    const errors = [miss("1", 1000), miss("2", 2000)];
    expect(errorIndexAtOrBefore(errors, 500)).toBe(0);
    expect(errorIndexAtOrBefore(errors, 1000)).toBe(0);
    expect(errorIndexAtOrBefore(errors, 1999)).toBe(1);
    expect(errorIndexAtOrBefore(errors, 9999)).toBe(1);
    expect(errorIndexAtOrBefore([], 100)).toBe(-1);
  });

  it("bins incidents by their lead error like the mock", () => {
    const errors = [miss("1", 0), sliderBreak("2", 1000), miss("3", 1010), miss("4", 59_999)];
    const incidents = groupIncidents(errors, [], "stable");
    const bins = buildDensityBins(incidents, errors, 60_000);
    expect(bins).toHaveLength(60);
    expect(bins[0]).toEqual({ count: 1, height: 9, tone: "miss", leadIndices: [0] });
    expect(bins[1]).toEqual({ count: 2, height: 13, tone: "miss", leadIndices: [1, 2] });
    expect(bins[2]).toEqual({ count: 0, height: 1, tone: "empty", leadIndices: [] });
    expect(bins[59].count).toBe(1);
  });

  it("caps the bar height, colours break-only bins and survives a zero duration", () => {
    const many = Array.from({ length: 5 }, (_, index) => sliderBreak(String(index), 10 + index));
    const bins = buildDensityBins(groupIncidents(many, [], "stable"), many, 60_000);
    expect(bins[0]).toMatchObject({ count: 5, height: 16, tone: "break" });
    const zero = buildDensityBins(groupIncidents(many, [], "stable"), many, 0);
    expect(zero[0].count).toBe(5);
    expect(zero.slice(1).every((bin) => bin.count === 0)).toBe(true);
  });

  it("puts leads outside the map in the end bins and survives a non-finite lead time", () => {
    const errors = [miss("1", -500), miss("2", 90_000), miss("3", NaN)];
    const bins = buildDensityBins(groupIncidents(errors, [], "stable"), errors, 60_000);
    expect(bins[59].count).toBe(1);
    expect(bins[0].count).toBe(2);
    expect(bins[0].leadIndices).toEqual([0, 2]);
  });
});
