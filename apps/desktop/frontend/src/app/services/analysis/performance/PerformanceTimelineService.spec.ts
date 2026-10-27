import { ipcRenderer } from "electron";
import { PerformanceTimelineService } from "./PerformanceTimelineService";
import { PERFORMANCE_ENGINE_VERSION, performanceAt, starRatingAt } from "@rewind/osu-performance/protocol";
import type { PerformanceResponse } from "@rewind/osu-performance/protocol";
import type { ReplayPerformanceInput } from "@rewind/osu-performance/types";
import type { CurrentReplayCaptureContext } from "../../library/library-current-replay";
import { LIBRARY_REPLAY_PARSER_VERSION, LIBRARY_RESOURCE_PREPARATION_VERSION } from "../../../../../../shared/library-analysis";

jest.mock("electron", () => ({ ipcRenderer: { invoke: jest.fn(), send: jest.fn() } }));

const inputs: ReplayPerformanceInput[] = ["stable", "lazer-classic"].map((mode) => ({
  mode: mode as ReplayPerformanceInput["mode"],
  states: [],
  finalReplayTime: 2000,
  limitations: [],
  mods: [],
}));
const response: Required<Pick<PerformanceResponse, "ok" | "engineVersion" | "timelines">> = {
  ok: true,
  engineVersion: PERFORMANCE_ENGINE_VERSION,
  timelines: [
    {
      mode: "stable",
      points: [
        { time: 1000, pp: 10, sr: 1 },
        { time: 2000, pp: 20, sr: 2 },
      ],
      difficultyPoints: [
        { time: 1000, sr: 1.1 },
        { time: 2000, sr: 2.1 },
        { time: 3000, sr: 3.1 },
      ],
    },
    {
      mode: "lazer-classic",
      points: [{ time: 1000, pp: 12, sr: 1.2 }],
      difficultyPoints: [
        { time: 1000, sr: 1.3 },
        { time: 3000, sr: 3.3 },
      ],
    },
  ],
};

beforeEach(() => jest.clearAllMocks());

function waitForSettled(service: PerformanceTimelineService, signal: AbortSignal): Promise<void> {
  return service.waitForSettled(signal);
}

describe("background performance preparation", () => {
  function pendingPreparation() {
    let resolve!: (value: PerformanceResponse) => void;
    (ipcRenderer.invoke as jest.Mock).mockReturnValueOnce(
      new Promise<PerformanceResponse>((done) => {
        resolve = done;
      }),
    );
    const service = new PerformanceTimelineService();
    const loading = service.load("pending map", inputs);
    return { service, loading, resolve };
  }

  it("labels pending live values without fabricating zero PP or SR", async () => {
    const { service, loading, resolve } = pendingPreparation();
    expect(service.at("stable", 1_000)).toEqual({ description: "Calculating replay performance…" });
    resolve(response);
    await loading;
  });

  it("waits for the current calculation and releases its observer on completion", async () => {
    const { service, loading, resolve } = pendingPreparation();
    let settled = false;
    const waiting = waitForSettled(service, new AbortController().signal).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(service.changed$.observers).toHaveLength(1);
    resolve(response);
    await Promise.all([loading, waiting]);
    expect(service.changed$.observers).toHaveLength(0);
    expect(service.at("stable", 2_000).point?.pp).toBe(20);
  });

  it("aborts an export wait without cancelling the replay's calculation", async () => {
    const { service, loading, resolve } = pendingPreparation();
    const abort = new AbortController();
    const waiting = waitForSettled(service, abort.signal);
    const failure = expect(waiting).rejects.toThrow(/cancel/i);
    abort.abort();
    await failure;
    expect(service.changed$.observers).toHaveLength(0);
    expect(service.fullMap("stable").status).toBe("loading");
    expect(ipcRenderer.send).toHaveBeenCalledTimes(1);
    resolve(response);
    await loading;
    expect(service.fullMap("stable").status).toBe("ready");
  });

  it("rejects a wait when the replay is cleared instead of adopting a replacement", async () => {
    const { service, loading, resolve } = pendingPreparation();
    const waiting = waitForSettled(service, new AbortController().signal);
    const failure = expect(waiting).rejects.toThrow(/changed/i);
    service.clear();
    await failure;
    expect(service.changed$.observers).toHaveLength(0);
    resolve(response);
    await loading;
    expect(service.fullMap("stable").status).toBe("unavailable");
  });

  it("settles on an unavailable result, preserving existing exports with absent PP", async () => {
    const { service, loading, resolve } = pendingPreparation();
    const waiting = waitForSettled(service, new AbortController().signal);
    resolve({ ok: false, error: "Unsupported mod" });
    await Promise.all([waiting, loading]);
    expect(service.at("stable", 1_000)).toEqual({ description: "Unsupported mod" });
    expect(service.changed$.observers).toHaveLength(0);
  });

  it("returns immediately when settled and rejects an already-aborted request without observers", async () => {
    const service = new PerformanceTimelineService();
    await waitForSettled(service, new AbortController().signal);
    const abort = new AbortController();
    abort.abort();
    await expect(waitForSettled(service, abort.signal)).rejects.toThrow(/cancel/i);
    expect(service.changed$.observers).toHaveLength(0);
  });
});

