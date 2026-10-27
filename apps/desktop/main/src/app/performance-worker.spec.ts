import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { spawn } from "child_process";
import { setPriority,constants } from "os";
import { PerformanceWorker } from "./performance-worker";
import { PERFORMANCE_ENGINE_VERSION, PerformanceRequest } from "@rewind/osu-performance/protocol";

jest.mock("child_process", () => ({ spawn: jest.fn() }));
jest.mock("os",()=>({...jest.requireActual("os"),setPriority:jest.fn()}));

const request: PerformanceRequest = {
  beatmap: "map",
  calculations: [
    {
      mode: "stable",
      states: [],
      mods: [],
    },
  ],
};
const response = {
  ok: true,
  engineVersion: PERFORMANCE_ENGINE_VERSION,
  timelines: [
    {
      mode: "stable",
      points: [{ time: 1000, pp: 42, sr: 1.2 }],
      fullDifficulty: { total: 2.3, aim: 1, speed: 0.5, reading: 0.25, flashlight: 0, sliderFactor: 0.8 },
      difficultyPoints: [
        { time: 1000, sr: 1.2 },
        { time: 2000, sr: 2.3 },
      ],
    },
  ],
};

function childFixture() {
  const requests: Array<PerformanceRequest & { id?: number }> = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: jest.fn(),
    requests,
    reply: (result: unknown = response) =>
      child.stdout.write(JSON.stringify({ ...(result as object), id: requests[requests.length - 1]?.id }) + "\n"),
  });
  child.stdin.on("data", (data: Buffer) => requests.push(JSON.parse(data.toString())));
  (spawn as jest.Mock).mockReturnValue(child);
  return child;
}

beforeEach(() => jest.clearAllMocks());
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it("keeps explicit background disposal pending until every retired helper actually closes",async()=>{
  const first=childFixture(),worker=new PerformanceWorker(()=>"engine.exe");const old=worker.calculate(1,request);worker.cancel(1);await old;
  const second=childFixture(),pending=worker.calculate(2,{...request,beatmap:"other"});second.reply();await pending;
  let drained=false;const closing=worker.disposeAndDrain().then(()=>{drained=true;});await Promise.resolve();expect(drained).toBe(false);
  second.emit("close",0);await Promise.resolve();expect(drained).toBe(false);first.emit("close",1);await closing;expect(drained).toBe(true);
  expect(await worker.calculate(3,request)).toMatchObject({ok:false,error:expect.stringMatching(/closed/)});
});
it("reports unconfirmed background helper exit instead of releasing a native lease after a kill request",async()=>{
  jest.useFakeTimers();const child=childFixture(),worker=new PerformanceWorker(()=>"engine.exe");const pending=worker.calculate(1,request);
  const closing=worker.disposeAndDrain(),failed=expect(closing).rejects.toThrow(/exit not confirmed/);await pending;
  expect(child.kill).toHaveBeenCalledTimes(1);await jest.advanceTimersByTimeAsync(2000);await failed;
  child.emit("close",1);await expect(worker.disposeAndDrain()).rejects.toThrow(/exit not confirmed/);
});
it("settles every calculation when cleanup throws while still waiting for actual helper closes",async()=>{
  const first=childFixture(),worker=new PerformanceWorker(()=>"engine.exe");
  const one=worker.calculate(1,request);first.kill.mockImplementation(()=>{throw new Error("kill denied");});
  const second=childFixture(),two=worker.calculate(2,{...request,beatmap:"other"});
  const settled:unknown[]=[];void one.then(value=>settled.push(value));void two.then(value=>settled.push(value));
  let drained=false;const closing=worker.disposeAndDrain().then(()=>{drained=true;});
  for(let index=0;index<8;index++)await Promise.resolve();
  expect(settled).toHaveLength(2);expect(settled).toEqual([
    {ok:false,error:"Performance calculation cancelled"},{ok:false,error:"Performance calculation cancelled"}]);
  expect(drained).toBe(false);first.emit("close",1);await Promise.resolve();expect(drained).toBe(false);
  second.emit("close",1);await closing;expect(drained).toBe(true);
});
it("sets low native priority before library input and leaves foreground priority unchanged",async()=>{
  const child=Object.assign(childFixture(),{pid:123});
  (setPriority as jest.Mock).mockImplementation(()=>expect(child.requests).toHaveLength(0));
  const worker=new PerformanceWorker(()=>"engine.exe",{background:true}),pending=worker.calculate(1,request);
  expect(setPriority).toHaveBeenCalledWith(123,constants.priority.PRIORITY_LOW);child.reply();await pending;
  const closing=worker.disposeAndDrain();await Promise.resolve();child.emit("close",0);await closing;
  jest.mocked(setPriority).mockClear();const foregroundChild=childFixture(),foreground=new PerformanceWorker(()=>"engine.exe");
  const foregroundWork=foreground.calculate(1,request);foregroundChild.reply();await foregroundWork;foreground.dispose();
  expect(setPriority).not.toHaveBeenCalled();
});
it("fails library calculation without sending bytes if native priority cannot be applied",async()=>{
  const child=Object.assign(childFixture(),{pid:123});(setPriority as jest.Mock).mockImplementationOnce(()=>{throw new Error("priority denied");});
  const worker=new PerformanceWorker(()=>"engine.exe",{background:true});
  expect(await worker.calculate(1,request)).toMatchObject({ok:false,error:expect.stringMatching(/priority/i)});expect(child.requests).toHaveLength(0);
  let drained=false;const closing=worker.disposeAndDrain().then(()=>{drained=true;});await Promise.resolve();expect(drained).toBe(false);
  child.emit("close",1);await closing;
});

