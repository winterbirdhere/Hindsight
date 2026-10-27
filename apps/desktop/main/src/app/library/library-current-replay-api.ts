import { randomUUID } from "crypto";
import { PERFORMANCE_ENGINE_VERSION } from "@rewind/osu-performance/protocol";
import { LIBRARY_NUMERIC_PROJECTION_VERSION, LIBRARY_RECONSTRUCTED_FC_VERSION, LIBRARY_REPLAY_PARSER_VERSION,
  LIBRARY_RESOURCE_PREPARATION_VERSION, LIBRARY_TIMELINE_PROJECTION_VERSION } from "../../../../shared/library-analysis";
import { isLibraryCurrentReplayReceipt } from "../../../../shared/library-current-replay";
import type { LibraryCurrentReplayReceipt, LibraryCurrentReplayResult, LibraryCurrentReplayPublication, LibraryCurrentReplayReleased } from "../../../../shared/library-current-replay";
import { validateLibraryErrorStrip } from "../../../../shared/library-error-strip";

type Binding = Omit<LibraryCurrentReplayReceipt, "token">;
interface Dependencies<Authority> {
  /** Must atomically recheck trusted target/recipe/lease and current source identity. No job admission. */
  publish(authority: Authority, results: LibraryCurrentReplayResult[], assertCurrent: () => void): Promise<LibraryCurrentReplayPublication>;
  /** Revoke the private backend capability. Runtime teardown must drain this work before closing metadata. */
  revoke?(authority: Authority): void | Promise<void>;
  now?: () => number;
  ttlMs?: number;
  maxReceipts?: number;
}
interface Entry<Authority> { receipt: LibraryCurrentReplayReceipt; authority: Authority; touched: number; pending: boolean }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const token = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.:/+-]{1,128}$/.test(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const count = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value >= 0;
const versions = { numerical: LIBRARY_NUMERIC_PROJECTION_VERSION, "timeline-pp": LIBRARY_TIMELINE_PROJECTION_VERSION, "fc-pp": LIBRARY_RECONSTRUCTED_FC_VERSION };
const fieldNames = { numerical: ["completion", "fc", "perfectCombo", "accuracy", "misses", "maxCombo", "comboLosses", "sliderBreaks", "sliderEndMisses", "sliderTickMisses", "sampleCount", "ur", "biasMs"],
  "timeline-pp": ["pp", "peakPp"], "fc-pp": ["ppIfFc"] };
const provenanceNames = ["replaySha256", "mapSha256", "mapMd5", "parserVersion", "preparationVersion", "validationVersion", "projectionVersion",
  "scoreOrigin", "ruleset", "rate", "coverageQualified", "completionEvidence", "completeAccuracyEvidence", "completeBreakEvidence", "engineVersion"];
function invalid(): never { throw new Error("Invalid current replay publication"); }

function validateResults(value: unknown, receipt: LibraryCurrentReplayReceipt): asserts value is LibraryCurrentReplayResult[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return invalid();
  const seen = new Set<string>();
  for (const result of value) {
    if (!object(result) || Object.keys(result).length !== 3 || Object.keys(result).some(key => !["slot", "producerVersion", "metrics"].includes(key)) ||
      !Object.prototype.hasOwnProperty.call(versions, String(result.slot))) return invalid();
    const slot = result.slot as keyof typeof versions;
    if (seen.has(slot) || result.producerVersion !== versions[slot]) return invalid();
    seen.add(slot);
    const metric = result.metrics;
    if (!object(metric) || Object.keys(metric).length > 3 || Object.keys(metric).some(key => !["fields", "provenance", "errorStrip"].includes(key)) ||
      !object(metric.fields) || !object(metric.provenance) || !Object.keys(metric.fields).length || Object.keys(metric.fields).length > fieldNames[slot].length) return invalid();
    const proof = metric.provenance;
    if (Object.keys(proof).length > provenanceNames.length || Object.keys(proof).some(key => !provenanceNames.includes(key)) || proof.replaySha256 !== receipt.replaySha256 ||
      proof.mapSha256 !== receipt.mapSha256 || proof.mapMd5 !== receipt.mapMd5 || proof.projectionVersion !== versions[slot] ||
      proof.parserVersion !== receipt.parserVersion || proof.preparationVersion !== receipt.preparationVersion || proof.scoreOrigin !== "reconstructed" ||
      !finite(proof.rate) || proof.rate <= 0 || typeof proof.coverageQualified !== "boolean" ||
      !(slot === "numerical" ? ["stable", "lazer"] : ["stable", "lazer", "lazer-classic"]).includes(String(proof.ruleset)) ||
      (slot !== "numerical" && proof.engineVersion !== PERFORMANCE_ENGINE_VERSION)) return invalid();
    for (const [name, item] of Object.entries(proof)) {
      if (["coverageQualified", "completeAccuracyEvidence", "completeBreakEvidence"].includes(name)) { if (typeof item !== "boolean") invalid(); }
      else if (name !== "rate" && !token(item)) invalid();
    }
    for (const [name, item] of Object.entries(metric.fields)) {
      if (!fieldNames[slot].includes(name) || !object(item)) return invalid();
      if (item.state === "known") {
        if (Object.keys(item).some(key => key !== "state" && key !== "value")) return invalid();
        const valid = name === "completion" ? item.value === "passed" || item.value === "failed"
          : name === "fc" || name === "perfectCombo" ? typeof item.value === "boolean"
          : name === "accuracy" ? finite(item.value) && item.value >= 0 && item.value <= 1
          : name === "biasMs" ? finite(item.value)
          : ["pp", "peakPp", "ppIfFc", "ur"].includes(name) ? finite(item.value) && item.value >= 0 : count(item.value);
        if (!valid) return invalid();
      } else if (!["unknown", "not-applicable", "error"].includes(String(item.state)) || !token(item.reason) ||
        Object.keys(item).some(key => key !== "state" && key !== "reason")) return invalid();
    }
    if (metric.errorStrip !== undefined) {
      if (slot !== "numerical") return invalid();
      validateLibraryErrorStrip(metric.errorStrip);
      if (metric.errorStrip.state === "known" && (proof.coverageQualified !== true || metric.errorStrip.value.ruleset !== proof.ruleset)) return invalid();
    }
  }
}

/** Renderer capability boundary only. The private authority is created by main after resource
 * verification; final publication CAS remains in the store callback, never in renderer input. */
export class LibraryCurrentReplayApi<Authority = unknown> {
  private readonly entries = new Map<string, Entry<Authority>>();
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly limit: number;
  private closed = false;
  private readonly revocations = new Map<string, Promise<void>>();
  private revocationFailure?: unknown;
  constructor(private readonly dependencies: Dependencies<Authority>) {
    this.now = dependencies.now ?? Date.now;
    this.ttl = dependencies.ttlMs ?? 30 * 60 * 1000;
    this.limit = dependencies.maxReceipts ?? 8;
    if (!Number.isSafeInteger(this.ttl) || this.ttl < 1 || !Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > 32) invalid();
  }
  private expire(): void { const now = this.now(); for (const [id, entry] of this.entries) if (now - entry.touched > this.ttl) void this.release(id); }
  issue(binding: Binding, authority: Authority): LibraryCurrentReplayReceipt {
    if (this.closed) throw new Error("Current replay publication is closed");
    this.expire(); if (this.entries.size + this.revocations.size >= this.limit) throw new Error("Current replay receipt limit reached");
    const receipt = { ...binding, token: randomUUID() };
    if (!isLibraryCurrentReplayReceipt(receipt) || receipt.parserVersion !== LIBRARY_REPLAY_PARSER_VERSION ||
      receipt.preparationVersion !== LIBRARY_RESOURCE_PREPARATION_VERSION || receipt.numericalVersion !== LIBRARY_NUMERIC_PROJECTION_VERSION) invalid();
    this.entries.set(receipt.token, { receipt: { ...receipt }, authority, touched: this.now(), pending: false });
    return receipt;
  }
  release(token: string): Promise<void> {
    const entry = this.entries.get(token); if (!entry) return this.revocations.get(token) ?? Promise.resolve();
    this.entries.delete(token); // The final publication guard observes revocation synchronously.
    let operation: Promise<void>;
    try { operation = Promise.resolve(this.dependencies.revoke?.(entry.authority)); }
    catch (error) { operation = Promise.reject(error); }
    this.revocations.set(token, operation);
    void operation.then(() => this.revocations.delete(token), error => {
      this.revocationFailure ??= error instanceof Error ? error : new Error("Current replay backend revocation failed"); this.revocations.delete(token);
    });
    return operation;
  }
  async drain(): Promise<void> {
    while (this.revocations.size) await Promise.allSettled([...this.revocations.values()]);
    if (this.revocationFailure !== undefined) throw this.revocationFailure;
  }
  releaseDocument(): Promise<void> { for (const id of this.entries.keys()) void this.release(id); return this.drain(); }
  close(): Promise<void> { this.closed = true; return this.releaseDocument(); }
  async receive(value: unknown, assertCurrent: () => void): Promise<LibraryCurrentReplayPublication | LibraryCurrentReplayReleased> {
    assertCurrent();
    if (this.closed) return { state: "stale", accepted: [] };
    if (!object(value) || !token(value.token) || !["current-replay-publish", "current-replay-release"].includes(String(value.method)) ||
      Object.keys(value).some(key => !["method", "token", ...(value.method === "current-replay-publish" ? ["results"] : [])].includes(key))) invalid();
    this.expire();
    if (value.method === "current-replay-release") { await this.release(value.token); return { state: "released" }; }
    const entry = this.entries.get(value.token);
    if (!entry) return { state: "stale", accepted: [] };
    validateResults(value.results, entry.receipt);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > 96 * 1024) invalid();
    if (entry.pending) throw new Error("Current replay publication is busy");
    entry.touched = this.now(); entry.pending = true;
    try {
      // Detach bounded incoming values before asynchronous CAS; caller mutation cannot retarget them.
      const results = JSON.parse(JSON.stringify(value.results)) as LibraryCurrentReplayResult[];
      const result = await this.dependencies.publish(entry.authority, results, () => {
        assertCurrent(); this.expire();
        if (this.closed || this.entries.get(entry.receipt.token) !== entry) throw new Error("Current replay publication is stale");
      });
      assertCurrent(); this.expire();
      if (this.closed || this.entries.get(entry.receipt.token) !== entry) return { state: "stale", accepted: [] };
      return result;
    } finally { entry.pending = false; }
  }
}
