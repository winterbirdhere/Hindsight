import type { ReplayAnalysisEvent } from "@osujs/core";
import type { ComponentMechanism } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ComponentMechanisms";
import type { ErrorAtom } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ErrorInventory";
import type { MissExplanationSessionState } from "./miss-explanation/MissExplanationSession";
import { analysisNotelockBlocker } from "./notelock-evidence";
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
  } as unknown as ErrorAtom);
const rejection = (blockerId: string, inputId = "r1") => ({
  inputId,
  attemptId: "a",
  selectionId: "s",
  policyId: "p",
  blockerId,
  targetActivationId: "t",
  timingResult: "GREAT",
  offsetMs: 0,
  eventIds: [],
});
const notelock = (rejections: unknown, extra = {}): ComponentMechanism =>
  ({
    status: "supported",
    codes: ["notelock"],
    headline: "Notelock",
    description: "",
    eventIds: [],
    limitations: [],
    diagnostics: { opportunities: [], primary: { directRejections: rejections } },
    ...extra,
  } as unknown as ComponentMechanism);
function session(mechanisms: ComponentMechanism[], atom = headAtom(), extra = {}): MissExplanationSessionState {
  return {
    status: "partial",
    identity: { analysisProfileId: "stable" },
    analysis: {
      inventory: { atoms: [atom] },
      classifications: mechanisms.map((mechanism) => ({ atomId: atom.id, mechanism })),
      incidents: [],
      excludedModelAtomIds: [],
      ...extra,
    },
  } as unknown as MissExplanationSessionState;
}
const blocker = (value: MissExplanationSessionState | undefined, ruleset: "stable" | "lazer" = "stable") =>
  analysisNotelockBlocker(error, events, ruleset, value);

describe("analysisNotelockBlocker", () => {
  it("returns the one blocker of a supported notelock, however many taps were rejected", () => {
    expect(blocker(session([notelock([rejection("6")])]))).toBe("6");
    expect(blocker(session([notelock([rejection("6", "r1"), rejection("6", "r2")])]))).toBe("6");
  });

  it("returns nothing for a notelock code next to another code: the lock is not the whole cause", () => {
    expect(blocker(session([notelock([rejection("6")], { codes: ["notelock", "off-target"] })]))).toBeUndefined();
    expect(blocker(session([notelock([rejection("6")], { codes: ["off-target", "notelock"] })]))).toBeUndefined();
    expect(blocker(session([notelock([rejection("6")], { codes: ["notelock", "notelock"] })]))).toBeUndefined();
    expect(blocker(session([notelock([rejection("6")], { codes: [] })]))).toBeUndefined();
  });

  it("returns nothing when the rejections name two different blockers", () => {
    expect(blocker(session([notelock([rejection("6"), rejection("5")])]))).toBeUndefined();
  });

  it("returns nothing for an unsupported mechanism", () => {
    expect(blocker(session([notelock([rejection("6")], { status: "unavailable" })]))).toBeUndefined();
  });

  it("returns nothing for a mechanism without the notelock code", () => {
    expect(blocker(session([notelock([rejection("6")], { codes: ["late-tap"] })]))).toBeUndefined();
    expect(blocker(session([notelock([rejection("6")], { codes: [], headline: "Notelock" })]))).toBeUndefined();
  });

  it("returns nothing for a consequence atom", () => {
    expect(blocker(session([notelock([rejection("6")])], headAtom({ role: "consequence" })))).toBeUndefined();
  });

  it("returns nothing without diagnostics, primary diagnostics or rejections", () => {
    expect(blocker(session([notelock(undefined, { diagnostics: undefined })]))).toBeUndefined();
    const bare = notelock([rejection("6")]);
    delete (bare as { diagnostics?: unknown }).diagnostics;
    expect(blocker(session([bare]))).toBeUndefined();
    expect(blocker(session([notelock(undefined, { diagnostics: { opportunities: [] } })]))).toBeUndefined();
    expect(blocker(session([notelock(undefined)]))).toBeUndefined();
    expect(blocker(session([notelock([])]))).toBeUndefined();
  });

  it("returns nothing for malformed rejections", () => {
    expect(blocker(session([notelock("6")]))).toBeUndefined();
    expect(blocker(session([notelock([{ ...rejection("6"), blockerId: "" }])]))).toBeUndefined();
    expect(blocker(session([notelock([{ ...rejection("6"), blockerId: 6 }])]))).toBeUndefined();
    expect(blocker(session([notelock([null])]))).toBeUndefined();
  });

  it("returns nothing unless the atom has exactly one classification", () => {
    expect(blocker(session([]))).toBeUndefined();
    expect(blocker(session([notelock([rejection("6")]), notelock([rejection("6")])]))).toBeUndefined();
  });

  it("returns nothing when the error does not match one atom", () => {
    expect(blocker(undefined)).toBeUndefined();
    expect(blocker({ status: "building" })).toBeUndefined();
    expect(blocker({ status: "error", reasons: [] })).toBeUndefined();
    expect(blocker(session([notelock([rejection("6")])]), "lazer")).toBeUndefined();
    expect(blocker(session([notelock([rejection("6")])], headAtom({ objectTimeMs: 2000 })))).toBeUndefined();
    expect(
      blocker(session([notelock([rejection("6")])], headAtom(), { excludedModelAtomIds: ["atom:head"] })),
    ).toBeUndefined();
  });

  it("does not mutate the session", () => {
    const value = session([notelock([rejection("6")])]);
    const before = JSON.stringify(value);
    blocker(value);
    expect(JSON.stringify(value)).toBe(before);
  });
});