const fullDifficulty = { total: 7.19, aim: 4.2, speed: 2.13, reading: 1.36, flashlight: 0, sliderFactor: 0.983 };

it.each([1.0000076619481455,1.1])("keeps the viewer breakdown for official slider ratio %s without changing raw results",async sliderFactor=>{
  const raw={...fullDifficulty,sliderFactor};
  (ipcRenderer.invoke as jest.Mock).mockResolvedValue({...response,timelines:[{...response.timelines[0],fullDifficulty:raw}]});
  const service=new PerformanceTimelineService();await service.load("map",inputs);
  expect(service.fullMap("stable")).toMatchObject({status:"ready",pp:20,sr:7.19,breakdown:{total:7.19,sliderAim:0}});
  expect(raw.sliderFactor).toBe(sliderFactor);
});

it.each([-1,NaN,Infinity,-Infinity,null,undefined,"1.1",{}])("omits the viewer breakdown for invalid slider ratio %s",async sliderFactor=>{
  (ipcRenderer.invoke as jest.Mock).mockResolvedValue({...response,timelines:[{...response.timelines[0],fullDifficulty:{...fullDifficulty,sliderFactor}}]});
  const service=new PerformanceTimelineService();await service.load("map",inputs);
  expect(service.fullMap("stable").breakdown).toBeUndefined();
});

it("summarizes achieved PP and full-map SR independently of playback position and final PP metadata", async () => {
  (ipcRenderer.invoke as jest.Mock).mockResolvedValue({
    ...response,
    timelines: [
      { ...response.timelines[0], fullDifficulty, final: { pp: 9999, sr: 7.19 } },
      { ...response.timelines[1], fullDifficulty: { ...fullDifficulty, total: 8 }, final: { pp: 12, sr: 8 } },
    ],
  });
  const service = new PerformanceTimelineService();
  await service.load("map", inputs);
  expect(service.fullMap("stable")).toMatchObject({
    status: "ready",
    pp: 20,
    sr: 7.19,
    breakdown: { total: 7.19, aim: 3.93, speed: 1.99, reading: 1.27, flashlight: 0, sliderAim: 0.07 },
  });
  expect(service.fullMap("lazer")).toMatchObject({ status: "ready", pp: 12, sr: 8 });
  for (const time of [0, 3000, 1000]) {
    service.at("stable", time);
    expect(service.fullMap("stable").pp).toBe(20);
  }
  expect(service.fullMap("lazer").description).toContain("Lazer + Classic");
  expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
});

