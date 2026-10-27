import "reflect-metadata";
import * as chokidar from "chokidar";
import { BehaviorSubject } from "rxjs";
import { ReplayFileWatcher } from "./ReplayFileWatcher";
import { OsuFolderService } from "./OsuFolderService";

jest.mock("chokidar", () => ({ watch: jest.fn() }));
jest.mock("./OsuFolderService", () => ({ OsuFolderService: class OsuFolderService {} }));

interface MockWatcher {
  handlers: Map<string, (path: string) => void>;
  on: jest.Mock;
  close: jest.Mock;
}

describe("ReplayFileWatcher literal filenames", () => {
  const watchers: MockWatcher[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    watchers.length = 0;
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    (chokidar.watch as jest.Mock).mockImplementation(() => {
      const handlers = new Map<string, (path: string) => void>();
      const watcher: MockWatcher = {
        handlers,
        on: jest.fn((event: string, listener: (path: string) => void) => {
          handlers.set(event, listener);
          return watcher;
        }),
        close: jest.fn().mockResolvedValue(undefined),
      };
      watchers.push(watcher);
      return watcher;
    });
  });

  afterEach(() => jest.restoreAllMocks());

  function startWatching(folder: string) {
    const replaysFolder$ = new BehaviorSubject(folder);
    const service = new ReplayFileWatcher({ replaysFolder$ } as OsuFolderService);
    const emitted = jest.fn();
    service.newReplays$.subscribe(emitted);
    service.startWatching();
    return { replaysFolder$, emitted, service };
  }

  it.each([
    "D:\\osu! [Stable]\\Replays",
    "D:\\osu! {Stable,Lazer}\\Replays",
    "D:\\osu! #100%23 日本語 [1]{2}\\Replays",
  ])("watches a literal folder without treating its characters as a glob: %s", (folder) => {
    startWatching(folder);

    expect(chokidar.watch).toHaveBeenCalledWith(folder, {
      disableGlobbing: true,
      ignoreInitial: true,
      persistent: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
  });

  it("keeps initial files ignored when starting and replacing a watcher", () => {
    const { emitted, replaysFolder$ } = startWatching("D:\\osu! [First]\\Replays");
    replaysFolder$.next("D:\\osu! {Second}\\Replays");

    const calls = (chokidar.watch as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    calls.forEach(([, options]) => expect(options.ignoreInitial).toBe(true));
    expect(emitted).not.toHaveBeenCalled();
  });

  it.each(["osr", "OSR", "OsR"])("emits newly added .%s paths unchanged", (extension) => {
    const folder = "D:\\osu! [Stable]{1}\\Replays";
    const path = `${folder}\\Player - 曲 #100%23 [Hard].${extension}`;
    const { emitted } = startWatching(folder);

    watchers[0].handlers.get("add")?.(path);

    expect(emitted).toHaveBeenCalledTimes(1);
    expect(emitted).toHaveBeenCalledWith(path);
  });

  it("ignores non-replay files and filenames with trailing extensions", () => {
    const { emitted } = startWatching("D:\\osu!\\Replays");
    for (const filename of ["map.osu", "replay.osr.tmp", "replay.osr.bak", "not-an-osr", "audio.mp3"]) {
      watchers[0].handlers.get("add")?.(`D:\\osu!\\Replays\\${filename}`);
    }

    expect(emitted).not.toHaveBeenCalled();
  });

  it("closes the previous watcher before registering the replacement folder", () => {
    const { emitted, replaysFolder$ } = startWatching("D:\\osu! [First]\\Replays");
    const previous = watchers[0];
    const nextFolder = "D:\\osu! {Second}\\Replays";

    replaysFolder$.next(nextFolder);

    expect(previous.close).toHaveBeenCalledTimes(1);
    expect(chokidar.watch).toHaveBeenLastCalledWith(nextFolder, expect.objectContaining({ disableGlobbing: true }));
    expect(previous.close.mock.invocationCallOrder[0]).toBeLessThan(
      (chokidar.watch as jest.Mock).mock.invocationCallOrder[1],
    );
    expect(watchers[1].close).not.toHaveBeenCalled();

    const path = `${nextFolder}\\Replay #2.OSR`;
    previous.handlers.get("add")?.("D:\\osu! [First]\\Replays\\late.osr");
    expect(emitted).not.toHaveBeenCalled();
    watchers[1].handlers.get("add")?.(path);
    expect(emitted).toHaveBeenCalledWith(path);
  });

  it("does not add duplicate folder subscriptions when initialized again", () => {
    const { service, replaysFolder$ } = startWatching("D:\\osu!\\Replays");
    service.startWatching();
    replaysFolder$.next("D:\\second\\Replays");
    expect(chokidar.watch).toHaveBeenCalledTimes(2);
  });

  it("waits for a configured replay folder instead of watching a relative path", () => {
    const { replaysFolder$ } = startWatching("");
    expect(chokidar.watch).not.toHaveBeenCalled();
    replaysFolder$.next("D:\\osu!\\Replays");
    expect(chokidar.watch).toHaveBeenCalledTimes(1);
    replaysFolder$.next("");
    expect(watchers[0].close).toHaveBeenCalledTimes(1);
    expect(chokidar.watch).toHaveBeenCalledTimes(1);
  });
});
