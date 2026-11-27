/** Kept out of the CommonJS headless/test import graph; Webpack owns the worker asset URL. */
export function createMissAnalysisWorker(): Worker {
  return new Worker(new URL("./miss-analysis.worker.ts", import.meta.url), { name: "miss-analysis" });
}