it("keeps full-map difficulty when no replay objects were completed", async () => {
  (ipcRenderer.invoke as jest.Mock).mockResolvedValue({
    ...response,
    timelines: [{ ...response.timelines[0], points: [], fullDifficulty }],
  });
  const service = new PerformanceTimelineService();
  await service.load("map", inputs);
  expect(service.fullMap("stable")).toMatchObject({ status: "ready", pp: 0, sr: 7.19 });
});

it("notifies an open summary on load completion and clear without accepting a stale response", async () => {
  let resolveOld!: (value: unknown) => void;
  (ipcRenderer.invoke as jest.Mock)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce({ ...response, timelines: [{ ...response.timelines[0], fullDifficulty }] });
  const service = new PerformanceTimelineService();
  const snapshots: string[] = [];
  const subscription = service.changed$.subscribe(() => snapshots.push(service.fullMap("stable").status));
  const pending = service.load("old", inputs);
  expect(service.fullMap("stable").status).toBe("loading");
  await service.load("new", inputs);
  expect(snapshots[snapshots.length - 1]).toBe("ready");
  resolveOld({ ok: false, error: "Old error" });
  await pending;
  expect(service.fullMap("stable").status).toBe("ready");
  service.clear();
  expect(snapshots[snapshots.length - 1]).toBe("unavailable");
  expect(service.fullMap("stable").pp).toBeUndefined();
  subscription.unsubscribe();
});

it("reports a failed full-map calculation without presenting zero PP or SR", async () => {
  (ipcRenderer.invoke as jest.Mock).mockResolvedValue({ ok: false, error: "Unsupported mod ZZ" });
  const service = new PerformanceTimelineService();
  await service.load("map", inputs);
  expect(service.fullMap("stable")).toEqual({ status: "unavailable", description: "Unsupported mod ZZ" });
});

it("never substitutes final metadata or a future judgement for achieved PP", async () => {
  (ipcRenderer.invoke as jest.Mock).mockResolvedValue({
    ...response,
    timelines: [
      {
        ...response.timelines[0],
        points: [
          { time: 1000, pp: 40, sr: 1 },
          { time: 2000, pp: 12, sr: 2 },
        ],
        final: { pp: 9999, sr: 99 },
      },
    ],
  });
  const service = new PerformanceTimelineService();
  await service.load("map", inputs);
  // Include a decrease, the replay end, map end, and reverse seeks. This also
  // guards against treating the greatest PP so far as the current value.
  for (const [time, pp] of [
    [999, 0],
    [1000, 40],
    [1999, 40],
    [2000, 12],
    [3000, 12],
    [10000, 12],
    [1999, 40],
    [2000, 12],
  ]) {
    expect(service.at("stable", time).point?.pp).toBe(pp);
  }
});

it("looks up both modes and backward seeks without calculator calls", async () => {
  (ipcRenderer.invoke as jest.Mock).mockResolvedValue(response);
  const service = new PerformanceTimelineService();
  await service.load("map", inputs);
  expect(service.at("stable", 999).point?.pp).toBe(0);
  expect(service.at("stable", 999).point?.sr).toBe(0);
  expect(service.at("stable", 2000).point?.pp).toBe(20);
  expect(service.at("stable", 1000).point?.pp).toBe(10);
  expect(service.at("lazer", 1000).point?.pp).toBe(12);
  expect(service.at("lazer", 1000).point?.sr).toBe(1.3);
  expect(service.at("lazer", 1000).description).toContain("Lazer + Classic");
  for (let i = 0; i < 1000; i++) service.at("stable", i * 10);
  expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
  expect((ipcRenderer.invoke as jest.Mock).mock.calls[0][1].calculations).toEqual(
    inputs.map(({ mode, mods, states }) => ({ mode, mods, states })),
  );
});

