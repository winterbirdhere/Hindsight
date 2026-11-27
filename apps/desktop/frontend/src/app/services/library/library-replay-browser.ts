/** Webpack owns the asset URL; kept outside the CommonJS test import graph. */
export function createLibraryReplayWorker(): Worker {
  return new Worker(new URL("./library-replay.worker.ts", import.meta.url), { name: "library-replay" });
}
