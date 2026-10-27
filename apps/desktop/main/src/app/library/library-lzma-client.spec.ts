import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { LibraryLzmaClient } from "./library-lzma-client";
import { LibraryNativeBroker,LibraryNativeBridge } from "./library-native-admission";

class Child extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  killed = false;
  kill(): boolean { this.killed = true; return true; }
}
const input = Buffer.alloc(13);
const request = { role: "frames" as const, maxOutputBytes: 100 };
it("does not launch a decoder until its shared native grant and retains the lease through actual close",async()=>{
  const broker=new LibraryNativeBroker();
  const endpoint=broker.attach(value=>queueMicrotask(()=>bridge.receive(value)));const bridge:LibraryNativeBridge=new LibraryNativeBridge(value=>queueMicrotask(()=>endpoint.receive(value)));
  await broker.setViewerDemand(true);const child=new Child(),launch=jest.fn(()=>child as never),client=new LibraryLzmaClient(()=>"helper.exe",launch,bridge);
  const decoding=client.decode(input,request);await new Promise(resolve=>setImmediate(resolve));expect(launch).not.toHaveBeenCalled();
  await broker.setViewerDemand(false);await new Promise(resolve=>setImmediate(resolve));expect(launch).toHaveBeenCalledTimes(1);expect(broker.status().active).toBe(1);
  child.stdout.write(Buffer.from("frames"));child.emit("close",0);expect((await decoding).toString()).toBe("frames");await new Promise(resolve=>setImmediate(resolve));
  expect(broker.status().active).toBe(0);await client.close();await broker.close();
});
function harness() {
  const child = new Child();
  const client = new LibraryLzmaClient(() => "helper.exe", () => child as never);
  return { child, client };
}

describe("foreground bounded decoder process", () => {
  it("publishes output only after successful exit and completed input", async () => {
    const { child, client } = harness();
    const result = client.decode(input, request);
    child.stdout.write(Buffer.from("frames"));
    await new Promise(resolve => setImmediate(resolve));
    child.emit("close", 0);
    expect((await result).toString()).toBe("frames");
    await client.close();
  });

  it("discards partial output from a failed helper", async () => {
    const { child, client } = harness();
    const result = client.decode(input, request);
    const rejected = expect(result).rejects.toThrow("failed");
    child.stdout.write(Buffer.from("partial"));
    child.emit("close", 1);
    await rejected;
    await client.close();
  });

  it("waits for actual exit on cancellation and refuses overlapping work", async () => {
    const { child, client } = harness();
    const controller = new AbortController();
    const result = client.decode(input, { ...request, signal: controller.signal });
    let settled = false;
    void result.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(result).rejects.toThrow("replaced");
    controller.abort(new Error("replaced"));
    await new Promise(resolve => setImmediate(resolve));
    expect(child.killed).toBe(true);
    expect(settled).toBe(false);
    await expect(client.decode(input, request)).rejects.toThrow("busy");
    child.emit("close", null);
    await rejected;
    await client.close();
  });

  it("kills over-limit output and drains close before allowing reuse", async () => {
    const { child, client } = harness();
    const result = client.decode(input, request);
    const rejected = expect(result).rejects.toThrow("limit");
    child.stdout.write(Buffer.alloc(101));
    expect(child.killed).toBe(true);
    child.emit("close", null);
    await rejected;
    await client.close();
  });

  it("shutdown drains its owned process and permanently stops new admission", async () => {
    const { child, client } = harness();
    const result = client.decode(input, request);
    const rejected = expect(result).rejects.toThrow("closed");
    let closed = false;
    const closing = client.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    child.emit("close", null);
    await Promise.all([rejected, closing]);
    await expect(client.decode(input, request)).rejects.toThrow("closed");
  });

  it.each(["stdout", "stderr"] as const)("drains %s pipe failures instead of throwing an unhandled event", async (pipe) => {
    const { child, client } = harness();
    const result = client.decode(input, request);
    const rejected = expect(result).rejects.toThrow("pipe failed");
    void rejected.catch(() => undefined);
    try {
      child[pipe].emit("error", new Error("broken pipe"));
    } finally { child.emit("close", 1); }
    await rejected;
    await client.close();
  });

  it("reports unconfirmed cleanup as failure and prevents a new decoder from starting", async () => {
    jest.useFakeTimers();
    const { child, client } = harness();
    try {
      const controller = new AbortController();
      const result = client.decode(input, { ...request, signal: controller.signal });
      const rejected = expect(result).rejects.toThrow("exit not confirmed");
      controller.abort();
      jest.advanceTimersByTime(2000);
      await rejected;
      await expect(client.decode(input, request)).rejects.toThrow("exit not confirmed");
      await expect(client.close()).rejects.toThrow("exit not confirmed");
    } finally {
      child.emit("close", null);
      jest.useRealTimers();
    }
  });
});