it.each(["stable", "lazer"] as const)(
  "continues %s SR past failure while retaining achieved PP, including backward seeks",
  async (ruleset) => {
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(response);
    const service = new PerformanceTimelineService();
    await service.load("map", inputs);
    const expectedPp = ruleset === "stable" ? 20 : 12;
    const finalSr = ruleset === "stable" ? 3.1 : 3.3;
    const beforeEndSr = ruleset === "stable" ? 2.1 : 1.3;
    expect(service.at(ruleset, 2000).point).toMatchObject({ pp: expectedPp, sr: beforeEndSr });
    expect(service.at(ruleset, 3000).point).toEqual({ time: 3000, pp: expectedPp, sr: finalSr });
    expect(service.at(ruleset, 10000).point).toEqual({ time: 3000, pp: expectedPp, sr: finalSr });
    expect(service.at(ruleset, 1500).point).toMatchObject({
      pp: ruleset === "stable" ? 10 : 12,
      sr: ruleset === "stable" ? 1.1 : 1.3,
    });
    expect(service.at(ruleset, 999).point).toMatchObject({ pp: 0, sr: 0 });
    expect(service.at(ruleset, 3000).point?.sr).toBe(finalSr);
    expect(service.at(ruleset, 3000).description).toContain("SR follows completed beatmap objects");
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
  },
);

it("continues map SR when failure precedes the first completed replay object", async () => {
  (ipcRenderer.invoke as jest.Mock).mockResolvedValue({
    ...response,
    timelines: [{ ...response.timelines[0], points: [] }],
  });
  const service = new PerformanceTimelineService();
  await service.load("map", [{ ...inputs[0], finalReplayTime: 100 }]);
  expect(service.at("stable", 100).point).toMatchObject({ pp: 0, sr: 0 });
  expect(service.at("stable", 1000).point).toEqual({ time: 1000, pp: 0, sr: 1.1 });
  expect(service.at("stable", 3000).point).toEqual({ time: 3000, pp: 0, sr: 3.1 });
});

it.each([
  { acronym: "DT", settings: { speed_change: 1.2 } },
  { acronym: "HT", settings: { speed_change: 0.6 } },
])("looks up $acronym with DA and Classic in beatmap time without applying playback rate again", async (rateMod) => {
  (ipcRenderer.invoke as jest.Mock).mockResolvedValue(response);
  const service = new PerformanceTimelineService();
  const nativeInput: ReplayPerformanceInput = {
    ...inputs[1],
    mods: [rateMod, { acronym: "DA", settings: { approach_rate: 9 } }, { acronym: "CL" }],
  };
  await service.load("map", [nativeInput]);
  for (const time of [3000, 2999, 1000, 5000, 2999, 3000]) {
    expect(service.at("lazer", time).point).toMatchObject({ pp: 12, sr: time < 3000 ? 1.3 : 3.3 });
  }
  expect((ipcRenderer.invoke as jest.Mock).mock.calls[0][1].calculations[0].mods).toEqual(nativeInput.mods);
  expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
});

it("discards a result completed after clear or a newer load", async () => {
  let resolveOld!: (value: unknown) => void;
  (ipcRenderer.invoke as jest.Mock)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce(response);
  const service = new PerformanceTimelineService();
  const previous = service.load("old", inputs);
  await service.load("new", inputs);
  resolveOld({ ...response, timelines: [] });
  await previous;
  expect(service.at("stable", 2000).point?.pp).toBe(20);
  service.clear();
  expect(service.at("stable", 2000).point).toBeUndefined();
  expect(ipcRenderer.send).toHaveBeenCalledTimes(3);
});

it("keeps playback usable and exposes engine errors instead of false zero values", async () => {
  (ipcRenderer.invoke as jest.Mock).mockResolvedValue({ ok: false, error: "Unsupported mod ZZ" });
  const service = new PerformanceTimelineService();
  await service.load("map", inputs);
  expect(service.at("stable", 2000)).toEqual({ description: "Unsupported mod ZZ" });
});

