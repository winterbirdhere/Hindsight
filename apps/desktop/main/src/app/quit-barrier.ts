/** Every quit remains prevented until every owned asynchronous cleanup has settled. */
export function createQuitBarrier(immediate: () => void, drain: () => Promise<unknown>[], quit: () => void, failed: (error: unknown) => void) {
  let done = false, running = false;
  return (event: { preventDefault(): void }): void => {
    if (done) return;
    event.preventDefault(); if (running) return; running = true;
    try { immediate(); } catch (error) { failed(error); }
    let tasks: Promise<unknown>[];
    try { tasks = drain(); } catch (error) { failed(error); tasks = []; }
    void Promise.allSettled(tasks).then(results => {
      for (const result of results) if (result.status === "rejected") failed(result.reason);
      done = true; quit();
    });
  };
}
