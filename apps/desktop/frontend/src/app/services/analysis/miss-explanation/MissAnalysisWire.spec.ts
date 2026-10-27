import { deserialize, serialize } from "v8";
import { Slider, HitCircle, Spinner, OsuClassicMod, LazerMod } from "@osujs/core";
import { errorFixture } from "../../../../../../../../libs/osu/core/test/ErrorAnalysisFixtures";
import { traceFrame } from "../../../../../../../../libs/osu/core/test/ReplayTraceFixtures";
import { buildMissExplanationSessionAsync } from "./MissExplanationSession";
import { runMissAnalysis, type MissAnalysisInput } from "./MissAnalysisRunner";
import { referenceComparisonCandidates } from "../../../../../../../../libs/osu/core/src/gameplay/error-analysis/PrimaryAttribution";
import {
  encodeMissAnalysisInput,
  decodeMissAnalysisInput,
  encodeMissAnalysisSession,
  decodeMissAnalysisSession,
} from "./MissAnalysisWire";

const clone = <T>(value: T): T => deserialize(serialize(value));
const checkpoint = async () => undefined;
const objects = "100,192,1000,1,0\n200,192,1500,2,0,B|240:140|300:192,2,150\n256,192,3000,8,0,4000";
const frames = [traceFrame(0, 500, [], 0), traceFrame(1200, 500, [], 0), traceFrame(4500, 500, [], 0)];

it("preserves exact diagnostic JSON hooks and aliases without changing unhooked copies", async () => {
  const f = fixture();
  const session = await runMissAnalysis(f.input, checkpoint);
  if (session.status !== "ready" && session.status !== "partial") throw new Error("Missing session");
  const decision = { inputId: "press", selectedCodes: ["misaim"] };
  Object.defineProperty(decision, "toJSON", { value: () => undefined });
  const candidates = [{ code: "misaim", attribution: decision }];
  const comparison = referenceComparisonCandidates({
    candidates,
    ranking: { candidates, attribution: { presses: [{ ...decision }] } },
  } as unknown as Parameters<typeof referenceComparisonCandidates>[0]);
  const probe = { comparison, plainComparison: { ...comparison }, decision, alias: decision };
  const original = { ...session, analysis: { ...session.analysis!, transportProbe: probe } };
  const hydrated = await decodeMissAnalysisSession(clone(encodeMissAnalysisSession(original)), checkpoint);
  if (hydrated.status !== "ready" && hydrated.status !== "partial") throw new Error("Missing session");
  const restored = (hydrated.analysis as typeof original.analysis).transportProbe;
  expect(JSON.stringify(restored)).toBe(JSON.stringify(probe));
  expect(restored.decision).toBe(restored.alias);
  expect(restored.comparison.candidates[0].attribution).toBe(restored.decision);
  expect(restored.comparison.candidates).toBe(restored.comparison.ranking.candidates);
  expect(Object.prototype.hasOwnProperty.call(restored.plainComparison, "toJSON")).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(restored.comparison.ranking.attribution!.presses[0], "toJSON")).toBe(
    false,
  );
  expect(Object.isFrozen(restored.decision)).toBe(true);
  expect(Object.keys(hydrated)).not.toContain("jsonAliases");
});

it("rejects unsupported JSON hooks and aliases outside the returned session", async () => {
  const session = await runMissAnalysis(fixture().input, checkpoint);
  if (session.status !== "ready" && session.status !== "partial") throw new Error("Missing session");
  const probe = {};
  Object.defineProperty(probe, "toJSON", { value: () => ({ unexpected: true }) });
  const unsupported = { ...session, analysis: { ...session.analysis!, probe } };
  expect(() => encodeMissAnalysisSession(unsupported)).toThrow("Unsupported miss-analysis diagnostic JSON hook");
  const wire = clone(encodeMissAnalysisSession(session));
  if (wire.status !== "ready" && wire.status !== "partial") throw new Error("Missing wire session");
  wire.jsonAliases = [{ target: {}, kind: "omit" }];
  await expect(decodeMissAnalysisSession(wire, checkpoint)).rejects.toThrow(
    "Unreachable miss-analysis diagnostic JSON alias",
  );
});
function fixture(profile: "stable" | "lazer" = "stable", mods: OsuClassicMod[] = [], lazerMods: LazerMod[] = []) {
  const f = errorFixture(objects, frames, profile, mods, lazerMods);
  const input: MissAnalysisInput = {
    beatmap: f.map,
    frames,
    domain: f.trace.domain,
    identity: f.trace.identity,
    profile,
    limits: f.trace.limits,
    recording: {},
    additionalLimitations: [],
  };
  return { ...f, input };
}

