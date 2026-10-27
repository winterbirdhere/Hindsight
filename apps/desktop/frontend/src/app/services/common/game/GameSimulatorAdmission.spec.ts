import { buildBeatmap, parseBlueprint, parseReplayFramesWithDiagnostics, SavedScoreTimeline } from "@osujs/core";
import { GameSimulator } from "./GameSimulator";
import { OsuReplay } from "../../../model/OsuReplay";
import { traceMapText, normalizeTraceState } from "../../../../../../../../libs/osu/core/test/ReplayTraceFixtures";
import { selectedErrorCauses } from "../../../components/analyzer/error-cause";
import { summarizeReplayEvents } from "../../analysis/replay-events";
import { MissExplanationSessionState } from "../../analysis/miss-explanation/MissExplanationSession";

function fixture() {
  const map = buildBeatmap(parseBlueprint(traceMapText("300,192,1000,1,0\n300,192,1500,1,0")), { mods: [], addStacking: false });
  const parsed = parseReplayFramesWithDiagnostics("0|256|-500|0,0|256|-500|0,700|300|192|0,300|300|192|0,300|300|192|0,200|300|192|0,300|300|192|0,700|300|192|0,");
  const replay: OsuReplay = { md5hash: "admission", beatmapMd5: "b".repeat(32), replayContentSha256: "a".repeat(64),
    player: "fixture", mods: [], gameVersion: 20200101, gameMode: 0, frames: parsed.frames, parseDiagnostics: parsed.diagnostics };
  return { map, replay };
}
function saved(conflict: boolean): SavedScoreTimeline {
  return { schema: "stable-saved-score-v1", provenance: { timelineSha256: "c".repeat(64), pairedReplaySha256: "a".repeat(64), mapMd5: "b".repeat(32), version: 20260711 }, rows: [],
    groups: [{ id: "saved:0", row: 0, time: conflict ? 1000 : 1800, ordinalStart: 0, count: 1,
      grades: { GREAT: conflict ? 1 : 0, OK: 0, MEH: 0, MISS: conflict ? 0 : 1 }, cumulativeCounts: conflict ? [1,0,0,0,0,0] : [0,0,0,0,0,1] }] };
}
const cases = [
  // Exceed the map count so the existing saved-score endpoint heuristic does
  // not shorten this fixture. Admission must not alter that scoring policy.
  { name: "Miss count", counts: [0,0,0,3], combo: 0 },
  { name: "grades and Miss", counts: [1,0,0,1], combo: 0 },
  { name: "combo only", counts: [0,0,0,2], combo: 1 },
  { name: "all totals", counts: [1,1,0,0], combo: 2 },
];
describe("saved results are advisory for reconstructed error admission", () => {
  it.each(cases.flatMap(c => ["absent", "rejected", "unavailable", "matching", "conflicting"].map(optional => ({...c, optional}))))(
    "$name with $optional optional records preserves analysis and gameplay", async ({counts,combo,optional}) => {
      const {map,replay}=fixture(), sim=new GameSimulator();
      replay.statistics={count300:counts[0],count100:counts[1],count50:counts[2],countMiss:counts[3],maxCombo:combo,score:0,perfectCombo:false};
      replay.savedScoreSource = optional === "matching" || optional === "conflicting"
        ? {status:"validated",attempts:[],timeline:saved(optional === "conflicting")}
        : {status:optional as "absent" | "rejected" | "unavailable",attempts:[]};
      try {
        sim.simulateReplay(map,replay,{beatmapMd5:replay.beatmapMd5}); sim.simulate(1e9);
        const events=sim.replayEvents$.value, state=sim.getCurrentState(), before=normalizeTraceState(state), frames=JSON.stringify(replay.frames);
        const validation=sim.validation$.value, nav=summarizeReplayEvents(events,"stable");
        expect(validation.verified).toBe(false);
        const session=await sim.analyzeMisses();
        expect(session.status).toBe("partial");
        if(session.status!=="partial") throw Error("Model analysis was vetoed");
        expect(session.reasons).toContain("global-totals-mismatch");
        expect(session.analysis?.outcomeBasis).toBe("model-reconstruction");
        expect(session.analysis?.excludedModelAtomIds).toEqual([]);
        expect(nav.errors.map(e=>selectedErrorCauses(e,events,"stable",session).map(c=>c.headline))).toEqual([["No tap"],["No tap"]]);
        if(optional === "conflicting") expect(session.analysis?.limitations).toContain("saved-outcome-model-conflict");
        if(optional === "matching") expect(session.analysis?.corroboration?.groups[0].consistency).toBe("corroborated");
        expect(await sim.analyzeMisses()).toBe(session);
        expect(sim.validation$.value).toBe(validation);expect(sim.getCurrentState()).toBe(state);expect(sim.replayEvents$.value).toBe(events);
        expect(normalizeTraceState(sim.getCurrentState())).toEqual(before);expect(JSON.stringify(replay.frames)).toBe(frames);
        expect(summarizeReplayEvents(sim.replayEvents$.value,"stable")).toEqual(nav);
        sim.setMissExplanationCaptureEnabled(true);sim.simulateReplay(map,replay,{beatmapMd5:replay.beatmapMd5});
        const sync=sim.missExplanations$.value;
        expect(sync.status).toBe("partial");
        if(sync.status!=="partial") throw Error("Synchronous model analysis was vetoed");
        expect(sync.analysis?.classifications.map(c=>c.mechanism.headline)).toEqual(session.analysis?.classifications.map(c=>c.mechanism.headline));
      } finally {sim.clear();}
    });
  it.each(["reconstruction-outcome-conflict", "saved-outcome-localization-unavailable"])("recomputes an obsolete cached %s refusal", async reason => {
    const {map,replay}=fixture(),sim=new GameSimulator();
    try {
      sim.simulateReplay(map,replay);
      (sim as unknown as {missSessions:Record<string,MissExplanationSessionState>}).missSessions.stable={status:"error",reasons:[reason]};
      const session=await sim.analyzeMisses();
      expect(["ready","partial"]).toContain(session.status);
      expect(await sim.analyzeMisses()).toBe(session);
    } finally {sim.clear();}
  });
});
