import type { ReplayAnalysisEvent } from "@osujs/core";
import type { ComponentMechanism } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ComponentMechanisms";
import type { ErrorAtom } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ErrorInventory";
import type { ErrorAnalysis } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ErrorAnalysis";
import { selectedErrorCauses } from "../../components/analyzer/error-cause";
import type { MissExplanationSessionState } from "./miss-explanation/MissExplanationSession";
import { matchErrorAtom } from "./error-atom-match";
import { summarizeReplayEvents } from "./replay-events";
import { createErrorAnalysisLookups } from "./error-analysis-lookups";

// The fixtures of components/analyzer/error-cause.spec.ts, so the matcher is held to the same cases.
const cause = (headline: string): ComponentMechanism => ({
  status: "supported",
  headline,
  codes: [headline],
  description: "Never render this",
  metric: { value: 99, unit: "ms" },
  eventIds: [],
  limitations: [],
});
const atom = (componentId: string, component: ErrorAtom["component"], extra = {}): ErrorAtom =>
  ({
    id: componentId,
    componentId,
    parentId: componentId.split("/")[0],
    component,
    result: "MISS",
    role: "primary",
    identity: { analysisProfileId: "stable" },
    objectTimeMs: 1000,
    resolutionTimeMs: 1100,
    relatedAtomIds: [],
    pendingContributionIds: [],
    ...extra,
  } as unknown as ErrorAtom);
const event = (
  componentId: string,
  type: "MISS" | "HEAD" | "TICK" | "REPEAT" | "TAIL",
  ruleset: "stable" | "lazer" = "stable",
): ReplayAnalysisEvent =>
  type === "MISS"
    ? {
        type: "HitObjectJudgement",
        hitObjectId: componentId,
        eventId: `${ruleset}:judgement:${componentId}`,
        time: 1100,
        objectTime: 1000,
        judgementTime: 1100,
        ruleset,
        position: { x: 0, y: 0 },
        verdict: "MISS",
      }
    : ({
        type: ruleset === "stable" ? "SliderBreak" : "SliderComponentMiss",
        componentId,
        sliderId: componentId.split("/")[0],
        componentType: type,
        eventId: `${ruleset}:component:${componentId}`,
        time: 1100,
        objectTime: 1000,
        judgementTime: 1100,
        ruleset,
        position: { x: 0, y: 0 },
      } as ReplayAnalysisEvent);
type Partial = Extract<MissExplanationSessionState, { status: "partial" }> & { analysis: ErrorAnalysis };
function session(atoms: ErrorAtom[], mechanisms = atoms.map(() => cause("Off track")), ruleset = "stable") {
  return {
    status: "partial",
    identity: { analysisProfileId: ruleset },
    analysis: {
      inventory: { atoms },
      classifications: atoms
        .filter((a) => a.role === "primary")
        .map((a, i) => ({ atomId: a.id, mechanism: mechanisms[i] })),
      incidents: [],
      excludedModelAtomIds: [],
    },
  } as unknown as Partial;
}
function both(
  events: ReplayAnalysisEvent[],
  value: MissExplanationSessionState,
  ruleset: "stable" | "lazer" = "stable",
) {
  const error = summarizeReplayEvents(events, ruleset).errors[0];
  const lookups = createErrorAnalysisLookups(events, ruleset, value);
  expect(matchErrorAtom(error, events, ruleset, value, lookups)).toEqual(matchErrorAtom(error, events, ruleset, value));
  expect(selectedErrorCauses(error, events, ruleset, value, lookups)).toEqual(
    selectedErrorCauses(error, events, ruleset, value),
  );
  return {
    match: matchErrorAtom(error, events, ruleset, value),
    causes: selectedErrorCauses(error, events, ruleset, value),
  };
}

