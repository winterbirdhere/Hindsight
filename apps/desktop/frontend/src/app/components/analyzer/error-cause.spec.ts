import type { ReplayAnalysisEvent } from "@osujs/core";
import type { ComponentMechanism } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ComponentMechanisms";
import type { ErrorAtom } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ErrorInventory";
import type { ErrorAnalysis } from "../../../../../../../libs/osu/core/src/gameplay/error-analysis/ErrorAnalysis";
import type { MissExplanationSessionState } from "../../services/analysis/miss-explanation/MissExplanationSession";
import { summarizeReplayEvents } from "../../services/analysis/replay-events";
import { selectedErrorCauses } from "./error-cause";
import { createErrorAnalysisLookups } from "../../services/analysis/error-analysis-lookups";

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
  type: "MISS" | "HEAD" | "TICK" | "REPEAT",
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
function session(atoms: ErrorAtom[], mechanisms = atoms.map(() => cause("Off track")), ruleset = "stable") {
  return {
    status: "partial",
    identity: { analysisProfileId: ruleset },
    analysis: {
      inventory: { atoms },
      classifications: atoms
        .filter((a) => a.role === "primary")
        .map((a, i) => ({ atomId: a.id, mechanism: mechanisms[i] })),
      incidents: [{ id: "group", atomIds: atoms.map((a) => a.id), mechanism: cause("Wrong later cause") }],
      excludedModelAtomIds: [],
    },
  } as unknown as Extract<MissExplanationSessionState, { status: "partial" }> & { analysis: ErrorAnalysis };
}
function select(
  events: ReplayAnalysisEvent[],
  value: MissExplanationSessionState,
  ruleset: "stable" | "lazer" = "stable",
) {
  const error = summarizeReplayEvents(events, ruleset).errors[0];
  const direct = selectedErrorCauses(error, events, ruleset, value);
  expect(
    selectedErrorCauses(error, events, ruleset, value, createErrorAnalysisLookups(events, ruleset, value)),
  ).toEqual(direct);
  return direct;
}
describe("canonical selected-error cause projection", () => {
  it.each(["stable", "lazer"] as const)("maps an exact %s miss without using a merged incident", (ruleset) => {
    const mechanism = cause("Overshoot"),
      a = atom("0", "circle", { identity: { analysisProfileId: ruleset } });
    expect(select([event("0", "MISS", ruleset)], session([a], [mechanism], ruleset), ruleset)).toEqual([mechanism]);
  });
  it.each(["HEAD", "TICK", "REPEAT"] as const)("maps exact Stable %s and native SliderTick semantics", (type) => {
    for (const ruleset of ["stable", "lazer"] as const) {
      const a = atom("s/part", type === "HEAD" ? "slider-head" : type === "TICK" ? "slider-tick" : "slider-repeat", {
        identity: { analysisProfileId: ruleset },
      });
      const mechanism = cause("Early release"),
        later = atom("s/tail", "slider-end", { objectTimeMs: 1500 });
      expect(
        select(
          [event(a.componentId, type, ruleset)],
          session([a, later], [mechanism, cause("Ran ahead")], ruleset),
          ruleset,
        ),
      ).toEqual([mechanism]);
    }
  });
  it("uses every linked parent contributor, not just the first incident", () => {
    const head = atom("s/HEAD", "slider-head"),
      tick = atom("s/tick", "slider-tick"),
      parent = atom("s", "slider-parent", { role: "consequence", relatedAtomIds: [head.id, tick.id] });
    const one = cause("Early tap"),
      two = cause("Off track");
    expect(select([event("s", "MISS")], session([head, tick, parent], [one, two]))).toEqual([one, two]);
  });
  it("keeps the Stable parent start-time target even though the scoring atom records its end", () => {
    const head = atom("s/HEAD", "slider-head"),
      parent = atom("s", "slider-parent", {
        role: "consequence",
        objectTimeMs: 3000,
        resolutionTimeMs: 3100,
        relatedAtomIds: [head.id],
      });
    const events = [{ ...event("s", "MISS"), time: 3100, judgementTime: 3100 }],
      mechanism = cause("Early tap");
    expect(summarizeReplayEvents(events, "stable").errors[0].time).toBe(1000);
    expect(select(events, session([head, parent], [mechanism]))).toEqual([mechanism]);
  });
  it("rejects the wrong component kind or parent even when a component ID matches", () => {
    expect(select([event("s/tick", "TICK")], session([atom("s/tick", "slider-end")]))).toEqual([]);
    expect(select([event("s/tick", "TICK")], session([atom("s/tick", "slider-tick", { parentId: "other" })]))).toEqual(
      [],
    );
  });
  it.each(["excluded", "partial", "pending", "missing"])(
    "does not cherry-pick parent causes when a contributor is %s",
    (mode) => {
      const head = atom("s/HEAD", "slider-head"),
        tick = atom("s/tick", "slider-tick"),
        parent = atom("s", "slider-parent", { role: "consequence", relatedAtomIds: [head.id, tick.id] });
      const value = session([head, tick, parent]);
      if (value.status !== "partial") throw Error();
      if (mode === "excluded") value.analysis.excludedModelAtomIds = [tick.id];
      if (mode === "partial") value.analysis.classifications[1].mechanism.status = "unavailable";
      if (mode === "pending") parent.pendingContributionIds = ["s/unrecorded"];
      if (mode === "missing") value.analysis.classifications.pop();
      expect(select([event("s", "MISS")], value)).toEqual([]);
    },
  );
  it("withholds disproven causes but leaves canonical navigation unchanged", () => {
    const events = [event("0", "MISS")],
      value = session([atom("0", "circle")], [cause("Early tap")]);
    if (value.status !== "partial") throw Error();
    value.analysis.excludedModelAtomIds = ["0"];
    expect(select(events, value)).toEqual([]);
    expect(summarizeReplayEvents(events, "stable").errors.map((e) => e.id)).toEqual(["miss:0"]);
  });
  it.each(["profile", "component", "time", "resolution", "ambiguous", "grade"])(
    "rejects mismatched %s scope",
    (field) => {
      const a = atom("0", "circle"),
        value = session([a]);
      if (value.status !== "partial") throw Error();
      if (field === "profile") value.identity.analysisProfileId = "lazer";
      if (field === "component") a.componentId = "other";
      if (field === "time") a.objectTimeMs = 2000;
      if (field === "resolution") a.resolutionTimeMs = 2100;
      if (field === "ambiguous") value.analysis.inventory.atoms.push({ ...a, id: "duplicate" });
      if (field === "grade") a.result = "OK";
      expect(select([event("0", "MISS")], value)).toEqual([]);
    },
  );
  it("does not mutate analysis, including grouped incidents or parent links", () => {
    const value = session([atom("0", "circle")]);
    const before = JSON.stringify(value);
    select([event("0", "MISS")], value);
    expect(JSON.stringify(value)).toBe(before);
  });
});
