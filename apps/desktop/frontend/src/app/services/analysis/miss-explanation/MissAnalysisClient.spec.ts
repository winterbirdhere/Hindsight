import { errorFixture } from "../../../../../../../../libs/osu/core/test/ErrorAnalysisFixtures";
import { traceFrame } from "../../../../../../../../libs/osu/core/test/ReplayTraceFixtures";
import type { MissAnalysisInput } from "./MissAnalysisRunner";
import { configureMissAnalysisWorker, startMissAnalysis } from "./MissAnalysisClient";
import { runMissAnalysis } from "./MissAnalysisRunner";
import { encodeMissAnalysisSession } from "./MissAnalysisWire";

function fixture() {
  const frames = [traceFrame(0, 500, [], 0), traceFrame(1500, 500, [], 0)];
  const f = errorFixture("100,192,1000,1,0", frames);
  const input: MissAnalysisInput = {
    beatmap: f.map,
    frames,
    profile: "stable",
    domain: f.trace.domain,
    identity: f.trace.identity,
    limits: f.trace.limits,
    recording: {},
    additionalLimitations: [],
  };
  const worker = {
    onmessage: null as Worker["onmessage"],
    onerror: null as Worker["onerror"],
    onmessageerror: null as Worker["onmessageerror"],
    postMessage: jest.fn((_value: unknown) => undefined),
    terminate: jest.fn(),
  };
  const factory = jest.fn(() => worker as unknown as Worker);
  configureMissAnalysisWorker(factory);
  const respond = (body: object) => {
    const request = worker.postMessage.mock.calls[0][0] as { requestId: number };
    worker.onmessage?.call(
      worker as unknown as Worker,
      { data: { version: 1, requestId: request.requestId, ...body } } as MessageEvent,
    );
  };
  return { input, worker, factory, respond };
}
afterEach(() => configureMissAnalysisWorker(undefined));

it.each(["identity", "trace", "duplicate", "key", "building"])(
  "rejects a misowned or malformed %s result",
  async (fault) => {
    const f = fixture();
    const result = encodeMissAnalysisSession(await runMissAnalysis(f.input, async () => undefined));
    if (result.status !== "ready" && result.status !== "partial") throw Error("Fixture must capture");
    const data = JSON.parse(JSON.stringify(result));
    if (fault === "identity") data.identity.generationKey = "other";
    if (fault === "trace") data.trace.identity.analysisProfileFingerprint = "other";
    if (fault === "duplicate") data.explanationEntries.push(data.explanationEntries[0]);
    if (fault === "key") data.explanationEntries[0][0] = "other";
    if (fault === "building") data.status = "building";
    const job = startMissAnalysis(
      f.input,
      async () => undefined,
      () => undefined,
    );
    const rejected = expect(job.promise).rejects.toThrow("Invalid miss-analysis worker session");
    f.respond({ kind: "result", session: data });
    await rejected;
    expect(f.worker.terminate).toHaveBeenCalledTimes(1);
  },
);

it("uses the worker, relays phases and terminates after a complete result", async () => {
  const f = fixture(),
    progress = jest.fn(),
    checkpoint = jest.fn(async () => undefined);
  const job = startMissAnalysis(f.input, checkpoint, progress);
  expect(f.factory).toHaveBeenCalledTimes(1);
  expect(f.worker.postMessage).toHaveBeenCalledTimes(1);
  f.respond({ kind: "progress", phase: "capturing" });
  expect(progress).toHaveBeenCalledWith("capturing");
  f.respond({ kind: "result", session: { status: "unsupported", reasons: ["fixture"] } });
  expect(await job.promise).toEqual({ status: "unsupported", reasons: ["fixture"] });
  expect(f.worker.terminate).toHaveBeenCalledTimes(1);
  expect(checkpoint).toHaveBeenCalled();
});

it("terminates cancelled work and rejects stale progress/results", async () => {
  const f = fixture(),
    progress = jest.fn();
  const job = startMissAnalysis(f.input, async () => undefined, progress);
  const oldHandler = f.worker.onmessage!,
    request = f.worker.postMessage.mock.calls[0][0] as { requestId: number };
  const failure = job.promise.catch((error) => error as Error);
  job.cancel();
  for (const data of [
    { kind: "progress", phase: "capturing" },
    { kind: "result", session: { status: "empty" } },
  ])
    oldHandler.call(
      f.worker as unknown as Worker,
      { data: { version: 1, requestId: request.requestId, ...data } } as MessageEvent,
    );
  expect(await failure).toEqual(expect.objectContaining({ message: "Miss analysis cancelled" }));
  expect(progress).not.toHaveBeenCalled();
  expect(f.worker.terminate).toHaveBeenCalledTimes(1);
});

it("cancels during result hydration and never resolves the stale session", async () => {
  const f = fixture();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const job = startMissAnalysis(
    f.input,
    () => wait,
    () => undefined,
  );
  const failure = job.promise.catch((error) => error as Error);
  f.respond({ kind: "result", session: { status: "empty" } });
  await Promise.resolve();
  job.cancel();
  release();
  expect(await failure).toEqual(expect.objectContaining({ message: "Miss analysis cancelled" }));
  expect(f.worker.terminate).toHaveBeenCalledTimes(1);
});

it.each(["startup", "clone", "error", "messageerror", "invalid"])(
  "surfaces worker %s failure without running analysis inline",
  async (fault) => {
    const f = fixture(),
      progress = jest.fn();
    if (fault === "startup")
      f.factory.mockImplementationOnce(() => {
        throw new Error("start failed");
      });
    if (fault === "clone")
      f.worker.postMessage.mockImplementationOnce(() => {
        throw new Error("clone failed");
      });
    const job = startMissAnalysis(f.input, async () => undefined, progress);
    const rejected = expect(job.promise).rejects.toBeInstanceOf(Error);
    if (fault === "error")
      f.worker.onerror?.call(
        f.worker as unknown as Worker,
      { message: "worker failed", preventDefault: jest.fn() } as unknown as ErrorEvent,
      );
    if (fault === "messageerror") f.worker.onmessageerror?.call(f.worker as unknown as Worker, {} as MessageEvent);
    if (fault === "invalid") f.respond({ kind: "result", session: { status: "unknown" } });
    await rejected;
    expect(progress).not.toHaveBeenCalled();
    if (fault !== "startup") expect(f.worker.terminate).toHaveBeenCalledTimes(1);
  },
);
