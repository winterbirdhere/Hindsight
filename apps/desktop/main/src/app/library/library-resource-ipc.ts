import type { LibraryExactMapUnavailable, LibraryResourceRequest } from "../../../../shared/library-resources";
import { isLibraryExactMapUnavailable } from "../../../../shared/library-resources";
import { LibraryExactMapUnavailableError } from "./library-replay-opener";
import type { LibraryReplayOpener } from "./library-replay-opener";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
function request(value: unknown): LibraryResourceRequest {
  if (!record(value) || Buffer.byteLength(JSON.stringify(value)) > 8192 || !text(value.requestId)) throw new Error("Invalid library resource request");
  const fields: Record<string, string[]> = { open: ["replayId"], transfer: ["kind", "name"], chunk: ["transferId", "offset"], release: [] };
  const method = String(value.method);
  if (!Object.prototype.hasOwnProperty.call(fields, method) || Object.keys(value).some(key => !["method", "requestId", ...fields[method]].includes(key)))
    throw new Error("Unknown library resource operation");
  if (method === "open" && !text(value.replayId)) throw new Error("Invalid library replay identity");
  if (method === "chunk" && (!text(value.transferId) || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0 || Number(value.offset) > 128 * 1024 * 1024))
    throw new Error("Invalid library resource offset");
  if (method === "transfer") {
    if (!["replay", "map", "asset"].includes(String(value.kind))) throw new Error("Invalid library resource kind");
    if (value.kind === "asset" && (typeof value.name !== "string" || !value.name || value.name.length > 512 ||
        /[<>:"|?*]/.test(value.name) || [...value.name].some(char => char.charCodeAt(0) < 32) ||
        value.name.replace(/\\/g, "/").split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))))
      throw new Error("Invalid library asset name");
    if (value.kind !== "asset" && value.name !== undefined) throw new Error("Invalid library resource name");
  }
  return value as unknown as LibraryResourceRequest;
}

export class LibraryResourceApi {
  private generation = 0;
  private closed = false;
  private pending = 0;
  constructor(private readonly opener: Pick<LibraryReplayOpener, "open" | "transfer" | "chunk" | "release" | "releaseDocument" | "close">) {}
  async receive(value: unknown, assertCurrent: () => void): Promise<unknown> {
    const generation = this.generation;
    const check = () => { assertCurrent(); if (this.closed || generation !== this.generation) throw new Error("Library resource document expired"); };
    check(); const input = request(value);
    if (this.pending >= 64 || (this.pending >= 32 && input.method !== "release")) throw new Error("Library resource queue is busy");
    this.pending++;
    try {
      let result: unknown;
      if (input.method === "open") {
        try { result = await this.opener.open(input.requestId, input.replayId, check); }
        catch (error) {
          check();
          if (!(error instanceof LibraryExactMapUnavailableError)) throw error;
          const unavailable: LibraryExactMapUnavailable = { state: "unavailable", reason: "exact-map-unavailable",
            requestId: input.requestId, replayId: input.replayId, beatmapMd5: error.beatmapMd5 };
          if (error.replayId !== input.replayId || !isLibraryExactMapUnavailable(unavailable))
            throw new Error("Invalid library exact-map-unavailable result");
          result = unavailable;
        }
      }
      else if (input.method === "transfer") result = await this.opener.transfer(input.requestId, input.kind, input.name);
      else if (input.method === "chunk") result = await this.opener.chunk(input.requestId, input.transferId, input.offset);
      else result = await this.opener.release(input.requestId);
      check(); return result;
    } finally { this.pending--; }
  }
  releaseDocument(): Promise<void> { this.generation++; return this.opener.releaseDocument(); }
  close(): Promise<void> { this.closed = true; this.generation++; return this.opener.close(); }
}