it.each(["RX", "AP", "AT"])("exposes calculated PP and SR with unranked %s enabled", async (acronym) => {
  (ipcRenderer.invoke as jest.Mock).mockResolvedValue(response);
  const service = new PerformanceTimelineService();
  const input: ReplayPerformanceInput = {
    ...inputs[0],
    mods: [{ acronym }, { acronym: "HD" }],
    limitations: ["This configuration uses osu!'s combo-based estimate for Stable PP."],
  };

  await service.load("map", [input]);

  expect((ipcRenderer.invoke as jest.Mock).mock.calls[0][1].calculations[0].mods).toEqual(input.mods);
  expect(service.at("stable", 2000).point).toEqual({ time: 2000, pp: 20, sr: 2.1 });
  expect(service.at("stable", 2000).description).toContain(input.limitations[0]);
  expect(service.at("stable", 1000).point).toEqual({ time: 1000, pp: 10, sr: 1.1 });
});

it("chooses the last completed snapshot at tied timestamps", () => {
  const points = [
    { time: 1000, pp: 10, sr: 1 },
    { time: 1000, pp: 12, sr: 1.2 },
  ];
  expect(performanceAt(points, 1000)).toBe(points[1]);
  expect(performanceAt(points, -1000).pp).toBe(0);
  expect(performanceAt([], 1000).pp).toBe(0);
  const difficultyPoints = [
    { time: 1000, sr: 1 },
    { time: 1000, sr: 1.2 },
    { time: 2000, sr: 2 },
  ];
  expect(starRatingAt(difficultyPoints, 1000)).toBe(difficultyPoints[1]);
  expect(starRatingAt(difficultyPoints, -1000).sr).toBe(0);
  expect(starRatingAt([], 1000).sr).toBe(0);
  expect(starRatingAt(difficultyPoints, 3000)).toBe(difficultyPoints[2]);
});

it("retains a supported mode when the other mode cannot be calculated", async () => {
  (ipcRenderer.invoke as jest.Mock).mockResolvedValue({
    ...response,
    timelines: [
      response.timelines[0],
      { mode: "lazer-classic", points: [], difficultyPoints: [], error: "Unsupported Classic setting" },
    ],
  });
  const service = new PerformanceTimelineService();
  await service.load("map", inputs);
  expect(service.at("stable", 2000).point?.pp).toBe(20);
  expect(service.at("lazer", 2000)).toEqual({ description: "Unsupported Classic setting" });
});

