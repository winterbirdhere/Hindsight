import type { ReplayAnalysisEvent } from "@osujs/core";
import type { ComponentMechanism } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ComponentMechanisms";
import type { ErrorAtom } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ErrorInventory";
import { analysisAttributedTaps, analysisCauseKind } from "./attributed-taps";
import type { MissExplanationSessionState } from "./miss-explanation/MissExplanationSession";
import type { ReplayError } from "./replay-events";

const HEAD = "7/HEAD";
const error: ReplayError = {
  id: `stable:slider-break:${HEAD}`,
  time: 1000,
  type: "SLIDER_BREAK",
  hitObjectId: HEAD,
  sliderId: "7",
};
const events = [
  {
    type: "SliderBreak",
    componentId: HEAD,
    sliderId: "7",
    componentType: "HEAD",
    eventId: error.id,
    time: 1100,
    objectTime: 1000,
    judgementTime: 1100,
    ruleset: "stable",
    position: { x: 0, y: 0 },
  } as ReplayAnalysisEvent,
];
const headAtom = (extra = {}): ErrorAtom =>
  ({
    id: "atom:head",
    componentId: HEAD,
    parentId: "7",
    component: "slider-head",
    result: "MISS",
    role: "primary",
    identity: { analysisProfileId: "stable" },
    objectTimeMs: 1000,
    resolutionTimeMs: 1100,
    relatedAtomIds: [],
    pendingContributionIds: [],
    ...extra,
  }) as unknown as ErrorAtom;

type Role = "relevant" | "context" | "ambiguous";
const association = (inputId: string, role: Role) => ({ inputId, role, reasons: [], eventIds: [] });
const mechanism = (associations: unknown, extra = {}, limitations: string[] = []): ComponentMechanism =>
  ({
    status: "supported",
    codes: ["aim-late"],
    headline: "Aim late",
    description: "",
    eventIds: [],
    limitations: [],
    diagnostics: { opportunities: [], primary: { association: { associations, limitations } } },
    ...extra,
  }) as unknown as ComponentMechanism;
const input = (id: string, timeMs: number, x: number) => ({ id, kind: "input", phase: "input", timeMs, position: { x, y: 99 } });
const TRACE = [
  input("in-early", 950, 10),
  input("in-main", 1043, 20),
  input("in-other", 1060, 30),
  { id: "attempt-1", kind: "attempt", phase: "attempt", timeMs: 1043, inputId: "in-main" },
];

function session(
  mechanisms: ComponentMechanism[],
  options: { atom?: ErrorAtom; records?: unknown[]; analysis?: object } = {},
): MissExplanationSessionState {
  const atom = options.atom ?? headAtom();
  return {
    status: "partial",
    identity: { analysisProfileId: "stable" },
    trace: { records: options.records ?? TRACE },
    analysis: {
      inventory: { atoms: [atom] },
      classifications: mechanisms.map((entry) => ({ atomId: atom.id, mechanism: entry })),
      incidents: [],
      excludedModelAtomIds: [],
      ...options.analysis,
    },
  } as unknown as MissExplanationSessionState;
}
const taps = (value: MissExplanationSessionState | undefined, ruleset: "stable" | "lazer" = "stable") =>
  analysisAttributedTaps(error, events, ruleset, value);