it("reuses its process for changed requests and caches identical inputs", async () => {
  const child = childFixture();
  const worker = new PerformanceWorker(() => "engine.exe");
  const pending = worker.calculate(1, request);
  child.reply();
  expect(await pending).toEqual(response);
  expect(child.kill).not.toHaveBeenCalled();
  expect(child.stdin.writableEnded).toBe(false);
  expect(await worker.calculate(1, request)).toEqual(response);
  expect(child.requests).toHaveLength(1);
  const changed = worker.calculate(1, { ...request, beatmap: "another map" });
  expect(child.requests).toHaveLength(2);
  expect(child.requests[1].id).not.toBe(child.requests[0].id);
  expect(child.requests[1].beatmap).toBe("another map");
  child.reply({ ...response, error: "distinct response" });
  expect(await changed).toEqual({ ...response, error: "distinct response" });
  expect(spawn).toHaveBeenCalledTimes(1);
  worker.dispose();
  expect(child.kill).toHaveBeenCalledTimes(1);
});

it("cancels obsolete work without terminating another window's calculation", async () => {
  const first = childFixture();
  const worker = new PerformanceWorker(() => "engine.exe");
  const old = worker.calculate(1, request);
  const second = childFixture();
  const other = worker.calculate(2, request);
  worker.cancel(1);
  expect((await old).ok).toBe(false);
  expect(first.kill).toHaveBeenCalledTimes(1);
  expect(second.kill).not.toHaveBeenCalled();
  second.reply();
  expect((await other).ok).toBe(true);
  worker.dispose();
});

it.each([0, 1, 1.0000076619481455, 1.1])("preserves the official finite nonnegative slider ratio %s", async sliderFactor => {
  const child = childFixture(), worker = new PerformanceWorker(() => "engine.exe");
  const pending = worker.calculate(1, request);
  const valid = { ...response, timelines: [{ ...response.timelines[0],
    fullDifficulty: { ...response.timelines[0].fullDifficulty, sliderFactor } }] };
  child.reply(valid);
  expect(await pending).toEqual(valid);
  expect(child.kill).not.toHaveBeenCalled();
  worker.dispose();
});

