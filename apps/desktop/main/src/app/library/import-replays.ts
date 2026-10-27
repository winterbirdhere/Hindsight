import { mkdir, lstat, link, unlink, open } from "fs/promises";
import { extname, join, resolve } from "path";
import { ImportIntent, LibraryStore } from "./library-store";
import { inspectReplayFile } from "./sources/replay-file";
import { LibraryActivityGate } from "./library-activity-gate";

export interface ImportResult {
  path: string;
  status: "added" | "already-imported" | "failed";
  replayId?: string;
  error?: string;
}
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const errorMessage = (error: unknown) => error && typeof (error as Error).message === "string" ? (error as Error).message : "Import failed";

/** Only explicit Import calls copy originals. Recovery uses already-owned files only. One utility owner. */
export class ReplayImporter {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly directory: string;
  private readonly sourceId = "imports";
  private readonly gate = new LibraryActivityGate();

  constructor(private readonly store: LibraryStore, directory: string) { this.directory = resolve(directory); }

  setViewerDemand(active: boolean): Promise<void> { return this.gate.setDemand(active); }
  private serial<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const pending = this.tail.then(() => this.gate.run(work, signal));
    this.tail = pending.catch(() => undefined);
    return pending;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    if ((await lstat(this.directory)).isSymbolicLink()) throw new Error("Managed import directory cannot be a link");
    this.store.registerSource({ id: this.sourceId, kind: "imported", directory: this.directory });
  }

  importReplays(paths: readonly string[], signal?: AbortSignal): Promise<ImportResult[]> {
    return this.serial(async () => {
      if (paths.length > 1000) throw new Error("Import selection exceeds 1000 files");
      await this.initialize();
      const results: ImportResult[] = [];
      for (const path of paths) {
        signal?.throwIfAborted();
        try {
          if (extname(path).toLowerCase() !== ".osr") throw new Error("Select an .osr replay");
          const original = await inspectReplayFile(path, signal, () => this.gate.checkpoint(signal));
          const intent = this.store.prepareImport(this.sourceId, original.sha256,
            { header: original.header, validation: "header-only" }, Date.now());
          const target = this.target(intent);
          const registered = !!this.store.sourceObservation(this.sourceId, original.sha256);
          const exists = await this.verifyOwned(target, intent.sha256, signal);
          if (!exists) {
            const staged = this.staged(intent);
            await this.copyOwned(path, staged, signal);
            const copied = await inspectReplayFile(staged, signal, () => this.gate.checkpoint(signal));
            if (copied.sha256 !== intent.sha256) throw new Error("Original replay changed during import");
            await this.promote(intent, signal);
          }
          await this.removeStage(intent);
          const replayId = this.store.completeImport(intent.id, target);
          results.push({ path, status: exists && registered ? "already-imported" : "added", replayId });
        } catch (error) {
          if (signal?.aborted) throw error;
          results.push({ path, status: "failed", error: errorMessage(error) });
        }
      }
      return results;
    }, signal);
  }

  /** Stream the journal in bounded pages; diagnostics retain at most1000items. The callback sees every outcome. */
  recover(signal?: AbortSignal, onResult: (result: ImportResult) => void = () => undefined): Promise<ImportResult[]> {
    return this.serial(async () => {
      await this.initialize();
      const results: ImportResult[] = [];
      const report = (result: ImportResult) => { onResult(result); if (results.length < 1000) results.push(result); };
      let cursor: { addedAt: number; id: string } | undefined;
      for (;;) {
        await this.gate.checkpoint(signal);
        const page = this.store.pendingImports(cursor);
        if (!page.length) break;
        for (const intent of page) {
        await this.gate.checkpoint(signal);
        if (intent.sourceId !== this.sourceId) continue;
        const path = this.target(intent);
        try {
          const registered = !!this.store.sourceObservation(this.sourceId, intent.sha256);
          const exists = await this.verifyOwned(path, intent.sha256, signal);
          if (!exists) {
            let validStage = false;
            try { validStage = await this.verifyOwned(this.staged(intent), intent.sha256, signal); }
            catch (error) {
              if (signal?.aborted) throw error;
              // Retain transient OS-access failures for retry. A partial/changed copy is terminal;
              // remove only this intent's staged name, never the original or occupied final path.
              if ((error as NodeJS.ErrnoException).code) throw error;
            }
            if (!validStage) {
              await this.removeStage(intent);
              this.store.abandonImport(intent.id);
              report({ path, status: "failed", error: "Import interrupted before copy completed; select the original again" });
              continue;
            }
            await this.promote(intent, signal);
          }
          await this.removeStage(intent);
          const replayId = this.store.completeImport(intent.id, path);
          report({ path, status: exists && registered ? "already-imported" : "added", replayId });
        } catch (error) { if (signal?.aborted) throw error; report({ path, status: "failed", error: errorMessage(error) }); }
        }
        const last = page[page.length - 1]; cursor = { addedAt: last.addedAt, id: last.id };
      }
      return results;
    }, signal);
  }

  private target(intent: ImportIntent): string {
    if (!/^[a-f\d]{64}$/.test(intent.sha256)) throw new Error("Invalid import digest");
    return join(this.directory, intent.sha256 + ".osr");
  }
  private staged(intent: ImportIntent): string {
    if (!/^[a-f\d-]{36}$/.test(intent.id)) throw new Error("Invalid import identity");
    return join(this.directory, intent.id + ".part");
  }
  private async verifyOwned(path: string, sha256: string, signal?: AbortSignal): Promise<boolean> {
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error("Managed replay cannot be a link");
      if ((await inspectReplayFile(path, signal, () => this.gate.checkpoint(signal))).sha256 !== sha256) throw new Error("Managed replay content conflict");
      return true;
    } catch (error) { if (isMissing(error)) return false; throw error; }
  }
  private async promote(intent: ImportIntent, signal?: AbortSignal): Promise<void> {
    await this.gate.checkpoint(signal);
    // Both explicit imports and crash recovery must flush owned bytes before publication.
    const handle = await open(this.staged(intent), "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    signal?.throwIfAborted();
    try { await link(this.staged(intent), this.target(intent)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!await this.verifyOwned(this.target(intent), intent.sha256, signal)) throw new Error("Promoted replay is missing");
  }
  private async removeStage(intent: ImportIntent): Promise<void> {
    try { await unlink(this.staged(intent)); } catch (error) { if (!isMissing(error)) throw error; }
  }
  private async copyOwned(original: string, staged: string, signal?: AbortSignal): Promise<void> {
    const input = await open(original, "r");
    try {
      const output = await open(staged, "wx");
      try {
        const buffer = Buffer.alloc(1024 * 1024); let position = 0;
        for (;;) {
          await this.gate.checkpoint(signal);
          const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          position += bytesRead; if (position > 512 * 1024 * 1024) throw new Error("Replay grew beyond import limit");
          let written = 0;
          while (written < bytesRead) {
            signal?.throwIfAborted();
            const { bytesWritten } = await output.write(buffer, written, bytesRead - written);
            if (!bytesWritten) throw new Error("Import staging write made no progress"); written += bytesWritten;
          }
        }
      } finally { await output.close(); }
    } finally { await input.close(); }
  }
}
