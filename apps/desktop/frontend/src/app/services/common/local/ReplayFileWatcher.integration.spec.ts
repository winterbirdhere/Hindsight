/** @jest-environment node */
import "reflect-metadata";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { BehaviorSubject, firstValueFrom, timeout } from "rxjs";
import type { FSWatcher } from "chokidar";
import { ReplayFileWatcher } from "./ReplayFileWatcher";
import { OsuFolderService } from "./OsuFolderService";

jest.mock("./OsuFolderService", () => ({ OsuFolderService: class OsuFolderService {} }));

it("publishes a split-written replay only after the complete file stabilizes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewind-replay-writes-"));
  const service = new ReplayFileWatcher({ replaysFolder$: new BehaviorSubject(directory) } as OsuFolderService);
  const observed: string[] = [];
  const subscription = service.newReplays$.subscribe((file) => observed.push(file));
  service.startWatching();
  const watcher = (service as unknown as { watcher: FSWatcher }).watcher;
  try {
    await new Promise<void>((resolve, reject) => {
      watcher.once("ready", resolve);
      watcher.once("error", reject);
    });
    const file = join(directory, "slow-copy.osr");
    await writeFile(file, "header-");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(observed).toEqual([]);
    const completed = firstValueFrom(service.newReplays$.pipe(timeout(5000)));
    await appendFile(file, "complete-frames");
    expect(await completed).toBe(file);
    expect(await readFile(file, "utf8")).toBe("header-complete-frames");
    expect(observed).toEqual([file]);
  } finally {
    subscription.unsubscribe();
    await watcher.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);