it("rejects stale engine versions and non-finite or unordered timeline data", async () => {
  for (const invalid of [
    { ...response, engineVersion: "old" },
    ...[
      {},
      { ...response.timelines[0].fullDifficulty, aim: null },
      { ...response.timelines[0].fullDifficulty, reading: -1 },
      ...[-1, null, undefined, "1.1", "Infinity", "NaN", {}].map(sliderFactor => ({ ...response.timelines[0].fullDifficulty, sliderFactor })),
    ].map((fullDifficulty) => ({ ...response, timelines: [{ ...response.timelines[0], fullDifficulty }] })),
    // A number that is negative, or one that arrived as the text of a non-finite value, is not an effective miss count.
    ...[-1, -0.01, "Infinity", "NaN", "2", {}].map((effectiveMissCount) => ({
      ...response,
      timelines: [{ ...response.timelines[0], effectiveMissCount }],
    })),
    { ...response, timelines: [{ ...response.timelines[0], difficultyPoints: undefined }] },
    { ...response, timelines: [{ ...response.timelines[0], difficultyPoints: [{ time: 2000, sr: null }] }] },
    { ...response, timelines: [{ ...response.timelines[0], difficultyPoints: [{ time: 2000, sr: -1 }] }] },
    {
      ...response,
      timelines: [
        {
          ...response.timelines[0],
          difficultyPoints: [
            { time: 2000, sr: 2 },
            { time: 1000, sr: 1 },
          ],
        },
      ],
    },
    { ...response, timelines: [{ mode: "stable", points: [{ time: 1000, pp: null, sr: 1 }] }] },
    {
      ...response,
      timelines: [
        {
          mode: "stable",
          points: [
            { time: 1000, pp: 1, sr: 1 },
            { time: 0, pp: 2, sr: 1 },
          ],
        },
      ],
    },
  ]) {
    const child = childFixture();
    const worker = new PerformanceWorker(() => "engine.exe");
    const pending = worker.calculate(1, request);
    child.reply(invalid);
    expect((await pending).ok).toBe(false);
    worker.dispose();
  }
});

it.each(["1e400", "-1e400"])("rejects a slider ratio that overflows to a non-finite number: %s", async sliderFactor => {
  const child = childFixture(), worker = new PerformanceWorker(() => "engine.exe");
  const pending = worker.calculate(1, request);
  const invalid = { ...response, id: child.requests[0].id, timelines: [{ ...response.timelines[0],
    fullDifficulty: { ...response.timelines[0].fullDifficulty, sliderFactor: 0 } }] };
  child.stdout.write(JSON.stringify(invalid).replace('"sliderFactor":0', '"sliderFactor":' + sliderFactor) + "\n");
  expect(await pending).toMatchObject({ ok: false, error: "Performance engine returned incompatible data" });
  worker.dispose();
});

it.each([[undefined], [null], [0], [2.375]])(
  "accepts an effective miss count of %s, absent or a finite number from zero up",
  async (effectiveMissCount) => {
    const child = childFixture();
    const worker = new PerformanceWorker(() => "engine.exe");
    const pending = worker.calculate(1, request);
    const valid = { ...response, timelines: [{ ...response.timelines[0], effectiveMissCount }] };
    child.reply(valid);
    // JSON drops undefined, so the parsed answer is what crossed the process boundary.
    expect(await pending).toEqual(JSON.parse(JSON.stringify(valid)));
    worker.dispose();
  },
);

it("assembles split UTF-8 characters and a separately received CRLF", async () => {
  const child = childFixture();
  const worker = new PerformanceWorker(() => "engine.exe");
  const expected = { ...response, timelines: [{ ...response.timelines[0], error: "測試 🎵" }] };
  const pending = worker.calculate(1, request);
  const encoded = Buffer.from(JSON.stringify({ ...expected, id: child.requests[0].id }));
  let resolved = false;
  void pending.then(() => (resolved = true));
  for (const byte of encoded) child.stdout.write(Buffer.from([byte]));
  await Promise.resolve();
  expect(resolved).toBe(false);
  child.stdout.write("\r");
  child.stdout.write("\n");
  expect(await pending).toEqual(expected);
  expect(child.kill).not.toHaveBeenCalled();
  worker.dispose();
});

