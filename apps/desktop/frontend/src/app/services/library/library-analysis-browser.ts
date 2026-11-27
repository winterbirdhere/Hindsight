/** Separate URL and lifetime from current-replay readiness, performance and miss-analysis workers. */
export function createLibraryAnalysisWorker(): Worker {
  return new Worker(new URL("./library-analysis.worker.ts", import.meta.url), {name:"library-analysis"});
}