describe("peak PP and PP if the replay were a full combo", () => {
  const stats = { great: 90, ok: 8, meh: 0, miss: 2, large_tick_hit: 0, large_tick_miss: 0, small_tick_hit: 0, small_tick_miss: 0, slider_tail_hit: 0, slider_tail_miss: 0 };
  const fullComboState = { time: 2000, passedObjects: 100, maxCombo: 150, statistics: { ...stats, great: 92, miss: 0 }, isFinal: true };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const fullCombo = (pp: number, modeName = "stable"): PerformanceResponse => ({
    ok: true,
    engineVersion: PERFORMANCE_ENGINE_VERSION,
    timelines: [{ mode: modeName as "stable", points: [{ time: 2000, pp, sr: 2 }], difficultyPoints: [] }],
  });
  // The replay reached 30 pp and ended on 20.
  const peaked: PerformanceResponse = {
    ...response,
    timelines: [{ ...response.timelines[0], points: [{ time: 500, pp: 12, sr: 1 }, { time: 1000, pp: 30, sr: 1 }, { time: 2000, pp: 20, sr: 2 }] }, response.timelines[1]],
  };

  it("reports the highest PP the replay reached beside its final PP", async () => {
    (ipcRenderer.invoke as jest.Mock).mockResolvedValueOnce(peaked);
    const service = new PerformanceTimelineService();
    await service.load("map", inputs);
    expect(service.fullMap("stable")).toMatchObject({ status: "ready", pp: 20, peakPp: 30 });
    expect(service.fullMap("lazer")).toMatchObject({ pp: 12, peakPp: 12 });
    // Nothing was asked about a full combo: no input describes one.
    expect(service.fullMap("stable").fullComboPp).toBeUndefined();
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
  });

  it("asks the engine once more for the full-combo state, without holding up the replay's own values", async () => {
    (ipcRenderer.invoke as jest.Mock).mockResolvedValueOnce(peaked).mockResolvedValueOnce(fullCombo(45));
    const service = new PerformanceTimelineService();
    await service.load("map", [{ ...inputs[0], fullComboState }, inputs[1]]);
    // Settled, with the replay's own values, before the second answer.
    await service.waitForSettled(new AbortController().signal);
    expect(service.fullMap("stable")).toMatchObject({ pp: 20, peakPp: 30 });
    await flush();
    expect((ipcRenderer.invoke as jest.Mock).mock.calls[1][1]).toEqual({
      beatmap: "map",
      calculations: [{ mode: "stable", mods: [], states: [fullComboState] }],
    });
    expect(service.fullMap("stable").fullComboPp).toBe(45);
    expect(service.fullMap("lazer").fullComboPp).toBeUndefined();
  });

  it("tells its listeners when the full-combo value arrives", async () => {
    (ipcRenderer.invoke as jest.Mock).mockResolvedValueOnce(peaked).mockResolvedValueOnce(fullCombo(45));
    const service = new PerformanceTimelineService();
    // What a listener reads each time it is told of a change.
    const read: Array<number | undefined> = [];
    service.changed$.subscribe(() => read.push(service.fullMap("stable").fullComboPp));
    await service.load("map", [{ ...inputs[0], fullComboState }]);
    await flush();
    expect(read[read.length - 1]).toBe(45);
  });

  it.each([
    ["the engine fails", () => Promise.reject(new Error("engine gone"))],
    ["the engine answers with an error", () => Promise.resolve({ ok: false, error: "no" })],
    ["the answer is another engine version's", () => Promise.resolve({ ...fullCombo(45), engineVersion: "other" })],
    ["the value is not a number", () => Promise.resolve(fullCombo(Number.NaN))],
  ])("has no full-combo value when %s, and keeps the replay's own", async (_name, answer) => {
    (ipcRenderer.invoke as jest.Mock).mockResolvedValueOnce(peaked).mockImplementationOnce(answer);
    const service = new PerformanceTimelineService();
    await service.load("map", [{ ...inputs[0], fullComboState }]);
    await flush();
    expect(service.fullMap("stable")).toMatchObject({ status: "ready", pp: 20, peakPp: 30 });
    expect(service.fullMap("stable").fullComboPp).toBeUndefined();
  });

  it("drops a full-combo answer that arrives for a replay that is gone", async () => {
    let answer!: (value: PerformanceResponse) => void;
    (ipcRenderer.invoke as jest.Mock)
      .mockResolvedValueOnce(peaked)
      .mockReturnValueOnce(new Promise<PerformanceResponse>((done) => (answer = done)))
      .mockResolvedValueOnce(peaked);
    const service = new PerformanceTimelineService();
    await service.load("map", [{ ...inputs[0], fullComboState }]);
    await service.load("another map", inputs);
    answer(fullCombo(45));
    await flush();
    expect(service.fullMap("stable").fullComboPp).toBeUndefined();
  });
});