it("uses received response bytes for cache accounting without serializing the parsed response again", async () => {
  const child = childFixture();
  const worker = new PerformanceWorker(() => "engine.exe");
  const pending = worker.calculate(1, request);
  const encoded = JSON.stringify({ ...response, id: child.requests[0].id }) + "\n";
  const stringify = jest.spyOn(JSON, "stringify");
  child.stdout.write(encoded);
  expect(await pending).toEqual(response);
  expect(stringify).not.toHaveBeenCalled();
  stringify.mockRestore();
  expect(await worker.calculate(1, request)).toEqual(response);
  expect(spawn).toHaveBeenCalledTimes(1);
  worker.dispose();
});

it("evicts the least recently used response after three cached requests", async () => {
  const worker = new PerformanceWorker(() => "engine.exe");
  const child = childFixture();
  const calculate = async (beatmap: string) => {
    const pending = worker.calculate(1, { ...request, beatmap });
    child.reply();
    expect(await pending).toEqual(response);
  };
  await calculate("a");
  await calculate("b");
  await calculate("c");
  await worker.calculate(1, { ...request, beatmap: "a" });
  await calculate("d");
  await worker.calculate(1, { ...request, beatmap: "c" });
  expect(child.requests).toHaveLength(4);
  await calculate("b");
  expect(child.requests).toHaveLength(5);
  expect(spawn).toHaveBeenCalledTimes(1);
  worker.dispose();
});

it("limits cached serialized bytes even when the parsed response is small", async () => {
  const worker = new PerformanceWorker(() => "engine.exe");
  const child = childFixture();
  const padding = " ".repeat(9 * 1024 * 1024);
  const calculate = async (beatmap: string) => {
    const pending = worker.calculate(1, { ...request, beatmap });
    // Valid JSON whitespace still occupies bytes in the received response.
    child.stdout.write(padding);
    child.reply();
    expect(await pending).toEqual(response);
  };
  await calculate("a");
  await calculate("b");
  expect(await worker.calculate(1, { ...request, beatmap: "b" })).toEqual(response);
  expect(child.requests).toHaveLength(2);
  await calculate("a");
  expect(child.requests).toHaveLength(3);
  worker.dispose();
});

it("does not cache a single response larger than the serialized cache budget", async () => {
  const worker = new PerformanceWorker(() => "engine.exe");
  const child = childFixture();
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = worker.calculate(1, request);
    child.stdout.write(" ".repeat(16 * 1024 * 1024));
    child.reply();
    expect(await pending).toEqual(response);
  }
  expect(child.requests).toHaveLength(2);
  worker.dispose();
});

it("rejects oversized UTF-8 output while receiving chunks before parsing a JSON line", async () => {
  const child = childFixture();
  const worker = new PerformanceWorker(() => "engine.exe");
  const pending = worker.calculate(1, request);
  const chunk = "中".repeat(1024 * 1024);
  for (let i = 0; i < 11; i++) child.stdout.write(chunk);
  expect(await pending).toEqual({ ok: false, error: "Performance engine response is too large" });
  expect(child.kill).toHaveBeenCalledTimes(1);
  worker.dispose();
});

it("rejects oversized input before starting a process", async () => {
  const worker = new PerformanceWorker(() => "engine.exe");
  expect(await worker.calculate(1, { ...request, beatmap: " ".repeat(32 * 1024 * 1024) })).toEqual({
    ok: false,
    error: "Replay performance input is too large",
  });
  expect(spawn).not.toHaveBeenCalled();
  worker.dispose();
});

it("times out once, releases partial output, and permits a fresh request", async () => {
  jest.useFakeTimers();
  const child = childFixture();
  const worker = new PerformanceWorker(() => "engine.exe");
  const pending = worker.calculate(1, request);
  child.stdout.write('{"ok":');
  jest.advanceTimersByTime(120_000);
  expect(await pending).toEqual({ ok: false, error: "Performance calculation timed out" });
  child.stdout.write(JSON.stringify(response) + "\n");
  child.emit("close", 1);
  expect(child.kill).toHaveBeenCalledTimes(1);
  const next = childFixture();
  const retry = worker.calculate(1, request);
  next.reply();
  expect(await retry).toEqual(response);
  expect(spawn).toHaveBeenCalledTimes(2);
  worker.dispose();
});

