import type { ReplayAnalysisEvent, ReplayAnalysisRuleset } from "@osujs/core";
import type { ComponentMechanism } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ComponentMechanisms";
import type { ErrorAnalysis } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ErrorAnalysis";
import type { ErrorAtom } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ErrorInventory";
import type { MissExplanationSessionState } from "../../services/analysis/miss-explanation/MissExplanationSession";
import { summarizeReplayEvents, type ReplayError } from "../../services/analysis/replay-events";
import {
  ERROR_CAUSE_FAMILY_CODES,
  errorCauseFamily,
  summarizeErrorCauses,
  type ErrorCauseFamily,
} from "./full-map-error-causes";

const FAMILIES: readonly ErrorCauseFamily[] = ["aim", "tapping", "notelock"];

// Real sessions, built the way error-cause.spec.ts builds them, so the selection and presentation rules the replay
// view applies run unfaked here too.
const mechanism = (code: string, headline = code, extra: Partial<ComponentMechanism> = {}): ComponentMechanism => ({
  status: "supported",
  headline,
  codes: [code],
  description: "Never rendered",
  eventIds: [],
  limitations: [],
  ...extra,
});
const atom = (componentId: string, component: ErrorAtom["component"], ruleset: ReplayAnalysisRuleset): ErrorAtom =>
  ({
    id: componentId,
    componentId,
    parentId: componentId.split("/")[0],
    component,
    result: "MISS",
    role: "primary",
    identity: { analysisProfileId: ruleset },
    objectTimeMs: 1000,
    resolutionTimeMs: 1100,
    relatedAtomIds: [],
    pendingContributionIds: [],
  } as unknown as ErrorAtom);

const missEvent = (id: string, time: number, ruleset: ReplayAnalysisRuleset): ReplayAnalysisEvent =>
  ({
    type: "HitObjectJudgement",
    hitObjectId: id,
    eventId: `${ruleset}:judgement:${id}`,
    time: time + 100,
    objectTime: time,
    judgementTime: time + 100,
    ruleset,
    position: { x: 0, y: 0 },
    verdict: "MISS",
  } as ReplayAnalysisEvent);
const sliderBreakEvent = (id: string, time: number): ReplayAnalysisEvent =>
  ({
    type: "SliderBreak",
    componentId: `${id}/tick`,
    sliderId: id,
    componentType: "TICK",
    eventId: `stable:component:${id}/tick`,
    time: time + 100,
    objectTime: time,
    judgementTime: time + 100,
    ruleset: "stable",
    position: { x: 0, y: 0 },
  } as ReplayAnalysisEvent);
const componentMissEvent = (id: string, time: number): ReplayAnalysisEvent =>
  ({
    type: "SliderComponentMiss",
    componentId: `${id}/tick`,
    sliderId: id,
    componentType: "TICK",
    eventId: `lazer:component:${id}/tick`,
    time: time + 100,
    objectTime: time,
    judgementTime: time + 100,
    ruleset: "lazer",
    position: { x: 0, y: 0 },
  } as ReplayAnalysisEvent);

interface Case {
  event: ReplayAnalysisEvent;
  atom: ErrorAtom;
  mechanism: ComponentMechanism;
}
/** A circle miss with its analysis atom and the given mechanism. */
function circle(id: string, time: number, mech: ComponentMechanism, ruleset: ReplayAnalysisRuleset = "stable"): Case {
  return {
    event: missEvent(id, time, ruleset),
    atom: { ...atom(id, "circle", ruleset), objectTimeMs: time, resolutionTimeMs: time + 100 },
    mechanism: mech,
  };
}
function sliderBreak(id: string, time: number, mech: ComponentMechanism): Case {
  return {
    event: sliderBreakEvent(id, time),
    atom: { ...atom(`${id}/tick`, "slider-tick", "stable"), objectTimeMs: time, resolutionTimeMs: time + 100 },
    mechanism: mech,
  };
}
function componentMiss(id: string, time: number, mech: ComponentMechanism): Case {
  return {
    event: componentMissEvent(id, time),
    atom: { ...atom(`${id}/tick`, "slider-tick", "lazer"), objectTimeMs: time, resolutionTimeMs: time + 100 },
    mechanism: mech,
  };
}

