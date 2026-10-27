import { ReplayWatcher } from "./ReplayWatcher";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { watch } from "chokidar";

jest.mock("chokidar", () => ({ watch: jest.fn() }));
jest.mock("node-osr", () => ({ read: jest.fn() }));

describe("ReplayWatcher resource cleanup", () => {
  it("closes every native watcher and waits for shutdown", async () => {
    let finishClosing: () => void = () => undefined;
    const first = {
      on: jest.fn(),
      close: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finishClosing = resolve;
          }),
      ),
    };
    const second = { on: jest.fn(), close: jest.fn().mockResolvedValue(undefined) };
    (watch as jest.Mock).mockReturnValueOnce(first).mockReturnValueOnce(second);
    const service = new ReplayWatcher(new EventEmitter2());
    service.watchForReplays("first").watchForReplays("second");

    let finished = false;
    const closing = service.onModuleDestroy().then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);

    finishClosing();
    await closing;
    expect(finished).toBe(true);
    await service.onModuleDestroy();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
  });
});