it.each([
  ["process", "Performance engine could not start: unavailable"],
  ["input", "Performance engine input failed: unavailable"],
  ["close", "Performance engine exited (7): unavailable"],
  ["json", "Performance engine returned invalid data"],
] as const)("releases failed %s calculations without caching them", async (failure, error) => {
  const child = childFixture();
  const worker = new PerformanceWorker(() => "engine.exe");
  const pending = worker.calculate(1, request);
  if (failure === "process") child.emit("error", new Error("unavailable"));
  else if (failure === "input") child.stdin.emit("error", new Error("unavailable"));
  else if (failure === "close") {
    child.stderr.write("unavailable");
    child.emit("close", 7);
  } else child.stdout.write("invalid JSON\n");
  expect(await pending).toEqual({ ok: false, error });
  expect(child.kill).toHaveBeenCalledTimes(1);
  const next = childFixture();
  const retry = worker.calculate(1, request);
  next.reply();
  expect(await retry).toEqual(response);
  expect(spawn).toHaveBeenCalledTimes(2);
  worker.dispose();
});

it("preserves idle reuse on owner cancellation but expires it after two minutes", async () => {
  jest.useFakeTimers();
  const child = childFixture();
  const worker = new PerformanceWorker(() => "engine.exe");
  const pending = worker.calculate(1, request);
  child.reply();
  jest.runAllTicks();
  expect(await pending).toEqual(response);
  worker.cancel(1);
  jest.advanceTimersByTime(119_999);
  expect(child.kill).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(child.kill).toHaveBeenCalledTimes(1);
  const next = childFixture();
  const retry = worker.calculate(2, { ...request, beatmap: "new" });
  next.reply();
  jest.runAllTicks();
  expect(await retry).toEqual(response);
  worker.dispose();
  expect(next.kill).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

it("retains only one idle process across owners", async () => {
  const first = childFixture();
  const worker = new PerformanceWorker(() => "engine.exe");
  const one = worker.calculate(1, request);
  const second = childFixture();
  const two = worker.calculate(2, { ...request, beatmap: "two" });
  first.reply();
  expect(await one).toEqual(response);
  second.reply();
  expect(await two).toEqual(response);
  expect(first.kill).toHaveBeenCalledTimes(1);
  expect(second.kill).not.toHaveBeenCalled();
  const three = worker.calculate(3, { ...request, beatmap: "three" });
  worker.cancel(1);
  expect(second.kill).not.toHaveBeenCalled();
  second.reply();
  expect(await three).toEqual(response);
  expect(spawn).toHaveBeenCalledTimes(2);
  worker.dispose();
});

it("retires a process after eight native requests without counting cache hits", async () => {
  const child = childFixture();
  const worker = new PerformanceWorker(() => "engine.exe");
  for (let index = 0; index < 8; index++) {
    const input = { ...request, beatmap: String(index) };
    const pending = worker.calculate(1, input);
    child.reply();
    expect(await pending).toEqual(response);
    expect(await worker.calculate(1, input)).toEqual(response);
    expect(child.kill).toHaveBeenCalledTimes(index === 7 ? 1 : 0);
  }
  const next = childFixture();
  const retry = worker.calculate(1, { ...request, beatmap: "ninth" });
  next.reply();
  expect(await retry).toEqual(response);
  expect(spawn).toHaveBeenCalledTimes(2);
  worker.dispose();
});

it.each(["duplicate", "trailing", "wrong id", "missing id", "null"])(
  "rejects %s protocol output and restarts for the next request",
  async (kind) => {
    const child = childFixture();
    const worker = new PerformanceWorker(() => "engine.exe");
    const pending = worker.calculate(1, request);
    const line = JSON.stringify({ ...response, id: child.requests[0].id });
    if (kind === "duplicate") child.stdout.write(line + "\n" + line + "\n");
    else if (kind === "trailing") child.stdout.write(line + "\n{");
    else if (kind === "wrong id") child.stdout.write(JSON.stringify({ ...response, id: -1 }) + "\n");
    else if (kind === "missing id") child.stdout.write(JSON.stringify(response) + "\n");
    else child.stdout.write("null\n");
    expect((await pending).ok).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);
    const next = childFixture();
    const retry = worker.calculate(1, request);
    next.reply();
    expect(await retry).toEqual(response);
    expect(spawn).toHaveBeenCalledTimes(2);
    worker.dispose();
  },
);

it("rejects a prior response ID after reusing a process", async () => {
  const child = childFixture();
  const worker = new PerformanceWorker(() => "engine.exe");
  const first = worker.calculate(1, request);
  const oldId = child.requests[0].id;
  child.reply();
  expect(await first).toEqual(response);
  const next = worker.calculate(2, { ...request, beatmap: "changed" });
  child.stdout.write(JSON.stringify({ ...response, id: oldId }) + "\n");
  expect((await next).ok).toBe(false);
  expect(child.kill).toHaveBeenCalledTimes(1);
  worker.dispose();
});

it("ignores late data, errors, and close from a cancelled child after replacement", async () => {
  const child = childFixture();
  const worker = new PerformanceWorker(() => "engine.exe");
  const first = worker.calculate(1, request);
  const next = childFixture();
  const replacement = worker.calculate(1, { ...request, beatmap: "replacement" });
  expect((await first).ok).toBe(false);
  child.reply();
  child.emit("error", new Error("late"));
  child.stdin.emit("error", new Error("late input"));
  child.emit("close", 1);
  expect(next.kill).not.toHaveBeenCalled();
  next.reply();
  expect(await replacement).toEqual(response);
  worker.dispose();
});

it.each(["output", "error", "close"])("retires an idle process after unsolicited %s", async (event) => {
  const child = childFixture();
  const worker = new PerformanceWorker(() => "engine.exe");
  const first = worker.calculate(1, request);
  child.reply();
  expect(await first).toEqual(response);
  if (event === "output") child.stdout.write("{partial");
  else if (event === "error") child.emit("error", new Error("idle"));
  else child.emit("close", 0);
  expect(child.kill).toHaveBeenCalledTimes(1);
  const next = childFixture();
  const replacement = worker.calculate(1, { ...request, beatmap: "replacement" });
  next.reply();
  expect(await replacement).toEqual(response);
  worker.dispose();
});

it("waits for input completion and drain before exposing a reusable process", async () => {
  const child = childFixture();
  let acknowledge: (error?: Error | null) => void = () => undefined;
  jest.spyOn(child.stdin, "write").mockImplementation(((data: string, callback: typeof acknowledge) => {
    child.requests.push(JSON.parse(data));
    acknowledge = callback;
    return false;
  }) as typeof child.stdin.write);
  const worker = new PerformanceWorker(() => "engine.exe");
  const pending = worker.calculate(1, request);
  let resolved = false;
  void pending.then(() => (resolved = true));
  child.reply();
  acknowledge();
  await Promise.resolve();
  expect(resolved).toBe(false);
  child.stdin.emit("drain");
  expect(await pending).toEqual(response);
  worker.dispose();
});

it("does not let a stale write callback affect a replacement calculation", async () => {
  const child = childFixture();
  let acknowledge: (error?: Error | null) => void = () => undefined;
  jest.spyOn(child.stdin, "write").mockImplementation(((_data: string, callback: typeof acknowledge) => {
    acknowledge = callback;
    return false;
  }) as typeof child.stdin.write);
  const worker = new PerformanceWorker(() => "engine.exe");
  const old = worker.calculate(1, request);
  const next = childFixture();
  const replacement = worker.calculate(1, { ...request, beatmap: "new" });
  expect((await old).ok).toBe(false);
  acknowledge(new Error("late write"));
  next.reply();
  expect(await replacement).toEqual(response);
  worker.dispose();
});