describe("effective miss count", () => {
  const withEffectiveMiss = (value: unknown): PerformanceResponse => ({
    ...response,
    timelines: [{ ...response.timelines[0], effectiveMissCount: value as number }, response.timelines[1]],
  });

  it("passes the engine's effective miss count through for a ready full-map result", async () => {
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(withEffectiveMiss(2.375));
    const service = new PerformanceTimelineService();
    await service.load("map", inputs);
    expect(service.fullMap("stable")).toMatchObject({ status: "ready", pp: 20, effectiveMissCount: 2.375 });
    // The other mode's timeline did not send one.
    expect(service.fullMap("lazer").effectiveMissCount).toBeUndefined();
  });

  it("keeps a count of zero, which a full combo has", async () => {
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(withEffectiveMiss(0));
    const service = new PerformanceTimelineService();
    await service.load("map", inputs);
    expect(service.fullMap("stable").effectiveMissCount).toBe(0);
  });

  it.each([
    ["did not send one", undefined],
    ["sent null", null],
    ["sent a negative one", -0.5],
    ["sent a non-finite one", Number.POSITIVE_INFINITY],
    ["sent one that is not a number", "2"],
  ])("leaves it undefined when the engine %s", async (_name, value) => {
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(withEffectiveMiss(value));
    const service = new PerformanceTimelineService();
    await service.load("map", inputs);
    expect(service.fullMap("stable")).toMatchObject({ status: "ready", pp: 20 });
    expect(service.fullMap("stable").effectiveMissCount).toBeUndefined();
  });

  it("has none while loading or when the calculation failed", async () => {
    let answer!: (value: PerformanceResponse) => void;
    (ipcRenderer.invoke as jest.Mock).mockReturnValueOnce(new Promise<PerformanceResponse>((done) => (answer = done)));
    const service = new PerformanceTimelineService();
    const loading = service.load("map", inputs);
    expect(service.fullMap("stable").effectiveMissCount).toBeUndefined();
    answer({
      ...response,
      timelines: [{ ...response.timelines[0], effectiveMissCount: 3, error: "Unsupported mod" }, response.timelines[1]],
    });
    await loading;
    expect(service.fullMap("stable")).toEqual({ status: "unavailable", description: "Unsupported mod" });
  });
});

