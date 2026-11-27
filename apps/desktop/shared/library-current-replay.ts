import type { LibraryMetricResult } from "./replay-library-metrics";

/** Main-issued capability for exact already-verified indexed resources. No locator or job ticket. */
export interface LibraryCurrentReplayReceipt {
  version: 1;
  token: string;
  replayId: string;
  replaySha256: string;
  mapSha256: string;
  mapMd5: string;
  numericalInputKey: string;
  parserVersion: string;
  preparationVersion: string;
  numericalVersion: string;
}
export type LibraryCurrentReplaySlot = "numerical" | "timeline-pp" | "fc-pp";
export interface LibraryCurrentReplayResult {
  slot: LibraryCurrentReplaySlot;
  producerVersion: string;
  metrics: LibraryMetricResult;
}
export type LibraryCurrentReplayRequest =
  | { method: "current-replay-publish"; token: string; results: LibraryCurrentReplayResult[] }
  | { method: "current-replay-release"; token: string };
export interface LibraryCurrentReplayPublication {
  state: "applied" | "cached" | "stale" | "unavailable";
  accepted: LibraryCurrentReplaySlot[];
}
export interface LibraryCurrentReplayReleased { state: "released" }

const text = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_.:/+-]{1,128}$/.test(value);
export function isLibraryCurrentReplayReceipt(value: unknown): value is LibraryCurrentReplayReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return Object.keys(receipt).length === 10 && receipt.version === 1 && text(receipt.token) && text(receipt.replayId) &&
    [receipt.replaySha256, receipt.mapSha256, receipt.numericalInputKey].every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) &&
    typeof receipt.mapMd5 === "string" && /^[a-f0-9]{32}$/.test(receipt.mapMd5) &&
    text(receipt.parserVersion) && text(receipt.preparationVersion) && text(receipt.numericalVersion);
}