function sessionOf(
  cases: readonly Case[],
  ruleset: ReplayAnalysisRuleset = "stable",
  status: "ready" | "partial" = "ready",
): MissExplanationSessionState {
  const atoms = cases.map((c) => c.atom);
  return {
    status,
    ...(status === "partial" ? { reasons: ["limited"] } : {}),
    identity: { analysisProfileId: ruleset },
    analysis: {
      inventory: { atoms },
      classifications: cases.map((c) => ({ atomId: c.atom.id, mechanism: c.mechanism })),
      incidents: [],
      excludedModelAtomIds: [],
    } as unknown as ErrorAnalysis,
  } as unknown as MissExplanationSessionState;
}

function summarize(
  cases: readonly Case[],
  session: MissExplanationSessionState | undefined = sessionOf(cases),
  ruleset: ReplayAnalysisRuleset = "stable",
) {
  const events = cases.map((c) => c.event);
  return summarizeErrorCauses({ errors: summarizeReplayEvents(events, ruleset).errors, events, ruleset, session });
}
function ready(result: ReturnType<typeof summarizeErrorCauses>) {
  if (result.status !== "ready") throw new Error(`expected ready, got ${result.status}`);
  return result;
}
const none = { total: 0, miss: 0, slider: 0 };

describe("error cause families", () => {
  it("lists each code in exactly one family", () => {
    const all = FAMILIES.flatMap((family) => ERROR_CAUSE_FAMILY_CODES[family]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("holds exactly the codes of each family", () => {
    expect([...ERROR_CAUSE_FAMILY_CODES.aim].sort()).toEqual(
      [
        "overshoot",
        "undershoot",
        "wide-aim",
        "misaim",
        "edge-miss",
        "off-target",
        "aim-late",
        "left-early",
        "between-passes",
        "off-track",
        "ran-ahead",
        "fell-behind",
        "turned-early",
        "late-pickup",
        "no-spin",
        "slow-spin",
        "stopped-early",
        "reversed-spin",
      ].sort(),
    );
    expect([...ERROR_CAUSE_FAMILY_CODES.tapping].sort()).toEqual(
      [
        "early-tap",
        "late-tap",
        "off-beat",
        "slow-tapping",
        "no-tap",
        "no-hold",
        "wrong-hold",
        "released-early",
        "hold-interrupted",
        "started-late",
      ].sort(),
    );
    expect([...ERROR_CAUSE_FAMILY_CODES.notelock].sort()).toEqual(["notelock", "out-of-order"]);
  });

  it.each(FAMILIES.flatMap((family) => ERROR_CAUSE_FAMILY_CODES[family].map((code) => [family, code] as const)))(
    "puts %s code %s in its family",
    (family, code) => {
      expect(errorCauseFamily([code])).toBe(family);
    },
  );

  it("takes Aim before Notelock before Tapping, for every pair", () => {
    for (const aim of ERROR_CAUSE_FAMILY_CODES.aim)
      for (const other of [...ERROR_CAUSE_FAMILY_CODES.tapping, ...ERROR_CAUSE_FAMILY_CODES.notelock]) {
        expect(errorCauseFamily([other, aim])).toBe("aim");
        expect(errorCauseFamily([aim, other])).toBe("aim");
      }
    for (const notelock of ERROR_CAUSE_FAMILY_CODES.notelock)
      for (const tapping of ERROR_CAUSE_FAMILY_CODES.tapping) {
        expect(errorCauseFamily([tapping, notelock])).toBe("notelock");
        expect(errorCauseFamily([notelock, tapping])).toBe("notelock");
      }
  });

  it("names no family for no code or only unknown codes", () => {
    expect(errorCauseFamily([])).toBeUndefined();
    expect(errorCauseFamily(["mystery"])).toBeUndefined();
    expect(errorCauseFamily(["mystery", "no-retap"])).toBeUndefined();
    // An unknown code does not hide a known one beside it.
    expect(errorCauseFamily(["mystery", "late-tap"])).toBe("tapping");
  });
});

describe("summarizeErrorCauses", () => {
  it("counts errors by family and by error type, in the replay view's terms", () => {
    const cases = [
      circle("a", 1000, mechanism("overshoot", "Overshoot")),
      circle("b", 2000, mechanism("misaim", "Misaim")),
      sliderBreak("s1", 3000, mechanism("off-track", "Off track")),
      circle("c", 4000, mechanism("early-tap", "Early tap")),
      sliderBreak("s2", 5000, mechanism("released-early", "Released early")),
      circle("d", 6000, mechanism("notelock", "Notelock")),
    ];
    const result = ready(summarize(cases));
    expect(result.total).toBe(6);
    expect(result.families.aim).toEqual({ total: 3, miss: 2, slider: 1 });
    expect(result.families.tapping).toEqual({ total: 2, miss: 1, slider: 1 });
    expect(result.families.notelock).toEqual({ total: 1, miss: 1, slider: 0 });
    expect(result.none).toEqual(none);
  });

  it("counts a Lazer slider component miss as a slider error", () => {
    const cases = [
      componentMiss("s", 1000, mechanism("off-track", "Off track")),
      circle("c", 2000, mechanism("late-tap", "Late tap"), "lazer"),
    ];
    const result = ready(summarize(cases, sessionOf(cases, "lazer"), "lazer"));
    expect(result.families.aim).toEqual({ total: 1, miss: 0, slider: 1 });
    expect(result.families.tapping).toEqual({ total: 1, miss: 1, slider: 0 });
    expect(result.total).toBe(2);
  });

  it("counts an error with causes from two families once, under Aim", () => {
    const cases = [
      circle("a", 1000, mechanism("early-tap", "Early tap · Off track", { codes: ["early-tap", "off-track"] })),
    ];
    const result = ready(summarize(cases));
    expect(result.families.aim.total).toBe(1);
    expect(result.families.tapping.total).toBe(0);
    expect(result.total).toBe(1);
  });

  it("counts an error whose cause is withheld, or whose mechanism the presentation rejects, as no cause", () => {
    const cases = [
      // Unavailable mechanism: the inspector shows no cause.
      circle("a", 1000, mechanism("overshoot", "Overshoot", { status: "unavailable" })),
      // A tap that was taken is not a cause the inspector shows.
      circle("b", 2000, mechanism("tap-taken", "Tap taken")),
      // A code outside the three families.
      circle("c", 3000, mechanism("mystery", "Mystery")),
      circle("d", 4000, mechanism("overshoot", "Overshoot")),
    ];
    const result = ready(summarize(cases));
    expect(result.none).toEqual({ total: 3, miss: 3, slider: 0 });
    expect(result.families.aim.total).toBe(1);
    expect(result.total).toBe(4);
  });

  it("counts an error with no analysis atom as no cause", () => {
    const cases = [
      circle("a", 1000, mechanism("overshoot", "Overshoot")),
      sliderBreak("s", 2000, mechanism("off-track", "Off track")),
    ];
    const result = ready(summarize(cases, sessionOf([cases[0]])));
    expect(result.none).toEqual({ total: 1, miss: 0, slider: 1 });
    expect(result.families.aim.total).toBe(1);
  });

  it("makes the total the sum of the families and no cause", () => {
    const cases = [
      circle("a", 1000, mechanism("overshoot", "Overshoot")),
      circle("b", 2000, mechanism("no-tap", "No tap")),
      sliderBreak("s", 3000, mechanism("mystery", "Mystery")),
      circle("c", 4000, mechanism("out-of-order", "Out of order")),
    ];
    const result = ready(summarize(cases));
    const sum = FAMILIES.reduce((n, family) => n + result.families[family].total, result.none.total);
    expect(sum).toBe(result.total);
    expect(result.total).toBe(4);
    for (const count of [...FAMILIES.map((family) => result.families[family]), result.none])
      expect(count.miss + count.slider).toBe(count.total);
  });

  it("leaves out an error type that is not a player error", () => {
    const events = [missEvent("a", 1000, "stable")];
    const session = sessionOf([circle("a", 1000, mechanism("overshoot", "Overshoot"))]);
    const errors: ReplayError[] = [
      ...summarizeReplayEvents(events, "stable").errors,
      { id: "odd", time: 5000, type: "ANALYSIS_ERROR" },
    ];
    const result = ready(summarizeErrorCauses({ errors, events, ruleset: "stable", session }));
    expect(result.total).toBe(1);
    expect(result.none.total).toBe(0);
  });

  it("is ready with every count zero when the replay has no errors", () => {
    const result = ready(summarize([], sessionOf([])));
    expect(result.total).toBe(0);
    for (const family of FAMILIES) expect(result.families[family]).toEqual(none);
    expect(result.none).toEqual(none);
  });

  it("reads a partial session of the page's ruleset as ready", () => {
    const cases = [circle("a", 1000, mechanism("overshoot", "Overshoot"))];
    const result = ready(summarize(cases, sessionOf(cases, "stable", "partial")));
    expect(result.families.aim.total).toBe(1);
  });

  describe("breakdown", () => {
    const rowsOf = (result: ReturnType<typeof ready>, family: ErrorCauseFamily) =>
      result.breakdown[family].map((row) => [row.label, row.count.total, row.count.miss, row.count.slider]);

    it("splits each family by the text the inspector shows, most errors first, then by label", () => {
      const cases = [
        circle("a", 1000, mechanism("overshoot", "Overshoot")),
        circle("b", 2000, mechanism("overshoot", "Overshoot")),
        circle("c", 3000, mechanism("misaim", "Misaim")),
        sliderBreak("s", 4000, mechanism("off-track", "Off track")),
        circle("d", 5000, mechanism("late-tap", "Late tap")),
        circle("e", 6000, mechanism("early-tap", "Early tap")),
        sliderBreak("t", 7000, mechanism("released-early", "Released early")),
        circle("f", 8000, mechanism("notelock", "Notelock")),
      ];
      const result = ready(summarize(cases));
      // The player's words come from the presentation: Overshoot is Overaim, Released early is Early release.
      expect(rowsOf(result, "aim")).toEqual([
        ["Overaim", 2, 2, 0],
        ["Misaim", 1, 1, 0],
        ["Off track", 1, 0, 1],
      ]);
      expect(rowsOf(result, "tapping")).toEqual([
        ["Early release", 1, 0, 1],
        ["Early tap", 1, 1, 0],
        ["Late tap", 1, 1, 0],
      ]);
      expect(rowsOf(result, "notelock")).toEqual([["Notelock", 1, 1, 0]]);
    });

    it("adds up, per family, to the family's total, misses and slider errors", () => {
      const cases = [
        circle("a", 1000, mechanism("overshoot", "Overshoot")),
        circle("b", 2000, mechanism("misaim", "Misaim")),
        sliderBreak("s", 3000, mechanism("off-track", "Off track")),
        sliderBreak("u", 3500, mechanism("off-track", "Off track")),
        circle("c", 4000, mechanism("early-tap", "Early tap")),
        sliderBreak("t", 5000, mechanism("released-early", "Released early")),
        circle("d", 6000, mechanism("mystery", "Mystery")),
      ];
      const result = ready(summarize(cases));
      for (const family of FAMILIES) {
        const sum = result.breakdown[family].reduce(
          (n, row) => ({ total: n.total + row.count.total, miss: n.miss + row.count.miss, slider: n.slider + row.count.slider }),
          { total: 0, miss: 0, slider: 0 },
        );
        expect([family, sum]).toEqual([family, result.families[family]]);
      }
    });

    it("names an error with two labels by the joined text, counted in one row of its family", () => {
      const cases = [
        circle("a", 1000, mechanism("early-tap", "Early tap · Off track", { codes: ["early-tap", "off-track"] })),
        circle("b", 2000, mechanism("early-tap", "Early tap · Off track", { codes: ["early-tap", "off-track"] })),
        circle("c", 3000, mechanism("off-track", "Off track")),
      ];
      const result = ready(summarize(cases));
      expect(rowsOf(result, "aim")).toEqual([
        ["Early tap · Off track", 2, 2, 0],
        ["Off track", 1, 1, 0],
      ]);
      expect(result.breakdown.tapping).toEqual([]);
    });

    it("leaves an error with no presentable cause out of every breakdown, and gives no cause no breakdown", () => {
      const cases = [
        circle("a", 1000, mechanism("overshoot", "Overshoot", { status: "unavailable" })),
        circle("b", 2000, mechanism("mystery", "Mystery")),
        circle("c", 3000, mechanism("overshoot", "Overshoot")),
      ];
      const result = ready(summarize(cases));
      expect(result.none.total).toBe(2);
      expect(rowsOf(result, "aim")).toEqual([["Overaim", 1, 1, 0]]);
      expect(result.breakdown.tapping).toEqual([]);
      expect(result.breakdown.notelock).toEqual([]);
      expect(Object.keys(result.breakdown).sort()).toEqual(["aim", "notelock", "tapping"]);
    });

    it("is empty in every family for a replay with no errors", () => {
      expect(ready(summarize([], sessionOf([]))).breakdown).toEqual({ aim: [], tapping: [], notelock: [] });
    });
  });

  describe("status", () => {
    const events = [missEvent("a", 1000, "stable")];
    const errors = summarizeReplayEvents(events, "stable").errors;
    const status = (session: MissExplanationSessionState | undefined, ruleset: ReplayAnalysisRuleset = "stable") =>
      summarizeErrorCauses({ errors, events, ruleset, session });

    it.each([
      ["building", { status: "building" }],
      ["empty", { status: "empty" }],
      ["not captured", { status: "not-captured", reasons: ["analysis-cancelled"] }],
    ] as const)("is analyzing while the session is %s", (_name, session) => {
      expect(status(session as MissExplanationSessionState)).toEqual({ status: "analyzing" });
    });

    it("is analyzing before there is a session", () => {
      expect(status(undefined)).toEqual({ status: "analyzing" });
    });

    it("is unavailable for the other ruleset when its profile is unsupported", () => {
      expect(status({ status: "unsupported", reasons: ["cross-rules-profile-not-captured"] }, "lazer")).toEqual({
        status: "unavailable",
        reason: "other-ruleset",
      });
    });

    it("is still analyzing when nothing is captured yet, whatever the reason: the simulator says this before it starts", () => {
      for (const ruleset of ["stable", "lazer"] as const)
        expect(status({ status: "not-captured", reasons: ["cross-rules-profile-not-captured"] }, ruleset)).toEqual({
          status: "analyzing",
        });
    });

    it("is unavailable for the other ruleset when the ready session is of the other profile", () => {
      const cases = [circle("a", 1000, mechanism("overshoot", "Overshoot"))];
      expect(status(sessionOf(cases, "stable"), "lazer")).toEqual({ status: "unavailable", reason: "other-ruleset" });
      expect(status(sessionOf(cases, "lazer", "partial"), "stable")).toEqual({
        status: "unavailable",
        reason: "other-ruleset",
      });
    });

    it("is unavailable, for no named reason, when the session is unsupported for another reason or failed", () => {
      expect(status({ status: "unsupported", reasons: ["source-beyond-canonical-traversal"] })).toEqual({
        status: "unavailable",
        reason: "unavailable",
      });
      expect(status({ status: "error", reasons: ["analysis-resource-limit"] })).toEqual({
        status: "unavailable",
        reason: "unavailable",
      });
    });
  });
});