describe("completed library performance capture", () => {
  const state={time:2000,passedObjects:1,maxCombo:1,isFinal:true,statistics:{great:1,ok:0,meh:0,miss:0,
    large_tick_hit:0,large_tick_miss:0,small_tick_hit:0,small_tick_miss:0,slider_tail_hit:0,slider_tail_miss:0}};
  function context(mode:ReplayPerformanceInput["mode"]="stable"):CurrentReplayCaptureContext {
    return {generation:1,binding:{replaySha256:"a".repeat(64),mapSha256:"b".repeat(64),mapMd5:"c".repeat(32),
      numericalInputKey:"d".repeat(64),mode,clockRate:1,objectCount:1,parserVersion:LIBRARY_REPLAY_PARSER_VERSION,
      preparationVersion:LIBRARY_RESOURCE_PREPARATION_VERSION},
      performanceInput:{mode,states:[state],fullComboState:state,finalReplayTime:2000,mods:[],limitations:[]}};
  }
  function answer(mode:ReplayPerformanceInput["mode"]="stable",pp=0):PerformanceResponse {
    return {ok:true,engineVersion:PERFORMANCE_ENGINE_VERSION,timelines:[{mode,objectCount:1,endpointVerified:true,
      points:[{time:2000,pp,sr:1}],difficultyPoints:[],final:{pp,sr:1}}]};
  }
  it("captures actual zero endpoints without waiting for the independently pending FC response",async()=>{
    const token=context();let resolveFc!:(value:PerformanceResponse)=>void;
    (ipcRenderer.invoke as jest.Mock).mockResolvedValueOnce(answer()).mockReturnValueOnce(new Promise(resolve=>{resolveFc=resolve;}));
    const service=new PerformanceTimelineService();await service.load("map",[token.performanceInput],token);
    const snapshot=service.captureLibraryPerformance(token)!;
    expect(snapshot.fullMap).toMatchObject({pp:0,peakPp:0});
    expect(snapshot.timeline).toEqual({mode:"stable",objectCount:1,endpointVerified:true,pointCount:1,lastPoint:{time:2000,pp:0,sr:1}});
    expect(snapshot.fcTimeline).toBeUndefined();expect(snapshot.fullMap.fullComboPp).toBeUndefined();
    expect(ipcRenderer.invoke).toHaveBeenCalledTimes(2);
    resolveFc(answer());await Promise.resolve();await Promise.resolve();
    expect(service.captureLibraryPerformance(token)).toMatchObject({fullMap:{fullComboPp:0},fcTimeline:{pointCount:1,lastPoint:{pp:0}}});
    expect(snapshot.fcTimeline).toBeUndefined();
  });
  it.each(["lazer","lazer-classic"] as const)("selects the exact %s mode without substituting a comparison input",async mode=>{
    const token=context(mode),other=context("stable").performanceInput;
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(answer(mode));
    const service=new PerformanceTimelineService();await service.load("map",[other,token.performanceInput],token);
    expect(service.captureLibraryPerformance(token)!.input).toBe(token.performanceInput);
    expect(service.captureLibraryPerformance({...token})).toBeUndefined();
    expect(service.captureLibraryPerformance(token)!.timeline!.mode).toBe(mode);
  });
  it("requires the same admission token even when a later load reuses the same input object",async()=>{
    const token=context(),next={...token,generation:2};let oldFc!:(value:PerformanceResponse)=>void;
    (ipcRenderer.invoke as jest.Mock).mockResolvedValueOnce(answer()).mockReturnValueOnce(new Promise(resolve=>{oldFc=resolve;}))
      .mockResolvedValueOnce(answer()).mockReturnValueOnce(new Promise(()=>undefined));
    const service=new PerformanceTimelineService();await service.load("old",[token.performanceInput],token);
    await service.load("new",[token.performanceInput],next);
    oldFc(answer("stable",99));await Promise.resolve();await Promise.resolve();
    expect(service.captureLibraryPerformance(token)).toBeUndefined();
    expect(service.captureLibraryPerformance(next)!.fcTimeline).toBeUndefined();
    service.clear();expect(service.captureLibraryPerformance(next)).toBeUndefined();
  });
  it("does not capture a pending, failed, unbound or wrong-input load",async()=>{
    const token=context();let resolve!:(value:PerformanceResponse)=>void;
    (ipcRenderer.invoke as jest.Mock).mockReturnValueOnce(new Promise(done=>{resolve=done;}));
    const service=new PerformanceTimelineService();const loading=service.load("map",[token.performanceInput],token);
    expect(service.captureLibraryPerformance(token)).toBeUndefined();resolve({ok:false,error:"failed"});await loading;
    expect(service.captureLibraryPerformance(token)).toBeUndefined();
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(answer());
    await service.load("map",[token.performanceInput]);expect(service.captureLibraryPerformance(token)).toBeUndefined();
    await service.load("map",[{...token.performanceInput}],token);expect(service.captureLibraryPerformance(token)).toBeUndefined();
  });
  it("retains actual empty-response facts instead of labelling display zero as a calculated prefix",async()=>{
    const token=context();token.performanceInput.fullComboState=undefined;
    const empty=answer();empty.timelines![0].points=[];
    (ipcRenderer.invoke as jest.Mock).mockResolvedValueOnce(empty);
    const service=new PerformanceTimelineService();await service.load("map",[token.performanceInput],token);
    const snapshot=service.captureLibraryPerformance(token)!;
    expect(snapshot.fullMap.pp).toBe(0);expect(snapshot.timeline).toMatchObject({pointCount:0});
    expect(snapshot.timeline!.lastPoint).toBeUndefined();expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
  });
  it("captures exact Classic values even if another native mode precedes it in the viewer inputs",async()=>{
    const token=context("lazer-classic"),other=context("lazer").performanceInput;
    const output=answer("lazer-classic");output.timelines!.unshift(answer("lazer",15).timelines![0]);
    (ipcRenderer.invoke as jest.Mock).mockResolvedValue(output);
    const service=new PerformanceTimelineService();await service.load("map",[other,token.performanceInput],token);
    expect(service.fullMap("lazer").pp).toBe(15);
    expect(service.captureLibraryPerformance(token)!.fullMap.pp).toBe(0);
    const captured=service.captureLibraryPerformance(token)!;captured.timeline!.lastPoint!.pp=99;
    expect(service.captureLibraryPerformance(token)!.timeline!.lastPoint!.pp).toBe(0);
  });
});