describe("analysisCauseKind", () => {
  const kind = (value: MissExplanationSessionState | undefined, ruleset: "stable" | "lazer" = "stable") =>
    analysisCauseKind(error, events, ruleset, value);
  const caused = (...codes: string[]) => session([mechanism([], { codes })]);

  it.each(["overshoot", "undershoot", "wide-aim", "misaim", "aim-late", "left-early", "between-passes", "off-target", "edge-miss", "off-track"])(
    "calls %s an aim cause",
    (code) => {
      expect(kind(caused(code))).toBe("aim");
    },
  );

  it.each(["late-tap", "early-tap", "off-beat", "no-tap", "notelock", "tap-taken", "no-hold"])("calls %s another kind of cause", (code) => {
    expect(kind(caused(code))).toBe("other");
  });

  it("calls a cause with an aim part an aim cause", () => {
    expect(kind(caused("no-hold", "off-track"))).toBe("aim");
  });

  it("has no kind without a cause the analysis supports for this one error", () => {
    expect(kind(undefined)).toBeUndefined();
    expect(kind(session([mechanism([], { status: "unavailable", codes: [] })]))).toBeUndefined();
    expect(kind(session([mechanism([], { codes: [] })]))).toBeUndefined();
    expect(kind(session([mechanism([]), mechanism([])]))).toBeUndefined();
    expect(kind(caused("overshoot"), "lazer")).toBeUndefined();
  });
});

describe("analysisAttributedTaps", () => {
  it("returns the taps the analysis calls relevant, with the trace's own time and position", () => {
    expect(taps(session([mechanism([association("in-main", "relevant")])]))).toEqual([
      { inputId: "in-main", timeMs: 1043, position: { x: 20, y: 99 }, certainty: "attributed" },
    ]);
  });

  it("keeps an ambiguous tap as ambiguous and leaves out taps that belong to other notes", () => {
    const value = session([
      mechanism([
        association("in-other", "context"),
        association("in-main", "ambiguous"),
        association("in-early", "relevant"),
      ]),
    ]);
    expect(taps(value)).toEqual([
      { inputId: "in-early", timeMs: 950, position: { x: 10, y: 99 }, certainty: "attributed" },
      { inputId: "in-main", timeMs: 1043, position: { x: 20, y: 99 }, certainty: "ambiguous" },
    ]);
  });

  it("never takes the tap nearest in time: with no relevant or ambiguous input there is no tap", () => {
    // in-main is 43 ms from the object and in the trace, but the analysis gave it to another note.
    expect(taps(session([mechanism([association("in-main", "context")])]))).toEqual([]);
    expect(taps(session([mechanism([])]))).toEqual([]);
  });

  it("treats an input the analysis lists under two roles as ambiguous", () => {
    const value = session([mechanism([association("in-main", "relevant"), association("in-main", "ambiguous")])]);
    expect(taps(value)).toEqual([expect.objectContaining({ inputId: "in-main", certainty: "ambiguous" })]);
  });

  it("drops a tap whose input is not an input record of the kept trace", () => {
    const value = session([
      mechanism([association("gone", "relevant"), association("attempt-1", "relevant"), association("in-main", "relevant")]),
    ]);
    expect(taps(value).map((tap) => tap.inputId)).toEqual(["in-main"]);
    const broken = [{ id: "in-main", kind: "input", phase: "input", timeMs: Number.NaN, position: { x: 1, y: 2 } }];
    expect(taps(session([mechanism([association("in-main", "relevant")])], { records: broken }))).toEqual([]);
  });

  it.each([
    ["an unsupported mechanism", session([mechanism([association("in-main", "relevant")], { status: "unavailable" })])],
    ["a mechanism without diagnostics", session([mechanism([], { diagnostics: undefined })])],
    ["an association the trace does not match", session([mechanism([association("in-main", "relevant")], {}, ["trace-identity-mismatch"])])],
    ["two classifications of one atom", session([mechanism([association("in-main", "relevant")]), mechanism([])])],
    ["a consequence atom", session([mechanism([association("in-main", "relevant")])], { atom: headAtom({ role: "consequence" }) })],
    ["an excluded atom", session([mechanism([association("in-main", "relevant")])], { analysis: { excludedModelAtomIds: ["atom:head"] } })],
    ["no session", undefined],
    ["a session still building", { status: "building" } as MissExplanationSessionState],
  ])("returns nothing for %s", (_name, value) => {
    expect(taps(value)).toEqual([]);
  });

  it("returns nothing while another ruleset is in view", () => {
    expect(taps(session([mechanism([association("in-main", "relevant")])]), "lazer")).toEqual([]);
  });
});
