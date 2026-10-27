import { injectable } from "inversify";
import { Subject } from "rxjs";
import * as chokidar from "chokidar";
import { OsuFolderService } from "./OsuFolderService";

@injectable()
export class ReplayFileWatcher {
  public readonly newReplays$: Subject<string>;
  private watcher?: chokidar.FSWatcher;
  private started = false;

  constructor(private readonly osuFolderService: OsuFolderService) {
    this.newReplays$ = new Subject<string>();
  }

  public startWatching() {
    if (this.started) return;
    this.started = true;
    this.osuFolderService.replaysFolder$.subscribe(this.onNewReplayFolder.bind(this));
  }

  // Unsubscribes from the old replay folder and starts listening on the new folder that was given
  // TODO: In the future we might want to watch on a list of folders and not just the osu! folder
  private onNewReplayFolder(folder: string) {
    // For now, we just use .close()
    // We could make it cleaner by using .unwatch() and adding new files to watch
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = undefined;
    }
    if (!folder) return;

    console.log(`Watching for replays (.osr) in folder: ${folder}`);
    const watcher = chokidar.watch(folder, {
      // The configured folder is a literal path, even when its name contains
      // glob syntax such as square brackets or braces.
      disableGlobbing: true,
      // Only newly added replays should be loaded, not files already present.
      ignoreInitial: true,
      persistent: true,
      depth: 0, // if somehow osu! is trolling, this will prevent it
      // A copied/exported replay may become visible before its last write.
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    this.watcher = watcher;
    watcher.on("add", (path) => {
      if (this.watcher !== watcher || !path.toLowerCase().endsWith(".osr")) {
        return;
      }
      console.log(`Detected new file at: ${path}`);
      this.newReplays$.next(path);
    });
  }
}