it("hydrates the prepared graph without rebuilding curves, checkpoint aliases or dictionary precedence", () => {
  const f = fixture(),
    original = f.map.hitObjects[1] as Slider;
  const before = [0, 0.2, 0.5, 1].map((t) => original.ballPositionAt(t));
  const copied = clone(encodeMissAnalysisInput(f.input));
  expect(copied.beatmap).not.toBeInstanceOf(Object.getPrototypeOf(f.map).constructor);
  const input = decodeMissAnalysisInput(copied),
    map = input.beatmap,
    slider = map.hitObjects[1] as Slider;
  expect(map.hitObjects[0]).toBeInstanceOf(HitCircle);
  expect(slider).toBeInstanceOf(Slider);
  expect(map.hitObjects[2]).toBeInstanceOf(Spinner);
  expect(slider.head).toBeInstanceOf(HitCircle);
  expect([0, 0.2, 0.5, 1].map((t) => slider.ballPositionAt(t))).toEqual(before);
  for (const point of slider.checkPoints) {
    expect(point.slider).toBe(slider);
    expect(map.getSliderCheckPoint(point.id)).toBe(point);
    expect(point.hitTime).toBe(original.checkPoints.find((p) => p.id === point.id)?.hitTime);
  }
  for (let i = 0; i < (original.stableCheckPoints?.length ?? 0); i++) {
    const originalPoint = original.stableCheckPoints![i],
      index = original.checkPoints.indexOf(originalPoint);
    if (index >= 0) expect(slider.stableCheckPoints![i]).toBe(slider.checkPoints[index]);
  }
  expect(map.getSlider(slider.id)).toBe(slider);
  expect(map.controlPointInfo.timingPoints.length).toBe(f.map.controlPointInfo.timingPoints.length);
  expect(map.controlPointInfo.timingPointAt(1600).beatLength).toBe(
    f.map.controlPointInfo.timingPointAt(1600).beatLength,
  );
});

it.each<["stable" | "lazer", OsuClassicMod[], LazerMod[]]>([
  ["stable", [], []],
  ["lazer", [], []],
  ["stable", ["HARD_ROCK", "DOUBLE_TIME"], []],
  ["lazer", [], [{ acronym: "DA", settings: { circle_size: 6, overall_difficulty: 8, approach_rate: 9 } }]],
])("preserves complete %s trace/session data through worker transport (%j / %j)", async (profile, mods, lazerMods) => {
  const f = fixture(profile, mods, lazerMods);
  const expected = await buildMissExplanationSessionAsync(f.trace, f.map, [], checkpoint);
  const phases: string[] = [];
  const actual = await runMissAnalysis(
    decodeMissAnalysisInput(clone(encodeMissAnalysisInput(f.input))),
    checkpoint,
    (phase) => phases.push(phase),
  );
  expect(encodeMissAnalysisSession(actual)).toEqual(encodeMissAnalysisSession(expected));
  let checkpoints = 0;
  const hydrated = await decodeMissAnalysisSession(clone(encodeMissAnalysisSession(actual)), async () => {
    checkpoints++;
  });
  expect(encodeMissAnalysisSession(hydrated)).toEqual(encodeMissAnalysisSession(expected));
  expect(phases).toEqual(["preparing", "capturing", "analysing", "finalizing"]);
  expect(checkpoints).toBeGreaterThan(0);
  expect(Object.isFrozen(hydrated)).toBe(true);
  if (hydrated.status !== "ready" && hydrated.status !== "partial") throw new Error("Missing captured session");
  expect(Object.isFrozen(hydrated.trace.records)).toBe(true);
  expect(Object.isFrozen(hydrated.analysis?.classifications)).toBe(true);
  expect("set" in hydrated.explanations).toBe(false);
  hydrated.explanations.forEach((_entry, _key, map) => expect(map).toBe(hydrated.explanations));
});