describe("matchErrorAtom", () => {
  it("projects repeated errors without rescanning events, atoms or classifications", () => {
    const events = [event("0", "MISS")],
      value = session([atom("0", "circle")]);
    const error = summarizeReplayEvents(events, "stable").errors[0];
    const expected = selectedErrorCauses(error, events, "stable", value);
    const scans = [events, value.analysis.inventory.atoms, value.analysis.classifications].map((array) =>
      jest.spyOn(array, "filter"),
    );
    try {
      const lookups = createErrorAnalysisLookups(events, "stable", value);
      for (let i = 0; i < 20; i++) expect(selectedErrorCauses(error, events, "stable", value, lookups)).toEqual(expected);
      scans.forEach((scan) => expect(scan).not.toHaveBeenCalled());
    } finally { scans.forEach(scan => scan.mockRestore()); }
  });

  it("retains ambiguity across different event times and duplicate classification IDs", () => {
    const events = [event("0", "MISS")],
      value = session([atom("0", "circle")]);
    expect(both(events, value).causes).toHaveLength(1);
    events.push({ ...events[0], objectTime: 2000, time: 2100, judgementTime: 2100 });
    expect(both(events, value)).toEqual({ match: undefined, causes: [] });
    events.pop();
    value.analysis.classifications.push({ ...value.analysis.classifications[0] });
    expect(both(events, value).causes).toEqual([]);
    value.analysis.classifications.pop();
    expect(both(events, value).causes).toHaveLength(1);
  });

  it("ignores an explicit index belonging to a different session or event stream", () => {
    const events = [event("0", "MISS")],
      value = session([atom("0", "circle")]);
    const lookups = createErrorAnalysisLookups(events, "stable", value);
    const error = summarizeReplayEvents(events, "stable").errors[0];
    const otherEvents = [events[0], { ...events[0] }];
    expect(matchErrorAtom(error, otherEvents, "stable", value, lookups)).toBeUndefined();
    const otherSession = session([atom("0", "circle")], [cause("Late tap")]);
    expect(selectedErrorCauses(error, events, "stable", otherSession, lookups)[0].headline).toBe("Late tap");
  });
  it.each(["stable", "lazer"] as const)("matches an exact %s miss to its atom, event and analysis", (ruleset) => {
    const a = atom("0", "circle", { identity: { analysisProfileId: ruleset } });
    const events = [event("0", "MISS", ruleset)];
    const value = session([a], [cause("Overshoot")], ruleset);
    const { match, causes } = both(events, value, ruleset);
    expect(match).toEqual({ atom: a, event: events[0], analysis: value.analysis });
    expect(match?.atom).toBe(a);
    expect(match?.event).toBe(events[0]);
    expect(causes).toHaveLength(1);
  });

  it.each(["HEAD", "TICK", "REPEAT"] as const)("matches an exact Stable and Lazer %s component", (type) => {
    for (const ruleset of ["stable", "lazer"] as const) {
      const a = atom("s/part", type === "HEAD" ? "slider-head" : type === "TICK" ? "slider-tick" : "slider-repeat", {
        identity: { analysisProfileId: ruleset },
      });
      const later = atom("s/tail", "slider-end", { objectTimeMs: 1500 });
      const { match, causes } = both(
        [event("s/part", type, ruleset)],
        session([a, later], undefined, ruleset),
        ruleset,
      );
      expect(match?.atom).toBe(a);
      expect(causes).toHaveLength(1);
    }
  });

  it("matches the Stable parent MISS to its consequence atom, by slider start time", () => {
    const head = atom("s/HEAD", "slider-head"),
      parent = atom("s", "slider-parent", {
        role: "consequence",
        objectTimeMs: 3000,
        resolutionTimeMs: 3100,
        relatedAtomIds: [head.id],
      });
    const events = [{ ...event("s", "MISS"), time: 3100, judgementTime: 3100 }];
    const { match, causes } = both(events, session([head, parent]));
    expect(match?.atom).toBe(parent);
    expect(causes).toHaveLength(1);
  });

  it("still matches a parent whose contributors are rejected later by the cause lookup", () => {
    const head = atom("s/HEAD", "slider-head"),
      tick = atom("s/tick", "slider-tick"),
      parent = atom("s", "slider-parent", { role: "consequence", relatedAtomIds: [head.id, tick.id] });
    const value = session([head, tick, parent]);
    value.analysis.excludedModelAtomIds = [tick.id];
    const { match, causes } = both([event("s", "MISS")], value);
    expect(match?.atom).toBe(parent);
    expect(causes).toEqual([]);
  });

  it("rejects the wrong component kind or parent even when a component ID matches", () => {
    expect(both([event("s/tick", "TICK")], session([atom("s/tick", "slider-end")])).match).toBeUndefined();
    expect(
      both([event("s/tick", "TICK")], session([atom("s/tick", "slider-tick", { parentId: "other" })])).match,
    ).toBeUndefined();
  });

  it("rejects an excluded atom", () => {
    const value = session([atom("0", "circle")]);
    value.analysis.excludedModelAtomIds = ["0"];
    expect(both([event("0", "MISS")], value)).toEqual({ match: undefined, causes: [] });
  });

  it.each(["profile", "component", "time", "resolution", "ambiguous", "grade"])(
    "rejects mismatched %s scope",
    (field) => {
      const a = atom("0", "circle"),
        value = session([a]);
      if (field === "profile") value.identity.analysisProfileId = "lazer";
      if (field === "component") a.componentId = "other";
      if (field === "time") a.objectTimeMs = 2000;
      if (field === "resolution") a.resolutionTimeMs = 2100;
      if (field === "ambiguous") value.analysis.inventory.atoms.push({ ...a, id: "duplicate" });
      if (field === "grade") a.result = "OK";
      expect(both([event("0", "MISS")], value)).toEqual({ match: undefined, causes: [] });
    },
  );

  it("rejects an atom of another profile inside a session of this profile", () => {
    const a = atom("0", "circle", { identity: { analysisProfileId: "lazer" } });
    expect(both([event("0", "MISS")], session([a])).match).toBeUndefined();
  });

  it("rejects a session that is not captured, or has no analysis", () => {
    const events = [event("0", "MISS")];
    const error = summarizeReplayEvents(events, "stable").errors[0];
    const states: MissExplanationSessionState[] = [
      { status: "empty" },
      { status: "not-captured", reasons: [] },
      { status: "building" },
      { status: "unsupported", reasons: [] },
      { status: "error", reasons: [] },
      { ...session([atom("0", "circle")]), analysis: undefined },
    ];
    for (const state of states) expect(matchErrorAtom(error, events, "stable", state)).toBeUndefined();
    expect(matchErrorAtom(error, events, "stable", session([atom("0", "circle")]))).toBeDefined();
    const ready = { ...session([atom("0", "circle")]), status: "ready" } as unknown as MissExplanationSessionState;
    expect(matchErrorAtom(error, events, "stable", ready)).toBeDefined();
  });

  it("rejects no error, no event, two candidate events and an event of another time", () => {
    const value = session([atom("0", "circle")]);
    const events = [event("0", "MISS")];
    const error = summarizeReplayEvents(events, "stable").errors[0];
    expect(matchErrorAtom(undefined, events, "stable", value)).toBeUndefined();
    expect(matchErrorAtom(error, [], "stable", value)).toBeUndefined();
    expect(matchErrorAtom(error, [events[0], { ...events[0] }], "stable", value)).toBeUndefined();
    expect(matchErrorAtom({ ...error, time: 999 }, events, "stable", value)).toBeUndefined();
  });

  it("ignores events of the other ruleset, non-scoring judgements and Stable nested head judgements", () => {
    const value = session([atom("0", "circle")]);
    const base = event("0", "MISS");
    const error = summarizeReplayEvents([base], "stable").errors[0];
    const lazer = { ...base, ruleset: "lazer" } as ReplayAnalysisEvent;
    expect(matchErrorAtom(error, [lazer], "stable", value)).toBeUndefined();
    expect(
      matchErrorAtom(error, [{ ...base, affectsAccuracy: false } as ReplayAnalysisEvent], "stable", value),
    ).toBeUndefined();
    expect(
      matchErrorAtom(error, [{ ...base, isSliderHead: true } as ReplayAnalysisEvent], "stable", value),
    ).toBeUndefined();
    // The extra events do not make the one scoring judgement ambiguous.
    expect(matchErrorAtom(error, [base, lazer], "stable", value)?.event).toBe(base);
  });

  it("never matches a slider tail component", () => {
    const tail = event("s/tail", "TAIL", "lazer");
    const value = session(
      [atom("s/tail", "slider-end", { identity: { analysisProfileId: "lazer" } })],
      undefined,
      "lazer",
    );
    const error = { id: tail.eventId as string, time: 1000, type: "SLIDER_COMPONENT_MISS" as const, sliderId: "s" };
    expect(matchErrorAtom(error, [tail], "lazer", value)).toBeUndefined();
  });

  it("does not mutate the session", () => {
    const value = session([atom("0", "circle")]);
    const before = JSON.stringify(value);
    both([event("0", "MISS")], value);
    expect(JSON.stringify(value)).toBe(before);
  });
});
