import { LibraryUpdatePolicy } from "./library-update-policy";

function fixture(mode: "auto" | "launch" | "manual" = "auto") {
  const notify = new Map<string, () => void>(), errors = new Map<string, (error: Error) => void>();
  const completions: ((success: boolean) => void)[] = [];
  let held = false;
  const enabled = new Set(["one", "two"]), claimed = new Set<string>();
  const scan = jest.fn(() => new Promise<boolean>(resolve => completions.push(resolve)));
  const stop = jest.fn(), close = jest.fn(), save = jest.fn();
  const policy = new LibraryUpdatePolicy(["one", "two"], mode, {
    enabled: id => enabled.has(id), held: () => held, scan, stop, saveMode: save,
    claimLaunch: id => { if (claimed.has(id)) return false; claimed.add(id); return true; },
    watch: (id, changed, failed) => { notify.set(id, changed); errors.set(id, failed); return close; },
  });
  return { policy, notify, errors, completions, scan, stop, close, save, enabled, hold: (value: boolean) => { held = value; } };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
const settle = () => jest.advanceTimersByTimeAsync(350);

it("distinguishes certified startup checks from unknown watcher refreshes", async () => {
  const f = fixture(); f.policy.start(); await settle();
  expect(f.scan).toHaveBeenCalledWith("one", "check");
  f.notify.get("one")?.(); f.completions[0](true); f.completions[1](true); await settle();
  expect(f.scan).toHaveBeenLastCalledWith("one", "refresh");
  f.policy.close(); f.completions[2](true);
});
it("treats On launch as a check despite its explicit scheduling bit", async () => {
  const f = fixture("launch"); f.policy.start(); await settle();
  expect(f.scan).toHaveBeenCalledWith("one", "check"); expect(f.scan).toHaveBeenCalledWith("two", "check");
  f.policy.close(); f.completions.forEach(done => done(true));
});
it.each(["watch", "error", "explicit"])("retains stronger %s intent while startup is held", async kind => {
  const f = fixture(); f.hold(true); f.policy.start();
  if (kind === "watch") f.notify.get("one")?.();
  if (kind === "error") f.errors.get("one")?.(Error("unknown change"));
  if (kind === "explicit") f.policy.scanNow("one");
  await settle(); expect(f.scan).not.toHaveBeenCalled();
  f.hold(false); f.policy.resumePending(); await settle();
  expect(f.scan).toHaveBeenCalledWith("one", "refresh"); expect(f.scan).toHaveBeenCalledWith("two", "check");
  f.policy.close(); f.completions.forEach(done => done(true));
});
it.each(["watch", "explicit", "source", "mode"])("does not let a completing check consume later %s refresh intent", async kind => {
  const f = fixture(); f.policy.start(); await settle();
  if (kind === "watch") f.notify.get("one")?.();
  if (kind === "explicit") f.policy.scanNow("one");
  if (kind === "source") f.policy.sourceChanged("one");
  if (kind === "mode") { f.policy.setMode("manual"); f.policy.setMode("auto"); }
  f.completions[0](true); f.completions[1](true); await settle();
  expect(f.scan).toHaveBeenCalledWith("one", "refresh");
  f.policy.close(); f.completions.slice(2).forEach(done => done(true));
});
it("retains refresh after Stop and ignores an old epoch callback", async () => {
  const f = fixture(); f.policy.start(); const stale = f.notify.get("one");
  f.policy.stop("one"); f.policy.setMode("manual"); stale?.(); await settle(); expect(f.scan).not.toHaveBeenCalled();
  f.policy.scanNow("one"); await settle(); expect(f.scan).toHaveBeenLastCalledWith("one", "refresh");
  f.policy.close(); f.completions[0](true);
});

it("starts Automatic once and coalesces repeated changes into one successful follow-up", async () => {
  const f = fixture(); f.policy.start(); f.policy.start(); await settle(); expect(f.scan).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 20; i++) f.notify.get("one")?.();
  f.completions[0](true); f.completions[1](true); await settle(); expect(f.scan).toHaveBeenCalledTimes(3);
  f.completions[2](true); await settle(); expect(f.scan).toHaveBeenCalledTimes(3); f.policy.close();
});

