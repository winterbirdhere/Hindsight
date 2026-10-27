import { buildBeatmap, parseBlueprint, ReplayTrace } from "@osujs/core";
import { GameSimulator } from "./GameSimulator";
import { OsuReplay } from "../../../model/OsuReplay";
import { BucketedGameStateTimeMachine, LazerGameStateTimeMachine } from "@osujs/core";
import { traceMapText, normalizeTraceState } from "../../../../../../../../libs/osu/core/test/ReplayTraceFixtures";

function fixture(native = false) {
  const map = buildBeatmap(parseBlueprint(traceMapText("300,192,1000,1,0\n300,192,5000,1,0")), {
    mods: [],
    addStacking: false,
  });
  const replay: OsuReplay = {
    md5hash: "replay",
    beatmapMd5: "map",
    player: "synthetic",
    mods: [],
    gameVersion: 20200101,
    gameMode: 0,
    ...(native ? { sourceClient: "lazer" as const, sourceProvenance: "user-confirmed" as const } : {}),
    frames: [
      { time: 0, position: { x: 300, y: 192 }, actions: [] },
      { time: 1200, position: { x: 300, y: 192 }, actions: [] },
    ],
  };
  return { map, replay };
}
function traceOf(s: GameSimulator): ReplayTrace {
  const state = s.missExplanations$.value;
  if (state.status !== "ready" && state.status !== "partial")
    throw Error("No captured session: " + JSON.stringify(state));
  return state.trace;
}
describe("opt-in miss explanation sidecar", () => {
  it("gives separate in-memory simulator instances distinct fallback identities", () => {
    const { map, replay } = fixture(),
      a = new GameSimulator(),
      b = new GameSimulator();
    a.setMissExplanationCaptureEnabled(true);
    b.setMissExplanationCaptureEnabled(true);
    a.simulateReplay(map, replay);
    b.simulateReplay(map, { ...replay, frames: replay.frames.map((f) => ({ ...f, position: { x: 0, y: 0 } })) });
    expect(traceOf(a).identity.generationKey).not.toBe(traceOf(b).identity.generationKey);
  });
  it.each([false, true])("does not publish failed canonical source capture native=%s", (native) => {
    const { map, replay } = fixture(native),
      s = new GameSimulator();
    s.setMissExplanationCaptureEnabled(true);
    const spy = jest
      .spyOn(native ? LazerGameStateTimeMachine.prototype : BucketedGameStateTimeMachine.prototype, "gameStateAt")
      .mockImplementation(() => {
        throw Error("injected gameplay failure");
      });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      if (native) s.simulateReplay(map, replay);
      else expect(() => s.simulateReplay(map, replay)).toThrow("injected gameplay failure");
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
    expect(s.getMissExplanation("0")).toBeUndefined();
    expect(s.missExplanations$.value.status).toBe("error");
  });
  it("defaults off and performs no capture when enabled only after load", () => {
    const { map, replay } = fixture(),
      s = new GameSimulator();
    expect(s.missExplanations$.value.status).toBe("empty");
    s.simulateReplay(map, replay);
    expect(s.missExplanations$.value.status).toBe("not-captured");
    s.setMissExplanationCaptureEnabled(true);
    expect(s.getMissExplanation("0")).toBeUndefined();
    s.simulate(1200);
    expect(s.missExplanations$.value.status).toBe("not-captured");
  });
  it.each([false, true])("preserves complete state/events and isolates source profile native=%s", (native) => {
    const { map, replay } = fixture(native),
      off = new GameSimulator(),
      on = new GameSimulator();
    off.simulateReplay(map, replay);
    on.setMissExplanationCaptureEnabled(true);
    on.simulateReplay(map, replay);
    const trace = traceOf(on),
      profile = native ? "lazer" : "stable";
    expect(trace.identity.analysisProfileId).toBe(profile);
    expect(trace.records.filter((r) => r.kind === "input")).toHaveLength(2);
    expect(on.getMissExplanation("0")).toBeDefined();
    expect(on.getMissExplanation("1")).toBeUndefined();
    for (const t of [1200, 0, 999, 1200]) {
      off.simulate(t);
      on.simulate(t);
      expect(normalizeTraceState(on.getCurrentState())).toEqual(normalizeTraceState(off.getCurrentState()));
      expect(on.replayEvents$.value).toEqual(off.replayEvents$.value);
      expect(traceOf(on)).toBe(trace);
    }
    on.setRulesetFocus(native ? "stable" : "lazer");
    expect(on.getMissExplanation("0")).toBeUndefined();
    expect(on.missExplanations$.value.status).toBe("not-captured");
    on.setRulesetFocus(profile);
    expect(traceOf(on)).toBe(trace);
    on.clear();
    expect(on.missExplanations$.value.status).toBe("empty");
  });
  it("keeps health and synthesized endpoint provenance without judging future objects", () => {
    const { map, replay } = fixture();
    replay.frames.push({ time: 1800, position: { x: 0, y: 0 }, actions: [] });
    replay.lifeBar = [
      { time: 0, health: 1 },
      { time: 1300, health: 0 },
    ];
    const s = new GameSimulator();
    s.setMissExplanationCaptureEnabled(true);
    s.simulateReplay(map, replay);
    const trace = traceOf(s);
    expect(trace.domain).toMatchObject({ endTimeMs: 1300, endpointBasis: "health-derived", synthesizedEndpoint: true });
    expect(trace.domain.frameSources?.[2]).toMatchObject({ origin: "synthetic" });
    expect(s.getMissExplanation("1")).toBeUndefined();
  });
  it("invalidates replaced/failed loads and unsupported profiles without harming scores", () => {
    const { map, replay } = fixture(),
      s = new GameSimulator();
    s.setMissExplanationCaptureEnabled(true);
    s.simulateReplay(map, replay);
    const first = traceOf(s).identity.generationKey;
    s.simulateReplay(map, replay);
    expect(traceOf(s).identity.generationKey).not.toBe(first);
    const modMap = buildBeatmap(parseBlueprint(traceMapText("300,192,1000,1,0")), {
      mods: ["HIDDEN"],
      addStacking: false,
    });
    s.simulateReplay(modMap, { ...replay, mods: ["HIDDEN"] });
    expect(["ready", "partial"]).toContain(s.missExplanations$.value.status);
    expect(s.getMissExplanation("0")).toBeDefined();
    s.simulateReplay(modMap, { ...replay, gameMode: 1 });
    expect(s.missExplanations$.value.status).toBe("unsupported");
    expect(s.getMissExplanation("0")).toBeUndefined();
    expect(() => s.simulateReplay(map, { ...replay, lazerMods: [{ acronym: "MR" }] })).toThrow();
    expect(s.getMissExplanation("0")).toBeUndefined();
  });
});