it("retains dirty state on failure without a retry loop; a new event permits one attempt", async () => {
  const f = fixture(); f.policy.start(); await settle(); f.notify.get("one")?.(); f.completions[0](false); f.completions[1](true);
  await settle(); expect(f.scan).toHaveBeenCalledTimes(2); expect(f.policy.status("one").pending).toBe(true);
  await jest.advanceTimersByTimeAsync(60000); expect(f.scan).toHaveBeenCalledTimes(2);
  f.notify.get("one")?.(); await settle(); expect(f.scan).toHaveBeenCalledTimes(3); f.policy.close(); f.completions[2](false);
});

it("Stop cancels debounce and latches against late notifications until explicit Scan now", async () => {
  const f = fixture(); f.policy.start(); f.policy.stop("one"); f.notify.get("one")?.(); await settle();
  expect(f.scan).toHaveBeenCalledTimes(1); expect(f.policy.status("one").stopped).toBe(true);
  f.policy.scanNow("one"); await settle(); expect(f.scan).toHaveBeenCalledTimes(2); expect(f.policy.status("one").stopped).toBe(false);
  f.policy.close(); f.completions.forEach(done => done(false));
});

it("Manual has no automatic scans; selecting On launch waits for an app start", async () => {
  const f = fixture("manual"); f.policy.start(); await settle(); expect(f.scan).not.toHaveBeenCalled(); expect(f.notify.size).toBe(0);
  f.policy.setMode("launch"); await settle(); expect(f.scan).not.toHaveBeenCalled(); expect(f.notify.size).toBe(0); f.policy.close();
  const launched = fixture("launch"); launched.policy.start(); await settle(); expect(launched.scan).toHaveBeenCalledTimes(2);
  launched.completions.forEach(done => done(true)); await settle(); launched.policy.setMode("manual"); launched.policy.setMode("launch"); await settle();
  expect(launched.scan).toHaveBeenCalledTimes(2); launched.policy.close();
});

it("invalidates old watcher callbacks, reports watcher failure, and holds pending work during rebuild", async () => {
  const f = fixture(); f.hold(true); f.policy.start(); await settle(); expect(f.scan).not.toHaveBeenCalled();
  const stale = f.notify.get("one"); f.policy.setMode("manual"); stale?.(); expect(f.close).toHaveBeenCalledTimes(2);
  f.policy.setMode("auto"); f.errors.get("one")?.(new Error("Watch buffer unavailable"));
  expect(f.policy.status("one").watchError).toMatch(/unavailable/); f.hold(false); f.policy.resumePending(); await settle();
  expect(f.scan).toHaveBeenCalledTimes(2); f.enabled.delete("one"); f.policy.sourceChanged("one");
  f.notify.get("one")?.(); f.completions.forEach(done => done(false)); await settle(); expect(f.scan).toHaveBeenCalledTimes(2);
  f.policy.close(); stale?.(); await settle(); expect(f.scan).toHaveBeenCalledTimes(2);
});

it("does not apply a mode change if durable persistence fails", () => {
  const f = fixture(); f.save.mockImplementation(() => { throw new Error("disk full"); });
  expect(() => f.policy.setMode("manual")).toThrow("disk full"); expect(f.policy.mode).toBe("auto"); f.policy.close();
});

it.each(["stop", "close", "hold", "mode"])("rechecks %s after debounce and before the scan microtask", async action => {
  const f = fixture(); f.policy.start(); jest.advanceTimersByTime(300);
  if (action === "stop") { f.policy.stop("one"); f.policy.stop("two"); }
  if (action === "close") f.policy.close();
  if (action === "hold") f.hold(true);
  if (action === "mode") f.policy.setMode("manual");
  await settle(); expect(f.scan).not.toHaveBeenCalled();
  if (action === "hold") { f.hold(false); f.policy.resumePending(); await settle(); expect(f.scan).toHaveBeenCalledTimes(2); }
  f.policy.close(); f.completions.forEach(done => done(false));
});

it("keeps lifecycle startup independent of an early explicit scan and never reopens after close", async () => {
  const f = fixture(); f.policy.scanNow("one"); await settle(); expect(f.scan).toHaveBeenCalledTimes(1);
  f.completions[0](true); await settle(); f.policy.start(); await settle(); expect(f.notify.size).toBe(2);
  const count = f.close.mock.calls.length; f.policy.close(); f.policy.sourceChanged("one"); f.policy.close();
  expect(f.close).toHaveBeenCalledTimes(count + 2); f.completions.forEach(done => done(false));
});
